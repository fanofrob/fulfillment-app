"""
Historical Data router — ingestion of historical sales from Shopify and
CRUD for historical promotion tagging.
"""
import csv
import io
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
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
        # Find latest existing data for incremental sync.
        # Floor to midnight so we re-fetch the full day and daily order counts
        # stay correct (partial-day fetches would undercount).
        latest = db.query(sqlfunc.max(models.HistoricalSales.hour_bucket)).scalar()
        if latest:
            start_date = latest.replace(hour=0, minute=0, second=0, microsecond=0)
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

    # Aggregate into hourly buckets + daily distinct-order counts + per-line-item rows
    buckets, daily_orders, line_items = _aggregate_to_hourly(orders)

    # Upsert daily distinct-order counts
    for day, order_count in daily_orders.items():
        existing_day = (
            db.query(models.HistoricalDailyOrders)
            .filter(models.HistoricalDailyOrders.day == day)
            .first()
        )
        if existing_day:
            existing_day.order_count = order_count
        else:
            db.add(models.HistoricalDailyOrders(day=day, order_count=order_count))

    # Replace per-line-item rows for the affected date range so re-ingestion
    # stays idempotent (Shopify returns all orders >= created_at_min).
    if line_items:
        earliest = min(li["created_at_shopify"] for li in line_items)
        db.query(models.HistoricalOrderLineItem).filter(
            models.HistoricalOrderLineItem.created_at_shopify >= earliest
        ).delete(synchronize_session=False)
        db.bulk_insert_mappings(models.HistoricalOrderLineItem, line_items)

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


@router.get("/sales/export")
def export_sales_csv(
    start: Optional[str] = Query(None, description="ISO datetime"),
    end: Optional[str] = Query(None, description="ISO datetime"),
    db: Session = Depends(get_db),
):
    """Stream historical_sales as CSV for external comparison."""
    q = db.query(models.HistoricalSales).order_by(
        models.HistoricalSales.hour_bucket, models.HistoricalSales.shopify_sku
    )
    if start:
        q = q.filter(models.HistoricalSales.hour_bucket >= datetime.fromisoformat(start))
    if end:
        q = q.filter(models.HistoricalSales.hour_bucket <= datetime.fromisoformat(end))

    def rows():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["hour_bucket", "shopify_sku", "order_count", "quantity_sold", "revenue"])
        yield buf.getvalue(); buf.seek(0); buf.truncate(0)
        for r in q.yield_per(1000):
            w.writerow([
                r.hour_bucket.isoformat() if r.hour_bucket else "",
                r.shopify_sku,
                r.order_count,
                r.quantity_sold,
                f"{r.revenue:.2f}",
            ])
            yield buf.getvalue(); buf.seek(0); buf.truncate(0)

    filename = f"historical_sales_{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/daily-orders/export")
def export_daily_orders_csv(db: Session = Depends(get_db)):
    """Stream historical_daily_orders as CSV — one row per calendar day."""
    q = db.query(models.HistoricalDailyOrders).order_by(models.HistoricalDailyOrders.day)

    def rows():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["day", "order_count"])
        yield buf.getvalue(); buf.seek(0); buf.truncate(0)
        for r in q.yield_per(1000):
            w.writerow([r.day.isoformat() if r.day else "", r.order_count])
            yield buf.getvalue(); buf.seek(0); buf.truncate(0)

    filename = f"historical_daily_orders_{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/orders/export")
def export_orders_csv(
    start: Optional[str] = Query(None, description="ISO date/datetime"),
    end: Optional[str] = Query(None, description="ISO date/datetime"),
    db: Session = Depends(get_db),
):
    """
    Stream per-line-item historical orders as CSV: one row per order line.
    Columns: order_number, shopify_order_id, created_at, tags, financial_status,
    fulfillment_status, shopify_sku, product_title, variant_title, quantity, price, discount.
    """
    q = db.query(models.HistoricalOrderLineItem).order_by(
        models.HistoricalOrderLineItem.created_at_shopify,
        models.HistoricalOrderLineItem.shopify_order_id,
    )
    if start:
        q = q.filter(models.HistoricalOrderLineItem.created_at_shopify >= datetime.fromisoformat(start))
    if end:
        q = q.filter(models.HistoricalOrderLineItem.created_at_shopify <= datetime.fromisoformat(end))

    def rows():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow([
            "order_number", "shopify_order_id", "created_at", "tags",
            "financial_status", "fulfillment_status",
            "shopify_sku", "product_title", "variant_title",
            "quantity", "price", "discount",
        ])
        yield buf.getvalue(); buf.seek(0); buf.truncate(0)
        for r in q.yield_per(1000):
            w.writerow([
                r.shopify_order_number or "",
                r.shopify_order_id,
                r.created_at_shopify.isoformat() if r.created_at_shopify else "",
                r.tags or "",
                r.financial_status or "",
                r.fulfillment_status or "",
                r.shopify_sku or "",
                r.product_title or "",
                r.variant_title or "",
                r.quantity,
                f"{r.price:.2f}",
                f"{r.discount:.2f}",
            ])
            yield buf.getvalue(); buf.seek(0); buf.truncate(0)

    filename = f"historical_orders_{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("/sales/")
def clear_sales(db: Session = Depends(get_db)):
    """Delete all historical sales data (for re-ingestion)."""
    count = db.query(models.HistoricalSales).delete()
    db.query(models.HistoricalDailyOrders).delete()
    db.query(models.HistoricalOrderLineItem).delete()
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


def _aggregate_to_hourly(orders: list) -> tuple[dict, dict, list]:
    """
    Aggregate raw Shopify orders into hourly buckets by SKU + daily distinct-order counts
    + flat per-line-item records for CSV export.
    Returns:
      buckets: {(hour_bucket, shopify_sku): {order_count, quantity_sold, revenue}}
      daily_orders: {date: distinct_order_count}
      line_items: list of dicts ready for HistoricalOrderLineItem bulk insert
    """
    buckets = {}
    daily_order_ids: dict = {}
    line_item_rows: list = []

    for order in orders:
        # Skip subscription priority-pass orders (auto-archived + pass-only)
        if shopify_service.should_exclude_from_historical(order):
            continue

        created_at_str = order.get("created_at", "")
        if not created_at_str:
            continue
        try:
            created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
        except ValueError:
            continue

        hour_bucket = created_at.replace(minute=0, second=0, microsecond=0)
        day = created_at.date()
        order_id = order.get("id")
        if order_id is not None:
            daily_order_ids.setdefault(day, set()).add(order_id)

        order_number = order.get("name") or order.get("order_number")
        tags = order.get("tags") or ""
        financial_status = order.get("financial_status")
        fulfillment_status = order.get("fulfillment_status")

        skus_in_order = set()

        for li in order.get("line_items", []):
            sku = li.get("sku") or ""
            qty = li.get("quantity", 0)
            unit_price = float(li.get("price", 0) or 0)
            price = unit_price * qty
            discount = 0.0
            for disc in li.get("discount_allocations", []):
                discount += float(disc.get("amount", 0) or 0)

            # Per-line-item record (even if SKU is blank — capture everything)
            line_item_rows.append({
                "shopify_order_id":     str(order_id) if order_id is not None else "",
                "shopify_order_number": str(order_number) if order_number is not None else None,
                "created_at_shopify":   created_at,
                "tags":                 tags,
                "financial_status":     financial_status,
                "fulfillment_status":   fulfillment_status,
                "shopify_sku":          sku or None,
                "product_title":        li.get("title") or None,
                "variant_title":        li.get("variant_title") or None,
                "quantity":             qty,
                "price":                price,
                "discount":             discount,
            })

            # Aggregate buckets only for real SKUs
            if not sku:
                continue
            revenue = price - discount
            key = (hour_bucket, sku)
            if key not in buckets:
                buckets[key] = {"order_count": 0, "quantity_sold": 0, "revenue": 0.0}
            buckets[key]["quantity_sold"] += qty
            buckets[key]["revenue"] += revenue
            skus_in_order.add(sku)

        for sku in skus_in_order:
            key = (hour_bucket, sku)
            if key in buckets:
                buckets[key]["order_count"] += 1

    daily_orders = {d: len(ids) for d, ids in daily_order_ids.items()}
    return buckets, daily_orders, line_item_rows
