"""
Projection Confirmed Orders router — the review/override layer for confirmed
demand under Projections. Mounted at /api/projection-periods/{period_id}/...
alongside projection_periods.py but kept as a separate module because the
surface area is distinct (box snapshots, save/revert, staged-order guard).
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from services import projection_confirmed_orders_service as svc

router = APIRouter()


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
