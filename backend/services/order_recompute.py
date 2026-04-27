"""
Order recompute — re-resolve pick_skus on existing open orders without pulling Shopify.

Use cases:
  - After SKU mapping or SKU helper edits.
  - After short-ship / inventory-hold config changes.
  - Sanity-refresh on the Staging Dashboard before pushing to ShipStation.

Mirrors the SKU resolution + downstream apply/unstage steps that Pull Shopify
already runs, so behavior stays consistent. Only the "fetch new orders" step
is skipped — everything else (line item explosion, short-ship rules, plan
issue checks, order rule checks, committed inventory recompute) is reused.

Orders already pushed to ShipStation are never touched.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

import models
from services import sheets_service


# Statuses we operate on — exclude orders already in ShipStation
RECOMPUTE_STATUSES = ("not_processed", "partially_fulfilled", "staged")


def _explode_line_item(
    base: dict,
    fulfillable_qty: int,
    mappings: Optional[list[dict]],
) -> list[dict]:
    """
    Same explosion logic as shopify_service.transform_order, but operating on
    existing line-item base data instead of a raw Shopify response.
    """
    if fulfillable_qty == 0:
        return [{**base, "pick_sku": None, "sku_mapped": True, "mix_quantity": 1.0}]
    if mappings:
        return [
            {
                **base,
                "pick_sku":     m.get("pick_sku"),
                "sku_mapped":   bool(m.get("pick_sku")),
                "mix_quantity": m.get("mix_quantity") or 1.0,
            }
            for m in mappings
        ]
    return [{**base, "pick_sku": None, "sku_mapped": False, "mix_quantity": 1.0}]


def _row_signature(rows) -> tuple:
    """
    Comparable signature for a set of rows belonging to one line_item_id.
    Used to detect whether re-resolution actually changed anything.
    """
    return tuple(sorted(
        ((r["pick_sku"], r["mix_quantity"], r["sku_mapped"]) for r in rows),
        key=lambda t: (t[0] or "", t[1] or 0, t[2]),
    ))


def _refresh_pick_skus(db: Session, order_ids: Optional[list[str]] = None) -> dict:
    """
    Re-resolve pick_sku / mix_quantity / sku_mapped on every line item of open orders.

    For each order, line items are grouped by line_item_id. If the new mapping
    produces a different set of (pick_sku, mix_quantity, sku_mapped) for that
    line_item_id, the rows are deleted and recreated from the new mapping.
    app_line_status and shipstation_line_item_id are preserved per line_item_id,
    using the same restore rules as Pull Shopify.

    Returns: {"orders_changed": [...], "lines_updated": int, "orders_scanned": int}
    """
    q = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.app_status.in_(RECOMPUTE_STATUSES)
    )
    if order_ids:
        q = q.filter(models.ShopifyOrder.shopify_order_id.in_(order_ids))
    orders = q.all()

    # Cache lookups per warehouse so each Sheet is fetched at most once
    lookups: dict[str, dict] = {}

    def _lookup_for(wh: str) -> dict:
        if wh not in lookups:
            try:
                lookups[wh] = sheets_service.get_sku_mapping_lookup(wh)
            except Exception as e:
                print(f"[WARN] order_recompute: failed to load mapping for '{wh}': {e}")
                lookups[wh] = {}
        return lookups[wh]

    orders_changed: set[str] = set()
    lines_updated = 0

    for order in orders:
        wh = order.assigned_warehouse or "walnut"
        sku_lookup = _lookup_for(wh)

        old_lis = (
            db.query(models.ShopifyLineItem)
            .filter(models.ShopifyLineItem.shopify_order_id == order.shopify_order_id)
            .all()
        )

        # Group rows by line_item_id; capture base fields from the first row
        by_line_id: dict[str, dict] = {}
        for li in old_lis:
            entry = by_line_id.get(li.line_item_id)
            if entry is None:
                entry = {
                    "base": {
                        "shopify_order_id":     li.shopify_order_id,
                        "line_item_id":         li.line_item_id,
                        "shopify_sku":          li.shopify_sku,
                        "product_title":        li.product_title,
                        "variant_title":        li.variant_title,
                        "quantity":             li.quantity,
                        "fulfillable_quantity": li.fulfillable_quantity,
                        "fulfillment_status":   li.fulfillment_status,
                        "price":                li.price,
                        "total_discount":       li.total_discount,
                        "grams":                li.grams,
                        "requires_shipping":    li.requires_shipping,
                    },
                    "rows": [],
                    "app_line_status":          li.app_line_status,
                    "shipstation_line_item_id": li.shipstation_line_item_id,
                }
                by_line_id[li.line_item_id] = entry
            entry["rows"].append(li)
            # Prefer non-None status / shipstation id across rows for the same line_item_id
            if li.app_line_status and not entry["app_line_status"]:
                entry["app_line_status"] = li.app_line_status
            if li.shipstation_line_item_id and not entry["shipstation_line_item_id"]:
                entry["shipstation_line_item_id"] = li.shipstation_line_item_id

        for line_item_id, entry in by_line_id.items():
            # 'removed' rows are zero-qty placeholders for items dropped from Shopify;
            # they don't represent a SKU resolution and must be left alone.
            if entry["app_line_status"] == "removed":
                continue

            base = entry["base"]
            shopify_sku = base["shopify_sku"]
            fulfillable_qty = base["fulfillable_quantity"] or 0

            mappings = sku_lookup.get(shopify_sku) if shopify_sku else None
            new_rows = _explode_line_item(base, fulfillable_qty, mappings)

            old_rows_sig = [
                {"pick_sku": r.pick_sku, "mix_quantity": r.mix_quantity, "sku_mapped": r.sku_mapped}
                for r in entry["rows"]
            ]
            if _row_signature(old_rows_sig) == _row_signature(new_rows):
                continue

            # Replace this line item's rows with the freshly resolved ones
            for r in entry["rows"]:
                db.delete(r)
            db.flush()

            old_status = entry["app_line_status"]
            old_ss_li_id = entry["shipstation_line_item_id"]
            for nr in new_rows:
                obj = models.ShopifyLineItem(**nr)
                # Same restore rules as Pull Shopify (orders.py:880-908):
                #   don't restore short_ship if there's nothing left to fulfill;
                #   don't restore 'removed' (we already short-circuited above).
                if old_status and not (
                    old_status == "short_ship" and (obj.fulfillable_quantity or 0) <= 0
                ):
                    obj.app_line_status = old_status
                if old_ss_li_id:
                    obj.shipstation_line_item_id = old_ss_li_id
                db.add(obj)

            orders_changed.add(order.shopify_order_id)
            lines_updated += 1

    db.flush()
    return {
        "orders_changed": list(orders_changed),
        "lines_updated":  lines_updated,
        "orders_scanned": len(orders),
    }


def recompute_open_orders(
    db: Session,
    order_ids: Optional[list[str]] = None,
    auto_replan: bool = True,
) -> dict:
    """
    Refresh open orders against the current SKU mapping and short-ship/inventory-hold
    config — without pulling from Shopify.

    Steps (mirrors Pull Shopify minus the fetch step):
      1. Re-resolve pick_sku / mix_quantity / sku_mapped on every line item.
      2. Re-apply short-ship + inventory-hold rules (deletes affected pending boxes,
         unstages affected staged orders).
      3. For orders whose pick_skus changed and that are still un-staged: delete
         their pending unpushed boxes and re-run auto-plan so boxes match the new
         pick_skus. (auto_replan=False skips this step.)
      4. Unstage any remaining staged orders that now have plan issues.
      5. Unstage any staged orders that violate order rules (hold, DNSS).
      6. Recompute committed inventory for affected warehouses.

    Orders already in ShipStation are never modified.
    """
    # Local imports to avoid circular dependencies at module load
    from routers.products import apply_short_ship_to_orders
    from routers.orders import _unstage_orders_with_plan_issues, _unstage_by_order_rules
    from routers.inventory import _recompute_committed

    # Step 1: re-resolve pick_skus on existing line items
    sku_result = _refresh_pick_skus(db, order_ids)
    db.commit()

    # Step 2: re-apply short-ship + inventory-hold rules to all open orders.
    # This may unstage staged orders and delete pending boxes for short-ship items.
    short_ship_result = apply_short_ship_to_orders(db)
    db.commit()

    # Step 3: re-plan orders whose pick_skus changed and are still un-staged.
    # We reset their pending boxes so auto-plan rebuilds from the new line items.
    replan_result = {"created": 0, "repaired": 0, "unmatched": 0}
    if auto_replan and sku_result["orders_changed"]:
        candidates = (
            db.query(models.ShopifyOrder.shopify_order_id)
            .filter(
                models.ShopifyOrder.shopify_order_id.in_(sku_result["orders_changed"]),
                models.ShopifyOrder.app_status.in_(["not_processed", "partially_fulfilled"]),
            )
            .all()
        )
        candidate_ids = [c[0] for c in candidates]
        if candidate_ids:
            # Drop pending unpushed boxes for these orders so auto-plan rebuilds them
            pending_boxes = (
                db.query(models.FulfillmentBox.id)
                .join(models.FulfillmentPlan, models.FulfillmentPlan.id == models.FulfillmentBox.plan_id)
                .filter(
                    models.FulfillmentPlan.shopify_order_id.in_(candidate_ids),
                    models.FulfillmentPlan.status != "cancelled",
                    models.FulfillmentBox.status == "pending",
                    models.FulfillmentBox.shipstation_order_id.is_(None),
                )
                .all()
            )
            box_ids = [b[0] for b in pending_boxes]
            if box_ids:
                db.query(models.BoxLineItem).filter(
                    models.BoxLineItem.box_id.in_(box_ids)
                ).delete(synchronize_session=False)
                db.query(models.FulfillmentBox).filter(
                    models.FulfillmentBox.id.in_(box_ids)
                ).delete(synchronize_session=False)
                db.commit()

            from routers.fulfillment import bulk_auto_plan, BulkAutoPlanRequest
            res = bulk_auto_plan(BulkAutoPlanRequest(order_ids=candidate_ids), db)
            replan_result = {
                "created":   res.get("created", 0),
                "repaired":  res.get("repaired", 0),
                "unmatched": res.get("unmatched", 0),
            }

    # Step 3.5: clean up empty pending boxes attached to orders that now have
    # nothing to ship (everything short-shipped, fulfilled, or unmapped). These
    # are leftovers from earlier auto-plan runs that didn't have the
    # nothing-to-ship guard.
    empty_boxes_removed = 0
    empty_pending = (
        db.query(models.FulfillmentBox)
        .join(models.FulfillmentPlan, models.FulfillmentPlan.id == models.FulfillmentBox.plan_id)
        .join(models.ShopifyOrder, models.ShopifyOrder.shopify_order_id == models.FulfillmentPlan.shopify_order_id)
        .filter(
            models.FulfillmentBox.status == "pending",
            models.FulfillmentBox.shipstation_order_id.is_(None),
            models.FulfillmentPlan.status != "cancelled",
            models.ShopifyOrder.app_status.in_(RECOMPUTE_STATUSES),
        )
        .all()
    )
    for box in empty_pending:
        item_count = (
            db.query(models.BoxLineItem)
            .filter(models.BoxLineItem.box_id == box.id)
            .count()
        )
        if item_count > 0:
            continue
        # Empty box — only delete if the order has nothing to ship right now
        plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.id == box.plan_id
        ).first()
        if not plan:
            continue
        from sqlalchemy import or_ as _or
        shippable_count = (
            db.query(models.ShopifyLineItem)
            .filter(
                models.ShopifyLineItem.shopify_order_id == plan.shopify_order_id,
                models.ShopifyLineItem.sku_mapped == True,
                models.ShopifyLineItem.pick_sku.isnot(None),
                models.ShopifyLineItem.fulfillable_quantity > 0,
                _or(
                    models.ShopifyLineItem.app_line_status != "short_ship",
                    models.ShopifyLineItem.app_line_status.is_(None),
                ),
            )
            .count()
        )
        if shippable_count == 0:
            db.delete(box)
            empty_boxes_removed += 1
    if empty_boxes_removed:
        db.commit()

    # Step 4: unstage staged orders that still have plan issues
    plan_unstaged = _unstage_orders_with_plan_issues(db)
    db.commit()

    # Step 5: unstage staged orders that violate order rules (hold, DNSS).
    # check_margin=False matches Pull Shopify; the dedicated /products/apply call
    # runs the margin check separately.
    rule_unstage = _unstage_by_order_rules(db, check_margin=False)
    db.commit()

    # Step 6: recompute committed inventory per affected warehouse
    affected_wh: set[str] = set()
    if sku_result["orders_changed"]:
        for (wh,) in (
            db.query(models.ShopifyOrder.assigned_warehouse)
            .filter(models.ShopifyOrder.shopify_order_id.in_(sku_result["orders_changed"]))
            .distinct()
            .all()
        ):
            if wh:
                affected_wh.add(wh)
    for wh in affected_wh:
        _recompute_committed(wh, db)
    if affected_wh:
        db.commit()

    return {
        "orders_scanned":              sku_result["orders_scanned"],
        "orders_with_sku_changes":     len(sku_result["orders_changed"]),
        "lines_updated":               sku_result["lines_updated"],
        "orders_replanned_created":    replan_result["created"],
        "orders_replanned_repaired":   replan_result["repaired"],
        "orders_replan_unmatched":     replan_result["unmatched"],
        "orders_unstaged_plan_issues": plan_unstaged,
        "orders_unstaged_hold":        rule_unstage["orders_unstaged_hold"],
        "orders_unstaged_dnss":        rule_unstage["orders_unstaged_dnss"],
        "lines_marked_short_ship":     short_ship_result.get("lines_marked", 0),
        "lines_cleared_short_ship":    short_ship_result.get("lines_cleared", 0),
        "lines_marked_inv_hold":       short_ship_result.get("hold_lines_marked", 0),
        "lines_cleared_inv_hold":      short_ship_result.get("hold_lines_cleared", 0),
        "boxes_deleted_short_ship":    short_ship_result.get("boxes_deleted", 0),
        "orders_unstaged_short_ship":  short_ship_result.get("orders_unstaged", 0),
        "orders_unstaged_inv_hold":    short_ship_result.get("orders_unstaged_hold", 0),
        "empty_boxes_removed":         empty_boxes_removed,
    }
