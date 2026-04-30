"""
Projection engine — generates demand forecasts per projection period.

Primary entrypoint: generate_projection(db, period_id, params)
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from sqlalchemy.orm import Session

import models
from services import sheets_service
from services import projection_confirmed_orders_service


def _ensure_utc(dt: datetime | None) -> datetime | None:
    # SQLite returns naive datetimes from DateTime(timezone=True) columns;
    # Postgres returns aware. Treat naive values as UTC so Python comparisons
    # don't raise "can't compare offset-naive and offset-aware datetimes".
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def generate_projection(
    db: Session,
    period_id: int,
    historical_weeks: int = 4,
    excluded_promo_ids: list[int] | None = None,
    promotion_multiplier: float | None = None,
    demand_multiplier: float | None = None,
    warehouse: str = "walnut",
) -> models.Projection:
    """
    Generate a point-in-time demand projection for a projection period.
    Returns the persisted Projection with lines.
    """
    now = datetime.now(timezone.utc)
    excluded_promo_ids = excluded_promo_ids or []

    # ── Step 1: Load and validate period ─────────────────────────────────────
    period = db.query(models.ProjectionPeriod).filter(
        models.ProjectionPeriod.id == period_id
    ).first()
    if not period:
        raise ValueError(f"Projection period {period_id} not found")
    if period.status == "closed":
        raise ValueError(f"Period {period_id} is closed; cannot generate projection")
    period.start_datetime = _ensure_utc(period.start_datetime)
    period.end_datetime = _ensure_utc(period.end_datetime)
    period.fulfillment_start = _ensure_utc(period.fulfillment_start)
    period.fulfillment_end = _ensure_utc(period.fulfillment_end)

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
    # Per-product-type overrides (Phase 2). Affects the padding toggle below
    # and is reloaded inside _calc_projected_demand for window/manual-rate handling.
    overrides = _load_overrides(db, period_id)

    # ── Step 4: Confirmed demand ─────────────────────────────────────────────
    # Always compute the auto rollup — it gets stored on the period as the
    # baseline that MANUAL is compared against (and is what the projection uses
    # when MANUAL isn't set).
    auto_demand, auto_orders, unmapped_skus_confirmed = _calc_confirmed_demand(
        db, period, sku_lookup, weight_map, short_ship_skus, inventory_hold_skus,
    )
    # When the user has saved confirmed demand on the Confirmed Demand Dashboard,
    # use the rollup of the confirmed orders' boxes_snapshot — the same source
    # the CD dashboard displays. Otherwise the Projection Dashboard would show
    # a "MANUAL" badge but an auto-derived number, with the two diverging.
    if period.has_manual_confirmed_demand:
        confirmed_demand, confirmed_orders = (
            projection_confirmed_orders_service
            .rollup_lbs_and_orders_by_product_type(db, period_id)
        )
    else:
        confirmed_demand, confirmed_orders = auto_demand, auto_orders

    # ── Step 5: Projected demand (historical forecast) ───────────────────────
    hist_range_start = now - timedelta(weeks=max(historical_weeks, 1))
    hist_range_end = now
    projected_demand, projected_orders, unmapped_skus_projected, hist_rows_used = _calc_projected_demand(
        db, period, sku_lookup, weight_map, now,
        hist_range_start, hist_range_end,
        excluded_promo_ids, promotion_multiplier, demand_multiplier,
    )

    # ── Step 6: On-hand inventory ────────────────────────────────────────────
    on_hand = _calc_on_hand(db, weight_map, sku_lookup, warehouse)

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
        global_padding_pct = padding_configs.get(pt, 0.0)
        override = overrides.get(pt)
        # Per-period override wins over the global per-product-type config.
        # Manual-rate's apply_padding=False is an older opt-out that still applies
        # when no explicit padding_pct_override is set.
        if override is not None and override.padding_pct_override is not None:
            effective_padding_pct = override.padding_pct_override
        elif (
            override is not None
            and override.manual_daily_lbs is not None
            and not override.apply_padding
        ):
            effective_padding_pct = 0.0
        else:
            effective_padding_pct = global_padding_pct
        padded_lbs = total_lbs * (1 + effective_padding_pct / 100.0)
        # Inventory adjustment models expiration / shrink before fulfillment.
        # Range is [-100, 0]; e.g. -50 keeps 50% of on_hand + expected_on_hand.
        inv_adj = override.inventory_adjustment_pct if override is not None else None
        inv_factor = 1.0 + (inv_adj / 100.0) if inv_adj is not None else 1.0
        oh_lbs = on_hand.get(pt, 0.0) * inv_factor
        eoh_lbs = expected_on_hand.get(pt, 0.0) * inv_factor
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
            "padding_pct": effective_padding_pct,
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
        overrides=list(overrides.values()),
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
            "demand_multiplier": demand_multiplier,
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

    # Write auto confirmed demand onto the period for the review/override layer.
    # Always store the auto-derived value here (not the manual-aware confirmed_demand
    # the projection just used) so the CD dashboard's "Revert to Auto" stays meaningful.
    period.confirmed_demand_auto_lbs = {
        pt: round(lbs, 2) for pt, lbs in auto_demand.items()
    }

    db.commit()
    db.refresh(projection)
    return projection


# ── Internal helpers ─────────────────────────────────────────────────────────

def _build_sku_mapping_lookup(
    db: Session, period: models.ProjectionPeriod, warehouse: str
) -> dict:
    """
    Build {shopify_sku: [{"pick_sku", "mix_quantity", "product_type"}, ...]} lookup.
    product_type is the PICK SKU's type (PicklistSku.type), not the Shopify product
    type — so a Mix Box explodes into its component product types rather than
    rolling up under one bundled row.
    Uses period-specific Sheets tab if available, otherwise falls back to warehouse default.
    """
    # Pick-level product type source of truth: PicklistSku.type keyed by pick_sku.
    pick_type_map = {}
    for ps in db.query(models.PicklistSku).all():
        if ps.pick_sku and ps.type:
            pick_type_map[ps.pick_sku] = ps.type

    if period.sku_mapping_sheet_tab:
        try:
            lookup = sheets_service.get_period_sku_mapping_lookup(period.sku_mapping_sheet_tab)
            if lookup:
                for entries in lookup.values():
                    for e in entries:
                        e["product_type"] = pick_type_map.get(e.get("pick_sku"))
                return lookup
        except Exception as e:
            print(f"[WARN] Failed to load period SKU mapping tab '{period.sku_mapping_sheet_tab}': {e}")

    # Fallback: use default warehouse mapping, tag each entry with its pick-level type.
    base_lookup = sheets_service.get_sku_mapping_lookup(warehouse)
    enriched = sheets_service.CaseInsensitiveSkuDict()
    for sku, entries in base_lookup.items():
        enriched[sku] = []
        for e in entries:
            enriched[sku].append({
                "pick_sku": e["pick_sku"],
                "mix_quantity": e.get("mix_quantity") or 1.0,
                "product_type": pick_type_map.get(e.get("pick_sku")),
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


def _build_remaining_slots(now: datetime, period: models.ProjectionPeriod) -> list[tuple[int, int]]:
    """List of (weekday, hour) for each remaining hour in the period."""
    if now >= period.end_datetime:
        return []
    effective_start = max(now, period.start_datetime)
    remaining_slots = []
    cursor = effective_start.replace(minute=0, second=0, microsecond=0)
    if cursor < effective_start:
        cursor += timedelta(hours=1)
    while cursor < period.end_datetime:
        remaining_slots.append((cursor.weekday(), cursor.hour))
        cursor += timedelta(hours=1)
    return remaining_slots


def _load_overrides(db: Session, period_id: int) -> dict[str, models.PeriodProjectionOverride]:
    return {
        o.product_type: o for o in
        db.query(models.PeriodProjectionOverride).filter(
            models.PeriodProjectionOverride.period_id == period_id
        ).all()
    }


def _build_pt_contribs(sku_lookup: dict) -> dict[str, list[tuple[str, float, str]]]:
    """Invert sku_lookup into product_type → [(shopify_sku, mix_quantity, pick_sku), ...]."""
    result: dict[str, list[tuple[str, float, str]]] = defaultdict(list)
    for shopify_sku, entries in sku_lookup.items():
        for e in entries:
            pt = e.get("product_type")
            ps = e.get("pick_sku")
            if pt and ps:
                result[pt].append((shopify_sku, float(e.get("mix_quantity") or 1.0), ps))
    return result


def _resolve_override_window(
    override: models.PeriodProjectionOverride | None,
    global_start: datetime,
    global_end: datetime,
) -> tuple[datetime, datetime]:
    """Return (hist_start, hist_end) after applying override's range controls."""
    if override:
        if override.custom_range_start and override.custom_range_end:
            return _ensure_utc(override.custom_range_start), _ensure_utc(override.custom_range_end)
        if override.historical_weeks:
            return global_end - timedelta(weeks=override.historical_weeks), global_end
    return global_start, global_end


def _project_pt_from_history(
    db: Session,
    pt: str,
    contribs: list[tuple[str, float, str]],
    weight_map: dict,
    slot_counts: dict,
    pt_hist_start: datetime,
    pt_hist_end: datetime,
    promo_ranges: list[dict],
    promotion_multiplier: float | None,
    demand_multiplier: float | None,
    store_curve: dict[tuple[int, int], dict[str, float]],
) -> tuple[float, float, int]:
    """
    Project one product_type using the store-wide hourly curve.

    The PT's own history sets the *volume* (weekly lbs/orders); the store-wide
    curve sets the *shape* (which (dow, hour) slots get more or less). This
    avoids the sparse-data problem where individual product types have too
    few sales to establish their own hourly pattern reliably.

    Returns (lbs, orders, rows_used).
    """
    weekly_lbs, weekly_orders, rows_used = _compute_pt_weekly_demand(
        db, contribs, weight_map, pt_hist_start, pt_hist_end,
        promo_ranges, promotion_multiplier, demand_multiplier,
    )

    if weekly_lbs <= 0 and weekly_orders <= 0:
        return 0.0, 0.0, rows_used

    total_lbs = 0.0
    total_orders = 0.0
    for (dow, hour), count in slot_counts.items():
        share = store_curve.get((dow, hour))
        if not share:
            continue
        total_lbs += weekly_lbs * share["lbs_share"] * count
        total_orders += weekly_orders * share["orders_share"] * count

    return total_lbs, total_orders, rows_used


def _manual_weekly_lbs(
    override: models.PeriodProjectionOverride,
    promotion_multiplier: float | None,
    demand_multiplier: float | None,
) -> float:
    """Convert manual_daily_lbs (×7) into a weekly figure that the store curve
    distributes across the projection window."""
    lbs = max(override.manual_daily_lbs or 0.0, 0.0) * 7.0
    if promotion_multiplier is not None and override.apply_promotion_multiplier:
        lbs *= promotion_multiplier
    if demand_multiplier is not None and override.apply_demand_multiplier:
        lbs *= demand_multiplier
    return lbs


def _compute_pt_weekly_demand(
    db: Session,
    contribs: list[tuple[str, float, str]],
    weight_map: dict,
    pt_hist_start: datetime,
    pt_hist_end: datetime,
    promo_ranges: list[dict],
    promotion_multiplier: float | None,
    demand_multiplier: float | None,
) -> tuple[float, float, int]:
    """
    Aggregate one product type's history into average weekly demand.

    Returns (weekly_lbs, weekly_orders, rows_used). Promo rows are excluded
    per the existing per-(hour, SKU) rule. Caller distributes the weekly
    figure across the projection window via the store-wide hourly curve.
    """
    skus_for_pt = list({sku for sku, _mq, _ps in contribs})
    if not skus_for_pt:
        return 0.0, 0.0, 0

    rows = db.query(models.HistoricalSales).filter(
        models.HistoricalSales.shopify_sku.in_(skus_for_pt),
        models.HistoricalSales.hour_bucket >= pt_hist_start,
        models.HistoricalSales.hour_bucket <= pt_hist_end,
    ).all()

    by_sku: dict[str, list[tuple[float, str]]] = defaultdict(list)
    for sku, mq, ps in contribs:
        by_sku[sku].append((mq, ps))

    days_in_range = max((pt_hist_end - pt_hist_start).total_seconds() / 86400, 1.0)
    pt_total_lbs = 0.0
    pt_total_orders = 0.0
    rows_used = 0
    for hs in rows:
        if _is_promotional_hour(hs.hour_bucket, hs.shopify_sku, promo_ranges):
            continue
        for mq, pick_sku in by_sku.get(hs.shopify_sku, []):
            weight = weight_map.get(pick_sku, 0.0)
            pt_total_lbs += hs.quantity_sold * mq * weight
        pt_total_orders += hs.order_count
        rows_used += 1

    weekly_lbs = (pt_total_lbs / days_in_range) * 7.0
    weekly_orders = (pt_total_orders / days_in_range) * 7.0

    if promotion_multiplier is not None:
        weekly_lbs *= promotion_multiplier
        weekly_orders *= promotion_multiplier
    if demand_multiplier is not None:
        weekly_lbs *= demand_multiplier
        weekly_orders *= demand_multiplier

    return weekly_lbs, weekly_orders, rows_used


def _build_store_hourly_curve(
    db: Session,
    hist_start: datetime,
    hist_end: datetime,
    promo_ranges: list[dict],
    sku_lookup: dict,
    weight_map: dict,
) -> dict[tuple[int, int], dict[str, float]]:
    """
    Aggregate store-wide HistoricalSales into a (dow, hour) → share table.

    Policy A: if any tracked-promo SKU was active during a given hour bucket,
    drop the entire hour from the aggregate (rather than just that SKU's row).
    This trades some data density for a cleaner non-promo baseline — promos
    often coincide with naturally-busy hours, and partial exclusion would
    leak halo-effect demand into the curve.

    Returns {(dow, hour): {"lbs_share": float, "orders_share": float}} where
    each share table sums to 1.0 across all 168 (dow, hour) slots that had
    activity. Caller multiplies by weekly demand to project per-slot volume.

    If history has no usable data, returns a uniform 1/168 fallback so the
    projection still produces non-zero output.
    """
    rows = db.query(models.HistoricalSales).filter(
        models.HistoricalSales.hour_bucket >= hist_start,
        models.HistoricalSales.hour_bucket <= hist_end,
    ).all()

    polluted_hours: set[datetime] = set()
    for hs in rows:
        if _is_promotional_hour(hs.hour_bucket, hs.shopify_sku, promo_ranges):
            polluted_hours.add(hs.hour_bucket)

    lbs_by_slot: dict[tuple[int, int], float] = defaultdict(float)
    orders_by_slot: dict[tuple[int, int], float] = defaultdict(float)
    total_lbs = 0.0
    total_orders = 0.0

    for hs in rows:
        if hs.hour_bucket in polluted_hours:
            continue
        slot = (hs.hour_bucket.weekday(), hs.hour_bucket.hour)
        # Convert qty → lbs across all PTs this SKU maps to (covers duplicate
        # sheet rows that split a Shopify SKU into multiple pick SKUs).
        row_lbs = 0.0
        for entry in sku_lookup.get(hs.shopify_sku, []):
            pick_sku = entry.get("pick_sku")
            mix_qty = entry.get("mix_quantity") or 1.0
            if not pick_sku:
                continue
            weight = weight_map.get(pick_sku, 0.0)
            row_lbs += hs.quantity_sold * mix_qty * weight
        lbs_by_slot[slot] += row_lbs
        total_lbs += row_lbs
        orders_by_slot[slot] += hs.order_count
        total_orders += hs.order_count

    if total_lbs <= 0 and total_orders <= 0:
        # Empty history (or fully polluted) — fall back to uniform so callers
        # still produce a non-zero projection rather than collapsing to 0.
        uniform = 1.0 / 168.0
        return {
            (d, h): {"lbs_share": uniform, "orders_share": uniform}
            for d in range(7) for h in range(24)
        }

    curve: dict[tuple[int, int], dict[str, float]] = {}
    for slot in set(lbs_by_slot.keys()) | set(orders_by_slot.keys()):
        curve[slot] = {
            "lbs_share": (lbs_by_slot[slot] / total_lbs) if total_lbs > 0 else 0.0,
            "orders_share": (orders_by_slot[slot] / total_orders) if total_orders > 0 else 0.0,
        }
    return curve


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
    demand_multiplier: float | None = None,
) -> tuple[dict[str, float], dict[str, float], list[str], int]:
    """
    Calculate projected demand, per product_type, respecting any per-period overrides.
    Returns (demand_lbs_by_pt, order_count_by_pt, unmapped_skus, hist_rows_used).
    """
    demand: dict[str, float] = {}
    order_counts: dict[str, float] = {}

    remaining_slots = _build_remaining_slots(now, period)
    if not remaining_slots:
        return {}, {}, [], 0

    slot_counts = defaultdict(int)
    for s in remaining_slots:
        slot_counts[s] += 1

    overrides = _load_overrides(db, period.id)
    pt_contribs = _build_pt_contribs(sku_lookup)

    # Promo ranges span the widest possible window (global + any override custom range).
    # Overrides rarely extend beyond the global range, but include them to be safe.
    window_start = hist_range_start
    window_end = hist_range_end
    for o in overrides.values():
        crs = _ensure_utc(o.custom_range_start)
        cre = _ensure_utc(o.custom_range_end)
        if crs and crs < window_start:
            window_start = crs
        if cre and cre > window_end:
            window_end = cre
    promo_ranges = _load_promo_ranges(db, window_start, window_end, excluded_promo_ids)

    # Build the store-wide hourly distribution once — every PT (and the manual-
    # override path) shares the same shape.
    store_curve = _build_store_hourly_curve(
        db, hist_range_start, hist_range_end, promo_ranges, sku_lookup, weight_map,
    )
    slot_share_total = sum(
        store_curve.get((dow, hour), {}).get("lbs_share", 0.0) * count
        for (dow, hour), count in slot_counts.items()
    )

    total_rows_used = 0
    for pt, contribs in pt_contribs.items():
        override = overrides.get(pt)

        if override and override.manual_daily_lbs is not None:
            weekly_lbs = _manual_weekly_lbs(override, promotion_multiplier, demand_multiplier)
            demand[pt] = weekly_lbs * slot_share_total
            order_counts[pt] = 0.0
            continue

        pt_start, pt_end = _resolve_override_window(override, hist_range_start, hist_range_end)
        lbs, orders, rows = _project_pt_from_history(
            db, pt, contribs, weight_map, slot_counts,
            pt_start, pt_end, promo_ranges,
            promotion_multiplier, demand_multiplier,
            store_curve,
        )
        if lbs > 0 or orders > 0:
            demand[pt] = lbs
            order_counts[pt] = orders
        total_rows_used += rows

    # Unmapped SKUs are tracked by the confirmed-demand pass; projected pass iterates
    # only mapped SKUs (contribs), so it has no unmapped to report.
    return demand, order_counts, [], total_rows_used


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
            "start": _ensure_utc(p.start_datetime),
            "end": _ensure_utc(p.end_datetime),
            "scope": p.scope,
            "affected_skus": set(p.affected_skus) if p.affected_skus else set(),
        })
    return result


def _is_promotional_hour(bucket: datetime, shopify_sku: str, promo_ranges: list[dict]) -> bool:
    """Check if an hour bucket falls within any active promotion."""
    bucket = _ensure_utc(bucket)
    for promo in promo_ranges:
        if promo["start"] <= bucket <= promo["end"]:
            if promo["scope"] == "store_wide":
                return True
            if promo["scope"] == "sku_specific" and shopify_sku in promo["affected_skus"]:
                return True
    return False


def _calc_on_hand(
    db: Session, weight_map: dict, sku_lookup: dict, warehouse: str
) -> dict[str, float]:
    """
    Calculate on-hand inventory in lbs aggregated to product type level.
    Uses InventoryItem.on_hand_qty × PicklistSku.weight_lb.
    pick_sku → product_type is derived from sku_lookup so all demand / supply
    calculations share one source of truth (PicklistSku.type, pick-level).
    """
    on_hand = defaultdict(float)

    pick_to_pt = {}
    for entries in sku_lookup.values():
        for e in entries:
            if e.get("pick_sku") and e.get("product_type"):
                pick_to_pt[e["pick_sku"]] = e["product_type"]

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
    overrides: list[models.PeriodProjectionOverride] | None = None,
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

    if overrides:
        lines.append("")
        lines.append("── Per-Product-Type Overrides ──")
        for o in sorted(overrides, key=lambda x: x.product_type):
            extras = []
            if o.padding_pct_override is not None:
                extras.append(f"padding {o.padding_pct_override:g}%")
            if o.inventory_adjustment_pct is not None:
                extras.append(f"inventory {o.inventory_adjustment_pct:+g}%")
            extras_str = f" [{', '.join(extras)}]" if extras else ""
            if o.manual_daily_lbs is not None:
                toggles = []
                if o.apply_demand_multiplier: toggles.append("demand")
                if o.apply_promotion_multiplier: toggles.append("promo")
                if o.apply_padding and o.padding_pct_override is None: toggles.append("padding")
                tgl = f" [multipliers: {', '.join(toggles) or 'none'}]" if toggles else " [no multipliers]"
                lines.append(f"  {o.product_type}: manual {o.manual_daily_lbs} lbs/day{tgl}{extras_str}")
            elif o.custom_range_start and o.custom_range_end:
                lines.append(
                    f"  {o.product_type}: custom range "
                    f"{o.custom_range_start.strftime('%Y-%m-%d')} → {o.custom_range_end.strftime('%Y-%m-%d')}{extras_str}"
                )
            elif o.historical_weeks:
                lines.append(f"  {o.product_type}: {o.historical_weeks}-week window{extras_str}")
            elif extras:
                lines.append(f"  {o.product_type}: {', '.join(extras)}")

    return "\n".join(lines)


# ── Hourly breakdown (shop-wide) ────────────────────────────────────────────

def get_shop_hourly_breakdown(db: Session, projection_id: int) -> dict:
    """
    Per-hour projected order count, summed across every product type.

    The store-wide hourly curve is identical for every PT, so a per-PT chart
    is redundant — this aggregate is the only chart the dashboard needs.
    Manual-lbs overrides have no order projection and are skipped.
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
    demand_multiplier = params.get("demand_multiplier")

    sku_lookup = _build_sku_mapping_lookup(db, period, warehouse)
    weight_map = _build_weight_map(db)

    period.start_datetime = _ensure_utc(period.start_datetime)
    period.end_datetime = _ensure_utc(period.end_datetime)
    now = _ensure_utc(projection.generated_at) or datetime.now(timezone.utc)
    if now >= period.end_datetime:
        return {"projection_id": projection_id, "period_name": period.name, "hours": []}
    effective_start = max(now, period.start_datetime)

    remaining_hours: list[datetime] = []
    cursor = effective_start.replace(minute=0, second=0, microsecond=0)
    if cursor < effective_start:
        cursor += timedelta(hours=1)
    while cursor < period.end_datetime:
        remaining_hours.append(cursor)
        cursor += timedelta(hours=1)

    if not remaining_hours:
        return {"projection_id": projection_id, "period_name": period.name, "hours": []}

    hist_range_end = period.start_datetime
    hist_range_start = hist_range_end - timedelta(weeks=max(historical_weeks, 1))
    promo_ranges = _load_promo_ranges(db, hist_range_start, hist_range_end, excluded_promo_ids)
    store_curve = _build_store_hourly_curve(
        db, hist_range_start, hist_range_end, promo_ranges, sku_lookup, weight_map,
    )

    overrides = _load_overrides(db, period.id)
    pt_contribs = _build_pt_contribs(sku_lookup)

    total_weekly_orders = 0.0
    for pt, contribs in pt_contribs.items():
        override = overrides.get(pt)
        if override and override.manual_daily_lbs is not None:
            continue
        pt_start, pt_end = _resolve_override_window(override, hist_range_start, hist_range_end)
        _lbs, weekly_orders, _ = _compute_pt_weekly_demand(
            db, contribs, weight_map, pt_start, pt_end,
            promo_ranges, promotion_multiplier, demand_multiplier,
        )
        total_weekly_orders += weekly_orders

    hours_out = []
    for hour_dt in remaining_hours:
        share = store_curve.get((hour_dt.weekday(), hour_dt.hour), {})
        hours_out.append({
            "hour": hour_dt,
            "projected_orders": round(total_weekly_orders * share.get("orders_share", 0.0), 2),
        })

    return {
        "projection_id": projection_id,
        "period_name": period.name,
        "hours": hours_out,
    }


def get_pt_daily_history(
    db: Session, projection_id: int, product_type: str
) -> dict:
    """
    Per-day historical lbs for one product type, grouped into 7-day weeks
    (week 1 = oldest). Powers the manual-override sizing panel: the user
    sees raw lbs/day plus a per-week average to pick a manual_daily_lbs.
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

    start = projection.historical_range_start
    end = projection.historical_range_end
    if not start or not end or end <= start:
        return {
            "product_type": product_type,
            "projection_id": projection_id,
            "historical_range_start": start,
            "historical_range_end": end,
            "weeks": [],
            "dow_averages": [],
            "overall_avg_lbs_per_day": 0.0,
        }

    params = projection.parameters or {}
    warehouse = params.get("warehouse", "walnut")
    sku_lookup = _build_sku_mapping_lookup(db, period, warehouse)
    weight_map = _build_weight_map(db)
    pt_contribs = _build_pt_contribs(sku_lookup)
    contribs = pt_contribs.get(product_type, [])

    daily_lbs: dict[date, float] = defaultdict(float)
    if contribs:
        skus_for_pt = list({sku for sku, _mq, _ps in contribs})
        rows = db.query(models.HistoricalSales).filter(
            models.HistoricalSales.shopify_sku.in_(skus_for_pt),
            models.HistoricalSales.hour_bucket >= start,
            models.HistoricalSales.hour_bucket <= end,
        ).all()

        by_sku: dict[str, list[tuple[float, str]]] = defaultdict(list)
        for sku, mq, ps in contribs:
            by_sku[sku].append((mq, ps))

        for hs in rows:
            day = hs.hour_bucket.date()
            for mq, pick_sku in by_sku.get(hs.shopify_sku, []):
                weight = weight_map.get(pick_sku, 0.0)
                daily_lbs[day] += hs.quantity_sold * mq * weight

    weeks: list[dict] = []
    dow_totals: dict[int, float] = defaultdict(float)
    dow_counts: dict[int, int] = defaultdict(int)
    overall_total = 0.0
    overall_days = 0

    cursor = start
    week_num = 1
    while cursor < end:
        w_end = min(cursor + timedelta(days=7), end)
        days_out: list[dict] = []
        d = cursor.date()
        end_d = w_end.date()
        week_total = 0.0
        while d < end_d:
            lbs = daily_lbs.get(d, 0.0)
            days_out.append({
                "date": d.isoformat(),
                "dow": d.weekday(),
                "lbs": round(lbs, 2),
            })
            week_total += lbs
            dow_totals[d.weekday()] += lbs
            dow_counts[d.weekday()] += 1
            d += timedelta(days=1)
        avg = (week_total / len(days_out)) if days_out else 0.0
        weeks.append({
            "week_number": week_num,
            "week_start": cursor,
            "week_end": w_end,
            "days": days_out,
            "total_lbs": round(week_total, 2),
            "avg_lbs_per_day": round(avg, 2),
        })
        overall_total += week_total
        overall_days += len(days_out)
        cursor = w_end
        week_num += 1

    dow_averages = [
        {
            "dow": d,
            "avg_lbs": round((dow_totals[d] / dow_counts[d]) if dow_counts[d] > 0 else 0.0, 2),
            "sample_count": dow_counts[d],
        }
        for d in range(7)
    ]
    overall_avg = (overall_total / overall_days) if overall_days > 0 else 0.0

    return {
        "product_type": product_type,
        "projection_id": projection_id,
        "historical_range_start": start,
        "historical_range_end": end,
        "weeks": weeks,
        "dow_averages": dow_averages,
        "overall_avg_lbs_per_day": round(overall_avg, 2),
    }


def get_historical_orders_summary(db: Session, projection_id: int) -> dict:
    """
    Summarize historical distinct-orders-per-day for a projection's historical window.
    Breaks the window into 7-day buckets (week 1 = oldest), counts distinct
    ShopifyOrder.shopify_order_id per day, and returns weekly + overall averages.
    """
    projection = db.query(models.Projection).filter(
        models.Projection.id == projection_id
    ).first()
    if not projection:
        raise ValueError(f"Projection {projection_id} not found")

    start = projection.historical_range_start
    end = projection.historical_range_end
    if not start or not end or end <= start:
        return {
            "historical_range_start": start,
            "historical_range_end": end,
            "weekly_breakdown": [],
            "overall_avg_orders_per_day": 0.0,
            "overall_total_orders": 0,
            "overall_days": 0,
        }

    # historical_daily_orders stores one row per calendar day with the distinct
    # order count pulled directly from Shopify at ingestion time (includes
    # fulfilled orders, unlike shopify_orders which only keeps unshipped).
    day_rows = db.query(
        models.HistoricalDailyOrders.day,
        models.HistoricalDailyOrders.order_count,
    ).filter(
        models.HistoricalDailyOrders.day >= start.date(),
        models.HistoricalDailyOrders.day <= end.date(),
    ).all()
    day_orders: dict = {d: count for d, count in day_rows}

    # Slice into 7-day buckets, week 1 = oldest. We track calendar days separately
    # from "days with data" — a missing day in historical_daily_orders means the
    # ingestion job hasn't covered it, NOT that zero orders happened. Averaging
    # those missing days as 0 makes a partial-ingestion window look like a sales
    # collapse, so the average uses days_with_data as the divisor instead.
    weekly = []
    cursor = start
    week_num = 1
    while cursor < end:
        w_end = min(cursor + timedelta(days=7), end)
        total = 0
        days_in_week = 0
        days_with_data = 0
        d = cursor.date()
        end_d = w_end.date()
        while d < end_d:
            if d in day_orders:
                total += day_orders[d]
                days_with_data += 1
            days_in_week += 1
            d += timedelta(days=1)
        avg = (total / days_with_data) if days_with_data > 0 else 0.0
        weekly.append({
            "week_number": week_num,
            "week_start": cursor,
            "week_end": w_end,
            "days": days_in_week,
            "days_with_data": days_with_data,
            "total_orders": total,
            "avg_orders_per_day": round(avg, 1),
        })
        cursor = w_end
        week_num += 1

    overall_total = sum(w["total_orders"] for w in weekly)
    overall_days = sum(w["days"] for w in weekly)
    overall_days_with_data = sum(w["days_with_data"] for w in weekly)
    overall_avg = (overall_total / overall_days_with_data) if overall_days_with_data > 0 else 0.0

    return {
        "historical_range_start": start,
        "historical_range_end": end,
        "weekly_breakdown": weekly,
        "overall_avg_orders_per_day": round(overall_avg, 1),
        "overall_total_orders": overall_total,
        "overall_days": overall_days,
        "overall_days_with_data": overall_days_with_data,
    }


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
