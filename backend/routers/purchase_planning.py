"""
Purchase Planning router — gap-driven, per-projection-period planning rows.

This is a working surface where the user picks a projection period, sees the
gap (in lbs) for each product type from that period's current projection, and
decides how much to buy from each vendor. Multiple rows per (period,
product_type) are allowed so a single gap can be split across vendors.

Distinct from the formal Purchase Order system (routers/purchase_orders.py),
which tracks PO lifecycle (draft → placed → received → reconciled) with line
items, prices, and receiving records.
"""
import math
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
import models

router = APIRouter()


# ── Schemas ─────────────────────────────────────────────────────────────────

class PurchasePlanLineCreate(BaseModel):
    projection_period_id: int
    vendor_id: Optional[int] = None
    product_type: str = Field(..., min_length=1)
    sub_product_type: Optional[str] = None
    purchase_weight_lbs: Optional[float] = None
    case_weight_lbs: Optional[float] = None
    quantity: Optional[float] = None
    shipping_status: Optional[str] = None
    notes: Optional[str] = None


class PurchasePlanLineUpdate(BaseModel):
    vendor_id: Optional[int] = None
    product_type: Optional[str] = Field(None, min_length=1)
    # Empty string clears the substitution. None means "no change".
    sub_product_type: Optional[str] = None
    purchase_weight_lbs: Optional[float] = None
    case_weight_lbs: Optional[float] = None
    quantity: Optional[float] = None
    # Empty string clears, None means "no change".
    shipping_status: Optional[str] = None
    notes: Optional[str] = None


class BulkDeleteBody(BaseModel):
    ids: list[int] = Field(..., min_length=1)


# ── Helpers ─────────────────────────────────────────────────────────────────

def _purchase_weight_helper(purchase_weight: Optional[float], case_weight: Optional[float]) -> Optional[float]:
    """Round up purchase_weight to the nearest whole-case multiple.
    e.g. purchase_weight=101, case_weight=10 → 110.
    Returns None if either input is missing or case_weight ≤ 0."""
    if purchase_weight is None or case_weight is None or case_weight <= 0:
        return None
    if purchase_weight <= 0:
        return 0.0
    return math.ceil(purchase_weight / case_weight) * case_weight


def _current_projection_for_period(db: Session, period_id: int) -> Optional[models.Projection]:
    """The most recently generated 'current' projection for a period, if any."""
    return (
        db.query(models.Projection)
        .filter(models.Projection.period_id == period_id)
        .filter(models.Projection.status == "current")
        .order_by(models.Projection.generated_at.desc())
        .first()
    )


def _projection_metrics_for_period(db: Session, period_id: int) -> dict[str, dict]:
    """{product_type: {gap_lbs, on_hand_lbs}} from the current projection for this period."""
    proj = _current_projection_for_period(db, period_id)
    if not proj:
        return {}
    lines = db.query(models.ProjectionLine).filter(
        models.ProjectionLine.projection_id == proj.id
    ).all()
    return {
        l.product_type: {
            "gap_lbs": float(l.gap_lbs or 0),
            "on_hand_lbs": float(l.on_hand_lbs or 0),
        }
        for l in lines
    }


def _purchases_by_combo(
    lines: list[models.PurchasePlanLine],
) -> dict[tuple[str, str], float]:
    """
    Sum purchase_weight_lbs across all lines sharing the same
    (product_type, sub_product_type) combo. Empty/None sub_product_type
    is treated as "" so rows with no substitution aggregate together.
    """
    out: dict[tuple[str, str], float] = {}
    for l in lines:
        if not l.purchase_weight_lbs:
            continue
        key = (l.product_type, l.sub_product_type or "")
        out[key] = out.get(key, 0.0) + float(l.purchase_weight_lbs)
    return out


def _serialize_line(
    line: models.PurchasePlanLine,
    metrics: dict[str, dict],
    purchases_by_combo: dict[tuple[str, str], float],
) -> dict:
    pwh = _purchase_weight_helper(line.purchase_weight_lbs, line.case_weight_lbs)

    base = metrics.get(line.product_type)
    base_gap = base["gap_lbs"] if base else None
    inventory_lbs = base["on_hand_lbs"] if base else None

    sub_pt = line.sub_product_type or None
    sub = metrics.get(sub_pt) if sub_pt else None
    sub_inventory_lbs = sub["on_hand_lbs"] if sub else None

    # Gap shown on this row: original gap minus the sub product type's on-hand
    # (which can substitute for the base). Sub inventory only counts when a
    # sub_product_type is set on this row.
    if base_gap is None:
        gap_lbs: Optional[float] = None
    else:
        gap_lbs = base_gap - (sub_inventory_lbs or 0.0)

    purchased_for_combo = purchases_by_combo.get(
        (line.product_type, line.sub_product_type or ""), 0.0
    )
    net = None if gap_lbs is None else (gap_lbs - purchased_for_combo)

    return {
        "id": line.id,
        "projection_period_id": line.projection_period_id,
        "vendor_id": line.vendor_id,
        "product_type": line.product_type,
        "sub_product_type": line.sub_product_type,
        "purchase_weight_lbs": line.purchase_weight_lbs,
        "case_weight_lbs": line.case_weight_lbs,
        "quantity": line.quantity,
        "shipping_status": line.shipping_status,
        "notes": line.notes,
        "inventory_lbs": inventory_lbs,
        "sub_inventory_lbs": sub_inventory_lbs,
        "gap_lbs": gap_lbs,
        "purchase_weight_helper_lbs": pwh,
        "purchased_combo_total_lbs": purchased_for_combo,
        "net_after_purchase_lbs": net,
        "created_at": line.created_at.isoformat() if line.created_at else None,
        "updated_at": line.updated_at.isoformat() if line.updated_at else None,
    }


# ── CRUD ────────────────────────────────────────────────────────────────────

@router.get("/")
def list_plan_lines(
    projection_period_id: int = Query(..., description="Required — scopes the listing to one period"),
    db: Session = Depends(get_db),
):
    """List all plan lines for a period, with computed gap and net-after-purchase."""
    lines = (
        db.query(models.PurchasePlanLine)
        .filter(models.PurchasePlanLine.projection_period_id == projection_period_id)
        .order_by(models.PurchasePlanLine.id)
        .all()
    )
    metrics = _projection_metrics_for_period(db, projection_period_id)
    purchases = _purchases_by_combo(lines)

    return {
        "projection_period_id": projection_period_id,
        "has_current_projection": bool(metrics),
        "items": [_serialize_line(l, metrics, purchases) for l in lines],
        "available_product_types": sorted(metrics.keys()),
    }


@router.post("/")
def create_plan_line(body: PurchasePlanLineCreate, db: Session = Depends(get_db)):
    period = db.query(models.ProjectionPeriod).filter_by(id=body.projection_period_id).first()
    if not period:
        raise HTTPException(404, "Projection period not found")
    if body.vendor_id is not None:
        vendor = db.query(models.Vendor).filter_by(id=body.vendor_id).first()
        if not vendor:
            raise HTTPException(404, "Vendor not found")

    metrics_for_default = _projection_metrics_for_period(db, body.projection_period_id)
    purchase_weight_lbs = body.purchase_weight_lbs
    if purchase_weight_lbs is None:
        gap = metrics_for_default.get(body.product_type, {}).get("gap_lbs")
        if gap is not None and gap > 0:
            purchase_weight_lbs = gap

    line = models.PurchasePlanLine(
        projection_period_id=body.projection_period_id,
        vendor_id=body.vendor_id,
        product_type=body.product_type,
        sub_product_type=(body.sub_product_type or None),
        purchase_weight_lbs=purchase_weight_lbs,
        case_weight_lbs=body.case_weight_lbs,
        quantity=body.quantity,
        shipping_status=(body.shipping_status or None),
        notes=body.notes,
    )
    db.add(line)
    db.commit()
    db.refresh(line)

    period_lines = db.query(models.PurchasePlanLine).filter_by(
        projection_period_id=body.projection_period_id
    ).all()
    purchases = _purchases_by_combo(period_lines)
    return _serialize_line(line, metrics_for_default, purchases)


@router.put("/{line_id}")
def update_plan_line(line_id: int, body: PurchasePlanLineUpdate, db: Session = Depends(get_db)):
    line = db.query(models.PurchasePlanLine).filter_by(id=line_id).first()
    if not line:
        raise HTTPException(404, "Plan line not found")
    if body.vendor_id is not None:
        vendor = db.query(models.Vendor).filter_by(id=body.vendor_id).first()
        if not vendor:
            raise HTTPException(404, "Vendor not found")

    for k, v in body.model_dump(exclude_unset=True).items():
        # Treat empty-string string fields as "clear it"
        if k in ("sub_product_type", "shipping_status") and v == "":
            v = None
        setattr(line, k, v)
    db.commit()
    db.refresh(line)

    metrics = _projection_metrics_for_period(db, line.projection_period_id)
    period_lines = db.query(models.PurchasePlanLine).filter_by(
        projection_period_id=line.projection_period_id
    ).all()
    purchases = _purchases_by_combo(period_lines)
    return _serialize_line(line, metrics, purchases)


@router.delete("/{line_id}")
def delete_plan_line(line_id: int, db: Session = Depends(get_db)):
    line = db.query(models.PurchasePlanLine).filter_by(id=line_id).first()
    if not line:
        raise HTTPException(404, "Plan line not found")
    db.delete(line)
    db.commit()
    return {"detail": "deleted"}


@router.post("/bulk-delete")
def bulk_delete_plan_lines(body: BulkDeleteBody, db: Session = Depends(get_db)):
    """Delete many plan lines in one round trip. Silently skips ids that don't exist."""
    deleted = (
        db.query(models.PurchasePlanLine)
        .filter(models.PurchasePlanLine.id.in_(body.ids))
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": deleted}


@router.post("/seed")
def seed_from_projection(
    projection_period_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """
    Create one plan line per product type from the period's current projection,
    regardless of gap sign. Skips product types that already have at least one
    plan line in this period (so re-running is safe and won't duplicate).
    Rows with non-positive gap seed with purchase_weight_lbs=None so the user
    can decide whether to actually order anything.
    """
    period = db.query(models.ProjectionPeriod).filter_by(id=projection_period_id).first()
    if not period:
        raise HTTPException(404, "Projection period not found")
    proj = _current_projection_for_period(db, projection_period_id)
    if not proj:
        raise HTTPException(400, "No current projection for this period — generate one first")

    existing_pts = {
        row.product_type
        for row in db.query(models.PurchasePlanLine.product_type)
        .filter(models.PurchasePlanLine.projection_period_id == projection_period_id)
        .distinct()
        .all()
    }

    proj_lines = db.query(models.ProjectionLine).filter(
        models.ProjectionLine.projection_id == proj.id
    ).all()

    created = 0
    skipped = 0
    for pl in proj_lines:
        if pl.product_type in existing_pts:
            skipped += 1
            continue
        gap = pl.gap_lbs or 0
        db.add(models.PurchasePlanLine(
            projection_period_id=projection_period_id,
            product_type=pl.product_type,
            case_weight_lbs=pl.case_weight_lbs,
            purchase_weight_lbs=gap if gap > 0 else None,
        ))
        created += 1
    db.commit()
    return {"created": created, "skipped_existing": skipped}
