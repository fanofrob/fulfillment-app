"""
Fulfillment router — multi-box fulfillment plans for Shopify orders.

Entities:
  FulfillmentPlan       — one plan per Shopify order
  FulfillmentBox        — one or more boxes per plan; each pushed as its own ShipStation order
  BoxLineItem           — pick_sku + quantity (in pick units) assigned to a box
  LineItemChangeEvent   — detected drift between Shopify line items and planned box items

Plan statuses:  draft | active | needs_review | needs_reconfiguration | completed | cancelled
Box statuses:   pending | packed | shipped
Change statuses: pending_approval | approved | rejected
"""

from datetime import datetime, timezone, timedelta
from typing import Optional, List
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import time
import uuid

import csv
import json
import os

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from database import get_db, SessionLocal
import models
from services import shipstation_service, sheets_service, shopify_service

router = APIRouter()


# ── ShipStation rate limiter (shared across all push operations) ─────────────
_rate_lock = threading.Lock()
_rate_timestamps: list = []
_RATE_MAX = 35          # max requests per window (ShipStation caps at 40)
_RATE_WINDOW = 60.0     # seconds


def _ss_rate_wait():
    """Block the calling thread until a rate-limit slot is available."""
    while True:
        with _rate_lock:
            now = time.monotonic()
            while _rate_timestamps and _rate_timestamps[0] <= now - _RATE_WINDOW:
                _rate_timestamps.pop(0)
            if len(_rate_timestamps) < _RATE_MAX:
                _rate_timestamps.append(now)
                return
            wait = _rate_timestamps[0] - (now - _RATE_WINDOW) + 0.1
        time.sleep(wait)


# ── Background push-job tracker ──────────────────────────────────────────────
_push_jobs: dict = {}   # job_id → {status, pushed, failed, total, …}


def _cleanup_old_jobs():
    stale = [jid for jid, j in _push_jobs.items()
             if time.time() - j.get("started_at", 0) > 1800]
    for jid in stale:
        del _push_jobs[jid]


# ── Request schemas ───────────────────────────────────────────────────────────

class PlanCreate(BaseModel):
    shopify_order_id: str
    notes: Optional[str] = None

class PlanUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None

class BulkAutoPlanRequest(BaseModel):
    order_ids: Optional[List[str]] = None

class BoxCreate(BaseModel):
    notes: Optional[str] = None
    box_type_id: Optional[int] = None

class BoxUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None
    carrier: Optional[str] = None
    box_type_id: Optional[int] = None

class BoxItemsSet(BaseModel):
    items: List[dict]  # [{pick_sku, quantity, shopify_sku?, product_title?, shopify_line_item_id?}]

class ChangeReview(BaseModel):
    notes: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _row(obj) -> dict:
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}


def _plan_to_dict(plan, db: Session) -> dict:
    boxes = (
        db.query(models.FulfillmentBox)
        .filter(models.FulfillmentBox.plan_id == plan.id)
        .order_by(models.FulfillmentBox.box_number)
        .all()
    )
    boxes_out = []
    for box in boxes:
        items = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).all()
        boxes_out.append({**_row(box), "items": [_row(i) for i in items]})

    # Include pending change events
    changes = (
        db.query(models.LineItemChangeEvent)
        .filter(
            models.LineItemChangeEvent.plan_id == plan.id,
            models.LineItemChangeEvent.status == "pending_approval",
        )
        .order_by(models.LineItemChangeEvent.detected_at.desc())
        .all()
    )

    return {**_row(plan), "boxes": boxes_out, "pending_changes": [_row(c) for c in changes]}


def _snap_to_json(snap: dict) -> dict:
    """Convert {(pick_sku, li_id): qty} to JSON-safe {pick_sku||li_id: qty}."""
    return {f"{k[0]}||{k[1]}": v for k, v in snap.items()}


def _json_to_snap(json_dict: dict) -> dict:
    """Convert JSON {pick_sku||li_id: qty} back to {(pick_sku, li_id): qty}.

    Also handles legacy format {pick_sku: qty} (no separator).
    """
    result = {}
    for k, v in json_dict.items():
        if "||" in k:
            parts = k.split("||", 1)
            result[(parts[0], parts[1])] = v
        else:
            result[(k, "")] = v
    return result


def _shopify_items_snapshot(shopify_order_id: str, db: Session) -> dict:
    """Return {(pick_sku, line_item_id): total_quantity_in_pick_units} from current ShopifyLineItems.

    Using a composite key preserves line-item-level granularity so that
    duplicate SKUs (different Shopify line item IDs) each get their own
    BoxLineItem and are fulfilled individually in Shopify.
    """
    items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == shopify_order_id,
        models.ShopifyLineItem.sku_mapped == True,
        models.ShopifyLineItem.pick_sku.isnot(None),
        or_(models.ShopifyLineItem.app_line_status != "short_ship", models.ShopifyLineItem.app_line_status.is_(None)),
    ).all()
    totals: dict[tuple, float] = {}
    for li in items:
        qty = li.fulfillable_quantity if li.fulfillable_quantity is not None else li.quantity
        if qty <= 0:
            continue
        units = qty * (li.mix_quantity or 1.0)
        key = (li.pick_sku, li.line_item_id)
        totals[key] = totals.get(key, 0.0) + units
    return totals


def _plan_items_snapshot(plan_id: int, db: Session) -> dict:
    """Return {(pick_sku, line_item_id): total_quantity} summed across all boxes in the plan."""
    boxes = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.plan_id == plan_id
    ).all()
    totals: dict[tuple, float] = {}
    for box in boxes:
        for item in db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).all():
            key = (item.pick_sku, item.shopify_line_item_id or "")
            totals[key] = totals.get(key, 0.0) + item.quantity
    return totals


# ── Zip → Zone lookup (loaded once from csv) ─────────────────────────────────

_ZIP_ZONE: dict[str, int] = {}

def _load_zip_zones():
    global _ZIP_ZONE
    if _ZIP_ZONE:
        return
    csv_path = os.path.join(os.path.dirname(__file__), "..", "zip_zones.csv")
    try:
        with open(os.path.normpath(csv_path), newline="") as f:
            for row in csv.DictReader(f):
                prefix = str(row.get("ZIP Code Prefix", "")).strip().zfill(3)
                try:
                    _ZIP_ZONE[prefix] = int(row["Zone"])
                except (KeyError, ValueError):
                    pass
    except FileNotFoundError:
        pass

_load_zip_zones()


def _zone_for_zip(zip_code: Optional[str]) -> Optional[int]:
    """Return the shipping zone (1–9) for a zip code using 3-digit prefix lookup."""
    if not zip_code:
        return None
    prefix = str(zip_code).strip().replace("-", "")[:3].zfill(3)
    return _ZIP_ZONE.get(prefix)


def _order_pactor(order: models.ShopifyOrder, db: Session) -> Optional[float]:
    """
    Calculate the total pactor for an order:
    sum(pactor_per_sku[pick_sku] × pick_quantity) across all mapped line items.
    Reads pactor values from the picklist_skus DB table (app is source of truth).
    """
    rows = db.query(models.PicklistSku).filter(models.PicklistSku.pactor.isnot(None)).all()
    pactor_map = {r.pick_sku: r.pactor for r in rows}
    if not pactor_map:
        return None

    line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
        models.ShopifyLineItem.sku_mapped == True,
        models.ShopifyLineItem.pick_sku.isnot(None),
        or_(models.ShopifyLineItem.app_line_status != "short_ship", models.ShopifyLineItem.app_line_status.is_(None)),
    ).all()

    total = 0.0
    found_any = False
    for li in line_items:
        p = pactor_map.get(li.pick_sku)
        if p is not None:
            qty = li.fulfillable_quantity if li.fulfillable_quantity is not None else li.quantity
            total += p * qty * (li.mix_quantity or 1.0)
            found_any = True

    return total if found_any else None


def _order_weight(order: models.ShopifyOrder, db: Session) -> Optional[float]:
    """
    Calculate the total contents weight (lbs) for an order — box tare excluded.
    sum(weight_lb[pick_sku] × pick_quantity) across all mapped line items.
    """
    rows = db.query(models.PicklistSku).filter(models.PicklistSku.weight_lb.isnot(None)).all()
    weight_map = {r.pick_sku: r.weight_lb for r in rows}
    if not weight_map:
        return None

    line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
        models.ShopifyLineItem.sku_mapped == True,
        models.ShopifyLineItem.pick_sku.isnot(None),
        or_(models.ShopifyLineItem.app_line_status != "short_ship", models.ShopifyLineItem.app_line_status.is_(None)),
    ).all()

    total = 0.0
    found_any = False
    for li in line_items:
        w = weight_map.get(li.pick_sku)
        if w is not None:
            qty = li.fulfillable_quantity if li.fulfillable_quantity is not None else li.quantity
            total += w * qty * (li.mix_quantity or 1.0)
            found_any = True

    return total if found_any else None


# ── Condition evaluator ───────────────────────────────────────────────────────

def _eval_numeric(operator: str, actual: float, value, value2=None) -> bool:
    """Apply a numeric operator between actual and value(s)."""
    try:
        v = float(value) if value is not None else None
        v2 = float(value2) if value2 is not None else None
    except (TypeError, ValueError):
        return False
    if operator == "is_empty":
        return actual is None
    if operator == "not_empty":
        return actual is not None
    if actual is None:
        return False
    if operator == "eq":   return actual == v
    if operator == "neq":  return actual != v
    if operator == "lt":   return actual < v
    if operator == "lte":  return actual <= v
    if operator == "gt":   return actual > v
    if operator == "gte":  return actual >= v
    if operator == "between" and v is not None and v2 is not None:
        return v <= actual <= v2
    return False


def _eval_condition(cond: dict, order: models.ShopifyOrder, db: Session) -> bool:
    """Evaluate a single PackageRule condition against a Shopify order."""
    field = cond.get("field", "")
    operator = cond.get("operator", "")
    value = cond.get("value")
    value2 = cond.get("value2")

    if field == "tags":
        raw = order.tags or ""
        tags = {t.strip().lower() for t in raw.split(",") if t.strip()}
        v = str(value).lower() if value is not None else ""
        if operator == "contains":
            return v in tags or any(v in t for t in tags)
        elif operator == "not_contains":
            return v not in tags and not any(v in t for t in tags)
        elif operator in ("eq", "is_exactly"):
            return v in tags
        elif operator == "neq":
            return v not in tags
        elif operator == "is_empty":
            return len(tags) == 0
        elif operator == "not_empty":
            return len(tags) > 0
        return False

    if field == "zone":
        zone = _zone_for_zip(order.shipping_zip)
        return _eval_numeric(operator, zone, value, value2)

    if field == "pactor":
        pactor = _order_pactor(order, db)
        return _eval_numeric(operator, pactor, value, value2)

    if field == "weight":
        weight = _order_weight(order, db)
        return _eval_numeric(operator, weight, value, value2)

    if field == "carrier_service":
        match = _apply_carrier_service_rules(order, db)
        actual = f"{match['carrier_code']}::{match['service_code']}" if match else None
        if operator == "eq":
            return actual == value
        if operator == "neq":
            return actual != value
        if operator == "is_empty":
            return actual is None
        if operator == "not_empty":
            return actual is not None
        return False

    return False


def _apply_package_rules(order: models.ShopifyOrder, db: Session) -> Optional[int]:
    """
    Evaluate active PackageRules (highest priority first) against the order.
    Returns the box_type_id of the first matching rule, or None if no match.
    A rule with no conditions is treated as a catch-all default.
    """
    rules = (
        db.query(models.PackageRule)
        .filter(models.PackageRule.is_active == True)
        .order_by(models.PackageRule.priority.desc())
        .all()
    )
    for rule in rules:
        conditions = rule.conditions or []
        matched = not conditions or all(_eval_condition(c, order, db) for c in conditions)
        if matched:
            box_type = db.query(models.BoxType).filter(
                models.BoxType.name == rule.package_type,
                models.BoxType.is_active == True,
            ).first()
            if box_type:
                return box_type.id
    return None


def _apply_carrier_service_rules(order: models.ShopifyOrder, db: Session) -> Optional[dict]:
    """
    Evaluate active CarrierServiceRules (highest priority first) against the order.
    Returns {rule_id, rule_name, carrier_code, service_code, shipping_provider_id} for the first match, or None.
    """
    rules = (
        db.query(models.CarrierServiceRule)
        .filter(models.CarrierServiceRule.is_active == True)
        .order_by(models.CarrierServiceRule.priority.desc())
        .all()
    )
    for rule in rules:
        conditions = rule.conditions or []
        matched = not conditions or all(_eval_condition(c, order, db) for c in conditions)
        if matched:
            return {
                "rule_id": rule.id,
                "rule_name": rule.name,
                "carrier_code": rule.carrier_code,
                "service_code": rule.service_code,
                "shipping_provider_id": rule.shipping_provider_id,
            }
    return None


def _next_box_number(plan_id: int, db: Session) -> int:
    last = (
        db.query(models.FulfillmentBox)
        .filter(models.FulfillmentBox.plan_id == plan_id)
        .order_by(models.FulfillmentBox.box_number.desc())
        .first()
    )
    return (last.box_number + 1) if last else 1


# ── Multi-box split helpers ───────────────────────────────────────────────────

def _populate_box_items(box_id: int, items: dict, li_meta: dict, db: Session):
    """Insert BoxLineItem rows from a {(pick_sku, line_item_id): qty} dict."""
    for (pick_sku, line_item_id), qty in items.items():
        meta = li_meta.get((pick_sku, line_item_id))
        db.add(models.BoxLineItem(
            box_id=box_id,
            pick_sku=pick_sku,
            shopify_sku=meta.shopify_sku if meta else None,
            product_title=meta.product_title if meta else None,
            shopify_line_item_id=line_item_id or None,
            quantity=qty,
        ))


def _get_max_box_pactor(order: models.ShopifyOrder, db: Session) -> Optional[float]:
    """
    Return the highest pactor upper-bound across all active package rules whose
    non-pactor conditions (carrier service, zone, tags) match this order.
    """
    rules = db.query(models.PackageRule).filter(models.PackageRule.is_active == True).all()
    max_cap = 0.0
    for rule in rules:
        conditions = rule.conditions or []
        pactor_conds = [c for c in conditions if c.get("field") == "pactor"]
        non_pactor_conds = [c for c in conditions if c.get("field") != "pactor"]

        if non_pactor_conds and not all(_eval_condition(c, order, db) for c in non_pactor_conds):
            continue

        for pc in pactor_conds:
            op = pc.get("operator")
            val = pc.get("value")
            val2 = pc.get("value2")
            try:
                if op == "between" and val2 is not None:
                    max_cap = max(max_cap, float(val2))
                elif op in ("lt", "lte") and val is not None:
                    max_cap = max(max_cap, float(val))
                elif op == "eq" and val is not None:
                    max_cap = max(max_cap, float(val))
            except (TypeError, ValueError):
                pass

    return max_cap if max_cap > 0 else None


def _eval_condition_with_pactor(
    cond: dict, order: models.ShopifyOrder, pactor_override: float, db: Session
) -> bool:
    """Like _eval_condition but substitutes pactor_override for the pactor field."""
    if cond.get("field") == "pactor":
        return _eval_numeric(
            cond.get("operator", ""),
            pactor_override,
            cond.get("value"),
            cond.get("value2"),
        )
    return _eval_condition(cond, order, db)


def _apply_package_rules_for_pactor(
    order: models.ShopifyOrder, pactor_override: float, db: Session
) -> Optional[int]:
    """Like _apply_package_rules but uses pactor_override instead of computing order pactor."""
    rules = (
        db.query(models.PackageRule)
        .filter(models.PackageRule.is_active == True)
        .order_by(models.PackageRule.priority.desc())
        .all()
    )
    for rule in rules:
        conditions = rule.conditions or []
        matched = not conditions or all(
            _eval_condition_with_pactor(c, order, pactor_override, db)
            for c in conditions
        )
        if matched:
            box_type = db.query(models.BoxType).filter(
                models.BoxType.name == rule.package_type,
                models.BoxType.is_active == True,
            ).first()
            if box_type:
                return box_type.id
    return None


def _compute_multi_box_split(
    order: models.ShopifyOrder, db: Session
) -> tuple[Optional[list], list]:
    """
    Bin-pack order items into the fewest boxes using First Fit Decreasing (FFD).
    The minimum atomic unit is 1 Shopify quantity of a line item. For mix/bundle
    SKUs (one Shopify item → multiple pick SKUs), all pick SKUs belonging to the
    same shopify_line_item_id are kept together in the same box. Rows can be split
    at individual qty boundaries, but a single Shopify unit is never split across boxes.

    Returns (boxes, errors):
      boxes — list of {"box_type_id": int|None, "items": {pick_sku: qty}, "total_pactor": float}
      errors — non-empty when a single Shopify unit's pactor exceeds the largest available box
    Returns (None, errors) when packing is impossible or no applicable box types exist.
    """
    pactor_map = {
        r.pick_sku: r.pactor
        for r in db.query(models.PicklistSku).filter(models.PicklistSku.pactor.isnot(None)).all()
    }

    line_items = db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
        models.ShopifyLineItem.sku_mapped == True,
        models.ShopifyLineItem.pick_sku.isnot(None),
        or_(models.ShopifyLineItem.app_line_status != "short_ship", models.ShopifyLineItem.app_line_status.is_(None)),
    ).all()

    # Group line items by shopify_line_item_id.
    # All pick SKUs that share a line_item_id belong to the same Shopify item (e.g. a
    # mix/bundle SKU). One Shopify unit = all those pick SKUs together — they must always
    # land in the same box.
    from collections import defaultdict
    groups: dict = defaultdict(list)
    for li in line_items:
        groups[li.line_item_id].append(li)

    # Build one "shopify unit" template per line-item group, then expand by qty.
    # Each entry in shopify_units represents 1 Shopify unit (atomic packing unit).
    # Components use (pick_sku, line_item_id) composite keys so that duplicate SKUs
    # with different line item IDs stay separate through bin-packing.
    shopify_units: list[dict] = []

    for li_id, rows in groups.items():
        # Qty is the same across all rows in a group; use the first row.
        first = rows[0]
        qty = (first.fulfillable_quantity if first.fulfillable_quantity is not None else first.quantity) or 0
        if qty <= 0:
            continue

        # Compute pactor and pick-qty contributed by this Shopify unit.
        pactor_per_unit = 0.0
        components: dict = {}  # {(pick_sku, line_item_id): pick_qty_per_shopify_unit}
        skip = False
        for li in rows:
            ppu = pactor_map.get(li.pick_sku)
            if ppu is None:
                skip = True
                break
            mix = li.mix_quantity or 1.0
            comp_key = (li.pick_sku, li_id)
            components[comp_key] = components.get(comp_key, 0.0) + mix
            pactor_per_unit += mix * ppu
        if skip or not components:
            continue

        for _ in range(int(qty)):
            shopify_units.append({
                "components": dict(components),  # {(pick_sku, li_id): pick_qty}
                "item_pactor": pactor_per_unit,
            })
        frac = qty - int(qty)
        if frac > 1e-9:
            shopify_units.append({
                "components": {k: v * frac for k, v in components.items()},
                "item_pactor": pactor_per_unit * frac,
            })

    if not shopify_units:
        return None, ["No items with known pactor found in order"]

    max_cap = _get_max_box_pactor(order, db)
    if not max_cap or max_cap <= 0:
        return None, []  # No applicable box types — caller falls back to "no rule" behavior

    # Flag any single Shopify unit whose pactor exceeds the largest available box
    errors = []
    seen_errors: set = set()
    for unit in shopify_units:
        # Extract just pick_skus for error message dedup (ignore line_item_id)
        pick_skus = tuple(sorted({k[0] for k in unit["components"].keys()}))
        if unit["item_pactor"] > max_cap + 1e-9 and pick_skus not in seen_errors:
            seen_errors.add(pick_skus)
            skus = ", ".join(sorted({k[0] for k in unit["components"].keys()}))
            errors.append(
                f"Item ({skus}) has per-unit pactor {unit['item_pactor']:.0f} which exceeds "
                f"the largest available box capacity ({max_cap:.0f})"
            )
    if errors:
        return None, errors

    # Sort by item pactor descending (FFD: largest items first)
    shopify_units.sort(key=lambda x: -x["item_pactor"])

    # Bins: list of {"total_pactor": float, "items": {pick_sku: qty}}
    bins: list[dict] = []

    for unit in shopify_units:
        # Find the first bin with enough space for this entire Shopify unit (First Fit)
        target = None
        for b in bins:
            if (max_cap - b["total_pactor"]) >= unit["item_pactor"] - 1e-9:
                target = b
                break

        if target is None:
            target = {"total_pactor": 0.0, "items": {}}
            bins.append(target)

        # Add all pick SKUs from this Shopify unit atomically
        for comp_key, pick_qty in unit["components"].items():
            target["items"][comp_key] = target["items"].get(comp_key, 0.0) + pick_qty
        target["total_pactor"] += unit["item_pactor"]

    # Assign a box type to each bin based on its actual total pactor
    result = []
    for b in bins:
        box_type_id = _apply_package_rules_for_pactor(order, b["total_pactor"], db)
        result.append({
            "box_type_id": box_type_id,
            "items": b["items"],
            "total_pactor": b["total_pactor"],
        })

    return result, []


def _try_multi_box_split(
    order: models.ShopifyOrder, db: Session
) -> tuple[Optional[list], list]:
    """
    Attempt a multi-box split only when total order pactor overflows the largest
    available box for this order's carrier/zone.
    Returns (None, []) when split is not needed (pactor fits in one box).
    """
    order_pactor = _order_pactor(order, db)
    max_box_pactor = _get_max_box_pactor(order, db)
    if not order_pactor or not max_box_pactor or order_pactor <= max_box_pactor + 1e-9:
        return None, []
    return _compute_multi_box_split(order, db)


# ── Pactor map ────────────────────────────────────────────────────────────────

@router.get("/carrier-service-for-order/{shopify_order_id}")
def get_carrier_service_for_order(shopify_order_id: str, db: Session = Depends(get_db)):
    """Evaluate carrier service rules and return the first match for this order."""
    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == shopify_order_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    result = _apply_carrier_service_rules(order, db)
    return result or {}


@router.get("/pactor-map")
def get_pactor_map(db: Session = Depends(get_db)):
    """Return {pick_sku: pactor_value} from the DB picklist_skus table."""
    rows = db.query(models.PicklistSku).filter(models.PicklistSku.pactor.isnot(None)).all()
    return {r.pick_sku: r.pactor for r in rows}


# ── Plans ─────────────────────────────────────────────────────────────────────

@router.get("/plans")
def list_plans(
    shopify_order_id: Optional[str] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(models.FulfillmentPlan)
    if shopify_order_id:
        q = q.filter(models.FulfillmentPlan.shopify_order_id == shopify_order_id)
    if status:
        q = q.filter(models.FulfillmentPlan.status == status)
    plans = q.order_by(models.FulfillmentPlan.created_at.desc()).all()
    return [_plan_to_dict(p, db) for p in plans]


@router.post("/plans")
def create_plan(body: PlanCreate, db: Session = Depends(get_db)):
    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == body.shopify_order_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    existing = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id == body.shopify_order_id,
        models.FulfillmentPlan.status.notin_(["cancelled"]),
    ).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"A plan already exists for this order (id={existing.id}, status={existing.status})",
        )

    plan = models.FulfillmentPlan(
        shopify_order_id=body.shopify_order_id,
        notes=body.notes,
        status="draft",
    )
    db.add(plan)
    db.flush()

    shopify_snap = _shopify_items_snapshot(body.shopify_order_id, db)

    # Build lookup for title / shopify_sku per (pick_sku, line_item_id)
    li_meta: dict[tuple, models.ShopifyLineItem] = {}
    for li in db.query(models.ShopifyLineItem).filter(
        models.ShopifyLineItem.shopify_order_id == body.shopify_order_id,
        models.ShopifyLineItem.sku_mapped == True,
        models.ShopifyLineItem.pick_sku.isnot(None),
    ).all():
        li_meta[(li.pick_sku, li.line_item_id)] = li

    auto_box_type_id = _apply_package_rules(order, db)

    if auto_box_type_id is not None:
        # Single box — rule matched directly
        box = models.FulfillmentBox(plan_id=plan.id, box_number=1, status="pending", box_type_id=auto_box_type_id)
        db.add(box)
        db.flush()
        _populate_box_items(box.id, shopify_snap, li_meta, db)
    else:
        # Try multi-box split when pactor overflows the largest available box
        split_boxes, split_errors = _try_multi_box_split(order, db)
        if split_boxes:
            for i, box_def in enumerate(split_boxes, start=1):
                box = models.FulfillmentBox(plan_id=plan.id, box_number=i, status="pending", box_type_id=box_def["box_type_id"])
                db.add(box)
                db.flush()
                _populate_box_items(box.id, box_def["items"], li_meta, db)
            if split_errors:
                err = "; ".join(split_errors)
                plan.notes = (f"{plan.notes}\n" if plan.notes else "") + f"[Auto-plan error: {err}]"
        else:
            # Fallback: single box with no type assigned
            box = models.FulfillmentBox(plan_id=plan.id, box_number=1, status="pending", box_type_id=None)
            db.add(box)
            db.flush()
            _populate_box_items(box.id, shopify_snap, li_meta, db)
            if split_errors:
                err = "; ".join(split_errors)
                plan.notes = (f"{plan.notes}\n" if plan.notes else "") + f"[Auto-plan error: {err}]"

    db.commit()
    db.refresh(plan)
    return _plan_to_dict(plan, db)


@router.get("/plans/{plan_id}")
def get_plan(plan_id: int, db: Session = Depends(get_db)):
    plan = db.query(models.FulfillmentPlan).filter(models.FulfillmentPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    return _plan_to_dict(plan, db)


@router.put("/plans/{plan_id}")
def update_plan(plan_id: int, body: PlanUpdate, db: Session = Depends(get_db)):
    plan = db.query(models.FulfillmentPlan).filter(models.FulfillmentPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    if body.status == "completed":
        unfulfilled = db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == plan.shopify_order_id,
            models.ShopifyLineItem.fulfillable_quantity > 0,
        ).count()
        if unfulfilled > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot complete plan: {unfulfilled} line item(s) are still unfulfilled on the Shopify order",
            )
    if body.status is not None:
        plan.status = body.status
    if body.notes is not None:
        plan.notes = body.notes
    db.commit()
    db.refresh(plan)
    return _plan_to_dict(plan, db)


@router.delete("/plans/{plan_id}")
def delete_plan(plan_id: int, db: Session = Depends(get_db)):
    plan = db.query(models.FulfillmentPlan).filter(models.FulfillmentPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    if plan.status not in ("draft", "cancelled"):
        raise HTTPException(status_code=409, detail="Can only delete draft or cancelled plans")
    boxes = db.query(models.FulfillmentBox).filter(models.FulfillmentBox.plan_id == plan_id).all()
    for box in boxes:
        db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).delete()
    db.query(models.FulfillmentBox).filter(models.FulfillmentBox.plan_id == plan_id).delete()
    db.query(models.LineItemChangeEvent).filter(models.LineItemChangeEvent.plan_id == plan_id).delete()
    db.delete(plan)
    db.commit()
    return {"deleted": True}


# ── Boxes ─────────────────────────────────────────────────────────────────────

@router.delete("/plans/{plan_id}/boxes/unpushed")
def delete_unpushed_boxes(plan_id: int, db: Session = Depends(get_db)):
    """Hard-delete all boxes in a plan that have never been pushed to ShipStation."""
    plan = db.query(models.FulfillmentPlan).filter(models.FulfillmentPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    unpushed = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.plan_id == plan_id,
        models.FulfillmentBox.shipstation_order_id == None,
        models.FulfillmentBox.status == "pending",
    ).all()

    deleted_count = 0
    for box in unpushed:
        db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).delete()
        db.delete(box)
        deleted_count += 1

    db.flush()

    # If no active boxes remain, revert plan to draft
    active_boxes = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.plan_id == plan_id,
        models.FulfillmentBox.status != "cancelled",
    ).count()
    if active_boxes == 0:
        plan.status = "draft"

    db.commit()
    return {"deleted": deleted_count}


@router.post("/plans/{plan_id}/boxes")
def add_box(plan_id: int, body: BoxCreate, db: Session = Depends(get_db)):
    plan = db.query(models.FulfillmentPlan).filter(models.FulfillmentPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    box = models.FulfillmentBox(
        plan_id=plan_id,
        box_number=_next_box_number(plan_id, db),
        status="pending",
        notes=body.notes,
        box_type_id=body.box_type_id,
    )
    db.add(box)
    db.commit()
    db.refresh(box)
    return {**_row(box), "items": []}


@router.put("/plans/{plan_id}/boxes/{box_id}")
def update_box(plan_id: int, box_id: int, body: BoxUpdate, db: Session = Depends(get_db)):
    box = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.id == box_id,
        models.FulfillmentBox.plan_id == plan_id,
    ).first()
    if not box:
        raise HTTPException(status_code=404, detail="Box not found")
    if body.status is not None:
        box.status = body.status
        if body.status == "shipped" and not box.shipped_at:
            box.shipped_at = datetime.now(timezone.utc)
            _snapshot_box_costs(box, db)
    if body.notes is not None:
        box.notes = body.notes
    if body.carrier is not None:
        box.carrier = body.carrier
    if body.box_type_id is not None:
        box.box_type_id = body.box_type_id
    db.commit()
    db.refresh(box)
    items = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).all()
    return {**_row(box), "items": [_row(i) for i in items]}


@router.delete("/plans/{plan_id}/boxes/{box_id}")
def delete_box(plan_id: int, box_id: int, db: Session = Depends(get_db)):
    box = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.id == box_id,
        models.FulfillmentBox.plan_id == plan_id,
    ).first()
    if not box:
        raise HTTPException(status_code=404, detail="Box not found")

    if box.shipstation_order_id:
        # Box was pushed to ShipStation — cancel it there, then soft-cancel here
        try:
            shipstation_service.cancel_order(box.shipstation_order_id)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"ShipStation cancel failed: {str(e)}")
        box.status = "cancelled"
    else:
        # Never pushed — hard delete items and box
        db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box_id).delete()
        db.delete(box)

    db.flush()

    # If no active boxes remain, revert plan to draft so auto-plan can re-run
    active_boxes = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.plan_id == plan_id,
        models.FulfillmentBox.status != "cancelled",
    ).count()

    plan = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.id == plan_id
    ).first()

    if active_boxes == 0 and plan:
        plan.status = "draft"
        # Restore inventory and reset order status if this was the last box
        if plan.shopify_order_id:
            order = db.query(models.ShopifyOrder).filter(
                models.ShopifyOrder.shopify_order_id == plan.shopify_order_id
            ).first()
            if order and order.app_status in ("in_shipstation_not_shipped", "staged"):
                from routers.inventory import _restore_inventory_on_cancel, _recompute_committed
                _restore_inventory_on_cancel(order, db)
                order.app_status = "not_processed"
                db.flush()
                _recompute_committed(order.assigned_warehouse, db)

    db.commit()

    if box.shipstation_order_id:
        db.refresh(box)
        items_out = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box_id).all()
        return {**_row(box), "items": [_row(i) for i in items_out]}
    return {"deleted": True}


# ── Box Items ─────────────────────────────────────────────────────────────────

@router.put("/plans/{plan_id}/boxes/{box_id}/items")
def set_box_items(plan_id: int, box_id: int, body: BoxItemsSet, db: Session = Depends(get_db)):
    """Replace all items in a box with the provided list."""
    box = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.id == box_id,
        models.FulfillmentBox.plan_id == plan_id,
    ).first()
    if not box:
        raise HTTPException(status_code=404, detail="Box not found")
    if box.status == "shipped":
        raise HTTPException(status_code=409, detail="Cannot modify items in a shipped box")

    db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box_id).delete()

    for item in body.items:
        if not item.get("pick_sku") or item.get("quantity") is None:
            continue
        db.add(models.BoxLineItem(
            box_id=box_id,
            pick_sku=item["pick_sku"],
            shopify_sku=item.get("shopify_sku"),
            product_title=item.get("product_title"),
            shopify_line_item_id=item.get("shopify_line_item_id"),
            quantity=float(item["quantity"]),
        ))

    # Manually editing a box activates the plan
    plan = db.query(models.FulfillmentPlan).filter(models.FulfillmentPlan.id == plan_id).first()
    if plan and plan.status == "draft":
        plan.status = "active"

    db.commit()
    items = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box_id).all()
    return [_row(i) for i in items]


# ── Push box to ShipStation ───────────────────────────────────────────────────

@router.post("/plans/{plan_id}/boxes/{box_id}/push")
def push_box(plan_id: int, box_id: int, db: Session = Depends(get_db)):
    """Push this box as a separate ShipStation order."""
    if not shipstation_service.is_configured():
        raise HTTPException(status_code=503, detail="ShipStation not configured")

    plan = db.query(models.FulfillmentPlan).filter(models.FulfillmentPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    box = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.id == box_id,
        models.FulfillmentBox.plan_id == plan_id,
    ).first()
    if not box:
        raise HTTPException(status_code=404, detail="Box not found")

    items = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box_id).all()
    if not items:
        raise HTTPException(status_code=400, detail="Box has no items — add items before pushing")

    order = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.shopify_order_id == plan.shopify_order_id
    ).first()

    if order and order.app_status not in ("staged", "in_shipstation_not_shipped"):
        raise HTTPException(
            status_code=409,
            detail=f"Order is '{order.app_status}' — must be staged before pushing boxes to ShipStation"
        )

    # Check negative inventory balance before push
    if order:
        box_demand: dict[str, float] = {}
        for item in items:
            box_demand[item.pick_sku] = box_demand.get(item.pick_sku, 0.0) + item.quantity
        from models import InventoryItem
        negative_skus = []
        for pick_sku, qty_needed in box_demand.items():
            inv = db.query(InventoryItem).filter(
                InventoryItem.pick_sku == pick_sku,
                InventoryItem.warehouse == order.assigned_warehouse,
            ).first()
            on_hand = inv.on_hand_qty if inv else 0.0
            if on_hand - qty_needed < 0:
                negative_skus.append(f"{pick_sku} (have {on_hand:.1f}, need {qty_needed:.1f})")
        if negative_skus:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot push: shipping this box would result in negative inventory for: {', '.join(negative_skus)}"
            )

    # Look up box type for package code, dimensions, and tare weight
    box_type = None
    if box.box_type_id:
        box_type = db.query(models.BoxType).filter(models.BoxType.id == box.box_type_id).first()

    # Calculate total shipment weight in oz:
    # Try SkuMapping.pick_weight_lb first, fall back to PicklistSku.weight_lb
    total_weight_oz = 0.0
    for item in items:
        weight_lb_per_unit = None
        sku_map = db.query(models.SkuMapping).filter(
            models.SkuMapping.pick_sku == item.pick_sku
        ).first()
        if sku_map and sku_map.pick_weight_lb:
            weight_lb_per_unit = sku_map.pick_weight_lb
        else:
            pl_sku = db.query(models.PicklistSku).filter(
                models.PicklistSku.pick_sku == item.pick_sku
            ).first()
            if pl_sku and pl_sku.weight_lb:
                weight_lb_per_unit = pl_sku.weight_lb
        if weight_lb_per_unit:
            total_weight_oz += weight_lb_per_unit * item.quantity * 16.0
    if box_type and box_type.weight_oz:
        total_weight_oz += box_type.weight_oz

    # Evaluate carrier service rules for this order
    carrier_match = _apply_carrier_service_rules(order, db) if order else None

    try:
        ss_result = shipstation_service.push_box(
            order, box.box_number, items,
            weight_oz=total_weight_oz if total_weight_oz > 0 else None,
            box_type=box_type,
            carrier_code=carrier_match.get("carrier_code") if carrier_match else None,
            service_code=carrier_match.get("service_code") if carrier_match else None,
            shipping_provider_id=carrier_match.get("shipping_provider_id") if carrier_match else None,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ShipStation error: {str(e)}")

    box.shipstation_order_id = str(ss_result.get("orderId", ""))
    box.shipstation_order_key = ss_result.get("orderKey", "")
    box.status = "packed"

    if order and order.app_status == "staged":
        order.app_status = "in_shipstation_not_shipped"
        db.flush()
        from routers.inventory import _auto_deduct_on_ship, _recompute_committed
        _auto_deduct_on_ship(order, db)
        _recompute_committed(order.assigned_warehouse, db)

    if plan.status == "draft":
        plan.status = "active"

    db.commit()
    db.refresh(box)
    items_out = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box_id).all()
    return {**_row(box), "items": [_row(i) for i in items_out]}


# ── Sync boxes with ShipStation ───────────────────────────────────────────────

def _compute_box_shopify_qtys(
    box_items: list,
    shopify_order_id: str,
    db: Session,
) -> dict:
    """
    Returns {shopify_line_item_id: shopify_qty_in_this_box} for all line items in a box.

    BoxLineItem.quantity is in pick units. ShopifyLineItem.mix_quantity is pick units
    per Shopify order unit for a given pick_sku. We divide to get per-box Shopify qty.
    """
    # Group box items by shopify_line_item_id; pick any one pick_sku representative
    li_to_qty_and_sku: dict = {}
    for bi in box_items:
        if not bi.shopify_line_item_id:
            continue
        li_id = str(bi.shopify_line_item_id)
        if li_id not in li_to_qty_and_sku and bi.pick_sku:
            li_to_qty_and_sku[li_id] = (bi.quantity, bi.pick_sku)

    result: dict = {}
    for li_id, (pick_qty, pick_sku) in li_to_qty_and_sku.items():
        sli = db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == shopify_order_id,
            models.ShopifyLineItem.line_item_id == li_id,
            models.ShopifyLineItem.pick_sku == pick_sku,
        ).first()
        mix_qty = (sli.mix_quantity or 1.0) if sli else 1.0
        shopify_qty = max(1, round(pick_qty / mix_qty))
        result[li_id] = shopify_qty

    return result


def _snapshot_box_costs(box, db: Session):
    """
    Freeze shipping, packaging, and per-SKU cost data onto a box and its line
    items at ship time so that the fulfilled GM% is immune to future rate/cost
    changes.
    """
    from routers.orders import _estimate_box_shipping

    # ── Shipping cost snapshot ───────────────────────────────────────────────
    if box.shipping_cost_snapshot is None:
        plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.id == box.plan_id
        ).first()
        order = None
        if plan:
            order = db.query(models.ShopifyOrder).filter(
                models.ShopifyOrder.shopify_order_id == plan.shopify_order_id
            ).first()
        if order:
            box_type = (
                db.query(models.BoxType).filter(models.BoxType.id == box.box_type_id).first()
                if box.box_type_id else None
            )
            carrier_match = _apply_carrier_service_rules(order, db)
            zone = _zone_for_zip(order.shipping_zip)
            est = _estimate_box_shipping(box, box_type, order, carrier_match, zone, db)
            if est.get("rate") is not None:
                box.shipping_cost_snapshot = round(est["rate"], 2)

    # ── Packaging cost snapshot ──────────────────────────────────────────────
    if box.packaging_cost_snapshot is None and box.box_type_id:
        btps = db.query(models.BoxTypePackaging).filter(
            models.BoxTypePackaging.box_type_id == box.box_type_id
        ).all()
        pkg_cost = 0.0
        for btp in btps:
            mat = db.query(models.PackagingMaterial).filter(
                models.PackagingMaterial.id == btp.packaging_material_id
            ).first()
            if mat:
                pkg_cost += mat.unit_cost * btp.quantity
        box.packaging_cost_snapshot = round(pkg_cost, 2)

    # ── Per-line-item cost snapshots ─────────────────────────────────────────
    items = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).all()
    picklist_map = {r.pick_sku: r for r in db.query(models.PicklistSku).all()}
    for item in items:
        if item.cost_per_lb_snapshot is not None and item.weight_lb_snapshot is not None:
            continue
        sku_rec = picklist_map.get(item.pick_sku)
        if not sku_rec:
            continue
        if item.weight_lb_snapshot is None and sku_rec.weight_lb is not None:
            item.weight_lb_snapshot = sku_rec.weight_lb
        if item.cost_per_lb_snapshot is None:
            cost_per_lb = sku_rec.cost_per_lb
            if cost_per_lb is None and sku_rec.cost_per_case is not None and sku_rec.case_weight_lb:
                cost_per_lb = sku_rec.cost_per_case / sku_rec.case_weight_lb
            if cost_per_lb is not None:
                item.cost_per_lb_snapshot = round(cost_per_lb, 4)


@router.post("/sync")
def sync_boxes(db: Session = Depends(get_db)):
    """
    Poll ShipStation for tracking updates on all packed (not yet shipped) boxes.

    For each box that has shipped:
      1. Record tracking number, carrier, and estimated delivery.
      2. Create a Shopify fulfillment for the line items in that box with the
         box's tracking number (multi-box: each box gets its own fulfillment).
      3. After all boxes for an order are shipped, mark the order as
         in_shipstation_shipped and deduct inventory (if not already done).
    """
    if not shipstation_service.is_configured():
        raise HTTPException(status_code=503, detail="ShipStation not configured")

    boxes = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.status == "packed",
        models.FulfillmentBox.shipstation_order_id.isnot(None),
    ).all()

    print(f"[sync_boxes] Found {len(boxes)} packed boxes: {[(b.id, b.shipstation_order_id) for b in boxes]}")

    synced = 0
    shipped = 0
    shopify_fulfillments_created = 0
    errors = []
    shipped_plan_ids: set = set()
    fulfillment_created_order_ids: set = set()  # orders where a Shopify fulfillment was created this run
    shipments: list = []

    if boxes:
        ss_order_ids = [b.shipstation_order_id for b in boxes]
        id_to_box = {b.shipstation_order_id: b for b in boxes}

        try:
            shipments = shipstation_service.get_shipments(ss_order_ids)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"ShipStation error: {str(e)}")

        print(f"[sync_boxes] ShipStation returned {len(shipments)} shipments: {[(s.get('orderId'), s.get('trackingNumber'), s.get('voided')) for s in shipments]}")

    for shipment in shipments:
        ss_order_id = str(shipment.get("orderId", ""))
        box = id_to_box.get(ss_order_id)
        if not box or shipment.get("voided", False):
            continue
        try:
            box.status = "shipped"
            box.shipped_at = datetime.now(timezone.utc)
            _snapshot_box_costs(box, db)
            tracking = shipment.get("trackingNumber")
            carrier = shipment.get("carrierCode")
            if tracking:
                box.tracking_number = tracking
            if carrier:
                box.carrier = carrier
            estimated_delivery = shipment.get("estimatedDeliveryDate")
            if estimated_delivery:
                try:
                    box.estimated_delivery_date = datetime.fromisoformat(
                        estimated_delivery.replace("Z", "+00:00")
                    )
                except (ValueError, AttributeError):
                    pass

            # ── Create Shopify fulfillment for this box's line items ──────────
            if tracking and shopify_service.is_configured():
                try:
                    db.flush()  # ensure box changes are visible for queries below

                    # Get the Shopify order ID from the plan
                    plan = db.query(models.FulfillmentPlan).filter(
                        models.FulfillmentPlan.id == box.plan_id
                    ).first()
                    shopify_order = (
                        db.query(models.ShopifyOrder).filter(
                            models.ShopifyOrder.shopify_order_id == plan.shopify_order_id
                        ).first()
                        if plan else None
                    )

                    if plan and shopify_order:
                        # Collect Shopify line_item_ids for all items in this box.
                        # BoxLineItem.shopify_line_item_id is the canonical source.
                        # Fallback: match box shopify_sku → ShopifyLineItem.line_item_id
                        box_items = db.query(models.BoxLineItem).filter(
                            models.BoxLineItem.box_id == box.id
                        ).all()

                        li_ids: list[str] = []
                        for bi in box_items:
                            if bi.shopify_line_item_id:
                                li_ids.append(str(bi.shopify_line_item_id))
                            elif bi.shopify_sku:
                                # Fallback: find line item on this order by shopify_sku
                                matched_lis = db.query(models.ShopifyLineItem).filter(
                                    models.ShopifyLineItem.shopify_order_id == shopify_order.shopify_order_id,
                                    models.ShopifyLineItem.shopify_sku == bi.shopify_sku,
                                ).all()
                                for mli in matched_lis:
                                    if mli.line_item_id and mli.line_item_id not in li_ids:
                                        li_ids.append(str(mli.line_item_id))

                        if li_ids:
                            box_qtys = _compute_box_shopify_qtys(
                                box_items, shopify_order.shopify_order_id, db
                            )
                            result = shopify_service.create_fulfillment_for_box(
                                shopify_order_id=shopify_order.shopify_order_id,
                                shopify_line_item_ids=li_ids,
                                tracking_number=tracking,
                                carrier_code=carrier,
                                notify_customer=True,
                                line_item_quantities=box_qtys,
                            )
                            if result:
                                shopify_fulfillments_created += 1
                                box.status = "fulfilled"

                        shipped_plan_ids.add(box.plan_id)

                except Exception as e:
                    errors.append(f"Box {box.id} Shopify fulfillment: {str(e)}")

            shipped += 1
        except Exception as e:
            errors.append(f"Box {box.id}: {str(e)}")
        synced += 1

    db.flush()

    # ── After sync: mark orders as shipped if ALL their boxes are now shipped ──
    from routers.inventory import _auto_deduct_on_ship, _recompute_committed
    affected_warehouses: set = set()

    for plan_id in shipped_plan_ids:
        plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.id == plan_id
        ).first()
        if not plan:
            continue

        # Count non-cancelled boxes that are not yet shipped/fulfilled
        remaining = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan_id,
            models.FulfillmentBox.status.notin_(["shipped", "fulfilled", "cancelled"]),
        ).count()

        if remaining == 0:
            # All boxes shipped — transition order status
            order = db.query(models.ShopifyOrder).filter(
                models.ShopifyOrder.shopify_order_id == plan.shopify_order_id
            ).first()
            if order and order.app_status not in ("in_shipstation_shipped", "fulfilled"):
                order.app_status = "in_shipstation_shipped"
                order.last_synced_at = datetime.now(timezone.utc)
                # Deduct inventory (for multi-box flow where push_box doesn't deduct)
                existing_deductions = db.query(models.InventoryAdjustment).filter(
                    models.InventoryAdjustment.shopify_order_id == order.shopify_order_id,
                    models.InventoryAdjustment.adjustment_type == "ship_deduct",
                ).count()
                if existing_deductions == 0:
                    _auto_deduct_on_ship(order, db)
                if order.assigned_warehouse:
                    affected_warehouses.add(order.assigned_warehouse)

    for wh in affected_warehouses:
        _recompute_committed(wh, db)

    db.commit()

    # ── Second pass: retry Shopify fulfillments for shipped boxes that may have
    # failed previously. Optimized: check fulfillable quantities per-order first
    # to avoid redundant Shopify API calls for already-fulfilled items. ──────
    print(f"[sync_boxes] Shopify configured: {shopify_service.is_configured()}")
    if shopify_service.is_configured():
        retry_cutoff = datetime.now(timezone.utc) - timedelta(days=14)
        shipped_boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.status == "shipped",
            models.FulfillmentBox.tracking_number.isnot(None),
            models.FulfillmentBox.shipped_at >= retry_cutoff,
        ).all()
        print(f"[sync_boxes] retry pass: {len(shipped_boxes)} shipped boxes with tracking (last 14 days)")

        # Group shipped boxes by order to minimize Shopify API calls
        order_boxes: dict = {}  # shopify_order_id → [(box, plan, shopify_order)]
        for box in shipped_boxes:
            try:
                plan = db.query(models.FulfillmentPlan).filter(
                    models.FulfillmentPlan.id == box.plan_id
                ).first()
                shopify_order = (
                    db.query(models.ShopifyOrder).filter(
                        models.ShopifyOrder.shopify_order_id == plan.shopify_order_id
                    ).first() if plan else None
                )
                if not plan or not shopify_order:
                    continue
                order_boxes.setdefault(shopify_order.shopify_order_id, []).append(
                    (box, plan, shopify_order)
                )
            except Exception as e:
                errors.append(f"Box {box.id} Shopify retry lookup: {str(e)}")

        for order_id, box_group in order_boxes.items():
            try:
                # Check fulfillable quantities once per order instead of per box
                fresh_qtys = shopify_service.get_order_fulfillable_qtys(order_id)
                all_fulfilled = all(qty == 0 for qty in fresh_qtys.values())

                if all_fulfilled:
                    # Items already fulfilled in Shopify — mark boxes without extra API calls
                    for box, _plan, _so in box_group:
                        box.status = "fulfilled"
                    fulfillment_created_order_ids.add(order_id)
                    print(f"[sync_boxes] retry pass: order {order_id} fully fulfilled in Shopify, marked {len(box_group)} boxes")
                    continue

                # Some items still need fulfillment — attempt per-box
                for box, plan, shopify_order in box_group:
                    try:
                        box_items = db.query(models.BoxLineItem).filter(
                            models.BoxLineItem.box_id == box.id
                        ).all()
                        li_ids = []
                        for bi in box_items:
                            if bi.shopify_line_item_id:
                                li_ids.append(str(bi.shopify_line_item_id))
                            elif bi.shopify_sku:
                                matched_lis = db.query(models.ShopifyLineItem).filter(
                                    models.ShopifyLineItem.shopify_order_id == shopify_order.shopify_order_id,
                                    models.ShopifyLineItem.shopify_sku == bi.shopify_sku,
                                ).all()
                                for mli in matched_lis:
                                    if mli.line_item_id and mli.line_item_id not in li_ids:
                                        li_ids.append(str(mli.line_item_id))

                        if li_ids:
                            # Skip boxes whose items are already fulfilled
                            box_items_fulfilled = all(
                                fresh_qtys.get(li_id, 0) == 0 for li_id in li_ids
                            )
                            if box_items_fulfilled:
                                box.status = "fulfilled"
                                fulfillment_created_order_ids.add(order_id)
                                continue

                            box_qtys = _compute_box_shopify_qtys(
                                box_items, shopify_order.shopify_order_id, db
                            )
                            result = shopify_service.create_fulfillment_for_box(
                                shopify_order_id=shopify_order.shopify_order_id,
                                shopify_line_item_ids=li_ids,
                                tracking_number=box.tracking_number,
                                carrier_code=box.carrier,
                                notify_customer=True,
                                line_item_quantities=box_qtys,
                            )
                            if result:
                                shopify_fulfillments_created += 1
                                box.status = "fulfilled"
                                fulfillment_created_order_ids.add(order_id)
                    except Exception as e:
                        errors.append(f"Box {box.id} Shopify retry: {str(e)}")
            except Exception as e:
                errors.append(f"Order {order_id} fulfillable qty check: {str(e)}")

    # ── Third pass: re-fetch tracking for shipped-but-no-tracking boxes ─────────
    # These boxes were marked shipped in a prior sync when ShipStation hadn't yet
    # returned a tracking number. Re-query ShipStation now and, if tracking arrived,
    # save it and create the Shopify fulfillment.
    if shipstation_service.is_configured():
        no_tracking_boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.status == "shipped",
            models.FulfillmentBox.tracking_number.is_(None),
            models.FulfillmentBox.shipstation_order_id.isnot(None),
        ).all()
        if no_tracking_boxes:
            print(f"[sync_boxes] third pass: {len(no_tracking_boxes)} shipped boxes without tracking")
            nt_ss_ids = [b.shipstation_order_id for b in no_tracking_boxes]
            try:
                nt_shipments = shipstation_service.get_shipments(nt_ss_ids)
            except Exception as e:
                errors.append(f"ShipStation re-fetch for no-tracking boxes: {str(e)}")
                nt_shipments = []

            nt_id_to_box = {b.shipstation_order_id: b for b in no_tracking_boxes}
            for shipment in nt_shipments:
                ss_order_id = str(shipment.get("orderId", ""))
                box = nt_id_to_box.get(ss_order_id)
                if not box or shipment.get("voided", False):
                    continue
                tracking = shipment.get("trackingNumber")
                carrier = shipment.get("carrierCode")
                if not tracking:
                    continue
                box.tracking_number = tracking
                if carrier:
                    box.carrier = carrier
                db.flush()

                if shopify_service.is_configured():
                    try:
                        plan = db.query(models.FulfillmentPlan).filter(
                            models.FulfillmentPlan.id == box.plan_id
                        ).first()
                        shopify_order = (
                            db.query(models.ShopifyOrder).filter(
                                models.ShopifyOrder.shopify_order_id == plan.shopify_order_id
                            ).first() if plan else None
                        )
                        if plan and shopify_order:
                            box_items = db.query(models.BoxLineItem).filter(
                                models.BoxLineItem.box_id == box.id
                            ).all()
                            li_ids = []
                            for bi in box_items:
                                if bi.shopify_line_item_id:
                                    li_ids.append(str(bi.shopify_line_item_id))
                                elif bi.shopify_sku:
                                    matched_lis = db.query(models.ShopifyLineItem).filter(
                                        models.ShopifyLineItem.shopify_order_id == shopify_order.shopify_order_id,
                                        models.ShopifyLineItem.shopify_sku == bi.shopify_sku,
                                    ).all()
                                    for mli in matched_lis:
                                        if mli.line_item_id and mli.line_item_id not in li_ids:
                                            li_ids.append(str(mli.line_item_id))
                            if li_ids:
                                box_qtys = _compute_box_shopify_qtys(
                                    box_items, shopify_order.shopify_order_id, db
                                )
                                result = shopify_service.create_fulfillment_for_box(
                                    shopify_order_id=shopify_order.shopify_order_id,
                                    shopify_line_item_ids=li_ids,
                                    tracking_number=tracking,
                                    carrier_code=carrier,
                                    notify_customer=True,
                                    line_item_quantities=box_qtys,
                                )
                                if result:
                                    shopify_fulfillments_created += 1
                                    box.status = "fulfilled"
                                    print(f"[sync_boxes] third pass: fulfillment created for box {box.id}, tracking={tracking}")
                                    fulfillment_created_order_ids.add(shopify_order.shopify_order_id)
                    except Exception as e:
                        errors.append(f"Box {box.id} Shopify third-pass: {str(e)}")

        db.commit()

    # ── Refresh fulfillable_quantity for orders where Shopify fulfillments were created ─
    # After creating Shopify fulfillments, sync local fulfillable_quantity from Shopify
    # so the UI shows correct remaining quantities and order status transitions correctly.
    # Only touches orders that actually had fulfillments created this run to avoid
    # mass-updating unrelated orders.
    if shopify_service.is_configured():
        # Orders that had boxes ship in this run (Pass 1) + orders with fulfillments created (Pass 2/3)
        refresh_ids: set = set()
        for plan_id in shipped_plan_ids:
            p = db.query(models.FulfillmentPlan).filter(models.FulfillmentPlan.id == plan_id).first()
            if p:
                refresh_ids.add(p.shopify_order_id)
        refresh_ids |= fulfillment_created_order_ids

        # Include all in_shipstation_shipped orders — they may have been
        # fulfilled outside this sync run and need their status checked
        shipped_rows = db.query(models.ShopifyOrder.shopify_order_id).filter(
            models.ShopifyOrder.app_status == "in_shipstation_shipped",
        ).all()
        refresh_ids |= {row[0] for row in shipped_rows}

        for order_id in refresh_ids:
            try:
                fresh_qtys = shopify_service.get_order_fulfillable_qtys(order_id)
                for li in db.query(models.ShopifyLineItem).filter(
                    models.ShopifyLineItem.shopify_order_id == order_id
                ).all():
                    # Missing from fresh_qtys means fully fulfilled (qty 0)
                    li.fulfillable_quantity = fresh_qtys.get(li.line_item_id, 0)
                db.flush()

                still_needed = db.query(models.ShopifyLineItem).filter(
                    models.ShopifyLineItem.shopify_order_id == order_id,
                    models.ShopifyLineItem.sku_mapped == True,
                    models.ShopifyLineItem.pick_sku.isnot(None),
                    models.ShopifyLineItem.fulfillable_quantity > 0,
                    or_(
                        models.ShopifyLineItem.app_line_status != "short_ship",
                        models.ShopifyLineItem.app_line_status.is_(None),
                    ),
                ).count()

                order = db.query(models.ShopifyOrder).filter(
                    models.ShopifyOrder.shopify_order_id == order_id
                ).first()
                if order:
                    has_pending_boxes = db.query(models.FulfillmentBox).join(
                        models.FulfillmentPlan,
                        models.FulfillmentPlan.id == models.FulfillmentBox.plan_id,
                    ).filter(
                        models.FulfillmentPlan.shopify_order_id == order_id,
                        models.FulfillmentPlan.status != "cancelled",
                        models.FulfillmentBox.status != "cancelled",
                        models.FulfillmentBox.status != "shipped",
                        models.FulfillmentBox.status != "fulfilled",
                    ).count() > 0
                    if still_needed == 0 and not has_pending_boxes:
                        order.app_status = "fulfilled"
                    elif order.app_status != "fulfilled":
                        order.app_status = "partially_fulfilled"
            except Exception as e:
                errors.append(f"Order {order_id} fulfillable refresh: {str(e)}")

        db.commit()

    return {
        "synced": synced,
        "shipped": shipped,
        "shopify_fulfillments": shopify_fulfillments_created,
        "errors": errors,
    }


# ── Bulk push plan boxes ──────────────────────────────────────────────────────

class BulkPushRequest(BaseModel):
    order_ids: List[str]


@router.delete("/bulk-reset-unpushed")
def bulk_reset_unpushed_boxes(db: Session = Depends(get_db)):
    """Hard-delete all pending (never-pushed) boxes across every fulfillment plan."""
    unpushed = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.shipstation_order_id == None,
        models.FulfillmentBox.status == "pending",
    ).all()

    affected_plan_ids = {box.plan_id for box in unpushed}
    deleted_count = 0
    for box in unpushed:
        db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).delete()
        db.delete(box)
        deleted_count += 1

    db.flush()

    # Revert any plans that now have no active boxes back to draft
    for plan_id in affected_plan_ids:
        active = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan_id,
            models.FulfillmentBox.status != "cancelled",
        ).count()
        if active == 0:
            plan = db.query(models.FulfillmentPlan).filter(
                models.FulfillmentPlan.id == plan_id
            ).first()
            if plan:
                plan.status = "draft"

    db.commit()
    return {"deleted": deleted_count, "plans_affected": len(affected_plan_ids)}


@router.delete("/bulk-reset-unpushed-by-orders")
def bulk_reset_unpushed_by_orders(body: BulkPushRequest, db: Session = Depends(get_db)):
    """Hard-delete all pending (never-pushed) boxes for the given Shopify order IDs."""
    plans = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.shopify_order_id.in_(body.order_ids)
    ).all()

    plan_ids = [p.id for p in plans]
    if not plan_ids:
        return {"deleted": 0, "plans_affected": 0}

    unpushed = db.query(models.FulfillmentBox).filter(
        models.FulfillmentBox.plan_id.in_(plan_ids),
        models.FulfillmentBox.shipstation_order_id == None,
        models.FulfillmentBox.status == "pending",
    ).all()

    affected_plan_ids = {box.plan_id for box in unpushed}
    deleted_count = 0
    for box in unpushed:
        db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).delete()
        db.delete(box)
        deleted_count += 1

    db.flush()

    for plan_id in affected_plan_ids:
        active = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan_id,
            models.FulfillmentBox.status != "cancelled",
        ).count()
        if active == 0:
            plan = db.query(models.FulfillmentPlan).filter(
                models.FulfillmentPlan.id == plan_id
            ).first()
            if plan:
                plan.status = "draft"

    db.commit()
    return {"deleted": deleted_count, "plans_affected": len(affected_plan_ids)}


@router.post("/bulk-push-stream")
def bulk_push_stream(body: BulkPushRequest, db: Session = Depends(get_db)):
    """
    Push multiple orders' boxes to ShipStation in a background thread,
    streaming progress via SSE.  The push survives client disconnects —
    reconnect via GET /bulk-push-status/{job_id} to resume watching.

    Rate-limited to ~35 req/60s (under ShipStation's 40-req/60-s cap)
    with automatic retry on 429 errors.

    SSE event types:
      start    → {"total": N, "job_id": "…"}
      progress → {"pushed": P, "failed": F, "total": N, "order_id": "…", "success": bool}
      done     → {"pushed": P, "failed": F, "total": N, "job_id": "…"}
    """
    if not shipstation_service.is_configured():
        raise HTTPException(status_code=503, detail="ShipStation not configured")

    # ── Phase 1: validate all orders & gather push-ready data (DB only) ──────
    validated = []        # list of dicts ready for parallel push
    skip_results = []     # orders that failed validation

    for order_id in body.order_ids:
        plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.shopify_order_id == order_id,
            models.FulfillmentPlan.status.notin_(["cancelled", "completed"]),
        ).first()
        if not plan:
            skip_results.append({"order_id": order_id, "success": False, "error": "No active plan found"})
            continue

        pending_boxes = (
            db.query(models.FulfillmentBox)
            .filter(
                models.FulfillmentBox.plan_id == plan.id,
                models.FulfillmentBox.status == "pending",
            )
            .order_by(models.FulfillmentBox.box_number)
            .all()
        )
        if not pending_boxes:
            skip_results.append({"order_id": order_id, "success": False, "error": "No pending boxes to push"})
            continue

        order = db.query(models.ShopifyOrder).filter(
            models.ShopifyOrder.shopify_order_id == order_id
        ).first()
        if order and order.app_status not in ("staged", "in_shipstation_not_shipped"):
            skip_results.append({
                "order_id": order_id, "success": False,
                "error": f"Order is '{order.app_status}' — must be staged before pushing to ShipStation",
            })
            continue

        carrier_match = _apply_carrier_service_rules(order, db) if order else None

        box_tasks = []
        order_skipped = False
        for box in pending_boxes:
            items = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).all()
            if not items:
                continue

            box_type = None
            if box.box_type_id:
                box_type = db.query(models.BoxType).filter(models.BoxType.id == box.box_type_id).first()

            total_weight_oz = 0.0
            for item in items:
                weight_lb_per_unit = None
                sku_map = db.query(models.SkuMapping).filter(
                    models.SkuMapping.pick_sku == item.pick_sku
                ).first()
                if sku_map and sku_map.pick_weight_lb:
                    weight_lb_per_unit = sku_map.pick_weight_lb
                else:
                    pl_sku = db.query(models.PicklistSku).filter(
                        models.PicklistSku.pick_sku == item.pick_sku
                    ).first()
                    if pl_sku and pl_sku.weight_lb:
                        weight_lb_per_unit = pl_sku.weight_lb
                if weight_lb_per_unit:
                    total_weight_oz += weight_lb_per_unit * item.quantity * 16.0
            if box_type and box_type.weight_oz:
                total_weight_oz += box_type.weight_oz

            # Inventory check
            if order:
                box_demand_check: dict = {}
                for item in items:
                    if item.pick_sku:
                        box_demand_check[item.pick_sku] = box_demand_check.get(item.pick_sku, 0.0) + item.quantity
                short_skus = []
                for pick_sku, qty_needed in box_demand_check.items():
                    inv = db.query(models.InventoryItem).filter(
                        models.InventoryItem.pick_sku == pick_sku,
                        models.InventoryItem.warehouse == order.assigned_warehouse,
                    ).first()
                    on_hand = inv.on_hand_qty if inv else 0.0
                    if on_hand < qty_needed:
                        short_skus.append(f"{pick_sku} (have {on_hand:.1f}, need {qty_needed:.1f})")
                if short_skus:
                    skip_results.append({
                        "order_id": order_id, "success": False,
                        "error": f"Insufficient inventory — {', '.join(short_skus)}",
                    })
                    order_skipped = True
                    break

            box_tasks.append({
                "box": box,
                "items": items,
                "weight_oz": total_weight_oz if total_weight_oz > 0 else None,
                "box_type": box_type,
                "carrier_code": carrier_match.get("carrier_code") if carrier_match else None,
                "service_code": carrier_match.get("service_code") if carrier_match else None,
                "shipping_provider_id": carrier_match.get("shipping_provider_id") if carrier_match else None,
            })

        if order_skipped:
            continue

        if not box_tasks:
            skip_results.append({"order_id": order_id, "success": False, "error": "No pushable boxes"})
            continue

        validated.append({
            "order_id": order_id,
            "order": order,
            "plan": plan,
            "box_tasks": box_tasks,
        })

    total_orders = len(validated) + len(skip_results)

    # ── Phase 2: launch background push thread ──────────────────────────────

    _cleanup_old_jobs()
    job_id = uuid.uuid4().hex[:8]
    job = {
        "status": "running",
        "pushed": 0,
        "failed": len(skip_results),
        "total": total_orders,
        "progress_log": [],       # list of {order_id, success, error?}
        "started_at": time.time(),
    }
    _push_jobs[job_id] = job

    def _push_one_box(order, bt):
        """Push a single box with rate limiting and retry on 429."""
        max_retries = 3
        for attempt in range(max_retries):
            _ss_rate_wait()
            try:
                ss_result = shipstation_service.push_box(
                    order, bt["box"].box_number, bt["items"],
                    weight_oz=bt["weight_oz"],
                    box_type=bt["box_type"],
                    carrier_code=bt["carrier_code"],
                    service_code=bt["service_code"],
                    shipping_provider_id=bt.get("shipping_provider_id"),
                )
                return {"box_id": bt["box"].id, "success": True, "ss_result": ss_result}
            except Exception as e:
                err_str = str(e)
                if "429" in err_str and attempt < max_retries - 1:
                    time.sleep(5 * (attempt + 1))
                    continue
                return {"box_id": bt["box"].id, "success": False, "error": err_str}

    def _push_one_order(entry):
        results = []
        for bt in entry["box_tasks"]:
            results.append(_push_one_box(entry["order"], bt))
        return entry, results

    def _run_push():
        """Background thread — pushes orders and updates DB."""
        try:
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = {pool.submit(_push_one_order, entry): entry for entry in validated}
                for future in as_completed(futures):
                    entry, box_results = future.result()
                    order_id = entry["order_id"]

                    boxes_pushed = sum(1 for r in box_results if r["success"])
                    boxes_failed = sum(1 for r in box_results if not r["success"])

                    gen_db = SessionLocal()
                    try:
                        order = gen_db.query(models.ShopifyOrder).filter(
                            models.ShopifyOrder.shopify_order_id == order_id
                        ).first()
                        plan = gen_db.query(models.FulfillmentPlan).filter(
                            models.FulfillmentPlan.shopify_order_id == order_id,
                            models.FulfillmentPlan.status.notin_(["cancelled", "completed"]),
                        ).first()

                        for br in box_results:
                            if br["success"]:
                                box = gen_db.query(models.FulfillmentBox).filter(
                                    models.FulfillmentBox.id == br["box_id"]
                                ).first()
                                if box:
                                    box.shipstation_order_id = str(br["ss_result"].get("orderId", ""))
                                    box.shipstation_order_key = br["ss_result"].get("orderKey", "")
                                    box.status = "packed"

                        if boxes_pushed > 0 and plan and plan.status == "draft":
                            plan.status = "active"

                        if boxes_pushed > 0 and order and order.app_status == "staged":
                            order.app_status = "in_shipstation_not_shipped"
                            gen_db.flush()
                            from routers.inventory import _auto_deduct_on_ship, _recompute_committed as _rc
                            _auto_deduct_on_ship(order, gen_db)
                            _rc(order.assigned_warehouse, gen_db)

                        gen_db.commit()
                    finally:
                        gen_db.close()

                    success = boxes_failed == 0 and boxes_pushed > 0
                    if success:
                        job["pushed"] += 1
                    else:
                        job["failed"] += 1

                    job["progress_log"].append({
                        "order_id": order_id,
                        "success": success,
                        **({"error": box_results[0].get("error")} if not success and box_results else {}),
                    })
        except Exception as e:
            print(f"[bulk-push] background thread error: {e}")
        finally:
            job["status"] = "done"

    bg_thread = threading.Thread(target=_run_push, daemon=True)
    bg_thread.start()

    # ── Phase 3: SSE stream reads from job state ─────────────────────────────

    def _sse(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    def generate():
        yield _sse("start", {"total": total_orders, "job_id": job_id})

        # Emit skipped orders immediately
        for sr in skip_results:
            yield _sse("progress", {
                "pushed": job["pushed"], "failed": job["failed"],
                "total": total_orders, "order_id": sr["order_id"],
                "success": False, "error": sr.get("error", "Unknown"),
            })

        # Stream progress from background thread
        last_idx = 0
        while job["status"] == "running":
            while last_idx < len(job["progress_log"]):
                entry = job["progress_log"][last_idx]
                last_idx += 1
                yield _sse("progress", {
                    "pushed": job["pushed"], "failed": job["failed"],
                    "total": total_orders, **entry,
                })
            time.sleep(0.5)

        # Drain any remaining entries
        while last_idx < len(job["progress_log"]):
            entry = job["progress_log"][last_idx]
            last_idx += 1
            yield _sse("progress", {
                "pushed": job["pushed"], "failed": job["failed"],
                "total": total_orders, **entry,
            })

        yield _sse("done", {
            "pushed": job["pushed"], "failed": job["failed"],
            "total": total_orders, "job_id": job_id,
        })

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/bulk-push-status/{job_id}")
def get_push_status(job_id: str):
    """Poll endpoint for push progress — survives page refresh."""
    job = _push_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found or expired")
    return {
        "job_id": job_id,
        "status": job["status"],
        "pushed": job["pushed"],
        "failed": job["failed"],
        "total": job["total"],
    }


@router.post("/bulk-push")
def bulk_push_plans(body: BulkPushRequest, db: Session = Depends(get_db)):
    """
    For each given Shopify order ID, find its active fulfillment plan and push
    all pending boxes to ShipStation. Returns a per-order summary.
    (Legacy non-streaming endpoint — kept as fallback.)
    """
    if not shipstation_service.is_configured():
        raise HTTPException(status_code=503, detail="ShipStation not configured")

    pushed = 0
    failed = 0
    results = []

    for order_id in body.order_ids:
        plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.shopify_order_id == order_id,
            models.FulfillmentPlan.status.notin_(["cancelled", "completed"]),
        ).first()

        if not plan:
            results.append({"order_id": order_id, "success": False, "error": "No active plan found"})
            failed += 1
            continue

        pending_boxes = (
            db.query(models.FulfillmentBox)
            .filter(
                models.FulfillmentBox.plan_id == plan.id,
                models.FulfillmentBox.status == "pending",
            )
            .order_by(models.FulfillmentBox.box_number)
            .all()
        )

        if not pending_boxes:
            results.append({"order_id": order_id, "success": False, "error": "No pending boxes to push"})
            failed += 1
            continue

        order = db.query(models.ShopifyOrder).filter(
            models.ShopifyOrder.shopify_order_id == order_id
        ).first()

        if order and order.app_status not in ("staged", "in_shipstation_not_shipped"):
            results.append({
                "order_id": order_id,
                "success": False,
                "error": f"Order is '{order.app_status}' — must be staged before pushing to ShipStation",
            })
            failed += 1
            continue

        # Evaluate carrier service rules once per order (same for all boxes)
        carrier_match = _apply_carrier_service_rules(order, db) if order else None

        boxes_pushed = 0
        boxes_failed = 0
        box_errors = []

        for box in pending_boxes:
            items = db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).all()
            if not items:
                continue

            box_type = None
            if box.box_type_id:
                box_type = db.query(models.BoxType).filter(models.BoxType.id == box.box_type_id).first()

            total_weight_oz = 0.0
            for item in items:
                weight_lb_per_unit = None
                sku_map = db.query(models.SkuMapping).filter(
                    models.SkuMapping.pick_sku == item.pick_sku
                ).first()
                if sku_map and sku_map.pick_weight_lb:
                    weight_lb_per_unit = sku_map.pick_weight_lb
                else:
                    pl_sku = db.query(models.PicklistSku).filter(
                        models.PicklistSku.pick_sku == item.pick_sku
                    ).first()
                    if pl_sku and pl_sku.weight_lb:
                        weight_lb_per_unit = pl_sku.weight_lb
                if weight_lb_per_unit:
                    total_weight_oz += weight_lb_per_unit * item.quantity * 16.0
            if box_type and box_type.weight_oz:
                total_weight_oz += box_type.weight_oz

            # Inventory check: ensure on_hand supports shipping this box
            if order:
                box_demand_check: dict = {}
                for item in items:
                    if item.pick_sku:
                        box_demand_check[item.pick_sku] = box_demand_check.get(item.pick_sku, 0.0) + item.quantity
                short_skus = []
                for pick_sku, qty_needed in box_demand_check.items():
                    inv = db.query(models.InventoryItem).filter(
                        models.InventoryItem.pick_sku == pick_sku,
                        models.InventoryItem.warehouse == order.assigned_warehouse,
                    ).first()
                    on_hand = inv.on_hand_qty if inv else 0.0
                    if on_hand < qty_needed:
                        short_skus.append(f"{pick_sku} (have {on_hand:.1f}, need {qty_needed:.1f})")
                if short_skus:
                    boxes_failed += 1
                    box_errors.append(f"Box {box.box_number}: insufficient inventory — {', '.join(short_skus)}")
                    continue

            try:
                ss_result = shipstation_service.push_box(
                    order, box.box_number, items,
                    weight_oz=total_weight_oz if total_weight_oz > 0 else None,
                    box_type=box_type,
                    carrier_code=carrier_match.get("carrier_code") if carrier_match else None,
                    service_code=carrier_match.get("service_code") if carrier_match else None,
                    shipping_provider_id=carrier_match.get("shipping_provider_id") if carrier_match else None,
                )
                box.shipstation_order_id = str(ss_result.get("orderId", ""))
                box.shipstation_order_key = ss_result.get("orderKey", "")
                box.status = "packed"
                boxes_pushed += 1
            except Exception as e:
                boxes_failed += 1
                box_errors.append(f"Box {box.box_number}: {str(e)}")

        if boxes_pushed > 0 and plan.status == "draft":
            plan.status = "active"

        if boxes_pushed > 0 and order and order.app_status == "staged":
            order.app_status = "in_shipstation_not_shipped"
            db.flush()
            from routers.inventory import _auto_deduct_on_ship, _recompute_committed as _recompute_committed_inv
            _auto_deduct_on_ship(order, db)
            _recompute_committed_inv(order.assigned_warehouse, db)

        db.commit()

        if boxes_failed == 0 and boxes_pushed > 0:
            results.append({"order_id": order_id, "success": True, "boxes_pushed": boxes_pushed})
            pushed += 1
        else:
            results.append({
                "order_id": order_id,
                "success": False,
                "boxes_pushed": boxes_pushed,
                "error": "; ".join(box_errors) if box_errors else "No items in boxes",
            })
            failed += 1

    return {"pushed": pushed, "failed": failed, "results": results}


# ── Bulk auto-plan ────────────────────────────────────────────────────────────

@router.post("/bulk-auto-plan")
def bulk_auto_plan(body: BulkAutoPlanRequest = BulkAutoPlanRequest(), db: Session = Depends(get_db)):
    """
    Auto-create or repair fulfillment plans for orders:
      - If order_ids provided: only plan those specific orders.
      - Otherwise: all 'not_processed' / 'partially_fulfilled' orders.
      1. Orders with no plan → create plan + Box 1 with items, box type from rules.
      2. Orders with a draft plan but no boxes → add Box 1 with items, box type from rules.
      3. Orders with a draft plan and pending boxes that have no box_type_id → apply rules.
    Returns a per-order summary including whether a box type was matched.
    """
    q = db.query(models.ShopifyOrder).filter(
        models.ShopifyOrder.app_status.in_(["not_processed", "partially_fulfilled"])
    )
    if body.order_ids:
        q = q.filter(models.ShopifyOrder.shopify_order_id.in_(body.order_ids))
    all_not_processed = q.all()

    # Map order_id → existing non-cancelled plan
    order_ids = [o.shopify_order_id for o in all_not_processed]
    existing_plans = {
        p.shopify_order_id: p
        for p in db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.shopify_order_id.in_(order_ids),
            models.FulfillmentPlan.status != "cancelled",
        ).all()
    }

    created = 0
    repaired = 0
    skipped = 0
    unmatched = 0
    results = []

    for order in all_not_processed:
        existing_plan = existing_plans.get(order.shopify_order_id)
        auto_box_type_id = _apply_package_rules(order, db)

        try:
            if not existing_plan:
                # Case 1: no plan at all — create plan + Box 1
                plan = models.FulfillmentPlan(
                    shopify_order_id=order.shopify_order_id,
                    status="draft",
                )
                db.add(plan)
                db.flush()

                shopify_snap = _shopify_items_snapshot(order.shopify_order_id, db)
                li_meta: dict[tuple, models.ShopifyLineItem] = {}
                for li in db.query(models.ShopifyLineItem).filter(
                    models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
                    models.ShopifyLineItem.sku_mapped == True,
                    models.ShopifyLineItem.pick_sku.isnot(None),
                ).all():
                    li_meta[(li.pick_sku, li.line_item_id)] = li

                box_type_matched = auto_box_type_id is not None
                if auto_box_type_id is not None:
                    box = models.FulfillmentBox(plan_id=plan.id, box_number=1, status="pending", box_type_id=auto_box_type_id)
                    db.add(box)
                    db.flush()
                    _populate_box_items(box.id, shopify_snap, li_meta, db)
                else:
                    split_boxes, split_errors = _try_multi_box_split(order, db)
                    if split_boxes:
                        box_type_matched = all(b["box_type_id"] is not None for b in split_boxes)
                        for i, box_def in enumerate(split_boxes, start=1):
                            box = models.FulfillmentBox(plan_id=plan.id, box_number=i, status="pending", box_type_id=box_def["box_type_id"])
                            db.add(box)
                            db.flush()
                            _populate_box_items(box.id, box_def["items"], li_meta, db)
                        if split_errors:
                            err = "; ".join(split_errors)
                            plan.notes = f"[Auto-plan error: {err}]"
                    else:
                        box = models.FulfillmentBox(plan_id=plan.id, box_number=1, status="pending", box_type_id=None)
                        db.add(box)
                        db.flush()
                        _populate_box_items(box.id, shopify_snap, li_meta, db)
                        if split_errors:
                            err = "; ".join(split_errors)
                            plan.notes = f"[Auto-plan error: {err}]"

                db.commit()
                created += 1
                if not box_type_matched:
                    unmatched += 1
                results.append({
                    "order_id": order.shopify_order_id,
                    "order_number": order.shopify_order_number,
                    "action": "created",
                    "plan_id": plan.id,
                    "box_type_matched": box_type_matched,
                })

            else:
                # Plan exists — check non-cancelled boxes to decide Case 2 vs Case 3
                plan = existing_plan
                if plan.status not in ("draft", "needs_reconfiguration"):
                    plan.status = "draft"

                boxes = db.query(models.FulfillmentBox).filter(
                    models.FulfillmentBox.plan_id == plan.id,
                    models.FulfillmentBox.status != "cancelled",
                ).all()

                # Boxes still awaiting fulfillment (pending or in ShipStation, not yet shipped/fulfilled)
                active_boxes = [b for b in boxes if b.status not in ("shipped", "fulfilled")]

                if not active_boxes:
                    # Case 2: no boxes left to ship (all cancelled/shipped) — add next box for remaining items
                    shopify_snap = _shopify_items_snapshot(order.shopify_order_id, db)
                    li_meta: dict[tuple, models.ShopifyLineItem] = {}
                    for li in db.query(models.ShopifyLineItem).filter(
                        models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
                        models.ShopifyLineItem.sku_mapped == True,
                        models.ShopifyLineItem.pick_sku.isnot(None),
                    ).all():
                        li_meta[(li.pick_sku, li.line_item_id)] = li

                    box_type_matched = auto_box_type_id is not None
                    next_num = _next_box_number(plan.id, db)
                    if auto_box_type_id is not None:
                        box = models.FulfillmentBox(plan_id=plan.id, box_number=next_num, status="pending", box_type_id=auto_box_type_id)
                        db.add(box)
                        db.flush()
                        _populate_box_items(box.id, shopify_snap, li_meta, db)
                    else:
                        split_boxes, split_errors = _try_multi_box_split(order, db)
                        if split_boxes:
                            box_type_matched = all(b["box_type_id"] is not None for b in split_boxes)
                            for i, box_def in enumerate(split_boxes, start=next_num):
                                box = models.FulfillmentBox(plan_id=plan.id, box_number=i, status="pending", box_type_id=box_def["box_type_id"])
                                db.add(box)
                                db.flush()
                                _populate_box_items(box.id, box_def["items"], li_meta, db)
                            if split_errors:
                                err = "; ".join(split_errors)
                                plan.notes = (f"{plan.notes}\n" if plan.notes else "") + f"[Auto-plan error: {err}]"
                        else:
                            box = models.FulfillmentBox(plan_id=plan.id, box_number=next_num, status="pending", box_type_id=None)
                            db.add(box)
                            db.flush()
                            _populate_box_items(box.id, shopify_snap, li_meta, db)
                            if split_errors:
                                err = "; ".join(split_errors)
                                plan.notes = (f"{plan.notes}\n" if plan.notes else "") + f"[Auto-plan error: {err}]"

                    db.commit()
                    repaired += 1
                    if not box_type_matched:
                        unmatched += 1
                    results.append({
                        "order_id": order.shopify_order_id,
                        "order_number": order.shopify_order_number,
                        "action": "added_box",
                        "plan_id": plan.id,
                        "box_type_matched": box_type_matched,
                    })

                else:
                    # Case 3: active boxes exist — apply rules to any pending box with no box_type
                    updated_any = False
                    for box in active_boxes:
                        if box.status == "pending" and box.box_type_id is None and auto_box_type_id:
                            box.box_type_id = auto_box_type_id
                            updated_any = True

                    if updated_any:
                        db.commit()
                        repaired += 1
                        results.append({
                            "order_id": order.shopify_order_id,
                            "order_number": order.shopify_order_number,
                            "action": "applied_box_type",
                            "plan_id": plan.id,
                            "box_type_matched": True,
                        })
                    else:
                        # Try multi-box split if all existing active boxes are untyped+pending
                        all_untyped_pending = bool(active_boxes) and all(
                            b.status == "pending" and b.box_type_id is None for b in active_boxes
                        )
                        split_boxes, split_errors = None, []
                        if all_untyped_pending and not auto_box_type_id:
                            split_boxes, split_errors = _try_multi_box_split(order, db)

                        if split_boxes and len(split_boxes) > 1:
                            # Replace untyped active boxes with a proper multi-box plan
                            for b in active_boxes:
                                db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == b.id).delete()
                                db.delete(b)
                            db.flush()

                            shopify_snap = _shopify_items_snapshot(order.shopify_order_id, db)
                            li_meta: dict[tuple, models.ShopifyLineItem] = {}
                            for li in db.query(models.ShopifyLineItem).filter(
                                models.ShopifyLineItem.shopify_order_id == order.shopify_order_id,
                                models.ShopifyLineItem.sku_mapped == True,
                                models.ShopifyLineItem.pick_sku.isnot(None),
                            ).all():
                                li_meta[(li.pick_sku, li.line_item_id)] = li

                            for i, box_def in enumerate(split_boxes, start=1):
                                box = models.FulfillmentBox(plan_id=plan.id, box_number=i, status="pending", box_type_id=box_def["box_type_id"])
                                db.add(box)
                                db.flush()
                                _populate_box_items(box.id, box_def["items"], li_meta, db)

                            if split_errors:
                                err = "; ".join(split_errors)
                                plan.notes = (f"{plan.notes}\n" if plan.notes else "") + f"[Auto-plan error: {err}]"

                            db.commit()
                            repaired += 1
                            box_type_matched = all(b["box_type_id"] is not None for b in split_boxes)
                            if not box_type_matched:
                                unmatched += 1
                            results.append({
                                "order_id": order.shopify_order_id,
                                "order_number": order.shopify_order_number,
                                "action": "multi_box_split",
                                "plan_id": plan.id,
                                "box_type_matched": box_type_matched,
                            })
                        elif all_untyped_pending and not auto_box_type_id:
                            # No overflow split needed — try pactor-based rule lookup for a single box
                            order_pactor = _order_pactor(order, db)
                            pactor_box_type_id = _apply_package_rules_for_pactor(order, order_pactor, db) if order_pactor else None
                            if pactor_box_type_id:
                                for b in boxes:
                                    if b.status == "pending" and b.box_type_id is None:
                                        b.box_type_id = pactor_box_type_id
                                db.commit()
                                repaired += 1
                                results.append({
                                    "order_id": order.shopify_order_id,
                                    "order_number": order.shopify_order_number,
                                    "action": "applied_box_type",
                                    "plan_id": plan.id,
                                    "box_type_matched": True,
                                })
                            else:
                                unmatched += 1
                                results.append({
                                    "order_id": order.shopify_order_id,
                                    "order_number": order.shopify_order_number,
                                    "action": "skipped",
                                    "reason": "no box rule matched",
                                })
                        else:
                            skipped += 1
                            results.append({
                                "order_id": order.shopify_order_id,
                                "order_number": order.shopify_order_number,
                                "action": "skipped",
                                "reason": "plan already has boxes with types assigned",
                            })

        except Exception as e:
            db.rollback()
            skipped += 1
            results.append({
                "order_id": order.shopify_order_id,
                "order_number": order.shopify_order_number,
                "error": str(e),
            })

    return {
        "created": created,
        "repaired": repaired,
        "skipped": skipped,
        "unmatched_box_type": unmatched,
        "results": results,
    }


# ── Change detection ──────────────────────────────────────────────────────────

@router.post("/detect-changes")
def detect_changes(
    shopify_order_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """
    Compare current ShopifyLineItems to BoxLineItem totals for all non-cancelled/completed plans.
    Creates a LineItemChangeEvent when they differ (and no pending event already exists).
    Sets plan status to needs_review when a new change is found.
    """
    q = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.status.notin_(["cancelled", "completed"])
    )
    if shopify_order_id:
        q = q.filter(models.FulfillmentPlan.shopify_order_id == shopify_order_id)
    plans = q.all()

    checked = 0
    changes_detected = 0

    for plan in plans:
        shopify_snap = _shopify_items_snapshot(plan.shopify_order_id, db)
        plan_snap = _plan_items_snapshot(plan.id, db)

        if shopify_snap == plan_snap:
            checked += 1
            continue

        # Only create a new event if no pending one already exists
        pending = db.query(models.LineItemChangeEvent).filter(
            models.LineItemChangeEvent.plan_id == plan.id,
            models.LineItemChangeEvent.status == "pending_approval",
        ).first()

        if not pending:
            db.add(models.LineItemChangeEvent(
                plan_id=plan.id,
                shopify_order_id=plan.shopify_order_id,
                old_line_items=_snap_to_json(plan_snap),
                new_line_items=_snap_to_json(shopify_snap),
            ))
            plan.status = "needs_review"
            changes_detected += 1

        checked += 1

    db.commit()
    return {"checked": checked, "changes_detected": changes_detected}


# ── Change events ─────────────────────────────────────────────────────────────

@router.get("/changes")
def list_changes(status: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(models.LineItemChangeEvent)
    if status:
        q = q.filter(models.LineItemChangeEvent.status == status)
    events = q.order_by(models.LineItemChangeEvent.detected_at.desc()).all()
    return [_row(e) for e in events]


@router.post("/changes/{change_id}/approve")
def approve_change(change_id: int, body: ChangeReview, db: Session = Depends(get_db)):
    """
    Approve a change: updates the plan's unshipped boxes to reflect the new line items,
    sets plan status to needs_reconfiguration so the operator can re-assign items to boxes.
    """
    event = db.query(models.LineItemChangeEvent).filter(
        models.LineItemChangeEvent.id == change_id
    ).first()
    if not event:
        raise HTTPException(status_code=404, detail="Change event not found")
    if event.status != "pending_approval":
        raise HTTPException(status_code=409, detail=f"Event is already '{event.status}'")

    event.status = "approved"
    event.reviewed_at = datetime.now(timezone.utc)
    if body.notes:
        event.notes = body.notes

    plan = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.id == event.plan_id
    ).first()
    if plan:
        plan.status = "needs_reconfiguration"

        # Clear items from all unshipped boxes; reload first box with new line items
        unshipped_boxes = (
            db.query(models.FulfillmentBox)
            .filter(
                models.FulfillmentBox.plan_id == plan.id,
                models.FulfillmentBox.status != "shipped",
            )
            .order_by(models.FulfillmentBox.box_number)
            .all()
        )

        for box in unshipped_boxes:
            db.query(models.BoxLineItem).filter(models.BoxLineItem.box_id == box.id).delete()

        if unshipped_boxes:
            # Build title/sku lookup from current ShopifyLineItems
            li_meta: dict[tuple, models.ShopifyLineItem] = {}
            for li in db.query(models.ShopifyLineItem).filter(
                models.ShopifyLineItem.shopify_order_id == event.shopify_order_id,
                models.ShopifyLineItem.sku_mapped == True,
                models.ShopifyLineItem.pick_sku.isnot(None),
            ).all():
                li_meta[(li.pick_sku, li.line_item_id)] = li

            first_box = unshipped_boxes[0]
            new_items = _json_to_snap(event.new_line_items)
            for (pick_sku, line_item_id), qty in new_items.items():
                meta = li_meta.get((pick_sku, line_item_id))
                db.add(models.BoxLineItem(
                    box_id=first_box.id,
                    pick_sku=pick_sku,
                    shopify_sku=meta.shopify_sku if meta else None,
                    product_title=meta.product_title if meta else None,
                    shopify_line_item_id=line_item_id or None,
                    quantity=qty,
                ))

    db.commit()
    return _row(event)


@router.post("/changes/{change_id}/reject")
def reject_change(change_id: int, body: ChangeReview, db: Session = Depends(get_db)):
    """Reject a change — keep the current plan as-is."""
    event = db.query(models.LineItemChangeEvent).filter(
        models.LineItemChangeEvent.id == change_id
    ).first()
    if not event:
        raise HTTPException(status_code=404, detail="Change event not found")
    if event.status != "pending_approval":
        raise HTTPException(status_code=409, detail=f"Event is already '{event.status}'")

    event.status = "rejected"
    event.reviewed_at = datetime.now(timezone.utc)
    if body.notes:
        event.notes = body.notes

    plan = db.query(models.FulfillmentPlan).filter(
        models.FulfillmentPlan.id == event.plan_id
    ).first()
    if plan and plan.status == "needs_review":
        plan.status = "active"

    db.commit()
    return _row(event)


# ── One-time repair: duplicate-SKU fulfillment bug ──────────────────────────

@router.post("/repair-duplicate-sku-fulfillments")
def repair_duplicate_sku_fulfillments(
    dry_run: bool = True,
    db: Session = Depends(get_db),
):
    """
    Find and fix orders where the app shipped boxes but some Shopify line items
    remain unfulfilled — typically caused by duplicate SKUs (e.g. upsells) where
    only one line_item_id was tracked on BoxLineItems.

    Approach: find orders with shipped boxes where the same shopify_sku appears on
    multiple Shopify line_item_ids, and at least one has fulfillable_quantity > 0
    (still unfulfilled). For each, create a Shopify fulfillment with the shipped
    box's tracking number, and split the merged BoxLineItem in the DB.

    When dry_run=True (default), reports what would be fixed without making changes.
    When dry_run=False, fixes BoxLineItems in the DB and creates Shopify fulfillments.
    """
    from services import shopify_service
    from collections import defaultdict

    results = []

    # Step 1: Find orders with multiple line_item_ids for the same shopify_sku
    all_lis = db.query(models.ShopifyLineItem).all()

    # Group by (shopify_order_id, shopify_sku) → list of distinct line_item_ids
    order_sku_groups: dict = defaultdict(list)
    for li in all_lis:
        if li.shopify_sku:
            order_sku_groups[(li.shopify_order_id, li.shopify_sku)].append(li)

    # Find orders where the same shopify_sku has multiple distinct line_item_ids
    affected_order_ids: set = set()
    for (order_id, sku), lis in order_sku_groups.items():
        distinct_li_ids = {li.line_item_id for li in lis}
        if len(distinct_li_ids) > 1:
            affected_order_ids.add(order_id)

    if not affected_order_ids:
        return {"dry_run": dry_run, "affected_orders": 0, "results": []}

    # Step 2: For each affected order, check if it has shipped boxes and unfulfilled line items
    for order_id in sorted(affected_order_ids):
        plan = db.query(models.FulfillmentPlan).filter(
            models.FulfillmentPlan.shopify_order_id == order_id,
            models.FulfillmentPlan.status.notin_(["cancelled"]),
        ).first()
        if not plan:
            continue

        shipped_boxes = db.query(models.FulfillmentBox).filter(
            models.FulfillmentBox.plan_id == plan.id,
            models.FulfillmentBox.status.in_(["shipped", "fulfilled"]),
        ).all()
        if not shipped_boxes:
            continue

        order = db.query(models.ShopifyOrder).filter(
            models.ShopifyOrder.shopify_order_id == order_id
        ).first()
        order_number = order.shopify_order_number if order else order_id

        # Get all ShopifyLineItems grouped by shopify_sku
        order_lis = db.query(models.ShopifyLineItem).filter(
            models.ShopifyLineItem.shopify_order_id == order_id,
        ).all()

        sku_to_li_ids: dict = defaultdict(set)
        li_id_to_lis: dict = defaultdict(list)
        for li in order_lis:
            if li.shopify_sku:
                sku_to_li_ids[li.shopify_sku].add(li.line_item_id)
            li_id_to_lis[li.line_item_id].append(li)

        # Find shopify_skus with duplicate line_item_ids
        dup_skus = {sku: li_ids for sku, li_ids in sku_to_li_ids.items() if len(li_ids) > 1}
        if not dup_skus:
            continue

        # Collect all line_item_ids referenced by shipped box items
        shipped_box_li_ids: set = set()
        shipped_box_tracking: dict = {}  # line_item_id → (tracking, carrier) from first box
        for box in shipped_boxes:
            box_items = db.query(models.BoxLineItem).filter(
                models.BoxLineItem.box_id == box.id
            ).all()
            for bi in box_items:
                if bi.shopify_line_item_id:
                    shipped_box_li_ids.add(bi.shopify_line_item_id)
                    if bi.shopify_line_item_id not in shipped_box_tracking:
                        shipped_box_tracking[bi.shopify_line_item_id] = (box.tracking_number, box.carrier, box.id, box.box_number)

        # For each duplicate SKU, find orphaned line_item_ids not referenced by shipped boxes
        for sku, li_ids in dup_skus.items():
            referenced_li_ids = li_ids & shipped_box_li_ids
            orphaned_li_ids = li_ids - shipped_box_li_ids

            if not orphaned_li_ids or not referenced_li_ids:
                continue

            # Check if orphaned line items are actually unfulfilled
            unfulfilled_orphans = []
            for orphan_id in orphaned_li_ids:
                orphan_lis = li_id_to_lis.get(orphan_id, [])
                # Check the first row for this line_item_id
                first = orphan_lis[0] if orphan_lis else None
                if first:
                    fq = first.fulfillable_quantity
                    if fq is not None and fq > 0:
                        unfulfilled_orphans.append({
                            "line_item_id": orphan_id,
                            "shopify_qty": first.quantity or 0,
                            "fulfillable_quantity": fq,
                        })
                    elif fq is None:
                        # fulfillable_quantity not set — assume unfulfilled
                        unfulfilled_orphans.append({
                            "line_item_id": orphan_id,
                            "shopify_qty": first.quantity or 0,
                            "fulfillable_quantity": first.quantity or 0,
                        })

            if not unfulfilled_orphans:
                continue

            # Use tracking from the first referenced line_item_id's box
            ref_li_id = next(iter(referenced_li_ids))
            tracking_info = shipped_box_tracking.get(ref_li_id)
            tracking = tracking_info[0] if tracking_info else None
            carrier = tracking_info[1] if tracking_info else None
            box_id = tracking_info[2] if tracking_info else None
            box_number = tracking_info[3] if tracking_info else None

            result_entry = {
                "order_id": order_id,
                "order_number": order_number,
                "shopify_sku": sku,
                "box_id": box_id,
                "box_number": box_number,
                "tracking_number": tracking,
                "carrier": carrier,
                "referenced_line_item_ids": sorted(referenced_li_ids),
                "orphaned_unfulfilled": unfulfilled_orphans,
                "db_fixed": False,
                "shopify_fixed": False,
                "shopify_errors": [],
            }

            if not dry_run:
                # Fix DB: For each orphan, add BoxLineItem rows to the shipped box
                # mirroring the pick_sku expansion of the referenced line_item_id
                if box_id:
                    for orphan in unfulfilled_orphans:
                        orphan_id = orphan["line_item_id"]
                        orphan_pick_lis = [
                            li for li in li_id_to_lis.get(orphan_id, [])
                            if li.pick_sku
                        ]
                        if orphan_pick_lis:
                            # Orphan has its own pick_sku expansion — use it
                            for li in orphan_pick_lis:
                                pick_units = (li.quantity or 0) * (li.mix_quantity or 1.0)
                                if pick_units > 0:
                                    db.add(models.BoxLineItem(
                                        box_id=box_id,
                                        pick_sku=li.pick_sku,
                                        shopify_sku=li.shopify_sku,
                                        product_title=li.product_title,
                                        shopify_line_item_id=orphan_id,
                                        quantity=pick_units,
                                    ))
                        else:
                            # No pick expansion — copy from the referenced line_item's box items
                            ref_box_items = db.query(models.BoxLineItem).filter(
                                models.BoxLineItem.box_id == box_id,
                                models.BoxLineItem.shopify_line_item_id == ref_li_id,
                            ).all()
                            # Each ref item's qty covers all line items; split proportionally
                            ref_total_shopify_qty = sum(
                                (li_id_to_lis.get(r, [{}])[0].quantity or 0)
                                if isinstance(r, str) else 0
                                for r in referenced_li_ids
                            ) or 1
                            for rbi in ref_box_items:
                                # The ref box item qty is for total units; split per line item
                                orphan_qty = orphan["shopify_qty"]
                                ref_li = li_id_to_lis.get(ref_li_id, [None])[0]
                                ref_shopify_qty = (ref_li.quantity or 1) if ref_li else 1
                                per_unit_pick = rbi.quantity / max(ref_shopify_qty, 1)
                                new_qty = per_unit_pick * orphan_qty
                                if new_qty > 0:
                                    # Reduce the existing merged BoxLineItem
                                    rbi.quantity -= new_qty
                                    db.add(models.BoxLineItem(
                                        box_id=box_id,
                                        pick_sku=rbi.pick_sku,
                                        shopify_sku=rbi.shopify_sku,
                                        product_title=rbi.product_title,
                                        shopify_line_item_id=orphan_id,
                                        quantity=new_qty,
                                    ))
                    db.flush()
                    result_entry["db_fixed"] = True

                # Fix Shopify: create fulfillment for orphaned line items
                if tracking and shopify_service.is_configured():
                    orphan_ids = [o["line_item_id"] for o in unfulfilled_orphans]
                    orphan_qtys = {
                        o["line_item_id"]: max(1, round(o["fulfillable_quantity"]))
                        for o in unfulfilled_orphans
                    }
                    try:
                        f_result = shopify_service.create_fulfillment_for_box(
                            shopify_order_id=order_id,
                            shopify_line_item_ids=orphan_ids,
                            tracking_number=tracking,
                            carrier_code=carrier,
                            notify_customer=False,
                            line_item_quantities=orphan_qtys,
                        )
                        if f_result:
                            result_entry["shopify_fixed"] = True
                        else:
                            result_entry["shopify_errors"].append(
                                "Shopify returned None — line items may already be fulfilled or no open fulfillment order"
                            )
                    except Exception as e:
                        result_entry["shopify_errors"].append(str(e))

            results.append(result_entry)

    if not dry_run:
        db.commit()

    return {
        "dry_run": dry_run,
        "affected_orders": len({r["order_id"] for r in results}),
        "fixes": len(results),
        "results": results,
    }
