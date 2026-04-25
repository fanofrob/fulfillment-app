"""
Products router — Shopify product catalog, short-ship, and inventory-hold configuration.

Short-ship: when allow_short_ship=True on a ShopifyProduct, any open order line
item with that shopify_sku gets app_line_status='short_ship'. Those items are:
  - Excluded from fulfillment planning (box split, snapshots)
  - Shown in a separate "Short Shipped" section in the UI
  - Excluded from gross margin calculation
  - NOT shipped (plan boxes containing them are reset for open orders)

Inventory Hold: when inventory_hold=True on a ShopifyProduct, any open order line
item with that shopify_sku gets app_line_status='inventory_hold'. Orders with
inventory_hold line items are unstaged (moved to not_processed) and blocked from
staging. Unlike short-ship, inventory hold does NOT delete fulfillment boxes.
Mutually exclusive with short-ship per SKU.

Staged orders ARE now affected: if a short-ship change touches a staged order's
line items, the order is moved back to not_processed and committed inventory is
recomputed so the inventory count stays accurate.

Orders in ShipStation (in_shipstation_not_shipped/in_shipstation_shipped) are
never modified.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
import models
from services import shopify_service

router = APIRouter()

# Statuses that are already in ShipStation — never touch their line items or plans
IN_PROGRESS_STATUSES = {"in_shipstation_not_shipped", "in_shipstation_shipped"}


# ── Request schemas ───────────────────────────────────────────────────────────

class ProductUpdate(BaseModel):
    allow_short_ship: Optional[bool] = None
    inventory_hold: Optional[bool] = None

class SetShortShipByTypeRequest(BaseModel):
    product_type: str
    allow_short_ship: bool

class SetInventoryHoldByTypeRequest(BaseModel):
    product_type: str
    inventory_hold: bool


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sync_products(db: Session):
    """
    Pull product catalog from Shopify and upsert into shopify_products.
    Preserves existing allow_short_ship values.
    Deduplicates by shopify_sku: when the same SKU appears in multiple products,
    prefers the entry with a non-null product_type over one without.
    """
    now = datetime.now(timezone.utc)
    raw_products = shopify_service.get_products()

    # Deduplicate by shopify_sku.
    # When the same SKU appears in multiple Shopify products (e.g. the standalone
    # product AND a bundle/collection that reuses the variant SKU), prefer the
    # entry that has a product_type set.  This prevents a NULL-typed duplicate
    # from silently overwriting a correctly-typed standalone product.
    by_sku: dict = {}
    for p in raw_products:
        existing_entry = by_sku.get(p["shopify_sku"])
        if existing_entry is None:
            # First time we see this SKU — always take it
            by_sku[p["shopify_sku"]] = p
        elif p["product_type"] and not existing_entry["product_type"]:
            # Current entry wins only if it has a type and the stored one doesn't
            by_sku[p["shopify_sku"]] = p
        # else: keep the existing entry (it has a type, or neither has one)

    # Load all existing records in one query for efficiency
    existing_map = {
        r.shopify_sku: r
        for r in db.query(models.ShopifyProduct).all()
    }

    for sku, p in by_sku.items():
        existing = existing_map.get(sku)
        if existing:
            existing.shopify_product_id = p["shopify_product_id"]
            existing.title              = p["title"]
            existing.product_type       = p["product_type"]
            existing.synced_at          = now
        else:
            obj = models.ShopifyProduct(
                shopify_product_id = p["shopify_product_id"],
                shopify_sku        = sku,
                title              = p["title"],
                product_type       = p["product_type"],
                allow_short_ship   = False,
                inventory_hold     = False,
                synced_at          = now,
            )
            db.add(obj)
            existing_map[sku] = obj  # prevent re-add if sku appears again

    db.flush()


def _upsert_products_from_line_items(db: Session):
    """
    After syncing from Shopify's product catalog, ensure every shopify_sku that
    appears on an order line item has a usable product_type in shopify_products.

    Two cases handled:
    1. SKU has no shopify_products record at all (subscription/manual line items):
       create a placeholder using the line item's product_title as the type.
    2. SKU exists in shopify_products but has product_type = NULL (Shopify product
       has no product type set): fill it in from the line item's product_title so
       it appears as a named group in the Short Ship Config instead of "(no type)".

    A full Shopify product sync will overwrite case 2 with the real Shopify type
    if one is ever set.
    """
    now = datetime.now(timezone.utc)

    # All distinct (shopify_sku, product_title) pairs from current line items
    li_rows = (
        db.query(
            models.ShopifyLineItem.shopify_sku,
            models.ShopifyLineItem.product_title,
        )
        .filter(
            models.ShopifyLineItem.shopify_sku.isnot(None),
            models.ShopifyLineItem.shopify_sku != "",
        )
        .distinct()
        .all()
    )

    # Build a map: sku → best product_title (prefer non-None)
    sku_title: dict[str, str | None] = {}
    for sku, title in li_rows:
        if sku not in sku_title or (title and not sku_title[sku]):
            sku_title[sku] = title

    # Load all existing records — need both SKU set and null-type records
    existing_records = {
        r.shopify_sku: r
        for r in db.query(models.ShopifyProduct).all()
    }
    existing_skus = set(existing_records.keys())

    for sku, title in sku_title.items():
        if sku in existing_skus:
            # If the Shopify sync left this record with no product_type, fill it in
            # from the line item's product_title so it shows up as a named group
            # in the Short Ship Config (instead of lumping into "(no type)").
            existing = existing_records[sku]
            if existing.product_type is None and title:
                existing.product_type = title
            continue
        obj = models.ShopifyProduct(
            shopify_sku=sku,
            title=title,
            product_type=title,   # best available proxy until a real sync fills it in
            allow_short_ship=False,
            inventory_hold=False,
            synced_at=now,
        )
        db.add(obj)

    db.flush()


def _get_active_rule_tags(db) -> dict:
    """Returns {action: set_of_lowercase_tags} for all active order rules."""
    from models import OrderRule
    rules = db.query(OrderRule).filter(OrderRule.is_active == True).all()
    result = {}
    for rule in rules:
        result.setdefault(rule.action, set()).add(rule.tag.lower())
    return result


def apply_short_ship_to_orders(db: Session) -> dict:
    """
    For all open orders (not in ShipStation):
      1. Set app_line_status='short_ship' on line items whose shopify_sku has allow_short_ship=True.
      2. Set app_line_status='inventory_hold' on line items whose shopify_sku has inventory_hold=True.
      3. Clear 'short_ship'/'inventory_hold' from line items whose shopify_sku no longer has the flag.
      4. Delete unpushed plan boxes that contain short-ship shopify_skus (NOT for inventory hold).
      5. Staged orders that have any line item change are moved back to not_processed
         and committed inventory is recomputed.

    Returns summary counts.
    """
    from routers.inventory import _recompute_committed

    # Build set of short-ship SKUs and inventory-hold SKUs
    short_ship_skus = {
        r.shopify_sku
        for r in db.query(models.ShopifyProduct).filter(
            models.ShopifyProduct.allow_short_ship == True
        ).all()
    }
    inventory_hold_skus = {
        r.shopify_sku
        for r in db.query(models.ShopifyProduct).filter(
            models.ShopifyProduct.inventory_hold == True
        ).all()
    }

    # Non-staged open orders (not in ShipStation)
    open_orders = (
        db.query(models.ShopifyOrder)
        .filter(models.ShopifyOrder.app_status.notin_(IN_PROGRESS_STATUSES))
        .filter(models.ShopifyOrder.app_status != "staged")
        .all()
    )

    # Staged orders — process them but unstage if any line item changes
    staged_orders = (
        db.query(models.ShopifyOrder)
        .filter(models.ShopifyOrder.app_status == "staged")
        .all()
    )

    lines_marked    = 0
    lines_cleared   = 0
    hold_lines_marked  = 0
    hold_lines_cleared = 0
    boxes_deleted   = 0
    affected_orders = set()   # non-staged orders needing box plan reset
    staged_affected = set()   # staged orders that need to be unstaged
    hold_staged_affected = set()  # staged orders unstaged due to inventory hold

    def _apply_line_statuses(line_items, order_id, is_staged):
        nonlocal lines_marked, lines_cleared, hold_lines_marked, hold_lines_cleared
        for li in line_items:
            if li.app_line_status == "removed":
                continue
            fq = li.fulfillable_quantity or 0
            sku = li.shopify_sku

            if sku in short_ship_skus and fq > 0:
                if li.app_line_status != "short_ship":
                    li.app_line_status = "short_ship"
                    lines_marked += 1
                    if is_staged:
                        staged_affected.add(order_id)
                    else:
                        affected_orders.add(order_id)
            elif sku in inventory_hold_skus and fq > 0:
                if li.app_line_status != "inventory_hold":
                    li.app_line_status = "inventory_hold"
                    hold_lines_marked += 1
                    if is_staged:
                        hold_staged_affected.add(order_id)
            else:
                if li.app_line_status == "short_ship":
                    li.app_line_status = None
                    lines_cleared += 1
                    if is_staged:
                        staged_affected.add(order_id)
                elif li.app_line_status == "inventory_hold":
                    li.app_line_status = None
                    hold_lines_cleared += 1

    for order in open_orders:
        line_items = (
            db.query(models.ShopifyLineItem)
            .filter(models.ShopifyLineItem.shopify_order_id == order.shopify_order_id)
            .all()
        )
        _apply_line_statuses(line_items, order.shopify_order_id, is_staged=False)

    for order in staged_orders:
        line_items = (
            db.query(models.ShopifyLineItem)
            .filter(models.ShopifyLineItem.shopify_order_id == order.shopify_order_id)
            .all()
        )
        _apply_line_statuses(line_items, order.shopify_order_id, is_staged=True)

    db.flush()

    # Unstage affected staged orders (both short-ship and inventory hold)
    all_unstaged = staged_affected | hold_staged_affected
    affected_warehouses: set = set()
    for order in staged_orders:
        if order.shopify_order_id in all_unstaged:
            order.app_status = "not_processed"
            if order.assigned_warehouse:
                affected_warehouses.add(order.assigned_warehouse)

    db.flush()

    # Reset plan boxes ONLY for short-ship affected orders (NOT inventory hold)
    for order_id in affected_orders | staged_affected:
        plans = (
            db.query(models.FulfillmentPlan)
            .filter(
                models.FulfillmentPlan.shopify_order_id == order_id,
                models.FulfillmentPlan.status != "cancelled",
            )
            .all()
        )
        for plan in plans:
            boxes = (
                db.query(models.FulfillmentBox)
                .filter(
                    models.FulfillmentBox.plan_id == plan.id,
                    models.FulfillmentBox.status == "pending",
                    models.FulfillmentBox.shipstation_order_id == None,
                )
                .all()
            )
            for box in boxes:
                items = (
                    db.query(models.BoxLineItem)
                    .filter(models.BoxLineItem.box_id == box.id)
                    .all()
                )
                has_short_ship = any(
                    (item.shopify_sku or "") in short_ship_skus
                    for item in items
                )
                if has_short_ship:
                    db.query(models.BoxLineItem).filter(
                        models.BoxLineItem.box_id == box.id
                    ).delete()
                    db.delete(box)
                    boxes_deleted += 1

    db.flush()

    # Recompute committed inventory for warehouses that had staged orders unstaged
    for wh in affected_warehouses:
        _recompute_committed(wh, db)

    return {
        "lines_marked":          lines_marked,
        "lines_cleared":         lines_cleared,
        "hold_lines_marked":     hold_lines_marked,
        "hold_lines_cleared":    hold_lines_cleared,
        "boxes_deleted":         boxes_deleted,
        "affected_orders":       len(affected_orders),
        "orders_unstaged":       len(staged_affected),
        "orders_unstaged_hold":  len(hold_staged_affected),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[dict])
def list_products(
    product_type: Optional[str] = Query(None),
    short_ship_only: bool = Query(False),
    db: Session = Depends(get_db),
):
    """
    List all synced Shopify products.
    Optionally filter by product_type or show only short-ship items.
    """
    q = db.query(models.ShopifyProduct).order_by(
        models.ShopifyProduct.product_type,
        models.ShopifyProduct.title,
        models.ShopifyProduct.shopify_sku,
    )

    if product_type:
        q = q.filter(models.ShopifyProduct.product_type == product_type)

    if short_ship_only:
        q = q.filter(models.ShopifyProduct.allow_short_ship == True)

    products = q.all()
    return [
        {
            "id":                p.id,
            "shopify_sku":       p.shopify_sku,
            "title":             p.title,
            "product_type":      p.product_type,
            "allow_short_ship":  p.allow_short_ship,
            "inventory_hold":    p.inventory_hold,
            "synced_at":         p.synced_at,
        }
        for p in products
    ]


@router.get("/product-types", response_model=List[dict])
def list_product_types(db: Session = Depends(get_db)):
    """
    Return distinct product_types with aggregate counts and short-ship status.
    """
    from sqlalchemy import func as sqlfunc, Integer as SAInteger, cast
    rows = (
        db.query(
            models.ShopifyProduct.product_type,
            sqlfunc.count(models.ShopifyProduct.id).label("sku_count"),
            sqlfunc.sum(
                cast(models.ShopifyProduct.allow_short_ship, SAInteger)
            ).label("short_ship_count"),
            sqlfunc.sum(
                cast(models.ShopifyProduct.inventory_hold, SAInteger)
            ).label("inventory_hold_count"),
        )
        .group_by(models.ShopifyProduct.product_type)
        .order_by(models.ShopifyProduct.product_type)
        .all()
    )

    return [
        {
            "product_type":          r.product_type,
            "sku_count":             r.sku_count,
            "short_ship_count":      r.short_ship_count or 0,
            "all_short_ship":        (r.short_ship_count or 0) == r.sku_count,
            "inventory_hold_count":  r.inventory_hold_count or 0,
            "all_inventory_hold":    (r.inventory_hold_count or 0) == r.sku_count,
        }
        for r in rows
    ]


@router.patch("/{product_id}", response_model=dict)
def update_product(
    product_id: int,
    body: ProductUpdate,
    db: Session = Depends(get_db),
):
    """Save allow_short_ship or inventory_hold on a single product SKU. Does NOT apply to orders — call /apply for that."""
    product = db.query(models.ShopifyProduct).filter(
        models.ShopifyProduct.id == product_id
    ).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    if body.allow_short_ship is not None:
        product.allow_short_ship = body.allow_short_ship
        if body.allow_short_ship:
            product.inventory_hold = False  # mutual exclusivity

    if body.inventory_hold is not None:
        product.inventory_hold = body.inventory_hold
        if body.inventory_hold:
            product.allow_short_ship = False  # mutual exclusivity

    db.commit()
    db.refresh(product)

    return {
        "id":               product.id,
        "shopify_sku":      product.shopify_sku,
        "allow_short_ship": product.allow_short_ship,
        "inventory_hold":   product.inventory_hold,
    }


@router.post("/set-short-ship-by-type")
def set_short_ship_by_type(
    body: SetShortShipByTypeRequest,
    db: Session = Depends(get_db),
):
    """Save allow_short_ship on all products of a given product_type. Does NOT apply to orders — call /apply for that."""
    updated = (
        db.query(models.ShopifyProduct)
        .filter(models.ShopifyProduct.product_type == body.product_type)
        .all()
    )
    if not updated:
        raise HTTPException(
            status_code=404,
            detail=f"No products found with product_type='{body.product_type}'"
        )

    for p in updated:
        p.allow_short_ship = body.allow_short_ship
        if body.allow_short_ship:
            p.inventory_hold = False  # mutual exclusivity

    db.commit()

    return {
        "product_type":     body.product_type,
        "products_updated": len(updated),
        "allow_short_ship": body.allow_short_ship,
    }


@router.post("/set-inventory-hold-by-type")
def set_inventory_hold_by_type(
    body: SetInventoryHoldByTypeRequest,
    db: Session = Depends(get_db),
):
    """Save inventory_hold on all products of a given product_type. Does NOT apply to orders — call /apply for that."""
    updated = (
        db.query(models.ShopifyProduct)
        .filter(models.ShopifyProduct.product_type == body.product_type)
        .all()
    )
    if not updated:
        raise HTTPException(
            status_code=404,
            detail=f"No products found with product_type='{body.product_type}'"
        )

    for p in updated:
        p.inventory_hold = body.inventory_hold
        if body.inventory_hold:
            p.allow_short_ship = False  # mutual exclusivity

    db.commit()

    return {
        "product_type":     body.product_type,
        "products_updated": len(updated),
        "inventory_hold":   body.inventory_hold,
    }


@router.post("/apply")
def apply_short_ship(db: Session = Depends(get_db)):
    """
    Re-apply current short-ship rules to all open orders.
    Useful if rules were changed without triggering an order pull.
    """
    result = apply_short_ship_to_orders(db)
    db.commit()

    # Also check order rules (hold, DNSS, margin) and unstage affected staged orders
    from routers.orders import _unstage_by_order_rules
    rule_unstage = _unstage_by_order_rules(db, check_margin=True)
    db.commit()

    return {
        **result,
        "orders_unstaged_rules_hold": rule_unstage["orders_unstaged_hold"],
        "orders_unstaged_dnss": rule_unstage["orders_unstaged_dnss"],
        "orders_unstaged_margin": rule_unstage["orders_unstaged_margin"],
    }


@router.get("/catalog-errors", response_model=dict)
def catalog_errors(db: Session = Depends(get_db)):
    """
    Diagnostic endpoint: surface SKU / product-type data quality issues.

    Returns three buckets:
    - no_product_type: records in shopify_products with no product_type set.
      These lump together in the Short Ship Config under "(no type)".
    - no_shopify_product: shopify_skus on current open order line items that
      have no matching row in shopify_products at all.
    - no_sku_on_line_item: open order line items whose shopify_sku is null/empty
      (order was placed with a blank SKU in Shopify).
    """
    # ── 1. Products with no product_type ──────────────────────────────────────
    no_type_rows = (
        db.query(models.ShopifyProduct)
        .filter(
            (models.ShopifyProduct.product_type.is_(None)) |
            (models.ShopifyProduct.product_type == "")
        )
        .order_by(models.ShopifyProduct.title)
        .all()
    )
    no_product_type = [
        {
            "id":               r.id,
            "shopify_sku":      r.shopify_sku,
            "title":            r.title,
            "shopify_product_id": r.shopify_product_id,
            "allow_short_ship": r.allow_short_ship,
            "synced_at":        r.synced_at.isoformat() if r.synced_at else None,
            # Records with no shopify_product_id were created from line-item data,
            # not from a real Shopify product page sync.
            "source":           "shopify" if r.shopify_product_id else "line_item_placeholder",
        }
        for r in no_type_rows
    ]

    # ── 2. Line-item SKUs missing from shopify_products ───────────────────────
    # Get all distinct non-empty shopify_skus from open orders
    OPEN_STATUSES = {"not_processed", "staged", "needs_plan"}
    li_skus = (
        db.query(
            models.ShopifyLineItem.shopify_sku,
            models.ShopifyLineItem.product_title,
            models.ShopifyOrder.shopify_order_number,
        )
        .join(
            models.ShopifyOrder,
            models.ShopifyLineItem.shopify_order_id == models.ShopifyOrder.shopify_order_id,
        )
        .filter(
            models.ShopifyLineItem.shopify_sku.isnot(None),
            models.ShopifyLineItem.shopify_sku != "",
            models.ShopifyOrder.app_status.in_(OPEN_STATUSES),
        )
        .distinct()
        .all()
    )

    # Collect all known shopify_skus in the catalog
    catalog_skus = {
        r.shopify_sku
        for r in db.query(models.ShopifyProduct.shopify_sku).all()
    }

    # Group missing skus: sku → {product_title, order_numbers}
    missing: dict = {}
    for sku, title, order_number in li_skus:
        if sku not in catalog_skus:
            if sku not in missing:
                missing[sku] = {"product_title": title, "order_numbers": []}
            if order_number and order_number not in missing[sku]["order_numbers"]:
                missing[sku]["order_numbers"].append(order_number)

    no_shopify_product = [
        {
            "shopify_sku":    sku,
            "product_title":  info["product_title"],
            "order_count":    len(info["order_numbers"]),
            "order_numbers":  sorted(info["order_numbers"]),
        }
        for sku, info in sorted(missing.items())
    ]

    # ── 3. Line items with no shopify_sku ─────────────────────────────────────
    no_sku_rows = (
        db.query(
            models.ShopifyLineItem.product_title,
            models.ShopifyLineItem.variant_title,
            models.ShopifyOrder.shopify_order_number,
            models.ShopifyOrder.shopify_order_id,
        )
        .join(
            models.ShopifyOrder,
            models.ShopifyLineItem.shopify_order_id == models.ShopifyOrder.shopify_order_id,
        )
        .filter(
            (models.ShopifyLineItem.shopify_sku.is_(None)) |
            (models.ShopifyLineItem.shopify_sku == ""),
            models.ShopifyOrder.app_status.in_(OPEN_STATUSES),
        )
        .order_by(models.ShopifyOrder.shopify_order_number)
        .all()
    )
    no_sku_on_line_item = [
        {
            "product_title":      r.product_title,
            "variant_title":      r.variant_title,
            "order_number":       r.shopify_order_number,
            "shopify_order_id":   r.shopify_order_id,
        }
        for r in no_sku_rows
    ]

    return {
        "no_product_type":     no_product_type,
        "no_shopify_product":  no_shopify_product,
        "no_sku_on_line_item": no_sku_on_line_item,
    }


@router.post("/sync")
def sync_products(db: Session = Depends(get_db)):
    """Manually sync product catalog from Shopify."""
    if not shopify_service.is_configured():
        raise HTTPException(
            status_code=503,
            detail="Shopify not connected. Visit /api/shopify/connect to authenticate."
        )
    _sync_products(db)
    _upsert_products_from_line_items(db)
    db.commit()
    count = db.query(models.ShopifyProduct).count()
    return {"synced": True, "total_products": count}
