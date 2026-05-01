"""
Receiving router — PO receiving, SKU confirmation, and inventory push.
"""
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func as sqlfunc
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas

router = APIRouter()

# Status ordering for forward-only progression
PO_STATUS_ORDER = [
    "draft", "placed", "in_transit", "partially_received",
    "delivered", "imported", "reconciled",
]

RECEIVABLE_STATUSES = {"placed", "in_transit", "partially_received"}
VALID_QUALITY_RATINGS = {"good", "acceptable", "poor"}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_po_or_404(db: Session, po_id: int) -> models.PurchaseOrder:
    po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    return po


def _get_po_line_or_404(db: Session, po_id: int, line_id: int) -> models.PurchaseOrderLine:
    line = (
        db.query(models.PurchaseOrderLine)
        .filter(
            models.PurchaseOrderLine.id == line_id,
            models.PurchaseOrderLine.purchase_order_id == po_id,
        )
        .first()
    )
    if not line:
        raise HTTPException(status_code=404, detail="PO line not found")
    return line


def _get_record_or_404(db: Session, record_id: int) -> models.ReceivingRecord:
    rec = db.query(models.ReceivingRecord).filter(models.ReceivingRecord.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Receiving record not found")
    return rec


def _validate_sku_for_product_type(db: Session, pick_sku: str, product_type: str):
    """Verify pick_sku is a real SKU.

    The receiving form's dropdown deliberately surfaces SKUs from inventory
    and the broader catalog (not just sku_mappings rows for this product
    type) so the user can correct mismatches in the field — the UI flags
    off-list picks with "Not in suggestions". This validator therefore only
    rejects SKUs that don't exist anywhere; product-type alignment is the
    user's call.
    """
    exists = db.query(models.PicklistSku.pick_sku).filter(
        models.PicklistSku.pick_sku == pick_sku
    ).first()
    if not exists:
        # Some inventory items reference SKUs that don't (yet) have a PicklistSku
        # row — accept those too rather than failing the receipt.
        exists = db.query(models.InventoryItem.pick_sku).filter(
            models.InventoryItem.pick_sku == pick_sku
        ).first()
    if not exists:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown SKU '{pick_sku}'",
        )


def _compute_pieces(db: Session, pick_sku: str, weight_lbs: float) -> Optional[float]:
    """Calculate piece count from weight and per-piece weight."""
    sku_row = db.query(models.PicklistSku).filter(models.PicklistSku.pick_sku == pick_sku).first()
    if sku_row and sku_row.weight_lb and sku_row.weight_lb > 0:
        return round(weight_lbs / sku_row.weight_lb, 2)
    return None


def _auto_progress_po_status(db: Session, po: models.PurchaseOrder):
    """
    Advance PO status forward based on receiving state.
    Only moves forward, never regresses.
    """
    current_idx = PO_STATUS_ORDER.index(po.status) if po.status in PO_STATUS_ORDER else 0

    lines = (
        db.query(models.PurchaseOrderLine)
        .filter(models.PurchaseOrderLine.purchase_order_id == po.id)
        .all()
    )
    if not lines:
        return

    line_ids = [l.id for l in lines]
    records = (
        db.query(models.ReceivingRecord)
        .filter(models.ReceivingRecord.po_line_id.in_(line_ids))
        .all()
    )

    if not records:
        return

    # Check if all records are pushed to inventory
    all_pushed = all(r.pushed_to_inventory for r in records)
    # Check if all lines have at least one receiving record
    lines_with_records = {r.po_line_id for r in records}
    all_lines_received = lines_with_records == set(line_ids)

    if all_pushed and all_lines_received:
        target = "imported"
    elif all_lines_received:
        target = "delivered"
    else:
        target = "partially_received"

    target_idx = PO_STATUS_ORDER.index(target)
    if target_idx > current_idx:
        po.status = target


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/po/{po_id}", response_model=List[schemas.ReceivingRecordResponse])
def list_receiving_for_po(po_id: int, db: Session = Depends(get_db)):
    """List all receiving records for a PO, grouped via PO line join."""
    po = _get_po_or_404(db, po_id)
    lines = (
        db.query(models.PurchaseOrderLine)
        .filter(models.PurchaseOrderLine.purchase_order_id == po.id)
        .all()
    )
    line_ids = [l.id for l in lines]
    line_map = {l.id: l.product_type for l in lines}

    if not line_ids:
        return []

    records = (
        db.query(models.ReceivingRecord)
        .filter(models.ReceivingRecord.po_line_id.in_(line_ids))
        .order_by(models.ReceivingRecord.received_date.desc(), models.ReceivingRecord.id.desc())
        .all()
    )

    result = []
    for r in records:
        resp = schemas.ReceivingRecordResponse.model_validate(r)
        resp.product_type = line_map.get(r.po_line_id)
        result.append(resp)
    return result


@router.post("/po/{po_id}/lines/{line_id}/receive", response_model=schemas.ReceivingRecordResponse, status_code=201)
def create_receiving_record(
    po_id: int, line_id: int,
    body: schemas.ReceivingRecordCreate,
    db: Session = Depends(get_db),
):
    """Record receipt of goods for a specific PO line."""
    po = _get_po_or_404(db, po_id)
    if po.status not in RECEIVABLE_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"Cannot receive on PO with status '{po.status}'. Must be placed, in_transit, or partially_received.",
        )

    line = _get_po_line_or_404(db, po_id, line_id)

    if body.quality_rating and body.quality_rating not in VALID_QUALITY_RATINGS:
        raise HTTPException(status_code=422, detail=f"quality_rating must be one of: {', '.join(VALID_QUALITY_RATINGS)}")

    confirmed_pieces = None
    if body.confirmed_pick_sku:
        _validate_sku_for_product_type(db, body.confirmed_pick_sku, line.product_type)
        confirmed_pieces = _compute_pieces(db, body.confirmed_pick_sku, body.received_weight_lbs)

    rec = models.ReceivingRecord(
        po_line_id=line.id,
        received_date=body.received_date,
        received_cases=body.received_cases,
        received_weight_lbs=body.received_weight_lbs,
        confirmed_pick_sku=body.confirmed_pick_sku,
        confirmed_pieces=confirmed_pieces,
        harvest_date=body.harvest_date,
        quality_rating=body.quality_rating,
        quality_notes=body.quality_notes,
    )
    db.add(rec)
    db.flush()

    _auto_progress_po_status(db, po)
    db.commit()
    db.refresh(rec)

    resp = schemas.ReceivingRecordResponse.model_validate(rec)
    resp.product_type = line.product_type
    return resp


@router.put("/{record_id}", response_model=schemas.ReceivingRecordResponse)
def update_receiving_record(
    record_id: int,
    body: schemas.ReceivingRecordUpdate,
    db: Session = Depends(get_db),
):
    """Update a receiving record (only before inventory push)."""
    rec = _get_record_or_404(db, record_id)
    if rec.pushed_to_inventory:
        raise HTTPException(status_code=422, detail="Cannot update a record that has been pushed to inventory")

    line = db.query(models.PurchaseOrderLine).filter(models.PurchaseOrderLine.id == rec.po_line_id).first()

    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(rec, key, value)

    # Re-validate and recompute if SKU or weight changed
    sku = update_data.get("confirmed_pick_sku", rec.confirmed_pick_sku)
    weight = update_data.get("received_weight_lbs", rec.received_weight_lbs)
    if sku and line:
        if "confirmed_pick_sku" in update_data:
            _validate_sku_for_product_type(db, sku, line.product_type)
        rec.confirmed_pieces = _compute_pieces(db, sku, weight)
    elif not sku:
        rec.confirmed_pieces = None

    if body.quality_rating and body.quality_rating not in VALID_QUALITY_RATINGS:
        raise HTTPException(status_code=422, detail=f"quality_rating must be one of: {', '.join(VALID_QUALITY_RATINGS)}")

    db.commit()
    db.refresh(rec)

    resp = schemas.ReceivingRecordResponse.model_validate(rec)
    resp.product_type = line.product_type if line else None
    return resp


@router.delete("/{record_id}")
def delete_receiving_record(record_id: int, db: Session = Depends(get_db)):
    """Delete a receiving record (only before inventory push)."""
    rec = _get_record_or_404(db, record_id)
    if rec.pushed_to_inventory:
        raise HTTPException(status_code=422, detail="Cannot delete a record that has been pushed to inventory")

    # Get PO for status re-evaluation
    line = db.query(models.PurchaseOrderLine).filter(models.PurchaseOrderLine.id == rec.po_line_id).first()
    po = None
    if line:
        po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == line.purchase_order_id).first()

    db.delete(rec)
    db.flush()

    if po:
        _auto_progress_po_status(db, po)

    db.commit()
    return {"ok": True}


def _product_type_family(pt: Optional[str]) -> Optional[str]:
    """Extract the family token used for fuzzy matching.

    "Fruit: Apple, Cosmic Crisp" → "apple"
    "Fruit: Apple, Honeycrisp"  → "apple"
    "Vegetable: Tomato, Roma"   → "tomato"

    The family is the first comma-separated word after the category prefix.
    """
    if not pt:
        return None
    body = pt.split(":", 1)[-1].strip()
    head = body.split(",", 1)[0].strip().lower()
    return head or None


def _strip_category_prefix(pt: Optional[str]) -> Optional[str]:
    """Drop the leading "Fruit: "/"Vegetable: " category from a product type.
    Used to match against InventoryItem.name (which doesn't carry the prefix)."""
    if not pt:
        return None
    return pt.split(":", 1)[1].strip() if ":" in pt else pt.strip()


@router.get("/skus-for-product-type/{product_type}", response_model=List[schemas.SkuForProductTypeResponse])
def get_skus_for_product_type(
    product_type: str,
    po_line_id: Optional[int] = Query(None, description="When provided, the linked plan row's base + sub product types are added to the suggestion candidates."),
    db: Session = Depends(get_db),
):
    """
    Return pick SKUs for the receiving form's Confirmed SKU dropdown,
    annotated with a `match_reason` so the frontend can render a
    "Suggested" group above the divider and "Other" below.

    Suggestion candidates (in priority order):
      - "exact"  — the line's product_type itself
      - "sub"    — the linked plan row's sub_product_type (substitute)
      - "base"   — the linked plan row's base product_type (when ordering a sub)
      - "family" — same first word (e.g. another "Apple, ..." for an Apple line)

    Everything else is returned unannotated so the user can still pick a
    completely different SKU if they have to — but the UI flags that case
    so it's a deliberate choice.
    """
    # ── Determine candidate product types from the linked plan row ──────────
    base_pt: Optional[str] = None
    sub_pt: Optional[str] = None
    if po_line_id:
        plan = db.query(models.PurchasePlanLine).filter(
            models.PurchasePlanLine.purchase_order_line_id == po_line_id
        ).first()
        if plan:
            base_pt = plan.product_type
            sub_pt = plan.sub_product_type

    # Priority order matters: a SKU matching multiple categories is labelled
    # by the highest-priority match.
    exact_pts = {product_type} if product_type else set()
    sub_pts = {sub_pt} if sub_pt and sub_pt != product_type else set()
    base_pts = {base_pt} if base_pt and base_pt not in exact_pts and base_pt not in sub_pts else set()
    family_words = {_product_type_family(pt) for pt in (product_type, base_pt, sub_pt)}
    family_words.discard(None)

    # ── Build a (pick_sku → product_type) lookup from sku_mappings ─────────
    # A SKU can appear under multiple Shopify variants but they all share the
    # same product_type, so first-seen wins.
    pt_by_sku: dict[str, str] = {}
    for sku, pt in db.query(
        models.SkuMapping.pick_sku, models.SkuMapping.product_type
    ).filter(
        models.SkuMapping.is_active == True,
        models.SkuMapping.pick_sku.isnot(None),
        models.SkuMapping.product_type.isnot(None),
    ).distinct().all():
        pt_by_sku.setdefault(sku, pt)

    # ── Inventory: aggregate on_hand_qty + name across warehouses ──────────
    inv_qty_by_sku: dict[str, float] = {}
    inv_name_by_sku: dict[str, str] = {}
    for sku, qty, name in db.query(
        models.InventoryItem.pick_sku,
        sqlfunc.sum(models.InventoryItem.on_hand_qty),
        sqlfunc.max(models.InventoryItem.name),
    ).group_by(models.InventoryItem.pick_sku).all():
        inv_qty_by_sku[sku] = float(qty or 0)
        if name:
            inv_name_by_sku[sku] = name

    # SKUs that appear in inventory but not in sku_mappings: synthesize a
    # product_type from InventoryItem.name. We don't know the category prefix
    # (Fruit/Vegetable/...) so we infer it from any of our candidate product
    # types — this only matters for matching anyway, not for display.
    candidate_prefix = ""
    for pt in (product_type, base_pt, sub_pt):
        if pt and ":" in pt:
            candidate_prefix = pt.split(":", 1)[0].strip() + ": "
            break
    for sku, name in inv_name_by_sku.items():
        if sku not in pt_by_sku:
            pt_by_sku[sku] = f"{candidate_prefix}{name}" if candidate_prefix else name

    # ── PicklistSku is the canonical SKU list (weights, shelf life, etc.) ──
    pick_rows = db.query(models.PicklistSku).all()
    pick_info_by_sku = {p.pick_sku: p for p in pick_rows}
    # Union of all known SKUs across the three sources.
    all_skus = set(pt_by_sku) | set(inv_qty_by_sku) | set(pick_info_by_sku)
    if not all_skus:
        return []

    # ── Classify each SKU ──────────────────────────────────────────────────
    def classify(pt: Optional[str]) -> Optional[str]:
        if not pt:
            return None
        if pt in exact_pts:
            return "exact"
        if pt in sub_pts:
            return "sub"
        if pt in base_pts:
            return "base"
        if _product_type_family(pt) in family_words:
            return "family"
        return None

    # Priority for sorting suggestions
    reason_rank = {"exact": 0, "sub": 1, "base": 2, "family": 3}

    items: list[schemas.SkuForProductTypeResponse] = []
    for ps in all_skus:
        pt = pt_by_sku.get(ps)
        info = pick_info_by_sku.get(ps)
        items.append(schemas.SkuForProductTypeResponse(
            pick_sku=ps,
            weight_lb=info.weight_lb if info else None,
            days_til_expiration=info.days_til_expiration if info else None,
            total_on_hand=inv_qty_by_sku.get(ps, 0.0),
            product_type=pt,
            match_reason=classify(pt),
        ))

    # Sort: suggested before others; within suggested, by reason priority then
    # stocked-first; within others, stocked-first then alphabetical.
    def sort_key(r: schemas.SkuForProductTypeResponse) -> tuple:
        is_suggested = r.match_reason is not None
        return (
            0 if is_suggested else 1,
            reason_rank.get(r.match_reason, 99),
            -r.total_on_hand,
            r.pick_sku,
        )
    items.sort(key=sort_key)
    return items


@router.post("/{record_id}/push-to-inventory", response_model=schemas.InventoryPushResponse)
def push_to_inventory(
    record_id: int,
    body: schemas.InventoryPushRequest,
    db: Session = Depends(get_db),
):
    """Push a receiving record to inventory: create batch + adjustment + update on-hand."""
    rec = _get_record_or_404(db, record_id)
    if rec.pushed_to_inventory:
        raise HTTPException(status_code=422, detail="Already pushed to inventory")
    if not rec.confirmed_pick_sku:
        raise HTTPException(status_code=422, detail="Must confirm SKU before pushing to inventory")

    line = db.query(models.PurchaseOrderLine).filter(models.PurchaseOrderLine.id == rec.po_line_id).first()
    po = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.id == line.purchase_order_id).first()

    # Find or create InventoryItem
    item = (
        db.query(models.InventoryItem)
        .filter(
            models.InventoryItem.pick_sku == rec.confirmed_pick_sku,
            models.InventoryItem.warehouse == body.warehouse,
        )
        .first()
    )
    if not item:
        item = models.InventoryItem(
            pick_sku=rec.confirmed_pick_sku,
            warehouse=body.warehouse,
            on_hand_qty=0.0,
            committed_qty=0.0,
            available_qty=0.0,
            shipped_qty=0.0,
        )
        db.add(item)
        db.flush()

    # Quantity: use confirmed_pieces if available, else weight
    qty = rec.confirmed_pieces if rec.confirmed_pieces else rec.received_weight_lbs

    # Expiration date from harvest_date + shelf life
    expiration_date = None
    if rec.harvest_date:
        sku_row = db.query(models.PicklistSku).filter(models.PicklistSku.pick_sku == rec.confirmed_pick_sku).first()
        if sku_row and sku_row.days_til_expiration:
            expiration_date = rec.harvest_date + timedelta(days=int(sku_row.days_til_expiration))

    batch_code = body.batch_code or f"PO-{po.po_number}-L{line.id}-R{rec.id}"

    batch = models.InventoryBatch(
        pick_sku=rec.confirmed_pick_sku,
        warehouse=body.warehouse,
        batch_code=batch_code,
        quantity_received=qty,
        quantity_remaining=qty,
        received_date=rec.received_date,
        expiration_date=expiration_date,
        notes=f"PO receive: {po.po_number}, {line.product_type}",
    )
    db.add(batch)
    db.flush()

    adj = models.InventoryAdjustment(
        pick_sku=rec.confirmed_pick_sku,
        warehouse=body.warehouse,
        delta=qty,
        adjustment_type="po_receive",
        note=f"PO {po.po_number} receive - {line.product_type}",
        batch_id=batch.id,
    )
    db.add(adj)
    db.flush()

    # Update inventory
    item.on_hand_qty += qty
    item.available_qty = item.on_hand_qty - item.committed_qty

    # Link record
    rec.pushed_to_inventory = True
    rec.inventory_batch_id = batch.id

    _auto_progress_po_status(db, po)
    db.commit()

    return schemas.InventoryPushResponse(
        receiving_record_id=rec.id,
        inventory_batch_id=batch.id,
        inventory_adjustment_id=adj.id,
        pick_sku=rec.confirmed_pick_sku,
        quantity_added=qty,
        expiration_date=expiration_date,
    )


@router.post("/po/{po_id}/push-all")
def push_all_to_inventory(
    po_id: int,
    body: schemas.InventoryPushRequest = schemas.InventoryPushRequest(),
    db: Session = Depends(get_db),
):
    """Push all un-pushed receiving records for a PO to inventory."""
    po = _get_po_or_404(db, po_id)
    lines = (
        db.query(models.PurchaseOrderLine)
        .filter(models.PurchaseOrderLine.purchase_order_id == po.id)
        .all()
    )
    line_ids = [l.id for l in lines]
    line_map = {l.id: l for l in lines}

    records = (
        db.query(models.ReceivingRecord)
        .filter(
            models.ReceivingRecord.po_line_id.in_(line_ids),
            models.ReceivingRecord.pushed_to_inventory == False,
            models.ReceivingRecord.confirmed_pick_sku.isnot(None),
        )
        .all()
    )

    if not records:
        raise HTTPException(status_code=422, detail="No eligible records to push (need confirmed SKU and not yet pushed)")

    results = []
    for rec in records:
        line = line_map[rec.po_line_id]

        # Find or create InventoryItem
        item = (
            db.query(models.InventoryItem)
            .filter(
                models.InventoryItem.pick_sku == rec.confirmed_pick_sku,
                models.InventoryItem.warehouse == body.warehouse,
            )
            .first()
        )
        if not item:
            item = models.InventoryItem(
                pick_sku=rec.confirmed_pick_sku,
                warehouse=body.warehouse,
                on_hand_qty=0.0,
                committed_qty=0.0,
                available_qty=0.0,
                shipped_qty=0.0,
            )
            db.add(item)
            db.flush()

        qty = rec.confirmed_pieces if rec.confirmed_pieces else rec.received_weight_lbs

        expiration_date = None
        if rec.harvest_date:
            sku_row = db.query(models.PicklistSku).filter(models.PicklistSku.pick_sku == rec.confirmed_pick_sku).first()
            if sku_row and sku_row.days_til_expiration:
                expiration_date = rec.harvest_date + timedelta(days=int(sku_row.days_til_expiration))

        batch_code = f"PO-{po.po_number}-L{line.id}-R{rec.id}"
        batch = models.InventoryBatch(
            pick_sku=rec.confirmed_pick_sku,
            warehouse=body.warehouse,
            batch_code=batch_code,
            quantity_received=qty,
            quantity_remaining=qty,
            received_date=rec.received_date,
            expiration_date=expiration_date,
            notes=f"PO receive: {po.po_number}, {line.product_type}",
        )
        db.add(batch)
        db.flush()

        adj = models.InventoryAdjustment(
            pick_sku=rec.confirmed_pick_sku,
            warehouse=body.warehouse,
            delta=qty,
            adjustment_type="po_receive",
            note=f"PO {po.po_number} receive - {line.product_type}",
            batch_id=batch.id,
        )
        db.add(adj)
        db.flush()

        item.on_hand_qty += qty
        item.available_qty = item.on_hand_qty - item.committed_qty

        rec.pushed_to_inventory = True
        rec.inventory_batch_id = batch.id

        results.append({
            "receiving_record_id": rec.id,
            "inventory_batch_id": batch.id,
            "pick_sku": rec.confirmed_pick_sku,
            "quantity_added": qty,
        })

    _auto_progress_po_status(db, po)
    db.commit()

    return {"pushed": len(results), "results": results}
