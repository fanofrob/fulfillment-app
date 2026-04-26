"""
Data-quality diagnostics for projection inputs.

Given a generated projection, report per-SKU coverage/history stats so the user
can decide whether to adjust the historical range or override the projection.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from sqlalchemy.orm import Session

import models
from services import projection_service


# Coverage-flag thresholds — keep in one place for backend + future UI parity
MIN_ACTIVE_WEEKS_GREEN = 3
MIN_FIRST_SEEN_DAYS_GREEN = 14
MIN_FIRST_SEEN_DAYS_YELLOW = 3
MAX_GAP_DAYS_GREEN = 7
CONTRIB_THRESHOLD_PCT = 5.0  # SKUs below this % of row lbs don't influence row badge


def _week_index(bucket: datetime, hist_range_end: datetime) -> int:
    """Which rolling 7-day bucket (0 = most recent) contains this bucket."""
    delta_seconds = (hist_range_end - bucket).total_seconds()
    return int(delta_seconds // (7 * 86400))


def _coverage_flag(
    active_weeks: int,
    first_seen_days_ago: float | None,
    longest_gap_days: float | None,
) -> str:
    if active_weeks == 0 or (first_seen_days_ago is not None and first_seen_days_ago < MIN_FIRST_SEEN_DAYS_YELLOW):
        return "red"
    yellow = (
        active_weeks < MIN_ACTIVE_WEEKS_GREEN
        or (longest_gap_days is not None and longest_gap_days > MAX_GAP_DAYS_GREEN)
        or (first_seen_days_ago is not None and first_seen_days_ago < MIN_FIRST_SEEN_DAYS_GREEN)
    )
    return "yellow" if yellow else "green"


def _iter_shopify_skus_for_product_type(sku_lookup: dict, product_type: str):
    """Yield (shopify_sku, mix_quantity) tuples that roll up to this product_type."""
    for shopify_sku, entries in sku_lookup.items():
        for e in entries:
            if e.get("product_type") == product_type and e.get("pick_sku"):
                yield shopify_sku, float(e.get("mix_quantity") or 1.0), e.get("pick_sku")


def _sku_history_stats(
    bucket_rows: list[tuple[datetime, int, int]],
    hist_range_start: datetime,
    hist_range_end: datetime,
) -> dict:
    """
    Compute per-SKU coverage stats from a list of (hour_bucket, qty, orders).
    Assumes bucket_rows are already filtered to a single SKU and promo-excluded.
    """
    if not bucket_rows:
        return {
            "total_qty": 0,
            "total_orders": 0,
            "active_weeks": 0,
            "first_seen": None,
            "last_seen": None,
            "longest_gap_days": None,
            "zero_sales_day_count": (hist_range_end.date() - hist_range_start.date()).days + 1,
            "zero_sales_dates": [],  # populated below only if there's at least some history
        }

    total_qty = sum(q for _, q, _ in bucket_rows)
    total_orders = sum(o for _, _, o in bucket_rows)

    weeks = {_week_index(b, hist_range_end) for b, q, _ in bucket_rows if q > 0}
    active_weeks = len(weeks)

    sales_buckets = [b for b, q, _ in bucket_rows if q > 0]
    first_seen = min(sales_buckets) if sales_buckets else None
    last_seen = max(sales_buckets) if sales_buckets else None

    # Per-day sale aggregation for gap detection + zero-sales-day list
    day_qty: dict[date, int] = defaultdict(int)
    for b, q, _ in bucket_rows:
        day_qty[b.date()] += q

    # Enumerate all calendar days in the historical window
    all_days = []
    d = hist_range_start.date()
    end_d = hist_range_end.date()
    while d <= end_d:
        all_days.append(d)
        d += timedelta(days=1)

    zero_sales_dates = [d for d in all_days if day_qty.get(d, 0) == 0]

    # Longest gap = longest run of consecutive zero-sales days BETWEEN first_seen and last_seen
    longest_gap_days: float | None = None
    if first_seen and last_seen and first_seen != last_seen:
        run = 0
        max_run = 0
        d = first_seen.date()
        end_d = last_seen.date()
        while d <= end_d:
            if day_qty.get(d, 0) == 0:
                run += 1
                max_run = max(max_run, run)
            else:
                run = 0
            d += timedelta(days=1)
        longest_gap_days = float(max_run) if max_run > 0 else 0.0

    return {
        "total_qty": total_qty,
        "total_orders": total_orders,
        "active_weeks": active_weeks,
        "first_seen": first_seen,
        "last_seen": last_seen,
        "longest_gap_days": longest_gap_days,
        "zero_sales_day_count": len(zero_sales_dates),
        "zero_sales_dates": [d.isoformat() for d in zero_sales_dates],
    }


def get_sku_diagnostics(db: Session, projection_id: int, product_type: str) -> dict:
    """
    Return per-SKU diagnostics for every Shopify SKU that rolls up to `product_type`
    in the given projection's historical window.
    """
    projection = db.query(models.Projection).filter(
        models.Projection.id == projection_id
    ).first()
    if not projection:
        raise ValueError(f"Projection {projection_id} not found")

    period = db.query(models.ProjectionPeriod).filter(
        models.ProjectionPeriod.id == projection.period_id
    ).first()
    if not period:
        raise ValueError(f"Period {projection.period_id} not found")

    hist_start = projection.historical_range_start
    hist_end = projection.historical_range_end
    params = projection.parameters or {}
    warehouse = params.get("warehouse", "walnut")
    excluded_promo_ids = params.get("excluded_promo_ids") or []

    # Reuse the projection engine's lookup so product_type resolution matches exactly
    sku_lookup = projection_service._build_sku_mapping_lookup(db, period, warehouse)
    weight_map = projection_service._build_weight_map(db)

    contributors = list(_iter_shopify_skus_for_product_type(sku_lookup, product_type))
    if not contributors:
        return {
            "projection_id": projection_id,
            "product_type": product_type,
            "historical_range_start": hist_start,
            "historical_range_end": hist_end,
            "skus": [],
        }

    unique_skus = list({sku for sku, _mq, _ps in contributors})

    promo_ranges = projection_service._load_promo_ranges(
        db, hist_start, hist_end, excluded_promo_ids
    )

    # Load all historical rows for these SKUs in one query
    rows = db.query(
        models.HistoricalSales.shopify_sku,
        models.HistoricalSales.hour_bucket,
        models.HistoricalSales.quantity_sold,
        models.HistoricalSales.order_count,
    ).filter(
        models.HistoricalSales.shopify_sku.in_(unique_skus),
        models.HistoricalSales.hour_bucket >= hist_start,
        models.HistoricalSales.hour_bucket <= hist_end,
    ).all()

    per_sku_rows: dict[str, list[tuple[datetime, int, int]]] = defaultdict(list)
    for sku, bucket, qty, orders in rows:
        if projection_service._is_promotional_hour(bucket, sku, promo_ranges):
            continue
        per_sku_rows[sku].append((bucket, qty, orders))

    now = datetime.utcnow()
    results = []
    # One row per (shopify_sku, mix_quantity, pick_sku) — preserves duplicate sheet rows
    for shopify_sku, mix_qty, pick_sku in contributors:
        stats = _sku_history_stats(per_sku_rows.get(shopify_sku, []), hist_start, hist_end)

        first_seen_days_ago = None
        if stats["first_seen"]:
            first_seen_days_ago = (now - stats["first_seen"]).total_seconds() / 86400

        flag = _coverage_flag(
            stats["active_weeks"], first_seen_days_ago, stats["longest_gap_days"]
        )

        weight = weight_map.get(pick_sku, 0.0)
        # Lbs if every historical qty were projected 1:1 — not the real projection
        # contribution (which uses hourly averaging + multipliers), but a useful
        # "size of the input" signal for ranking.
        hist_lbs_contribution = stats["total_qty"] * mix_qty * weight

        results.append({
            "shopify_sku": shopify_sku,
            "pick_sku": pick_sku,
            "mix_quantity": mix_qty,
            "pick_weight_lb": weight,
            "active_weeks": stats["active_weeks"],
            "first_seen": stats["first_seen"],
            "last_seen": stats["last_seen"],
            "first_seen_days_ago": round(first_seen_days_ago, 1) if first_seen_days_ago is not None else None,
            "longest_gap_days": stats["longest_gap_days"],
            "zero_sales_day_count": stats["zero_sales_day_count"],
            "zero_sales_dates": stats["zero_sales_dates"],
            "total_qty": stats["total_qty"],
            "total_orders": stats["total_orders"],
            "historical_lbs_contribution": round(hist_lbs_contribution, 2),
            "coverage": flag,
        })

    # Sort by historical contribution desc so largest drivers surface first
    results.sort(key=lambda r: -r["historical_lbs_contribution"])

    return {
        "projection_id": projection_id,
        "product_type": product_type,
        "historical_range_start": hist_start,
        "historical_range_end": hist_end,
        "skus": results,
    }


def get_coverage_summary(db: Session, projection_id: int) -> dict:
    """
    Return one coverage flag per product_type for this projection's rows.
    Flag = worst color among contributors with > CONTRIB_THRESHOLD_PCT of the row's
    historical-lbs contribution (prevents a trivial long-tail SKU from tanking a row).
    """
    projection = db.query(models.Projection).filter(
        models.Projection.id == projection_id
    ).first()
    if not projection:
        raise ValueError(f"Projection {projection_id} not found")

    period = db.query(models.ProjectionPeriod).filter(
        models.ProjectionPeriod.id == projection.period_id
    ).first()
    if not period:
        raise ValueError(f"Period {projection.period_id} not found")

    hist_start = projection.historical_range_start
    hist_end = projection.historical_range_end
    params = projection.parameters or {}
    warehouse = params.get("warehouse", "walnut")
    excluded_promo_ids = params.get("excluded_promo_ids") or []

    sku_lookup = projection_service._build_sku_mapping_lookup(db, period, warehouse)
    weight_map = projection_service._build_weight_map(db)

    # Collect (product_type, shopify_sku, mix_qty, pick_sku) tuples for every line
    by_pt: dict[str, list[tuple[str, float, str]]] = defaultdict(list)
    for shopify_sku, entries in sku_lookup.items():
        for e in entries:
            pt = e.get("product_type")
            ps = e.get("pick_sku")
            if pt and ps:
                by_pt[pt].append((shopify_sku, float(e.get("mix_quantity") or 1.0), ps))

    # Only report on product_types that appear in the projection's lines
    line_pts = {
        l.product_type for l in
        db.query(models.ProjectionLine).filter(
            models.ProjectionLine.projection_id == projection_id
        ).all()
    }

    relevant = {pt: contribs for pt, contribs in by_pt.items() if pt in line_pts}
    if not relevant:
        return {"projection_id": projection_id, "product_types": {}}

    # Pull all needed SKUs in one query
    all_skus = sorted({sku for contribs in relevant.values() for sku, _, _ in contribs})
    rows = db.query(
        models.HistoricalSales.shopify_sku,
        models.HistoricalSales.hour_bucket,
        models.HistoricalSales.quantity_sold,
        models.HistoricalSales.order_count,
    ).filter(
        models.HistoricalSales.shopify_sku.in_(all_skus),
        models.HistoricalSales.hour_bucket >= hist_start,
        models.HistoricalSales.hour_bucket <= hist_end,
    ).all() if all_skus else []

    promo_ranges = projection_service._load_promo_ranges(
        db, hist_start, hist_end, excluded_promo_ids
    )

    per_sku_rows: dict[str, list[tuple[datetime, int, int]]] = defaultdict(list)
    for sku, bucket, qty, orders in rows:
        if projection_service._is_promotional_hour(bucket, sku, promo_ranges):
            continue
        per_sku_rows[sku].append((bucket, qty, orders))

    now = datetime.utcnow()
    rank = {"green": 0, "yellow": 1, "red": 2}

    summary: dict[str, dict] = {}
    for pt, contribs in relevant.items():
        # Compute each SKU's stats + lbs contribution to this product type
        rows_for_pt = []
        total_lbs = 0.0
        for shopify_sku, mix_qty, pick_sku in contribs:
            stats = _sku_history_stats(per_sku_rows.get(shopify_sku, []), hist_start, hist_end)
            first_seen_days_ago = (
                (now - stats["first_seen"]).total_seconds() / 86400
                if stats["first_seen"] else None
            )
            flag = _coverage_flag(stats["active_weeks"], first_seen_days_ago, stats["longest_gap_days"])
            weight = weight_map.get(pick_sku, 0.0)
            lbs = stats["total_qty"] * mix_qty * weight
            total_lbs += lbs
            rows_for_pt.append((flag, lbs, stats["active_weeks"], stats["total_qty"]))

        # Determine the row badge: worst flag among material contributors
        threshold = total_lbs * (CONTRIB_THRESHOLD_PCT / 100.0)
        material = [r for r in rows_for_pt if r[1] >= threshold] if total_lbs > 0 else rows_for_pt

        # Edge case: no material contributors (total_lbs == 0 OR all below threshold)
        # → fall back to the worst flag across all contributors
        ranked_source = material if material else rows_for_pt
        worst_flag = max((r[0] for r in ranked_source), key=lambda f: rank.get(f, 0), default="green")

        summary[pt] = {
            "coverage": worst_flag,
            "sku_count": len(rows_for_pt),
            "red_count": sum(1 for r in rows_for_pt if r[0] == "red"),
            "yellow_count": sum(1 for r in rows_for_pt if r[0] == "yellow"),
            "green_count": sum(1 for r in rows_for_pt if r[0] == "green"),
        }

    return {"projection_id": projection_id, "product_types": summary}
