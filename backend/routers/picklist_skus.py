from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database import get_db
import models
from routers.inventory import sync_inventory_with_picklist
from services import sheets_service

router = APIRouter()


class PicklistSkuUpdate(BaseModel):
    customer_description: Optional[str] = None
    weight_lb: Optional[float] = None
    pactor_multiplier: Optional[float] = None
    pactor: Optional[float] = None
    temperature: Optional[str] = None
    type: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    cc_item_id: Optional[str] = None
    notes: Optional[str] = None
    days_til_expiration: Optional[float] = None
    cost_per_lb: Optional[float] = None
    cost_per_case: Optional[float] = None
    case_weight_lb: Optional[float] = None


def _to_dict(item: models.PicklistSku) -> dict:
    return {
        "id": item.id,
        "pick_sku": item.pick_sku,
        "customer_description": item.customer_description,
        "weight_lb": item.weight_lb,
        "pactor_multiplier": item.pactor_multiplier,
        "pactor": item.pactor,
        "temperature": item.temperature,
        "type": item.type,
        "category": item.category,
        "status": item.status,
        "cc_item_id": item.cc_item_id,
        "notes": item.notes,
        "days_til_expiration": item.days_til_expiration,
        "cost_per_lb": item.cost_per_lb,
        "cost_per_case": item.cost_per_case,
        "case_weight_lb": item.case_weight_lb,
        "synced_at": item.synced_at.isoformat() if item.synced_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


ACTIVE_STATUSES = ['not_processed', 'staged', 'partially_fulfilled', 'needs_plan', 'plan_mismatch', 'no_box_rule']


@router.get("/missing-cogs")
def get_missing_cogs_skus(db: Session = Depends(get_db)):
    """
    Returns PicklistSKUs that have weight_lb set (used in margin calc) but are missing
    cost data, along with how many active orders are affected.
    """
    missing = db.query(models.PicklistSku).filter(
        models.PicklistSku.weight_lb.isnot(None),
        models.PicklistSku.cost_per_lb.is_(None),
        or_(
            models.PicklistSku.cost_per_case.is_(None),
            models.PicklistSku.case_weight_lb.is_(None),
        )
    ).all()

    if not missing:
        return []

    results = []
    for sku_rec in missing:
        affected = (
            db.query(models.ShopifyOrder)
            .join(
                models.ShopifyLineItem,
                models.ShopifyLineItem.shopify_order_id == models.ShopifyOrder.shopify_order_id,
            )
            .filter(
                models.ShopifyLineItem.pick_sku == sku_rec.pick_sku,
                models.ShopifyOrder.app_status.in_(ACTIVE_STATUSES),
            )
            .distinct(models.ShopifyOrder.shopify_order_id)
            .all()
        )
        order_count = len(affected)
        revenue_at_risk = sum(o.total_price or 0 for o in affected)
        row = _to_dict(sku_rec)
        row["affected_order_count"] = order_count
        row["revenue_at_risk"] = revenue_at_risk
        results.append(row)

    results.sort(key=lambda x: x["affected_order_count"], reverse=True)
    return results


@router.get("/")
def list_picklist_skus(
    search: Optional[str] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    q = db.query(models.PicklistSku)
    if search:
        s = f"%{search}%"
        q = q.filter(
            models.PicklistSku.pick_sku.ilike(s) |
            models.PicklistSku.customer_description.ilike(s)
        )
    total = q.count()
    items = q.order_by(models.PicklistSku.customer_description).offset(skip).limit(limit).all()
    return {"total": total, "items": [_to_dict(i) for i in items]}


@router.post("/sync")
def sync_from_sheets(db: Session = Depends(get_db)):
    """Re-pull picklist SKU table from Google Sheets into the database."""
    if not sheets_service.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured.")
    try:
        rows = sheets_service.pull_picklist_skus()
        margin_map = sheets_service.pull_blended_product_margins()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    now = datetime.now(timezone.utc)
    created = updated = 0
    seen_skus = set()

    for row in rows:
        sku = row["pick_sku"]
        seen_skus.add(sku)
        # Auto-fill cost_per_lb from BLENDED PRODUCT MARGIN if Pick Type matches
        pick_type = row.get("type")
        if pick_type and pick_type in margin_map:
            row["cost_per_lb"] = margin_map[pick_type]
        existing = db.query(models.PicklistSku).filter_by(pick_sku=sku).first()
        if existing:
            for k, v in row.items():
                setattr(existing, k, v)
            existing.synced_at = now
            updated += 1
        else:
            db.add(models.PicklistSku(**row, synced_at=now))
            created += 1

    db.commit()
    # Invalidate the in-memory pactor cache so fulfillment rules re-read from DB
    sheets_service.invalidate("picklist_pactors")

    # Mirror new picklist SKUs into inventory (per-warehouse, qty=0).
    inv_result = sync_inventory_with_picklist(db)
    db.commit()

    return {
        "created": created,
        "updated": updated,
        "total": len(rows),
        "inventory_created": inv_result["created"],
    }


@router.put("/{item_id}")
def update_picklist_sku(
    item_id: int,
    data: PicklistSkuUpdate,
    db: Session = Depends(get_db),
):
    item = db.query(models.PicklistSku).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    db.commit()
    db.refresh(item)
    return _to_dict(item)
