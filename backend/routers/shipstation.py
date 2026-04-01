"""
ShipStation router — push orders to ShipStation and sync fulfillment status.

All endpoints return 503 if ShipStation credentials are not configured.
"""
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from services import shipstation_service

router = APIRouter()


def _require_configured():
    if not shipstation_service.is_configured():
        raise HTTPException(
            status_code=503,
            detail="ShipStation not configured. Set SS_API_KEY and SS_API_SECRET in .env"
        )


# ── Status ────────────────────────────────────────────────────────────────────

@router.get("/status", response_model=schemas.ShipStationStatusOut)
def get_status():
    status = shipstation_service.get_status()
    return schemas.ShipStationStatusOut(
        configured=status["configured"],
        message=status["message"],
    )


# ── Push single order ─────────────────────────────────────────────────────────

@router.post("/push/{shopify_order_id}", response_model=schemas.ShopifyOrderOut)
def push_order(shopify_order_id: str, db: Session = Depends(get_db)):
    """
    Push one order to ShipStation. Sets app_status → in_shipstation_not_shipped.
    """
    _require_configured()

    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == shopify_order_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if order.app_status not in ("staged",):
        raise HTTPException(
            status_code=409,
            detail=f"Order is '{order.app_status}' — only 'staged' orders can be pushed to ShipStation"
        )

    # Check active hold rules against order tags
    order_tags = {t.strip().lower() for t in (order.tags or "").split(",") if t.strip()}
    if order_tags:
        hold_rules = db.query(models.OrderRule).filter(
            models.OrderRule.action == "hold",
            models.OrderRule.is_active == True,
        ).all()
        for rule in hold_rules:
            if rule.tag.lower() in order_tags:
                raise HTTPException(
                    status_code=409,
                    detail=f"Order is on hold — tag '{rule.tag}' matches an active hold rule. Remove the tag or disable the rule to push."
                )

    # Check that no pick_sku would go negative on_hand after shipping this order
    all_line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == shopify_order_id,
        models.ShopifyLineItem.sku_mapped == True,
    ).all()
    order_demand: dict[str, float] = {}
    for li in all_line_items:
        if not li.pick_sku:
            continue
        qty = (li.fulfillable_quantity if li.fulfillable_quantity is not None else li.quantity)
        order_demand[li.pick_sku] = order_demand.get(li.pick_sku, 0.0) + qty * (li.mix_quantity or 1.0)
    negative_skus = []
    for pick_sku, qty_needed in order_demand.items():
        inv = db.query(models.InventoryItem).filter(
            models.InventoryItem.pick_sku == pick_sku,
            models.InventoryItem.warehouse == order.assigned_warehouse,
        ).first()
        on_hand = inv.on_hand_qty if inv else 0.0
        if on_hand - qty_needed < 0:
            negative_skus.append(f"{pick_sku} (have {on_hand:.1f}, need {qty_needed:.1f})")
    if negative_skus:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot push: shipping this order would result in negative inventory for: {', '.join(negative_skus)}"
        )

    line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == shopify_order_id
    ).all()

    try:
        ss_result = shipstation_service.push_order(order, line_items)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ShipStation error: {str(e)}")

    # Store ShipStation order ID and update status
    order.shipstation_order_id = str(ss_result.get("orderId", ""))
    order.shipstation_order_key = ss_result.get("orderKey", "")
    order.app_status = "in_shipstation_not_shipped"
    order.last_synced_at = datetime.now(timezone.utc)

    from routers.inventory import _recompute_committed, _auto_deduct_on_ship
    db.flush()
    _auto_deduct_on_ship(order, db)  # Deduct on_hand at push time
    _recompute_committed(order.assigned_warehouse, db)
    db.commit()
    db.refresh(order)

    line_items_out = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == shopify_order_id
    ).all()

    return schemas.ShopifyOrderOut(
        **{c.name: getattr(order, c.name) for c in order.__table__.columns},
        line_items=[schemas.LineItemOut.model_validate(li) for li in line_items_out],
    )


# ── Push batch ────────────────────────────────────────────────────────────────

@router.post("/push-batch")
def push_batch(body: schemas.ShipStationPushBatchRequest, db: Session = Depends(get_db)):
    """
    Push multiple orders to ShipStation at once.
    Returns per-order results.
    """
    _require_configured()

    results = []
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
                "error": f"Order is '{order.app_status}' — only 'staged' orders can be pushed to ShipStation",
            })
            continue

        # Check active hold rules against order tags
        order_tags = {t.strip().lower() for t in (order.tags or "").split(",") if t.strip()}
        if order_tags:
            hold_rules = db.query(models.OrderRule).filter(
                models.OrderRule.action == "hold",
                models.OrderRule.is_active == True,
            ).all()
            held_by = next((r.tag for r in hold_rules if r.tag.lower() in order_tags), None)
            if held_by:
                results.append({
                    "order_id": order_id,
                    "success": False,
                    "error": f"On hold — tag '{held_by}' matches an active hold rule",
                })
                continue

        # Check negative balance before push
        batch_line_items = db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == order_id,
            models.ShopifyLineItem.sku_mapped == True,
        ).all()
        batch_demand: dict[str, float] = {}
        for li in batch_line_items:
            if not li.pick_sku:
                continue
            qty = (li.fulfillable_quantity if li.fulfillable_quantity is not None else li.quantity)
            batch_demand[li.pick_sku] = batch_demand.get(li.pick_sku, 0.0) + qty * (li.mix_quantity or 1.0)
        negative_skus = []
        for pick_sku, qty_needed in batch_demand.items():
            inv = db.query(models.InventoryItem).filter(
                models.InventoryItem.pick_sku == pick_sku,
                models.InventoryItem.warehouse == order.assigned_warehouse,
            ).first()
            on_hand = inv.on_hand_qty if inv else 0.0
            if on_hand - qty_needed < 0:
                negative_skus.append(f"{pick_sku} (have {on_hand:.1f}, need {qty_needed:.1f})")
        if negative_skus:
            results.append({
                "order_id": order_id,
                "success": False,
                "error": f"Negative inventory would result for: {', '.join(negative_skus)}",
            })
            continue

        line_items = db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == order_id
        ).all()

        try:
            ss_result = shipstation_service.push_order(order, line_items)
            order.shipstation_order_id = str(ss_result.get("orderId", ""))
            order.shipstation_order_key = ss_result.get("orderKey", "")
            order.app_status = "in_shipstation_not_shipped"
            order.last_synced_at = datetime.now(timezone.utc)
            db.flush()
            from routers.inventory import _auto_deduct_on_ship
            _auto_deduct_on_ship(order, db)  # Deduct on_hand at push time
            results.append({
                "order_id": order_id,
                "success": True,
                "shipstation_order_id": order.shipstation_order_id,
            })
        except Exception as e:
            results.append({"order_id": order_id, "success": False, "error": str(e)})

    # Recompute committed for all affected warehouses
    warehouses = {
        db.query(models.ShopifyOrder.assigned_warehouse)
        .filter(models.ShopifyOrder.shopify_order_id.in_(body.order_ids))
        .distinct()
        .all()
    }
    from routers.inventory import _recompute_committed
    for (wh,) in db.query(models.ShopifyOrder.assigned_warehouse).filter(
        models.ShopifyOrder.shopify_order_id.in_(body.order_ids)
    ).distinct().all():
        _recompute_committed(wh, db)

    db.commit()

    pushed = sum(1 for r in results if r["success"])
    return {
        "pushed": pushed,
        "failed": len(results) - pushed,
        "results": results,
    }


# ── Check for duplicate unshipped orders in ShipStation ──────────────────────

@router.post("/check-duplicates")
def check_duplicates(db: Session = Depends(get_db)):
    """
    Pull all unshipped orders from ShipStation and match them against orders
    in the app by order number. Sets ss_duplicate=True on matches, clears it
    on orders that are no longer found in ShipStation.
    """
    _require_configured()

    import re

    try:
        ss_orders = shipstation_service.get_unshipped_orders()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ShipStation error: {str(e)}")

    # Extract base order numbers from ShipStation (strip leading # and any -Box suffix)
    ss_order_numbers: set[str] = set()
    for ss_order in ss_orders:
        raw = ss_order.get("orderNumber", "")
        # Strip leading '#'
        num = raw.lstrip("#").strip()
        # Extract base number (before any -Box suffix the app may have added)
        base = re.split(r"-[Bb]ox\d*", num)[0]
        if base:
            ss_order_numbers.add(base)

    # Match against all app orders that are not yet shipped/fulfilled
    app_orders = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.app_status.in_(["not_processed", "staged", "partially_fulfilled"]),
    ).all()

    flagged = 0
    cleared = 0
    for order in app_orders:
        order_num = (order.shopify_order_number or "").lstrip("#").strip()
        is_dup = order_num in ss_order_numbers
        if is_dup and not order.ss_duplicate:
            order.ss_duplicate = True
            flagged += 1
        elif not is_dup and order.ss_duplicate:
            order.ss_duplicate = False
            cleared += 1

    db.commit()

    return {
        "ss_unshipped_count": len(ss_order_numbers),
        "duplicates_flagged": flagged,
        "duplicates_cleared": cleared,
        "ss_order_numbers": sorted(ss_order_numbers),
    }


# ── Estimated delivery (pre-push rate quote) ─────────────────────────────────

@router.get("/estimated-delivery/{shopify_order_id}")
def get_estimated_delivery(shopify_order_id: str, db: Session = Depends(get_db)):
    """
    Get estimated delivery date for an order before pushing to ShipStation.
    Resolves carrier/service via rules, computes weight from line items,
    then calls ShipStation /shipments/getrates.
    """
    _require_configured()

    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == shopify_order_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    # Resolve carrier/service from rules
    from routers.fulfillment import _apply_carrier_service_rules
    carrier_match = _apply_carrier_service_rules(order, db)
    if not carrier_match:
        raise HTTPException(status_code=422, detail="No carrier service rule matched for this order")

    carrier_code = carrier_match["carrier_code"]
    service_code = carrier_match["service_code"]

    # Compute weight from line items (pick_weight_lb × quantity × 16 oz/lb)
    line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == shopify_order_id,
        models.ShopifyLineItem.sku_mapped == True,
        models.ShopifyLineItem.pick_sku.isnot(None),
    ).all()

    total_weight_oz = 0.0
    for li in line_items:
        qty = li.fulfillable_quantity if li.fulfillable_quantity is not None else li.quantity
        units = qty * (li.mix_quantity or 1.0)
        sku_map = db.query(models.SkuMapping).filter(
            models.SkuMapping.shopify_sku == li.shopify_sku,
            models.SkuMapping.warehouse == order.assigned_warehouse,
            models.SkuMapping.is_active == True,
        ).first()
        if sku_map and sku_map.pick_weight_lb:
            total_weight_oz += sku_map.pick_weight_lb * units * 16.0

    # Fall back to Shopify's total_weight_g if no pick weights available
    if total_weight_oz == 0 and order.total_weight_g:
        total_weight_oz = order.total_weight_g * 0.03527396  # g → oz

    if total_weight_oz == 0:
        total_weight_oz = 16.0  # 1 lb default

    # Get origin postal code
    from_postal = shipstation_service._get_from_postal(order.assigned_warehouse)
    if not from_postal:
        raise HTTPException(status_code=422, detail="Origin postal code not configured — set WALNUT_FROM_ZIP / NORTHLAKE_FROM_ZIP in .env")

    try:
        result = shipstation_service.get_rates(
            carrier_code=carrier_code,
            service_code=service_code,
            from_postal=from_postal,
            to_postal=order.shipping_zip or "",
            to_state=order.shipping_province or "",
            to_country=order.shipping_country or "US",
            weight_oz=total_weight_oz,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ShipStation getrates error: {str(e)}")

    return {
        **result,
        "weight_oz": round(total_weight_oz, 2),
        "from_postal": from_postal,
        "rule_name": carrier_match["rule_name"],
    }


# ── Sync (poll ShipStation for updates) ──────────────────────────────────────

@router.post("/sync", response_model=schemas.ShipStationSyncResult)
def sync(db: Session = Depends(get_db)):
    """
    Poll ShipStation for all in-flight orders. Update status to
    in_shipstation_shipped if ShipStation reports them shipped.
    Auto-deducts inventory and logs adjustments.
    """
    _require_configured()

    try:
        result = shipstation_service.sync_in_flight_orders(db)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ShipStation sync error: {str(e)}")

    return schemas.ShipStationSyncResult(
        synced=result["synced"],
        shipped=result["shipped"],
        errors=result["errors"],
    )
