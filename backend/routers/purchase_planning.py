"""
Purchase Planning router — gap-driven, per-projection-period planning rows.

This is the editor surface for procurement. The user picks a projection period,
sees the gap (in lbs) for each product type from that period's current
projection, decides how much to buy from each vendor, then attaches the row to
a Purchase Order via the PO # column. Once linked, edits to the plan row mirror
to the underlying PO line — the plan row is the source of truth.

Linkage rules:
  - Each plan row may bind to at most one PO line (purchase_order_line_id).
  - Setting the link creates a new PO line on the chosen PO from the row's data.
  - Changing vendor silently deletes the old PO line and clears the link
    (the frontend prompts to pick a new PO).
  - Deleting a plan row that's bound also deletes the PO line; if that was the
    last line on the PO, the empty PO is deleted too.
  - Plan rows whose linked PO has progressed past in_transit are read-only
    from this surface (receiving records are bound to those quantities).
"""
import math
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
import models

router = APIRouter()

# Statuses past which a linked PO line is no longer editable from planning
# (receiving has started; quantities can't change without breaking receipts).
_PO_LOCKED_STATUSES = {"partially_received", "delivered", "imported", "reconciled"}
# Statuses where a PO is eligible to be linked / receive new lines from planning.
_PO_LINKABLE_STATUSES = {"draft", "placed", "in_transit"}


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


class POLinkBody(BaseModel):
    """
    One body shape for all three linking actions:
      - {"action": "link", "purchase_order_id": <id>}: attach to existing PO
      - {"action": "create"}: create a new PO for the row's vendor
      - {"action": "unlink"}: detach (and delete the underlying PO line)
    """
    action: str = Field(..., pattern="^(link|create|unlink)$")
    purchase_order_id: Optional[int] = None


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


# ── PO mirroring ───────────────────────────────────────────────────────────
# A plan row's "effective" product type (the thing we're literally buying from
# the vendor) is the substitute when set, otherwise the base.
def _po_line_product_type(plan: models.PurchasePlanLine) -> str:
    return (plan.sub_product_type or plan.product_type or "").strip()


def _quantity_cases_from_plan(plan: models.PurchasePlanLine) -> float:
    """Convert the plan row's purchase weight into a whole-case count.
    Mirrors purchase_weight_helper but returns the case count, not the weight.
    Returns 0 for "bulk lbs" rows (no case_weight set)."""
    pw = plan.purchase_weight_lbs or 0.0
    cw = plan.case_weight_lbs or 0.0
    if pw <= 0 or cw <= 0:
        return 0.0
    return float(math.ceil(pw / cw))


def _total_weight_from_plan(plan: models.PurchasePlanLine) -> Optional[float]:
    """Total weight to record on the linked PO line.

    Two pricing/order shapes:
      - Cased: case_weight_lbs is set → total = ceil(purchase / case) * case
      - Bulk:  no case_weight → total = purchase_weight_lbs directly (e.g.
        "11 lbs of apricots" with no case structure)
    Returns None when neither is available."""
    pw = plan.purchase_weight_lbs
    cw = plan.case_weight_lbs
    if cw and cw > 0 and pw and pw > 0:
        return float(math.ceil(pw / cw)) * float(cw)
    if pw and pw > 0:
        return float(pw)
    return None


def _vendor_product(db: Session, vendor_id: int, product_type: str) -> Optional[models.VendorProduct]:
    return db.query(models.VendorProduct).filter(
        models.VendorProduct.vendor_id == vendor_id,
        models.VendorProduct.product_type == product_type,
    ).first()


def _next_po_number(db: Session) -> str:
    """Same shape as routers.purchase_orders._next_po_number — duplicated to
    avoid a cross-router import that would create a cycle."""
    year = datetime.now(timezone.utc).year
    prefix = f"PO-{year}-"
    latest = db.query(models.PurchaseOrder).filter(
        models.PurchaseOrder.po_number.like(f"{prefix}%")
    ).order_by(models.PurchaseOrder.po_number.desc()).first()
    seq = int(latest.po_number.split("-")[-1]) + 1 if latest else 1
    return f"{prefix}{seq:04d}"


def _recompute_line_totals(line: models.PurchaseOrderLine) -> None:
    if line.case_weight_lbs and line.quantity_cases:
        line.total_weight_lbs = line.quantity_cases * line.case_weight_lbs
    else:
        line.total_weight_lbs = None
    if line.unit_price and line.quantity_cases:
        if line.price_unit == "lb" and line.total_weight_lbs:
            line.total_price = line.unit_price * line.total_weight_lbs
        else:
            line.total_price = line.unit_price * line.quantity_cases
    else:
        line.total_price = None


def _recompute_po_subtotal(db: Session, po_id: int) -> None:
    from sqlalchemy import func as sqlfunc
    total = db.query(sqlfunc.sum(models.PurchaseOrderLine.total_price)).filter(
        models.PurchaseOrderLine.purchase_order_id == po_id
    ).scalar()
    po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == po_id).first()
    if po:
        po.subtotal = total or 0.0


def _replace_line_allocation(db: Session, line: models.PurchaseOrderLine, period_id: int) -> None:
    """Wipe and recreate the line's single period allocation to match its
    current total_weight_lbs. The plan→PO model only has one allocation per
    line (the row's own period), so we just replace it."""
    db.query(models.PurchaseOrderPeriodAllocation).filter(
        models.PurchaseOrderPeriodAllocation.po_line_id == line.id
    ).delete()
    eff = float(line.total_weight_lbs or 0.0)
    db.add(models.PurchaseOrderPeriodAllocation(
        po_line_id=line.id,
        period_id=period_id,
        allocated_lbs=eff,
        spoilage_pct=0.0,
        effective_lbs=eff,
    ))


def _create_po_line_from_plan(
    db: Session,
    plan: models.PurchasePlanLine,
    po: models.PurchaseOrder,
) -> models.PurchaseOrderLine:
    """Materialize a PO line from a plan row's current data and bind it."""
    pt = _po_line_product_type(plan)
    vp = _vendor_product(db, po.vendor_id, pt) if pt else None
    unit_price = vp.default_price_per_case if vp else None
    price_unit = (vp.order_unit if vp else "case") or "case"
    if price_unit == "lb" and vp:
        unit_price = vp.default_price_per_lb

    line = models.PurchaseOrderLine(
        purchase_order_id=po.id,
        product_type=pt or "",
        quantity_cases=_quantity_cases_from_plan(plan),
        case_weight_lbs=plan.case_weight_lbs,
        unit_price=unit_price,
        price_unit=price_unit,
        notes=plan.notes,
    )
    _recompute_line_totals(line)
    # Bulk fallback: when there's no case structure, _recompute_line_totals
    # leaves total_weight_lbs=None — fill it from purchase_weight_lbs so the
    # PO still shows the ordered weight (e.g. "11 lbs of apricots").
    if line.total_weight_lbs is None:
        line.total_weight_lbs = _total_weight_from_plan(plan)
    db.add(line)
    db.flush()  # need line.id for allocation + plan.purchase_order_line_id
    _replace_line_allocation(db, line, plan.projection_period_id)
    plan.purchase_order_line_id = line.id
    _recompute_po_subtotal(db, po.id)
    return line


def _mirror_plan_to_line(db: Session, plan: models.PurchasePlanLine) -> None:
    """Push the plan row's editable fields onto its bound PO line. No-op if
    the row isn't linked. Caller has already committed plan-side changes."""
    if not plan.purchase_order_line_id:
        return
    line = db.query(models.PurchaseOrderLine).filter(
        models.PurchaseOrderLine.id == plan.purchase_order_line_id
    ).first()
    if not line:
        # Dangling FK (e.g. PO line deleted out from under us) — clear the
        # link so the plan row falls back to "unbound".
        plan.purchase_order_line_id = None
        return

    line.product_type = _po_line_product_type(plan) or line.product_type
    line.case_weight_lbs = plan.case_weight_lbs
    line.quantity_cases = _quantity_cases_from_plan(plan)
    if plan.notes is not None:
        line.notes = plan.notes
    _recompute_line_totals(line)
    # Bulk fallback (see _create_po_line_from_plan for rationale).
    if line.total_weight_lbs is None:
        line.total_weight_lbs = _total_weight_from_plan(plan)
    _replace_line_allocation(db, line, plan.projection_period_id)
    _recompute_po_subtotal(db, line.purchase_order_id)


def _delete_linked_po_line(db: Session, plan: models.PurchasePlanLine) -> None:
    """Detach the plan row from its PO line and delete the line. If that was
    the last line on the PO, delete the empty PO too."""
    if not plan.purchase_order_line_id:
        return
    line_id = plan.purchase_order_line_id
    line = db.query(models.PurchaseOrderLine).filter(
        models.PurchaseOrderLine.id == line_id
    ).first()
    plan.purchase_order_line_id = None
    if not line:
        return
    po_id = line.purchase_order_id
    db.query(models.PurchaseOrderPeriodAllocation).filter(
        models.PurchaseOrderPeriodAllocation.po_line_id == line.id
    ).delete()
    db.delete(line)
    db.flush()
    remaining = db.query(models.PurchaseOrderLine).filter(
        models.PurchaseOrderLine.purchase_order_id == po_id
    ).count()
    if remaining == 0:
        db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == po_id).delete()
    else:
        _recompute_po_subtotal(db, po_id)


def _po_locked_for_planning(po: Optional[models.PurchaseOrder]) -> bool:
    """True if the linked PO is past the point where planning can edit it."""
    return bool(po and po.status in _PO_LOCKED_STATUSES)


def _po_info_map(db: Session, plan_lines: list[models.PurchasePlanLine]) -> dict[int, dict]:
    """One round-trip lookup: {plan_line_id: {po_id, po_number, po_status, locked}}."""
    line_ids = [p.purchase_order_line_id for p in plan_lines if p.purchase_order_line_id]
    if not line_ids:
        return {}
    rows = (
        db.query(models.PurchasePlanLine.id, models.PurchaseOrder.id,
                 models.PurchaseOrder.po_number, models.PurchaseOrder.status)
        .join(models.PurchaseOrderLine,
              models.PurchaseOrderLine.id == models.PurchasePlanLine.purchase_order_line_id)
        .join(models.PurchaseOrder,
              models.PurchaseOrder.id == models.PurchaseOrderLine.purchase_order_id)
        .filter(models.PurchasePlanLine.id.in_([p.id for p in plan_lines]))
        .all()
    )
    return {
        plan_id: {
            "purchase_order_id": po_id,
            "purchase_order_number": po_num,
            "purchase_order_status": po_status,
            "locked_by_po": po_status in _PO_LOCKED_STATUSES,
        }
        for plan_id, po_id, po_num, po_status in rows
    }


def _serialize_line(
    line: models.PurchasePlanLine,
    metrics: dict[str, dict],
    purchases_by_combo: dict[tuple[str, str], float],
    po_info: Optional[dict] = None,
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
        # Linked PO info (null when this row hasn't been attached to a PO yet).
        "purchase_order_line_id": line.purchase_order_line_id,
        "purchase_order_id": (po_info or {}).get("purchase_order_id"),
        "purchase_order_number": (po_info or {}).get("purchase_order_number"),
        "purchase_order_status": (po_info or {}).get("purchase_order_status"),
        "locked_by_po": (po_info or {}).get("locked_by_po", False),
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
    po_info = _po_info_map(db, lines)

    return {
        "projection_period_id": projection_period_id,
        "has_current_projection": bool(metrics),
        "items": [_serialize_line(l, metrics, purchases, po_info.get(l.id)) for l in lines],
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

    # Lock check: if the row is bound to a PO that's past in_transit, refuse
    # any field edits (receiving has already happened against those quantities).
    if line.purchase_order_line_id:
        existing_line = db.query(models.PurchaseOrderLine).filter(
            models.PurchaseOrderLine.id == line.purchase_order_line_id
        ).first()
        existing_po = (
            db.query(models.PurchaseOrder)
            .filter(models.PurchaseOrder.id == existing_line.purchase_order_id).first()
            if existing_line else None
        )
        if _po_locked_for_planning(existing_po):
            raise HTTPException(
                400,
                f"Plan row is bound to PO {existing_po.po_number} ({existing_po.status}); "
                f"edits are no longer allowed from planning."
            )

    payload = body.model_dump(exclude_unset=True)
    vendor_changed = "vendor_id" in payload and payload["vendor_id"] != line.vendor_id

    for k, v in payload.items():
        # Treat empty-string string fields as "clear it"
        if k in ("sub_product_type", "shipping_status") and v == "":
            v = None
        setattr(line, k, v)

    # Vendor change: silently delete the old PO line and clear the link. The
    # frontend prompts the user to pick / create a new PO afterwards.
    if vendor_changed and line.purchase_order_line_id:
        _delete_linked_po_line(db, line)
    else:
        # Other field changes: mirror onto the bound PO line if any.
        _mirror_plan_to_line(db, line)

    db.commit()
    db.refresh(line)

    metrics = _projection_metrics_for_period(db, line.projection_period_id)
    period_lines = db.query(models.PurchasePlanLine).filter_by(
        projection_period_id=line.projection_period_id
    ).all()
    purchases = _purchases_by_combo(period_lines)
    po_info = _po_info_map(db, [line]).get(line.id)
    return _serialize_line(line, metrics, purchases, po_info)


@router.delete("/{line_id}")
def delete_plan_line(line_id: int, db: Session = Depends(get_db)):
    line = db.query(models.PurchasePlanLine).filter_by(id=line_id).first()
    if not line:
        raise HTTPException(404, "Plan line not found")
    _delete_linked_po_line(db, line)
    db.delete(line)
    db.commit()
    return {"detail": "deleted"}


@router.post("/bulk-delete")
def bulk_delete_plan_lines(body: BulkDeleteBody, db: Session = Depends(get_db)):
    """Delete many plan lines in one round trip. Silently skips ids that don't exist.
    Also deletes any linked PO lines (and parent POs that become empty)."""
    rows = db.query(models.PurchasePlanLine).filter(
        models.PurchasePlanLine.id.in_(body.ids)
    ).all()
    for row in rows:
        _delete_linked_po_line(db, row)
        db.delete(row)
    db.commit()
    return {"deleted": len(rows)}


# ── PO linkage ──────────────────────────────────────────────────────────────

@router.put("/{line_id}/po")
def set_plan_line_po(line_id: int, body: POLinkBody, db: Session = Depends(get_db)):
    """
    Attach this plan row to a Purchase Order. Three actions:
      - link: bind to an existing PO (must match the row's vendor and be in a
        linkable status). Replaces any prior link.
      - create: create a fresh draft PO for the row's vendor and bind to it.
      - unlink: detach (deletes the underlying PO line; deletes the parent PO
        if it becomes empty).
    Returns the updated serialized plan line.
    """
    plan = db.query(models.PurchasePlanLine).filter_by(id=line_id).first()
    if not plan:
        raise HTTPException(404, "Plan line not found")

    if body.action == "unlink":
        _delete_linked_po_line(db, plan)
        db.commit()
        db.refresh(plan)
        return _return_plan_row(db, plan)

    # link / create both require a vendor on the row
    if not plan.vendor_id:
        raise HTTPException(400, "Set a vendor on this row before attaching a PO")

    # Both also require a product to materialize as a line
    if not _po_line_product_type(plan):
        raise HTTPException(400, "Set a product type on this row before attaching a PO")

    # Drop any prior link before re-binding (so we never have two PO lines
    # pointing at the same plan row).
    if plan.purchase_order_line_id:
        _delete_linked_po_line(db, plan)

    if body.action == "create":
        po = models.PurchaseOrder(
            po_number=_next_po_number(db),
            vendor_id=plan.vendor_id,
            status="draft",
            order_date=date.today(),
            notes="Created from purchase planning",
        )
        db.add(po)
        db.flush()
    else:  # link
        if not body.purchase_order_id:
            raise HTTPException(400, "purchase_order_id is required for action=link")
        po = db.query(models.PurchaseOrder).filter_by(id=body.purchase_order_id).first()
        if not po:
            raise HTTPException(404, "Purchase order not found")
        if po.vendor_id != plan.vendor_id:
            raise HTTPException(
                400,
                "PO vendor does not match the plan row's vendor — pick a PO for the same vendor or create a new one."
            )
        if po.status not in _PO_LINKABLE_STATUSES:
            raise HTTPException(
                400,
                f"PO {po.po_number} is in '{po.status}' — only {sorted(_PO_LINKABLE_STATUSES)} accept new lines."
            )

    _create_po_line_from_plan(db, plan, po)
    db.commit()
    db.refresh(plan)
    return _return_plan_row(db, plan)


def _return_plan_row(db: Session, plan: models.PurchasePlanLine) -> dict:
    metrics = _projection_metrics_for_period(db, plan.projection_period_id)
    period_lines = db.query(models.PurchasePlanLine).filter_by(
        projection_period_id=plan.projection_period_id
    ).all()
    purchases = _purchases_by_combo(period_lines)
    info = _po_info_map(db, [plan]).get(plan.id)
    return _serialize_line(plan, metrics, purchases, info)


@router.get("/eligible-pos")
def list_eligible_pos(
    vendor_id: int = Query(..., description="Filter to POs for this vendor"),
    db: Session = Depends(get_db),
):
    """POs that a planning row with this vendor can be attached to: same
    vendor + status in {draft, placed, in_transit}. Used by the PO # column
    dropdown on the planning grid."""
    pos = (
        db.query(models.PurchaseOrder)
        .filter(models.PurchaseOrder.vendor_id == vendor_id)
        .filter(models.PurchaseOrder.status.in_(list(_PO_LINKABLE_STATUSES)))
        .order_by(models.PurchaseOrder.created_at.desc())
        .all()
    )
    return [
        {
            "id": p.id,
            "po_number": p.po_number,
            "status": p.status,
            "order_date": p.order_date.isoformat() if p.order_date else None,
            "expected_delivery_date": p.expected_delivery_date.isoformat() if p.expected_delivery_date else None,
            "subtotal": p.subtotal,
        }
        for p in pos
    ]


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
