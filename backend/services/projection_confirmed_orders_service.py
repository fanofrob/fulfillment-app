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


def build_boxes_snapshot(
    db: Session,
    shopify_order_id: str,
    pick_to_pt: dict,
    weight_map: dict,
) -> list[dict]:
    """
    Build the frozen box-contents snapshot for a single order.
    Returns list of {pick_sku, quantity, weight_lb, product_type}.
    Raises ValueError if the order has no active plan or no non-cancelled boxes.
    """
    plan = _get_active_plan(db, shopify_order_id)
    if not plan:
        raise ValueError("Order has no fulfillment plan")

    boxes = (
        db.query(models.FulfillmentBox)
        .filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.status != "cancelled",
        )
        .all()
    )
    if not boxes:
        raise ValueError("Order plan has no boxes")

    items: list[dict] = []
    for box in boxes:
        box_items = (
            db.query(models.BoxLineItem)
            .filter(models.BoxLineItem.box_id == box.id)
            .all()
        )
        for bli in box_items:
            if not bli.pick_sku or bli.quantity is None:
                continue
            items.append({
                "pick_sku":     bli.pick_sku,
                "quantity":     float(bli.quantity),
                "weight_lb":    weight_map.get(bli.pick_sku),
                "product_type": pick_to_pt.get(bli.pick_sku),
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
            snapshot = build_boxes_snapshot(db, oid, pick_to_pt, weight_map)
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


def rollup_lbs_by_product_type(db: Session, period_id: int) -> dict[str, float]:
    """Sum weight_lb × quantity across every confirmed order's box snapshot."""
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
            totals[pt] += float(qty) * float(w)
    return {pt: round(lbs, 2) for pt, lbs in totals.items()}


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
