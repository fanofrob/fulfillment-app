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


def _group_errors(lines, rule, total_pick_weight, shopify_weight) -> list[str]:
    """
    Group-level warnings about a (warehouse, canonical_sku) bundle as a whole.
    Always warnings — never blocks save. Phase 6.
    """
    errors: list[str] = []
    has_any_pick = any(line.pick_sku for line in lines)

    if has_any_pick and (shopify_weight is None or shopify_weight <= 0):
        errors.append("missing_weight")
    elif shopify_weight is not None and shopify_weight > 0:
        diff = total_pick_weight - shopify_weight
        over_threshold = max(0.20 * shopify_weight, 1.0)
        under_threshold = max(0.05 * shopify_weight, 1.0)
        if diff > over_threshold:
            errors.append("over_weight")
        elif -diff > under_threshold:
            errors.append("under_weight")

    if rule and rule.kind:
        product_types = [line.product_type for line in lines if line.product_type]
        if rule.kind == "multi":
            seen: set[str] = set()
            for pt in product_types:
                if pt in seen:
                    errors.append("multi_same_product_type")
                    break
                seen.add(pt)
        elif rule.kind == "single":
            allowed = set(rule.single_substitute_product_types or [])
            if allowed and any(pt not in allowed for pt in product_types):
                errors.append("single_product_type_mismatch")

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
    items = [_to_dict(r) for r in rows]
    if errors_only:
        items = [i for i in items if i["errors"]]
    return items[skip:skip + limit]


@router.get("/grouped")
def list_grouped_sku_mappings(
    warehouse: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    errors_only: bool = Query(False),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    """
    One row per (warehouse, shopify_sku) with all pick lines aggregated, rule attached
    (resolved through sku_helper_mappings), and a summary block (total pick weight,
    Shopify weight, diff, pick count, distinct categories) computed for the page tooltip.
    """
    from collections import OrderedDict
    from routers.shopify_sku_rules import get_rule_for_shopify_sku

    q = db.query(models.BundleMapping)
    if warehouse:
        q = q.filter(models.BundleMapping.warehouse == warehouse)
    if search:
        s = f"%{search.lower()}%"
        q = q.filter(or_(
            func.lower(models.BundleMapping.shopify_sku).like(s),
            func.lower(models.BundleMapping.pick_sku).like(s),
        ))
    rows = q.order_by(models.BundleMapping.shopify_sku, models.BundleMapping.warehouse).all()
    if not rows:
        return []

    grouped: "OrderedDict[tuple, list]" = OrderedDict()
    for r in rows:
        grouped.setdefault((r.warehouse, r.shopify_sku), []).append(r)

    all_pick_skus = {r.pick_sku for r in rows if r.pick_sku}
    pick_meta: dict[str, dict] = {}
    if all_pick_skus:
        for p in db.query(models.PicklistSku).filter(models.PicklistSku.pick_sku.in_(all_pick_skus)).all():
            cost = p.cost_per_lb
            if cost is None and p.cost_per_case is not None and p.case_weight_lb:
                cost = p.cost_per_case / p.case_weight_lb
            pick_meta[p.pick_sku] = {
                "picklist_weight_lb": p.weight_lb,
                "cost_per_lb": cost,
                "category": p.category,
            }

    result = []
    for (wh, sku), lines in grouped.items():
        pick_lines: list[dict] = []
        total_pick_weight = 0.0
        agg_errors: set[str] = set()
        for line in lines:
            meta = pick_meta.get(line.pick_sku, {})
            pw = line.pick_weight_lb if line.pick_weight_lb is not None else meta.get("picklist_weight_lb")
            line_total = (line.mix_quantity or 0) * (pw or 0)
            total_pick_weight += line_total
            line_errors = _row_errors(line)
            agg_errors.update(line_errors)
            pick_lines.append({
                "id": line.id,
                "pick_sku": line.pick_sku,
                "mix_quantity": line.mix_quantity,
                "pick_weight_lb": pw,
                "product_type": line.product_type,
                "pick_type": line.pick_type,
                "shop_status": line.shop_status,
                "is_active": line.is_active,
                "cost_per_lb": meta.get("cost_per_lb"),
                "category": meta.get("category"),
                "line_total_weight": round(line_total, 4),
                "last_edited_in_app_at": line.last_edited_in_app_at.isoformat() if line.last_edited_in_app_at else None,
                "errors": line_errors,
            })

        rule = get_rule_for_shopify_sku(db, sku)
        rule_dict = None
        shopify_weight = None
        if rule:
            rule_dict = {
                "id": rule.id,
                "shopify_sku": rule.shopify_sku,
                "weight_lb": rule.weight_lb,
                "kind": rule.kind,
                "single_substitute_product_types": rule.single_substitute_product_types,
                "multi_min_picks": rule.multi_min_picks,
                "multi_max_picks": rule.multi_max_picks,
                "multi_min_categories": rule.multi_min_categories,
                "multi_max_categories": rule.multi_max_categories,
                "multi_max_cost_per_lb": rule.multi_max_cost_per_lb,
                "multi_allowed_product_types": rule.multi_allowed_product_types,
                "multi_required_picks": rule.multi_required_picks,
            }
            shopify_weight = rule.weight_lb

        weight_diff = None
        weight_diff_pct = None
        if shopify_weight is not None and shopify_weight > 0:
            weight_diff = round(total_pick_weight - shopify_weight, 4)
            weight_diff_pct = round((total_pick_weight - shopify_weight) / shopify_weight, 4)

        agg_errors.update(_group_errors(lines, rule, total_pick_weight, shopify_weight))

        result.append({
            "shopify_sku": sku,
            "warehouse": wh,
            "pick_lines": pick_lines,
            "rule": rule_dict,
            "summary": {
                "total_pick_weight": round(total_pick_weight, 4),
                "shopify_weight": shopify_weight,
                "weight_diff": weight_diff,
                "weight_diff_pct": weight_diff_pct,
                "pick_count": len(pick_lines),
                "categories": sorted({pl["category"] for pl in pick_lines if pl["category"]}),
            },
            "errors": sorted(agg_errors),
        })

    if errors_only:
        result = [r for r in result if r["errors"]]
    return result[skip:skip + limit]


@router.get("/staged-errors")
def staged_skus_with_errors(db: Session = Depends(get_db)):
    """
    Phase 6 dashboard query: canonical Shopify SKUs that appear in any staged order
    AND have mapping errors. Shows what's blocking clean fulfillment right now.

    Each row: {shopify_sku, warehouse, errors[], order_count, total_pick_weight,
    shopify_weight, weight_diff_pct}. Sorted by order_count desc.
    """
    from routers.shopify_sku_rules import _resolve_canonical

    # Pull staged-order line items: (shopify_sku, assigned_warehouse, order_id)
    rows = (
        db.query(
            models.ShopifyLineItem.shopify_sku,
            models.ShopifyOrder.assigned_warehouse,
            models.ShopifyLineItem.shopify_order_id,
        )
        .join(
            models.ShopifyOrder,
            models.ShopifyLineItem.shopify_order_id == models.ShopifyOrder.shopify_order_id,
        )
        .filter(
            models.ShopifyOrder.app_status == "staged",
            models.ShopifyLineItem.shopify_sku.isnot(None),
        )
        .all()
    )

    if not rows:
        return []

    # Map (warehouse, canonical_sku) -> set(order_ids) for the affected-order count
    canonical_map: dict[tuple[str, str], set[str]] = {}
    for shopify_sku, warehouse, order_id in rows:
        canonical = _resolve_canonical(db, shopify_sku)
        canonical_map.setdefault((warehouse, canonical), set()).add(order_id)

    # Reuse the grouped endpoint's logic to get error data for everything that erred.
    groups = list_grouped_sku_mappings(
        warehouse=None,
        search=None,
        errors_only=True,
        skip=0,
        limit=2000,
        db=db,
    )

    out: list[dict] = []
    for g in groups:
        key = (g["warehouse"], g["shopify_sku"])
        if key not in canonical_map:
            continue
        out.append({
            "shopify_sku": g["shopify_sku"],
            "warehouse": g["warehouse"],
            "errors": g["errors"],
            "order_count": len(canonical_map[key]),
            "total_pick_weight": g["summary"]["total_pick_weight"],
            "shopify_weight": g["summary"]["shopify_weight"],
            "weight_diff_pct": g["summary"]["weight_diff_pct"],
        })

    out.sort(key=lambda x: (-x["order_count"], x["shopify_sku"]))
    return out


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
