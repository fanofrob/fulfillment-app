from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.orm import Session

from database import get_db
import models
from services import sheets_service

router = APIRouter()


class BundleMappingUpdate(BaseModel):
    pick_sku: Optional[str] = None
    mix_quantity: Optional[float] = None
    product_type: Optional[str] = None
    pick_type: Optional[str] = None
    pick_weight_lb: Optional[float] = None
    lineitem_weight: Optional[float] = None
    shop_status: Optional[str] = None
    is_active: Optional[bool] = None
    notes: Optional[str] = None


class BundleMappingCreate(BundleMappingUpdate):
    warehouse: str
    shopify_sku: str


def _row_errors(r) -> list[str]:
    errors = []
    if not r.pick_sku:
        errors.append("missing_pick_sku")
    if r.mix_quantity is not None and r.mix_quantity <= 0:
        errors.append("invalid_mix_qty")
    return errors


def _to_dict(r: models.BundleMapping) -> dict:
    return {
        "id": r.id,
        "warehouse": r.warehouse,
        "shopify_sku": r.shopify_sku,
        "pick_sku": r.pick_sku,
        "mix_quantity": r.mix_quantity,
        "product_type": r.product_type,
        "pick_type": r.pick_type,
        "pick_weight_lb": r.pick_weight_lb,
        "lineitem_weight": r.lineitem_weight,
        "shop_status": r.shop_status,
        "is_active": r.is_active,
        "notes": r.notes,
        "errors": _row_errors(r),
        "last_edited_in_app_at": r.last_edited_in_app_at.isoformat() if r.last_edited_in_app_at else None,
        "synced_at": r.synced_at.isoformat() if r.synced_at else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


@router.get("/")
def list_sku_mappings(
    warehouse: Optional[str] = Query(None),
    shopify_sku: Optional[str] = Query(None),
    errors_only: bool = Query(False),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """
    List bundle mappings from the bundle_mappings DB table. Returns a list (not paginated envelope)
    to match the legacy sheets-backed contract that the SKU Mapping page already consumes.

    Falls back to live sheets read when the DB is empty (transitional state before first refresh).
    """
    q = db.query(models.BundleMapping)
    if warehouse:
        q = q.filter(models.BundleMapping.warehouse == warehouse)
    if shopify_sku:
        s = f"%{shopify_sku.lower()}%"
        q = q.filter(or_(
            func.lower(models.BundleMapping.shopify_sku).like(s),
            func.lower(models.BundleMapping.pick_sku).like(s),
        ))

    rows = q.order_by(models.BundleMapping.shopify_sku, models.BundleMapping.warehouse).all()

    if not rows:
        # When DB has no bundle_mappings rows at all, fall back to sheets so the page still
        # renders before the first refresh runs. Once any rows exist this fallback stops
        # triggering — empty filters then mean "DB has data, just none matching".
        if db.query(models.BundleMapping).count() == 0 and sheets_service.is_configured():
            try:
                if warehouse:
                    return sheets_service.get_sku_mappings(
                        warehouse, search=shopify_sku, skip=skip, limit=limit, errors_only=errors_only,
                    )
                return sheets_service.get_sku_mappings_both(
                    search=shopify_sku, skip=skip, limit=limit, errors_only=errors_only,
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))
        return []

    items = [_to_dict(r) for r in rows]
    if errors_only:
        items = [i for i in items if i["errors"]]
    return items[skip:skip + limit]


@router.post("/refresh")
def refresh_sku_mappings(db: Session = Depends(get_db)):
    """
    Pull mappings from Google Sheets and upsert into bundle_mappings. Rows that have been
    edited in-app (last_edited_in_app_at IS NOT NULL) are SKIPPED entirely — app wins on
    conflict. Then runs the existing recompute cascade so open orders / confirmed snapshots
    pick up the latest mappings.
    """
    if not sheets_service.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured.")

    # Invalidate the sheet cache so the upsert reads fresh data.
    sheets_service.invalidate("sku_walnut")
    sheets_service.invalidate("sku_northlake")
    sheets_service.invalidate("sku_type_data")

    now = datetime.now(timezone.utc)
    created = updated = skipped_app_edited = 0

    for warehouse in ("walnut", "northlake"):
        try:
            sheet_rows = sheets_service.get_sku_mappings(warehouse, skip=0, limit=100000)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Sheet read failed for {warehouse}: {e}")

        for sr in sheet_rows:
            shopify_sku = sr.get("shopify_sku")
            pick_sku = sr.get("pick_sku")
            if not shopify_sku:
                continue

            existing = db.query(models.BundleMapping).filter_by(
                warehouse=warehouse,
                shopify_sku=shopify_sku,
                pick_sku=pick_sku,
            ).first()

            if existing:
                if existing.last_edited_in_app_at is not None:
                    skipped_app_edited += 1
                    existing.synced_at = now
                    continue
                existing.mix_quantity = sr.get("mix_quantity")
                existing.product_type = sr.get("product_type")
                existing.pick_type = sr.get("pick_type")
                existing.pick_weight_lb = sr.get("pick_weight_lb")
                existing.lineitem_weight = sr.get("lineitem_weight")
                existing.shop_status = sr.get("shop_status")
                existing.is_active = sr.get("is_active", True)
                existing.synced_at = now
                updated += 1
            else:
                db.add(models.BundleMapping(
                    warehouse=warehouse,
                    shopify_sku=shopify_sku,
                    pick_sku=pick_sku,
                    mix_quantity=sr.get("mix_quantity"),
                    product_type=sr.get("product_type"),
                    pick_type=sr.get("pick_type"),
                    pick_weight_lb=sr.get("pick_weight_lb"),
                    lineitem_weight=sr.get("lineitem_weight"),
                    shop_status=sr.get("shop_status"),
                    is_active=sr.get("is_active", True),
                    synced_at=now,
                ))
                created += 1

    db.commit()

    from services.order_recompute import recompute_open_orders
    from services.projection_confirmed_orders_service import auto_reconfirm_across_periods

    result = recompute_open_orders(db)
    reconfirm = auto_reconfirm_across_periods(db, result.get("orders_changed_ids") or [])

    return {
        "status": "refreshed",
        "created": created,
        "updated": updated,
        "skipped_app_edited": skipped_app_edited,
        "orders_unstaged": (
            result["orders_unstaged_plan_issues"]
            + result["orders_unstaged_short_ship"]
            + result["orders_unstaged_inv_hold"]
        ),
        "snapshots_reconfirmed": reconfirm["reconfirmed"],
        "snapshots_reconfirmed_by_period": reconfirm["results_by_period"],
        **result,
    }


@router.get("/resolve")
def resolve_sku(shopify_sku: str = Query(...), warehouse: str = Query("walnut")):
    """
    Debug endpoint: show how a Shopify SKU resolves to pick SKU(s).
    Reads through the same DB-backed lookup as the consumers.
    """
    try:
        helper_map = sheets_service.get_sku_type_helper_map()
        helper_sku = helper_map.get(shopify_sku)
        lookup_key = helper_sku if helper_sku else shopify_sku

        lookup = sheets_service.get_sku_mapping_lookup(warehouse)
        mappings = lookup.get(shopify_sku)

        return {
            "shopify_sku": shopify_sku,
            "helper_sku": helper_sku,
            "lookup_key_used": lookup_key,
            "pick_mappings": mappings,
            "resolved": bool(mappings),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
def create_bundle_mapping(data: BundleMappingCreate, db: Session = Depends(get_db)):
    if data.warehouse not in ("walnut", "northlake"):
        raise HTTPException(status_code=400, detail="warehouse must be 'walnut' or 'northlake'")
    row = models.BundleMapping(
        **data.model_dump(),
        last_edited_in_app_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_dict(row)


@router.put("/{item_id}")
def update_bundle_mapping(item_id: int, data: BundleMappingUpdate, db: Session = Depends(get_db)):
    item = db.query(models.BundleMapping).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    item.last_edited_in_app_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(item)
    return _to_dict(item)


@router.delete("/{item_id}")
def delete_bundle_mapping(item_id: int, db: Session = Depends(get_db)):
    item = db.query(models.BundleMapping).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    db.delete(item)
    db.commit()
    return {"deleted": item_id}
