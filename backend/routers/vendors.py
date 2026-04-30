"""
Vendor Management router — CRUD for vendors and their product type defaults.
"""
from typing import List, Optional
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas

router = APIRouter()


def _encode_catalog(catalog) -> Optional[str]:
    """List[str] → JSON-encoded TEXT for storage."""
    if catalog is None:
        return None
    if isinstance(catalog, str):
        return catalog  # already encoded
    cleaned = [str(x).strip() for x in catalog if str(x).strip()]
    return json.dumps(cleaned)


def _parse_fruit_cell(raw: str) -> List[str]:
    """
    Best-effort parse of the freeform 'Fruit' column from RAW_Agg_Partners.
    Examples:
      'Fruit: Avocado'                     → ['Fruit: Avocado']
      'Fruit: Avocado, Bacon'              → ['Fruit: Avocado, Bacon']
      'Fruit: Lime, Caviar'                → ['Fruit: Lime, Caviar']
      'Cherimoya, Passion fruit, Mango'    → ['Fruit: Cherimoya', 'Fruit: Passion fruit', 'Fruit: Mango']
      'Fruit: Lemon, Meyer; Fruit: Lime'   → ['Fruit: Lemon, Meyer', 'Fruit: Lime']

    Heuristic: if the cell starts with 'Fruit:' assume one entry per
    'Fruit:' boundary (the comma after 'Fruit:' is a variety separator,
    not a list separator). Otherwise split by comma and prepend 'Fruit: '.
    """
    if not raw:
        return []
    s = raw.strip()
    if not s:
        return []
    if "fruit:" in s.lower():
        # Split on each 'Fruit:' occurrence and re-prepend the prefix
        # so 'Fruit: Lemon, Meyer; Fruit: Lime' → ['Lemon, Meyer', 'Lime']
        import re
        parts = re.split(r"(?i)\bfruit\s*:", s)
        out = []
        for p in parts:
            cleaned = p.strip().strip(";").strip(",").strip()
            if cleaned:
                out.append(f"Fruit: {cleaned}")
        return out
    # No 'Fruit:' prefix → comma-separated list of plain product names
    return [f"Fruit: {p.strip()}" for p in s.split(",") if p.strip()]


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
        url=data.url,
        pickup_address=data.pickup_address,
        agg_location=data.agg_location,
        product_catalog=_encode_catalog(data.product_catalog),
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
    payload = data.model_dump(exclude_unset=True)
    if "product_catalog" in payload:
        payload["product_catalog"] = _encode_catalog(payload["product_catalog"])
    for field, value in payload.items():
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


# ── Sheet Sync ──────────────────────────────────────────────────────────────

@router.post("/sync-from-sheets")
def sync_vendors_from_sheets(db: Session = Depends(get_db)):
    """
    Pull vendor records from the RAW_Agg_Partners Google Sheet and upsert by name.

    Sync is one-way (sheet → DB). Existing vendors are matched by `name`
    (case-insensitive). For matched vendors, only fields that are currently
    blank in the DB get updated — manual edits in the UI are preserved.
    The `product_catalog` is *merged*: items from the sheet are added to the
    existing catalog without removing anything.
    """
    from services import sheets_service

    try:
        partners = sheets_service.pull_agg_partners()
    except Exception as e:
        raise HTTPException(500, f"Failed to read RAW_Agg_Partners: {e}")

    created, updated, skipped = 0, 0, 0

    for row in partners:
        name = row["name"]
        existing = db.query(models.Vendor).filter(
            models.Vendor.name.ilike(name)
        ).first()

        catalog_from_sheet = _parse_fruit_cell(row.get("fruit_raw") or "")

        if existing is None:
            vendor = models.Vendor(
                name=name,
                contact_name=row.get("contact_name"),
                contact_phone=row.get("contact_phone"),
                url=row.get("url"),
                pickup_address=row.get("pickup_address"),
                agg_location=row.get("agg_location"),
                notes=row.get("notes"),
                product_catalog=_encode_catalog(catalog_from_sheet),
                is_active=True,
            )
            db.add(vendor)
            created += 1
        else:
            changed = False
            # Fill blanks only — preserve manual UI edits.
            for field in ("contact_name", "contact_phone", "url",
                          "pickup_address", "agg_location", "notes"):
                sheet_val = row.get(field)
                if sheet_val and not getattr(existing, field):
                    setattr(existing, field, sheet_val)
                    changed = True
            # Merge catalog: union of existing + sheet values.
            if catalog_from_sheet:
                try:
                    current = json.loads(existing.product_catalog) if existing.product_catalog else []
                    if not isinstance(current, list):
                        current = []
                except (ValueError, TypeError):
                    current = []
                merged = list(dict.fromkeys(current + catalog_from_sheet))  # preserve order, dedupe
                if merged != current:
                    existing.product_catalog = _encode_catalog(merged)
                    changed = True
            if changed:
                updated += 1
            else:
                skipped += 1

    db.commit()
    return {
        "ok": True,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "total_rows": len(partners),
    }
