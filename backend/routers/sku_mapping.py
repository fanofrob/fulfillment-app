from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from sqlalchemy.orm import Session

from database import get_db
import models
from services import sheets_service

router = APIRouter()


def _unstage_orders_with_changed_skus(db: Session) -> int:
    """
    After a SKU mapping cache refresh, re-check all staged orders.
    Any staged order whose line items would now resolve to different pick_skus
    is moved back to not_processed and committed inventory is recomputed.
    Returns the count of orders unstaged.
    """
    from routers.inventory import _recompute_committed

    staged_orders = (
        db.query(models.ShopifyOrder)
        .filter(models.ShopifyOrder.app_status == "staged")
        .all()
    )
    if not staged_orders:
        return 0

    # Cache lookups per warehouse so we only hit Sheets once each
    wh_lookups: dict = {}
    def get_lookup(wh: str) -> dict:
        if wh not in wh_lookups:
            try:
                wh_lookups[wh] = sheets_service.get_sku_mapping_lookup(wh)
            except Exception:
                wh_lookups[wh] = {}
        return wh_lookups[wh]

    orders_unstaged = 0
    affected_warehouses: set = set()

    for order in staged_orders:
        wh = order.assigned_warehouse or "walnut"
        sku_lookup = get_lookup(wh)

        line_items = (
            db.query(models.ShopifyLineItem)
            .filter(models.ShopifyLineItem.shopify_order_id == order.shopify_order_id)
            .all()
        )

        # Group current pick_skus by shopify_sku
        current_by_shopify: dict = {}
        for li in line_items:
            if li.shopify_sku:
                current_by_shopify.setdefault(li.shopify_sku, set()).add(li.pick_sku)

        changed = False
        for shopify_sku, current_pick_skus in current_by_shopify.items():
            new_mappings = sku_lookup.get(shopify_sku)
            if new_mappings is None:
                new_pick_skus = {None}
            else:
                new_pick_skus = {m.get("pick_sku") for m in new_mappings}
            if new_pick_skus != current_pick_skus:
                changed = True
                break

        if changed:
            order.app_status = "not_processed"
            orders_unstaged += 1
            if order.assigned_warehouse:
                affected_warehouses.add(order.assigned_warehouse)

    if orders_unstaged:
        db.flush()
        for wh in affected_warehouses:
            _recompute_committed(wh, db)

    return orders_unstaged


@router.get("/")
def list_sku_mappings(
    warehouse: Optional[str] = Query(None),
    shopify_sku: Optional[str] = Query(None),
    errors_only: bool = Query(False),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
):
    if not sheets_service.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured yet. Add credentials.json to the backend folder.")
    try:
        if warehouse:
            return sheets_service.get_sku_mappings(warehouse, search=shopify_sku, skip=skip, limit=limit, errors_only=errors_only)
        return sheets_service.get_sku_mappings_both(search=shopify_sku, skip=skip, limit=limit, errors_only=errors_only)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/refresh")
def refresh_sku_cache(db: Session = Depends(get_db)):
    sheets_service.invalidate("sku_walnut")
    sheets_service.invalidate("sku_northlake")
    sheets_service.invalidate("sku_type_data")
    orders_unstaged = _unstage_orders_with_changed_skus(db)
    db.commit()
    return {"status": "cache cleared", "orders_unstaged": orders_unstaged}


@router.get("/resolve")
def resolve_sku(shopify_sku: str = Query(...), warehouse: str = Query("walnut")):
    """
    Debug endpoint: show how a Shopify SKU resolves to pick SKU(s).
    Returns the helper SKU (if any) and the final pick SKU mappings.
    """
    if not sheets_service.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured yet.")
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
