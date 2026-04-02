"""
Projection engine — generates demand forecasts per projection period.

Primary entrypoint: generate_projection(db, period_id, params)
"""
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session

import models
from services import sheets_service


def generate_projection(
    db: Session,
    period_id: int,
    historical_weeks: int = 4,
    excluded_promo_ids: list[int] | None = None,
    promotion_multiplier: float | None = None,
    warehouse: str = "walnut",
) -> models.Projection:
    """
    Generate a point-in-time demand projection for a projection period.
    Returns the persisted Projection with lines.
    """
    now = datetime.utcnow()  # naive UTC to match SQLite storage
    excluded_promo_ids = excluded_promo_ids or []

    # ── Step 1: Load and validate period ─────────────────────────────────────
    period = db.query(models.ProjectionPeriod).filter(
        models.ProjectionPeriod.id == period_id
    ).first()
    if not period:
        raise ValueError(f"Projection period {period_id} not found")
    if period.status == "closed":
        raise ValueError(f"Period {period_id} is closed; cannot generate projection")

    # ── Step 2: Build SKU mapping lookup ─────────────────────────────────────
    sku_lookup = _build_sku_mapping_lookup(db, period, warehouse)

    # Build pick_sku → weight_lb map from PicklistSku
    weight_map = _build_weight_map(db)

    # ── Step 3: Load period configs ──────────────────────────────────────────
    short_ship_skus = {
        c.shopify_sku for c in
        db.query(models.PeriodShortShipConfig).filter(
            models.PeriodShortShipConfig.period_id == period_id
        ).all()
    }
    inventory_hold_skus = {
        c.shopify_sku for c in
        db.query(models.PeriodInventoryHoldConfig).filter(
            models.PeriodInventoryHoldConfig.period_id == period_id
        ).all()
    }
    padding_configs = {
        pc.product_type: pc.padding_pct for pc in
        db.query(models.ProjectionPaddingConfig).all()
    }

    # ── Step 4: Confirmed demand ─────────────────────────────────────────────
    confirmed_demand, confirmed_orders, unmapped_skus_confirmed = _calc_confirmed_demand(
        db, period, sku_lookup, weight_map, short_ship_skus, inventory_hold_skus,
    )

    # ── Step 5: Projected demand (historical forecast) ───────────────────────
    hist_range_start = now - timedelta(weeks=max(historical_weeks, 1))
    hist_range_end = now
    projected_demand, projected_orders, unmapped_skus_projected, hist_rows_used = _calc_projected_demand(
        db, period, sku_lookup, weight_map, now,
        hist_range_start, hist_range_end,
        excluded_promo_ids, promotion_multiplier,
    )

    # ── Step 6: On-hand inventory ────────────────────────────────────────────
    on_hand = _calc_on_hand(db, weight_map, warehouse)

    # ── Step 7: Expected on-hand (Period 2+) ─────────────────────────────────
    expected_on_hand = _calc_expected_on_hand(db, period)

    # ── Step 8: Assemble product types, padding & gap ────────────────────────
    on_order_map = _calc_on_order(db, period_id)
    all_product_types = set(confirmed_demand) | set(projected_demand) | set(on_hand) | set(expected_on_hand) | set(on_order_map)

    # Get case weights from PicklistSku for gap_cases calculation
    case_weight_map = _build_case_weight_map(db, sku_lookup)

    lines_data = []
    total_confirmed_lbs = 0.0
    total_projected_lbs = 0.0
    total_demand_lbs = 0.0

    for pt in sorted(all_product_types):
        conf_lbs = confirmed_demand.get(pt, 0.0)
        conf_orders = confirmed_orders.get(pt, 0)
        proj_lbs = projected_demand.get(pt, 0.0)
        proj_orders = projected_orders.get(pt, 0.0)
        total_lbs = conf_lbs + proj_lbs
        padding_pct = padding_configs.get(pt, 0.0)
        padded_lbs = total_lbs * (1 + padding_pct / 100.0)
        oh_lbs = on_hand.get(pt, 0.0)
        eoh_lbs = expected_on_hand.get(pt, 0.0)
        on_order = on_order_map.get(pt, 0.0)
        gap = padded_lbs - oh_lbs - eoh_lbs - on_order

        cw = case_weight_map.get(pt)
        gap_cases = math.ceil(gap / cw) if cw and cw > 0 and gap > 0 else None

        if gap > 0:
            gap_status = "short"
        elif oh_lbs > 0 and gap < -(oh_lbs * 0.5):
            gap_status = "long"
        else:
            gap_status = "ok"

        total_confirmed_lbs += conf_lbs
        total_projected_lbs += proj_lbs
        total_demand_lbs += total_lbs

        lines_data.append({
            "product_type": pt,
            "confirmed_order_count": conf_orders,
            "confirmed_demand_lbs": round(conf_lbs, 2),
            "projected_order_count": round(proj_orders, 2),
            "projected_demand_lbs": round(proj_lbs, 2),
            "total_demand_lbs": round(total_lbs, 2),
            "padding_pct": padding_pct,
            "padded_demand_lbs": round(padded_lbs, 2),
            "on_hand_lbs": round(oh_lbs, 2),
            "expected_on_hand_lbs": round(eoh_lbs, 2),
            "on_order_lbs": on_order,
            "gap_lbs": round(gap, 2),
            "gap_cases": gap_cases,
            "case_weight_lbs": cw,
            "gap_status": gap_status,
            "detail": None,
        })

    # ── Step 9: Methodology report ───────────────────────────────────────────
    all_unmapped = sorted(set(unmapped_skus_confirmed) | set(unmapped_skus_projected))
    hours_remaining = max(0, (period.end_datetime - now).total_seconds() / 3600) if period.end_datetime > now else 0
    total_hours = (period.end_datetime - period.start_datetime).total_seconds() / 3600

    excluded_promos = []
    if excluded_promo_ids:
        promos = db.query(models.HistoricalPromotion).filter(
            models.HistoricalPromotion.id.in_(excluded_promo_ids)
        ).all()
        excluded_promos = [p.name for p in promos]

    methodology = _build_methodology_report(
        generated_at=now,
        hist_range_start=hist_range_start,
        hist_range_end=hist_range_end,
        historical_weeks=historical_weeks,
        hist_rows_used=hist_rows_used,
        excluded_promos=excluded_promos,
        promotion_multiplier=promotion_multiplier,
        confirmed_order_count=sum(confirmed_orders.values()),
        hold_skus_count=len(inventory_hold_skus),
        hours_remaining=hours_remaining,
        total_hours=total_hours,
        sku_mapping_source=period.sku_mapping_sheet_tab or f"default ({warehouse})",
        unmapped_skus=all_unmapped,
        period=period,
    )

    # Shopify data freshness: latest pulled_at from orders
    latest_pull = db.query(models.ShopifyOrder.pulled_at).order_by(
        models.ShopifyOrder.pulled_at.desc()
    ).first()
    shopify_as_of = latest_pull[0] if latest_pull else None

    # ── Step 10: Persist ─────────────────────────────────────────────────────
    # Mark existing projections for this period as superseded
    db.query(models.Projection).filter(
        models.Projection.period_id == period_id,
        models.Projection.status == "current",
    ).update({"status": "superseded"})

    projection = models.Projection(
        period_id=period_id,
        generated_at=now,
        shopify_data_as_of=shopify_as_of,
        historical_range_start=hist_range_start,
        historical_range_end=hist_range_end,
        parameters={
            "historical_weeks": historical_weeks,
            "excluded_promo_ids": excluded_promo_ids,
            "promotion_multiplier": promotion_multiplier,
            "warehouse": warehouse,
        },
        methodology_report=methodology,
        status="current",
        total_confirmed_demand_lbs=round(total_confirmed_lbs, 2),
        total_projected_demand_lbs=round(total_projected_lbs, 2),
        total_demand_lbs=round(total_demand_lbs, 2),
    )
    db.add(projection)
    db.flush()  # get projection.id

    for ld in lines_data:
        line = models.ProjectionLine(projection_id=projection.id, **ld)
        db.add(line)

    db.commit()
    db.refresh(projection)
    return projection


# ── Internal helpers ─────────────────────────────────────────────────────────

def _build_sku_mapping_lookup(
    db: Session, period: models.ProjectionPeriod, warehouse: str
) -> dict:
    """
    Build {shopify_sku: [{"pick_sku", "mix_quantity", "product_type"}, ...]} lookup.
    Uses period-specific Sheets tab if available, otherwise falls back to warehouse default.
    """
    if period.sku_mapping_sheet_tab:
        try:
            lookup = sheets_service.get_period_sku_mapping_lookup(period.sku_mapping_sheet_tab)
            if lookup:
                return lookup
        except Exception as e:
            print(f"[WARN] Failed to load period SKU mapping tab '{period.sku_mapping_sheet_tab}': {e}")

    # Fallback: use default warehouse mapping + enrich with product_type from DB
    base_lookup = sheets_service.get_sku_mapping_lookup(warehouse)
    # The base lookup doesn't include product_type, so enrich from SkuMapping table
    pt_map = {}
    db_mappings = db.query(models.SkuMapping).filter(
        models.SkuMapping.warehouse == warehouse
    ).all()
    for m in db_mappings:
        if m.shopify_sku and m.product_type:
            pt_map[m.shopify_sku] = m.product_type

    enriched = {}
    for sku, entries in base_lookup.items():
        enriched[sku] = []
        for e in entries:
            enriched[sku].append({
                "pick_sku": e["pick_sku"],
                "mix_quantity": e.get("mix_quantity") or 1.0,
                "product_type": pt_map.get(sku),
            })
    return enriched


def _build_weight_map(db: Session) -> dict:
    """Build {pick_sku: weight_lb} from PicklistSku."""
    result = {}
    for ps in db.query(models.PicklistSku).all():
        if ps.pick_sku and ps.weight_lb is not None:
            result[ps.pick_sku] = ps.weight_lb
    return result


def _build_case_weight_map(db: Session, sku_lookup: dict) -> dict:
    """
    Build {product_type: case_weight_lbs} from PicklistSku.case_weight_lb.
    Uses the first available case weight for each product type.
    """
    # First, build pick_sku → product_type map from sku_lookup
    pick_to_pt = {}
    for entries in sku_lookup.values():
        for e in entries:
            if e.get("pick_sku") and e.get("product_type"):
                pick_to_pt[e["pick_sku"]] = e["product_type"]

    result = {}
    for ps in db.query(models.PicklistSku).all():
        if ps.pick_sku and ps.case_weight_lb and ps.case_weight_lb > 0:
            pt = pick_to_pt.get(ps.pick_sku)
            if pt and pt not in result:
                result[pt] = ps.case_weight_lb
    return result


def _resolve_line_item(
    shopify_sku: str, quantity: int,
    sku_lookup: dict, weight_map: dict,
) -> tuple[dict[str, float], set[str]]:
    """
    Resolve a single line item's demand in lbs by product type.
    Returns (demand_by_pt, unmapped_skus).
    """
    demand = defaultdict(float)
    unmapped = set()

    if not shopify_sku or shopify_sku not in sku_lookup:
        if shopify_sku:
            unmapped.add(shopify_sku)
        return dict(demand), unmapped

    for entry in sku_lookup[shopify_sku]:
        pick_sku = entry.get("pick_sku")
        mix_qty = entry.get("mix_quantity") or 1.0
        product_type = entry.get("product_type")

        if not pick_sku or not product_type:
            if shopify_sku:
                unmapped.add(shopify_sku)
            continue

        weight = weight_map.get(pick_sku, 0.0)
        pick_qty = quantity * mix_qty
        lbs = pick_qty * weight
        demand[product_type] += lbs

    return dict(demand), unmapped


def _calc_confirmed_demand(
    db: Session,
    period: models.ProjectionPeriod,
    sku_lookup: dict,
    weight_map: dict,
    short_ship_skus: set,
    inventory_hold_skus: set,
) -> tuple[dict[str, float], dict[str, int], list[str]]:
    """
    Calculate confirmed demand from orders in the period window.
    Returns (demand_lbs_by_pt, order_count_by_pt, unmapped_skus).
    """
    demand = defaultdict(float)
    order_counts = defaultdict(set)  # product_type → set of order IDs (deduplicate)
    all_unmapped = set()

    # Query orders in the period time window that are actionable
    orders = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.created_at_shopify >= period.start_datetime,
        models.ShopifyOrder.created_at_shopify <= period.end_datetime,
        models.ShopifyOrder.app_status.in_([
            "not_processed", "staged", "in_shipstation_not_shipped",
        ]),
    ).all()

    for order in orders:
        line_items = db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == order.shopify_order_id
        ).all()

        for li in line_items:
            sku = li.shopify_sku
            if not sku:
                continue
            # Skip short-shipped SKUs
            if sku in short_ship_skus:
                continue

            li_demand, unmapped = _resolve_line_item(sku, li.quantity, sku_lookup, weight_map)
            all_unmapped.update(unmapped)

            for pt, lbs in li_demand.items():
                demand[pt] += lbs
                order_counts[pt].add(order.shopify_order_id)

    # Convert order_counts from sets to counts
    order_count_result = {pt: len(ids) for pt, ids in order_counts.items()}
    return dict(demand), order_count_result, sorted(all_unmapped)


def _calc_projected_demand(
    db: Session,
    period: models.ProjectionPeriod,
    sku_lookup: dict,
    weight_map: dict,
    now: datetime,
    hist_range_start: datetime,
    hist_range_end: datetime,
    excluded_promo_ids: list[int],
    promotion_multiplier: float | None,
) -> tuple[dict[str, float], dict[str, float], list[str], int]:
    """
    Calculate projected demand from historical hourly sales patterns.
    Returns (demand_lbs_by_pt, order_count_by_pt, unmapped_skus, hist_rows_used).
    """
    demand = defaultdict(float)
    order_counts = defaultdict(float)
    all_unmapped = set()

    # Determine remaining hours in the period
    if now >= period.end_datetime:
        return dict(demand), dict(order_counts), [], 0
    effective_start = max(now, period.start_datetime)

    # Build set of remaining (day_of_week, hour) slots
    remaining_slots = []
    cursor = effective_start.replace(minute=0, second=0, microsecond=0)
    if cursor < effective_start:
        cursor += timedelta(hours=1)
    while cursor < period.end_datetime:
        remaining_slots.append((cursor.weekday(), cursor.hour))
        cursor += timedelta(hours=1)

    if not remaining_slots:
        return dict(demand), dict(order_counts), [], 0

    # Count occurrences of each (dow, hour) slot to know how many hours to project
    slot_counts = defaultdict(int)
    for dow, hour in remaining_slots:
        slot_counts[(dow, hour)] += 1

    # Load historical sales in the date range
    hist_sales = db.query(models.HistoricalSales).filter(
        models.HistoricalSales.hour_bucket >= hist_range_start,
        models.HistoricalSales.hour_bucket <= hist_range_end,
    ).all()

    # Load promotions to exclude
    promo_ranges = _load_promo_ranges(db, hist_range_start, hist_range_end, excluded_promo_ids)

    # Group historical sales by (dow, hour, shopify_sku), excluding promotional hours
    # hist_agg: {(dow, hour, sku): [qty_sold_values]}
    hist_agg = defaultdict(list)
    hist_order_agg = defaultdict(list)
    rows_used = 0

    for hs in hist_sales:
        bucket = hs.hour_bucket
        dow = bucket.weekday()
        hour = bucket.hour

        # Only include slots we need
        if (dow, hour) not in slot_counts:
            continue

        # Check if this hour is in a promotional period
        if _is_promotional_hour(bucket, hs.shopify_sku, promo_ranges):
            continue

        key = (dow, hour, hs.shopify_sku)
        hist_agg[key].append(hs.quantity_sold)
        hist_order_agg[key].append(hs.order_count)
        rows_used += 1

    # For each remaining (dow, hour) slot, project demand using historical averages
    for (dow, hour), count in slot_counts.items():
        # Find all SKUs that had sales in this (dow, hour) historically
        matching_keys = [k for k in hist_agg if k[0] == dow and k[1] == hour]

        for key in matching_keys:
            sku = key[2]
            avg_qty = sum(hist_agg[key]) / len(hist_agg[key])
            avg_orders = sum(hist_order_agg[key]) / len(hist_order_agg[key])

            # Multiply by count (number of times this slot appears in remaining period)
            projected_qty = avg_qty * count
            projected_order = avg_orders * count

            # Apply promotion multiplier
            if promotion_multiplier is not None:
                projected_qty *= promotion_multiplier
                projected_order *= promotion_multiplier

            # Resolve SKU → product type
            li_demand, unmapped = _resolve_line_item(sku, 1, sku_lookup, weight_map)
            all_unmapped.update(unmapped)

            for pt, lbs_per_unit in li_demand.items():
                demand[pt] += lbs_per_unit * projected_qty
                order_counts[pt] += projected_order

    return dict(demand), dict(order_counts), sorted(all_unmapped), rows_used


def _load_promo_ranges(
    db: Session, start: datetime, end: datetime, excluded_promo_ids: list[int]
) -> list[dict]:
    """Load historical promotions that overlap the given range."""
    query = db.query(models.HistoricalPromotion).filter(
        models.HistoricalPromotion.start_datetime <= end,
        models.HistoricalPromotion.end_datetime >= start,
    )
    # Always filter on all promotions (they're always excluded from baseline)
    # Additionally exclude any specifically requested promo IDs
    promos = query.all()
    result = []
    for p in promos:
        result.append({
            "id": p.id,
            "start": p.start_datetime,
            "end": p.end_datetime,
            "scope": p.scope,
            "affected_skus": set(p.affected_skus) if p.affected_skus else set(),
        })
    return result


def _is_promotional_hour(bucket: datetime, shopify_sku: str, promo_ranges: list[dict]) -> bool:
    """Check if an hour bucket falls within any active promotion."""
    for promo in promo_ranges:
        if promo["start"] <= bucket <= promo["end"]:
            if promo["scope"] == "store_wide":
                return True
            if promo["scope"] == "sku_specific" and shopify_sku in promo["affected_skus"]:
                return True
    return False


def _calc_on_hand(db: Session, weight_map: dict, warehouse: str) -> dict[str, float]:
    """
    Calculate on-hand inventory in lbs aggregated to product type level.
    Uses InventoryItem.on_hand_qty × PicklistSku.weight_lb, resolved via SkuMapping.product_type.
    """
    on_hand = defaultdict(float)

    # Build pick_sku → product_type from SkuMapping DB table
    pick_to_pt = {}
    for m in db.query(models.SkuMapping).filter(models.SkuMapping.warehouse == warehouse).all():
        if m.pick_sku and m.product_type:
            pick_to_pt[m.pick_sku] = m.product_type

    items = db.query(models.InventoryItem).filter(
        models.InventoryItem.warehouse == warehouse
    ).all()

    for item in items:
        pick_sku = item.pick_sku
        qty = item.on_hand_qty or 0
        if qty <= 0:
            continue
        weight = weight_map.get(pick_sku, 0.0)
        pt = pick_to_pt.get(pick_sku)
        if pt and weight > 0:
            on_hand[pt] += qty * weight

    return dict(on_hand)


def _calc_on_order(db: Session, period_id: int) -> dict[str, float]:
    """
    Get total on-order lbs per product type for a given period.
    Only counts POs with status in (draft, placed, in_transit) — not yet received.
    """
    from sqlalchemy import func as sqlfunc

    active_statuses = ["draft", "placed", "in_transit"]
    results = db.query(
        models.PurchaseOrderLine.product_type,
        sqlfunc.sum(models.PurchaseOrderPeriodAllocation.effective_lbs),
    ).join(
        models.PurchaseOrderPeriodAllocation,
        models.PurchaseOrderPeriodAllocation.po_line_id == models.PurchaseOrderLine.id,
    ).join(
        models.PurchaseOrder,
        models.PurchaseOrder.id == models.PurchaseOrderLine.purchase_order_id,
    ).filter(
        models.PurchaseOrderPeriodAllocation.period_id == period_id,
        models.PurchaseOrder.status.in_(active_statuses),
    ).group_by(
        models.PurchaseOrderLine.product_type,
    ).all()

    return {pt: lbs or 0.0 for pt, lbs in results}


def _calc_expected_on_hand(db: Session, period: models.ProjectionPeriod) -> dict[str, float]:
    """
    For Period 2+, calculate expected remaining inventory after the preceding period.
    expected = prev_on_hand - prev_padded_demand, adjusted for spoilage, floored at 0.
    """
    if not period.previous_period_id:
        return {}

    # Find the latest "current" projection for the previous period
    prev_projection = db.query(models.Projection).filter(
        models.Projection.period_id == period.previous_period_id,
        models.Projection.status == "current",
    ).order_by(models.Projection.generated_at.desc()).first()

    if not prev_projection:
        return {}

    prev_lines = db.query(models.ProjectionLine).filter(
        models.ProjectionLine.projection_id == prev_projection.id
    ).all()

    spoilage_overrides = period.spoilage_adjustments or {}
    result = {}

    for line in prev_lines:
        remaining = line.on_hand_lbs - line.padded_demand_lbs
        # Apply spoilage
        spoilage_pct = spoilage_overrides.get(line.product_type, 0.0)
        if spoilage_pct > 0:
            remaining *= (1 - spoilage_pct / 100.0)
        result[line.product_type] = max(0.0, remaining)

    return result


def _build_methodology_report(
    generated_at: datetime,
    hist_range_start: datetime,
    hist_range_end: datetime,
    historical_weeks: int,
    hist_rows_used: int,
    excluded_promos: list[str],
    promotion_multiplier: float | None,
    confirmed_order_count: int,
    hold_skus_count: int,
    hours_remaining: float,
    total_hours: float,
    sku_mapping_source: str,
    unmapped_skus: list[str],
    period: models.ProjectionPeriod,
) -> str:
    """Auto-generate a human-readable methodology report."""
    lines = [
        f"Projection generated at {generated_at.strftime('%Y-%m-%d %H:%M UTC')}.",
        f"Period: {period.name} ({period.start_datetime.strftime('%Y-%m-%d %H:%M')} to {period.end_datetime.strftime('%Y-%m-%d %H:%M')}).",
        "",
        "── Historical Data ──",
        f"Range: {hist_range_start.strftime('%Y-%m-%d')} to {hist_range_end.strftime('%Y-%m-%d')} ({historical_weeks} weeks).",
        f"Historical sales rows used: {hist_rows_used}.",
        f"Promotions excluded: {', '.join(excluded_promos) if excluded_promos else 'none'}.",
        f"Upcoming promotion multiplier: {promotion_multiplier}x." if promotion_multiplier else "No upcoming promotion multiplier applied.",
        "",
        "── Confirmed Demand ──",
        f"Confirmed orders in period: {confirmed_order_count}.",
        f"Inventory hold SKUs configured: {hold_skus_count} (included as confirmed demand).",
        "",
        "── Projection Window ──",
        f"Hours remaining in period: {hours_remaining:.0f} of {total_hours:.0f} total.",
        f"SKU mapping source: {sku_mapping_source}.",
    ]

    if unmapped_skus:
        lines.append("")
        lines.append("── Data Quality ──")
        lines.append(f"Unmapped SKUs (skipped): {', '.join(unmapped_skus[:20])}")
        if len(unmapped_skus) > 20:
            lines.append(f"  ... and {len(unmapped_skus) - 20} more.")

    return "\n".join(lines)


# ── Hourly breakdown ────────────────────────────────────────────────────────

def get_hourly_breakdown(
    db: Session, projection_id: int, product_type: str
) -> list[dict]:
    """
    Return per-hour projected demand for a single product type,
    using the same parameters as the original projection.
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
        raise ValueError("Period not found")

    params = projection.parameters or {}
    warehouse = params.get("warehouse", "walnut")
    historical_weeks = params.get("historical_weeks", 4)
    excluded_promo_ids = params.get("excluded_promo_ids") or []
    promotion_multiplier = params.get("promotion_multiplier")

    sku_lookup = _build_sku_mapping_lookup(db, period, warehouse)
    weight_map = _build_weight_map(db)

    # Determine the time window (use projection generated_at as "now")
    now = projection.generated_at or datetime.utcnow()
    if now >= period.end_datetime:
        return []
    effective_start = max(now, period.start_datetime)

    # Build remaining hour slots as actual datetimes
    remaining_hours = []
    cursor = effective_start.replace(minute=0, second=0, microsecond=0)
    if cursor < effective_start:
        cursor += timedelta(hours=1)
    while cursor < period.end_datetime:
        remaining_hours.append(cursor)
        cursor += timedelta(hours=1)

    if not remaining_hours:
        return []

    # Historical range
    hist_range_end = period.start_datetime
    hist_range_start = hist_range_end - timedelta(weeks=historical_weeks)

    hist_sales = db.query(models.HistoricalSales).filter(
        models.HistoricalSales.hour_bucket >= hist_range_start,
        models.HistoricalSales.hour_bucket <= hist_range_end,
    ).all()

    promo_ranges = _load_promo_ranges(db, hist_range_start, hist_range_end, excluded_promo_ids)

    # Aggregate historical by (dow, hour, sku)
    hist_agg = defaultdict(list)
    hist_order_agg = defaultdict(list)

    for hs in hist_sales:
        bucket = hs.hour_bucket
        if _is_promotional_hour(bucket, hs.shopify_sku, promo_ranges):
            continue
        key = (bucket.weekday(), bucket.hour, hs.shopify_sku)
        hist_agg[key].append(hs.quantity_sold)
        hist_order_agg[key].append(hs.order_count)

    # For each remaining hour, compute projected demand for the target product type
    result = []
    for hour_dt in remaining_hours:
        dow = hour_dt.weekday()
        hr = hour_dt.hour
        hour_lbs = 0.0
        hour_orders = 0.0

        matching_keys = [k for k in hist_agg if k[0] == dow and k[1] == hr]
        for key in matching_keys:
            sku = key[2]
            avg_qty = sum(hist_agg[key]) / len(hist_agg[key])
            avg_orders = sum(hist_order_agg[key]) / len(hist_order_agg[key])

            if promotion_multiplier is not None:
                avg_qty *= promotion_multiplier
                avg_orders *= promotion_multiplier

            li_demand, _ = _resolve_line_item(sku, 1, sku_lookup, weight_map)
            for pt, lbs_per_unit in li_demand.items():
                if pt == product_type:
                    hour_lbs += lbs_per_unit * avg_qty
                    hour_orders += avg_orders

        result.append({
            "hour": hour_dt,
            "projected_orders": round(hour_orders, 2),
            "projected_lbs": round(hour_lbs, 2),
        })

    return result


def compare_projections(
    db: Session, projection_a_id: int, projection_b_id: int
) -> dict:
    """
    Compare two projections side-by-side, matching lines by product_type.
    Returns {projection_a, projection_b, lines: [{product_type, a_*, b_*}]}.
    """
    pa = db.query(models.Projection).filter(models.Projection.id == projection_a_id).first()
    pb = db.query(models.Projection).filter(models.Projection.id == projection_b_id).first()
    if not pa:
        raise ValueError(f"Projection {projection_a_id} not found")
    if not pb:
        raise ValueError(f"Projection {projection_b_id} not found")

    lines_a = {
        l.product_type: l for l in
        db.query(models.ProjectionLine).filter(
            models.ProjectionLine.projection_id == pa.id
        ).all()
    }
    lines_b = {
        l.product_type: l for l in
        db.query(models.ProjectionLine).filter(
            models.ProjectionLine.projection_id == pb.id
        ).all()
    }

    all_pts = sorted(set(lines_a.keys()) | set(lines_b.keys()))
    comparison_lines = []

    for pt in all_pts:
        la = lines_a.get(pt)
        lb = lines_b.get(pt)
        comparison_lines.append({
            "product_type": pt,
            "a_confirmed_demand_lbs": la.confirmed_demand_lbs if la else 0.0,
            "a_projected_demand_lbs": la.projected_demand_lbs if la else 0.0,
            "a_total_demand_lbs": la.total_demand_lbs if la else 0.0,
            "a_padded_demand_lbs": la.padded_demand_lbs if la else 0.0,
            "a_on_hand_lbs": la.on_hand_lbs if la else 0.0,
            "a_expected_on_hand_lbs": la.expected_on_hand_lbs if la else 0.0,
            "a_gap_lbs": la.gap_lbs if la else 0.0,
            "a_gap_cases": la.gap_cases if la else None,
            "a_gap_status": la.gap_status if la else "ok",
            "b_confirmed_demand_lbs": lb.confirmed_demand_lbs if lb else 0.0,
            "b_projected_demand_lbs": lb.projected_demand_lbs if lb else 0.0,
            "b_total_demand_lbs": lb.total_demand_lbs if lb else 0.0,
            "b_padded_demand_lbs": lb.padded_demand_lbs if lb else 0.0,
            "b_on_hand_lbs": lb.on_hand_lbs if lb else 0.0,
            "b_expected_on_hand_lbs": lb.expected_on_hand_lbs if lb else 0.0,
            "b_gap_lbs": lb.gap_lbs if lb else 0.0,
            "b_gap_cases": lb.gap_cases if lb else None,
            "b_gap_status": lb.gap_status if lb else "ok",
        })

    return {"projection_a": pa, "projection_b": pb, "lines": comparison_lines}
