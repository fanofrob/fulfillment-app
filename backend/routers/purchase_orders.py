"""
Purchase Orders router — CRUD, lifecycle management, and projection integration.
"""
import math
from datetime import date, datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func as sqlfunc

from database import get_db
import models
import schemas

router = APIRouter()

PO_STATUSES = ["draft", "placed", "in_transit", "partially_received", "delivered", "imported", "reconciled"]
PO_STATUS_TRANSITIONS = {
    "draft": ["placed", "in_transit"],
    "placed": ["in_transit", "partially_received", "delivered"],
    "in_transit": ["partially_received", "delivered"],
    "partially_received": ["delivered"],
    "delivered": ["imported"],
    "imported": ["reconciled"],
    "reconciled": [],
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _next_po_number(db: Session) -> str:
    """Generate next PO number like PO-2026-0001."""
    year = datetime.now(timezone.utc).year
    prefix = f"PO-{year}-"
    latest = db.query(models.PurchaseOrder).filter(
        models.PurchaseOrder.po_number.like(f"{prefix}%")
    ).order_by(models.PurchaseOrder.po_number.desc()).first()
    if latest:
        seq = int(latest.po_number.split("-")[-1]) + 1
    else:
        seq = 1
    return f"{prefix}{seq:04d}"


def _compute_line_totals(line: models.PurchaseOrderLine):
    """Recompute total_weight_lbs and total_price for a PO line."""
    if line.case_weight_lbs and line.quantity_cases:
        line.total_weight_lbs = line.quantity_cases * line.case_weight_lbs
    if line.unit_price and line.quantity_cases:
        if line.price_unit == "lb" and line.total_weight_lbs:
            line.total_price = line.unit_price * line.total_weight_lbs
        else:
            line.total_price = line.unit_price * line.quantity_cases


def _compute_po_subtotal(db: Session, po_id: int):
    """Recompute PO subtotal from line totals."""
    result = db.query(sqlfunc.sum(models.PurchaseOrderLine.total_price)).filter(
        models.PurchaseOrderLine.purchase_order_id == po_id
    ).scalar()
    po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == po_id).first()
    if po:
        po.subtotal = result or 0.0


def _build_po_response(db: Session, po: models.PurchaseOrder) -> schemas.PurchaseOrderResponse:
    """Build a full PO response with lines, allocations, and vendor name."""
    vendor = db.query(models.Vendor).filter(models.Vendor.id == po.vendor_id).first()
    lines_db = db.query(models.PurchaseOrderLine).filter(
        models.PurchaseOrderLine.purchase_order_id == po.id
    ).all()

    lines_resp = []
    for line in lines_db:
        allocations = db.query(models.PurchaseOrderPeriodAllocation).filter(
            models.PurchaseOrderPeriodAllocation.po_line_id == line.id
        ).all()
        lr = schemas.POLineResponse.model_validate(line)
        lr.allocations = [schemas.POPeriodAllocationResponse.model_validate(a) for a in allocations]
        # Overage flag: check if total_weight_lbs > 1.1 × sum of allocated effective_lbs
        total_effective = sum(a.effective_lbs for a in allocations) if allocations else 0
        if total_effective > 0 and line.total_weight_lbs:
            lr.overage_flag = line.total_weight_lbs > total_effective * 1.1
        lines_resp.append(lr)

    resp = schemas.PurchaseOrderResponse.model_validate(po)
    resp.lines = lines_resp
    resp.vendor_name = vendor.name if vendor else None
    return resp


# ── PO CRUD ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[schemas.PurchaseOrderResponse])
def list_purchase_orders(
    status: Optional[str] = Query(None),
    vendor_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(models.PurchaseOrder)
    if status:
        q = q.filter(models.PurchaseOrder.status == status)
    if vendor_id:
        q = q.filter(models.PurchaseOrder.vendor_id == vendor_id)
    pos = q.order_by(models.PurchaseOrder.created_at.desc()).all()
    return [_build_po_response(db, po) for po in pos]


@router.get("/{po_id}", response_model=schemas.PurchaseOrderResponse)
def get_purchase_order(po_id: int, db: Session = Depends(get_db)):
    po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    return _build_po_response(db, po)


@router.post("/", response_model=schemas.PurchaseOrderResponse, status_code=201)
def create_purchase_order(data: schemas.PurchaseOrderCreate, db: Session = Depends(get_db)):
    # Validate vendor exists
    vendor = db.query(models.Vendor).filter(models.Vendor.id == data.vendor_id).first()
    if not vendor:
        raise HTTPException(404, "Vendor not found")

    po = models.PurchaseOrder(
        po_number=_next_po_number(db),
        vendor_id=data.vendor_id,
        status=data.status,
        order_date=data.order_date or date.today(),
        expected_delivery_date=data.expected_delivery_date,
        actual_delivery_date=data.actual_delivery_date,
        delivery_notes=data.delivery_notes,
        communication_method=data.communication_method,
        notes=data.notes,
    )
    db.add(po)
    db.flush()

    for line_data in data.lines:
        line = models.PurchaseOrderLine(
            purchase_order_id=po.id,
            product_type=line_data.product_type,
            quantity_cases=line_data.quantity_cases,
            case_weight_lbs=line_data.case_weight_lbs,
            unit_price=line_data.unit_price,
            price_unit=line_data.price_unit or "case",
            notes=line_data.notes,
        )
        _compute_line_totals(line)
        db.add(line)
        db.flush()

        if line_data.allocations:
            for alloc_data in line_data.allocations:
                # Validate period exists
                period = db.query(models.ProjectionPeriod).filter(
                    models.ProjectionPeriod.id == alloc_data.period_id
                ).first()
                if not period:
                    raise HTTPException(404, f"Period {alloc_data.period_id} not found")
                effective = alloc_data.allocated_lbs * (1 - alloc_data.spoilage_pct)
                alloc = models.PurchaseOrderPeriodAllocation(
                    po_line_id=line.id,
                    period_id=alloc_data.period_id,
                    allocated_lbs=alloc_data.allocated_lbs,
                    spoilage_pct=alloc_data.spoilage_pct,
                    effective_lbs=effective,
                )
                db.add(alloc)

    _compute_po_subtotal(db, po.id)
    db.commit()
    db.refresh(po)
    return _build_po_response(db, po)


@router.put("/{po_id}", response_model=schemas.PurchaseOrderResponse)
def update_purchase_order(po_id: int, data: schemas.PurchaseOrderUpdate, db: Session = Depends(get_db)):
    po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(404, "Purchase order not found")

    update_data = data.model_dump(exclude_unset=True)

    # Validate status transitions
    if "status" in update_data and update_data["status"] != po.status:
        new_status = update_data["status"]
        if new_status not in PO_STATUS_TRANSITIONS.get(po.status, []):
            raise HTTPException(
                400,
                f"Cannot transition from '{po.status}' to '{new_status}'. "
                f"Allowed: {PO_STATUS_TRANSITIONS.get(po.status, [])}"
            )

    for field, value in update_data.items():
        setattr(po, field, value)
    db.commit()
    db.refresh(po)
    return _build_po_response(db, po)


@router.delete("/{po_id}")
def delete_purchase_order(po_id: int, db: Session = Depends(get_db)):
    po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if po.status != "draft":
        raise HTTPException(400, "Only draft POs can be deleted")
    # Delete allocations, lines, then PO
    lines = db.query(models.PurchaseOrderLine).filter(
        models.PurchaseOrderLine.purchase_order_id == po_id
    ).all()
    for line in lines:
        db.query(models.PurchaseOrderPeriodAllocation).filter(
            models.PurchaseOrderPeriodAllocation.po_line_id == line.id
        ).delete()
    db.query(models.PurchaseOrderLine).filter(
        models.PurchaseOrderLine.purchase_order_id == po_id
    ).delete()
    db.delete(po)
    db.commit()
    return {"ok": True}


# ── PO Line Management ─────────────────────────────────────────────────────

@router.post("/{po_id}/lines", response_model=schemas.POLineResponse, status_code=201)
def add_po_line(po_id: int, data: schemas.POLineCreate, db: Session = Depends(get_db)):
    po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(404, "Purchase order not found")

    line = models.PurchaseOrderLine(
        purchase_order_id=po_id,
        product_type=data.product_type,
        quantity_cases=data.quantity_cases,
        case_weight_lbs=data.case_weight_lbs,
        unit_price=data.unit_price,
        price_unit=data.price_unit or "case",
        notes=data.notes,
    )
    _compute_line_totals(line)
    db.add(line)
    db.flush()

    allocations = []
    if data.allocations:
        for alloc_data in data.allocations:
            effective = alloc_data.allocated_lbs * (1 - alloc_data.spoilage_pct)
            alloc = models.PurchaseOrderPeriodAllocation(
                po_line_id=line.id,
                period_id=alloc_data.period_id,
                allocated_lbs=alloc_data.allocated_lbs,
                spoilage_pct=alloc_data.spoilage_pct,
                effective_lbs=effective,
            )
            db.add(alloc)
            allocations.append(alloc)

    _compute_po_subtotal(db, po_id)
    db.commit()
    db.refresh(line)
    for a in allocations:
        db.refresh(a)

    resp = schemas.POLineResponse.model_validate(line)
    resp.allocations = [schemas.POPeriodAllocationResponse.model_validate(a) for a in allocations]
    return resp


@router.put("/{po_id}/lines/{line_id}", response_model=schemas.POLineResponse)
def update_po_line(po_id: int, line_id: int, data: schemas.POLineUpdate, db: Session = Depends(get_db)):
    line = db.query(models.PurchaseOrderLine).filter(
        models.PurchaseOrderLine.id == line_id,
        models.PurchaseOrderLine.purchase_order_id == po_id,
    ).first()
    if not line:
        raise HTTPException(404, "PO line not found")

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(line, field, value)
    _compute_line_totals(line)
    _compute_po_subtotal(db, po_id)
    db.commit()
    db.refresh(line)

    allocations = db.query(models.PurchaseOrderPeriodAllocation).filter(
        models.PurchaseOrderPeriodAllocation.po_line_id == line.id
    ).all()
    resp = schemas.POLineResponse.model_validate(line)
    resp.allocations = [schemas.POPeriodAllocationResponse.model_validate(a) for a in allocations]
    return resp


@router.delete("/{po_id}/lines/{line_id}")
def delete_po_line(po_id: int, line_id: int, db: Session = Depends(get_db)):
    line = db.query(models.PurchaseOrderLine).filter(
        models.PurchaseOrderLine.id == line_id,
        models.PurchaseOrderLine.purchase_order_id == po_id,
    ).first()
    if not line:
        raise HTTPException(404, "PO line not found")
    db.query(models.PurchaseOrderPeriodAllocation).filter(
        models.PurchaseOrderPeriodAllocation.po_line_id == line.id
    ).delete()
    db.delete(line)
    _compute_po_subtotal(db, po_id)
    db.commit()
    return {"ok": True}


# ── Period Allocations ──────────────────────────────────────────────────────

@router.put("/{po_id}/lines/{line_id}/allocations", response_model=List[schemas.POPeriodAllocationResponse])
def set_line_allocations(
    po_id: int,
    line_id: int,
    allocations: List[schemas.POPeriodAllocationCreate],
    db: Session = Depends(get_db),
):
    """Replace all allocations for a PO line."""
    line = db.query(models.PurchaseOrderLine).filter(
        models.PurchaseOrderLine.id == line_id,
        models.PurchaseOrderLine.purchase_order_id == po_id,
    ).first()
    if not line:
        raise HTTPException(404, "PO line not found")

    # Clear existing
    db.query(models.PurchaseOrderPeriodAllocation).filter(
        models.PurchaseOrderPeriodAllocation.po_line_id == line_id
    ).delete()

    results = []
    for alloc_data in allocations:
        period = db.query(models.ProjectionPeriod).filter(
            models.ProjectionPeriod.id == alloc_data.period_id
        ).first()
        if not period:
            raise HTTPException(404, f"Period {alloc_data.period_id} not found")
        effective = alloc_data.allocated_lbs * (1 - alloc_data.spoilage_pct)
        alloc = models.PurchaseOrderPeriodAllocation(
            po_line_id=line_id,
            period_id=alloc_data.period_id,
            allocated_lbs=alloc_data.allocated_lbs,
            spoilage_pct=alloc_data.spoilage_pct,
            effective_lbs=effective,
        )
        db.add(alloc)
        results.append(alloc)

    db.commit()
    for a in results:
        db.refresh(a)
    return [schemas.POPeriodAllocationResponse.model_validate(a) for a in results]


# ── Create PO from Projection Gap ──────────────────────────────────────────

@router.post("/from-projection", response_model=schemas.PurchaseOrderResponse, status_code=201)
def create_po_from_projection(data: schemas.POFromProjectionRequest, db: Session = Depends(get_db)):
    """
    Create a PO pre-filled from projection gap data.
    Looks up the latest projection for the period, finds gap data for requested product types,
    and creates PO lines with suggested quantities.
    """
    # Get the projection
    projection = db.query(models.Projection).filter(
        models.Projection.id == data.projection_id,
        models.Projection.period_id == data.period_id,
    ).first()
    if not projection:
        raise HTTPException(404, "Projection not found for this period")

    # Get projection lines for requested product types
    proj_lines = db.query(models.ProjectionLine).filter(
        models.ProjectionLine.projection_id == projection.id,
        models.ProjectionLine.product_type.in_(data.product_types),
    ).all()
    if not proj_lines:
        raise HTTPException(404, "No projection lines found for requested product types")

    # Determine vendor
    vendor_id = data.vendor_id
    if not vendor_id:
        # Try to find preferred vendor for first product type
        first_pt = data.product_types[0]
        vp = db.query(models.VendorProduct).filter(
            models.VendorProduct.product_type == first_pt,
            models.VendorProduct.is_preferred == True,
        ).first()
        if vp:
            vendor_id = vp.vendor_id
    if not vendor_id:
        raise HTTPException(400, "No vendor specified and no preferred vendor found")

    vendor = db.query(models.Vendor).filter(models.Vendor.id == vendor_id).first()
    if not vendor:
        raise HTTPException(404, "Vendor not found")

    # Create PO
    po = models.PurchaseOrder(
        po_number=_next_po_number(db),
        vendor_id=vendor_id,
        status="draft",
        order_date=date.today(),
        notes=f"Auto-created from projection #{projection.id} for period #{data.period_id}",
    )
    db.add(po)
    db.flush()

    for pl in proj_lines:
        if pl.gap_lbs <= 0:
            continue  # no gap, skip

        # Look up vendor defaults for this product type
        vp = db.query(models.VendorProduct).filter(
            models.VendorProduct.vendor_id == vendor_id,
            models.VendorProduct.product_type == pl.product_type,
        ).first()

        case_weight = pl.case_weight_lbs or (vp.default_case_weight_lbs if vp else None) or 1.0
        quantity_cases = math.ceil(pl.gap_lbs / case_weight)
        unit_price = (vp.default_price_per_case if vp else None)
        price_unit = (vp.order_unit if vp else "case") or "case"
        if price_unit == "lb" and vp:
            unit_price = vp.default_price_per_lb

        line = models.PurchaseOrderLine(
            purchase_order_id=po.id,
            product_type=pl.product_type,
            quantity_cases=quantity_cases,
            case_weight_lbs=case_weight,
            unit_price=unit_price,
            price_unit=price_unit,
            notes=f"Gap: {pl.gap_lbs:.1f} lbs ({pl.gap_status})",
        )
        _compute_line_totals(line)
        db.add(line)
        db.flush()

        # Allocate entirely to the requesting period
        effective = line.total_weight_lbs or (quantity_cases * case_weight)
        alloc = models.PurchaseOrderPeriodAllocation(
            po_line_id=line.id,
            period_id=data.period_id,
            allocated_lbs=effective,
            spoilage_pct=0.0,
            effective_lbs=effective,
        )
        db.add(alloc)

    _compute_po_subtotal(db, po.id)
    db.commit()
    db.refresh(po)
    return _build_po_response(db, po)


# ── On-Order Summary (for projection integration) ──────────────────────────

@router.get("/on-order/{period_id}")
def get_on_order_for_period(period_id: int, db: Session = Depends(get_db)):
    """
    Get total on-order lbs per product type for a given period.
    Only counts POs with status in (draft, placed, in_transit) — not yet received.
    Returns dict: { product_type: effective_lbs }
    """
    # Get all allocations for this period where PO is not yet delivered
    active_statuses = ["draft", "placed", "in_transit"]
    results = db.query(
        models.PurchaseOrderLine.product_type,
        sqlfunc.sum(models.PurchaseOrderPeriodAllocation.effective_lbs),
    ).join(
        models.PurchaseOrderPeriodAllocation,
        models.PurchaseOrderPeriodAllocation.po_line_id == models.PurchaseOrderLine.id,
    ).join(
        models.PurchaseOrder,
        models.PurchaseOrder.id == models.PurchaseOrderLine.purchase_order_id,
    ).filter(
        models.PurchaseOrderPeriodAllocation.period_id == period_id,
        models.PurchaseOrder.status.in_(active_statuses),
    ).group_by(
        models.PurchaseOrderLine.product_type,
    ).all()

    return {product_type: effective_lbs or 0.0 for product_type, effective_lbs in results}
