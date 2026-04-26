"""
Live-preview mapping override service.

Used by the Projection Orders page to show what an order's pick SKUs and
fulfillment plan would look like under a different SKU mapping sheet tab,
without writing anything to the database.

The override is a *view* — every function here returns synthetic structures
derived from the selected mapping tab combined with the order's persisted
Shopify-side data. Stored ShopifyLineItem.pick_sku and FulfillmentPlan rows
are never modified.
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


def build_override_line_items(
    shopify_order_id: str,
    mapping_tab: str,
    db: Session,
) -> list[dict]:
    """
    Return synthetic line-item rows for one order, re-resolved against `mapping_tab`.

    Output shape mirrors the fields _compute_multi_box_split needs to read off
    each ShopifyLineItem so the result can be passed in as `line_items_override`.

    Important: ShopifyLineItem rows are *already exploded* in the DB — a single
    Shopify line item that maps to N pick SKUs under the warehouse default is
    stored as N rows (one per component). We deduplicate by line_item_id first,
    then re-resolve each unique Shopify line item against the override mapping.
    Otherwise the override would multiply N (stored components) × M (override
    components), inflating quantities Nx.

    Each Shopify line item explodes into 1+ override rows — one per (pick_sku)
    component in the tab's mapping. A "no_bundle" entry yields zero rows
    (treated as unmapped).
    """
    sku_lookup = _load_mapping_lookup(mapping_tab)
    if not sku_lookup:
        return []

    raw_lis = (
        db.query(models.ShopifyLineItem)
        .filter(models.ShopifyLineItem.shopify_order_id == shopify_order_id)
        .all()
    )

    # Dedupe by line_item_id — keep the first row seen. All exploded rows for
    # one line item share shopify_sku / quantity / fulfillable_quantity / etc.,
    # so the choice of representative doesn't matter as long as we don't iterate
    # all of them.
    by_line_id: dict[str, models.ShopifyLineItem] = {}
    for li in raw_lis:
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
                "shopify_order_id": shopify_order_id,
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
