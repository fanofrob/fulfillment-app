"""
Projection Confirmed Orders router — the review/override layer for confirmed
demand under Projections. Mounted at /api/projection-periods/{period_id}/...
alongside projection_periods.py but kept as a separate module because the
surface area is distinct (box snapshots, save/revert, staged-order guard).
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from services import projection_confirmed_orders_service as svc

router = APIRouter()


class _CDSetShortShipByTypeRequest(BaseModel):
    product_type: str
    allow_short_ship: bool


class _CDSetInventoryHoldByTypeRequest(BaseModel):
    product_type: str
    inventory_hold: bool


def _ensure_period(period_id: int, db: Session) -> models.ProjectionPeriod:
    period = (
        db.query(models.ProjectionPeriod)
        .filter(models.ProjectionPeriod.id == period_id)
        .first()
    )
    if not period:
        raise HTTPException(status_code=404, detail=f"Period {period_id} not found")
    return period


def _ensure_not_archived(period: models.ProjectionPeriod):
    if period.status == "archived":
        raise HTTPException(status_code=409, detail="Cannot modify an archived period")


def _run_cascade(db: Session, period_id: int, changed_skus: set[str]) -> dict:
    """Run the auto-unconfirm cascade and commit. Returns the cascade summary
    in the shape `{unconfirmed: int, order_ids: [str], changed_skus: [str]}`.
    Caller must have already committed the upstream config write."""
    summary = svc.apply_cd_status_to_confirmed_orders(db, period_id, changed_skus)
    if summary["unconfirmed"]:
        db.commit()
    return {
        "unconfirmed": summary["unconfirmed"],
        "order_ids": summary["order_ids"],
        "changed_skus": sorted(changed_skus),
    }


@router.get(
    "/{period_id}/confirmed-orders",
    response_model=list[schemas.ProjectionPeriodConfirmedOrderResponse],
)
def list_confirmed(period_id: int, db: Session = Depends(get_db)):
    _ensure_period(period_id, db)
    return (
        db.query(models.ProjectionPeriodConfirmedOrder)
        .filter(models.ProjectionPeriodConfirmedOrder.period_id == period_id)
        .order_by(models.ProjectionPeriodConfirmedOrder.confirmed_at.desc())
        .all()
    )


@router.post(
    "/{period_id}/confirm-orders",
    response_model=schemas.ConfirmOrdersResult,
)
def confirm_orders(
    period_id: int,
    body: schemas.ConfirmOrdersRequest,
    db: Session = Depends(get_db),
):
    period = _ensure_period(period_id, db)
    _ensure_not_archived(period)
    if not body.mapping_tab:
        raise HTTPException(status_code=400, detail="mapping_tab is required")
    if not body.order_ids:
        raise HTTPException(status_code=400, detail="order_ids is required")

    results = svc.confirm_orders(db, period_id, body.order_ids, body.mapping_tab)
    confirmed = sum(1 for r in results if r.get("success"))
    return {
        "confirmed": confirmed,
        "skipped": len(results) - confirmed,
        "results": results,
    }


class _ReConfirmAllRequest(BaseModel):
    mapping_tab: str
    order_ids: Optional[List[str]] = None  # None = re-confirm all eligible-unconfirmed


@router.post("/{period_id}/re-confirm-all")
def re_confirm_all(
    period_id: int,
    body: _ReConfirmAllRequest,
    db: Session = Depends(get_db),
):
    """
    Bulk-confirm orders in the period using the period-aware planner. Without
    `order_ids`, picks every eligible-but-unconfirmed order — the natural
    follow-up to a CD short-ship/hold cascade that just kicked orders back.
    """
    period = _ensure_period(period_id, db)
    _ensure_not_archived(period)
    if not body.mapping_tab:
        raise HTTPException(status_code=400, detail="mapping_tab is required")

    target_ids = body.order_ids
    if target_ids is None:
        target_ids = svc.list_unconfirmed_eligible_order_ids(db, period_id)
    if not target_ids:
        return {"confirmed": 0, "skipped": 0, "results": []}

    results = svc.confirm_orders(db, period_id, target_ids, body.mapping_tab)
    confirmed = sum(1 for r in results if r.get("success"))
    return {
        "confirmed": confirmed,
        "skipped": len(results) - confirmed,
        "results": results,
    }


@router.post("/{period_id}/unconfirm-orders")
def unconfirm_orders(
    period_id: int,
    body: schemas.UnconfirmOrdersRequest,
    db: Session = Depends(get_db),
):
    period = _ensure_period(period_id, db)
    _ensure_not_archived(period)
    deleted = svc.unconfirm_orders(db, period_id, body.order_ids)
    return {"deleted": deleted}


@router.get("/{period_id}/confirmed-demand-rollup")
def get_rollup(period_id: int, db: Session = Depends(get_db)):
    _ensure_period(period_id, db)
    return {
        "rollup_lbs_by_product_type": svc.rollup_lbs_by_product_type(db, period_id),
        "mapping_used_breakdown": svc.mapping_used_breakdown(db, period_id),
    }


@router.post(
    "/{period_id}/save-confirmed-demand",
    response_model=schemas.SaveConfirmedDemandResponse,
)
def save_confirmed_demand(period_id: int, db: Session = Depends(get_db)):
    period = _ensure_period(period_id, db)
    _ensure_not_archived(period)

    # Pre-flight: block if any order anywhere in the system is staged
    staged_count = svc.count_staged_orders(db)
    if staged_count > 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{staged_count} order(s) are currently staged in Operations. "
                f"Unstage all orders before saving confirmed demand."
            ),
        )
    try:
        return svc.save_confirmed_demand(db, period_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/{period_id}/revert-confirmed-demand")
def revert_confirmed_demand(period_id: int, db: Session = Depends(get_db)):
    period = _ensure_period(period_id, db)
    _ensure_not_archived(period)
    try:
        return svc.revert_confirmed_demand(db, period_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{period_id}/staged-orders-blocking")
def get_staged_orders_blocking(period_id: int, db: Session = Depends(get_db)):
    """
    Lightweight check used by the UI to warn before save. Returns the count of
    currently-staged orders anywhere in the system.
    """
    _ensure_period(period_id, db)
    return {"staged_count": svc.count_staged_orders(db)}


@router.get("/{period_id}/confirmed-demand-inventory")
def confirmed_demand_inventory(period_id: int, db: Session = Depends(get_db)):
    """
    Pivot of confirmed demand vs. on-hand inventory for the period. Excluded
    SKUs (per the Confirmed Demand Dashboard's short-ship / inventory-hold
    configs) are removed from demand.
    """
    _ensure_period(period_id, db)
    return svc.confirmed_demand_inventory_pivot(db, period_id)


# ── Confirmed Demand short-ship config (independent per-period layer) ───────

@router.get(
    "/{period_id}/confirmed-demand/short-ship",
    response_model=List[schemas.ConfirmedDemandShortShipResponse],
)
def cd_list_short_ship(period_id: int, db: Session = Depends(get_db)):
    _ensure_period(period_id, db)
    return (
        db.query(models.ConfirmedDemandShortShipConfig)
        .filter(models.ConfirmedDemandShortShipConfig.period_id == period_id)
        .order_by(models.ConfirmedDemandShortShipConfig.shopify_sku)
        .all()
    )


@router.post("/{period_id}/confirmed-demand/short-ship")
def cd_add_short_ship(
    period_id: int,
    body: schemas.PeriodConfigItem,
    db: Session = Depends(get_db),
):
    _ensure_period(period_id, db)
    existing = (
        db.query(models.ConfirmedDemandShortShipConfig)
        .filter(
            models.ConfirmedDemandShortShipConfig.period_id == period_id,
            models.ConfirmedDemandShortShipConfig.shopify_sku == body.shopify_sku,
        )
        .first()
    )
    if existing:
        return {"cfg": {"id": existing.id, "period_id": existing.period_id, "shopify_sku": existing.shopify_sku, "created_at": existing.created_at},
                "cascade": {"unconfirmed": 0, "order_ids": [], "changed_skus": []}}
    cfg = models.ConfirmedDemandShortShipConfig(period_id=period_id, shopify_sku=body.shopify_sku)
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    cascade = _run_cascade(db, period_id, {body.shopify_sku})
    return {"cfg": {"id": cfg.id, "period_id": cfg.period_id, "shopify_sku": cfg.shopify_sku, "created_at": cfg.created_at},
            "cascade": cascade}


@router.post("/{period_id}/confirmed-demand/short-ship/bulk")
def cd_bulk_set_short_ship(
    period_id: int,
    body: List[schemas.PeriodConfigItem],
    db: Session = Depends(get_db),
):
    """Replace all Confirmed Demand short-ship SKUs for this period."""
    _ensure_period(period_id, db)
    old_skus = {
        r.shopify_sku for r in db.query(models.ConfirmedDemandShortShipConfig.shopify_sku)
        .filter(models.ConfirmedDemandShortShipConfig.period_id == period_id).all()
    }
    new_skus = {item.shopify_sku for item in body}
    changed = (old_skus | new_skus) - (old_skus & new_skus)  # XOR

    db.query(models.ConfirmedDemandShortShipConfig).filter(
        models.ConfirmedDemandShortShipConfig.period_id == period_id
    ).delete()
    new_items = []
    for item in body:
        cfg = models.ConfirmedDemandShortShipConfig(period_id=period_id, shopify_sku=item.shopify_sku)
        db.add(cfg)
        new_items.append(cfg)
    db.commit()
    for item in new_items:
        db.refresh(item)
    cascade = _run_cascade(db, period_id, changed)
    return {
        "items": [{"id": i.id, "period_id": i.period_id, "shopify_sku": i.shopify_sku, "created_at": i.created_at} for i in new_items],
        "cascade": cascade,
    }


@router.delete("/{period_id}/confirmed-demand/short-ship/{shopify_sku:path}")
def cd_remove_short_ship(period_id: int, shopify_sku: str, db: Session = Depends(get_db)):
    deleted = (
        db.query(models.ConfirmedDemandShortShipConfig)
        .filter(
            models.ConfirmedDemandShortShipConfig.period_id == period_id,
            models.ConfirmedDemandShortShipConfig.shopify_sku == shopify_sku,
        )
        .delete()
    )
    db.commit()
    cascade = _run_cascade(db, period_id, {shopify_sku} if deleted else set())
    return {"deleted": deleted > 0, "cascade": cascade}


@router.post("/{period_id}/confirmed-demand/short-ship/import-global")
def cd_import_global_short_ship(period_id: int, db: Session = Depends(get_db)):
    """Seed this period's Confirmed Demand short-ship list from the current
    global `shopify_products.allow_short_ship` flags (Staging Dashboard's
    config). One-way snapshot — future Staging edits won't auto-propagate."""
    _ensure_period(period_id, db)
    global_skus = {
        r.shopify_sku
        for r in db.query(models.ShopifyProduct).filter(
            models.ShopifyProduct.allow_short_ship == True
        ).all()
    }
    existing = {
        r.shopify_sku
        for r in db.query(models.ConfirmedDemandShortShipConfig).filter(
            models.ConfirmedDemandShortShipConfig.period_id == period_id
        ).all()
    }
    new_skus = global_skus - existing
    for sku in new_skus:
        db.add(models.ConfirmedDemandShortShipConfig(period_id=period_id, shopify_sku=sku))
    db.commit()
    cascade = _run_cascade(db, period_id, new_skus)
    return {"imported": len(new_skus), "already_existed": len(global_skus & existing), "cascade": cascade}


# ── Confirmed Demand inventory-hold config ──────────────────────────────────

@router.get(
    "/{period_id}/confirmed-demand/inventory-hold",
    response_model=List[schemas.ConfirmedDemandInventoryHoldResponse],
)
def cd_list_inventory_hold(period_id: int, db: Session = Depends(get_db)):
    _ensure_period(period_id, db)
    return (
        db.query(models.ConfirmedDemandInventoryHoldConfig)
        .filter(models.ConfirmedDemandInventoryHoldConfig.period_id == period_id)
        .order_by(models.ConfirmedDemandInventoryHoldConfig.shopify_sku)
        .all()
    )


@router.post("/{period_id}/confirmed-demand/inventory-hold")
def cd_add_inventory_hold(
    period_id: int,
    body: schemas.PeriodConfigItem,
    db: Session = Depends(get_db),
):
    _ensure_period(period_id, db)
    existing = (
        db.query(models.ConfirmedDemandInventoryHoldConfig)
        .filter(
            models.ConfirmedDemandInventoryHoldConfig.period_id == period_id,
            models.ConfirmedDemandInventoryHoldConfig.shopify_sku == body.shopify_sku,
        )
        .first()
    )
    if existing:
        return {"cfg": {"id": existing.id, "period_id": existing.period_id, "shopify_sku": existing.shopify_sku, "created_at": existing.created_at},
                "cascade": {"unconfirmed": 0, "order_ids": [], "changed_skus": []}}
    cfg = models.ConfirmedDemandInventoryHoldConfig(period_id=period_id, shopify_sku=body.shopify_sku)
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    cascade = _run_cascade(db, period_id, {body.shopify_sku})
    return {"cfg": {"id": cfg.id, "period_id": cfg.period_id, "shopify_sku": cfg.shopify_sku, "created_at": cfg.created_at},
            "cascade": cascade}


@router.post("/{period_id}/confirmed-demand/inventory-hold/bulk")
def cd_bulk_set_inventory_hold(
    period_id: int,
    body: List[schemas.PeriodConfigItem],
    db: Session = Depends(get_db),
):
    """Replace all Confirmed Demand inventory-hold SKUs for this period."""
    _ensure_period(period_id, db)
    old_skus = {
        r.shopify_sku for r in db.query(models.ConfirmedDemandInventoryHoldConfig.shopify_sku)
        .filter(models.ConfirmedDemandInventoryHoldConfig.period_id == period_id).all()
    }
    new_skus = {item.shopify_sku for item in body}
    changed = (old_skus | new_skus) - (old_skus & new_skus)

    db.query(models.ConfirmedDemandInventoryHoldConfig).filter(
        models.ConfirmedDemandInventoryHoldConfig.period_id == period_id
    ).delete()
    new_items = []
    for item in body:
        cfg = models.ConfirmedDemandInventoryHoldConfig(period_id=period_id, shopify_sku=item.shopify_sku)
        db.add(cfg)
        new_items.append(cfg)
    db.commit()
    for item in new_items:
        db.refresh(item)
    cascade = _run_cascade(db, period_id, changed)
    return {
        "items": [{"id": i.id, "period_id": i.period_id, "shopify_sku": i.shopify_sku, "created_at": i.created_at} for i in new_items],
        "cascade": cascade,
    }


@router.delete("/{period_id}/confirmed-demand/inventory-hold/{shopify_sku:path}")
def cd_remove_inventory_hold(period_id: int, shopify_sku: str, db: Session = Depends(get_db)):
    deleted = (
        db.query(models.ConfirmedDemandInventoryHoldConfig)
        .filter(
            models.ConfirmedDemandInventoryHoldConfig.period_id == period_id,
            models.ConfirmedDemandInventoryHoldConfig.shopify_sku == shopify_sku,
        )
        .delete()
    )
    db.commit()
    cascade = _run_cascade(db, period_id, {shopify_sku} if deleted else set())
    return {"deleted": deleted > 0, "cascade": cascade}


@router.post("/{period_id}/confirmed-demand/inventory-hold/import-global")
def cd_import_global_inventory_hold(period_id: int, db: Session = Depends(get_db)):
    """Seed this period's Confirmed Demand inventory-hold list from the current
    global `shopify_products.inventory_hold` flags (Staging Dashboard's config)."""
    _ensure_period(period_id, db)
    global_skus = {
        r.shopify_sku
        for r in db.query(models.ShopifyProduct).filter(
            models.ShopifyProduct.inventory_hold == True
        ).all()
    }
    existing = {
        r.shopify_sku
        for r in db.query(models.ConfirmedDemandInventoryHoldConfig).filter(
            models.ConfirmedDemandInventoryHoldConfig.period_id == period_id
        ).all()
    }
    new_skus = global_skus - existing
    for sku in new_skus:
        db.add(models.ConfirmedDemandInventoryHoldConfig(period_id=period_id, shopify_sku=sku))
    db.commit()
    cascade = _run_cascade(db, period_id, new_skus)
    return {"imported": len(new_skus), "already_existed": len(global_skus & existing), "cascade": cascade}


# ── Bulk-by-product-type endpoints (mirror productsApi.setShortShipByType) ──

def _cd_set_by_product_type(
    db: Session,
    period_id: int,
    product_type: str,
    table_cls,
    on: bool,
):
    """Add or remove every shopify_product matching `product_type` to/from the
    period's CD config table. Mirrors the per-type flip on Staging."""
    skus = {
        r.shopify_sku
        for r in db.query(models.ShopifyProduct.shopify_sku).filter(
            models.ShopifyProduct.product_type == product_type
        ).all()
        if r.shopify_sku
    }
    if not skus:
        return {"changed": 0, "cascade": {"unconfirmed": 0, "order_ids": [], "changed_skus": []}}
    if on:
        existing = {
            r.shopify_sku
            for r in db.query(table_cls.shopify_sku).filter(
                table_cls.period_id == period_id,
                table_cls.shopify_sku.in_(list(skus)),
            ).all()
        }
        new_skus = skus - existing
        for sku in new_skus:
            db.add(table_cls(period_id=period_id, shopify_sku=sku))
        db.commit()
        cascade = _run_cascade(db, period_id, new_skus)
        return {"changed": len(new_skus), "cascade": cascade}
    # Capture which SKUs are about to be removed before the delete
    removed_skus = {
        r.shopify_sku
        for r in db.query(table_cls.shopify_sku).filter(
            table_cls.period_id == period_id,
            table_cls.shopify_sku.in_(list(skus)),
        ).all()
    }
    deleted = (
        db.query(table_cls)
        .filter(
            table_cls.period_id == period_id,
            table_cls.shopify_sku.in_(list(skus)),
        )
        .delete(synchronize_session=False)
    )
    db.commit()
    cascade = _run_cascade(db, period_id, removed_skus)
    return {"changed": deleted, "cascade": cascade}


@router.post("/{period_id}/confirmed-demand/short-ship/by-product-type")
def cd_set_short_ship_by_type(
    period_id: int,
    body: _CDSetShortShipByTypeRequest,
    db: Session = Depends(get_db),
):
    _ensure_period(period_id, db)
    return _cd_set_by_product_type(
        db, period_id, body.product_type,
        models.ConfirmedDemandShortShipConfig,
        body.allow_short_ship,
    )


@router.post("/{period_id}/confirmed-demand/inventory-hold/by-product-type")
def cd_set_inventory_hold_by_type(
    period_id: int,
    body: _CDSetInventoryHoldByTypeRequest,
    db: Session = Depends(get_db),
):
    _ensure_period(period_id, db)
    return _cd_set_by_product_type(
        db, period_id, body.product_type,
        models.ConfirmedDemandInventoryHoldConfig,
        body.inventory_hold,
    )


# ── Enriched confirmed orders (joined with ShopifyOrder + line items) ───────

@router.get("/{period_id}/confirmed-orders/enriched")
def list_confirmed_enriched(period_id: int, db: Session = Depends(get_db)):
    """
    Confirmed orders joined with their ShopifyOrder + ShopifyLineItem rows.
    Returned shape mirrors the Operations `GET /api/orders` rows so the
    Staging Dashboard's StagedOrdersTab UI can render confirmed orders without
    further reshaping. Excludes the legacy snapshot/mapping_used fields, which
    aren't needed by that UI.
    """
    _ensure_period(period_id, db)

    rows = (
        db.query(models.ProjectionPeriodConfirmedOrder)
        .filter(models.ProjectionPeriodConfirmedOrder.period_id == period_id)
        .order_by(models.ProjectionPeriodConfirmedOrder.confirmed_at.desc())
        .all()
    )
    if not rows:
        return []

    order_ids = [r.shopify_order_id for r in rows]
    orders = {
        o.shopify_order_id: o for o in
        db.query(models.ShopifyOrder)
        .filter(models.ShopifyOrder.shopify_order_id.in_(order_ids))
        .all()
    }
    line_items_by_order: dict[str, list] = {}
    for li in (
        db.query(models.ShopifyLineItem)
        .filter(models.ShopifyLineItem.shopify_order_id.in_(order_ids))
        .all()
    ):
        line_items_by_order.setdefault(li.shopify_order_id, []).append(li)

    # Apply the period's confirmed-demand short-ship / inventory-hold overrides
    # to line-item statuses in-memory only (read-only).
    excluded_short = {
        r.shopify_sku for r in
        db.query(models.ConfirmedDemandShortShipConfig.shopify_sku)
        .filter(models.ConfirmedDemandShortShipConfig.period_id == period_id)
        .all()
    }
    excluded_hold = {
        r.shopify_sku for r in
        db.query(models.ConfirmedDemandInventoryHoldConfig.shopify_sku)
        .filter(models.ConfirmedDemandInventoryHoldConfig.period_id == period_id)
        .all()
    }
    for li_list in line_items_by_order.values():
        for li in li_list:
            if li.app_line_status == "removed":
                continue
            sku = li.shopify_sku
            if sku and sku in excluded_short:
                li.app_line_status = "short_ship"
            elif sku and sku in excluded_hold:
                li.app_line_status = "inventory_hold"
            else:
                li.app_line_status = None

    out = []
    for r in rows:
        o = orders.get(r.shopify_order_id)
        if not o:
            continue
        lis = line_items_by_order.get(r.shopify_order_id, [])
        out.append({
            "shopify_order_id":      o.shopify_order_id,
            "shopify_order_number":  o.shopify_order_number,
            "customer_name":         o.customer_name,
            "tags":                  o.tags,
            "total_price":           o.total_price,
            "total_shipping_price":  o.total_shipping_price,
            "created_at_shopify":    o.created_at_shopify,
            "assigned_warehouse":    o.assigned_warehouse,
            "app_status":            o.app_status,
            "has_plan":              True,  # confirming requires an active plan
            "plan_box_unmatched":    False,
            "has_plan_mismatch":     False,
            "ss_duplicate":          bool(getattr(o, "ss_duplicate", False)),
            # Confirmed-demand-specific
            "confirmed_at":          r.confirmed_at,
            "mapping_used":          r.mapping_used,
            "boxes_snapshot":        r.boxes_snapshot,
            "line_items": [
                {
                    "line_item_id":         li.line_item_id,
                    "shopify_sku":          li.shopify_sku,
                    "pick_sku":             li.pick_sku,
                    "product_title":        li.product_title,
                    "quantity":             li.quantity,
                    "fulfillable_quantity": li.fulfillable_quantity,
                    "price":                li.price,
                    "total_discount":       li.total_discount,
                    "app_line_status":      li.app_line_status,
                }
                for li in lis
            ],
        })
    return out
