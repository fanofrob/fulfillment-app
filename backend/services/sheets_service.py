"""
Google Sheets service — reads live data from GHF spreadsheets.
Requires credentials.json (service account) in the backend/ directory.
"""
import os
import time
import gspread
from google.oauth2.service_account import Credentials

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
]

SPREADSHEET_IDS = {
    "inventory":       "19-0HG0voqQkzBfiMwmCC05KE8pO4lQapvrnI_H7nWDY",
    "fruit_dashboard": "1Blls8QQsdWcOKgeJspyRtbSQ4e3BCpTUF1Rf9CXfgXY",
    "cogs_shipping":   "1IjZT0BMjIMV3r9-B2pMgtpcPIFgvIha-9HAxvsRs6ng",
}

CREDENTIALS_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "credentials.json")

CACHE_TTL = 300  # 5 minutes
_cache: dict = {}
_client = None


def _get_client():
    global _client
    if _client is None:
        if not os.path.exists(CREDENTIALS_PATH):
            raise FileNotFoundError(
                f"credentials.json not found at {CREDENTIALS_PATH}. "
                "Please follow setup instructions to create a Google service account."
            )
        creds = Credentials.from_service_account_file(CREDENTIALS_PATH, scopes=SCOPES)
        _client = gspread.authorize(creds)
    return _client


def _cached(key: str, fetch_fn):
    now = time.time()
    if key in _cache and now - _cache[key]["ts"] < CACHE_TTL:
        return _cache[key]["data"]
    data = fetch_fn()
    _cache[key] = {"data": data, "ts": now}
    return data


def invalidate(key: str = None):
    global _cache
    if key:
        _cache.pop(key, None)
    else:
        _cache.clear()


def _parse_float(val):
    if val is None or str(val).strip() in ("", "#ERROR", "#VALUE!", "#REF!", "#N/A", "#ERROR!"):
        return None
    try:
        return float(str(val).replace("$", "").replace(",", "").replace("%", "").strip())
    except Exception:
        return None


def _row_get(row: dict, *keys) -> str | None:
    """Case-insensitive column lookup — tries each key name in order."""
    normalized = {k.lower().strip(): v for k, v in row.items()}
    for key in keys:
        val = normalized.get(key.lower().strip())
        if val is not None and str(val).strip() not in ("", "#ERROR", "#VALUE!", "#REF!", "#N/A", "#ERROR!"):
            return val
    return None


def _parse_date(val):
    if not val or str(val).strip() == "":
        return None
    from datetime import datetime
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y", "%-m/%-d/%Y"):
        try:
            return datetime.strptime(str(val).strip(), fmt).date().isoformat()
        except Exception:
            pass
    return str(val).strip()


# ── SKU Mappings ──────────────────────────────────────────────────────────────


class CaseInsensitiveSkuDict(dict):
    """Dict with case-insensitive string-key lookups.

    Iteration preserves the original-case key as first inserted. `get`, `[]`,
    `in`, and `__delitem__` fold case before matching. Used for SKU lookups
    because Shopify may return a SKU with different casing than the Sheet row.
    """

    def __init__(self):
        super().__init__()
        self._ci: dict[str, str] = {}

    def __setitem__(self, key, value):
        if isinstance(key, str):
            prior = self._ci.get(key.lower())
            if prior is not None and prior != key:
                super().__delitem__(prior)
            self._ci[key.lower()] = key
        super().__setitem__(key, value)

    def __getitem__(self, key):
        if isinstance(key, str):
            actual = self._ci.get(key.lower())
            if actual is None:
                raise KeyError(key)
            return super().__getitem__(actual)
        return super().__getitem__(key)

    def __contains__(self, key):
        if isinstance(key, str):
            return key.lower() in self._ci
        return super().__contains__(key)

    def __delitem__(self, key):
        if isinstance(key, str):
            actual = self._ci.pop(key.lower(), None)
            if actual is None:
                raise KeyError(key)
            super().__delitem__(actual)
        else:
            super().__delitem__(key)

    def get(self, key, default=None):
        if isinstance(key, str):
            actual = self._ci.get(key.lower())
            if actual is None:
                return default
            return super().__getitem__(actual)
        return super().get(key, default)


def get_sku_mappings(warehouse: str, search: str = None, skip: int = 0, limit: int = 50, errors_only: bool = False):
    tab_names = {
        "walnut":    "INPUT_bundles_cvr_walnut",
        "northlake": "INPUT_bundles_cvr_northlake",
    }
    tab = tab_names.get(warehouse)
    if not tab:
        return []

    def fetch():
        client = _get_client()
        ws = client.open_by_key(SPREADSHEET_IDS["inventory"]).worksheet(tab)
        rows = ws.get_all_records(expected_headers=["shopifysku2", "picklist sku"])
        result = []
        for i, row in enumerate(rows):
            sku = str(_row_get(row, "shopifysku2") or "").strip()
            if not sku or sku == "shopifysku2":
                continue
            pick_sku = str(_row_get(row, "picklist sku") or "").strip() or None
            mix_qty = _parse_float(_row_get(row, "actualqty")) or 1.0
            # Compute data-quality errors for this row
            errors = []
            if not pick_sku:
                errors.append("missing_pick_sku")
            if mix_qty <= 0:
                errors.append("invalid_mix_qty")
            result.append({
                "id": i + 1,
                "_row": i + 2,  # 1-indexed sheet row (header = row 1)
                "warehouse": warehouse,
                "shopify_sku": sku,
                "pick_sku": pick_sku,
                "mix_quantity": mix_qty,
                "product_type": str(_row_get(row, "Product Type") or "").strip() or None,
                "pick_type": str(_row_get(row, "Pick Type") or "").strip() or None,
                "pick_weight_lb": _parse_float(_row_get(row, "Pick Weight LB")),
                "lineitem_weight": _parse_float(_row_get(row, "Lineitem Weight")),
                "shop_status": str(_row_get(row, "Shop Status") or "").strip() or None,
                "is_active": str(_row_get(row, "Shop Status") or "").strip() != "Inactive",
                "errors": errors,
                "notes": None,
                "created_at": None,
                "updated_at": None,
            })
        return result

    all_rows = _cached(f"sku_{warehouse}", fetch)

    if search:
        s = search.lower()
        all_rows = [r for r in all_rows if s in r["shopify_sku"].lower()
                    or (r["pick_sku"] and s in r["pick_sku"].lower())]

    if errors_only:
        all_rows = [r for r in all_rows if r.get("errors")]

    return all_rows[skip: skip + limit]


def get_sku_mappings_both(search: str = None, skip: int = 0, limit: int = 50, errors_only: bool = False):
    """Return mappings from both warehouses, interleaved by shopify_sku."""
    walnut = get_sku_mappings("walnut", search=search, skip=0, limit=10000, errors_only=errors_only)
    northlake = get_sku_mappings("northlake", search=search, skip=0, limit=10000, errors_only=errors_only)
    combined = walnut + northlake
    combined.sort(key=lambda r: (r["shopify_sku"], r["warehouse"]))
    return combined[skip: skip + limit]


# ── Period-Specific SKU Mappings ──────────────────────────────────────────────

def get_period_sku_mappings(tab_name: str, search: str = None, skip: int = 0, limit: int = 50):
    """
    Read SKU mappings from a period-specific Google Sheets tab.
    Tab name is stored on the projection_period record (e.g. "Period 1 SKU Mapping").
    Uses the same spreadsheet and column format as the default bundles_cvr tabs.
    """
    if not tab_name:
        return []

    def fetch():
        client = _get_client()
        ws = client.open_by_key(SPREADSHEET_IDS["inventory"]).worksheet(tab_name)
        rows = ws.get_all_records(expected_headers=["shopifysku2", "picklist sku"])
        result = []
        for i, row in enumerate(rows):
            sku = str(_row_get(row, "shopifysku2") or "").strip()
            if not sku or sku == "shopifysku2":
                continue
            pick_sku = str(_row_get(row, "picklist sku") or "").strip() or None
            mix_qty = _parse_float(_row_get(row, "actualqty")) or 1.0
            result.append({
                "id": i + 1,
                "_row": i + 2,
                "shopify_sku": sku,
                "pick_sku": pick_sku,
                "mix_quantity": mix_qty,
                "product_type": str(_row_get(row, "Product Type") or "").strip() or None,
                "pick_type": str(_row_get(row, "Pick Type") or "").strip() or None,
                "pick_weight_lb": _parse_float(_row_get(row, "Pick Weight LB")),
                "lineitem_weight": _parse_float(_row_get(row, "Lineitem Weight")),
                "shop_status": str(_row_get(row, "Shop Status") or "").strip() or None,
                "is_active": str(_row_get(row, "Shop Status") or "").strip() != "Inactive",
            })
        return result

    all_rows = _cached(f"period_sku_{tab_name}", fetch)

    if search:
        s = search.lower()
        all_rows = [r for r in all_rows if s in r["shopify_sku"].lower()
                    or (r["pick_sku"] and s in r["pick_sku"].lower())]

    return all_rows[skip: skip + limit]


def get_period_sku_mapping_lookup(tab_name: str) -> dict:
    """
    Returns {shopify_sku: [{"pick_sku": str, "mix_quantity": float, "product_type": str}, ...]}
    for a period-specific Google Sheets tab. Mirrors get_sku_mapping_lookup() but preserves
    the product_type field needed by the projection engine.
    """
    rows = get_period_sku_mappings(tab_name, skip=0, limit=100000)
    result = CaseInsensitiveSkuDict()
    for r in rows:
        sku = r.get("shopify_sku")
        if not sku:
            continue
        if sku not in result:
            result[sku] = []
        result[sku].append({
            "pick_sku": r["pick_sku"],
            "mix_quantity": r.get("mix_quantity") or 1.0,
            "product_type": r.get("product_type"),
        })
    return result


def list_sheet_tabs():
    """List all worksheet tab names in the inventory spreadsheet."""
    try:
        client = _get_client()
        spreadsheet = client.open_by_key(SPREADSHEET_IDS["inventory"])
        return [ws.title for ws in spreadsheet.worksheets()]
    except Exception:
        return []


# ── COGS ──────────────────────────────────────────────────────────────────────

def get_cogs(product_type_search: str = None, skip: int = 0, limit: int = 200):
    def fetch():
        client = _get_client()
        ws = client.open_by_key(SPREADSHEET_IDS["fruit_dashboard"]).worksheet("Fruit cost")
        rows = ws.get_all_records()
        result = []
        seen = set()
        for i, row in enumerate(rows):
            pt = str(row.get("Product Type", "")).strip()
            price = _parse_float(row.get("Price per lb"))
            date_val = _parse_date(row.get("Date Placed"))
            if not pt or price is None:
                continue
            key = (pt, date_val)
            if key in seen:
                continue
            seen.add(key)
            result.append({
                "id": i + 1,
                "_row": i + 2,
                "product_type": pt,
                "price_per_lb": price,
                "effective_date": date_val,
                "vendor": str(row.get("Aggregator / Vendor", "")).strip() or None,
                "invoice_number": str(row.get("Invoice #", "")).strip() or None,
                "notes": None,
                "created_at": None,
                "updated_at": None,
            })
        return result

    all_rows = _cached("cogs", fetch)

    if product_type_search:
        s = product_type_search.lower()
        all_rows = [r for r in all_rows if s in r["product_type"].lower()]

    return all_rows[skip: skip + limit]


def append_cogs_row(product_type: str, price_per_lb: float, effective_date: str,
                    vendor: str = None, invoice_number: str = None):
    """Append a new COGS entry to the Fruit cost tab."""
    client = _get_client()
    ws = client.open_by_key(SPREADSHEET_IDS["fruit_dashboard"]).worksheet("Fruit cost")
    ws.append_row([effective_date, invoice_number or "", vendor or "",
                   product_type, "", "", "", "", "", "", "", "", "", "", price_per_lb])
    invalidate("cogs")


# ── Rate Cards ────────────────────────────────────────────────────────────────

def get_rate_cards(carrier: str = None, is_flat_rate: bool = None, skip: int = 0, limit: int = 500):
    def fetch():
        from datetime import date
        effective = date(2026, 1, 1).isoformat()

        client = _get_client()
        ws = client.open_by_key(SPREADSHEET_IDS["cogs_shipping"]).worksheet("2026 USPS")
        all_values = ws.get_all_values()

        FLAT_RATE_MAP = {
            "Flat Rate Envelopes": "USPS Flat Rate Envelope",
            "Legal Flat Rate Envelope": "USPS Legal Flat Rate Envelope",
            "Padded Flat Rate Envelope": "USPS Padded Flat Rate Envelope",
            "Small Flat Rate Box": "USPS Small Flat Rate Box",
            "Medium Flat Rate Boxes": "USPS Medium Flat Rate Box",
            "Large Flat Rate Boxes": "USPS Large Flat Rate Box",
            "Military Large Flat Rate Boxes": "USPS Military Large Flat Rate Box",
        }

        # Find zone column map from header rows
        zone_cols = {}
        for row in all_values[:6]:
            for j, cell in enumerate(row):
                for z in range(1, 10):
                    if str(cell).strip() == f"Zone {z}":
                        zone_cols[z] = j
            if zone_cols:
                break

        result = []
        idx = 1
        for row in all_values:
            label = str(row[0]).strip()
            if label in FLAT_RATE_MAP:
                rate = _parse_float(row[zone_cols[1]] if zone_cols else row[2])
                if rate is not None:
                    result.append({"id": idx, "carrier": "USPS",
                                   "service_name": FLAT_RATE_MAP[label],
                                   "weight_lb": None, "zone": None,
                                   "rate": rate, "is_flat_rate": True,
                                   "effective_date": effective, "notes": None})
                    idx += 1
            elif label.endswith(" lb") or label.endswith(" lbs"):
                try:
                    weight = float(label.replace(" lbs", "").replace(" lb", "").strip())
                except Exception:
                    continue
                for z, col in zone_cols.items():
                    if col < len(row):
                        rate = _parse_float(row[col])
                        if rate is not None:
                            result.append({"id": idx, "carrier": "USPS",
                                           "service_name": "USPS Priority Mail",
                                           "weight_lb": weight, "zone": z,
                                           "rate": rate, "is_flat_rate": False,
                                           "effective_date": effective, "notes": None})
                            idx += 1
        return result

    all_rows = _cached("rate_cards", fetch)
    if carrier:
        all_rows = [r for r in all_rows if r["carrier"] == carrier]
    if is_flat_rate is not None:
        all_rows = [r for r in all_rows if r["is_flat_rate"] == is_flat_rate]
    return all_rows[skip: skip + limit]


# ── Picklist SKU ──────────────────────────────────────────────────────────────

def pull_picklist_skus() -> list:
    """
    Pull full picklist SKU data from INPUT_picklist_sku tab.
    Uses row 1 as column headers, skips row 2, data from row 3 onwards.
    Returns a list of dicts with all recognised columns.
    """
    client = _get_client()
    ws = client.open_by_key(SPREADSHEET_IDS["inventory"]).worksheet("INPUT_picklist_sku")
    all_values = ws.get_all_values()
    if len(all_values) < 3:
        return []

    headers = [h.strip() for h in all_values[0]]  # Row 1 = column names

    def _col(row_dict, *names):
        for n in names:
            v = row_dict.get(n, "").strip()
            if v:
                return v
        return None

    result = []
    for raw_row in all_values[2:]:  # skip header + sub-header row
        if not any(raw_row):
            continue
        row = {headers[i]: raw_row[i].strip() if i < len(raw_row) else "" for i in range(len(headers))}
        pick_sku = _col(row, "picklist sku", "Picklist SKU", "PICKLIST SKU")
        if not pick_sku:
            continue
        result.append({
            "pick_sku": pick_sku,
            "customer_description": _col(row, "Customer Description"),
            "weight_lb": _parse_float(_col(row, "Weight (lbs)", "Weight(lbs)", "Weight")),
            "pactor_multiplier": _parse_float(_col(row, "Pactor Multiplier")),
            "pactor": _parse_float(_col(row, "Pactor")),
            "temperature": _col(row, "Temperature"),
            "type": _col(row, "Pick Type"),
            "status": _col(row, "Status"),
            "cc_item_id": _col(row, "CC Item ID"),
        })
    return result


def pull_blended_product_margins() -> dict:
    """
    Pull BLENDED PRODUCT MARGIN tab from fruit_dashboard spreadsheet.
    Returns a dict mapping Product Type → cost_per_lb (float).
    Skips rows with $0.00 cost (category headers).
    """
    import re
    client = _get_client()
    ws = client.open_by_key(SPREADSHEET_IDS["fruit_dashboard"]).worksheet("BLENDED PRODUCT MARGIN")
    all_values = ws.get_all_values()
    margin_map = {}
    for row in all_values[1:]:  # skip header row
        if not any(row):
            continue
        product_type = row[0].strip()
        cost_str = row[4].strip() if len(row) > 4 else ""
        if not product_type or not cost_str:
            continue
        val = re.sub(r"[^\d.]", "", cost_str)
        if val:
            cost = float(val)
            if cost > 0:
                margin_map[product_type] = cost
    return margin_map


# ── Package Table ─────────────────────────────────────────────────────────────

def get_package_rules(weight_lb: int = None, zone: int = None):
    def fetch():
        client = _get_client()
        ws = client.open_by_key(SPREADSHEET_IDS["cogs_shipping"]).worksheet("Package Table")
        all_values = ws.get_all_values()
        # Row 0: empty + "Zone"; Row 1: "Weight", 1..8
        header = all_values[1] if len(all_values) > 1 else []
        zone_cols = {}
        for j, cell in enumerate(header):
            try:
                z = int(str(cell).strip())
                zone_cols[z] = j
            except Exception:
                pass
        result = []
        idx = 1
        for row in all_values[2:]:
            if not row:
                continue
            try:
                w = int(str(row[0]).strip())
            except Exception:
                continue
            for z, col in zone_cols.items():
                if col < len(row):
                    pkg = str(row[col]).strip()
                    if pkg:
                        result.append({"id": idx, "weight_lb": w, "zone": z,
                                       "package_type": pkg,
                                       "created_at": None, "updated_at": None})
                        idx += 1
        return result

    all_rows = _cached("package_rules", fetch)
    if weight_lb is not None:
        all_rows = [r for r in all_rows if r["weight_lb"] == weight_lb]
    if zone is not None:
        all_rows = [r for r in all_rows if r["zone"] == zone]
    return all_rows


# ── Inventory ─────────────────────────────────────────────────────────────────

def get_inventory(warehouse: str = None):
    """
    Pull current inventory from RAW_cc_inventory tab.
    Columns: WarehouseName, ItemId, Sku, Name, Type, BatchCode, AvailableQty, DaysOnHand
    Sku column = Pick SKU.
    Optionally filtered by warehouse (case-insensitive substring of WarehouseName).
    """
    cache_key = f"inventory_{warehouse or 'all'}"

    def fetch():
        client = _get_client()
        ws = client.open_by_key(SPREADSHEET_IDS["inventory"]).worksheet("RAW_cc_inventory")
        rows = ws.get_all_records()
        result = []
        for row in rows:
            sku = str(row.get("Sku", "")).strip()
            if not sku:
                continue
            available = _parse_float(row.get("AvailableQty"))
            if available is None:
                available = 0.0
            result.append({
                "warehouse_name": str(row.get("WarehouseName", "")).strip() or None,
                "item_id":        str(row.get("ItemId", "")).strip() or None,
                "pick_sku":       sku,
                "name":           str(row.get("Name", "")).strip() or None,
                "type":           str(row.get("Type", "")).strip() or None,
                "batch_code":     str(row.get("BatchCode", "")).strip() or None,
                "available_qty":  available,
                "days_on_hand":   _parse_float(row.get("DaysOnHand")),
            })
        return result

    all_rows = _cached(cache_key, fetch)

    if warehouse:
        wh_lower = warehouse.lower()
        all_rows = [r for r in all_rows if r["warehouse_name"] and wh_lower in r["warehouse_name"].lower()]

    return all_rows


def _fetch_sku_type_data() -> dict:
    """
    Read INPUT_SKU_TYPE tab once and return both:
      - helper_map:    {shopify_sku: helper_sku}  — rows where helper differs from SKU
      - no_bundle_set: {shopify_sku}               — rows where Bundle Needed = FALSE
    Uses get_all_values() to avoid gspread duplicate-header errors.
    Header is on row 2 (index 1); data starts on row 3 (index 2).
    """
    def fetch():
        client = _get_client()
        ws = client.open_by_key(SPREADSHEET_IDS["inventory"]).worksheet("INPUT_SKU_TYPE")
        all_values = ws.get_all_values()
        if not all_values or len(all_values) < 2:
            return {"helper_map": CaseInsensitiveSkuDict(), "no_bundle_set": set()}

        header = [str(h).strip().lower() for h in all_values[1]]

        try:
            sku_col = header.index("sku")
        except ValueError:
            print("[WARN] INPUT_SKU_TYPE: 'SKU' column not found in header row")
            return {"helper_map": CaseInsensitiveSkuDict(), "no_bundle_set": set()}

        helper_col    = next((i for i, h in enumerate(header) if h == "sku helper"),    None)
        bundle_col    = next((i for i, h in enumerate(header) if h == "bundle needed"), None)

        helper_map    = CaseInsensitiveSkuDict()
        no_bundle_set = set()

        for row in all_values[2:]:
            sku = str(row[sku_col]).strip() if sku_col < len(row) else ""
            if not sku:
                continue
            if helper_col is not None and helper_col < len(row):
                helper = str(row[helper_col]).strip()
                if helper and helper != sku:
                    helper_map[sku] = helper
            if bundle_col is not None and bundle_col < len(row):
                if str(row[bundle_col]).strip().upper() == "FALSE":
                    no_bundle_set.add(sku)

        return {"helper_map": helper_map, "no_bundle_set": no_bundle_set}

    return _cached("sku_type_data", fetch)


def get_sku_type_helper_map() -> dict:
    return _fetch_sku_type_data()["helper_map"]


def get_no_bundle_skus() -> set:
    return _fetch_sku_type_data()["no_bundle_set"]


def get_sku_mapping_lookup(warehouse: str) -> dict:
    """
    Returns {shopify_sku: [{"pick_sku": str, "mix_quantity": float}, ...]} for fast O(1) lookup.
    A single Shopify SKU may map to multiple pick SKUs (bundle), so each value is a list.

    Applies a two-step resolution:
      1. shopify_sku → helper_sku  (via INPUT_SKU_TYPE "SKU Helper" column)
      2. helper_sku  → pick_sku    (via INPUT_bundles_cvr_* "picklist sku" column)

    If a shopify_sku already has a direct entry in the bundles_cvr table it is used as-is.
    If not, the helper indirection is applied so that all variant SKUs that share a helper
    inherit the same pick_sku mapping without needing their own row in the bundles table.
    """
    rows = get_sku_mappings(warehouse, skip=0, limit=100000)
    result = CaseInsensitiveSkuDict()
    for r in rows:
        sku = r.get("shopify_sku")
        if not sku:
            continue
        if sku not in result:
            result[sku] = []
        result[sku].append({
            "pick_sku": r["pick_sku"],
            "mix_quantity": r.get("mix_quantity") or 1.0,
        })

    # Apply SKU type data from INPUT_SKU_TYPE (helper indirection + no-bundle flags).
    try:
        sku_type = _fetch_sku_type_data()

        # 1. Helper indirection: variant SKU → helper SKU → pick SKU
        for shopify_sku, helper_sku in sku_type["helper_map"].items():
            if shopify_sku not in result and helper_sku in result:
                result[shopify_sku] = result[helper_sku]

        # 2. No-bundle SKUs: Bundle Needed = FALSE → mark as intentionally no pick
        for sku in sku_type["no_bundle_set"]:
            if sku not in result:
                result[sku] = [{"pick_sku": None, "mix_quantity": 1.0, "no_bundle": True}]
    except Exception as e:
        import traceback
        print(f"[WARN] SKU type data failed, skipping indirection: {e}")
        traceback.print_exc()

    return result


def is_configured() -> bool:
    return os.path.exists(CREDENTIALS_PATH)
