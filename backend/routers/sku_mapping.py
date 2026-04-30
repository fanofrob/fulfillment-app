from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from sqlalchemy.orm import Session

from database import get_db
import models
from services import sheets_service

router = APIRouter()


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
    """
    Invalidate the SKU mapping cache and recompute all open orders so they
    reflect the latest mappings (re-resolves pick_skus, re-applies short-ship,
    replans changed orders, unstages anything that no longer fits). Then
    refresh the box snapshots of any confirmed orders whose pick_skus changed,
    across every non-archived projection period — using each row's existing
    mapping_used so per-order intent is preserved.
    """
    sheets_service.invalidate("sku_walnut")
    sheets_service.invalidate("sku_northlake")
    sheets_service.invalidate("sku_type_data")

    from services.order_recompute import recompute_open_orders
    from services.projection_confirmed_orders_service import auto_reconfirm_across_periods

    result = recompute_open_orders(db)
    reconfirm = auto_reconfirm_across_periods(db, result.get("orders_changed_ids") or [])

    return {
        "status": "cache cleared",
        # Legacy field — equivalent to "orders that no longer match staging requirements".
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
