"""
Packaging Mappings — link a product pick_sku to one or more packaging pick_skus
with a `qty_per_unit` consumption rate.

When a product ships, _auto_deduct_on_ship() (in routers/inventory.py) reads
these rows and deducts (qty_per_unit × shipped_units) of each packaging SKU
from inventory.

Box-level packaging (1 box per shipment) is NOT modelled here — it lives on
BoxType.pick_sku. This table is exclusively per-product-unit packaging like
'1lb_clamshell ships with every cherry-01x01'.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import get_db
import models

router = APIRouter()


class PackagingMappingCreate(BaseModel):
    product_pick_sku: str
    packaging_pick_sku: str
    qty_per_unit: float = 1.0
    notes: Optional[str] = None


class PackagingMappingUpdate(BaseModel):
    qty_per_unit: Optional[float] = None
    notes: Optional[str] = None


def _to_dict(m: models.PackagingMapping, ps_index: dict) -> dict:
    """Serialize. ps_index = {pick_sku: PicklistSku} for friendly descriptions."""
    prod = ps_index.get(m.product_pick_sku)
    pkg = ps_index.get(m.packaging_pick_sku)
    return {
        "id": m.id,
        "product_pick_sku": m.product_pick_sku,
        "product_description": prod.customer_description if prod else None,
        "packaging_pick_sku": m.packaging_pick_sku,
        "packaging_description": pkg.customer_description if pkg else None,
        "qty_per_unit": m.qty_per_unit,
        "notes": m.notes,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "updated_at": m.updated_at.isoformat() if m.updated_at else None,
    }


def _picklist_index(db: Session) -> dict:
    return {p.pick_sku: p for p in db.query(models.PicklistSku).all()}


def _validate_skus_exist(db: Session, product_sku: str, packaging_sku: str):
    prod = db.query(models.PicklistSku).filter_by(pick_sku=product_sku).first()
    if not prod:
        raise HTTPException(status_code=400, detail=f"product_pick_sku '{product_sku}' not found in picklist_skus")
    pkg = db.query(models.PicklistSku).filter_by(pick_sku=packaging_sku).first()
    if not pkg:
        raise HTTPException(status_code=400, detail=f"packaging_pick_sku '{packaging_sku}' not found in picklist_skus")
    if pkg.inventory_type != 'packaging':
        raise HTTPException(
            status_code=400,
            detail=f"'{packaging_sku}' has inventory_type='{pkg.inventory_type}', expected 'packaging'. "
                   f"Change its inventory_type to 'packaging' on the Picklist SKUs page first."
        )


@router.get("/")
def list_mappings(
    product_pick_sku: Optional[str] = Query(None),
    packaging_pick_sku: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """
    List packaging mappings, optionally filtered by product or packaging pick_sku.
    """
    q = db.query(models.PackagingMapping)
    if product_pick_sku:
        q = q.filter(models.PackagingMapping.product_pick_sku == product_pick_sku)
    if packaging_pick_sku:
        q = q.filter(models.PackagingMapping.packaging_pick_sku == packaging_pick_sku)
    rows = q.order_by(
        models.PackagingMapping.product_pick_sku,
        models.PackagingMapping.packaging_pick_sku,
    ).all()
    ps_index = _picklist_index(db)
    return {"total": len(rows), "items": [_to_dict(m, ps_index) for m in rows]}


@router.post("/", status_code=201)
def create_mapping(data: PackagingMappingCreate, db: Session = Depends(get_db)):
    if data.qty_per_unit <= 0:
        raise HTTPException(status_code=400, detail="qty_per_unit must be > 0")
    _validate_skus_exist(db, data.product_pick_sku, data.packaging_pick_sku)
    m = models.PackagingMapping(
        product_pick_sku=data.product_pick_sku.strip(),
        packaging_pick_sku=data.packaging_pick_sku.strip(),
        qty_per_unit=data.qty_per_unit,
        notes=data.notes,
    )
    db.add(m)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"Mapping already exists for {data.product_pick_sku} → {data.packaging_pick_sku}",
        )
    db.refresh(m)
    return _to_dict(m, _picklist_index(db))


@router.put("/{mapping_id}")
def update_mapping(mapping_id: int, data: PackagingMappingUpdate, db: Session = Depends(get_db)):
    m = db.query(models.PackagingMapping).filter_by(id=mapping_id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Not found")
    update = data.model_dump(exclude_unset=True)
    if "qty_per_unit" in update and (update["qty_per_unit"] is None or update["qty_per_unit"] <= 0):
        raise HTTPException(status_code=400, detail="qty_per_unit must be > 0")
    for k, v in update.items():
        setattr(m, k, v)
    db.commit()
    db.refresh(m)
    return _to_dict(m, _picklist_index(db))


@router.delete("/{mapping_id}", status_code=204)
def delete_mapping(mapping_id: int, db: Session = Depends(get_db)):
    m = db.query(models.PackagingMapping).filter_by(id=mapping_id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(m)
    db.commit()
    return None
