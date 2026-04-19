"""
Inventory router — persistent, sessionless inventory management.

Inventory is the app's source of truth. on_hand_qty is manually managed via
adjustments. committed_qty is auto-computed from open orders.
available_qty = on_hand_qty - committed_qty.
"""
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from services import sheets_service

router = APIRouter()

VALID_STATUSES = {
    "not_processed", "staged", "in_shipstation_not_shipped", "in_shipstation_shipped",
    "fulfilled", "partially_fulfilled",
}

# Statuses that count toward committed inventory.
# Only staged orders commit inventory; once pushed to ShipStation, on_hand is
# immediately decremented so in_shipstation_not_shipped no longer needs to commit.
COMMITTED_STATUSES = {"staged"}

# Statuses that count as shipped (informational)
SHIPPED_STATUSES = {"in_shipstation_shipped", "fulfilled", "partially_fulfilled"}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _recompute_committed(warehouse: str, db: Session,
                         shipped_from: Optional[datetime] = None,
                         shipped_to: Optional[datetime] = None):
    """
    Recompute committed_qty and available_qty for all items in a warehouse
    based on current open order line items. Call whenever order statuses change.
    """
    # Get live SKU mapping (same source as demand_analysis) — cached 5 min
    try:
        sku_lookup = sheets_service.get_sku_mapping_lookup(warehouse)
    except Exception:
        sku_lookup = {}

    # ── Open orders (committed) ───────────────────────────────────────────────
    open_orders = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.assigned_warehouse == warehouse,
        models.ShopifyOrder.app_status.in_(list(COMMITTED_STATUSES)),
    ).all()
    open_order_ids = [o.shopify_order_id for o in open_orders]

    # Batch-fetch all plans for open orders
    plans = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id.in_(open_order_ids)
    ).all() if open_order_ids else []
    plan_map = {p.shopify_order_id: p for p in plans}
    plan_ids = [p.id for p in plans]

    # Batch-fetch all boxes for those plans
    all_open_boxes = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.plan_id.in_(plan_ids)
    ).all() if plan_ids else []
    boxes_by_plan: dict[int, list] = {}
    for box in all_open_boxes:
        boxes_by_plan.setdefault(box.plan_id, []).append(box)

    # Batch-fetch box line items for non-cancelled boxes
    non_cancelled_box_ids = [b.id for b in all_open_boxes if b.status != 'cancelled']
    all_box_items = db.query(models.BoxLineItem).filter(
        models.BoxLineItem.box_id.in_(non_cancelled_box_ids)
    ).all() if non_cancelled_box_ids else []
    box_items_by_box: dict[int, list] = {}
    for item in all_box_items:
        box_items_by_box.setdefault(item.box_id, []).append(item)

    # Build per-order box demand from box line items
    order_box_demand: dict[str, dict[str, float]] = {}
    for plan in plans:
        plan_boxes = [b for b in boxes_by_plan.get(plan.id, []) if b.status != 'cancelled']
        if not plan_boxes:
            continue
        sku_agg: dict[str, float] = {}
        for box in plan_boxes:
            for item in box_items_by_box.get(box.id, []):
                if item.pick_sku:
                    sku_agg[item.pick_sku] = sku_agg.get(item.pick_sku, 0.0) + item.quantity
        if sku_agg:
            order_box_demand[plan.shopify_order_id] = sku_agg

    orders_with_plan = set(order_box_demand.keys())

    # Batch-fetch line items for open orders that have no plan
    orders_without_plan_ids = [o.shopify_order_id for o in open_orders
                                if o.shopify_order_id not in orders_with_plan]
    open_line_items_by_order: dict[str, list] = {}
    if orders_without_plan_ids:
        for li in db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id.in_(orders_without_plan_ids)
        ).all():
            open_line_items_by_order.setdefault(li.shopify_order_id, []).append(li)

    # Batch-fetch box types used by open-order boxes
    open_box_type_ids = {b.box_type_id for b in all_open_boxes if b.box_type_id}
    open_box_types = {}
    if open_box_type_ids:
        open_box_types = {bt.id: bt for bt in db.query(models.BoxType).filter(
            models.BoxType.id.in_(list(open_box_type_ids))
        ).all()}

    demand: dict[str, float] = {}
    for order in open_orders:
        order_id = order.shopify_order_id

        if order_id in orders_with_plan:
            for pick, qty in order_box_demand[order_id].items():
                demand[pick] = demand.get(pick, 0.0) + qty
        else:
            for li in open_line_items_by_order.get(order_id, []):
                if not li.shopify_sku or li.app_line_status == 'short_ship':
                    continue
                qty = (li.fulfillable_quantity if li.fulfillable_quantity is not None
                       else li.quantity)
                live_mappings = sku_lookup.get(li.shopify_sku, [])
                if live_mappings:
                    for m in live_mappings:
                        pick = m.get('pick_sku')
                        if pick:
                            demand[pick] = demand.get(pick, 0.0) + qty * (m.get('mix_quantity') or 1.0)
                elif li.sku_mapped and li.pick_sku:
                    demand[li.pick_sku] = demand.get(li.pick_sku, 0.0) + qty * (li.mix_quantity or 1.0)

        # Commit 1 unit per box used (box material)
        plan = plan_map.get(order_id)
        if plan:
            for box in boxes_by_plan.get(plan.id, []):
                if box.box_type_id:
                    bt = open_box_types.get(box.box_type_id)
                    if bt and bt.pick_sku:
                        demand[bt.pick_sku] = demand.get(bt.pick_sku, 0.0) + 1.0

    # ── Shipped orders ────────────────────────────────────────────────────────
    shipped_q = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.assigned_warehouse == warehouse,
        models.ShopifyOrder.app_status.in_(list(SHIPPED_STATUSES)),
    )
    if shipped_from:
        shipped_q = shipped_q.filter(models.ShopifyOrder.updated_at >= shipped_from)
    if shipped_to:
        shipped_q = shipped_q.filter(models.ShopifyOrder.updated_at <= shipped_to)
    shipped_orders = shipped_q.all()
    shipped_order_ids = [o.shopify_order_id for o in shipped_orders]

    shipped: dict[str, float] = {}
    if shipped_order_ids:
        # Batch-fetch all line items for shipped orders
        shipped_line_items_by_order: dict[str, list] = {}
        for li in db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id.in_(shipped_order_ids)
        ).all():
            shipped_line_items_by_order.setdefault(li.shopify_order_id, []).append(li)

        # Batch-fetch fulfillment plans for shipped orders
        shipped_plans = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.shopify_order_id.in_(shipped_order_ids)
        ).all()
        shipped_plan_map = {p.shopify_order_id: p for p in shipped_plans}
        shipped_plan_ids = [p.id for p in shipped_plans]

        # Batch-fetch boxes and box types for shipped plans
        shipped_boxes_by_plan: dict[int, list] = {}
        shipped_box_type_ids: set[int] = set()
        if shipped_plan_ids:
            for box in db.query(models.FulfillmentBox).filter(
                models.FulfillmentBox.plan_id.in_(shipped_plan_ids)
            ).all():
                shipped_boxes_by_plan.setdefault(box.plan_id, []).append(box)
                if box.box_type_id:
                    shipped_box_type_ids.add(box.box_type_id)

        shipped_box_types = {}
        if shipped_box_type_ids:
            shipped_box_types = {bt.id: bt for bt in db.query(models.BoxType).filter(
                models.BoxType.id.in_(list(shipped_box_type_ids))
            ).all()}

        for order in shipped_orders:
            order_id = order.shopify_order_id
            for li in shipped_line_items_by_order.get(order_id, []):
                if not li.shopify_sku or li.app_line_status == 'short_ship':
                    continue
                qty = (li.fulfillable_quantity if li.fulfillable_quantity is not None
                       else li.quantity)
                live_mappings = sku_lookup.get(li.shopify_sku, [])
                if live_mappings:
                    for m in live_mappings:
                        pick = m.get('pick_sku')
                        if pick:
                            shipped[pick] = shipped.get(pick, 0.0) + qty * (m.get('mix_quantity') or 1.0)
                elif li.sku_mapped and li.pick_sku:
                    shipped[li.pick_sku] = shipped.get(li.pick_sku, 0.0) + qty * (li.mix_quantity or 1.0)

            # Count 1 unit per box shipped (box material)
            plan = shipped_plan_map.get(order_id)
            if plan:
                for box in shipped_boxes_by_plan.get(plan.id, []):
                    if box.box_type_id:
                        bt = shipped_box_types.get(box.box_type_id)
                        if bt and bt.pick_sku:
                            shipped[bt.pick_sku] = shipped.get(bt.pick_sku, 0.0) + 1.0

    # Update all inventory items for this warehouse
    items = db.query(models.InventoryItem).filter(
        models.InventoryItem.warehouse == warehouse
    ).all()
    for item in items:
        item.committed_qty = demand.get(item.pick_sku, 0.0)
        item.shipped_qty = shipped.get(item.pick_sku, 0.0)
        item.available_qty = item.on_hand_qty - item.committed_qty
    db.flush()


def _auto_deduct_on_ship(order, db: Session):
    """
    Deduct pick quantities from on_hand_qty when an order is pushed to ShipStation.
    Call this immediately after setting app_status = 'in_shipstation_not_shipped'.
    Inventory is considered consumed at push time; no further deduction on fulfilled/shipped.
    """
    from sqlalchemy import or_
    line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
        models.ShopifyLineItem.sku_mapped == True,
        or_(
            models.ShopifyLineItem.app_line_status != "short_ship",
            models.ShopifyLineItem.app_line_status.is_(None),
        ),
    ).all()

    demand: dict[str, float] = {}
    for li in line_items:
        if not li.pick_sku:
            continue
        qty = (li.fulfillable_quantity if li.fulfillable_quantity is not None else li.quantity)
        needed = qty * (li.mix_quantity or 1.0)
        demand[li.pick_sku] = demand.get(li.pick_sku, 0.0) + needed

    # Also deduct 1 unit per box used in this order's fulfillment plan
    plan = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id == order.shopify_order_id
    ).first()
    if plan:
        boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id
        ).all()
        for box in boxes:
            if box.box_type_id:
                bt = db.query(models.BoxType).filter(
                    models.BoxType.id == box.box_type_id
                ).first()
                if bt and bt.pick_sku:
                    demand[bt.pick_sku] = demand.get(bt.pick_sku, 0.0) + 1.0

    for pick_sku, qty in demand.items():
        inv = db.query(models.InventoryItem).filter(
            models.InventoryItem.pick_sku == pick_sku,
            models.InventoryItem.warehouse == order.assigned_warehouse,
        ).first()
        if inv:
            inv.on_hand_qty -= qty
            _log_adjustment(
                db, pick_sku, order.assigned_warehouse,
                -qty, "ship_deduct",
                f"Pushed to ShipStation: order {order.shopify_order_number}",
                order.shopify_order_id,
            )
    db.flush()


def _restore_inventory_on_cancel(order, db: Session):
    """
    Reverse all ship_deduct adjustments for this order.
    Call this when cancelling an order that was previously pushed to ShipStation
    (i.e. _auto_deduct_on_ship was already called).

    Looks up every InventoryAdjustment with adjustment_type='ship_deduct' for the
    order, adds back the absolute delta to on_hand_qty, and logs a cancel_restore
    adjustment so the audit trail is complete.

    Safe to call even if no deductions exist (e.g. multi-box orders where inventory
    is deducted at ship time, not push time) — it simply does nothing.
    """
    adjustments = (
        db.query(models.InventoryAdjustment)
        .filter(
            models.InventoryAdjustment.shopify_order_id == order.shopify_order_id,
            models.InventoryAdjustment.adjustment_type == "ship_deduct",
        )
        .all()
    )

    for adj in adjustments:
        inv = db.query(models.InventoryItem).filter(
            models.InventoryItem.pick_sku == adj.pick_sku,
            models.InventoryItem.warehouse == adj.warehouse,
        ).first()
        if inv:
            restore_qty = abs(adj.delta)
            inv.on_hand_qty += restore_qty
            _log_adjustment(
                db, adj.pick_sku, adj.warehouse,
                restore_qty, "cancel_restore",
                f"Cancelled order {order.shopify_order_number} — inventory restored",
                order.shopify_order_id,
            )

    db.flush()


def _log_adjustment(
    db: Session,
    pick_sku: str,
    warehouse: str,
    delta: float,
    adjustment_type: str,
    note: Optional[str] = None,
    shopify_order_id: Optional[str] = None,
    batch_id: Optional[int] = None,
):
    adj = models.InventoryAdjustment(
        pick_sku=pick_sku,
        warehouse=warehouse,
        delta=delta,
        adjustment_type=adjustment_type,
        note=note,
        shopify_order_id=shopify_order_id,
        batch_id=batch_id,
    )
    db.add(adj)
    return adj


# ── Items CRUD ────────────────────────────────────────────────────────────────

@router.get("/items")
def list_items(
    warehouse: str = Query(..., description="'walnut' or 'northlake'"),
    search: Optional[str] = Query(None),
    shipped_from: Optional[str] = Query(None, description="ISO date for shipped range start (YYYY-MM-DD)"),
    shipped_to: Optional[str] = Query(None, description="ISO date for shipped range end (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
):
    # Parse shipped date range
    sf = datetime.fromisoformat(shipped_from) if shipped_from else None
    st = (datetime.fromisoformat(shipped_to).replace(hour=23, minute=59, second=59)
          if shipped_to else None)

    # Always recompute committed from live orders + live Sheets mapping before
    # returning items, so the Inventory page is always in sync with staging
    # without needing a manual "Recompute Committed" click.
    # Sheets data is cached (5 min) so this is fast on repeated calls.
    _recompute_committed(warehouse, db, shipped_from=sf, shipped_to=st)
    db.commit()

    q = db.query(models.InventoryItem).filter(
        models.InventoryItem.warehouse == warehouse
    )
    if search:
        s = f"%{search.lower()}%"
        q = q.filter(
            models.InventoryItem.pick_sku.ilike(s) |
            models.InventoryItem.name.ilike(s)
        )
    items = q.order_by(models.InventoryItem.pick_sku).all()

    # Build category map from picklist_skus
    pick_skus = [i.pick_sku for i in items]
    category_map: dict[str, str | None] = {}
    if pick_skus:
        pskus = db.query(models.PicklistSku.pick_sku, models.PicklistSku.category).filter(
            models.PicklistSku.pick_sku.in_(pick_skus)
        ).all()
        category_map = {p.pick_sku: p.category for p in pskus}

    return [
        {
            "id": item.id,
            "pick_sku": item.pick_sku,
            "warehouse": item.warehouse,
            "name": item.name,
            "on_hand_qty": item.on_hand_qty,
            "committed_qty": item.committed_qty,
            "available_qty": item.available_qty,
            "shipped_qty": item.shipped_qty,
            "days_on_hand": item.days_on_hand,
            "batch_code": item.batch_code,
            "updated_at": item.updated_at,
            "category": category_map.get(item.pick_sku),
        }
        for item in items
    ]


@router.get("/weekly-report")
def weekly_report(
    warehouse: str = Query(...),
    db: Session = Depends(get_db),
):
    """Items with on_hand_qty > 0 for the weekly inventory count sheet."""
    items = db.query(models.InventoryItem).filter(
        models.InventoryItem.warehouse == warehouse,
        models.InventoryItem.on_hand_qty > 0,
    ).order_by(models.InventoryItem.pick_sku).all()

    pick_skus = [i.pick_sku for i in items]
    category_map: dict[str, str | None] = {}
    if pick_skus:
        pskus = db.query(models.PicklistSku.pick_sku, models.PicklistSku.category).filter(
            models.PicklistSku.pick_sku.in_(pick_skus)
        ).all()
        category_map = {p.pick_sku: p.category for p in pskus}

    return [
        {
            "id": item.id,
            "pick_sku": item.pick_sku,
            "warehouse": item.warehouse,
            "name": item.name,
            "on_hand_qty": item.on_hand_qty,
            "committed_qty": item.committed_qty,
            "available_qty": item.available_qty,
            "shipped_qty": item.shipped_qty,
            "days_on_hand": item.days_on_hand,
            "batch_code": item.batch_code,
            "updated_at": item.updated_at,
            "category": category_map.get(item.pick_sku),
        }
        for item in items
    ]


@router.post("/items", response_model=schemas.InventoryItemOut, status_code=201)
def create_item(body: schemas.InventoryItemCreate, db: Session = Depends(get_db)):
    existing = db.query(models.InventoryItem).filter(
        models.InventoryItem.pick_sku == body.pick_sku,
        models.InventoryItem.warehouse == body.warehouse,
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"SKU '{body.pick_sku}' already exists for warehouse '{body.warehouse}'")

    item = models.InventoryItem(
        pick_sku=body.pick_sku,
        warehouse=body.warehouse,
        name=body.name,
        on_hand_qty=body.on_hand_qty,
        committed_qty=0.0,
        available_qty=body.on_hand_qty,
        shipped_qty=0.0,
        days_on_hand=body.days_on_hand,
        batch_code=body.batch_code,
    )
    db.add(item)
    db.flush()

    if body.on_hand_qty != 0.0:
        _log_adjustment(
            db, body.pick_sku, body.warehouse, body.on_hand_qty,
            "initial_set", f"Initial stock entry: {body.on_hand_qty} units"
        )

    db.commit()
    db.refresh(item)
    return item


@router.put("/items/{item_id}", response_model=schemas.InventoryItemOut)
def update_item(item_id: int, body: schemas.InventoryItemUpdate, db: Session = Depends(get_db)):
    item = db.query(models.InventoryItem).filter(models.InventoryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Inventory item not found")

    if body.on_hand_qty is not None:
        delta = body.on_hand_qty - item.on_hand_qty
        if delta != 0:
            adj_type = "manual_add" if delta > 0 else "manual_deduct"
            _log_adjustment(db, item.pick_sku, item.warehouse, delta, adj_type, body.note)
            item.on_hand_qty = body.on_hand_qty
            item.available_qty = item.on_hand_qty - item.committed_qty

    if body.name is not None:
        item.name = body.name
    if body.days_on_hand is not None:
        item.days_on_hand = body.days_on_hand
    if body.batch_code is not None:
        item.batch_code = body.batch_code

    db.commit()
    db.refresh(item)
    return item


@router.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.InventoryItem).filter(models.InventoryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Inventory item not found")
    if item.committed_qty > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete '{item.pick_sku}': {item.committed_qty} units currently committed to open orders"
        )
    db.delete(item)
    db.commit()


# ── Adjustments ───────────────────────────────────────────────────────────────

@router.get("/items/{item_id}/adjustments", response_model=List[schemas.AdjustmentOut])
def get_item_adjustments(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.InventoryItem).filter(models.InventoryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Inventory item not found")
    return (
        db.query(models.InventoryAdjustment)
        .filter(
            models.InventoryAdjustment.pick_sku == item.pick_sku,
            models.InventoryAdjustment.warehouse == item.warehouse,
        )
        .order_by(models.InventoryAdjustment.created_at.desc())
        .all()
    )


@router.get("/adjustments", response_model=List[schemas.AdjustmentOut])
def list_adjustments(
    warehouse: str = Query(...),
    pick_sku: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    q = db.query(models.InventoryAdjustment).filter(
        models.InventoryAdjustment.warehouse == warehouse
    )
    if pick_sku:
        q = q.filter(models.InventoryAdjustment.pick_sku == pick_sku)
    return q.order_by(models.InventoryAdjustment.created_at.desc()).limit(limit).all()


# ── Batches ───────────────────────────────────────────────────────────────────

@router.get("/items/{item_id}/batches", response_model=List[schemas.InventoryBatchOut])
def list_item_batches(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.InventoryItem).filter(models.InventoryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Inventory item not found")
    return (
        db.query(models.InventoryBatch)
        .filter(
            models.InventoryBatch.pick_sku == item.pick_sku,
            models.InventoryBatch.warehouse == item.warehouse,
        )
        .order_by(models.InventoryBatch.received_date.desc(), models.InventoryBatch.created_at.desc())
        .all()
    )


@router.post("/items/{item_id}/batches", response_model=schemas.InventoryBatchOut, status_code=201)
def receive_batch(item_id: int, body: schemas.InventoryBatchCreate, db: Session = Depends(get_db)):
    """
    Receive a new batch of inventory. Adds quantity to the item's on_hand_qty and
    creates a batch record with received/expiration dates.
    Expiration date defaults to received_date + PicklistSku.days_til_expiration if not provided.
    """
    item = db.query(models.InventoryItem).filter(models.InventoryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Inventory item not found")
    if body.quantity_received <= 0:
        raise HTTPException(status_code=422, detail="quantity_received must be positive")

    # Compute expiration date if not provided
    expiration_date = body.expiration_date
    if expiration_date is None:
        sku_row = db.query(models.PicklistSku).filter(models.PicklistSku.pick_sku == item.pick_sku).first()
        if sku_row and sku_row.days_til_expiration:
            expiration_date = body.received_date + timedelta(days=int(sku_row.days_til_expiration))

    batch = models.InventoryBatch(
        pick_sku=item.pick_sku,
        warehouse=item.warehouse,
        batch_code=body.batch_code,
        quantity_received=body.quantity_received,
        quantity_remaining=body.quantity_received,
        received_date=body.received_date,
        expiration_date=expiration_date,
        notes=body.notes,
    )
    db.add(batch)
    db.flush()

    # Update item on_hand_qty
    item.on_hand_qty += body.quantity_received
    item.available_qty = item.on_hand_qty - item.committed_qty

    _log_adjustment(
        db, item.pick_sku, item.warehouse, body.quantity_received, "restock",
        f"Batch received: {body.batch_code}",
        batch_id=batch.id,
    )

    db.commit()
    db.refresh(batch)
    return batch


@router.put("/batches/{batch_id}", response_model=schemas.InventoryBatchOut)
def update_batch(batch_id: int, body: schemas.InventoryBatchUpdate, db: Session = Depends(get_db)):
    """
    Adjust a batch's quantity_remaining. The delta is applied to the linked
    inventory item's on_hand_qty as a batch_adjust adjustment.
    """
    batch = db.query(models.InventoryBatch).filter(models.InventoryBatch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    if body.quantity_remaining < 0:
        raise HTTPException(status_code=422, detail="quantity_remaining cannot be negative")

    delta = body.quantity_remaining - batch.quantity_remaining

    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.pick_sku == batch.pick_sku,
        models.InventoryItem.warehouse == batch.warehouse,
    ).first()

    if item and delta != 0:
        item.on_hand_qty += delta
        item.available_qty = item.on_hand_qty - item.committed_qty
        adj_type = "batch_adjust"
        note_text = body.notes or f"Batch adjustment: {batch.batch_code}"
        _log_adjustment(db, item.pick_sku, item.warehouse, delta, adj_type, note_text, batch_id=batch_id)

    batch.quantity_remaining = body.quantity_remaining
    if body.notes is not None:
        batch.notes = body.notes

    db.commit()
    db.refresh(batch)
    return batch


# ── Committed recompute ───────────────────────────────────────────────────────

@router.post("/recompute-committed")
def recompute_committed(
    warehouse: str = Query(...),
    db: Session = Depends(get_db),
):
    """
    Recompute committed_qty for all inventory items in a warehouse from live orders.
    Call this after bulk changes or to sync state.
    """
    _recompute_committed(warehouse, db)
    db.commit()
    items = db.query(models.InventoryItem).filter(
        models.InventoryItem.warehouse == warehouse
    ).all()
    return {
        "warehouse": warehouse,
        "items_updated": len(items),
        "message": "Committed quantities recomputed from open orders",
    }


# ── Demand analysis ───────────────────────────────────────────────────────────

@router.get("/demand-analysis", response_model=List[schemas.DemandAnalysisItem])
def demand_analysis(
    warehouse: str = Query(..., description="'walnut' or 'northlake'"),
    order_scope: str = Query("staged", description="'staged' = staged only, 'all' = all open orders including not_processed"),
    health_filter: str = Query("all", description="'all' = all orders, 'ok' = orders without shortages, 'errors' = orders with shortages"),
    db: Session = Depends(get_db),
):
    """
    Show which pick SKUs would be out of stock and by how much if all open orders
    were processed, using LIVE SKU mappings from Google Sheets.
    Also shows which Shopify SKUs map to each pick SKU (for remapping decisions).
    """
    # Always recompute committed so the available_qty / committed_qty values
    # embedded in results reflect the current state.
    _recompute_committed(warehouse, db)
    db.commit()

    # 1. Pull live SKU mapping from Sheets (cached 5 min)
    try:
        sku_lookup = sheets_service.get_sku_mapping_lookup(warehouse)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="Google Sheets credentials not configured")

    # 2. Build inverse lookup: pick_sku → [{ shopify_sku, mix_quantity }]
    #    Also build a product title lookup from stored line items
    inverse: dict[str, list] = {}
    for shopify_sku, mappings in sku_lookup.items():
        for m in mappings:
            pick = m.get("pick_sku")
            if not pick:
                continue
            if pick not in inverse:
                inverse[pick] = []
            inverse[pick].append({
                "shopify_sku": shopify_sku,
                "mix_quantity": m.get("mix_quantity") or 1.0,
            })

    # 3. Get product titles from stored line items (best-effort)
    title_lookup: dict[str, str] = {}
    recent_items = db.query(
        models.ShopifyLineItem.shopify_sku,
        models.ShopifyLineItem.product_title,
    ).filter(
        models.ShopifyLineItem.shopify_sku.isnot(None),
        models.ShopifyLineItem.product_title.isnot(None),
    ).distinct().all()
    for row in recent_items:
        if row.shopify_sku and row.shopify_sku not in title_lookup:
            title_lookup[row.shopify_sku] = row.product_title

    # 4. Get orders for this warehouse based on scope
    if order_scope == "all":
        scope_statuses = {"not_processed", *COMMITTED_STATUSES}
    else:
        scope_statuses = {"staged"}
    open_orders = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.assigned_warehouse == warehouse,
        models.ShopifyOrder.app_status.in_(list(scope_statuses)),
    ).all()

    # 5. For orders that have a fulfillment plan with non-cancelled boxes,
    #    use actual box items (already in pick units) as the ground truth.
    #    For orders with no plan or empty plan, fall back to line items × SKU mapping.
    open_order_ids = [o.shopify_order_id for o in open_orders]
    plans = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id.in_(open_order_ids)
    ).all()

    # Build a map: order_id → { pick_sku → { shopify_sku, total_qty } }
    order_box_demand: dict[str, dict] = {}
    for plan in plans:
        non_cancelled_boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.status.notin_(["cancelled"]),
        ).all()
        if not non_cancelled_boxes:
            continue
        box_ids = [b.id for b in non_cancelled_boxes]
        box_items = db.query(models.BoxLineItem).filter(
            models.BoxLineItem.box_id.in_(box_ids),
        ).all()
        if not box_items:
            continue
        # Aggregate by pick_sku, keeping a representative shopify_sku
        sku_agg: dict[str, dict] = {}
        for item in box_items:
            if not item.pick_sku:
                continue
            if item.pick_sku not in sku_agg:
                sku_agg[item.pick_sku] = {"units": 0.0, "shopify_sku": item.shopify_sku or item.pick_sku}
            sku_agg[item.pick_sku]["units"] += item.quantity
        if sku_agg:
            order_box_demand[plan.shopify_order_id] = sku_agg

    orders_with_plan = set(order_box_demand.keys())

    # 5c. Get current inventory for this warehouse (needed for health filtering)
    inv_map: dict[str, models.InventoryItem] = {}
    for item in db.query(models.InventoryItem).filter(
        models.InventoryItem.warehouse == warehouse
    ).all():
        inv_map[item.pick_sku] = item

    # 5d. If health_filter is set, classify each order and restrict the list
    if health_filter in ("ok", "errors"):
        def _order_has_shortage(order_id: str) -> bool:
            if order_id not in orders_with_plan:
                return False  # no plan → treat as ok (no demand to check)
            for pick, agg in order_box_demand[order_id].items():
                on_hand = inv_map[pick].on_hand_qty if pick in inv_map else 0.0
                if on_hand < agg["units"]:
                    return True
            return False

        if health_filter == "errors":
            open_orders = [o for o in open_orders if _order_has_shortage(o.shopify_order_id)]
        else:  # ok
            open_orders = [o for o in open_orders if not _order_has_shortage(o.shopify_order_id)]

    # 5b. Aggregate demand per pick_sku
    #    demand_detail: { pick_sku: { shopify_sku: { units: float, mix_quantity: float } } }
    demand_detail: dict[str, dict] = {}
    affected_orders: dict[str, set] = {}

    for order in open_orders:
        order_id = order.shopify_order_id

        if order_id in orders_with_plan:
            # Use actual box items for this order
            for pick, agg in order_box_demand[order_id].items():
                shopify_sku = agg["shopify_sku"]
                if pick not in demand_detail:
                    demand_detail[pick] = {}
                    affected_orders[pick] = set()
                if shopify_sku not in demand_detail[pick]:
                    demand_detail[pick][shopify_sku] = {"units": 0.0, "mix_quantity": 1.0}
                demand_detail[pick][shopify_sku]["units"] += agg["units"]
                affected_orders[pick].add(order_id)
        else:
            # Fall back to line items × SKU mapping
            line_items = db.query(models.ShopifyLineItem).filter(
                models.ShopifyLineItem.shopify_order_id == order_id,
            ).all()
            for li in line_items:
                if not li.shopify_sku:
                    continue
                if li.app_line_status == 'short_ship':
                    continue
                mappings = sku_lookup.get(li.shopify_sku, [])
                for m in mappings:
                    pick = m.get("pick_sku")
                    if not pick:
                        continue
                    mix = m.get("mix_quantity") or 1.0
                    qty = (li.fulfillable_quantity if li.fulfillable_quantity is not None
                           else li.quantity)
                    units = qty * mix
                    if pick not in demand_detail:
                        demand_detail[pick] = {}
                        affected_orders[pick] = set()
                    shopify_sku = li.shopify_sku
                    if shopify_sku not in demand_detail[pick]:
                        demand_detail[pick][shopify_sku] = {"units": 0.0, "mix_quantity": mix}
                    demand_detail[pick][shopify_sku]["units"] += units
                    affected_orders[pick].add(order_id)

    # 6. inv_map already built in step 5c above

    # 7. Build result — include all pick SKUs that have demand
    result = []
    all_pick_skus = set(demand_detail.keys())

    for pick_sku in all_pick_skus:
        inv = inv_map.get(pick_sku)
        available = inv.available_qty if inv else 0.0
        on_hand = inv.on_hand_qty if inv else 0.0
        committed = inv.committed_qty if inv else 0.0
        name = inv.name if inv else None

        total_demand = sum(v["units"] for v in demand_detail[pick_sku].values())
        shortfall = max(0.0, total_demand - on_hand)

        breakdown = []
        for shopify_sku, detail in demand_detail[pick_sku].items():
            breakdown.append(schemas.ShopifySkuBreakdown(
                shopify_sku=shopify_sku,
                product_title=title_lookup.get(shopify_sku),
                mix_quantity=detail["mix_quantity"],
                units_demanded=detail["units"],
            ))
        # Sort breakdown by units demanded desc
        breakdown.sort(key=lambda x: x.units_demanded, reverse=True)

        result.append(schemas.DemandAnalysisItem(
            pick_sku=pick_sku,
            name=name,
            available_qty=available,
            on_hand_qty=on_hand,
            committed_qty=committed,
            total_demand=total_demand,
            shortfall=shortfall,
            affected_order_count=len(affected_orders[pick_sku]),
            shopify_sku_breakdown=breakdown,
        ))

    # Sort by shortfall desc (most critical first), then by total_demand desc
    result.sort(key=lambda x: (-x.shortfall, -x.total_demand))
    return result


@router.get("/staged-shortages")
def staged_shortages(
    warehouse: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """
    For each staged order (optionally filtered by warehouse), check whether
    its non-cancelled/shipped box items can be fulfilled given current on_hand_qty.
    Returns a list of per-order shortage info.
    """
    q = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.app_status == "staged"
    )
    if warehouse:
        q = q.filter(models.ShopifyOrder.assigned_warehouse == warehouse)
    orders = q.all()

    if not orders:
        return []

    order_ids = [o.shopify_order_id for o in orders]
    order_map = {o.shopify_order_id: o for o in orders}

    # Plans for these orders
    plans = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id.in_(order_ids),
        models.FulfillmentPlan.status.notin_(["cancelled"]),
    ).all()
    plan_map = {p.shopify_order_id: p for p in plans}

    # Boxes for these plans (exclude cancelled and already shipped)
    plan_ids = [p.id for p in plans]
    boxes = []
    if plan_ids:
        boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id.in_(plan_ids),
            models.FulfillmentBox.status.notin_(["cancelled", "shipped"]),
        ).all()

    box_ids = [b.id for b in boxes]
    plan_to_boxes: dict = {}
    for b in boxes:
        plan_to_boxes.setdefault(b.plan_id, []).append(b)

    # Box line items
    all_box_items = []
    if box_ids:
        all_box_items = db.query(models.BoxLineItem).filter(
            models.BoxLineItem.box_id.in_(box_ids)
        ).all()
    box_to_items: dict = {}
    for item in all_box_items:
        box_to_items.setdefault(item.box_id, []).append(item)

    # Inventory (all warehouses) — use a mutable copy so we can track
    # remaining inventory as we allocate across orders cumulatively.
    remaining: dict = {}  # (pick_sku, warehouse) -> remaining qty
    for inv in db.query(models.InventoryItem).all():
        remaining[(inv.pick_sku, inv.warehouse)] = inv.on_hand_qty

    results = []
    for order in orders:
        plan = plan_map.get(order.shopify_order_id)
        if not plan:
            results.append({
                "shopify_order_id": order.shopify_order_id,
                "shopify_order_number": order.shopify_order_number,
                "has_shortage": False,
                "no_plan": True,
                "shortage_skus": [],
            })
            continue

        plan_boxes = plan_to_boxes.get(plan.id, [])

        # Aggregate needed quantities per pick_sku across all pending boxes
        needed: dict = {}
        for box in plan_boxes:
            for item in box_to_items.get(box.id, []):
                if item.pick_sku:
                    needed[item.pick_sku] = needed.get(item.pick_sku, 0.0) + item.quantity

        if not needed:
            results.append({
                "shopify_order_id": order.shopify_order_id,
                "shopify_order_number": order.shopify_order_number,
                "has_shortage": False,
                "no_plan": False,
                "shortage_skus": [],
            })
            continue

        shortage_skus = []
        for pick_sku, qty_needed in needed.items():
            key = (pick_sku, order.assigned_warehouse)
            avail = remaining.get(key, 0.0)
            if avail < qty_needed:
                shortage_skus.append({
                    "pick_sku": pick_sku,
                    "available": round(avail, 2),
                    "needed": round(qty_needed, 2),
                })
            # Deduct this order's demand from remaining inventory
            remaining[key] = avail - qty_needed

        results.append({
            "shopify_order_id": order.shopify_order_id,
            "shopify_order_number": order.shopify_order_number,
            "has_shortage": len(shortage_skus) > 0,
            "no_plan": False,
            "shortage_skus": shortage_skus,
        })

    return results
