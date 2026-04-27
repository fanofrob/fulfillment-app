"""
Live-preview mapping override service.

Used by the Confirmed Orders page to show what an order's pick SKUs and
fulfillment plan would look like under a different SKU mapping sheet tab,
without writing anything to the database.

The override is a *view* — every function here returns synthetic structures
derived from the selected mapping tab combined with the order's persisted
Shopify-side data. Stored ShopifyLineItem.pick_sku and FulfillmentPlan rows
are never modified.

Period status overrides (short-ship / inventory-hold) read from the
*Confirmed Demand Dashboard* configs, so toggles made on that dashboard
flow through to the Confirmed Orders view of the same period. The
projection-forecast-only `PeriodShortShipConfig` / `PeriodInventoryHoldConfig`
tables are NOT consulted here.
"""
from __future__ import annotations
from typing import Optional

from sqlalchemy.orm import Session

import models
from services import sheets_service


def _load_mapping_lookup(mapping_tab: str) -> dict:
    """Load {shopify_sku: [{pick_sku, mix_quantity, ...}, ...]} for a tab.

    Returns empty dict if the tab can't be read — callers fall back to stored values.
    """
    try:
        return sheets_service.get_period_sku_mapping_lookup(mapping_tab) or {}
    except Exception as e:
        print(f"[WARN] mapping_override: failed to load tab '{mapping_tab}': {e}")
        return {}


def _load_period_status_skus(
    period_id: int, db: Session
) -> tuple[set[str], set[str]]:
    """Return (short_ship_skus, inventory_hold_skus) from the period's
    Confirmed Demand Dashboard configs."""
    short = {
        r.shopify_sku for r in
        db.query(models.ConfirmedDemandShortShipConfig.shopify_sku)
        .filter(models.ConfirmedDemandShortShipConfig.period_id == period_id)
        .all()
    }
    hold = {
        r.shopify_sku for r in
        db.query(models.ConfirmedDemandInventoryHoldConfig.shopify_sku)
        .filter(models.ConfirmedDemandInventoryHoldConfig.period_id == period_id)
        .all()
    }
    return short, hold


def apply_period_status_overrides(
    line_items: list[models.ShopifyLineItem],
    period_id: Optional[int],
    db: Session,
) -> None:
    """
    Mutate `app_line_status` in-place on each line item based on the period's
    short-ship / inventory-hold configs. No-op when period_id is falsy.

    Override semantics (replaces, not merges, the stamped global value):
      - shopify_sku in period short-ship list → 'short_ship'
      - shopify_sku in period inventory-hold list → 'inventory_hold'
      - otherwise → None  (clears anything stamped from the global config)
      - 'removed' is preserved — never overwritten

    Safety: relies on SessionLocal(autocommit=False, autoflush=False) — these
    ORM-level attribute mutations stay in-memory and never persist unless the
    request handler explicitly calls db.commit(). All GET handlers that call
    this helper are read-only and never commit.
    """
    if not period_id:
        return
    short_skus, hold_skus = _load_period_status_skus(period_id, db)
    for li in line_items:
        if li.app_line_status == "removed":
            continue
        sku = li.shopify_sku
        if sku and sku in short_skus:
            li.app_line_status = "short_ship"
        elif sku and sku in hold_skus:
            li.app_line_status = "inventory_hold"
        else:
            li.app_line_status = None


def _resolve_rows(
    line_items: list[models.ShopifyLineItem],
    sku_lookup: dict,
) -> list[dict]:
    """
    Core re-resolution: turn ShopifyLineItem rows into synthetic dicts under
    the supplied mapping `sku_lookup`. Caller is responsible for any period
    status mutation prior to calling.

    ShopifyLineItem rows are *already exploded* in the DB — a single Shopify
    line item mapped to N pick SKUs under the warehouse default is stored as
    N rows. Dedupe by line_item_id first so we re-resolve each unique Shopify
    line item once; otherwise the override would multiply N (stored) × M
    (override) components.

    Each Shopify line item explodes into 1+ override rows — one per pick_sku
    component in the tab's mapping. A "no_bundle" entry yields zero rows.
    """
    by_line_id: dict[str, models.ShopifyLineItem] = {}
    for li in line_items:
        if li.line_item_id and li.line_item_id not in by_line_id:
            by_line_id[li.line_item_id] = li

    out: list[dict] = []
    for li_id, li in by_line_id.items():
        if not li.shopify_sku or li.shopify_sku not in sku_lookup:
            continue
        entries = sku_lookup[li.shopify_sku] or []
        for entry in entries:
            pick_sku = entry.get("pick_sku")
            if not pick_sku or entry.get("no_bundle"):
                continue
            out.append({
                "shopify_order_id": li.shopify_order_id,
                "line_item_id": li_id,
                "shopify_sku": li.shopify_sku,
                "product_title": li.product_title,
                "pick_sku": pick_sku,
                "mix_quantity": entry.get("mix_quantity") or 1.0,
                "fulfillable_quantity": li.fulfillable_quantity,
                "quantity": li.quantity,
                "sku_mapped": True,
                "app_line_status": li.app_line_status,
            })
    return out


def build_override_line_items(
    shopify_order_id: str,
    mapping_tab: str,
    db: Session,
    period_id: Optional[int] = None,
) -> list[dict]:
    """
    Return synthetic line-item rows for one order, re-resolved against `mapping_tab`.

    Output shape mirrors the fields _compute_multi_box_split needs to read off
    each ShopifyLineItem so the result can be passed in as `line_items_override`.

    When `period_id` is provided, each underlying ShopifyLineItem's
    `app_line_status` is rewritten in-memory via apply_period_status_overrides
    *before* the synthetic dicts are emitted, so callers see period-specific
    short-ship / inventory-hold semantics on the resulting `app_line_status`
    field.
    """
    sku_lookup = _load_mapping_lookup(mapping_tab)
    if not sku_lookup:
        return []

    raw_lis = (
        db.query(models.ShopifyLineItem)
        .filter(models.ShopifyLineItem.shopify_order_id == shopify_order_id)
        .all()
    )
    apply_period_status_overrides(raw_lis, period_id, db)
    return _resolve_rows(raw_lis, sku_lookup)


def build_override_cogs_rows(
    line_items: list[models.ShopifyLineItem],
    mapping_tab: str,
) -> Optional[list[dict]]:
    """
    Re-resolve already-loaded `line_items` against `mapping_tab` for the COGS
    side of GM% calculation. Returns None when the tab fails to load (caller
    should fall back to stored pick_sku/mix_quantity), or a list otherwise.

    Caller is responsible for having already mutated `line_items` via
    apply_period_status_overrides if a period override is in effect — the
    returned dicts carry the post-override `app_line_status` through.

    The output shape matches build_override_line_items but consumes pre-loaded
    rows so the caller's existing DB query can be reused.
    """
    sku_lookup = _load_mapping_lookup(mapping_tab)
    if not sku_lookup:
        return None
    return _resolve_rows(line_items, sku_lookup)


def build_override_cogs_rows_for_orders(
    line_items_by_order: dict[str, list[models.ShopifyLineItem]],
    mapping_tab: str,
) -> Optional[dict[str, list[dict]]]:
    """
    Batch variant of build_override_cogs_rows. Loads the mapping lookup once
    (cached) and re-resolves each order's line items independently.

    Returns None when the tab fails to load. Each order key maps to a (possibly
    empty) list of synthetic rows.
    """
    sku_lookup = _load_mapping_lookup(mapping_tab)
    if not sku_lookup:
        return None
    return {oid: _resolve_rows(lis, sku_lookup) for oid, lis in line_items_by_order.items()}


def override_response_line_items(
    line_items: list[models.ShopifyLineItem],
    mapping_tab: str,
) -> list[dict]:
    """
    Build synthetic per-line-item dicts for the orders/list response, re-resolved
    against `mapping_tab`. Stays 1:1 with the underlying ShopifyLineItem rows
    so the LineItemOut schema (which requires unique ids) stays valid.

    For mix-box mappings (multiple pick_sku components for one shopify_sku) the
    line item shows pick_sku=None and sku_mapped=True — matching how the live
    DB models mix items today. The component breakdown surfaces in the box
    preview (build_override_line_items + _build_preview_plan) instead.
    """
    sku_lookup = _load_mapping_lookup(mapping_tab)
    out: list[dict] = []
    for li in line_items:
        base = {c.name: getattr(li, c.name) for c in li.__table__.columns}
        if not li.shopify_sku or li.shopify_sku not in sku_lookup:
            base["pick_sku"] = None
            base["mix_quantity"] = None
            base["sku_mapped"] = False
            out.append(base)
            continue

        entries = [e for e in (sku_lookup[li.shopify_sku] or []) if not e.get("no_bundle")]
        if not entries:
            base["pick_sku"] = None
            base["mix_quantity"] = None
            base["sku_mapped"] = False
            out.append(base)
            continue

        if len(entries) == 1:
            base["pick_sku"] = entries[0].get("pick_sku")
            base["mix_quantity"] = entries[0].get("mix_quantity") or 1.0
            base["sku_mapped"] = bool(base["pick_sku"])
        else:
            # Mix-box: leave pick_sku None to mirror existing model semantics;
            # box preview uses build_override_line_items for the component split.
            base["pick_sku"] = None
            base["mix_quantity"] = None
            base["sku_mapped"] = True
        out.append(base)
    return out
