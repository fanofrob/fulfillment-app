from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import List, Optional
from database import get_db
import models
import schemas

router = APIRouter()


# --- Box Types ---

@router.get("/box-types", response_model=List[schemas.BoxTypeResponse])
def list_box_types(
    is_active: Optional[bool] = Query(None),
    db: Session = Depends(get_db),
):
    query = db.query(models.BoxType)
    if is_active is not None:
        query = query.filter(models.BoxType.is_active == is_active)
    return query.order_by(models.BoxType.name).all()


@router.post("/box-types", response_model=schemas.BoxTypeResponse, status_code=201)
def create_box_type(payload: schemas.BoxTypeCreate, db: Session = Depends(get_db)):
    if db.query(models.BoxType).filter(models.BoxType.name == payload.name).first():
        raise HTTPException(status_code=400, detail="A box type with this name already exists")
    item = models.BoxType(**payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/box-types/{item_id}", response_model=schemas.BoxTypeResponse)
def update_box_type(item_id: int, payload: schemas.BoxTypeUpdate, db: Session = Depends(get_db)):
    item = db.query(models.BoxType).filter(models.BoxType.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Box type not found")
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates:
        existing = db.query(models.BoxType).filter(models.BoxType.name == updates["name"], models.BoxType.id != item_id).first()
        if existing:
            raise HTTPException(status_code=400, detail="A box type with this name already exists")
    for field, value in updates.items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/box-types/{item_id}", status_code=204)
def delete_box_type(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.BoxType).filter(models.BoxType.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Box type not found")
    db.delete(item)
    db.commit()


# --- Packaging Materials ---

class PackagingMaterialCreate(BaseModel):
    name: str
    unit_cost: float = 0.0
    unit: Optional[str] = "each"
    is_active: bool = True
    notes: Optional[str] = None

class PackagingMaterialUpdate(BaseModel):
    name: Optional[str] = None
    unit_cost: Optional[float] = None
    unit: Optional[str] = None
    is_active: Optional[bool] = None
    notes: Optional[str] = None

def _material_to_dict(m: models.PackagingMaterial) -> dict:
    return {
        "id": m.id, "name": m.name, "unit_cost": m.unit_cost,
        "unit": m.unit, "is_active": m.is_active, "notes": m.notes,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "updated_at": m.updated_at.isoformat() if m.updated_at else None,
    }

@router.get("/packaging-materials")
def list_packaging_materials(db: Session = Depends(get_db)):
    items = db.query(models.PackagingMaterial).order_by(models.PackagingMaterial.name).all()
    return [_material_to_dict(m) for m in items]

@router.post("/packaging-materials", status_code=201)
def create_packaging_material(payload: PackagingMaterialCreate, db: Session = Depends(get_db)):
    if db.query(models.PackagingMaterial).filter(models.PackagingMaterial.name == payload.name).first():
        raise HTTPException(status_code=400, detail="A material with this name already exists")
    item = models.PackagingMaterial(**payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return _material_to_dict(item)

@router.put("/packaging-materials/{item_id}")
def update_packaging_material(item_id: int, payload: PackagingMaterialUpdate, db: Session = Depends(get_db)):
    item = db.query(models.PackagingMaterial).filter(models.PackagingMaterial.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Packaging material not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    db.commit()
    db.refresh(item)
    return _material_to_dict(item)

@router.delete("/packaging-materials/{item_id}", status_code=204)
def delete_packaging_material(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.PackagingMaterial).filter(models.PackagingMaterial.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Packaging material not found")
    db.delete(item)
    db.commit()


# --- Box Type Packaging (which materials go in which box type) ---

class BoxTypePackagingCreate(BaseModel):
    packaging_material_id: int
    quantity: float = 1.0

class BoxTypePackagingUpdate(BaseModel):
    quantity: float

def _btp_to_dict(btp: models.BoxTypePackaging, db: Session) -> dict:
    mat = db.query(models.PackagingMaterial).filter(models.PackagingMaterial.id == btp.packaging_material_id).first()
    return {
        "id": btp.id,
        "box_type_id": btp.box_type_id,
        "packaging_material_id": btp.packaging_material_id,
        "quantity": btp.quantity,
        "material_name": mat.name if mat else None,
        "material_unit_cost": mat.unit_cost if mat else None,
        "material_unit": mat.unit if mat else None,
        "line_cost": round((mat.unit_cost if mat else 0) * btp.quantity, 4),
    }

@router.get("/box-types/{box_type_id}/packaging")
def list_box_type_packaging(box_type_id: int, db: Session = Depends(get_db)):
    items = db.query(models.BoxTypePackaging).filter(
        models.BoxTypePackaging.box_type_id == box_type_id
    ).all()
    return [_btp_to_dict(i, db) for i in items]

@router.post("/box-types/{box_type_id}/packaging", status_code=201)
def add_box_type_packaging(box_type_id: int, payload: BoxTypePackagingCreate, db: Session = Depends(get_db)):
    box_type = db.query(models.BoxType).filter(models.BoxType.id == box_type_id).first()
    if not box_type:
        raise HTTPException(status_code=404, detail="Box type not found")
    if db.query(models.BoxTypePackaging).filter_by(
        box_type_id=box_type_id, packaging_material_id=payload.packaging_material_id
    ).first():
        raise HTTPException(status_code=400, detail="This material is already assigned to this box type")
    item = models.BoxTypePackaging(box_type_id=box_type_id, **payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return _btp_to_dict(item, db)

@router.put("/box-types/{box_type_id}/packaging/{entry_id}")
def update_box_type_packaging(box_type_id: int, entry_id: int, payload: BoxTypePackagingUpdate, db: Session = Depends(get_db)):
    item = db.query(models.BoxTypePackaging).filter_by(id=entry_id, box_type_id=box_type_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Entry not found")
    item.quantity = payload.quantity
    db.commit()
    db.refresh(item)
    return _btp_to_dict(item, db)

@router.delete("/box-types/{box_type_id}/packaging/{entry_id}", status_code=204)
def delete_box_type_packaging(box_type_id: int, entry_id: int, db: Session = Depends(get_db)):
    item = db.query(models.BoxTypePackaging).filter_by(id=entry_id, box_type_id=box_type_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Entry not found")
    db.delete(item)
    db.commit()


# --- Package Rules ---

@router.get("/packages", response_model=List[schemas.PackageRuleResponse])
def list_package_rules(
    is_active: Optional[bool] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    query = db.query(models.PackageRule)
    if is_active is not None:
        query = query.filter(models.PackageRule.is_active == is_active)
    return query.order_by(models.PackageRule.priority.desc(), models.PackageRule.id).offset(skip).limit(limit).all()


@router.get("/packages/{item_id}", response_model=schemas.PackageRuleResponse)
def get_package_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.PackageRule).filter(models.PackageRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Package rule not found")
    return item


@router.post("/packages", response_model=schemas.PackageRuleResponse, status_code=201)
def create_package_rule(payload: schemas.PackageRuleCreate, db: Session = Depends(get_db)):
    data = payload.model_dump()
    # conditions is already a list of dicts via Pydantic; SQLAlchemy JSON stores it as-is
    data["conditions"] = [c.model_dump() if hasattr(c, "model_dump") else c for c in (data.get("conditions") or [])]
    item = models.PackageRule(**data)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/packages/{item_id}", response_model=schemas.PackageRuleResponse)
def update_package_rule(item_id: int, payload: schemas.PackageRuleUpdate, db: Session = Depends(get_db)):
    item = db.query(models.PackageRule).filter(models.PackageRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Package rule not found")
    updates = payload.model_dump(exclude_unset=True)
    if "conditions" in updates and updates["conditions"] is not None:
        updates["conditions"] = [c.model_dump() if hasattr(c, "model_dump") else c for c in updates["conditions"]]
    for field, value in updates.items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.patch("/packages/{item_id}/pause", response_model=schemas.PackageRuleResponse)
def pause_package_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.PackageRule).filter(models.PackageRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Package rule not found")
    item.is_active = False
    db.commit()
    db.refresh(item)
    return item


@router.patch("/packages/{item_id}/unpause", response_model=schemas.PackageRuleResponse)
def unpause_package_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.PackageRule).filter(models.PackageRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Package rule not found")
    item.is_active = True
    db.commit()
    db.refresh(item)
    return item


@router.delete("/packages/{item_id}", status_code=204)
def delete_package_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.PackageRule).filter(models.PackageRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Package rule not found")
    db.delete(item)
    db.commit()


# --- Carrier Service Rules ---

@router.get("/carrier-services", response_model=List[schemas.CarrierServiceRuleResponse])
def list_carrier_service_rules(
    is_active: Optional[bool] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    query = db.query(models.CarrierServiceRule)
    if is_active is not None:
        query = query.filter(models.CarrierServiceRule.is_active == is_active)
    return query.order_by(models.CarrierServiceRule.priority.desc(), models.CarrierServiceRule.id).offset(skip).limit(limit).all()


@router.get("/carrier-services/{item_id}", response_model=schemas.CarrierServiceRuleResponse)
def get_carrier_service_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.CarrierServiceRule).filter(models.CarrierServiceRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Carrier service rule not found")
    return item


@router.post("/carrier-services", response_model=schemas.CarrierServiceRuleResponse, status_code=201)
def create_carrier_service_rule(payload: schemas.CarrierServiceRuleCreate, db: Session = Depends(get_db)):
    data = payload.model_dump()
    data["conditions"] = [c.model_dump() if hasattr(c, "model_dump") else c for c in (data.get("conditions") or [])]
    item = models.CarrierServiceRule(**data)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/carrier-services/{item_id}", response_model=schemas.CarrierServiceRuleResponse)
def update_carrier_service_rule(item_id: int, payload: schemas.CarrierServiceRuleUpdate, db: Session = Depends(get_db)):
    item = db.query(models.CarrierServiceRule).filter(models.CarrierServiceRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Carrier service rule not found")
    updates = payload.model_dump(exclude_unset=True)
    if "conditions" in updates and updates["conditions"] is not None:
        updates["conditions"] = [c.model_dump() if hasattr(c, "model_dump") else c for c in updates["conditions"]]
    for field, value in updates.items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.patch("/carrier-services/{item_id}/pause", response_model=schemas.CarrierServiceRuleResponse)
def pause_carrier_service_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.CarrierServiceRule).filter(models.CarrierServiceRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Carrier service rule not found")
    item.is_active = False
    db.commit()
    db.refresh(item)
    return item


@router.patch("/carrier-services/{item_id}/unpause", response_model=schemas.CarrierServiceRuleResponse)
def unpause_carrier_service_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.CarrierServiceRule).filter(models.CarrierServiceRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Carrier service rule not found")
    item.is_active = True
    db.commit()
    db.refresh(item)
    return item


@router.delete("/carrier-services/{item_id}", status_code=204)
def delete_carrier_service_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.CarrierServiceRule).filter(models.CarrierServiceRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Carrier service rule not found")
    db.delete(item)
    db.commit()


# --- Order Rules ---

@router.get("/orders/tags", response_model=List[str])
def list_order_tags(db: Session = Depends(get_db)):
    """Return all distinct tags from Shopify orders for the tag dropdown."""
    rows = db.query(models.ShopifyOrder.tags).filter(models.ShopifyOrder.tags.isnot(None)).all()
    tag_set = set()
    for (raw,) in rows:
        for t in raw.split(","):
            t = t.strip()
            if t:
                tag_set.add(t)
    return sorted(tag_set, key=str.lower)


@router.get("/orders", response_model=List[schemas.OrderRuleResponse])
def list_order_rules(
    tag: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    is_active: Optional[bool] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    query = db.query(models.OrderRule)
    if tag is not None:
        query = query.filter(models.OrderRule.tag.ilike(f"%{tag}%"))
    if action is not None:
        query = query.filter(models.OrderRule.action == action)
    if is_active is not None:
        query = query.filter(models.OrderRule.is_active == is_active)
    return query.order_by(models.OrderRule.priority.desc()).offset(skip).limit(limit).all()


@router.get("/orders/{item_id}", response_model=schemas.OrderRuleResponse)
def get_order_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.OrderRule).filter(models.OrderRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Order rule not found")
    return item


@router.post("/orders", response_model=schemas.OrderRuleResponse, status_code=201)
def create_order_rule(payload: schemas.OrderRuleCreate, db: Session = Depends(get_db)):
    item = models.OrderRule(**payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/orders/{item_id}", response_model=schemas.OrderRuleResponse)
def update_order_rule(item_id: int, payload: schemas.OrderRuleUpdate, db: Session = Depends(get_db)):
    item = db.query(models.OrderRule).filter(models.OrderRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Order rule not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.patch("/orders/{item_id}/pause", response_model=schemas.OrderRuleResponse)
def pause_order_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.OrderRule).filter(models.OrderRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Order rule not found")
    item.is_active = False
    db.commit()
    db.refresh(item)
    return item


@router.patch("/orders/{item_id}/unpause", response_model=schemas.OrderRuleResponse)
def unpause_order_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.OrderRule).filter(models.OrderRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Order rule not found")
    item.is_active = True
    db.commit()
    db.refresh(item)
    return item


@router.delete("/orders/{item_id}", status_code=204)
def delete_order_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.OrderRule).filter(models.OrderRule.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Order rule not found")
    db.delete(item)
    db.commit()
