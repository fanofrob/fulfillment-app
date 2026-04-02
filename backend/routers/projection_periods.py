"""
Projection Periods router — CRUD for projection periods and period-specific configs.

A projection period is a named time window (default Wed 12:00am → Tue 11:59pm)
with its own short-ship and inventory-hold SKU configurations.
"""
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from services import sheets_service

router = APIRouter()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _suggest_default_boundaries(reference_date: datetime = None):
    """Suggest default Wed 12:00am → Tue 11:59pm boundaries for the week containing reference_date."""
    if reference_date is None:
        reference_date = datetime.now(timezone.utc)
    # Find Wednesday (weekday=2) at midnight
    days_since_wed = (reference_date.weekday() - 2) % 7
    wed = reference_date - timedelta(days=days_since_wed)
    start = wed.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=6, hours=23, minutes=59, seconds=59)
    return start, end


# ── Period CRUD ──────────────────────────────────────────────────────────────

@router.get("/", response_model=List[schemas.ProjectionPeriodResponse])
def list_periods(
    status: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(models.ProjectionPeriod).order_by(models.ProjectionPeriod.start_datetime.desc())
    if status:
        q = q.filter(models.ProjectionPeriod.status == status)
    return q.all()


@router.get("/suggest-dates")
def suggest_dates():
    """Return default Wed-Tue boundaries for the current week and next week."""
    now = datetime.now(timezone.utc)
    s1, e1 = _suggest_default_boundaries(now)
    s2, e2 = _suggest_default_boundaries(now + timedelta(weeks=1))
    return {
        "current_week": {"start": s1.isoformat(), "end": e1.isoformat()},
        "next_week":    {"start": s2.isoformat(), "end": e2.isoformat()},
    }


@router.get("/{period_id}", response_model=schemas.ProjectionPeriodResponse)
def get_period(period_id: int, db: Session = Depends(get_db)):
    period = db.query(models.ProjectionPeriod).filter(models.ProjectionPeriod.id == period_id).first()
    if not period:
        raise HTTPException(status_code=404, detail="Period not found")
    return period


@router.post("/", response_model=schemas.ProjectionPeriodResponse)
def create_period(body: schemas.ProjectionPeriodCreate, db: Session = Depends(get_db)):
    if body.end_datetime <= body.start_datetime:
        raise HTTPException(status_code=400, detail="end_datetime must be after start_datetime")
    period = models.ProjectionPeriod(**body.model_dump())
    db.add(period)
    db.commit()
    db.refresh(period)
    return period


@router.put("/{period_id}", response_model=schemas.ProjectionPeriodResponse)
def update_period(period_id: int, body: schemas.ProjectionPeriodUpdate, db: Session = Depends(get_db)):
    period = db.query(models.ProjectionPeriod).filter(models.ProjectionPeriod.id == period_id).first()
    if not period:
        raise HTTPException(status_code=404, detail="Period not found")
    updates = body.model_dump(exclude_unset=True)
    for k, v in updates.items():
        setattr(period, k, v)
    if period.end_datetime <= period.start_datetime:
        raise HTTPException(status_code=400, detail="end_datetime must be after start_datetime")
    db.commit()
    db.refresh(period)
    return period


@router.delete("/{period_id}")
def delete_period(period_id: int, db: Session = Depends(get_db)):
    period = db.query(models.ProjectionPeriod).filter(models.ProjectionPeriod.id == period_id).first()
    if not period:
        raise HTTPException(status_code=404, detail="Period not found")
    if period.status == "active":
        raise HTTPException(status_code=400, detail="Cannot delete an active period. Close it first.")
    # Delete associated configs
    db.query(models.PeriodShortShipConfig).filter(models.PeriodShortShipConfig.period_id == period_id).delete()
    db.query(models.PeriodInventoryHoldConfig).filter(models.PeriodInventoryHoldConfig.period_id == period_id).delete()
    db.delete(period)
    db.commit()
    return {"deleted": True, "period_id": period_id}


# ── Short Ship Config ────────────────────────────────────────────────────────

@router.get("/{period_id}/short-ship", response_model=List[schemas.PeriodShortShipResponse])
def list_short_ship(period_id: int, db: Session = Depends(get_db)):
    _ensure_period(period_id, db)
    return (
        db.query(models.PeriodShortShipConfig)
        .filter(models.PeriodShortShipConfig.period_id == period_id)
        .order_by(models.PeriodShortShipConfig.shopify_sku)
        .all()
    )


@router.post("/{period_id}/short-ship", response_model=schemas.PeriodShortShipResponse)
def add_short_ship(period_id: int, body: schemas.PeriodConfigItem, db: Session = Depends(get_db)):
    _ensure_period(period_id, db)
    existing = (
        db.query(models.PeriodShortShipConfig)
        .filter(
            models.PeriodShortShipConfig.period_id == period_id,
            models.PeriodShortShipConfig.shopify_sku == body.shopify_sku,
        )
        .first()
    )
    if existing:
        return existing
    cfg = models.PeriodShortShipConfig(period_id=period_id, shopify_sku=body.shopify_sku)
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return cfg


@router.post("/{period_id}/short-ship/bulk", response_model=List[schemas.PeriodShortShipResponse])
def bulk_set_short_ship(period_id: int, body: List[schemas.PeriodConfigItem], db: Session = Depends(get_db)):
    """Replace all short-ship SKUs for this period."""
    _ensure_period(period_id, db)
    db.query(models.PeriodShortShipConfig).filter(models.PeriodShortShipConfig.period_id == period_id).delete()
    new_items = []
    for item in body:
        cfg = models.PeriodShortShipConfig(period_id=period_id, shopify_sku=item.shopify_sku)
        db.add(cfg)
        new_items.append(cfg)
    db.commit()
    for item in new_items:
        db.refresh(item)
    return new_items


@router.delete("/{period_id}/short-ship/{shopify_sku}")
def remove_short_ship(period_id: int, shopify_sku: str, db: Session = Depends(get_db)):
    deleted = (
        db.query(models.PeriodShortShipConfig)
        .filter(
            models.PeriodShortShipConfig.period_id == period_id,
            models.PeriodShortShipConfig.shopify_sku == shopify_sku,
        )
        .delete()
    )
    db.commit()
    return {"deleted": deleted > 0}


# ── Inventory Hold Config ────────────────────────────────────────────────────

@router.get("/{period_id}/inventory-hold", response_model=List[schemas.PeriodInventoryHoldResponse])
def list_inventory_hold(period_id: int, db: Session = Depends(get_db)):
    _ensure_period(period_id, db)
    return (
        db.query(models.PeriodInventoryHoldConfig)
        .filter(models.PeriodInventoryHoldConfig.period_id == period_id)
        .order_by(models.PeriodInventoryHoldConfig.shopify_sku)
        .all()
    )


@router.post("/{period_id}/inventory-hold", response_model=schemas.PeriodInventoryHoldResponse)
def add_inventory_hold(period_id: int, body: schemas.PeriodConfigItem, db: Session = Depends(get_db)):
    _ensure_period(period_id, db)
    existing = (
        db.query(models.PeriodInventoryHoldConfig)
        .filter(
            models.PeriodInventoryHoldConfig.period_id == period_id,
            models.PeriodInventoryHoldConfig.shopify_sku == body.shopify_sku,
        )
        .first()
    )
    if existing:
        return existing
    cfg = models.PeriodInventoryHoldConfig(period_id=period_id, shopify_sku=body.shopify_sku)
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return cfg


@router.post("/{period_id}/inventory-hold/bulk", response_model=List[schemas.PeriodInventoryHoldResponse])
def bulk_set_inventory_hold(period_id: int, body: List[schemas.PeriodConfigItem], db: Session = Depends(get_db)):
    """Replace all inventory-hold SKUs for this period."""
    _ensure_period(period_id, db)
    db.query(models.PeriodInventoryHoldConfig).filter(models.PeriodInventoryHoldConfig.period_id == period_id).delete()
    new_items = []
    for item in body:
        cfg = models.PeriodInventoryHoldConfig(period_id=period_id, shopify_sku=item.shopify_sku)
        db.add(cfg)
        new_items.append(cfg)
    db.commit()
    for item in new_items:
        db.refresh(item)
    return new_items


@router.delete("/{period_id}/inventory-hold/{shopify_sku}")
def remove_inventory_hold(period_id: int, shopify_sku: str, db: Session = Depends(get_db)):
    deleted = (
        db.query(models.PeriodInventoryHoldConfig)
        .filter(
            models.PeriodInventoryHoldConfig.period_id == period_id,
            models.PeriodInventoryHoldConfig.shopify_sku == shopify_sku,
        )
        .delete()
    )
    db.commit()
    return {"deleted": deleted > 0}


# ── Copy Configs Between Periods ─────────────────────────────────────────────

@router.post("/{period_id}/short-ship/copy")
def copy_short_ship(period_id: int, body: schemas.CopyConfigsRequest, db: Session = Depends(get_db)):
    """Copy short-ship config from source_period_id to this period. Merges (does not overwrite existing)."""
    _ensure_period(period_id, db)
    _ensure_period(body.source_period_id, db)
    source_skus = {
        r.shopify_sku
        for r in db.query(models.PeriodShortShipConfig).filter(
            models.PeriodShortShipConfig.period_id == body.source_period_id
        ).all()
    }
    existing_skus = {
        r.shopify_sku
        for r in db.query(models.PeriodShortShipConfig).filter(
            models.PeriodShortShipConfig.period_id == period_id
        ).all()
    }
    added = 0
    for sku in source_skus - existing_skus:
        db.add(models.PeriodShortShipConfig(period_id=period_id, shopify_sku=sku))
        added += 1
    db.commit()
    return {"copied": added, "already_existed": len(source_skus & existing_skus)}


@router.post("/{period_id}/inventory-hold/copy")
def copy_inventory_hold(period_id: int, body: schemas.CopyConfigsRequest, db: Session = Depends(get_db)):
    """Copy inventory-hold config from source_period_id to this period. Merges (does not overwrite existing)."""
    _ensure_period(period_id, db)
    _ensure_period(body.source_period_id, db)
    source_skus = {
        r.shopify_sku
        for r in db.query(models.PeriodInventoryHoldConfig).filter(
            models.PeriodInventoryHoldConfig.period_id == body.source_period_id
        ).all()
    }
    existing_skus = {
        r.shopify_sku
        for r in db.query(models.PeriodInventoryHoldConfig).filter(
            models.PeriodInventoryHoldConfig.period_id == period_id
        ).all()
    }
    added = 0
    for sku in source_skus - existing_skus:
        db.add(models.PeriodInventoryHoldConfig(period_id=period_id, shopify_sku=sku))
        added += 1
    db.commit()
    return {"copied": added, "already_existed": len(source_skus & existing_skus)}


# ── Config Diff ──────────────────────────────────────────────────────────────

@router.get("/{period_id}/short-ship/diff/{other_period_id}", response_model=schemas.ConfigDiffResponse)
def diff_short_ship(period_id: int, other_period_id: int, db: Session = Depends(get_db)):
    """Compare short-ship configs between two periods."""
    skus_a = {
        r.shopify_sku
        for r in db.query(models.PeriodShortShipConfig).filter(
            models.PeriodShortShipConfig.period_id == period_id
        ).all()
    }
    skus_b = {
        r.shopify_sku
        for r in db.query(models.PeriodShortShipConfig).filter(
            models.PeriodShortShipConfig.period_id == other_period_id
        ).all()
    }
    return {
        "only_in_source": sorted(skus_a - skus_b),
        "only_in_target": sorted(skus_b - skus_a),
        "in_both": sorted(skus_a & skus_b),
    }


@router.get("/{period_id}/inventory-hold/diff/{other_period_id}", response_model=schemas.ConfigDiffResponse)
def diff_inventory_hold(period_id: int, other_period_id: int, db: Session = Depends(get_db)):
    """Compare inventory-hold configs between two periods."""
    skus_a = {
        r.shopify_sku
        for r in db.query(models.PeriodInventoryHoldConfig).filter(
            models.PeriodInventoryHoldConfig.period_id == period_id
        ).all()
    }
    skus_b = {
        r.shopify_sku
        for r in db.query(models.PeriodInventoryHoldConfig).filter(
            models.PeriodInventoryHoldConfig.period_id == other_period_id
        ).all()
    }
    return {
        "only_in_source": sorted(skus_a - skus_b),
        "only_in_target": sorted(skus_b - skus_a),
        "in_both": sorted(skus_a & skus_b),
    }


# ── Copy from current global configs ────────────────────────────────────────

@router.post("/{period_id}/short-ship/import-global")
def import_global_short_ship(period_id: int, db: Session = Depends(get_db)):
    """Import current global short-ship config (from shopify_products) into this period."""
    _ensure_period(period_id, db)
    global_skus = {
        r.shopify_sku
        for r in db.query(models.ShopifyProduct).filter(
            models.ShopifyProduct.allow_short_ship == True
        ).all()
    }
    existing = {
        r.shopify_sku
        for r in db.query(models.PeriodShortShipConfig).filter(
            models.PeriodShortShipConfig.period_id == period_id
        ).all()
    }
    added = 0
    for sku in global_skus - existing:
        db.add(models.PeriodShortShipConfig(period_id=period_id, shopify_sku=sku))
        added += 1
    db.commit()
    return {"imported": added, "already_existed": len(global_skus & existing)}


@router.post("/{period_id}/inventory-hold/import-global")
def import_global_inventory_hold(period_id: int, db: Session = Depends(get_db)):
    """Import current global inventory-hold config (from shopify_products) into this period."""
    _ensure_period(period_id, db)
    global_skus = {
        r.shopify_sku
        for r in db.query(models.ShopifyProduct).filter(
            models.ShopifyProduct.inventory_hold == True
        ).all()
    }
    existing = {
        r.shopify_sku
        for r in db.query(models.PeriodInventoryHoldConfig).filter(
            models.PeriodInventoryHoldConfig.period_id == period_id
        ).all()
    }
    added = 0
    for sku in global_skus - existing:
        db.add(models.PeriodInventoryHoldConfig(period_id=period_id, shopify_sku=sku))
        added += 1
    db.commit()
    return {"imported": added, "already_existed": len(global_skus & existing)}


# ── Google Sheets Tab Integration ────────────────────────────────────────────

@router.get("/sheets/tabs")
def list_sheets_tabs():
    """List all worksheet tab names in the inventory spreadsheet (for period SKU mapping assignment)."""
    try:
        tabs = sheets_service.list_sheet_tabs()
        return {"tabs": tabs}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Could not read sheets: {e}")


@router.get("/{period_id}/sku-mappings")
def get_period_sku_mappings(
    period_id: int,
    search: Optional[str] = Query(None),
    skip: int = Query(0),
    limit: int = Query(500),
    db: Session = Depends(get_db),
):
    """Read SKU mappings from the period's assigned Google Sheets tab."""
    period = db.query(models.ProjectionPeriod).filter(models.ProjectionPeriod.id == period_id).first()
    if not period:
        raise HTTPException(status_code=404, detail="Period not found")
    if not period.sku_mapping_sheet_tab:
        return {"error": "No SKU mapping sheet tab assigned to this period", "mappings": []}
    try:
        mappings = sheets_service.get_period_sku_mappings(
            period.sku_mapping_sheet_tab, search=search, skip=skip, limit=limit
        )
        return {"tab": period.sku_mapping_sheet_tab, "mappings": mappings}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Could not read sheet tab '{period.sku_mapping_sheet_tab}': {e}")


# ── Internal helpers ─────────────────────────────────────────────────────────

def _ensure_period(period_id: int, db: Session):
    if not db.query(models.ProjectionPeriod).filter(models.ProjectionPeriod.id == period_id).first():
        raise HTTPException(status_code=404, detail=f"Period {period_id} not found")
