"""
Packaging Dashboard — usage analytics + reorder recommendations for packaging SKUs.

Computes weekly burn rate from `inventory_adjustments` rows where
adjustment_type='ship_deduct', then projects weeks-of-cover and order qty
needed to reach a target weeks-of-supply.
"""
import math
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
import models

router = APIRouter()


@router.get("/")
def packaging_dashboard(
    warehouse: str = Query("walnut", description="Warehouse code"),
    lookback_days: int = Query(30, ge=7, le=180, description="Days of history to compute weekly avg"),
    alert_weeks: float = Query(2.0, ge=0.1, le=52, description="Alert threshold — red when weeks_of_cover < this"),
    target_weeks: float = Query(4.0, ge=0.1, le=52, description="Target weeks of cover for purchase recommendation"),
    db: Session = Depends(get_db),
):
    """
    Per-packaging-SKU usage report.

    For each PicklistSku where inventory_type='packaging' that has an
    InventoryItem in the requested warehouse, returns:
      - on_hand_qty
      - units_used (sum of |delta| from ship_deduct adjustments in lookback window)
      - weekly_avg (units_used × 7 / lookback_days)
      - weeks_of_cover (on_hand / weekly_avg, or None if weekly_avg == 0)
      - alert_level: 'critical' (< alert_weeks), 'warn' (< target_weeks), 'ok' otherwise
      - order_qty_for_target_weeks: max(0, ceil(weekly_avg × target_weeks − on_hand))

    Total `units_used` includes all deductions logged with adjustment_type='ship_deduct'
    — this captures BOTH per-box deductions (BoxType.pick_sku) and per-product-unit
    deductions (PackagingMapping), since both write the same audit log entry.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

    # Pull all packaging PicklistSkus
    pkg_skus = db.query(models.PicklistSku).filter(
        models.PicklistSku.inventory_type == 'packaging'
    ).all()
    pkg_sku_set = [p.pick_sku for p in pkg_skus]

    if not pkg_sku_set:
        return {
            "warehouse": warehouse,
            "lookback_days": lookback_days,
            "alert_weeks": alert_weeks,
            "target_weeks": target_weeks,
            "items": [],
        }

    # Inventory rows for this warehouse, indexed by pick_sku
    inv_rows = db.query(models.InventoryItem).filter(
        models.InventoryItem.warehouse == warehouse,
        models.InventoryItem.pick_sku.in_(pkg_sku_set),
    ).all()
    inv_by_sku = {i.pick_sku: i for i in inv_rows}

    # Bulk usage query — sum of |delta| per pick_sku in window
    usage_rows = (
        db.query(
            models.InventoryAdjustment.pick_sku,
            func.sum(func.abs(models.InventoryAdjustment.delta)).label("used"),
        )
        .filter(
            models.InventoryAdjustment.warehouse == warehouse,
            models.InventoryAdjustment.adjustment_type == 'ship_deduct',
            models.InventoryAdjustment.created_at >= cutoff,
            models.InventoryAdjustment.pick_sku.in_(pkg_sku_set),
        )
        .group_by(models.InventoryAdjustment.pick_sku)
        .all()
    )
    used_by_sku = {row[0]: float(row[1] or 0.0) for row in usage_rows}

    items = []
    for p in pkg_skus:
        inv = inv_by_sku.get(p.pick_sku)
        on_hand = inv.on_hand_qty if inv else 0.0
        used = used_by_sku.get(p.pick_sku, 0.0)
        weekly_avg = (used * 7.0 / lookback_days) if lookback_days > 0 else 0.0
        if weekly_avg > 0:
            weeks_of_cover = on_hand / weekly_avg
        else:
            weeks_of_cover = None  # no usage history; can't compute cover

        # Alert level
        if weeks_of_cover is None:
            alert_level = "no_data"
        elif weeks_of_cover < alert_weeks:
            alert_level = "critical"
        elif weeks_of_cover < target_weeks:
            alert_level = "warn"
        else:
            alert_level = "ok"

        # Reorder qty to hit target weeks
        target_units = weekly_avg * target_weeks
        order_qty = max(0, math.ceil(target_units - on_hand))

        items.append({
            "pick_sku": p.pick_sku,
            "description": p.customer_description,
            "category": p.category,
            "on_hand_qty": on_hand,
            "units_used": used,
            "weekly_avg": round(weekly_avg, 2),
            "weeks_of_cover": round(weeks_of_cover, 2) if weeks_of_cover is not None else None,
            "alert_level": alert_level,
            "order_qty_for_target_weeks": order_qty,
        })

    # Sort: critical first (most urgent), then by ascending weeks_of_cover, with
    # no_data SKUs sinking to the bottom.
    sort_rank = {"critical": 0, "warn": 1, "ok": 2, "no_data": 3}
    items.sort(key=lambda it: (sort_rank[it["alert_level"]], it["weeks_of_cover"] if it["weeks_of_cover"] is not None else float("inf")))

    return {
        "warehouse": warehouse,
        "lookback_days": lookback_days,
        "alert_weeks": alert_weeks,
        "target_weeks": target_weeks,
        "items": items,
    }
