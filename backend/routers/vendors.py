"""
Vendor Management router — CRUD for vendors and their product type defaults.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas

router = APIRouter()


# ── Vendor CRUD ─────────────────────────────────────────────────────────────

@router.get("/", response_model=List[schemas.VendorResponse])
def list_vendors(
    active_only: bool = Query(False),
    db: Session = Depends(get_db),
):
    q = db.query(models.Vendor)
    if active_only:
        q = q.filter(models.Vendor.is_active == True)
    vendors = q.order_by(models.Vendor.name).all()
    result = []
    for v in vendors:
        products = db.query(models.VendorProduct).filter(
            models.VendorProduct.vendor_id == v.id
        ).order_by(models.VendorProduct.product_type).all()
        resp = schemas.VendorResponse.model_validate(v)
        resp.products = [schemas.VendorProductResponse.model_validate(p) for p in products]
        result.append(resp)
    return result


@router.get("/{vendor_id}", response_model=schemas.VendorResponse)
def get_vendor(vendor_id: int, db: Session = Depends(get_db)):
    vendor = db.query(models.Vendor).filter(models.Vendor.id == vendor_id).first()
    if not vendor:
        raise HTTPException(404, "Vendor not found")
    products = db.query(models.VendorProduct).filter(
        models.VendorProduct.vendor_id == vendor.id
    ).order_by(models.VendorProduct.product_type).all()
    resp = schemas.VendorResponse.model_validate(vendor)
    resp.products = [schemas.VendorProductResponse.model_validate(p) for p in products]
    return resp


@router.post("/", response_model=schemas.VendorResponse, status_code=201)
def create_vendor(data: schemas.VendorCreate, db: Session = Depends(get_db)):
    vendor = models.Vendor(
        name=data.name,
        contact_name=data.contact_name,
        contact_email=data.contact_email,
        contact_phone=data.contact_phone,
        contact_whatsapp=data.contact_whatsapp,
        preferred_communication=data.preferred_communication,
        notes=data.notes,
        is_active=data.is_active,
    )
    db.add(vendor)
    db.flush()  # get vendor.id

    products = []
    if data.products:
        for p in data.products:
            vp = models.VendorProduct(
                vendor_id=vendor.id,
                product_type=p.product_type,
                default_case_weight_lbs=p.default_case_weight_lbs,
                default_case_count=p.default_case_count,
                default_price_per_case=p.default_price_per_case,
                default_price_per_lb=p.default_price_per_lb,
                lead_time_days=p.lead_time_days,
                order_unit=p.order_unit,
                is_preferred=p.is_preferred,
                notes=p.notes,
            )
            db.add(vp)
            products.append(vp)

    db.commit()
    db.refresh(vendor)
    for p in products:
        db.refresh(p)

    resp = schemas.VendorResponse.model_validate(vendor)
    resp.products = [schemas.VendorProductResponse.model_validate(p) for p in products]
    return resp


@router.put("/{vendor_id}", response_model=schemas.VendorResponse)
def update_vendor(vendor_id: int, data: schemas.VendorUpdate, db: Session = Depends(get_db)):
    vendor = db.query(models.Vendor).filter(models.Vendor.id == vendor_id).first()
    if not vendor:
        raise HTTPException(404, "Vendor not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(vendor, field, value)
    db.commit()
    db.refresh(vendor)
    return get_vendor(vendor_id, db)


@router.delete("/{vendor_id}")
def delete_vendor(vendor_id: int, db: Session = Depends(get_db)):
    vendor = db.query(models.Vendor).filter(models.Vendor.id == vendor_id).first()
    if not vendor:
        raise HTTPException(404, "Vendor not found")
    # Check for existing POs
    po_count = db.query(models.PurchaseOrder).filter(
        models.PurchaseOrder.vendor_id == vendor_id
    ).count()
    if po_count > 0:
        raise HTTPException(400, f"Cannot delete vendor with {po_count} purchase order(s). Deactivate instead.")
    db.query(models.VendorProduct).filter(models.VendorProduct.vendor_id == vendor_id).delete()
    db.delete(vendor)
    db.commit()
    return {"ok": True}


# ── Vendor Products ─────────────────────────────────────────────────────────

@router.post("/{vendor_id}/products", response_model=schemas.VendorProductResponse, status_code=201)
def add_vendor_product(vendor_id: int, data: schemas.VendorProductCreate, db: Session = Depends(get_db)):
    vendor = db.query(models.Vendor).filter(models.Vendor.id == vendor_id).first()
    if not vendor:
        raise HTTPException(404, "Vendor not found")
    # Check for duplicate
    existing = db.query(models.VendorProduct).filter(
        models.VendorProduct.vendor_id == vendor_id,
        models.VendorProduct.product_type == data.product_type,
    ).first()
    if existing:
        raise HTTPException(400, f"Vendor already has product type '{data.product_type}'")

    vp = models.VendorProduct(
        vendor_id=vendor_id,
        product_type=data.product_type,
        default_case_weight_lbs=data.default_case_weight_lbs,
        default_case_count=data.default_case_count,
        default_price_per_case=data.default_price_per_case,
        default_price_per_lb=data.default_price_per_lb,
        lead_time_days=data.lead_time_days,
        order_unit=data.order_unit,
        is_preferred=data.is_preferred,
        notes=data.notes,
    )
    db.add(vp)
    db.commit()
    db.refresh(vp)
    return vp


@router.put("/{vendor_id}/products/{product_id}", response_model=schemas.VendorProductResponse)
def update_vendor_product(
    vendor_id: int,
    product_id: int,
    data: schemas.VendorProductUpdate,
    db: Session = Depends(get_db),
):
    vp = db.query(models.VendorProduct).filter(
        models.VendorProduct.id == product_id,
        models.VendorProduct.vendor_id == vendor_id,
    ).first()
    if not vp:
        raise HTTPException(404, "Vendor product not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(vp, field, value)
    db.commit()
    db.refresh(vp)
    return vp


@router.delete("/{vendor_id}/products/{product_id}")
def delete_vendor_product(vendor_id: int, product_id: int, db: Session = Depends(get_db)):
    vp = db.query(models.VendorProduct).filter(
        models.VendorProduct.id == product_id,
        models.VendorProduct.vendor_id == vendor_id,
    ).first()
    if not vp:
        raise HTTPException(404, "Vendor product not found")
    db.delete(vp)
    db.commit()
    return {"ok": True}


# ── Preferred Vendor Lookup ─────────────────────────────────────────────────

@router.get("/preferred/{product_type}", response_model=Optional[schemas.VendorResponse])
def get_preferred_vendor(product_type: str, db: Session = Depends(get_db)):
    """Get the preferred vendor for a product type."""
    vp = db.query(models.VendorProduct).filter(
        models.VendorProduct.product_type == product_type,
        models.VendorProduct.is_preferred == True,
    ).first()
    if not vp:
        return None
    return get_vendor(vp.vendor_id, db)


@router.get("/by-product-type/{product_type}", response_model=List[schemas.VendorResponse])
def get_vendors_for_product_type(product_type: str, db: Session = Depends(get_db)):
    """Get all vendors that supply a given product type."""
    vps = db.query(models.VendorProduct).filter(
        models.VendorProduct.product_type == product_type,
    ).all()
    vendor_ids = list(set(vp.vendor_id for vp in vps))
    return [get_vendor(vid, db) for vid in vendor_ids]
