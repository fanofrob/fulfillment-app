from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.orm import Session

from database import get_db
import models

router = APIRouter()


# ── Pydantic schemas ─────────────────────────────────────────────────────────

class RequiredPick(BaseModel):
    pick_sku: str
    qty: float


class ShopifySkuRuleBase(BaseModel):
    weight_lb: Optional[float] = None
    kind: Optional[Literal["single", "multi"]] = None
    single_substitute_product_types: Optional[List[str]] = None
    multi_min_picks: Optional[int] = None
    multi_max_picks: Optional[int] = None
    multi_min_categories: Optional[int] = None
    multi_max_categories: Optional[int] = None
    multi_max_cost_per_lb: Optional[float] = None
    multi_allowed_product_types: Optional[List[str]] = None
    multi_required_picks: Optional[List[RequiredPick]] = None
    notes: Optional[str] = None


class ShopifySkuRuleCreate(ShopifySkuRuleBase):
    shopify_sku: str


class ShopifySkuRuleUpdate(ShopifySkuRuleBase):
    pass


# ── Helpers ──────────────────────────────────────────────────────────────────

def _resolve_canonical(db: Session, shopify_sku: str) -> str:
    """Walk the helper indirection: variant → canonical Shopify SKU. Returns the
    input unchanged if no helper alias exists."""
    helper = db.query(models.SkuHelperMapping).filter_by(shopify_sku=shopify_sku).first()
    if helper and helper.helper_sku:
        return helper.helper_sku
    return shopify_sku


def get_rule_for_shopify_sku(db: Session, shopify_sku: str) -> Optional[models.ShopifySkuRule]:
    """
    Public lookup helper — resolves a Shopify SKU (variant or canonical) to its
    rule row, or None. Used by Phase 4 (page tooltip) and Phase 6 (error checks).
    """
    canonical = _resolve_canonical(db, shopify_sku)
    return db.query(models.ShopifySkuRule).filter_by(shopify_sku=canonical).first()


def _to_dict(r: models.ShopifySkuRule) -> dict:
    return {
        "id": r.id,
        "shopify_sku": r.shopify_sku,
        "weight_lb": r.weight_lb,
        "kind": r.kind,
        "single_substitute_product_types": r.single_substitute_product_types,
        "multi_min_picks": r.multi_min_picks,
        "multi_max_picks": r.multi_max_picks,
        "multi_min_categories": r.multi_min_categories,
        "multi_max_categories": r.multi_max_categories,
        "multi_max_cost_per_lb": r.multi_max_cost_per_lb,
        "multi_allowed_product_types": r.multi_allowed_product_types,
        "multi_required_picks": r.multi_required_picks,
        "notes": r.notes,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/")
def list_rules(
    search: Optional[str] = Query(None),
    kind: Optional[str] = Query(None, description="'single' or 'multi'"),
    skip: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    q = db.query(models.ShopifySkuRule)
    if search:
        s = f"%{search.lower()}%"
        q = q.filter(func.lower(models.ShopifySkuRule.shopify_sku).like(s))
    if kind:
        q = q.filter(models.ShopifySkuRule.kind == kind)
    total = q.count()
    items = q.order_by(models.ShopifySkuRule.shopify_sku).offset(skip).limit(limit).all()
    return {"total": total, "items": [_to_dict(r) for r in items]}


@router.get("/lookup")
def lookup_rule(
    shopify_sku: str = Query(..., description="Variant or canonical Shopify SKU"),
    db: Session = Depends(get_db),
):
    """Resolve a Shopify SKU through the helper alias and return its rule (or null)."""
    canonical = _resolve_canonical(db, shopify_sku)
    rule = db.query(models.ShopifySkuRule).filter_by(shopify_sku=canonical).first()
    return {
        "shopify_sku": shopify_sku,
        "canonical_sku": canonical,
        "resolved_via_helper": canonical != shopify_sku,
        "rule": _to_dict(rule) if rule else None,
    }


@router.post("/")
def create_rule(data: ShopifySkuRuleCreate, db: Session = Depends(get_db)):
    existing = db.query(models.ShopifySkuRule).filter_by(shopify_sku=data.shopify_sku).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Rule already exists for {data.shopify_sku} (id={existing.id})")
    payload = data.model_dump()
    if payload.get("multi_required_picks") is not None:
        payload["multi_required_picks"] = [p if isinstance(p, dict) else p.model_dump() for p in payload["multi_required_picks"]]
    row = models.ShopifySkuRule(**payload)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_dict(row)


@router.put("/{item_id}")
def update_rule(item_id: int, data: ShopifySkuRuleUpdate, db: Session = Depends(get_db)):
    item = db.query(models.ShopifySkuRule).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    payload = data.model_dump(exclude_unset=True)
    if "multi_required_picks" in payload and payload["multi_required_picks"] is not None:
        payload["multi_required_picks"] = [p if isinstance(p, dict) else p.model_dump() for p in payload["multi_required_picks"]]
    for k, v in payload.items():
        setattr(item, k, v)
    db.commit()
    db.refresh(item)
    return _to_dict(item)


@router.put("/by-shopify-sku/{shopify_sku}")
def upsert_rule_by_shopify_sku(shopify_sku: str, data: ShopifySkuRuleUpdate, db: Session = Depends(get_db)):
    """
    Upsert convenience: looks up by shopify_sku (canonical — caller should pass the
    canonical SKU, e.g. after resolving via /lookup). Creates if missing, updates
    if present. Returns the resulting row.
    """
    payload = data.model_dump(exclude_unset=True)
    if "multi_required_picks" in payload and payload["multi_required_picks"] is not None:
        payload["multi_required_picks"] = [p if isinstance(p, dict) else p.model_dump() for p in payload["multi_required_picks"]]

    item = db.query(models.ShopifySkuRule).filter_by(shopify_sku=shopify_sku).first()
    if item:
        for k, v in payload.items():
            setattr(item, k, v)
    else:
        item = models.ShopifySkuRule(shopify_sku=shopify_sku, **payload)
        db.add(item)
    db.commit()
    db.refresh(item)
    return _to_dict(item)


@router.delete("/{item_id}")
def delete_rule(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.ShopifySkuRule).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(item)
    db.commit()
    return {"deleted": item_id}
