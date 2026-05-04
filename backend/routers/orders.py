"""
Orders router — pulls Shopify orders and manages their fulfillment pipeline status.

Order statuses (app_status):
  not_processed          → pulled from Shopify, not yet staged; inventory NOT committed
  staged                 → staged for fulfillment; inventory IS committed; can push to ShipStation
  in_shipstation_not_shipped → pushed to ShipStation, awaiting shipment
  in_shipstation_shipped → ShipStation confirms shipped, tracking available
  fulfilled              → all line items fulfilled in Shopify
  partially_fulfilled    → some line items fulfilled in Shopify
"""
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from services import shopify_service, sheets_service, mapping_override
from routers.inventory import _recompute_committed
from routers.fulfillment import _zone_for_zip
from routers.products import _sync_products, apply_short_ship_to_orders, _get_active_rule_tags

router = APIRouter()

VALID_APP_STATUSES = {
    "not_processed",
    "staged",
    "in_shipstation_not_shipped",
    "in_shipstation_shipped",
    "fulfilled",
    "partially_fulfilled",
}

# Shopify financial statuses that indicate payment is not yet complete
PENDING_PAYMENT_STATUSES = {"pending", "partially_paid"}

# Statuses that should NOT be overwritten when re-pulling from Shopify
# (order is already in progress — don't reset it)
IN_PROGRESS_STATUSES = {
    "staged",
    "in_shipstation_not_shipped",
    "in_shipstation_shipped",
}

# Orders committed to ShipStation — never reset to not_processed, but CAN be marked fulfilled
SHIPSTATION_STATUSES = {"in_shipstation_not_shipped", "in_shipstation_shipped"}


def _build_order_response(
    order: models.ShopifyOrder,
    db: Session,
    has_plan: bool = False,
    plan_box_unmatched: bool = False,
    has_plan_mismatch: bool = False,
    mapping_tab_override: Optional[str] = None,
    period_id_override: Optional[int] = None,
) -> schemas.ShopifyOrderOut:
    line_items = (
        db.query(models.ShopifyLineItem)
        .filter(models.ShopifyLineItem.shopify_order_id == order.shopify_order_id)
        .all()
    )
    # Period override mutates app_line_status in-memory only — see
    # mapping_override.apply_period_status_overrides for safety notes.
    mapping_override.apply_period_status_overrides(line_items, period_id_override, db)

    # Build shopify_sku → product_type lookup from the product catalog
    skus = {li.shopify_sku for li in line_items if li.shopify_sku}
    product_type_map: dict = {}
    if skus:
        rows = (
            db.query(models.ShopifyProduct.shopify_sku, models.ShopifyProduct.product_type)
            .filter(models.ShopifyProduct.shopify_sku.in_(skus))
            .all()
        )
        product_type_map = {r.shopify_sku: r.product_type for r in rows}

    line_item_outs = []
    if mapping_tab_override:
        # Live preview: re-resolve pick_sku / mix_quantity / sku_mapped against
        # the override tab without touching the DB. May produce more rows than
        # the underlying ShopifyLineItem table when a SKU explodes into multiple
        # components in the new mapping.
        override_rows = mapping_override.override_response_line_items(
            line_items, mapping_tab_override
        )
        for li_data in override_rows:
            li_data["product_type"] = product_type_map.get(li_data.get("shopify_sku"))
            line_item_outs.append(schemas.LineItemOut(**li_data))
    else:
        for li in line_items:
            li_data = {c.name: getattr(li, c.name) for c in li.__table__.columns}
            li_data["product_type"] = product_type_map.get(li.shopify_sku)
            line_item_outs.append(schemas.LineItemOut(**li_data))

    return schemas.ShopifyOrderOut(
        **{c.name: getattr(order, c.name) for c in order.__table__.columns},
        line_items=line_item_outs,
        zone=_zone_for_zip(order.shipping_zip),
        has_plan=has_plan,
        plan_box_unmatched=plan_box_unmatched,
        has_plan_mismatch=has_plan_mismatch,
    )


def _check_plan_mismatch(
    order_id: str,
    db: Session,
    mapping_tab: Optional[str] = None,
    period_id: Optional[int] = None,
) -> bool:
    """
    Returns True if the plan's box quantities don't match the order's line items.
    Catches both under-coverage (items missing from boxes) and over-coverage
    (boxes have SKUs or quantities exceeding what the order now requires).
    Note: requires_shipping is intentionally excluded — items with a mapped pick_sku
    must be packed regardless of Shopify's requires_shipping flag (e.g. promo items).

    When `mapping_tab` is provided, `needed` is computed by re-resolving line
    items against that override mapping instead of the warehouse-default DB
    pick_skus + SkuMapping. This keeps the mismatch check consistent with a
    plan that was built against the same override (e.g. Confirmed Orders).
    """
    needed: dict[str, float] = {}

    if mapping_tab:
        from services import mapping_override
        override_rows = mapping_override.build_override_line_items(
            order_id, mapping_tab, db, period_id=period_id
        )
        for row in override_rows:
            if row.get("app_line_status") in ("short_ship", "removed"):
                continue
            pick_sku = row.get("pick_sku")
            if not pick_sku:
                continue
            qty = (row.get("fulfillable_quantity") or 0) * (row.get("mix_quantity") or 1.0)
            if qty <= 0:
                continue
            needed[pick_sku] = needed.get(pick_sku, 0.0) + qty
    else:
        line_items = (
            db.query(
                models.ShopifyLineItem.pick_sku,
                models.ShopifyLineItem.fulfillable_quantity,
                models.ShopifyLineItem.mix_quantity,
            )
            .filter(
                models.ShopifyLineItem.shopify_order_id == order_id,
                models.ShopifyLineItem.sku_mapped == True,
                models.ShopifyLineItem.fulfillable_quantity > 0,
                models.ShopifyLineItem.pick_sku != None,
                or_(models.ShopifyLineItem.app_line_status.notin_(["short_ship", "removed"]), models.ShopifyLineItem.app_line_status.is_(None)),
            )
            .all()
        )
        for li in line_items:
            qty = (li.fulfillable_quantity or 0) * (li.mix_quantity or 1.0)
            needed[li.pick_sku] = needed.get(li.pick_sku, 0.0) + qty

        # Also expand mix-box line items (pick_sku=None, sku_mapped=True) via SkuMapping
        order_obj = db.query(models.ShopifyOrder).filter(
            models.ShopifyOrder.shopify_order_id == order_id
        ).first()
        warehouse = order_obj.assigned_warehouse if order_obj else None
        if warehouse:
            mix_lis = (
                db.query(
                    models.ShopifyLineItem.shopify_sku,
                    models.ShopifyLineItem.fulfillable_quantity,
                )
                .filter(
                    models.ShopifyLineItem.shopify_order_id == order_id,
                    models.ShopifyLineItem.sku_mapped == True,
                    models.ShopifyLineItem.fulfillable_quantity > 0,
                    models.ShopifyLineItem.pick_sku == None,
                    or_(models.ShopifyLineItem.app_line_status.notin_(["short_ship", "removed"]), models.ShopifyLineItem.app_line_status.is_(None)),
                )
                .all()
            )
            for mli in mix_lis:
                if not mli.shopify_sku:
                    continue
                sm_rows = db.query(models.SkuMapping).filter(
                    models.SkuMapping.shopify_sku == mli.shopify_sku,
                    models.SkuMapping.warehouse == warehouse,
                    models.SkuMapping.pick_sku != None,
                    models.SkuMapping.is_active == True,
                ).all()
                for sm in sm_rows:
                    qty = (mli.fulfillable_quantity or 0) * (sm.mix_quantity or 1.0)
                    needed[sm.pick_sku] = needed.get(sm.pick_sku, 0.0) + qty

    box_items = (
        db.query(
            models.BoxLineItem.pick_sku,
            models.BoxLineItem.quantity,
        )
        .join(models.FulfillmentBox, models.FulfillmentBox.id == models.BoxLineItem.box_id)
        .join(models.FulfillmentPlan, models.FulfillmentPlan.id == models.FulfillmentBox.plan_id)
        .filter(
            models.FulfillmentPlan.shopify_order_id == order_id,
            models.FulfillmentPlan.status != "cancelled",
            models.FulfillmentBox.status.notin_(["cancelled", "shipped", "fulfilled"]),
        )
        .all()
    )
    boxed: dict[str, float] = {}
    for bi in box_items:
        boxed[bi.pick_sku] = boxed.get(bi.pick_sku, 0.0) + bi.quantity

    # Under-coverage: needed SKU not fully covered by boxes
    for sku, qty in needed.items():
        if boxed.get(sku, 0.0) < qty - 0.001:
            return True

    # Over-coverage: boxes have a SKU not needed, or more qty than needed
    for sku, qty in boxed.items():
        if qty > needed.get(sku, 0.0) + 0.001:
            return True

    return False


# ── List orders ───────────────────────────────────────────────────────────────

@router.get("/", response_model=List[schemas.ShopifyOrderOut])
def list_orders(
    app_status: Optional[str] = Query(None, description="Filter by app_status"),
    tag: Optional[str] = Query(None, description="Case-insensitive tag contains"),
    search: Optional[str] = Query(None, description="Search order number, customer name/email"),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=2000),
    mapping_tab: Optional[str] = Query(None, description="Re-resolve line item pick SKUs against this sheet tab (preview, no DB writes)"),
    period_id: Optional[int] = Query(None, description="Apply this projection period's short-ship/inventory-hold configs as in-memory overrides on app_line_status (no DB writes)"),
    db: Session = Depends(get_db),
):
    q = db.query(models.ShopifyOrder)

    if app_status:
        q = q.filter(models.ShopifyOrder.app_status == app_status)

    if tag:
        t = f"%{tag.lower()}%"
        q = q.filter(models.ShopifyOrder.tags.ilike(t))

    if search:
        s = f"%{search.lower()}%"
        q = q.filter(
            models.ShopifyOrder.shopify_order_number.ilike(s) |
            models.ShopifyOrder.customer_name.ilike(s) |
            models.ShopifyOrder.customer_email.ilike(s)
        )

    orders = (
        q.order_by(models.ShopifyOrder.created_at_shopify.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    # Batch lookup which orders have a non-cancelled fulfillment plan
    plan_order_ids: set = set()
    unmatched_order_ids: set = set()
    mismatch_order_ids: set = set()
    if orders:
        order_ids = [o.shopify_order_id for o in orders]
        plan_order_ids = {
            row[0] for row in db.query(models.FulfillmentPlan.shopify_order_id)
            .filter(
                models.FulfillmentPlan.shopify_order_id.in_(order_ids),
                models.FulfillmentPlan.status != "cancelled",
            )
            .distinct()
            .all()
        }
        # Orders where a plan exists but at least one pending box has no box_type assigned.
        # Excludes orders with nothing to ship (filtered below using `needed`).
        unmatched_order_ids = {
            row[0] for row in db.query(models.FulfillmentPlan.shopify_order_id)
            .join(models.FulfillmentBox, models.FulfillmentBox.plan_id == models.FulfillmentPlan.id)
            .filter(
                models.FulfillmentPlan.shopify_order_id.in_(order_ids),
                models.FulfillmentPlan.status != "cancelled",
                models.FulfillmentBox.box_type_id == None,
                models.FulfillmentBox.status == "pending",
            )
            .distinct()
            .all()
        }
        # Orders with plans where box quantities don't match the order (under or over)
        if plan_order_ids:
            # Aggregate needed qty: order_id -> {pick_sku -> qty}
            # When mapping_tab is set, re-resolve each order's items against
            # the override mapping so the mismatch check matches the planner
            # used on this page (e.g. Confirmed Orders' agg mapping).
            needed: dict[str, dict[str, float]] = {}
            if mapping_tab:
                from services import mapping_override
                for oid in plan_order_ids:
                    rows = mapping_override.build_override_line_items(
                        oid, mapping_tab, db, period_id=period_id
                    )
                    for row in rows:
                        if row.get("app_line_status") in ("short_ship", "removed"):
                            continue
                        pick_sku = row.get("pick_sku")
                        if not pick_sku:
                            continue
                        qty = (row.get("fulfillable_quantity") or 0) * (row.get("mix_quantity") or 1.0)
                        if qty <= 0:
                            continue
                        needed.setdefault(oid, {})
                        needed[oid][pick_sku] = needed[oid].get(pick_sku, 0.0) + qty
            else:
                # Default: warehouse-resolved DB pick_skus + SkuMapping mix expansion.
                # Note: requires_shipping excluded — mapped pick_sku items must be packed
                # regardless of Shopify's requires_shipping flag (e.g. promo items).
                li_rows = (
                    db.query(
                        models.ShopifyLineItem.shopify_order_id,
                        models.ShopifyLineItem.pick_sku,
                        models.ShopifyLineItem.fulfillable_quantity,
                        models.ShopifyLineItem.mix_quantity,
                    )
                    .filter(
                        models.ShopifyLineItem.shopify_order_id.in_(plan_order_ids),
                        models.ShopifyLineItem.sku_mapped == True,
                        models.ShopifyLineItem.fulfillable_quantity > 0,
                        models.ShopifyLineItem.pick_sku != None,
                        or_(models.ShopifyLineItem.app_line_status.notin_(["short_ship", "removed"]), models.ShopifyLineItem.app_line_status.is_(None)),
                    )
                    .all()
                )
                for li in li_rows:
                    qty = (li.fulfillable_quantity or 0) * (li.mix_quantity or 1.0)
                    needed.setdefault(li.shopify_order_id, {})
                    needed[li.shopify_order_id][li.pick_sku] = (
                        needed[li.shopify_order_id].get(li.pick_sku, 0.0) + qty
                    )
                # Also expand mix-box line items (pick_sku=None) via SkuMapping
                mix_li_rows = (
                    db.query(
                        models.ShopifyLineItem.shopify_order_id,
                        models.ShopifyLineItem.shopify_sku,
                        models.ShopifyLineItem.fulfillable_quantity,
                        models.ShopifyOrder.assigned_warehouse,
                    )
                    .join(models.ShopifyOrder, models.ShopifyOrder.shopify_order_id == models.ShopifyLineItem.shopify_order_id)
                    .filter(
                        models.ShopifyLineItem.shopify_order_id.in_(plan_order_ids),
                        models.ShopifyLineItem.sku_mapped == True,
                        models.ShopifyLineItem.fulfillable_quantity > 0,
                        models.ShopifyLineItem.pick_sku == None,
                        or_(models.ShopifyLineItem.app_line_status.notin_(["short_ship", "removed"]), models.ShopifyLineItem.app_line_status.is_(None)),
                    )
                    .all()
                )
                for mli in mix_li_rows:
                    if not mli.shopify_sku or not mli.assigned_warehouse:
                        continue
                    sm_rows = db.query(models.SkuMapping).filter(
                        models.SkuMapping.shopify_sku == mli.shopify_sku,
                        models.SkuMapping.warehouse == mli.assigned_warehouse,
                        models.SkuMapping.pick_sku != None,
                        models.SkuMapping.is_active == True,
                    ).all()
                    for sm in sm_rows:
                        qty = (mli.fulfillable_quantity or 0) * (sm.mix_quantity or 1.0)
                        needed.setdefault(mli.shopify_order_id, {})
                        needed[mli.shopify_order_id][sm.pick_sku] = (
                            needed[mli.shopify_order_id].get(sm.pick_sku, 0.0) + qty
                        )
            # Gather box item quantities for active (non-shipped/fulfilled/cancelled) boxes
            bi_rows = (
                db.query(
                    models.FulfillmentPlan.shopify_order_id,
                    models.BoxLineItem.pick_sku,
                    models.BoxLineItem.quantity,
                )
                .join(models.FulfillmentBox, models.FulfillmentBox.plan_id == models.FulfillmentPlan.id)
                .join(models.BoxLineItem, models.BoxLineItem.box_id == models.FulfillmentBox.id)
                .filter(
                    models.FulfillmentPlan.shopify_order_id.in_(plan_order_ids),
                    models.FulfillmentPlan.status != "cancelled",
                    models.FulfillmentBox.status.notin_(["cancelled", "shipped", "fulfilled"]),
                )
                .all()
            )
            # Aggregate boxed qty: order_id -> {pick_sku -> qty}
            boxed: dict[str, dict[str, float]] = {}
            for bi in bi_rows:
                boxed.setdefault(bi.shopify_order_id, {})
                boxed[bi.shopify_order_id][bi.pick_sku] = (
                    boxed[bi.shopify_order_id].get(bi.pick_sku, 0.0) + bi.quantity
                )
            # Orders with nothing to ship (everything short-shipped, fulfilled, or unmapped):
            # they're absent from `needed` after both the direct-pick and mix-item passes.
            # Don't flag them with "No Box Rule" — they have no real plan issue.
            shippable_order_ids = set(needed.keys())
            unmatched_order_ids = {oid for oid in unmatched_order_ids if oid in shippable_order_ids}

            # Flag orders with any under-coverage or over-coverage
            for oid, skus in needed.items():
                order_boxed = boxed.get(oid, {})
                # Under-coverage: needed SKU not fully in boxes
                for sku, qty in skus.items():
                    if order_boxed.get(sku, 0.0) < qty - 0.001:
                        mismatch_order_ids.add(oid)
                        break
                if oid in mismatch_order_ids:
                    continue
                # Over-coverage: boxes have SKUs not needed or qty exceeds need
                for sku, qty in order_boxed.items():
                    if qty > skus.get(sku, 0.0) + 0.001:
                        mismatch_order_ids.add(oid)
                        break

        # Don't surface plan/box issues for orders already in ShipStation —
        # the plan is locked once pushed, so any mismatch with refreshed
        # Shopify line items isn't actionable from the Orders page.
        ss_order_ids = {o.shopify_order_id for o in orders if o.app_status in SHIPSTATION_STATUSES}
        if ss_order_ids:
            mismatch_order_ids -= ss_order_ids
            unmatched_order_ids -= ss_order_ids

    return [
        _build_order_response(
            o, db,
            has_plan=o.shopify_order_id in plan_order_ids,
            plan_box_unmatched=o.shopify_order_id in unmatched_order_ids,
            has_plan_mismatch=o.shopify_order_id in mismatch_order_ids,
            mapping_tab_override=mapping_tab,
            period_id_override=period_id,
        )
        for o in orders
    ]


# ── Archived orders ───────────────────────────────────────────────────────────

@router.get("/archived", response_model=list[schemas.ArchivedOrderOut])
def list_archived_orders(
    skip: int = 0,
    limit: int = 500,
    db: Session = Depends(get_db),
):
    """Return orders that were auto-archived in Shopify during a pull."""
    return (
        db.query(models.ArchivedOrder)
        .order_by(models.ArchivedOrder.archived_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


@router.get("/margins")
def get_batch_margins(
    ids: str = Query(..., description="Comma-separated shopify_order_ids"),
    period_id: Optional[int] = Query(None, description="Apply this projection period's short-ship/inventory-hold configs as in-memory overrides on app_line_status (no DB writes)"),
    mapping_tab: Optional[str] = Query(None, description="Re-resolve line item pick SKUs / mix_quantity against this sheet tab for COGS calculation (preview, no DB writes). Revenue is unaffected."),
    db: Session = Depends(get_db),
):
    """
    Batch compute gross_margin_pct for multiple orders.
    Returns {shopify_order_id: float | null}.
    Shares expensive data loads (picklist map, gm settings, sku weights, etc.)
    across all orders in the request.
    """
    from routers.fulfillment import _apply_carrier_service_rules, _zone_for_zip

    order_ids = [i.strip() for i in ids.split(",") if i.strip()]
    if not order_ids:
        return {}

    # ── Shared data (loaded once) ─────────────────────────────────────────────
    gm_settings = db.query(models.GmSettings).filter(models.GmSettings.id == 1).first()
    replacement_pct       = gm_settings.replacement_pct       if gm_settings else 1.0
    refund_pct            = gm_settings.refund_pct            if gm_settings else 1.0
    transaction_fee_pct   = gm_settings.transaction_fee_pct   if gm_settings else 2.9

    picklist_map = {r.pick_sku: r for r in db.query(models.PicklistSku).all()}
    sku_weight_map = {r.pick_sku: r.pick_weight_lb for r in db.query(models.SkuMapping).filter(models.SkuMapping.pick_weight_lb.isnot(None)).all()}

    # ── Batch load per-order data ─────────────────────────────────────────────
    orders = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id.in_(order_ids)
    ).all()
    orders_by_id = {o.shopify_order_id: o for o in orders}

    all_line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id.in_(order_ids)
    ).all()
    # Period override mutates app_line_status in-memory only — see
    # mapping_override.apply_period_status_overrides for safety notes.
    mapping_override.apply_period_status_overrides(all_line_items, period_id, db)
    li_by_order: dict = {}
    for li in all_line_items:
        li_by_order.setdefault(li.shopify_order_id, []).append(li)

    # Mapping-tab override: re-resolve pick_sku/mix_quantity for COGS only.
    # Returns None when the tab fails to load → fall back to stored values.
    cogs_by_order: Optional[dict] = None
    if mapping_tab:
        cogs_by_order = mapping_override.build_override_cogs_rows_for_orders(
            li_by_order, mapping_tab
        )

    all_plans = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id.in_(order_ids),
        models.FulfillmentPlan.status != "cancelled",
    ).order_by(models.FulfillmentPlan.created_at.desc()).all()
    plan_by_order: dict = {}
    for plan in all_plans:
        if plan.shopify_order_id not in plan_by_order:
            plan_by_order[plan.shopify_order_id] = plan

    plan_ids = [p.id for p in plan_by_order.values()]
    boxes_by_plan: dict = {}
    box_ids = []
    box_type_ids = set()
    if plan_ids:
        all_boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id.in_(plan_ids),
            models.FulfillmentBox.status != "cancelled",
        ).order_by(models.FulfillmentBox.box_number).all()
        for box in all_boxes:
            boxes_by_plan.setdefault(box.plan_id, []).append(box)
            box_ids.append(box.id)
            if box.box_type_id:
                box_type_ids.add(box.box_type_id)

    box_type_map: dict = {}
    if box_type_ids:
        for bt in db.query(models.BoxType).filter(models.BoxType.id.in_(box_type_ids)).all():
            box_type_map[bt.id] = bt

    box_items_by_box: dict = {}
    if box_ids:
        for bi in db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id.in_(box_ids)).all():
            box_items_by_box.setdefault(bi.box_id, []).append(bi)

    # Packaging
    btp_by_box_type: dict = {}
    pkg_material_map: dict = {}
    if box_type_ids:
        all_btps = db.query(models.BoxTypePackaging).filter(
            models.BoxTypePackaging.box_type_id.in_(box_type_ids)
        ).all()
        for btp in all_btps:
            btp_by_box_type.setdefault(btp.box_type_id, []).append(btp)
        mat_ids = {btp.packaging_material_id for btp in all_btps}
        if mat_ids:
            for mat in db.query(models.PackagingMaterial).filter(models.PackagingMaterial.id.in_(mat_ids)).all():
                pkg_material_map[mat.id] = mat

    # ── Per-order computation ─────────────────────────────────────────────────
    result = {}
    for order_id in order_ids:
        order = orders_by_id.get(order_id)
        if not order:
            result[order_id] = None
            continue

        line_items = li_by_order.get(order_id, [])

        # Revenue
        gross_all_items = 0.0
        seen_all: set = set()
        for li in line_items:
            if li.line_item_id in seen_all or li.app_line_status == "removed":
                continue
            seen_all.add(li.line_item_id)
            gross_all_items += (li.price or 0.0) * (li.quantity or 0)

        subtotal = order.subtotal_price or 0.0
        eff_ratio = max(0.0, min(1.0, subtotal / gross_all_items)) if gross_all_items > 0 else 1.0  # noqa: F841

        revenue_gross = 0.0
        revenue_gross_fulfilled = 0.0
        revenue_discounts = 0.0
        revenue_discounts_fulfilled = 0.0
        rev_disc_short = 0.0
        seen_li: set = set()
        for li in line_items:
            if li.line_item_id in seen_li:
                continue
            seen_li.add(li.line_item_id)
            orig_qty = li.quantity or 1
            fq = li.fulfillable_quantity if li.fulfillable_quantity is not None else orig_qty
            fq_done = max(0, orig_qty - fq)
            if li.app_line_status == "removed":
                continue
            if li.app_line_status == "short_ship":
                rev_disc_short += li.total_discount or 0.0
                continue
            if fq > 0:
                gross = (li.price or 0.0) * fq
                discount = (li.total_discount or 0.0) * (fq / orig_qty)
                revenue_gross += gross
                revenue_discounts += discount
            if fq_done > 0:
                gross_f = (li.price or 0.0) * fq_done
                discount_f = (li.total_discount or 0.0) * (fq_done / orig_qty)
                revenue_gross_fulfilled += gross_f
                revenue_discounts_fulfilled += discount_f

        # Reconcile order-level discount with line-item discounts
        order_total_disc = order.total_discounts or 0.0
        li_disc_sum = revenue_discounts + revenue_discounts_fulfilled
        # Exclude short-shipped items' discounts — they're already handled via effective_ratio
        disc_gap = order_total_disc - li_disc_sum - rev_disc_short
        if disc_gap > 0.01:
            gross_excl_short = revenue_gross + revenue_gross_fulfilled
            if gross_excl_short > 0:
                revenue_discounts += disc_gap * (revenue_gross / gross_excl_short)
                revenue_discounts_fulfilled += disc_gap * (revenue_gross_fulfilled / gross_excl_short)

        # Split paid shipping proportionally to unfulfilled revenue
        paid_shipping = order.total_shipping_price or 0.0
        rev_net_unfulfilled = revenue_gross - revenue_discounts
        rev_net_fulfilled = revenue_gross_fulfilled - revenue_discounts_fulfilled
        net_total_for_split = rev_net_unfulfilled + rev_net_fulfilled
        if net_total_for_split > 0:
            ship_unfulfilled = paid_shipping * (rev_net_unfulfilled / net_total_for_split)
        elif rev_net_unfulfilled > 0:
            ship_unfulfilled = paid_shipping
        else:
            ship_unfulfilled = paid_shipping if revenue_gross > 0 else 0.0
        rev_total_unfulfilled = rev_net_unfulfilled + ship_unfulfilled

        # Fruit / SKU cost (unfulfilled items only) — uses override rows when
        # mapping_tab is set so the COGS reflects the override pick_sku/mix.
        if cogs_by_order is not None:
            cogs_items = cogs_by_order.get(order_id, [])
            def _cg(li, k): return li.get(k)
        else:
            cogs_items = line_items
            def _cg(li, k): return getattr(li, k)

        fruit_cost = 0.0
        missing_cost_skus: set = set()
        for li in cogs_items:
            pick_sku = _cg(li, "pick_sku")
            if _cg(li, "app_line_status") in ("short_ship", "removed") or not pick_sku:
                continue
            orig_qty_b = _cg(li, "quantity") or 1
            fq_attr = _cg(li, "fulfillable_quantity")
            fq_b = fq_attr if fq_attr is not None else orig_qty_b
            if fq_b <= 0:
                continue
            sku_rec = picklist_map.get(pick_sku)
            if not sku_rec or sku_rec.weight_lb is None:
                continue
            cost_per_lb = sku_rec.cost_per_lb
            if cost_per_lb is None and sku_rec.cost_per_case is not None and sku_rec.case_weight_lb:
                cost_per_lb = sku_rec.cost_per_case / sku_rec.case_weight_lb
            if cost_per_lb is None:
                missing_cost_skus.add(pick_sku)
                continue
            mix = _cg(li, "mix_quantity") or 1.0
            fruit_cost += sku_rec.weight_lb * mix * fq_b * cost_per_lb

        # Shipping estimate (unshipped boxes only)
        plan = plan_by_order.get(order_id)
        shipping_cost = None
        if plan:
            boxes = boxes_by_plan.get(plan.id, [])
            unshipped_boxes = [b for b in boxes if b.status not in ("shipped", "fulfilled")]
            if not unshipped_boxes:
                # All boxes shipped — no unfulfilled shipping cost
                shipping_cost = 0.0
            elif unshipped_boxes:
                carrier_match = _apply_carrier_service_rules(order, db)
                zone = _zone_for_zip(order.shipping_zip)
                shipping_cost = 0.0
                for box in unshipped_boxes:
                    box_type = box_type_map.get(box.box_type_id) if box.box_type_id else None
                    items = box_items_by_box.get(box.id, [])
                    flat_rate_service = None
                    if box_type and box_type.package_code:
                        flat_rate_service = _FLAT_RATE_PACKAGE_MAP.get(box_type.package_code)
                    if flat_rate_service:
                        rate = _lookup_shipping_rate("USPS", flat_rate_service, 0, None, db)
                    elif not items:
                        rate = None
                    else:
                        total_weight_oz = 0.0
                        for item in items:
                            wlb = sku_weight_map.get(item.pick_sku)
                            if wlb is None:
                                pl = picklist_map.get(item.pick_sku)
                                if pl:
                                    wlb = pl.weight_lb
                            if wlb:
                                total_weight_oz += wlb * item.quantity * 16.0
                        if box_type and box_type.weight_oz:
                            total_weight_oz += box_type.weight_oz
                        weight_lb = total_weight_oz / 16.0 if total_weight_oz > 0 else None
                        if weight_lb is None or zone is None:
                            rate = None
                        else:
                            cc = carrier_match.get("carrier_code") if carrier_match else None
                            sc = carrier_match.get("service_code") if carrier_match else None
                            carrier, svc_name = _CARRIER_SERVICE_RATE_MAP.get((cc, sc), (None, None)) if cc and sc else (None, None)
                            rate = _lookup_shipping_rate(carrier, svc_name, weight_lb, zone, db) if carrier and svc_name else None
                    if rate is not None:
                        shipping_cost += rate
                    else:
                        shipping_cost = None
                        break

        # Packaging cost (unshipped boxes only)
        packaging_cost = 0.0
        if plan:
            unshipped = [b for b in boxes_by_plan.get(plan.id, []) if b.status not in ("shipped", "fulfilled")]
            for box in unshipped:
                if not box.box_type_id:
                    continue
                for btp in btp_by_box_type.get(box.box_type_id, []):
                    mat = pkg_material_map.get(btp.packaging_material_id)
                    if mat:
                        packaging_cost += mat.unit_cost * btp.quantity

        # % COGS based on to-fulfill revenue only
        replacement_cost = rev_total_unfulfilled * replacement_pct / 100
        refund_cost      = rev_total_unfulfilled * refund_pct / 100
        txn_fee          = rev_total_unfulfilled * transaction_fee_pct / 100

        cogs_known = fruit_cost + packaging_cost + replacement_cost + refund_cost + txn_fee
        cogs_total = (cogs_known + shipping_cost) if shipping_cost is not None else None

        gm_pct = None
        if cogs_total is not None and rev_total_unfulfilled > 0:
            gm_pct = round((rev_total_unfulfilled - cogs_total) / rev_total_unfulfilled * 100, 1)

        result[order_id] = {"gm_pct": gm_pct, "missing_cost_skus": sorted(missing_cost_skus), "fulfillable_revenue": round(rev_total_unfulfilled, 2)}

    return result


# ── Get single order ──────────────────────────────────────────────────────────

@router.get("/{shopify_order_id}", response_model=schemas.ShopifyOrderOut)
def get_order(
    shopify_order_id: str,
    mapping_tab: Optional[str] = Query(None, description="Re-resolve line item pick SKUs against this sheet tab (preview, no DB writes)"),
    period_id: Optional[int] = Query(None, description="Apply this projection period's short-ship/inventory-hold configs as in-memory overrides on app_line_status (no DB writes)"),
    db: Session = Depends(get_db),
):
    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == shopify_order_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    plan = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id == shopify_order_id,
        models.FulfillmentPlan.status != "cancelled",
    ).first()
    has_plan = plan is not None
    plan_box_unmatched = False
    has_plan_mismatch = False
    if plan:
        plan_box_unmatched = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.box_type_id == None,
            models.FulfillmentBox.status == "pending",
        ).first() is not None
        has_plan_mismatch = _check_plan_mismatch(
            shopify_order_id, db,
            mapping_tab=mapping_tab,
            period_id=period_id,
        )
    return _build_order_response(
        order, db,
        has_plan=has_plan,
        plan_box_unmatched=plan_box_unmatched,
        has_plan_mismatch=has_plan_mismatch,
        mapping_tab_override=mapping_tab,
        period_id_override=period_id,
    )


# ── Pull orders from Shopify ──────────────────────────────────────────────────

@router.post("/pull")
def pull_orders(body: schemas.PullOrdersRequest, db: Session = Depends(get_db)):
    """
    Fetch all unfulfilled orders from Shopify and upsert into the DB.
    warehouse: used for SKU resolution. Saved as assigned_warehouse on each order.
    """
    if not shopify_service.is_configured():
        raise HTTPException(
            status_code=503,
            detail="Shopify not connected. Visit /api/shopify/connect to authenticate."
        )

    # Build SKU lookup from Google Sheets
    try:
        sku_lookup = sheets_service.get_sku_mapping_lookup(body.warehouse)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="Google Sheets credentials not configured")
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=502, detail=f"Google Sheets error: {type(e).__name__}: {e}")

    try:
        raw_orders = shopify_service.get_unfulfilled_orders()
        on_hold_ids = shopify_service.get_on_hold_order_ids()
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=502, detail=f"Shopify error: {type(e).__name__}: {e}")
    now = datetime.now(timezone.utc)

    created = 0
    updated = 0
    deleted = 0
    auto_archived = 0

    # Auto-archive pass: detect orders matching criteria and close them in Shopify
    orders_to_skip: set[str] = set()
    for raw in raw_orders:
        if shopify_service.should_auto_archive(raw):
            shopify_order_id = str(raw["id"])

            # Skip if already successfully archived; retry if previous attempt failed
            already = db.query(models.ArchivedOrder).filter(
                models.ArchivedOrder.shopify_order_id == shopify_order_id
            ).first()
            if already:
                if already.shopify_archived:
                    orders_to_skip.add(shopify_order_id)
                    continue
                # Previous attempt failed — retry the Shopify close call
                success = shopify_service.archive_order(shopify_order_id)
                if success:
                    already.shopify_archived = True
                orders_to_skip.add(shopify_order_id)
                continue

            # Call Shopify to close the order
            success = shopify_service.archive_order(shopify_order_id)

            # Build a summary of line items for display
            li_parts = []
            for li in raw.get("line_items", []):
                sku = str(li.get("sku") or "").strip()
                qty = li.get("quantity", 1)
                title = li.get("title") or sku
                li_parts.append(f"{title} x{qty}")
            line_items_summary = "; ".join(li_parts) or None

            customer = raw.get("customer") or {}
            first = customer.get("first_name") or ""
            last = customer.get("last_name") or ""
            customer_name = f"{first} {last}".strip() or None

            archived_rec = models.ArchivedOrder(
                shopify_order_id=shopify_order_id,
                shopify_order_number=raw.get("name"),
                customer_name=customer_name,
                customer_email=customer.get("email"),
                tags=raw.get("tags", ""),
                total_price=float(raw.get("total_price") or 0),
                line_items_summary=line_items_summary,
                shopify_archived=success,
            )
            db.add(archived_rec)
            orders_to_skip.add(shopify_order_id)
            auto_archived += 1

    if auto_archived:
        db.flush()

    # Track which Shopify order IDs are still open (excluding auto-archived)
    shopify_ids_in_pull: set[str] = {
        str(raw["id"]) for raw in raw_orders
        if str(raw["id"]) not in orders_to_skip
    }

    for raw in raw_orders:
        if str(raw["id"]) in orders_to_skip:
            continue
        transformed = shopify_service.transform_order(raw, sku_lookup)
        order_data = transformed["order"]
        line_items_data = transformed["line_items"]

        shopify_order_id = order_data["shopify_order_id"]

        existing = db.query(models.ShopifyOrder).filter(
            models.ShopifyOrder.shopify_order_id == shopify_order_id
        ).first()

        # Derive app_status from Shopify fulfillment_status
        shopify_fulfillment = order_data.get("fulfillment_status")
        if shopify_fulfillment == "fulfilled":
            shopify_derived_status = "fulfilled"
        elif shopify_fulfillment == "partial":
            # If the only fulfilled items are monthly-priority-pass, don't treat as partial
            fulfilled_skus = {
                str(li.get("sku") or "").strip()
                for li in raw.get("line_items", [])
                if int(li.get("quantity") or 0) > 0
                and int(li.get("fulfillable_quantity") or 0) == 0
            }
            if fulfilled_skus and fulfilled_skus <= {"monthly-priority-pass"}:
                shopify_derived_status = "not_processed"
            else:
                shopify_derived_status = "partially_fulfilled"
        else:
            shopify_derived_status = "not_processed"

        is_shopify_hold = shopify_order_id in on_hold_ids

        if existing:
            # Update order fields
            for k, v in order_data.items():
                if hasattr(existing, k):
                    setattr(existing, k, v)
            existing.pulled_at = now
            existing.last_synced_at = now
            existing.assigned_warehouse = body.warehouse
            existing.shopify_hold = is_shopify_hold

            # Detect Shopify fulfillment reversal (e.g. user cancelled Shopify fulfillment
            # while testing). If we marked the order as shipped but Shopify now shows it as
            # unfulfilled, reset everything so the order can be re-processed from scratch.
            if (
                existing.app_status == "in_shipstation_shipped"
                and shopify_derived_status == "not_processed"
            ):
                from routers.inventory import _restore_inventory_on_cancel
                _restore_inventory_on_cancel(existing, db)
                existing.app_status = "not_processed"
                existing.shipstation_order_id = None
                existing.shipstation_order_key = None
                plan = db.query(models.FulfillmentPlan).filter(
                    models.FulfillmentPlan.shopify_order_id == shopify_order_id
                ).first()
                if plan:
                    for box in db.query(models.FulfillmentBox).filter(
                        models.FulfillmentBox.plan_id == plan.id
                    ).all():
                        box.status = "pending"
                        box.tracking_number = None
                        box.carrier = None
                        box.shipped_at = None
                        box.estimated_delivery_date = None
                        box.shipstation_order_id = None
                        box.shipstation_order_key = None
                    plan.status = "draft"

            # Update app_status rules:
            # - Shopify confirms fully fulfilled → always override (order is done)
            # - Shopify confirms partial → override UNLESS order is already in ShipStation
            #   (partial fulfillment from a prior shipment doesn't mean the current
            #    ShipStation shipment should be reset)
            # - ShipStation orders + not-yet-fulfilled → keep (don't reset to not_processed)
            # - Staged orders + not-yet-fulfilled → keep staged
            elif shopify_derived_status == "fulfilled":
                existing.app_status = shopify_derived_status
            elif shopify_derived_status == "partially_fulfilled" and existing.app_status not in SHIPSTATION_STATUSES:
                existing.app_status = shopify_derived_status
            elif existing.app_status not in SHIPSTATION_STATUSES and existing.app_status != "staged":
                existing.app_status = shopify_derived_status

            updated += 1
        else:
            order_obj = models.ShopifyOrder(
                **{k: v for k, v in order_data.items() if hasattr(models.ShopifyOrder, k)},
                assigned_warehouse=body.warehouse,
                app_status=shopify_derived_status,
                shopify_hold=is_shopify_hold,
                pulled_at=now,
                last_synced_at=now,
            )
            db.add(order_obj)
            created += 1

        db.flush()

        # Replace line items for this order, preserving app-side statuses
        old_line_items = db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == shopify_order_id
        ).all()
        old_status_map = {
            li.line_item_id: {
                "app_line_status": li.app_line_status,
                "shipstation_line_item_id": li.shipstation_line_item_id,
            }
            for li in old_line_items
        }
        db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == shopify_order_id
        ).delete()

        new_line_item_ids = {d["line_item_id"] for d in line_items_data}
        for li_data in line_items_data:
            li = models.ShopifyLineItem(
                **{k: v for k, v in li_data.items() if hasattr(models.ShopifyLineItem, k)}
            )
            old = old_status_map.get(li_data["line_item_id"])
            if old:
                old_status = old["app_line_status"]
                # Don't restore "short_ship" for items with nothing left to fulfill.
                # Don't restore "removed" — the item is back in Shopify's response.
                if old_status and old_status != "removed" and not (old_status == "short_ship" and (li.fulfillable_quantity or 0) <= 0):
                    li.app_line_status = old_status
                if old["shipstation_line_item_id"]:
                    li.shipstation_line_item_id = old["shipstation_line_item_id"]
            db.add(li)

        # Detect removed items: existed before but no longer in Shopify response.
        # Mark them as 'removed' so revenue calculation ignores them entirely.
        for old_li_id, old_data in old_status_map.items():
            if old_li_id not in new_line_item_ids:
                removed_li = models.ShopifyLineItem(
                    shopify_order_id=shopify_order_id,
                    line_item_id=old_li_id,
                    quantity=0,
                    fulfillable_quantity=0,
                    price=0.0,
                    total_discount=0.0,
                    app_line_status="removed",
                )
                db.add(removed_li)

    # Remove orders that are no longer open in Shopify (e.g. archived/cancelled),
    # unless they are committed to ShipStation (staged orders ARE deleted — they've
    # disappeared from Shopify so there's nothing left to fulfill).
    stale_orders = (
        db.query(models.ShopifyOrder)
        .filter(
            models.ShopifyOrder.shopify_order_id.notin_(shopify_ids_in_pull),
            models.ShopifyOrder.app_status.notin_(SHIPSTATION_STATUSES),
        )
        .all()
    )
    for stale in stale_orders:
        # Clean up fulfillment-plan graph before deleting the order — Postgres
        # enforces the FKs, so deleting the order directly would fail.
        plan_ids = [
            pid for (pid,) in db.query(models.FulfillmentPlan.id).filter(
                models.FulfillmentPlan.shopify_order_id == stale.shopify_order_id
            ).all()
        ]
        if plan_ids:
            box_ids = [
                bid for (bid,) in db.query(models.FulfillmentBox.id).filter(
                    models.FulfillmentBox.plan_id.in_(plan_ids)
                ).all()
            ]
            if box_ids:
                db.query(models.BoxLineItem).filter(
                    models.BoxLineItem.box_id.in_(box_ids)
                ).delete(synchronize_session=False)
                db.query(models.FulfillmentBox).filter(
                    models.FulfillmentBox.id.in_(box_ids)
                ).delete(synchronize_session=False)
            db.query(models.LineItemChangeEvent).filter(
                models.LineItemChangeEvent.plan_id.in_(plan_ids)
            ).delete(synchronize_session=False)
            db.query(models.FulfillmentPlan).filter(
                models.FulfillmentPlan.id.in_(plan_ids)
            ).delete(synchronize_session=False)

        db.query(models.ProjectionPeriodConfirmedOrder).filter(
            models.ProjectionPeriodConfirmedOrder.shopify_order_id == stale.shopify_order_id
        ).delete(synchronize_session=False)

        db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == stale.shopify_order_id
        ).delete(synchronize_session=False)
        db.delete(stale)
        deleted += 1

    db.commit()

    # Sync product catalog from Shopify (upserts only; preserves allow_short_ship)
    try:
        _sync_products(db)
        db.commit()
    except Exception as e:
        # Product sync failure should not block order pull
        import traceback
        print(f"[WARN] Product sync failed during order pull: {e}")
        traceback.print_exc()

    # Upsert placeholder records for any line item SKUs not in the product catalog.
    # Covers custom/subscription-app line items that have no Shopify product page.
    try:
        from routers.products import _upsert_products_from_line_items
        _upsert_products_from_line_items(db)
        db.commit()
    except Exception as e:
        import traceback
        print(f"[WARN] Line-item product upsert failed: {e}")
        traceback.print_exc()

    # Apply short-ship rules to newly pulled line items
    apply_short_ship_to_orders(db)
    db.commit()

    # Recompute committed inventory after pull
    _recompute_committed(body.warehouse, db)
    db.commit()

    # Unstage any staged orders with plan issues (no plan, no box rule, mismatch)
    _unstage_orders_with_plan_issues(db)
    db.commit()

    # Unstage orders that violate order rules (hold, DNSS+short_ship) — no margin check on pull
    _unstage_by_order_rules(db, check_margin=False)
    db.commit()

    return {
        "orders_pulled": len(raw_orders),
        "created": created,
        "updated": updated,
        "deleted": deleted,
        "auto_archived": auto_archived,
        "warehouse": body.warehouse,
    }


# ── Cancel order ─────────────────────────────────────────────────────────────

@router.post("/{shopify_order_id}/cancel")
def cancel_order(shopify_order_id: str, db: Session = Depends(get_db)):
    """
    Cancel or reset an order that is staged or in ShipStation.

    Steps:
      1. Validate: order must be staged, in_shipstation_not_shipped, or in_shipstation_shipped.
      2. Cancel order-level ShipStation push (if push_order was used).
      3. Cancel each pushed box (if push_box was used).
      4. Restore any inventory that was deducted at push time.
      5. Reset plan status → draft, order status → not_processed.
      6. Recompute committed inventory.

    Returns the updated order.
    """
    from services import shipstation_service
    from routers.inventory import _restore_inventory_on_cancel, _recompute_committed

    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == shopify_order_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    CANCELLABLE = {"in_shipstation_not_shipped", "staged", "in_shipstation_shipped"}
    if order.app_status not in CANCELLABLE:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot cancel: order status is '{order.app_status}'. "
                   f"Only {sorted(CANCELLABLE)} orders can be cancelled here."
        )

    ss_errors: list[str] = []

    # ── Cancel order-level ShipStation push (legacy push_order flow) ──────────
    if order.shipstation_order_id:
        try:
            shipstation_service.cancel_order(order.shipstation_order_id)
        except Exception as e:
            ss_errors.append(f"Order-level SS cancel failed: {e}")

    # ── Cancel any packed boxes (multi-box push_box flow) ─────────────────────
    plan = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id == shopify_order_id
    ).first()

    if plan:
        pushed_boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.shipstation_order_id.isnot(None),
            models.FulfillmentBox.status.in_(["packed", "pending"]),
        ).all()

        for box in pushed_boxes:
            try:
                shipstation_service.cancel_order(box.shipstation_order_id)
                box.status = "cancelled"
            except Exception as e:
                ss_errors.append(f"Box {box.box_number} SS cancel failed: {e}")

        # If any boxes failed, still continue — we at least reset the local state
        db.flush()

        # Revert plan to draft
        plan.status = "draft"

    # ── Restore inventory deducted at push time ───────────────────────────────
    _restore_inventory_on_cancel(order, db)

    # ── Reset order status ────────────────────────────────────────────────────
    order.app_status = "not_processed"
    order.shipstation_order_id = None
    order.shipstation_order_key = None
    order.last_synced_at = datetime.now(timezone.utc)

    db.flush()
    _recompute_committed(order.assigned_warehouse, db)
    db.commit()

    if ss_errors:
        # Return a 207 Multi-Status: local state was reset but some SS calls failed
        return {
            "cancelled": True,
            "shopify_order_id": shopify_order_id,
            "warnings": ss_errors,
            "message": "Order reset to not_processed. Some ShipStation cancels failed — check ShipStation manually.",
        }

    return {
        "cancelled": True,
        "shopify_order_id": shopify_order_id,
        "warnings": [],
        "message": "Order cancelled and reset to not_processed. Inventory restored.",
    }


# ── Bulk cancel ShipStation boxes ─────────────────────────────────────────────

@router.post("/bulk-cancel-shipstation-boxes/preview")
def preview_bulk_cancel_ss_boxes(
    body: schemas.BulkCancelSSBoxesRequest,
    db: Session = Depends(get_db),
):
    """
    Preview how many boxes would be cancelled for the given orders.
    Returns per-order box counts without making any changes.
    """
    results = []
    total_boxes = 0

    for order_id in body.order_ids:
        order = db.query(models.ShopifyOrder).filter(
            models.ShopifyOrder.shopify_order_id == order_id
        ).first()
        if not order:
            continue

        plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.shopify_order_id == order_id
        ).first()
        if not plan:
            continue

        # Count boxes that are pushed to SS but not yet shipped/fulfilled/cancelled
        cancellable_boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.shipstation_order_id.isnot(None),
            models.FulfillmentBox.status.notin_(["shipped", "fulfilled", "cancelled"]),
        ).count()

        if cancellable_boxes > 0:
            results.append({
                "shopify_order_id": order_id,
                "order_number": order.shopify_order_number,
                "cancellable_boxes": cancellable_boxes,
            })
            total_boxes += cancellable_boxes

    return {
        "total_orders": len(results),
        "total_boxes": total_boxes,
        "orders": results,
    }


@router.post("/bulk-cancel-shipstation-boxes")
def bulk_cancel_ss_boxes(
    body: schemas.BulkCancelSSBoxesRequest,
    db: Session = Depends(get_db),
):
    """
    Cancel only the 'in ShipStation' (pushed, not shipped) boxes for the given orders.

    For each order:
      1. Find boxes with shipstation_order_id that are not shipped/fulfilled/cancelled.
      2. Void each in ShipStation via DELETE.
      3. Mark box status = 'cancelled'.
      4. Restore inventory (ship_deduct reversals).
      5. Recalculate order app_status based on remaining boxes.
    """
    from services import shipstation_service
    from routers.inventory import _restore_inventory_on_cancel, _recompute_committed

    per_order = []
    affected_warehouses = set()

    for order_id in body.order_ids:
        order = db.query(models.ShopifyOrder).filter(
            models.ShopifyOrder.shopify_order_id == order_id
        ).first()
        if not order:
            per_order.append({"shopify_order_id": order_id, "boxes_cancelled": 0, "warnings": ["Order not found"]})
            continue

        plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.shopify_order_id == order_id
        ).first()
        if not plan:
            per_order.append({"shopify_order_id": order_id, "boxes_cancelled": 0, "warnings": ["No plan found"]})
            continue

        # Find boxes pushed to SS but not yet shipped/fulfilled/cancelled
        cancellable = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.shipstation_order_id.isnot(None),
            models.FulfillmentBox.status.notin_(["shipped", "fulfilled", "cancelled"]),
        ).all()

        if not cancellable:
            per_order.append({"shopify_order_id": order_id, "boxes_cancelled": 0, "warnings": ["No cancellable boxes"]})
            continue

        ss_errors = []
        cancelled_count = 0

        for box in cancellable:
            try:
                shipstation_service.cancel_order(box.shipstation_order_id)
            except Exception as e:
                ss_errors.append(f"Box {box.box_number} SS cancel failed: {e}")
            # Mark cancelled locally even if SS call failed (same pattern as single cancel)
            box.status = "cancelled"
            cancelled_count += 1

        db.flush()

        # Also cancel order-level SS push if present
        if order.shipstation_order_id:
            try:
                shipstation_service.cancel_order(order.shipstation_order_id)
            except Exception:
                pass  # best-effort; box-level is the important one
            order.shipstation_order_id = None
            order.shipstation_order_key = None

        # Restore inventory
        _restore_inventory_on_cancel(order, db)

        # Recalculate order status based on remaining active boxes
        remaining_active = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.status.notin_(["cancelled"]),
        ).all()

        shipped_count = sum(1 for b in remaining_active if b.status == "shipped")
        fulfilled_count = sum(1 for b in remaining_active if b.status == "fulfilled")
        pending_count = sum(1 for b in remaining_active if b.status in ("pending", "packed"))

        if len(remaining_active) == 0:
            # No boxes left — full reset
            order.app_status = "not_processed"
            plan.status = "draft"
        elif fulfilled_count > 0 and pending_count == 0 and shipped_count == 0:
            # Only mark fully fulfilled if no Shopify items still need packing.
            # If boxes were cancelled to re-plan, unfulfilled items remain and the
            # order should stay partially_fulfilled so auto-plan can pick it up.
            still_needed = db.query(models.ShopifyLineItem).filter(
                models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
                models.ShopifyLineItem.sku_mapped == True,
                models.ShopifyLineItem.pick_sku.isnot(None),
                models.ShopifyLineItem.fulfillable_quantity > 0,
                or_(
                    models.ShopifyLineItem.app_line_status != "short_ship",
                    models.ShopifyLineItem.app_line_status.is_(None),
                ),
            ).count()
            order.app_status = "fulfilled" if still_needed == 0 else "partially_fulfilled"
        elif fulfilled_count > 0 or shipped_count > 0:
            order.app_status = "partially_fulfilled"
        elif pending_count > 0:
            # Unpushed boxes remain — go back to staged
            order.app_status = "staged"
        else:
            order.app_status = "not_processed"
            plan.status = "draft"

        order.last_synced_at = datetime.now(timezone.utc)
        if order.assigned_warehouse:
            affected_warehouses.add(order.assigned_warehouse)

        per_order.append({
            "shopify_order_id": order_id,
            "order_number": order.shopify_order_number,
            "boxes_cancelled": cancelled_count,
            "new_status": order.app_status,
            "warnings": ss_errors,
        })

    # Recompute committed inventory for all affected warehouses
    for wh in affected_warehouses:
        _recompute_committed(wh, db)

    db.commit()

    total_cancelled = sum(r["boxes_cancelled"] for r in per_order)
    total_warnings = sum(len(r["warnings"]) for r in per_order)

    return {
        "total_orders": len([r for r in per_order if r["boxes_cancelled"] > 0]),
        "total_boxes_cancelled": total_cancelled,
        "total_warnings": total_warnings,
        "orders": per_order,
    }


# ── Update order status ───────────────────────────────────────────────────────

@router.put("/{shopify_order_id}/status", response_model=schemas.ShopifyOrderOut)
def update_order_status(
    shopify_order_id: str,
    body: schemas.OrderStatusUpdate,
    db: Session = Depends(get_db),
):
    if body.app_status not in VALID_APP_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid app_status '{body.app_status}'. Valid values: {sorted(VALID_APP_STATUSES)}"
        )

    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == shopify_order_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    old_status = order.app_status
    order.app_status = body.app_status
    order.updated_at = datetime.now(timezone.utc)

    db.flush()

    # Recompute committed quantities if status changed
    if old_status != body.app_status:
        _recompute_committed(order.assigned_warehouse, db)

    db.commit()
    db.refresh(order)
    return _build_order_response(order, db)


# ── Stage order ───────────────────────────────────────────────────────────────

@router.post("/{shopify_order_id}/stage", response_model=schemas.ShopifyOrderOut)
def stage_order(shopify_order_id: str, db: Session = Depends(get_db)):
    """
    Move an order from not_processed → staged.
    Staging commits inventory to this order. Only staged orders can be pushed to ShipStation.
    """
    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == shopify_order_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.app_status not in ("not_processed", "partially_fulfilled"):
        raise HTTPException(
            status_code=409,
            detail=f"Order is '{order.app_status}' — can only stage 'not_processed' or 'partially_fulfilled' orders"
        )
    if order.financial_status in PENDING_PAYMENT_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"Order has unpaid/pending payment ('{order.financial_status}') — cannot stage until payment is complete"
        )

    # Plan & box issue check: block staging for orders with plan issues
    plan_issue = _check_plan_issues(order, db)
    if plan_issue:
        raise HTTPException(status_code=409, detail=plan_issue)

    ss_block = _check_already_in_shipstation(order, db)
    if ss_block:
        raise HTTPException(status_code=409, detail=ss_block)

    rule_tags = _get_active_rule_tags(db)
    eligibility_error = _check_staging_eligibility(order, db, rule_tags)
    if eligibility_error:
        raise HTTPException(status_code=409, detail=eligibility_error)

    order.app_status = "staged"
    order.updated_at = datetime.now(timezone.utc)
    db.flush()

    _recompute_committed(order.assigned_warehouse, db)
    db.commit()
    db.refresh(order)
    return _build_order_response(order, db)


@router.post("/stage-batch")
def stage_batch(body: schemas.StageBatchRequest, db: Session = Depends(get_db)):
    """
    Move multiple not_processed orders to staged in one call.
    Returns per-order results.
    """
    results = []
    affected_warehouses: set[str] = set()
    rule_tags = _get_active_rule_tags(db)

    for order_id in body.order_ids:
        order = db.query(models.ShopifyOrder).filter(
            models.ShopifyOrder.shopify_order_id == order_id
        ).first()
        if not order:
            results.append({"order_id": order_id, "success": False, "error": "Order not found"})
            continue
        if order.app_status not in ("not_processed", "partially_fulfilled"):
            results.append({
                "order_id": order_id,
                "success": False,
                "error": f"Order is '{order.app_status}' — can only stage 'not_processed' or 'partially_fulfilled' orders",
            })
            continue
        if order.financial_status in PENDING_PAYMENT_STATUSES:
            results.append({
                "order_id": order_id,
                "success": False,
                "error": f"Order has unpaid/pending payment ('{order.financial_status}') — cannot stage until payment is complete",
            })
            continue

        plan_issue = _check_plan_issues(order, db)
        if plan_issue:
            results.append({"order_id": order_id, "success": False, "error": plan_issue})
            continue

        ss_block = _check_already_in_shipstation(order, db)
        if ss_block:
            results.append({"order_id": order_id, "success": False, "error": ss_block})
            continue

        eligibility_error = _check_staging_eligibility(order, db, rule_tags)
        if eligibility_error:
            results.append({"order_id": order_id, "success": False, "error": eligibility_error})
            continue

        order.app_status = "staged"
        order.updated_at = datetime.now(timezone.utc)
        affected_warehouses.add(order.assigned_warehouse)
        results.append({"order_id": order_id, "success": True})

    db.flush()
    for wh in affected_warehouses:
        _recompute_committed(wh, db)
    db.commit()

    staged = sum(1 for r in results if r["success"])
    return {"staged": staged, "failed": len(results) - staged, "results": results}


@router.post("/repair-staged-shipstation")
def repair_staged_shipstation(db: Session = Depends(get_db)):
    """
    One-time repair: find orders that have boxes pushed to ShipStation
    (shipstation_order_id is set, box not cancelled) but whose app_status
    is NOT in_shipstation_not_shipped or in_shipstation_shipped.

    Restores them to in_shipstation_not_shipped so they aren't
    accidentally re-staged or re-pushed.
    """
    # Find all orders whose status doesn't reflect that they're in ShipStation
    mismatched_orders = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.app_status.notin_(list(SHIPSTATION_STATUSES)),
    ).all()

    repaired = []
    for order in mismatched_orders:
        plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.shopify_order_id == order.shopify_order_id,
            models.FulfillmentPlan.status.notin_(["cancelled"]),
        ).first()
        if not plan:
            continue
        pushed_box = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.shipstation_order_id.isnot(None),
            models.FulfillmentBox.status.notin_(["cancelled"]),
        ).first()
        if pushed_box:
            old_status = order.app_status
            order.app_status = "in_shipstation_not_shipped"
            repaired.append({
                "order_id": order.shopify_order_id,
                "order_number": order.shopify_order_number,
                "old_status": old_status,
            })

    if repaired:
        db.commit()

    return {"repaired": len(repaired), "orders": repaired}


@router.post("/unstage-plan-issues")
def unstage_plan_issues(db: Session = Depends(get_db)):
    """
    Find all staged orders with plan issues (no plan, no box rule, plan mismatch)
    and move them back to not_processed so they can be fixed and re-staged.
    """
    orders_unstaged = _unstage_orders_with_plan_issues(db)
    db.commit()
    return {"orders_unstaged": orders_unstaged}


@router.post("/recompute")
def recompute_orders(
    body: schemas.RecomputeOrdersRequest = schemas.RecomputeOrdersRequest(),
    db: Session = Depends(get_db),
):
    """
    Refresh open orders against the current SKU mapping and short-ship/inventory-hold
    config — without pulling from Shopify.

    Re-resolves pick_skus on every line item, re-applies short-ship/hold, replans
    orders whose pick_skus changed, and unstages anything with new plan issues or
    rule violations. Orders already in ShipStation are never touched.
    """
    # Invalidate sheet caches so the recompute reads the latest mappings/helpers
    sheets_service.invalidate("sku_walnut")
    sheets_service.invalidate("sku_northlake")
    sheets_service.invalidate("sku_type_data")

    from services.order_recompute import recompute_open_orders
    return recompute_open_orders(
        db,
        order_ids=body.order_ids,
        auto_replan=body.auto_replan,
    )


@router.post("/unstage-batch")
def unstage_batch(body: schemas.StageBatchRequest, db: Session = Depends(get_db)):
    """
    Move multiple staged orders back to not_processed in one call.
    """
    results = []
    affected_warehouses: set[str] = set()

    for order_id in body.order_ids:
        order = db.query(models.ShopifyOrder).filter(
            models.ShopifyOrder.shopify_order_id == order_id
        ).first()
        if not order:
            results.append({"order_id": order_id, "success": False, "error": "Order not found"})
            continue
        if order.app_status != "staged":
            results.append({
                "order_id": order_id,
                "success": False,
                "error": f"Order is '{order.app_status}' — can only unstage 'staged' orders",
            })
            continue

        order.app_status = "not_processed"
        order.updated_at = datetime.now(timezone.utc)
        if order.assigned_warehouse:
            affected_warehouses.add(order.assigned_warehouse)
        results.append({"order_id": order_id, "success": True})

    db.flush()
    for wh in affected_warehouses:
        _recompute_committed(wh, db)
    db.commit()

    unstaged = sum(1 for r in results if r["success"])
    return {"unstaged": unstaged, "failed": len(results) - unstaged, "results": results}


def _check_plan_issues(order, db: Session) -> Optional[str]:
    """
    Check if an order has plan/box issues that should block staging.
    Returns None if no issues, or an error message string if blocked.
    """
    # Check has_plan: order must have at least one non-cancelled fulfillment plan
    has_plan = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id == order.shopify_order_id,
        models.FulfillmentPlan.status != "cancelled",
    ).first() is not None

    if not has_plan:
        return "Order has no fulfillment plan — cannot stage until a plan is created"

    # Check plan_box_unmatched: plan must have at least one non-cancelled box with a box_type
    box_count = (
        db.query(models.FulfillmentBox)
        .join(models.FulfillmentPlan, models.FulfillmentPlan.id == models.FulfillmentBox.plan_id)
        .filter(
            models.FulfillmentPlan.shopify_order_id == order.shopify_order_id,
            models.FulfillmentPlan.status != "cancelled",
            models.FulfillmentBox.status != "cancelled",
        )
        .count()
    )
    if box_count == 0:
        return "Order plan has no box rule match — cannot stage until box rules are configured"

    # Check plan mismatch
    if _check_plan_mismatch(order.shopify_order_id, db):
        return "Order plan quantities don't match the order — cannot stage until the plan is corrected"

    # Check ShipStation duplicate
    if order.ss_duplicate:
        return "Order already exists unshipped in ShipStation — cancel the ShipStation order first, then re-check duplicates"

    return None


def _check_already_in_shipstation(order, db: Session) -> Optional[str]:
    """
    Block staging for orders that already have one or more boxes pushed to
    ShipStation. Without this guard, an order whose app_status was knocked
    back to partially_fulfilled (e.g. by the Shopify fulfillable refresh
    after one box ships while others remain packed in SS) can be re-staged
    by a user click — leaving live SS boxes attached to a 'staged' order
    that subsequent pushes can't progress.
    """
    pushed = db.query(models.FulfillmentBox).join(
        models.FulfillmentPlan, models.FulfillmentPlan.id == models.FulfillmentBox.plan_id
    ).filter(
        models.FulfillmentPlan.shopify_order_id == order.shopify_order_id,
        models.FulfillmentPlan.status != "cancelled",
        models.FulfillmentBox.status != "cancelled",
        models.FulfillmentBox.shipstation_order_id.isnot(None),
    ).first()
    if pushed:
        return (
            f"Order already has box {pushed.box_number} in ShipStation "
            f"(orderId={pushed.shipstation_order_id}). Cancel the box or run "
            f"the repair endpoint before re-staging."
        )
    return None


def _check_staging_eligibility(order, db: Session, rule_tags: dict) -> Optional[str]:
    """
    Check if an order is eligible to be staged given active order rules.
    Returns None if eligible, or an error message string if blocked.
    """
    tags = {t.strip().lower() for t in (order.tags or '').split(',') if t.strip()}

    # Inventory hold check: block if any line item is on inventory hold
    has_inv_hold = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
        models.ShopifyLineItem.app_line_status == "inventory_hold",
    ).first() is not None
    if has_inv_hold:
        return "Order has line items on inventory hold — cannot stage until hold is released"

    # Hold check
    hold_tags = rule_tags.get('hold', set())
    if hold_tags and tags & hold_tags:
        matching = tags & hold_tags
        return f"Order has hold tag ({', '.join(matching)}) — remove hold before staging"

    # DNSS check: if DNSS tag + any short_ship lines → block
    dnss_tags = rule_tags.get('dnss', set())
    if dnss_tags and tags & dnss_tags:
        has_short_ship = db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
            models.ShopifyLineItem.app_line_status == "short_ship",
        ).first() is not None
        if has_short_ship:
            return "Order has DNSS tag with short-shipped items — cannot stage"

    # Margin check
    margin_override_tags = rule_tags.get('margin_override', set())
    ship_always_tags = rule_tags.get('ship_always', set())
    has_margin_override = bool(tags & margin_override_tags)
    if not has_margin_override:
        try:
            margin_data = get_order_margin(shopify_order_id=order.shopify_order_id, db=db)
            gm_pct = margin_data.get('gross_margin_pct')
            revenue_shippable = margin_data.get('revenue_shippable', 0) or 0

            # Block $0-revenue / N/A GM orders unless ship_always or margin_override tag
            if revenue_shippable <= 0 and not (tags & ship_always_tags):
                return "Order has $0 shippable revenue — cannot stage. Add a Margin Override or Ship Always tag to bypass."

            # Block below-30% margin
            if gm_pct is not None and gm_pct < 30.0:
                return f"Order margin is {gm_pct:.1f}% — below 30% minimum. Add a Margin Override tag to bypass."
        except Exception:
            pass  # If margin can't be computed, don't block staging

    return None


def _unstage_by_order_rules(db: Session, check_margin: bool = False) -> dict:
    """
    Scan all staged orders and unstage any that violate active order rules:
      - hold tags: always unstage
      - dnss tags + any short_ship lines: unstage
      - check_margin=True: margin < 30% and no margin_override tag → unstage
    Returns counts of orders unstaged by each reason.
    """
    rule_tags = _get_active_rule_tags(db)
    hold_tags = rule_tags.get('hold', set())
    dnss_tags = rule_tags.get('dnss', set())
    margin_override_tags = rule_tags.get('margin_override', set())

    staged_orders = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.app_status == "staged"
    ).all()

    if not staged_orders:
        return {'orders_unstaged_hold': 0, 'orders_unstaged_dnss': 0, 'orders_unstaged_margin': 0}

    order_ids = [o.shopify_order_id for o in staged_orders]

    # Batch load line items for DNSS check
    all_line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id.in_(order_ids)
    ).all()
    li_by_order: dict = {}
    for li in all_line_items:
        li_by_order.setdefault(li.shopify_order_id, []).append(li)

    # Batch compute margins if needed
    margins_by_order: dict = {}
    revenue_by_order: dict = {}
    if check_margin and (hold_tags or dnss_tags or margin_override_tags or True):
        try:
            batch = get_batch_margins(ids=",".join(order_ids), db=db)
            margins_by_order = {oid: data.get('gm_pct') for oid, data in batch.items()}
            revenue_by_order = {oid: data.get('fulfillable_revenue', 0) or 0 for oid, data in batch.items()}
        except Exception:
            pass

    orders_unstaged_hold = 0
    orders_unstaged_dnss = 0
    orders_unstaged_margin = 0
    affected_warehouses: set = set()

    for order in staged_orders:
        tags = {t.strip().lower() for t in (order.tags or '').split(',') if t.strip()}
        oid = order.shopify_order_id

        # Hold check
        if hold_tags and tags & hold_tags:
            order.app_status = "not_processed"
            order.updated_at = datetime.now(timezone.utc)
            orders_unstaged_hold += 1
            if order.assigned_warehouse:
                affected_warehouses.add(order.assigned_warehouse)
            continue

        # DNSS check
        if dnss_tags and tags & dnss_tags:
            line_items = li_by_order.get(oid, [])
            if any(li.app_line_status == "short_ship" for li in line_items):
                order.app_status = "not_processed"
                order.updated_at = datetime.now(timezone.utc)
                orders_unstaged_dnss += 1
                if order.assigned_warehouse:
                    affected_warehouses.add(order.assigned_warehouse)
                continue

        # Margin check: low margin (<30%) or $0 revenue / N/A GM
        if check_margin and not (tags & margin_override_tags):
            gm_pct = margins_by_order.get(oid)
            rev = revenue_by_order.get(oid, 0)
            ship_always_tags = rule_tags.get('ship_always', set())
            should_unstage = False
            if rev <= 0 and not (tags & ship_always_tags):
                should_unstage = True
            elif gm_pct is not None and gm_pct < 30.0:
                should_unstage = True
            if should_unstage:
                order.app_status = "not_processed"
                order.updated_at = datetime.now(timezone.utc)
                orders_unstaged_margin += 1
                if order.assigned_warehouse:
                    affected_warehouses.add(order.assigned_warehouse)

    if affected_warehouses:
        db.flush()
        for wh in affected_warehouses:
            _recompute_committed(wh, db)

    return {
        'orders_unstaged_hold': orders_unstaged_hold,
        'orders_unstaged_dnss': orders_unstaged_dnss,
        'orders_unstaged_margin': orders_unstaged_margin,
    }


def _unstage_orders_with_plan_issues(db: Session) -> int:
    """
    Find all staged orders with plan issues and move them back to not_processed.
    Plan issues: no plan, no box rule (plan_box_unmatched), or plan mismatch.
    Returns count of orders unstaged.
    """
    staged_orders = (
        db.query(models.ShopifyOrder)
        .filter(models.ShopifyOrder.app_status == "staged")
        .all()
    )

    orders_unstaged = 0
    affected_warehouses: set = set()

    for order in staged_orders:
        # Check has_plan: order has at least one non-cancelled fulfillment plan
        has_plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.shopify_order_id == order.shopify_order_id,
            models.FulfillmentPlan.status != "cancelled",
        ).first() is not None

        if not has_plan:
            order.app_status = "not_processed"
            order.updated_at = datetime.now(timezone.utc)
            orders_unstaged += 1
            if order.assigned_warehouse:
                affected_warehouses.add(order.assigned_warehouse)
            continue

        # Check plan_box_unmatched: plan has no non-cancelled boxes
        box_count = (
            db.query(models.FulfillmentBox)
            .join(models.FulfillmentPlan, models.FulfillmentPlan.id == models.FulfillmentBox.plan_id)
            .filter(
                models.FulfillmentPlan.shopify_order_id == order.shopify_order_id,
                models.FulfillmentPlan.status != "cancelled",
                models.FulfillmentBox.status != "cancelled",
            )
            .count()
        )
        plan_box_unmatched = box_count == 0

        if plan_box_unmatched:
            order.app_status = "not_processed"
            order.updated_at = datetime.now(timezone.utc)
            orders_unstaged += 1
            if order.assigned_warehouse:
                affected_warehouses.add(order.assigned_warehouse)
            continue

        # Check plan mismatch
        has_mismatch = _check_plan_mismatch(order.shopify_order_id, db)
        if has_mismatch:
            order.app_status = "not_processed"
            order.updated_at = datetime.now(timezone.utc)
            orders_unstaged += 1
            if order.assigned_warehouse:
                affected_warehouses.add(order.assigned_warehouse)

    if orders_unstaged:
        db.flush()
        for wh in affected_warehouses:
            _recompute_committed(wh, db)

    return orders_unstaged


# ── Gross margin ──────────────────────────────────────────────────────────────

# Maps (carrier_code, service_code) → (rate_card carrier, rate_card service_name)
_CARRIER_SERVICE_RATE_MAP = {
    ("stamps_com", "usps_priority_mail"):                    ("USPS", "USPS Priority Mail"),
    ("stamps_com", "usps_priority_mail_open_and_distribute"):("USPS", "USPS Priority Mail"),
    ("stamps_com", "usps_flat_rate_envelope"):               ("USPS", "USPS Flat Rate Envelope"),
    ("stamps_com", "usps_legal_flat_rate_envelope"):         ("USPS", "USPS Legal Flat Rate Envelope"),
    ("stamps_com", "usps_padded_flat_rate_envelope"):        ("USPS", "USPS Padded Flat Rate Envelope"),
    ("stamps_com", "usps_small_flat_rate_box"):              ("USPS", "USPS Small Flat Rate Box"),
    ("stamps_com", "usps_medium_flat_rate_box"):             ("USPS", "USPS Medium Flat Rate Box"),
    ("stamps_com", "usps_large_flat_rate_box"):              ("USPS", "USPS Large Flat Rate Box"),
    ("ups",        "ups_ground"):                            ("UPS",  "UPS Ground"),
    ("ups_walleted","ups_ground"):                           ("UPS",  "UPS Ground"),
    ("ups",        "ups_next_day_air"):                      ("UPS",  "UPS Next Day Air"),
    ("ups_walleted","ups_next_day_air"):                     ("UPS",  "UPS Next Day Air"),
    ("ups",        "ups_2nd_day_air"):                       ("UPS",  "UPS 2nd Day Air"),
    ("ups_walleted","ups_2nd_day_air"):                      ("UPS",  "UPS 2nd Day Air"),
}

# Maps BoxType.package_code → flat-rate service_name in rate_cards
_FLAT_RATE_PACKAGE_MAP = {
    "usps_flat_rate_envelope":          "USPS Flat Rate Envelope",
    "usps_legal_flat_rate_envelope":    "USPS Legal Flat Rate Envelope",
    "usps_padded_flat_rate_envelope":   "USPS Padded Flat Rate Envelope",
    "usps_small_flat_rate_box":         "USPS Small Flat Rate Box",
    "usps_medium_flat_rate_box":        "USPS Medium Flat Rate Box",
    "usps_large_flat_rate_box":         "USPS Large Flat Rate Box",
    "usps_military_large_flat_rate_box":"USPS Military Large Flat Rate Box",
}


def _lookup_shipping_rate(carrier: str, service_name: str, weight_lb: float, zone: int, db) -> Optional[float]:
    """
    Look up the estimated shipping rate from the DB rate_cards table.
    For flat rate services, zone and weight are ignored.
    For weight-based, rounds up to the nearest available weight tier.
    Falls back to Sheets (USPS) if no DB entry found.
    """
    from services import sheets_service as _ss

    # Flat rate — just match carrier + service_name
    if "Flat Rate" in service_name or "flat_rate" in service_name.lower():
        entry = db.query(models.RateCard).filter(
            models.RateCard.carrier == carrier,
            models.RateCard.service_name == service_name,
            models.RateCard.is_flat_rate == True,
        ).first()
        return entry.rate if entry else None

    if zone is None:
        return None

    # Weight-based: find the smallest weight_lb >= actual weight
    entry = db.query(models.RateCard).filter(
        models.RateCard.carrier == carrier,
        models.RateCard.service_name == service_name,
        models.RateCard.is_flat_rate == False,
        models.RateCard.zone == zone,
        models.RateCard.weight_lb >= weight_lb,
    ).order_by(models.RateCard.weight_lb).first()

    if entry:
        return entry.rate

    # For USPS, fall back to Sheets
    if carrier == "USPS":
        try:
            rc_rows = _ss.get_rate_cards(carrier="USPS", is_flat_rate=False)
            candidates = [
                r for r in rc_rows
                if r.get("service_name") == service_name
                and r.get("zone") == zone
                and r.get("weight_lb") is not None
                and r["weight_lb"] >= weight_lb
            ]
            if candidates:
                return min(candidates, key=lambda r: r["weight_lb"])["rate"]
        except Exception:
            pass

    return None


def _estimate_box_shipping(box, box_type, order, carrier_match, zone, db) -> dict:
    """
    Estimate shipping cost for a single box. Returns a dict with rate + metadata.
    """
    items = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).all()
    if not items:
        return {"box_id": box.id, "box_number": box.box_number, "rate": None, "error": "no items"}

    # Check if this is a flat rate box (by package_code)
    flat_rate_service = None
    if box_type and box_type.package_code:
        flat_rate_service = _FLAT_RATE_PACKAGE_MAP.get(box_type.package_code)

    if flat_rate_service:
        rate = _lookup_shipping_rate("USPS", flat_rate_service, 0, None, db)
        return {
            "box_id": box.id, "box_number": box.box_number,
            "weight_lb": None, "zone": None,
            "carrier": "USPS", "service": flat_rate_service,
            "rate": round(rate, 2) if rate is not None else None,
            "error": None if rate is not None else "rate not found",
        }

    # Weight-based: sum item weights + tare
    # Try SkuMapping.pick_weight_lb first, then fall back to PicklistSku.weight_lb
    total_weight_oz = 0.0
    for item in items:
        weight_lb_per_unit = None
        sku_rec = db.query(models.SkuMapping).filter(
            models.SkuMapping.pick_sku == item.pick_sku
        ).first()
        if sku_rec and sku_rec.pick_weight_lb:
            weight_lb_per_unit = sku_rec.pick_weight_lb
        else:
            pl_sku = db.query(models.PicklistSku).filter(
                models.PicklistSku.pick_sku == item.pick_sku
            ).first()
            if pl_sku and pl_sku.weight_lb:
                weight_lb_per_unit = pl_sku.weight_lb
        if weight_lb_per_unit:
            total_weight_oz += weight_lb_per_unit * item.quantity * 16.0
    if box_type and box_type.weight_oz:
        total_weight_oz += box_type.weight_oz

    weight_lb = total_weight_oz / 16.0 if total_weight_oz > 0 else None

    if weight_lb is None:
        return {"box_id": box.id, "box_number": box.box_number, "rate": None, "error": "no weight data"}

    if zone is None:
        return {"box_id": box.id, "box_number": box.box_number, "weight_lb": round(weight_lb, 2), "zone": None, "rate": None, "error": "zone unknown"}

    # Determine carrier/service from carrier match
    carrier_code = carrier_match.get("carrier_code") if carrier_match else None
    service_code = carrier_match.get("service_code") if carrier_match else None
    carrier, service_name = _CARRIER_SERVICE_RATE_MAP.get(
        (carrier_code, service_code), (None, None)
    ) if carrier_code and service_code else (None, None)

    if not carrier or not service_name:
        return {
            "box_id": box.id, "box_number": box.box_number,
            "weight_lb": round(weight_lb, 2), "zone": zone,
            "rate": None, "error": "carrier/service not mapped",
        }

    rate = _lookup_shipping_rate(carrier, service_name, weight_lb, zone, db)
    return {
        "box_id": box.id, "box_number": box.box_number,
        "weight_lb": round(weight_lb, 2), "zone": zone,
        "carrier": carrier, "service": service_name,
        "rate": round(rate, 2) if rate is not None else None,
        "error": None if rate is not None else "rate not found",
    }



@router.get("/{shopify_order_id}/margin")
def get_order_margin(
    shopify_order_id: str,
    period_id: Optional[int] = Query(None, description="Apply this projection period's short-ship/inventory-hold configs as in-memory overrides on app_line_status (no DB writes)"),
    mapping_tab: Optional[str] = Query(None, description="Re-resolve line item pick SKUs / mix_quantity against this sheet tab for COGS calculation (preview, no DB writes). Revenue is unaffected."),
    db: Session = Depends(get_db),
):
    """
    Split gross margin breakdown for an order — separate calculations for:
      - to_fulfill:          items with fulfillable_quantity > 0 (live costs)
      - fulfilled_app:       items fulfilled via the app (snapshotted costs)
      - fulfilled_external:  items fulfilled outside the app (revenue only, GM = N/A)

    Each group gets its own revenue, COGS, and GM%.
    Paid shipping is split proportionally by net line-item revenue.
    """
    from routers.fulfillment import _apply_carrier_service_rules, _zone_for_zip

    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == shopify_order_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == shopify_order_id
    ).all()
    # Period override mutates app_line_status in-memory only — see
    # mapping_override.apply_period_status_overrides for safety notes.
    mapping_override.apply_period_status_overrides(line_items, period_id, db)

    # Mapping tab override: re-resolve pick_sku/mix_quantity for COGS only.
    # Revenue is per-Shopify-line-item and doesn't depend on the warehouse
    # mapping, so it always reads from the original line_items.
    cogs_rows: Optional[list] = None
    if mapping_tab:
        cogs_rows = mapping_override.build_override_cogs_rows(line_items, mapping_tab)
    if cogs_rows is not None:
        def _cg(li, k):
            return li.get(k)
    else:
        cogs_rows = line_items
        def _cg(li, k):
            return getattr(li, k)

    # ── Determine which fulfilled line items were fulfilled via the app ───────
    # A line item is "fulfilled via app" if there are BoxLineItem records that
    # reference its shopify_line_item_id or shopify_sku in a shipped/fulfilled box.
    plan = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id == shopify_order_id,
        models.FulfillmentPlan.status != "cancelled",
    ).order_by(models.FulfillmentPlan.created_at.desc()).first()

    app_fulfilled_line_item_ids: set = set()
    shipped_boxes = []
    unshipped_boxes = []
    all_boxes = []
    if plan:
        all_boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.status != "cancelled",
        ).order_by(models.FulfillmentBox.box_number).all()
        for box in all_boxes:
            if box.status in ("shipped", "fulfilled"):
                shipped_boxes.append(box)
            else:
                unshipped_boxes.append(box)

        # Collect line_item_ids from shipped/fulfilled boxes
        shipped_box_ids = [b.id for b in shipped_boxes]
        if shipped_box_ids:
            shipped_box_items = db.query(models.BoxLineItem).filter(
                models.BoxLineItem.box_id.in_(shipped_box_ids)
            ).all()
            for bi in shipped_box_items:
                if bi.shopify_line_item_id:
                    app_fulfilled_line_item_ids.add(bi.shopify_line_item_id)
                elif bi.shopify_sku:
                    matched = db.query(models.ShopifyLineItem).filter(
                        models.ShopifyLineItem.shopify_order_id == shopify_order_id,
                        models.ShopifyLineItem.shopify_sku == bi.shopify_sku,
                    ).all()
                    for mli in matched:
                        if mli.line_item_id:
                            app_fulfilled_line_item_ids.add(mli.line_item_id)

    # ── Revenue — split into 3 groups ────────────────────────────────────────
    gross_all_items = 0.0
    seen_all_ids: set = set()
    for li in line_items:
        if li.line_item_id in seen_all_ids or li.app_line_status in ("removed", "short_ship"):
            continue
        seen_all_ids.add(li.line_item_id)
        gross_all_items += (li.price or 0.0) * (li.quantity or 0)

    subtotal_after_discounts = order.subtotal_price or 0.0
    effective_ratio = max(0.0, min(1.0, subtotal_after_discounts / gross_all_items)) if gross_all_items > 0 else 1.0

    rev_gross_unfulfilled = 0.0
    rev_gross_app = 0.0
    rev_gross_ext = 0.0
    rev_disc_unfulfilled = 0.0
    rev_disc_app = 0.0
    rev_disc_ext = 0.0
    revenue_gross_short_ship = 0.0
    rev_disc_short_ship = 0.0
    seen_line_item_ids: set = set()
    for li in line_items:
        if li.line_item_id in seen_line_item_ids:
            continue
        seen_line_item_ids.add(li.line_item_id)
        orig_qty = li.quantity or 1
        fulfillable_qty = li.fulfillable_quantity if li.fulfillable_quantity is not None else orig_qty
        fulfilled_qty = max(0, orig_qty - fulfillable_qty)

        if li.app_line_status == "removed":
            continue

        if li.app_line_status == "short_ship":
            rev_disc_short_ship += li.total_discount or 0.0
            if fulfillable_qty > 0:
                revenue_gross_short_ship += (li.price or 0.0) * fulfillable_qty
            continue

        # Unfulfilled portion
        if fulfillable_qty > 0:
            gross = (li.price or 0.0) * fulfillable_qty
            discount = (li.total_discount or 0.0) * (fulfillable_qty / orig_qty)
            rev_gross_unfulfilled += gross
            rev_disc_unfulfilled += discount

        # Fulfilled portion — split by app vs external
        if fulfilled_qty > 0:
            gross = (li.price or 0.0) * fulfilled_qty
            discount = (li.total_discount or 0.0) * (fulfilled_qty / orig_qty)
            if li.line_item_id in app_fulfilled_line_item_ids:
                rev_gross_app += gross
                rev_disc_app += discount
            else:
                rev_gross_ext += gross
                rev_disc_ext += discount

    # ── Reconcile order-level discount with line-item discounts ──────────────
    # Some Shopify discount types (automatic, custom, etc.) don't populate
    # line-item total_discount. Distribute the gap proportionally by gross revenue.
    order_total_discounts = order.total_discounts or 0.0
    li_discounts_sum = rev_disc_unfulfilled + rev_disc_app + rev_disc_ext
    # Exclude short-shipped items' discounts — they're already handled via effective_ratio
    discount_gap = order_total_discounts - li_discounts_sum - rev_disc_short_ship
    if discount_gap > 0.01:  # meaningful gap exists
        gross_total_excl_short = rev_gross_unfulfilled + rev_gross_app + rev_gross_ext
        if gross_total_excl_short > 0:
            rev_disc_unfulfilled += discount_gap * (rev_gross_unfulfilled / gross_total_excl_short)
            rev_disc_app += discount_gap * (rev_gross_app / gross_total_excl_short)
            rev_disc_ext += discount_gap * (rev_gross_ext / gross_total_excl_short)

    rev_disc_unfulfilled = round(rev_disc_unfulfilled, 2)
    rev_disc_app = round(rev_disc_app, 2)
    rev_disc_ext = round(rev_disc_ext, 2)
    rev_net_unfulfilled = rev_gross_unfulfilled - rev_disc_unfulfilled
    rev_net_app = rev_gross_app - rev_disc_app
    rev_net_ext = rev_gross_ext - rev_disc_ext
    revenue_short_ship = revenue_gross_short_ship * effective_ratio

    # Split paid shipping proportionally by net line-item revenue
    paid_shipping = order.total_shipping_price or 0.0
    net_total_for_split = rev_net_unfulfilled + rev_net_app + rev_net_ext
    if net_total_for_split > 0:
        ship_unfulfilled = paid_shipping * (rev_net_unfulfilled / net_total_for_split)
        ship_app = paid_shipping * (rev_net_app / net_total_for_split)
        ship_ext = paid_shipping * (rev_net_ext / net_total_for_split)
    elif rev_net_unfulfilled > 0:
        ship_unfulfilled = paid_shipping
        ship_app = 0.0
        ship_ext = 0.0
    else:
        # Edge case: all zero revenue — put shipping in unfulfilled if items exist
        ship_unfulfilled = paid_shipping if rev_gross_unfulfilled > 0 else 0.0
        ship_app = paid_shipping if ship_unfulfilled == 0 and rev_gross_app > 0 else 0.0
        ship_ext = 0.0

    rev_total_unfulfilled = rev_net_unfulfilled + ship_unfulfilled
    rev_total_app = rev_net_app + ship_app
    rev_total_ext = rev_net_ext + ship_ext
    # Legacy totals for staging guard etc.
    revenue_shippable = rev_net_unfulfilled + paid_shipping
    revenue_total = rev_net_unfulfilled + rev_net_app + rev_net_ext + paid_shipping

    # ── COGS: Fruit / SKU cost (unfulfilled — live data) ─────────────────────
    # Reads from `cogs_rows` so the mapping_tab override (when present) picks
    # the override's pick_sku + mix_quantity. Revenue calculations above stay
    # on `line_items` since revenue is mapping-independent.
    picklist_map = {r.pick_sku: r for r in db.query(models.PicklistSku).all()}

    sku_weights: dict = {}
    for li in cogs_rows:
        pick_sku = _cg(li, "pick_sku")
        if pick_sku and _cg(li, "app_line_status") not in ("short_ship", "removed"):
            sku_rec = picklist_map.get(pick_sku)
            if sku_rec and sku_rec.weight_lb:
                sku_weights[pick_sku] = sku_rec.weight_lb

    fruit_cost_unfulfilled = 0.0
    fruit_lines = []
    missing_cost_skus: list = []
    for li in cogs_rows:
        pick_sku = _cg(li, "pick_sku")
        if _cg(li, "app_line_status") in ("short_ship", "removed") or not pick_sku:
            continue
        orig_qty_fc = _cg(li, "quantity") or 1
        fq_attr = _cg(li, "fulfillable_quantity")
        unfulfilled_qty = fq_attr if fq_attr is not None else orig_qty_fc
        if unfulfilled_qty <= 0:
            continue
        sku_rec = picklist_map.get(pick_sku)
        if not sku_rec or sku_rec.weight_lb is None:
            continue
        cost_per_lb = sku_rec.cost_per_lb
        if cost_per_lb is None and sku_rec.cost_per_case is not None and sku_rec.case_weight_lb:
            cost_per_lb = sku_rec.cost_per_case / sku_rec.case_weight_lb
        if cost_per_lb is None:
            if pick_sku not in missing_cost_skus:
                missing_cost_skus.append(pick_sku)
            continue
        mix = _cg(li, "mix_quantity") or 1.0
        line_cost = sku_rec.weight_lb * mix * unfulfilled_qty * cost_per_lb
        fruit_cost_unfulfilled += line_cost
        fruit_lines.append({
            "pick_sku": pick_sku, "qty": unfulfilled_qty, "mix": mix,
            "weight_lb": sku_rec.weight_lb, "cost_per_lb": round(cost_per_lb, 4),
            "line_cost": round(line_cost, 2),
        })

    # ── COGS: Fulfilled-via-app — from snapshots ─────────────────────────────
    fruit_cost_app = 0.0
    fruit_lines_app = []
    shipping_cost_app = 0.0
    packaging_cost_app = 0.0
    shipping_boxes_app = []
    has_app_snapshots = len(shipped_boxes) > 0
    for box in shipped_boxes:
        # Shipping from snapshot
        if box.shipping_cost_snapshot is not None:
            shipping_cost_app += box.shipping_cost_snapshot
            shipping_boxes_app.append({
                "box_id": box.id, "box_number": box.box_number,
                "rate": box.shipping_cost_snapshot, "source": "snapshot",
            })
        # Packaging from snapshot
        if box.packaging_cost_snapshot is not None:
            packaging_cost_app += box.packaging_cost_snapshot
        # Fruit cost from line item snapshots
        box_items = db.query(models.BoxLineItem).filter(
            models.BoxLineItem.box_id == box.id
        ).all()
        for bi in box_items:
            if bi.cost_per_lb_snapshot is not None and bi.weight_lb_snapshot is not None:
                line_cost = bi.weight_lb_snapshot * bi.quantity * bi.cost_per_lb_snapshot
                fruit_cost_app += line_cost
                fruit_lines_app.append({
                    "pick_sku": bi.pick_sku, "qty": bi.quantity,
                    "weight_lb": bi.weight_lb_snapshot,
                    "cost_per_lb": bi.cost_per_lb_snapshot,
                    "line_cost": round(line_cost, 2),
                    "source": "snapshot",
                })

    # ── COGS: Shipping estimate for unfulfilled boxes ────────────────────────
    shipping_cost_unfulfilled = None
    shipping_boxes_unfulfilled = []
    shipping_missing_reason = None

    if not plan:
        shipping_missing_reason = "no_plan"
    elif not unshipped_boxes:
        if not shipped_boxes:
            shipping_missing_reason = "no_boxes"
        else:
            # All boxes shipped — no unfulfilled shipping cost needed
            shipping_cost_unfulfilled = 0.0
    else:
        carrier_match = _apply_carrier_service_rules(order, db)
        zone = _zone_for_zip(order.shipping_zip)
        shipping_cost_unfulfilled = 0.0
        for box in unshipped_boxes:
            box_type = db.query(models.BoxType).filter(
                models.BoxType.id == box.box_type_id
            ).first() if box.box_type_id else None
            box_est = _estimate_box_shipping(box, box_type, order, carrier_match, zone, db)
            shipping_boxes_unfulfilled.append(box_est)
            if box_est.get("rate") is not None:
                shipping_cost_unfulfilled += box_est["rate"]
            else:
                shipping_cost_unfulfilled = None
                break

    # ── COGS: Packaging for unfulfilled boxes ────────────────────────────────
    packaging_cost_unfulfilled = 0.0
    packaging_lines = []
    for box in unshipped_boxes:
        if not box.box_type_id:
            continue
        btps = db.query(models.BoxTypePackaging).filter(
            models.BoxTypePackaging.box_type_id == box.box_type_id
        ).all()
        for btp in btps:
            mat = db.query(models.PackagingMaterial).filter(
                models.PackagingMaterial.id == btp.packaging_material_id
            ).first()
            if mat:
                line_cost = mat.unit_cost * btp.quantity
                packaging_cost_unfulfilled += line_cost
                packaging_lines.append({
                    "box_number": box.box_number,
                    "material": mat.name, "qty": btp.quantity,
                    "unit_cost": mat.unit_cost, "line_cost": round(line_cost, 2),
                })

    # ── COGS: % estimates (per-group) ────────────────────────────────────────
    gm_settings = db.query(models.GmSettings).filter(models.GmSettings.id == 1).first()
    replacement_pct = gm_settings.replacement_pct if gm_settings else 1.0
    refund_pct = gm_settings.refund_pct if gm_settings else 1.0
    transaction_fee_pct = gm_settings.transaction_fee_pct if gm_settings else 2.9

    def _pct_cogs(rev):
        return {
            "replacement": rev * replacement_pct / 100,
            "refund": rev * refund_pct / 100,
            "transaction_fee": rev * transaction_fee_pct / 100,
        }

    pct_unfulfilled = _pct_cogs(rev_total_unfulfilled)
    pct_app = _pct_cogs(rev_total_app)

    # ── Group A: To Fulfill ──────────────────────────────────────────────────
    cogs_known_uf = (fruit_cost_unfulfilled + packaging_cost_unfulfilled
                     + pct_unfulfilled["replacement"] + pct_unfulfilled["refund"]
                     + pct_unfulfilled["transaction_fee"])
    cogs_total_uf = (cogs_known_uf + shipping_cost_unfulfilled) if shipping_cost_unfulfilled is not None else None
    gm_pct_unfulfilled = None
    if cogs_total_uf is not None and rev_total_unfulfilled > 0:
        gm_pct_unfulfilled = round((rev_total_unfulfilled - cogs_total_uf) / rev_total_unfulfilled * 100, 1)

    # ── Group B: Fulfilled via App ───────────────────────────────────────────
    cogs_known_app = (fruit_cost_app + packaging_cost_app + shipping_cost_app
                      + pct_app["replacement"] + pct_app["refund"]
                      + pct_app["transaction_fee"])
    cogs_total_app = cogs_known_app  # all snapshotted, no missing data
    gm_pct_app = None
    if rev_total_app > 0:
        gm_pct_app = round((rev_total_app - cogs_total_app) / rev_total_app * 100, 1)

    # ── Header GM% = To Fulfill if available, else Fulfilled via App ─────────
    header_gm_pct = gm_pct_unfulfilled if rev_net_unfulfilled > 0 else gm_pct_app

    return {
        # Legacy / staging guard fields
        "revenue_shippable": round(revenue_shippable, 2),
        "revenue_total": round(revenue_total, 2),
        "revenue_short_ship": round(revenue_short_ship, 2),
        "paid_shipping": round(paid_shipping, 2),
        # Header GM% (To Fulfill if items exist, else Fulfilled via App)
        "gross_margin_pct": header_gm_pct,
        # Settings
        "settings": {
            "replacement_pct": replacement_pct,
            "refund_pct": refund_pct,
            "transaction_fee_pct": transaction_fee_pct,
        },
        "missing_cost_skus": missing_cost_skus,
        "sku_weights": sku_weights,
        # Line item IDs fulfilled through the app (for frontend item display)
        "app_fulfilled_line_item_ids": sorted(app_fulfilled_line_item_ids),
        # ── Group A: To Fulfill ──────────────────────────────────────────
        "to_fulfill": {
            "revenue_gross": round(rev_gross_unfulfilled, 2),
            "revenue_discounts": round(rev_disc_unfulfilled, 2),
            "revenue_net": round(rev_net_unfulfilled, 2),
            "revenue_shipping": round(ship_unfulfilled, 2),
            "revenue_total": round(rev_total_unfulfilled, 2),
            "cogs_fruit": round(fruit_cost_unfulfilled, 2),
            "cogs_shipping": round(shipping_cost_unfulfilled, 2) if shipping_cost_unfulfilled is not None else None,
            "cogs_packaging": round(packaging_cost_unfulfilled, 2),
            "cogs_replacement": round(pct_unfulfilled["replacement"], 2),
            "cogs_refund": round(pct_unfulfilled["refund"], 2),
            "cogs_transaction_fee": round(pct_unfulfilled["transaction_fee"], 2),
            "cogs_total": round(cogs_total_uf, 2) if cogs_total_uf is not None else None,
            "gross_margin_pct": gm_pct_unfulfilled,
            "fruit_lines": fruit_lines,
            "shipping_boxes": shipping_boxes_unfulfilled,
            "shipping_missing_reason": shipping_missing_reason,
            "packaging_lines": packaging_lines,
        },
        # ── Group B: Fulfilled via App ───────────────────────────────────
        "fulfilled_app": {
            "revenue_gross": round(rev_gross_app, 2),
            "revenue_discounts": round(rev_disc_app, 2),
            "revenue_net": round(rev_net_app, 2),
            "revenue_shipping": round(ship_app, 2),
            "revenue_total": round(rev_total_app, 2),
            "cogs_fruit": round(fruit_cost_app, 2),
            "cogs_shipping": round(shipping_cost_app, 2),
            "cogs_packaging": round(packaging_cost_app, 2),
            "cogs_replacement": round(pct_app["replacement"], 2),
            "cogs_refund": round(pct_app["refund"], 2),
            "cogs_transaction_fee": round(pct_app["transaction_fee"], 2),
            "cogs_total": round(cogs_total_app, 2),
            "gross_margin_pct": gm_pct_app,
            "fruit_lines": fruit_lines_app,
            "shipping_boxes": shipping_boxes_app,
        },
        # ── Group C: Fulfilled outside App ───────────────────────────────
        "fulfilled_external": {
            "revenue_gross": round(rev_gross_ext, 2),
            "revenue_discounts": round(rev_disc_ext, 2),
            "revenue_net": round(rev_net_ext, 2),
            "revenue_shipping": round(ship_ext, 2),
            "revenue_total": round(rev_total_ext, 2),
            "gross_margin_pct": None,  # always N/A
        },
    }
