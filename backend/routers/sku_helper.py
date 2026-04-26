"""
CRUD + sheet-import endpoints for the Shopify-SKU → helper-SKU table.

The helper map normalizes Shopify SKU variants (e.g. `f.passionfruit_purple-5lb_2`,
`f.passionfruit_purple-5lb_pos`) onto a single canonical SKU
(`f.passionfruit_purple-5lb`). Downstream lookups (warehouse SKU mapping, projection
demand attribution, fulfillment plan resolution) try the variant first, then fall
back to the helper. Without this, every Shopify variant would need its own
SkuMapping row — and unmapped variants get silently dropped from projections.

The DB is the source of truth. `POST /sync` does a one-way pull from the
INPUT_SKU_TYPE Google Sheet for one-time / occasional refresh.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import get_db
import models
from services import sheets_service

router = APIRouter()


class SkuHelperCreate(BaseModel):
    shopify_sku: str = Field(..., min_length=1)
    helper_sku: str = Field(..., min_length=1)
    notes: Optional[str] = None


class SkuHelperUpdate(BaseModel):
    helper_sku: Optional[str] = Field(None, min_length=1)
    notes: Optional[str] = None


def _to_dict(item: models.SkuHelperMapping) -> dict:
    return {
        "id": item.id,
        "shopify_sku": item.shopify_sku,
        "helper_sku": item.helper_sku,
        "notes": item.notes,
        "synced_at": item.synced_at.isoformat() if item.synced_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


@router.get("/")
def list_helpers(
    search: Optional[str] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    q = db.query(models.SkuHelperMapping)
    if search:
        s = f"%{search}%"
        q = q.filter(
            models.SkuHelperMapping.shopify_sku.ilike(s) |
            models.SkuHelperMapping.helper_sku.ilike(s)
        )
    total = q.count()
    items = q.order_by(models.SkuHelperMapping.shopify_sku).offset(skip).limit(limit).all()
    return {"total": total, "items": [_to_dict(i) for i in items]}


@router.post("/")
def create_helper(body: SkuHelperCreate, db: Session = Depends(get_db)):
    existing = db.query(models.SkuHelperMapping).filter(
        models.SkuHelperMapping.shopify_sku == body.shopify_sku
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"shopify_sku '{body.shopify_sku}' already exists")
    item = models.SkuHelperMapping(
        shopify_sku=body.shopify_sku,
        helper_sku=body.helper_sku,
        notes=body.notes,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    sheets_service.invalidate("sku_type_data")
    return _to_dict(item)


@router.put("/{item_id}")
def update_helper(item_id: int, body: SkuHelperUpdate, db: Session = Depends(get_db)):
    item = db.query(models.SkuHelperMapping).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    db.commit()
    db.refresh(item)
    sheets_service.invalidate("sku_type_data")
    return _to_dict(item)


@router.delete("/{item_id}")
def delete_helper(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.SkuHelperMapping).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(item)
    db.commit()
    sheets_service.invalidate("sku_type_data")
    return {"detail": "deleted"}


@router.post("/sync")
def sync_from_sheet(db: Session = Depends(get_db)):
    """
    Pull the helper column from the INPUT_SKU_TYPE Google Sheet and upsert into
    the DB. New rows are inserted; rows where the helper changed are updated.
    Existing rows whose shopify_sku is no longer in the sheet are LEFT ALONE
    (we don't delete UI-added entries on sync).
    """
    if not sheets_service.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured.")
    try:
        sheets_service.invalidate("sku_type_data")
        helper_map = sheets_service._sheet_helper_map_raw()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    now = datetime.now(timezone.utc)
    created = updated = unchanged = 0

    for shopify_sku, helper_sku in helper_map.items():
        existing = db.query(models.SkuHelperMapping).filter(
            models.SkuHelperMapping.shopify_sku == shopify_sku
        ).first()
        if existing:
            if existing.helper_sku != helper_sku:
                existing.helper_sku = helper_sku
                existing.synced_at = now
                updated += 1
            else:
                unchanged += 1
        else:
            db.add(models.SkuHelperMapping(
                shopify_sku=shopify_sku,
                helper_sku=helper_sku,
                synced_at=now,
            ))
            created += 1

    db.commit()
    sheets_service.invalidate("sku_type_data")
    return {
        "created": created,
        "updated": updated,
        "unchanged": unchanged,
        "total_in_sheet": len(helper_map),
    }
