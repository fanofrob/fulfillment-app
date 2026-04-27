"""
Shopify service — pulls unfulfilled orders from the Shopify Admin REST API.

Authentication:
  - Set SHOPIFY_API_KEY + SHOPIFY_API_SECRET in env, then visit /api/shopify/connect
    to run the OAuth flow. The resulting access token is saved to the app_config DB table
    (survives restarts; works on ephemeral filesystems like Railway).
  - Or set SHOPIFY_ACCESS_TOKEN directly in env (legacy / manual override).
"""
from __future__ import annotations

import os
import json
import requests
from datetime import datetime
from typing import List, Dict, Optional

SHOPIFY_SHOP_DOMAIN = os.getenv("SHOPIFY_SHOP_DOMAIN", "").strip()
SHOPIFY_API_KEY     = os.getenv("SHOPIFY_API_KEY", "").strip()
SHOPIFY_API_SECRET  = os.getenv("SHOPIFY_API_SECRET", "").strip()
API_VERSION = "2024-01"

# Legacy on-disk token file — only read once on first startup if DB has no token,
# then migrated into the app_config table. Will not exist on Railway.
_LEGACY_TOKEN_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "shopify_token.json")

_TOKEN_KEY = "shopify_access_token"

# In-memory cache so we don't hit the DB on every request
_cached_token: Optional[str] = None
_cached_admin_domain: Optional[str] = None


def _load_token_from_db() -> Optional[str]:
    """Read token from the app_config table. Imports are local to avoid
    circular imports at module load."""
    from database import SessionLocal
    from models import AppConfig
    db = SessionLocal()
    try:
        row = db.query(AppConfig).filter(AppConfig.key == _TOKEN_KEY).first()
        return row.value if row and row.value else None
    finally:
        db.close()


def _save_token_to_db(token: Optional[str]) -> None:
    from database import SessionLocal
    from models import AppConfig
    db = SessionLocal()
    try:
        row = db.query(AppConfig).filter(AppConfig.key == _TOKEN_KEY).first()
        if row is None:
            row = AppConfig(key=_TOKEN_KEY, value=token)
            db.add(row)
        else:
            row.value = token
        db.commit()
    finally:
        db.close()


def _migrate_legacy_token_file() -> Optional[str]:
    """One-shot: if the old shopify_token.json exists and DB has no token yet,
    copy it into the DB so existing local installs keep working after the refactor."""
    if not os.path.exists(_LEGACY_TOKEN_FILE):
        return None
    try:
        with open(_LEGACY_TOKEN_FILE) as f:
            data = json.load(f)
        token = data.get("access_token")
        if not token:
            return None
        _save_token_to_db(token)
        return token
    except Exception:
        return None


def get_access_token() -> Optional[str]:
    """Return the access token, checking env var, in-memory cache, then DB.
    Also migrates from the legacy shopify_token.json on first call if needed."""
    global _cached_token
    # 1. Env var (manual override — useful for first-time Railway setup)
    env_token = os.getenv("SHOPIFY_ACCESS_TOKEN", "").strip()
    if env_token:
        return env_token
    # 2. In-memory cache
    if _cached_token:
        return _cached_token
    # 3. DB
    db_token = _load_token_from_db()
    if db_token:
        _cached_token = db_token
        return _cached_token
    # 4. Legacy JSON file (only matters on the original dev machine — migrate it in)
    migrated = _migrate_legacy_token_file()
    if migrated:
        _cached_token = migrated
        return _cached_token
    return None


def save_access_token(token: str):
    """Persist token to DB and update in-memory cache."""
    global _cached_token
    _cached_token = token
    _save_token_to_db(token)


def clear_access_token():
    """Remove the stored token (forces re-auth)."""
    global _cached_token
    _cached_token = None
    _save_token_to_db(None)


def is_configured() -> bool:
    return bool(SHOPIFY_SHOP_DOMAIN and get_access_token())


def oauth_ready() -> bool:
    """True if we have enough config to start the OAuth flow."""
    return bool(SHOPIFY_SHOP_DOMAIN and SHOPIFY_API_KEY and SHOPIFY_API_SECRET)


def _base_url() -> str:
    return f"https://{SHOPIFY_SHOP_DOMAIN}/admin/api/{API_VERSION}"


def _headers() -> dict:
    return {
        "X-Shopify-Access-Token": get_access_token(),
        "Content-Type": "application/json",
    }


def _admin_domain() -> str:
    """Canonical *.myshopify.com domain — required for GraphQL (REST works on either)."""
    global _cached_admin_domain
    if _cached_admin_domain:
        return _cached_admin_domain
    if SHOPIFY_SHOP_DOMAIN.endswith(".myshopify.com"):
        _cached_admin_domain = SHOPIFY_SHOP_DOMAIN
        return _cached_admin_domain
    try:
        resp = requests.get(f"{_base_url()}/shop.json", headers=_headers(), timeout=15)
        resp.raise_for_status()
        d = resp.json().get("shop", {}).get("myshopify_domain")
        if d:
            _cached_admin_domain = d
            return d
    except Exception:
        pass
    return SHOPIFY_SHOP_DOMAIN


def _graphql_url() -> str:
    return f"https://{_admin_domain()}/admin/api/{API_VERSION}/graphql.json"


def _parse_next_link(link_header: str) -> Optional[str]:
    """Parse Shopify's Link header to find the next page URL."""
    if not link_header:
        return None
    for part in link_header.split(","):
        part = part.strip()
        if 'rel="next"' in part:
            url_part = part.split(";")[0].strip()
            return url_part.strip("<>")
    return None


def get_unfulfilled_orders() -> List[Dict]:
    """
    Pull all open (unfulfilled + partially fulfilled) orders from Shopify using
    cursor-based pagination. Returns raw order dicts including line_items,
    shipping_address, tags, discounts.
    """
    if not is_configured():
        raise RuntimeError(
            "Shopify not connected. Visit /api/shopify/connect to authenticate."
        )

    url = f"{_base_url()}/orders.json"
    params = {
        "status": "open",
        "limit": 250,
        "fields": (
            "id,name,created_at,tags,note,financial_status,fulfillment_status,"
            "total_price,subtotal_price,total_discounts,total_weight,"
            "customer,shipping_address,line_items,discount_codes,shipping_lines"
        ),
    }

    all_orders = []
    while url:
        resp = requests.get(url, headers=_headers(), params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        orders = data.get("orders", [])
        all_orders.extend(orders)
        params = {}  # params only on first request; subsequent URLs are fully formed
        url = _parse_next_link(resp.headers.get("Link", ""))

    # Exclude fully fulfilled orders — we only care about open work
    return [o for o in all_orders if o.get("fulfillment_status") != "fulfilled"]


def _parse_dt(s) -> datetime | None:
    """Parse a Shopify ISO datetime string into a Python datetime object."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def get_on_hold_order_ids() -> set:
    """
    Return the set of Shopify order IDs (as strings, legacy numeric IDs) that
    currently have an on-hold fulfillment status, using the Shopify Admin GraphQL API.
    Makes paginated calls until all on-hold orders are collected.
    Returns an empty set if not configured or on any error.
    """
    if not is_configured():
        return set()

    url = _graphql_url()
    headers = {
        "X-Shopify-Access-Token": get_access_token(),
        "Content-Type": "application/json",
    }

    on_hold_ids: set = set()
    cursor = None

    while True:
        after_clause = f', after: "{cursor}"' if cursor else ""
        query = f"""
        {{
          orders(first: 250, query: "status:open fulfillment_status:on_hold"{after_clause}) {{
            edges {{
              node {{
                legacyResourceId
              }}
            }}
            pageInfo {{
              hasNextPage
              endCursor
            }}
          }}
        }}
        """
        try:
            resp = requests.post(url, headers=headers, json={"query": query}, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            break

        orders_data = data.get("data", {}).get("orders", {})
        for edge in orders_data.get("edges", []):
            legacy_id = edge.get("node", {}).get("legacyResourceId")
            if legacy_id:
                on_hold_ids.add(str(legacy_id))

        page_info = orders_data.get("pageInfo", {})
        if not page_info.get("hasNextPage"):
            break
        cursor = page_info.get("endCursor")

    return on_hold_ids


def create_fulfillment_for_box(
    shopify_order_id: str,
    shopify_line_item_ids: List[str],
    tracking_number: str,
    carrier_code: Optional[str] = None,
    notify_customer: bool = True,
    line_item_quantities: Optional[Dict[str, int]] = None,
) -> Optional[Dict]:
    """
    Create a Shopify fulfillment for a specific set of line items (one box).
    Uses the Fulfillment Orders API (required for Shopify API 2022-01+).

    Flow:
      1. GET /orders/{id}/fulfillment_orders → find open fulfillment order(s)
      2. Match our line_item_ids to the fulfillment order line items
      3. POST /fulfillments with tracking info + matched line items

    line_item_quantities: optional dict of {shopify_line_item_id: qty_in_this_box}.
    When provided, uses per-box quantities (capped at fulfillable_quantity) instead of
    fulfilling all remaining — critical for multi-box orders where boxes ship separately.

    Returns the created Shopify fulfillment dict, or None on failure.
    Multi-box: call once per box — each box gets its own fulfillment + tracking number.
    """
    if not is_configured():
        return None
    if not tracking_number or not shopify_line_item_ids:
        return None

    li_id_set = {str(li_id) for li_id in shopify_line_item_ids}

    # Step 1: get fulfillment orders for this Shopify order
    fo_url = f"{_base_url()}/orders/{shopify_order_id}/fulfillment_orders.json"
    try:
        fo_resp = requests.get(fo_url, headers=_headers(), timeout=30)
        fo_resp.raise_for_status()
    except Exception as e:
        print(f"[shopify] fulfillment_orders fetch failed for order {shopify_order_id}: {e}")
        return None

    fulfillment_orders = fo_resp.json().get("fulfillment_orders", [])

    # Step 2: match our line items to fulfillment order line items
    line_items_by_fo: List[Dict] = []
    for fo in fulfillment_orders:
        if fo.get("status") not in ("open", "in_progress"):
            continue
        matched = []
        for fo_li in fo.get("line_items", []):
            li_id_str = str(fo_li.get("line_item_id", ""))
            if li_id_str in li_id_set:
                fulfillable_qty = fo_li.get("fulfillable_quantity", 0)
                if fulfillable_qty > 0:
                    if line_item_quantities and li_id_str in line_item_quantities:
                        qty = min(line_item_quantities[li_id_str], fulfillable_qty)
                    else:
                        qty = fulfillable_qty
                    if qty > 0:
                        matched.append({"id": fo_li["id"], "quantity": qty})
        if matched:
            line_items_by_fo.append({
                "fulfillment_order_id": fo["id"],
                "fulfillment_order_line_items": matched,
            })

    if not line_items_by_fo:
        print(f"[shopify] no open fulfillment order line items matched for order {shopify_order_id}, line_items={shopify_line_item_ids}")
        return None

    # Carrier name mapping (ShipStation carrier codes → Shopify display names)
    carrier_names = {
        "ups":          "UPS",
        "fedex":        "FedEx",
        "usps":         "USPS",
        "stamps_com":   "USPS",
        "dhl_express":  "DHL Express",
        "ontrac":       "OnTrac",
        "lasership":    "LaserShip",
        "asendia":      "Asendia",
        "amazon":       "Amazon",
    }
    carrier_name = carrier_names.get((carrier_code or "").lower(), carrier_code or "Other")

    # Step 3: create the fulfillment
    payload = {
        "fulfillment": {
            "notify_customer": notify_customer,
            "tracking_info": {
                "number": tracking_number,
                "company": carrier_name,
            },
            "line_items_by_fulfillment_order": line_items_by_fo,
        }
    }
    f_url = f"{_base_url()}/fulfillments.json"
    try:
        f_resp = requests.post(f_url, headers=_headers(), json=payload, timeout=30)
        if f_resp.status_code in (200, 201):
            created = f_resp.json().get("fulfillment")
            print(f"[shopify] fulfillment created for order {shopify_order_id}, tracking={tracking_number}, id={created.get('id') if created else None}")
            return created
        print(f"[shopify] fulfillment creation failed {f_resp.status_code}: {f_resp.text[:400]}")
    except Exception as e:
        print(f"[shopify] fulfillment POST exception for order {shopify_order_id}: {e}")
    return None


def get_order_fulfillable_qtys(shopify_order_id: str) -> Dict[str, int]:
    """
    Fetch current fulfillable_quantity for each line item on a Shopify order.
    Uses the fulfillment_orders endpoint (more reliable than /orders/{id}.json
    which can 404 on deprecated API versions).
    Returns {line_item_id: fulfillable_quantity}.
    Items fully fulfilled won't appear — callers should treat missing IDs as 0.
    """
    url = f"{_base_url()}/orders/{shopify_order_id}/fulfillment_orders.json"
    resp = requests.get(url, headers=_headers(), timeout=30)
    resp.raise_for_status()
    fulfillment_orders = resp.json().get("fulfillment_orders", [])
    qtys: Dict[str, int] = {}
    for fo in fulfillment_orders:
        if fo.get("status") in ("open", "in_progress"):
            for li in fo.get("line_items", []):
                li_id = str(li.get("line_item_id", ""))
                if li_id:
                    qtys[li_id] = qtys.get(li_id, 0) + li.get("fulfillable_quantity", 0)
    return qtys


def get_products() -> List[Dict]:
    """
    Pull all products from Shopify and return a flat list — one entry per variant SKU.
    Each entry: {shopify_product_id, shopify_sku, title, product_type}
    """
    if not is_configured():
        raise RuntimeError(
            "Shopify not connected. Visit /api/shopify/connect to authenticate."
        )

    url = f"{_base_url()}/products.json"
    params = {
        "limit": 250,
        "fields": "id,title,product_type,variants,status",
        "status": "active,archived,draft",   # Shopify rejects "any"; comma-list returns all
    }

    all_products = []
    while url:
        resp = requests.get(url, headers=_headers(), params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        all_products.extend(data.get("products", []))
        params = {}
        url = _parse_next_link(resp.headers.get("Link", ""))

    result = []
    for product in all_products:
        title        = product.get("title") or ""
        product_type = product.get("product_type") or None
        product_id   = str(product.get("id") or "")
        for variant in product.get("variants", []):
            sku = str(variant.get("sku") or "").strip()
            if not sku:
                continue
            result.append({
                "shopify_product_id": product_id,
                "shopify_sku":        sku,
                "title":              title or None,
                "product_type":       product_type,
            })
    return result


def archive_order(shopify_order_id: str) -> bool:
    """
    Close (archive) a Shopify order by calling POST /orders/{id}/close.json.
    Returns True on success, False if the call fails.
    """
    if not is_configured():
        return False
    url = f"{_base_url()}/orders/{shopify_order_id}/close.json"
    try:
        resp = requests.post(url, headers=_headers(), json={}, timeout=15)
        return resp.status_code in (200, 201)
    except Exception:
        return False


def should_auto_archive(raw: Dict) -> bool:
    """
    Returns True if this raw Shopify order should be auto-archived:
      - No shipping address
      - Tagged with 'subscription_recurring_order'
      - Has a line item with SKU 'monthly-priority-pass'
      - All other line items are priced at $0
    """
    # Must have monthly-priority-pass line item
    line_items = raw.get("line_items", [])
    has_pass = any(str(li.get("sku") or "").strip() == "monthly-priority-pass" for li in line_items)
    if not has_pass:
        return False

    # All non-monthly-priority-pass items must be priced at $0 and have "Choose Your Gift" in the title
    others = [li for li in line_items if str(li.get("sku") or "").strip() != "monthly-priority-pass"]
    for li in others:
        if float(li.get("price") or 0) != 0.0:
            return False
        if "choose your gift" not in (li.get("title") or "").lower():
            return False

    return True


def should_exclude_from_historical(raw: Dict) -> bool:
    """
    Returns True if this raw Shopify order should NOT be counted in historical
    sales or daily order totals. Excludes:
      - Auto-archived orders (subscription pass + free "Choose Your Gift" items)
      - Orders whose only line items are the monthly-priority-pass SKU
    """
    if should_auto_archive(raw):
        return True

    line_items = raw.get("line_items", [])
    if not line_items:
        return False

    non_pass = [
        li for li in line_items
        if str(li.get("sku") or "").strip() != "monthly-priority-pass"
    ]
    return len(non_pass) == 0


def transform_order(raw: Dict, sku_lookup: Dict) -> Dict:
    """
    Convert a raw Shopify order dict into DB-ready dicts.
    sku_lookup: {shopify_sku: {"pick_sku": str, "mix_quantity": float}}
    Returns {"order": {...}, "line_items": [...]}
    """
    shipping = raw.get("shipping_address") or {}
    customer = raw.get("customer") or {}
    line_items_raw = raw.get("line_items", [])

    first = customer.get("first_name") or ""
    last = customer.get("last_name") or ""
    customer_name = f"{first} {last}".strip() or None

    order = {
        "shopify_order_id":      str(raw["id"]),
        "shopify_order_number":  raw.get("name"),
        "customer_name":         customer_name,
        "customer_email":        customer.get("email"),
        "shipping_name":         shipping.get("name"),
        "shipping_address1":     shipping.get("address1"),
        "shipping_address2":     shipping.get("address2"),
        "shipping_city":         shipping.get("city"),
        "shipping_province":     shipping.get("province_code"),
        "shipping_zip":          shipping.get("zip"),
        "shipping_country":      shipping.get("country_code"),
        "tags":                  raw.get("tags", ""),
        "financial_status":      raw.get("financial_status"),
        "fulfillment_status":    raw.get("fulfillment_status"),
        "total_price":           float(raw.get("total_price") or 0),
        "subtotal_price":        float(raw.get("subtotal_price") or 0),
        "total_discounts":       float(raw.get("total_discounts") or 0),
        "total_shipping_price":  sum(float(sl.get("price") or 0) for sl in raw.get("shipping_lines") or []),
        "total_weight_g":        int(raw.get("total_weight") or 0),
        "note":                  raw.get("note"),
        "created_at_shopify":    _parse_dt(raw.get("created_at")),
        "updated_at":            _parse_dt(raw.get("updated_at")),
    }

    line_items = []
    for li in line_items_raw:
        shopify_sku = str(li.get("sku") or "").strip()
        mappings = sku_lookup.get(shopify_sku)

        # fulfillable_quantity = quantity − already fulfilled by Shopify.
        # 0 means fully auto-fulfilled (digital, membership, etc.) — no warehouse pick needed.
        fulfillable_qty = int(li.get("fulfillable_quantity") or 0)

        base = {
            "shopify_order_id":       str(raw["id"]),
            "line_item_id":           str(li["id"]),
            "shopify_sku":            shopify_sku or None,
            "product_title":          li.get("title"),
            "variant_title":          li.get("variant_title"),
            "quantity":               int(li["quantity"]) if li.get("quantity") is not None else 1,
            "fulfillable_quantity":   fulfillable_qty,
            "fulfillment_status":     li.get("fulfillment_status") or None,
            "price":                  float(li.get("price") or 0),
            "total_discount":         float(li.get("total_discount") or 0),
            "grams":                  int(li.get("grams") or 0),
            "requires_shipping":      li.get("requires_shipping", True),
        }

        if fulfillable_qty == 0:
            # Already fulfilled by Shopify (digital/membership/auto-fulfilled) — no pick needed
            line_items.append({
                **base,
                "pick_sku":    None,
                "sku_mapped":  True,
                "mix_quantity": 1.0,
            })
        elif mappings:
            # Normal pick: expand bundle (one DB row per pick_sku mapping)
            for m in mappings:
                pick_sku = m.get("pick_sku")
                line_items.append({
                    **base,
                    "pick_sku":    pick_sku,
                    "sku_mapped":  bool(pick_sku),
                    "mix_quantity": m.get("mix_quantity") or 1.0,
                })
        else:
            # No mapping found — unmapped SKU; will trigger a hold
            line_items.append({
                **base,
                "pick_sku":    None,
                "sku_mapped":  False,
                "mix_quantity": 1.0,
            })

    return {"order": order, "line_items": line_items}
