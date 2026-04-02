"""
Historical Data router — ingestion of historical sales from Shopify and
CRUD for historical promotion tagging.
"""
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func as sqlfunc

from database import get_db
import models
import schemas
from services import shopify_service

router = APIRouter()


# ── Historical Sales Ingestion ───────────────────────────────────────────────

@router.post("/sales/ingest", response_model=schemas.HistoricalSalesIngestionResult)
def ingest_historical_sales(
    since: Optional[str] = Query(None, description="ISO date to start from (e.g. 2025-01-01). If omitted, pulls all time."),
    db: Session = Depends(get_db),
):
    """
    Pull historical Shopify orders and aggregate into hourly sales buckets.
    Incremental: only processes orders newer than the latest existing data
    (unless `since` is specified to force a specific start date).
    """
    if not shopify_service.is_configured():
        raise HTTPException(status_code=503, detail="Shopify not connected.")

    # Determine the start date
    if since:
        try:
            start_date = datetime.fromisoformat(since).replace(tzinfo=timezone.utc)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid date format: {since}")
    else:
        # Find latest existing data for incremental sync
        latest = db.query(sqlfunc.max(models.HistoricalSales.hour_bucket)).scalar()
        if latest:
            start_date = latest
        else:
            start_date = None  # pull everything

    # Fetch orders from Shopify
    orders = _fetch_shopify_orders_for_history(start_date)

    if not orders:
        return {
            "total_orders_processed": 0,
            "total_sales_rows_upserted": 0,
            "errors": [],
        }

    # Aggregate into hourly buckets
    buckets = _aggregate_to_hourly(orders)

    # Upsert into historical_sales
    upserted = 0
    errors = []
    date_min = None
    date_max = None

    for (hour_bucket, shopify_sku), data in buckets.items():
        if date_min is None or hour_bucket < date_min:
            date_min = hour_bucket
        if date_max is None or hour_bucket > date_max:
            date_max = hour_bucket

        existing = (
            db.query(models.HistoricalSales)
            .filter(
                models.HistoricalSales.hour_bucket == hour_bucket,
                models.HistoricalSales.shopify_sku == shopify_sku,
            )
            .first()
        )
        if existing:
            existing.order_count = data["order_count"]
            existing.quantity_sold = data["quantity_sold"]
            existing.revenue = data["revenue"]
        else:
            db.add(models.HistoricalSales(
                hour_bucket=hour_bucket,
                shopify_sku=shopify_sku,
                order_count=data["order_count"],
                quantity_sold=data["quantity_sold"],
                revenue=data["revenue"],
            ))
        upserted += 1

    db.commit()

    return {
        "total_orders_processed": len(orders),
        "total_sales_rows_upserted": upserted,
        "date_range_start": date_min,
        "date_range_end": date_max,
        "errors": errors,
    }


@router.get("/sales/summary")
def sales_summary(db: Session = Depends(get_db)):
    """Summary statistics about ingested historical sales data."""
    total_rows = db.query(models.HistoricalSales).count()
    if total_rows == 0:
        return {"total_rows": 0, "date_range_start": None, "date_range_end": None, "unique_skus": 0}

    date_min = db.query(sqlfunc.min(models.HistoricalSales.hour_bucket)).scalar()
    date_max = db.query(sqlfunc.max(models.HistoricalSales.hour_bucket)).scalar()
    unique_skus = db.query(models.HistoricalSales.shopify_sku).distinct().count()
    total_orders = db.query(sqlfunc.sum(models.HistoricalSales.order_count)).scalar() or 0

    return {
        "total_rows": total_rows,
        "date_range_start": date_min,
        "date_range_end": date_max,
        "unique_skus": unique_skus,
        "total_orders": total_orders,
    }


@router.get("/sales/", response_model=List[schemas.HistoricalSalesResponse])
def list_sales(
    shopify_sku: Optional[str] = Query(None),
    start: Optional[str] = Query(None, description="ISO datetime for range start"),
    end: Optional[str] = Query(None, description="ISO datetime for range end"),
    skip: int = Query(0),
    limit: int = Query(500),
    db: Session = Depends(get_db),
):
    q = db.query(models.HistoricalSales).order_by(models.HistoricalSales.hour_bucket.desc())
    if shopify_sku:
        q = q.filter(models.HistoricalSales.shopify_sku == shopify_sku)
    if start:
        q = q.filter(models.HistoricalSales.hour_bucket >= datetime.fromisoformat(start))
    if end:
        q = q.filter(models.HistoricalSales.hour_bucket <= datetime.fromisoformat(end))
    return q.offset(skip).limit(limit).all()


@router.delete("/sales/")
def clear_sales(db: Session = Depends(get_db)):
    """Delete all historical sales data (for re-ingestion)."""
    count = db.query(models.HistoricalSales).delete()
    db.commit()
    return {"deleted": count}


# ── Historical Promotions CRUD ───────────────────────────────────────────────

@router.get("/promotions/", response_model=List[schemas.HistoricalPromotionResponse])
def list_promotions(db: Session = Depends(get_db)):
    return (
        db.query(models.HistoricalPromotion)
        .order_by(models.HistoricalPromotion.start_datetime.desc())
        .all()
    )


@router.get("/promotions/{promo_id}", response_model=schemas.HistoricalPromotionResponse)
def get_promotion(promo_id: int, db: Session = Depends(get_db)):
    promo = db.query(models.HistoricalPromotion).filter(models.HistoricalPromotion.id == promo_id).first()
    if not promo:
        raise HTTPException(status_code=404, detail="Promotion not found")
    return promo


@router.post("/promotions/", response_model=schemas.HistoricalPromotionResponse)
def create_promotion(body: schemas.HistoricalPromotionCreate, db: Session = Depends(get_db)):
    if body.end_datetime <= body.start_datetime:
        raise HTTPException(status_code=400, detail="end_datetime must be after start_datetime")
    if body.scope == "sku_specific" and not body.affected_skus:
        raise HTTPException(status_code=400, detail="affected_skus required when scope is sku_specific")
    promo = models.HistoricalPromotion(**body.model_dump())
    db.add(promo)
    db.commit()
    db.refresh(promo)
    return promo


@router.put("/promotions/{promo_id}", response_model=schemas.HistoricalPromotionResponse)
def update_promotion(promo_id: int, body: schemas.HistoricalPromotionUpdate, db: Session = Depends(get_db)):
    promo = db.query(models.HistoricalPromotion).filter(models.HistoricalPromotion.id == promo_id).first()
    if not promo:
        raise HTTPException(status_code=404, detail="Promotion not found")
    updates = body.model_dump(exclude_unset=True)
    for k, v in updates.items():
        setattr(promo, k, v)
    db.commit()
    db.refresh(promo)
    return promo


@router.delete("/promotions/{promo_id}")
def delete_promotion(promo_id: int, db: Session = Depends(get_db)):
    promo = db.query(models.HistoricalPromotion).filter(models.HistoricalPromotion.id == promo_id).first()
    if not promo:
        raise HTTPException(status_code=404, detail="Promotion not found")
    db.delete(promo)
    db.commit()
    return {"deleted": True, "id": promo_id}


# ── Internal helpers ─────────────────────────────────────────────────────────

def _fetch_shopify_orders_for_history(since: datetime = None) -> list:
    """
    Fetch historical orders from Shopify REST API.
    Uses the any-status endpoint to get all orders (not just unfulfilled).
    """
    import requests

    token = shopify_service.get_access_token()
    shop = shopify_service.SHOPIFY_SHOP_DOMAIN
    if not shop or not token:
        return []

    headers = {"X-Shopify-Access-Token": token}
    all_orders = []
    params = {
        "status": "any",
        "limit": 250,
        "order": "created_at asc",
    }
    if since:
        params["created_at_min"] = since.isoformat()

    url = f"https://{shop}/admin/api/2024-01/orders.json"

    while url:
        resp = requests.get(url, headers=headers, params=params)
        if resp.status_code != 200:
            break
        data = resp.json()
        orders = data.get("orders", [])
        all_orders.extend(orders)

        # Pagination via Link header
        url = None
        params = {}  # params already encoded in the next URL
        link_header = resp.headers.get("Link", "")
        for part in link_header.split(","):
            if 'rel="next"' in part:
                url = part.split("<")[1].split(">")[0]
                break

    return all_orders


def _aggregate_to_hourly(orders: list) -> dict:
    """
    Aggregate raw Shopify orders into hourly buckets by SKU.
    Returns: {(hour_bucket_datetime, shopify_sku): {order_count, quantity_sold, revenue}}
    """
    buckets = {}

    for order in orders:
        created_at_str = order.get("created_at", "")
        if not created_at_str:
            continue
        try:
            created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
        except ValueError:
            continue

        # Truncate to hour
        hour_bucket = created_at.replace(minute=0, second=0, microsecond=0)

        # Track which SKUs appear in this order (for order_count)
        skus_in_order = set()

        for li in order.get("line_items", []):
            sku = li.get("sku") or ""
            if not sku:
                continue
            qty = li.get("quantity", 0)
            price = float(li.get("price", 0)) * qty
            discount = 0
            for disc in li.get("discount_allocations", []):
                discount += float(disc.get("amount", 0))
            revenue = price - discount

            key = (hour_bucket, sku)
            if key not in buckets:
                buckets[key] = {"order_count": 0, "quantity_sold": 0, "revenue": 0.0}

            buckets[key]["quantity_sold"] += qty
            buckets[key]["revenue"] += revenue
            skus_in_order.add(sku)

        # Increment order_count for each SKU that appeared
        for sku in skus_in_order:
            key = (hour_bucket, sku)
            if key in buckets:
                buckets[key]["order_count"] += 1

    return buckets
