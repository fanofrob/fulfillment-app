"""
Pickup Runs router — driver manifest grouping POs by pickup location for a given date.

A "pickup run" is a logical grouping for the day's pickups: every PO scheduled
to be picked up on `date`, bucketed by the effective pickup address so the
driver can plan a route and the operator can see what's expected.

POs are eligible when status ∈ {placed, in_transit, partially_received} AND
either pickup_run_date matches the requested date, or pickup_run_date is null
and expected_delivery_date matches as a fallback.
"""
from datetime import date as date_cls
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database import get_db
import models

router = APIRouter()

ELIGIBLE_STATUSES = ["placed", "in_transit", "partially_received"]


class PickupLine(BaseModel):
    product_type: str
    quantity_cases: float
    case_weight_lbs: Optional[float] = None
    total_weight_lbs: Optional[float] = None
    notes: Optional[str] = None


class PickupPO(BaseModel):
    id: int
    po_number: str
    status: str
    seller_vendor_id: int
    seller_vendor_name: Optional[str] = None
    seller_contact_name: Optional[str] = None
    seller_contact_phone: Optional[str] = None
    seller_contact_whatsapp: Optional[str] = None
    pickup_at_vendor_id: Optional[int] = None
    pickup_at_vendor_name: Optional[str] = None
    pickup_at_vendor_phone: Optional[str] = None
    expected_delivery_date: Optional[date_cls] = None
    pickup_run_date: Optional[date_cls] = None
    driver_name: Optional[str] = None
    delivery_location: Optional[str] = None
    delivery_notes: Optional[str] = None
    notes: Optional[str] = None
    lines: List[PickupLine] = []
    line_count: int = 0
    total_cases: float = 0.0
    total_weight_lbs: float = 0.0


class PickupGroup(BaseModel):
    """Bucket of POs sharing the same effective pickup address."""
    address: Optional[str] = None      # the address the driver actually goes to
    consolidator_vendor_id: Optional[int] = None    # set if pickups are consolidated at a known vendor
    consolidator_vendor_name: Optional[str] = None
    pos: List[PickupPO] = []
    po_count: int = 0
    total_cases: float = 0.0
    total_weight_lbs: float = 0.0


class PickupRunResponse(BaseModel):
    date: date_cls
    groups: List[PickupGroup] = []
    unscheduled_count: int = 0   # POs in eligible statuses without a pickup date set


def _resolve_pickup_address(po: models.PurchaseOrder, vendor: Optional[models.Vendor], consolidator: Optional[models.Vendor]) -> Optional[str]:
    if po.pickup_address_override:
        return po.pickup_address_override
    if consolidator and consolidator.pickup_address:
        return consolidator.pickup_address
    return vendor.pickup_address if vendor else None


@router.get("/", response_model=PickupRunResponse)
def get_pickup_run(
    date: date_cls = Query(..., description="Pickup run date"),
    db: Session = Depends(get_db),
):
    """Return all POs scheduled for pickup on `date`, grouped by pickup address."""
    pos = (
        db.query(models.PurchaseOrder)
        .filter(
            models.PurchaseOrder.status.in_(ELIGIBLE_STATUSES),
            or_(
                models.PurchaseOrder.pickup_run_date == date,
                # Fallback: pickup_run_date isn't set yet, but expected_delivery_date matches.
                # This lets the user start using the page without backfilling pickup_run_date
                # on every existing PO.
                (models.PurchaseOrder.pickup_run_date.is_(None))
                & (models.PurchaseOrder.expected_delivery_date == date),
            ),
        )
        .order_by(models.PurchaseOrder.po_number)
        .all()
    )

    # Pre-fetch vendors in one batch
    vendor_ids = set()
    for po in pos:
        vendor_ids.add(po.vendor_id)
        if po.pickup_at_vendor_id:
            vendor_ids.add(po.pickup_at_vendor_id)
    vendors = {v.id: v for v in db.query(models.Vendor).filter(models.Vendor.id.in_(vendor_ids)).all()} if vendor_ids else {}

    # Pre-fetch lines
    po_ids = [p.id for p in pos]
    lines_by_po: dict[int, list[models.PurchaseOrderLine]] = {}
    if po_ids:
        all_lines = db.query(models.PurchaseOrderLine).filter(
            models.PurchaseOrderLine.purchase_order_id.in_(po_ids)
        ).all()
        for ln in all_lines:
            lines_by_po.setdefault(ln.purchase_order_id, []).append(ln)

    # Group by effective pickup address. We key on the address text since two
    # POs that both override to the same custom address should bucket together
    # (e.g. a parking-lot meet that isn't tied to any vendor record).
    groups: dict[tuple[Optional[str], Optional[int]], PickupGroup] = {}

    for po in pos:
        seller = vendors.get(po.vendor_id)
        consolidator = vendors.get(po.pickup_at_vendor_id) if po.pickup_at_vendor_id else None
        addr = _resolve_pickup_address(po, seller, consolidator)

        # Group key: (address, consolidator_vendor_id) — keeps a custom override at
        # vendor B's address from accidentally merging with vendor B's own group
        # if the override happens to match.
        key = (addr or None, consolidator.id if consolidator else None)
        if key not in groups:
            groups[key] = PickupGroup(
                address=addr,
                consolidator_vendor_id=consolidator.id if consolidator else None,
                consolidator_vendor_name=consolidator.name if consolidator else None,
            )
        g = groups[key]

        po_lines = lines_by_po.get(po.id, [])
        line_models = [
            PickupLine(
                product_type=ln.product_type,
                quantity_cases=ln.quantity_cases or 0.0,
                case_weight_lbs=ln.case_weight_lbs,
                total_weight_lbs=ln.total_weight_lbs,
                notes=ln.notes,
            )
            for ln in po_lines
        ]
        po_total_cases = sum(ln.quantity_cases or 0.0 for ln in po_lines)
        po_total_weight = sum(ln.total_weight_lbs or 0.0 for ln in po_lines)

        g.pos.append(PickupPO(
            id=po.id,
            po_number=po.po_number,
            status=po.status,
            seller_vendor_id=po.vendor_id,
            seller_vendor_name=seller.name if seller else None,
            seller_contact_name=seller.contact_name if seller else None,
            seller_contact_phone=seller.contact_phone if seller else None,
            seller_contact_whatsapp=seller.contact_whatsapp if seller else None,
            pickup_at_vendor_id=consolidator.id if consolidator else None,
            pickup_at_vendor_name=consolidator.name if consolidator else None,
            pickup_at_vendor_phone=consolidator.contact_phone if consolidator else None,
            expected_delivery_date=po.expected_delivery_date,
            pickup_run_date=po.pickup_run_date,
            driver_name=po.driver_name,
            delivery_location=po.delivery_location,
            delivery_notes=po.delivery_notes,
            notes=po.notes,
            lines=line_models,
            line_count=len(po_lines),
            total_cases=po_total_cases,
            total_weight_lbs=po_total_weight,
        ))
        g.po_count += 1
        g.total_cases += po_total_cases
        g.total_weight_lbs += po_total_weight

    # Sort groups: groups with a known address first (alpha), then unaddressed.
    sorted_groups = sorted(
        groups.values(),
        key=lambda g: (g.address is None, (g.address or "").lower()),
    )

    # Tally how many eligible POs are unscheduled (no pickup_run_date AND no
    # expected_delivery_date) to surface in the UI as "needs scheduling".
    unscheduled = (
        db.query(models.PurchaseOrder)
        .filter(
            models.PurchaseOrder.status.in_(ELIGIBLE_STATUSES),
            models.PurchaseOrder.pickup_run_date.is_(None),
            models.PurchaseOrder.expected_delivery_date.is_(None),
        )
        .count()
    )

    return PickupRunResponse(date=date, groups=sorted_groups, unscheduled_count=unscheduled)
