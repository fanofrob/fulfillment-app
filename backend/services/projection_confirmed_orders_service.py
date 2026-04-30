"""
Projection Confirmed Orders service — builds reproducible box snapshots for the
"confirm demand" flow under Projections. Distinct from the Operations staging
flow: confirming does NOT touch inventory or order status; it just captures the
planned boxes against a projection period for demand rollup.
"""
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

import models


def build_pick_sku_lookup(db: Session) -> dict:
    """
    Return {pick_sku: product_type} sourced from PicklistSku.type. This is the
    pick-level product type (e.g., "Fruit: Apple, Honeycrisp"), not the Shopify
    bundle type (e.g., "Mix Box: Variety Box").
    """
    pick_to_pt: dict = {}
    for ps in db.query(models.PicklistSku).all():
        if ps.pick_sku and ps.type:
            pick_to_pt[ps.pick_sku] = ps.type
    return pick_to_pt


def _weight_map(db: Session) -> dict[str, float]:
    out = {}
    for ps in db.query(models.PicklistSku).all():
        if ps.pick_sku and ps.weight_lb is not None:
            out[ps.pick_sku] = ps.weight_lb
    return out


def _get_active_plan(db: Session, shopify_order_id: str) -> Optional[models.FulfillmentPlan]:
    return (
        db.query(models.FulfillmentPlan)
        .filter(
            models.FulfillmentPlan.shopify_order_id == shopify_order_id,
            models.FulfillmentPlan.status != "cancelled",
        )
        .order_by(models.FulfillmentPlan.version.desc())
        .first()
    )


def build_boxes_snapshot_for_period(
    db: Session,
    order: models.ShopifyOrder,
    period_id: int,
    mapping_tab: str,
    pick_to_pt: dict,
    weight_map: dict,
) -> list[dict]:
    """
    Build a frozen box snapshot using the SAME planner Operations uses, but with:
      - line items re-resolved against `mapping_tab` (period-chosen SKU mapping)
      - app_line_status masked by the period's Confirmed Demand short-ship /
        inventory-hold configs (lines marked short_ship / inventory_hold drop)

    The Operations FulfillmentPlan / FulfillmentBox rows are never touched —
    this returns boxes as data only.

    Returns a flat list of snapshot items in the same shape the rollup consumes:
      [{pick_sku, shopify_sku, quantity, weight_lb, product_type}, ...]

    Raises ValueError when the order can't be planned at all under this
    period's config (no shippable items, no applicable box types, etc.).
    """
    # Local import to avoid a router→service→router import cycle at module load.
    from services import mapping_override
    from routers.fulfillment import compute_boxes_for_order

    override_lis = mapping_override.build_override_line_items(
        order.shopify_order_id, mapping_tab, db, period_id=period_id
    )
    if not override_lis:
        raise ValueError(f"No line items resolved under mapping tab '{mapping_tab}'")

    boxes, errors = compute_boxes_for_order(order, override_lis, db)
    if not boxes:
        msg = "; ".join(errors) if errors else "Plan produced no shippable boxes"
        raise ValueError(msg)

    items: list[dict] = []
    for box in boxes:
        for (pick_sku, _li_id), qty in box["items"].items():
            if not pick_sku or qty is None:
                continue
            # Find the source shopify_sku for this pick_sku via the override rows
            shopify_sku = next(
                (l.get("shopify_sku") for l in override_lis if l.get("pick_sku") == pick_sku),
                None,
            )
            items.append({
                "pick_sku":     pick_sku,
                "shopify_sku":  shopify_sku,
                "quantity":     float(qty),
                "weight_lb":    weight_map.get(pick_sku),
                "product_type": pick_to_pt.get(pick_sku),
            })
    return items


def confirm_orders(
    db: Session,
    period_id: int,
    order_ids: list[str],
    mapping_tab: str,
) -> list[dict]:
    """
    Upsert ProjectionPeriodConfirmedOrder rows for the given orders. Does not
    modify order status or inventory. Returns per-order results.
    """
    pick_to_pt = build_pick_sku_lookup(db)
    weight_map = _weight_map(db)

    period = (
        db.query(models.ProjectionPeriod)
        .filter(models.ProjectionPeriod.id == period_id)
        .first()
    )
    if not period:
        raise ValueError(f"Period {period_id} not found")
    window_start = period.fulfillment_start
    window_end = period.fulfillment_end

    results = []
    for oid in order_ids:
        order = (
            db.query(models.ShopifyOrder)
            .filter(models.ShopifyOrder.shopify_order_id == oid)
            .first()
        )
        if not order:
            results.append({"order_id": oid, "success": False, "error": "Order not found"})
            continue

        # Eligibility: same plan-based rules as staging
        if order.app_status not in ("not_processed", "partially_fulfilled"):
            results.append({
                "order_id": oid,
                "success": False,
                "error": f"Order is '{order.app_status}' — only unfulfilled orders can be confirmed",
            })
            continue

        # Temporal guard: order's Shopify creation time must fall within the
        # period's fulfillment window (when that window is defined).
        if window_start is not None and window_end is not None:
            created = order.created_at_shopify
            if created is None:
                results.append({
                    "order_id": oid,
                    "success": False,
                    "error": "Order has no Shopify creation date; cannot validate fulfillment window",
                })
                continue
            if created < window_start or created > window_end:
                results.append({
                    "order_id": oid,
                    "success": False,
                    "error": (
                        f"Order created {created.isoformat()} is outside the period's "
                        f"fulfillment window ({window_start.isoformat()} → {window_end.isoformat()})"
                    ),
                })
                continue

        try:
            snapshot = build_boxes_snapshot_for_period(
                db, order, period_id, mapping_tab, pick_to_pt, weight_map
            )
        except ValueError as e:
            results.append({"order_id": oid, "success": False, "error": str(e)})
            continue

        if not snapshot:
            results.append({"order_id": oid, "success": False, "error": "Plan has no box line items"})
            continue

        existing = (
            db.query(models.ProjectionPeriodConfirmedOrder)
            .filter(
                models.ProjectionPeriodConfirmedOrder.period_id == period_id,
                models.ProjectionPeriodConfirmedOrder.shopify_order_id == oid,
            )
            .first()
        )
        if existing:
            existing.boxes_snapshot = snapshot
            existing.mapping_used = mapping_tab
            existing.confirmed_at = datetime.now(timezone.utc)
        else:
            db.add(models.ProjectionPeriodConfirmedOrder(
                period_id=period_id,
                shopify_order_id=oid,
                boxes_snapshot=snapshot,
                mapping_used=mapping_tab,
            ))
        results.append({"order_id": oid, "success": True})

    db.commit()
    return results


def apply_cd_status_to_confirmed_orders(
    db: Session,
    period_id: int,
    changed_skus: set[str],
) -> dict:
    """
    Auto-unconfirm cascade: when a CD short-ship / inventory-hold config row
    changes for `period_id`, drop the confirmation for any order whose stored
    snapshot or live line items reference one of the changed SKUs.

    `changed_skus` is the set of shopify_skus whose CD status flipped in this
    config write (added, removed, or moved between short-ship/hold).

    Caller is responsible for db.commit() — typically the endpoint that already
    commits the config write. Caller is also expected to follow with
    `replan_and_reconfirm_for_period(period_id, items_to_reconfirm)` so the
    affected orders get fresh plans + snapshots immediately.

    Returns {
      "unconfirmed": int,
      "order_ids": [str, ...],
      "items_to_reconfirm": [{"shopify_order_id": str, "mapping_used": str}, ...]
    }.
    """
    if not changed_skus:
        return {"unconfirmed": 0, "order_ids": [], "items_to_reconfirm": []}

    confirmed = (
        db.query(models.ProjectionPeriodConfirmedOrder)
        .filter(models.ProjectionPeriodConfirmedOrder.period_id == period_id)
        .all()
    )
    if not confirmed:
        return {"unconfirmed": 0, "order_ids": [], "items_to_reconfirm": []}

    affected: list[str] = []
    items_to_reconfirm: list[dict] = []
    for c in confirmed:
        hit = False
        # 1) Snapshot reference: SKU was IN the snapshot and just got short-shipped/held
        snap_skus = {
            it.get("shopify_sku") for it in (c.boxes_snapshot or [])
            if it.get("shopify_sku")
        }
        if snap_skus & changed_skus:
            hit = True
        else:
            # 2) Live line reference: SKU was excluded by old config and now isn't
            line_skus = {
                li.shopify_sku for li in
                db.query(models.ShopifyLineItem.shopify_sku)
                .filter(models.ShopifyLineItem.shopify_order_id == c.shopify_order_id)
                .all()
                if li.shopify_sku
            }
            if line_skus & changed_skus:
                hit = True
        if hit:
            affected.append(c.shopify_order_id)
            if c.mapping_used:
                items_to_reconfirm.append({
                    "shopify_order_id": c.shopify_order_id,
                    "mapping_used":     c.mapping_used,
                })

    if affected:
        db.query(models.ProjectionPeriodConfirmedOrder).filter(
            models.ProjectionPeriodConfirmedOrder.period_id == period_id,
            models.ProjectionPeriodConfirmedOrder.shopify_order_id.in_(affected),
        ).delete(synchronize_session=False)

    return {
        "unconfirmed": len(affected),
        "order_ids": affected,
        "items_to_reconfirm": items_to_reconfirm,
    }


def replan_and_reconfirm_for_period(
    db: Session,
    period_id: int,
    items: list[dict],
) -> dict:
    """
    For each order in `items` (each {shopify_order_id, mapping_used}):
      1) Run order_recompute.recompute_open_orders so the operations-level plan
         reflects the latest SKU mapping + global short-ship config.
      2) Re-confirm the order in `period_id` using its prior mapping_used so a
         fresh box snapshot is written.

    Orders are grouped by mapping_used so confirm_orders can run once per
    distinct mapping. Returns a per-mapping summary plus the recompute summary.
    """
    if not items:
        return {"reconfirmed": 0, "results_by_mapping": {}, "recompute": None}

    from services.order_recompute import recompute_open_orders

    order_ids = [it["shopify_order_id"] for it in items]
    recompute = recompute_open_orders(db, order_ids=order_ids, auto_replan=True)

    grouped: dict[str, list[str]] = defaultdict(list)
    for it in items:
        grouped[it["mapping_used"]].append(it["shopify_order_id"])

    results_by_mapping: dict[str, dict] = {}
    total_reconfirmed = 0
    for mapping_tab, oids in grouped.items():
        results = confirm_orders(db, period_id, oids, mapping_tab)
        ok = sum(1 for r in results if r.get("success"))
        total_reconfirmed += ok
        results_by_mapping[mapping_tab] = {
            "attempted": len(oids),
            "reconfirmed": ok,
            "results": results,
        }
    return {
        "reconfirmed": total_reconfirmed,
        "results_by_mapping": results_by_mapping,
        "recompute": recompute,
    }


def auto_reconfirm_across_periods(
    db: Session,
    order_ids: list[str],
) -> dict:
    """
    Refresh the confirmed-order box snapshots for `order_ids` in every
    non-archived period that already had them confirmed. Each row is
    re-confirmed with its existing mapping_used.

    Use this after a SKU mapping or SKU helper change has run
    recompute_open_orders — confirmed snapshots that reference orders whose
    pick_skus just changed become stale and need to be rebuilt.

    Does NOT run recompute_open_orders itself — caller already did.
    """
    if not order_ids:
        return {"reconfirmed": 0, "results_by_period": {}}

    rows = (
        db.query(
            models.ProjectionPeriodConfirmedOrder.period_id,
            models.ProjectionPeriodConfirmedOrder.shopify_order_id,
            models.ProjectionPeriodConfirmedOrder.mapping_used,
        )
        .join(
            models.ProjectionPeriod,
            models.ProjectionPeriod.id == models.ProjectionPeriodConfirmedOrder.period_id,
        )
        .filter(
            models.ProjectionPeriodConfirmedOrder.shopify_order_id.in_(order_ids),
            models.ProjectionPeriod.status != "archived",
        )
        .all()
    )

    grouped: dict[tuple[int, str], list[str]] = defaultdict(list)
    for period_id, shopify_order_id, mapping_used in rows:
        if not mapping_used:
            continue
        grouped[(period_id, mapping_used)].append(shopify_order_id)

    results_by_period: dict[int, dict] = {}
    total_reconfirmed = 0
    for (period_id, mapping_tab), oids in grouped.items():
        results = confirm_orders(db, period_id, oids, mapping_tab)
        ok = sum(1 for r in results if r.get("success"))
        total_reconfirmed += ok
        per_period = results_by_period.setdefault(period_id, {
            "attempted": 0, "reconfirmed": 0, "results_by_mapping": {},
        })
        per_period["attempted"] += len(oids)
        per_period["reconfirmed"] += ok
        per_period["results_by_mapping"][mapping_tab] = {
            "attempted": len(oids),
            "reconfirmed": ok,
            "results": results,
        }
    return {"reconfirmed": total_reconfirmed, "results_by_period": results_by_period}


def list_unconfirmed_eligible_order_ids(db: Session, period_id: int) -> list[str]:
    """
    Return shopify_order_ids that:
      - are NOT currently in projection_period_confirmed_orders for this period
      - have app_status in ('not_processed', 'partially_fulfilled') (same filter as confirm)
      - fall inside the period's fulfillment window (when defined)
    Used by the Re-confirm All bulk action.
    """
    period = (
        db.query(models.ProjectionPeriod)
        .filter(models.ProjectionPeriod.id == period_id)
        .first()
    )
    if not period:
        return []
    confirmed_ids = {
        r.shopify_order_id for r in
        db.query(models.ProjectionPeriodConfirmedOrder.shopify_order_id)
        .filter(models.ProjectionPeriodConfirmedOrder.period_id == period_id)
        .all()
    }
    q = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.app_status.in_(("not_processed", "partially_fulfilled"))
    )
    if period.fulfillment_start is not None and period.fulfillment_end is not None:
        q = q.filter(
            models.ShopifyOrder.created_at_shopify >= period.fulfillment_start,
            models.ShopifyOrder.created_at_shopify <= period.fulfillment_end,
        )
    return [
        o.shopify_order_id for o in q.all()
        if o.shopify_order_id not in confirmed_ids
    ]


def unconfirm_orders(db: Session, period_id: int, order_ids: list[str]) -> int:
    deleted = (
        db.query(models.ProjectionPeriodConfirmedOrder)
        .filter(
            models.ProjectionPeriodConfirmedOrder.period_id == period_id,
            models.ProjectionPeriodConfirmedOrder.shopify_order_id.in_(order_ids),
        )
        .delete(synchronize_session=False)
    )
    db.commit()
    return deleted


def load_confirmed_demand_excluded_skus(db: Session, period_id: int) -> set[str]:
    """
    Return the set of shopify_skus excluded from confirmed-demand rollup for
    this period — union of the period's Confirmed Demand short-ship and
    inventory-hold configs. Independent of `period_short_ship_configs` and
    `shopify_products.allow_short_ship`.
    """
    short = {
        r.shopify_sku for r in
        db.query(models.ConfirmedDemandShortShipConfig.shopify_sku)
        .filter(models.ConfirmedDemandShortShipConfig.period_id == period_id)
        .all()
    }
    hold = {
        r.shopify_sku for r in
        db.query(models.ConfirmedDemandInventoryHoldConfig.shopify_sku)
        .filter(models.ConfirmedDemandInventoryHoldConfig.period_id == period_id)
        .all()
    }
    return short | hold


def rollup_lbs_by_product_type(db: Session, period_id: int) -> dict[str, float]:
    """
    Sum weight_lb × quantity across every confirmed order's box snapshot,
    excluding snapshot items whose source shopify_sku is configured as
    short-ship or inventory-hold for this period in the Confirmed Demand
    Dashboard. Snapshots written before the shopify_sku field was added carry
    no shopify_sku — those items are always included (no info to filter on).
    """
    excluded = load_confirmed_demand_excluded_skus(db, period_id)
    rows = (
        db.query(models.ProjectionPeriodConfirmedOrder)
        .filter(models.ProjectionPeriodConfirmedOrder.period_id == period_id)
        .all()
    )
    totals: dict[str, float] = defaultdict(float)
    for row in rows:
        for item in (row.boxes_snapshot or []):
            pt = item.get("product_type")
            qty = item.get("quantity") or 0.0
            w = item.get("weight_lb")
            if not pt or not w:
                continue
            sku = item.get("shopify_sku")
            if sku and sku in excluded:
                continue
            totals[pt] += float(qty) * float(w)
    return {pt: round(lbs, 2) for pt, lbs in totals.items()}


def confirmed_demand_inventory_pivot(db: Session, period_id: int) -> list[dict]:
    """
    Pivot of confirmed demand vs. on-hand inventory, scoped to this period.
    Returns one row per pick_sku with {pick_sku, on_hand_qty, total_demand,
    ending_qty, has_shortage, shopify_sku_breakdown}. Excluded shopify_skus
    (short-ship / inventory-hold per the Confirmed Demand Dashboard) are not
    counted toward demand.
    """
    excluded = load_confirmed_demand_excluded_skus(db, period_id)

    rows = (
        db.query(models.ProjectionPeriodConfirmedOrder)
        .filter(models.ProjectionPeriodConfirmedOrder.period_id == period_id)
        .all()
    )

    by_pick: dict[str, dict] = {}
    for row in rows:
        for item in (row.boxes_snapshot or []):
            pick = item.get("pick_sku")
            if not pick:
                continue
            sku = item.get("shopify_sku")
            if sku and sku in excluded:
                continue
            qty = float(item.get("quantity") or 0.0)
            entry = by_pick.setdefault(pick, {
                "pick_sku": pick,
                "total_demand": 0.0,
                "shopify_sku_breakdown": {},
            })
            entry["total_demand"] += qty
            if sku:
                bd = entry["shopify_sku_breakdown"].setdefault(sku, {"shopify_sku": sku, "units": 0.0})
                bd["units"] += qty

    inv_rows = (
        db.query(models.InventoryItem)
        .filter(models.InventoryItem.pick_sku.in_(list(by_pick.keys()) or [""]))
        .all()
    )
    on_hand_by_pick: dict[str, float] = defaultdict(float)
    for inv in inv_rows:
        on_hand_by_pick[inv.pick_sku] += float(inv.on_hand_qty or 0.0)

    out: list[dict] = []
    for pick, entry in by_pick.items():
        on_hand = on_hand_by_pick.get(pick, 0.0)
        ending = on_hand - entry["total_demand"]
        out.append({
            "pick_sku": pick,
            "on_hand_qty": round(on_hand, 2),
            "total_demand": round(entry["total_demand"], 2),
            "ending_qty": round(ending, 2),
            "has_shortage": ending < 0,
            "shopify_sku_breakdown": [
                {"shopify_sku": v["shopify_sku"], "units": round(v["units"], 2)}
                for v in entry["shopify_sku_breakdown"].values()
            ],
        })
    out.sort(key=lambda r: (not r["has_shortage"], r["pick_sku"]))
    return out


def mapping_used_breakdown(db: Session, period_id: int) -> list[dict]:
    """
    Return [{mapping_tab, count}, ...] sorted by count desc — one row per
    distinct mapping_used value across confirmed orders for the period.
    """
    counts: dict[str, int] = defaultdict(int)
    rows = (
        db.query(models.ProjectionPeriodConfirmedOrder.mapping_used)
        .filter(models.ProjectionPeriodConfirmedOrder.period_id == period_id)
        .all()
    )
    for r in rows:
        tab = r[0] or ""
        counts[tab] += 1
    return [
        {"mapping_tab": tab, "count": c}
        for tab, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


def count_staged_orders(db: Session) -> int:
    """Used to block save if any orders are currently staged in Operations."""
    return (
        db.query(models.ShopifyOrder)
        .filter(models.ShopifyOrder.app_status == "staged")
        .count()
    )


def save_confirmed_demand(db: Session, period_id: int) -> dict:
    """
    Roll up all confirmed orders for the period into product-type totals and
    write to ProjectionPeriod.confirmed_demand_manual_lbs. Sets the manual flag.
    """
    period = (
        db.query(models.ProjectionPeriod)
        .filter(models.ProjectionPeriod.id == period_id)
        .first()
    )
    if not period:
        raise ValueError(f"Period {period_id} not found")

    totals = rollup_lbs_by_product_type(db, period_id)
    period.confirmed_demand_manual_lbs = totals
    period.has_manual_confirmed_demand = True
    period.confirmed_demand_saved_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(period)
    return {
        "period_id": period_id,
        "confirmed_demand_manual_lbs": totals,
        "has_manual_confirmed_demand": True,
        "confirmed_demand_saved_at": period.confirmed_demand_saved_at,
    }


def revert_confirmed_demand(db: Session, period_id: int) -> dict:
    """Clear manual override; dashboard falls back to confirmed_demand_auto_lbs."""
    period = (
        db.query(models.ProjectionPeriod)
        .filter(models.ProjectionPeriod.id == period_id)
        .first()
    )
    if not period:
        raise ValueError(f"Period {period_id} not found")

    period.confirmed_demand_manual_lbs = None
    period.has_manual_confirmed_demand = False
    period.confirmed_demand_saved_at = None
    db.commit()
    db.refresh(period)
    return {
        "period_id": period_id,
        "has_manual_confirmed_demand": False,
        "confirmed_demand_auto_lbs": period.confirmed_demand_auto_lbs or {},
    }
