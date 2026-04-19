"""
ShipStation service — integrates with ShipStation REST API v1.

Authentication: HTTP Basic auth using SS_API_KEY:SS_API_SECRET from .env.
Base URL: https://ssapi.shipstation.com

If credentials are not configured, all functions raise RuntimeError gracefully.
The router returns 503 so the UI can show "ShipStation not configured".
"""
import os
import requests
from base64 import b64encode
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Optional

SS_API_KEY    = os.getenv("SS_API_KEY", "").strip()
SS_API_SECRET = os.getenv("SS_API_SECRET", "").strip()
BASE_URL      = "https://ssapi.shipstation.com"

# Warehouse origin zip codes — override via env vars or auto-fetched from SS warehouses
WALNUT_FROM_ZIP    = os.getenv("WALNUT_FROM_ZIP", "").strip()
NORTHLAKE_FROM_ZIP = os.getenv("NORTHLAKE_FROM_ZIP", "").strip()

_warehouses_cache: Optional[List[Dict]] = None


def is_configured() -> bool:
    return bool(SS_API_KEY and SS_API_SECRET)


def _headers() -> dict:
    token = b64encode(f"{SS_API_KEY}:{SS_API_SECRET}".encode()).decode()
    return {
        "Authorization": f"Basic {token}",
        "Content-Type": "application/json",
    }


def get_status() -> dict:
    """Return connection status. Calls /account to verify credentials."""
    if not is_configured():
        return {"configured": False, "message": "SS_API_KEY and SS_API_SECRET not set in .env"}
    try:
        resp = requests.get(f"{BASE_URL}/stores", headers=_headers(), timeout=10)
        if resp.status_code == 200:
            return {"configured": True, "message": "ShipStation connected"}
        elif resp.status_code == 401:
            return {"configured": False, "message": "Invalid ShipStation credentials"}
        else:
            return {"configured": False, "message": f"ShipStation returned HTTP {resp.status_code}"}
    except requests.RequestException as e:
        return {"configured": False, "message": f"Connection error: {str(e)}"}


def push_order(order, line_items) -> dict:
    """
    Create an order in ShipStation from a ShopifyOrder + its line items.
    Returns the ShipStation order dict on success.
    Raises RuntimeError if not configured or API call fails.
    """
    if not is_configured():
        raise RuntimeError("ShipStation not configured")

    # Build ShipStation order payload
    ss_items = []
    seen_skus: dict[str, int] = {}  # pick_sku → index in ss_items for deduplication

    for li in line_items:
        if not li.sku_mapped or not li.pick_sku:
            continue
        qty = li.fulfillable_quantity if li.fulfillable_quantity is not None else li.quantity
        units = qty * (li.mix_quantity or 1.0)

        if li.pick_sku in seen_skus:
            ss_items[seen_skus[li.pick_sku]]["quantity"] += units
        else:
            idx = len(ss_items)
            seen_skus[li.pick_sku] = idx
            ss_items.append({
                "lineItemKey": li.line_item_id,
                "sku": li.pick_sku,
                "name": li.product_title or li.pick_sku,
                "quantity": units,
                "unitPrice": float(li.price or 0),
            })

    now = datetime.now(timezone.utc)
    custom_field_3 = now.strftime("%m/%d/%Y %H:%M")

    payload = {
        "orderNumber": order.shopify_order_number or str(order.shopify_order_id),
        "orderKey": order.shopify_order_id,
        "orderDate": order.created_at_shopify.isoformat() if order.created_at_shopify else now.isoformat(),
        "orderStatus": "awaiting_shipment",
        "billTo": {
            "name": order.customer_name or order.shipping_name or "",
            "street1": order.shipping_address1 or "",
            "street2": order.shipping_address2 or "",
            "city": order.shipping_city or "",
            "state": order.shipping_province or "",
            "postalCode": order.shipping_zip or "",
            "country": order.shipping_country or "US",
        },
        "shipTo": {
            "name": order.shipping_name or order.customer_name or "",
            "street1": order.shipping_address1 or "",
            "street2": order.shipping_address2 or "",
            "city": order.shipping_city or "",
            "state": order.shipping_province or "",
            "postalCode": order.shipping_zip or "",
            "country": order.shipping_country or "US",
            "residential": True,
        },
        "items": ss_items,
        "amountPaid": float(order.total_price or 0),
        "taxAmount": 0,
        "shippingAmount": 0,
        "customerEmail": order.customer_email or "",
        "customerNotes": order.note or "",
        "internalNotes": f"Shopify order {order.shopify_order_number}",
        "advancedOptions": {
            "customField3": custom_field_3,
        },
    }

    resp = requests.post(
        f"{BASE_URL}/orders/createorder",
        json=payload,
        headers=_headers(),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def get_shipments(ss_order_ids: List[str], days: int = 14) -> List[Dict]:
    """
    Fetch shipment info for a list of ShipStation order IDs.

    Two date-window calls cover all cases:
    1. GET /shipments?shipDateStart=<days ago> — catches label purchases
    2. GET /orders?orderStatus=shipped&modifyDateStart=<days ago> — catches
       "Mark as Shipped" manual entries which don't appear in /shipments

    Both calls are paginated but each returns at most a few pages regardless of
    how many order IDs are passed in. Orders not found in either window simply
    haven't shipped yet — no per-order fallback needed since any order that
    shipped more than `days` days ago would have been processed by a prior sync.
    """
    if not is_configured():
        raise RuntimeError("ShipStation not configured")
    if not ss_order_ids:
        return []

    target_ids = set(str(oid) for oid in ss_order_ids)
    ship_date_start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")

    all_shipments = []
    found_order_ids: set = set()

    # ── Pass 1: /shipments date window (label purchases) ─────────────────────
    page = 1
    while True:
        resp = requests.get(
            f"{BASE_URL}/shipments",
            params={
                "shipDateStart": ship_date_start,
                "includeShipmentItems": True,
                "pageSize": 500,
                "page": page,
            },
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        shipments = data.get("shipments", [])

        for s in shipments:
            order_id = str(s.get("orderId", ""))
            if order_id in target_ids:
                all_shipments.append(s)
                found_order_ids.add(order_id)

        total = data.get("total", 0)
        if page * 500 >= total or not shipments:
            break
        page += 1

    # ── Pass 2: /orders date window for "Mark as Shipped" entries ────────────
    # Only run if there are still unmatched IDs after pass 1.
    missing_ids = target_ids - found_order_ids
    if missing_ids:
        page = 1
        while True:
            resp = requests.get(
                f"{BASE_URL}/orders",
                params={
                    "orderStatus": "shipped",
                    "modifyDateStart": ship_date_start,
                    "pageSize": 500,
                    "page": page,
                },
                headers=_headers(),
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            orders = data.get("orders", [])

            for order in orders:
                order_id = str(order.get("orderId", ""))
                if order_id not in missing_ids:
                    continue
                tracking = order.get("trackingNumber") or order.get("advancedOptions", {}).get("trackingNumber")
                carrier = order.get("carrierCode")
                print(f"[get_shipments] mark-as-shipped order keys: {list(order.keys())}")
                print(f"[get_shipments] trackingNumber={order.get('trackingNumber')!r}, carrierCode={order.get('carrierCode')!r}, serviceCode={order.get('serviceCode')!r}, advancedOptions={order.get('advancedOptions')!r}")
                all_shipments.append({
                    "orderId": order_id,
                    "trackingNumber": tracking,
                    "carrierCode": carrier,
                    "estimatedDeliveryDate": order.get("shipDate"),
                    "voided": False,
                })
                found_order_ids.add(order_id)

            total = data.get("total", 0)
            if page * 500 >= total or not orders:
                break
            page += 1

    print(f"[get_shipments] found {len(found_order_ids)}/{len(target_ids)} order IDs in {days}-day window, returning {len(all_shipments)} shipments")
    return all_shipments


def push_box(order, box_number: int, box_items, weight_oz=None, box_type=None, carrier_code=None, service_code=None, shipping_provider_id=None) -> dict:
    """
    Create a ShipStation order for a single fulfillment box.
    box_items: list of BoxLineItem model objects.
    weight_oz: total shipment weight in oz (items + box tare), or None to omit.
    box_type: BoxType model object (for packageCode and dimensions), or None.
    shipping_provider_id: ShipStation shippingProviderId — required when multiple
        accounts share the same carrierCode (e.g. USPS wallet se-4946429 vs
        Stamps.com se-5337414). Sent as advancedOptions.billToMyOtherAccount.
    Order number is formatted as '<shopify_order_number>-Box<N>' so each box
    gets its own ShipStation entry with a distinct tracking number.
    Returns the ShipStation order dict.
    """
    if not is_configured():
        raise RuntimeError("ShipStation not configured")

    ss_items = []
    seen_skus: dict[str, int] = {}

    for item in box_items:
        if not item.pick_sku:
            continue
        if item.pick_sku in seen_skus:
            ss_items[seen_skus[item.pick_sku]]["quantity"] += int(item.quantity)
        else:
            idx = len(ss_items)
            seen_skus[item.pick_sku] = idx
            ss_items.append({
                "lineItemKey": str(item.id),
                "sku": item.pick_sku,
                "name": item.product_title or item.pick_sku,
                "quantity": int(item.quantity),
                "unitPrice": 0,
            })

    order_number = f"{order.shopify_order_number or order.shopify_order_id}-Box{box_number}"
    order_key = f"{order.shopify_order_id}-box{box_number}"

    now = datetime.now(timezone.utc)
    custom_field_3 = now.strftime("%m/%d/%Y %H:%M")

    payload = {
        "orderNumber": order_number,
        "orderKey": order_key,
        "orderDate": order.created_at_shopify.isoformat() if order.created_at_shopify else now.isoformat(),
        "orderStatus": "awaiting_shipment",
        "billTo": {
            "name": order.customer_name or order.shipping_name or "",
            "street1": order.shipping_address1 or "",
            "street2": order.shipping_address2 or "",
            "city": order.shipping_city or "",
            "state": order.shipping_province or "",
            "postalCode": order.shipping_zip or "",
            "country": order.shipping_country or "US",
        },
        "shipTo": {
            "name": order.shipping_name or order.customer_name or "",
            "street1": order.shipping_address1 or "",
            "street2": order.shipping_address2 or "",
            "city": order.shipping_city or "",
            "state": order.shipping_province or "",
            "postalCode": order.shipping_zip or "",
            "country": order.shipping_country or "US",
            "residential": True,
        },
        "items": ss_items,
        "amountPaid": 0,
        "taxAmount": 0,
        "shippingAmount": 0,
        "customerEmail": order.customer_email or "",
        "customerNotes": order.note or "",
        "internalNotes": f"Shopify {order.shopify_order_number} — Box {box_number}",
        "advancedOptions": {
            "customField3": custom_field_3,
            **({"billToMyOtherAccount": shipping_provider_id} if shipping_provider_id else {}),
        },
    }

    if weight_oz is not None:
        payload["weight"] = {"value": round(weight_oz, 2), "units": "ounces"}

    if carrier_code:
        payload["carrierCode"] = carrier_code
    if service_code:
        payload["serviceCode"] = service_code

    # Build requestedShippingService: "USPS — Priority Mail - Medium Flat Rate Box"
    CARRIER_CODE_DISPLAY = {"stamps_com": "USPS", "fedex": "FedEx", "ups_walleted": "UPS"}
    if box_type or service_code:
        carrier_display = ""
        if box_type and box_type.carrier:
            carrier_display = box_type.carrier
        elif carrier_code:
            carrier_display = CARRIER_CODE_DISPLAY.get(carrier_code, carrier_code)
        service_display = ""
        if service_code:
            svc = service_code
            for prefix in ("usps_", "fedex_", "ups_"):
                if svc.startswith(prefix):
                    svc = svc[len(prefix):]
                    break
            service_display = svc.replace("_", " ").title()
        # For carrier-specific boxes, show box name; for generic, show dimensions
        box_display = ""
        if box_type and box_type.carrier:
            box_display = box_type.name
        elif box_type and box_type.length_in and box_type.width_in and box_type.height_in:
            def _dim(v):
                return str(int(v)) if v == int(v) else str(v)
            box_display = f"{_dim(box_type.length_in)}x{_dim(box_type.width_in)}x{_dim(box_type.height_in)}"
        # Assemble: "USPS — Priority Mail - Medium Flat Rate Box"
        req_svc = carrier_display
        if service_display:
            req_svc = f"{req_svc} — {service_display}" if req_svc else service_display
        if box_display:
            req_svc = f"{req_svc} - {box_display}" if req_svc else box_display
        if req_svc:
            payload["requestedShippingService"] = req_svc

    if box_type and box_type.package_code:
        payload["packageCode"] = box_type.package_code
    if box_type and box_type.length_in and box_type.width_in and box_type.height_in:
        payload["dimensions"] = {
            "units": "inches",
            "length": box_type.length_in,
            "width": box_type.width_in,
            "height": box_type.height_in,
        }

    resp = requests.post(
        f"{BASE_URL}/orders/createorder",
        json=payload,
        headers=_headers(),
        timeout=30,
    )
    if not resp.ok:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        raise RuntimeError(f"ShipStation {resp.status_code}: {detail}")
    return resp.json()


def get_unshipped_orders() -> List[Dict]:
    """
    Fetch all orders from ShipStation that have NOT shipped yet.
    Paginates through all results. Returns list of order dicts with orderNumber and orderStatus.
    ShipStation statuses that mean "not shipped": awaiting_payment, awaiting_shipment, on_hold.
    """
    if not is_configured():
        raise RuntimeError("ShipStation not configured")

    all_orders = []
    for status in ("awaiting_payment", "awaiting_shipment", "on_hold"):
        page = 1
        while True:
            resp = requests.get(
                f"{BASE_URL}/orders",
                params={"orderStatus": status, "page": page, "pageSize": 500},
                headers=_headers(),
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            orders = data.get("orders", [])
            all_orders.extend(orders)
            total_pages = data.get("pages", 1)
            if page >= total_pages:
                break
            page += 1

    return all_orders


def cancel_order(shipstation_order_id: str) -> bool:
    """
    Void/cancel a ShipStation order by its SS order ID.
    Returns True on success, raises RuntimeError on failure.
    """
    if not is_configured():
        raise RuntimeError("ShipStation not configured")

    resp = requests.delete(
        f"{BASE_URL}/orders/{shipstation_order_id}",
        headers=_headers(),
        timeout=30,
    )
    if not resp.ok:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        raise RuntimeError(f"ShipStation {resp.status_code}: {detail}")
    return True


def _get_from_postal(warehouse: str) -> Optional[str]:
    """
    Return the origin postal code for a warehouse.
    Checks env vars first; falls back to the first SS warehouse record.
    """
    global _warehouses_cache

    env_map = {"walnut": WALNUT_FROM_ZIP, "northlake": NORTHLAKE_FROM_ZIP}
    if env_map.get(warehouse):
        return env_map[warehouse]

    # Fall back to SS warehouses API
    if not is_configured():
        return None
    try:
        if _warehouses_cache is None:
            resp = requests.get(f"{BASE_URL}/warehouses", headers=_headers(), timeout=10)
            resp.raise_for_status()
            _warehouses_cache = resp.json()
        if _warehouses_cache:
            return _warehouses_cache[0].get("originAddress", {}).get("postalCode")
    except Exception:
        pass
    return None


def get_rates(
    carrier_code: str,
    service_code: str,
    from_postal: str,
    to_postal: str,
    to_state: str,
    to_country: str,
    weight_oz: float,
    package_code: Optional[str] = None,
) -> dict:
    """
    Query ShipStation /shipments/getrates for a specific carrier+service.
    Returns {carrier_code, service_code, transit_days, estimated_delivery_date, shipment_cost}
    or raises RuntimeError on failure.
    """
    if not is_configured():
        raise RuntimeError("ShipStation not configured")

    payload = {
        "carrierCode": carrier_code,
        "serviceCode": service_code,
        "fromPostalCode": from_postal,
        "toState": to_state,
        "toPostalCode": to_postal,
        "toCountry": to_country or "US",
        "weight": {"value": round(max(weight_oz, 1.0), 2), "units": "ounces"},
        "residential": True,
        "confirmation": "none",
    }
    if package_code:
        payload["packageCode"] = package_code

    resp = requests.post(
        f"{BASE_URL}/shipments/getrates",
        json=payload,
        headers=_headers(),
        timeout=15,
    )
    if not resp.ok:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        raise RuntimeError(f"ShipStation getrates {resp.status_code}: {detail}")

    rates = resp.json()
    # Find the rate matching our service_code
    for rate in rates:
        if rate.get("serviceCode") == service_code:
            return {
                "carrier_code": carrier_code,
                "service_code": service_code,
                "transit_days": rate.get("transitDays"),
                "estimated_delivery_date": rate.get("deliveryDate"),
                "shipment_cost": rate.get("shipmentCost"),
            }
    # Fallback: return first rate if exact service not found
    if rates:
        r = rates[0]
        return {
            "carrier_code": carrier_code,
            "service_code": r.get("serviceCode", service_code),
            "transit_days": r.get("transitDays"),
            "estimated_delivery_date": r.get("deliveryDate"),
            "shipment_cost": r.get("shipmentCost"),
        }
    return {}


def sync_in_flight_orders(db) -> dict:
    """
    Poll ShipStation for all orders currently in 'in_shipstation_not_shipped' status.
    Update status to 'in_shipstation_shipped' when ShipStation confirms shipment.
    Returns summary: { synced, shipped, errors }

    NOTE: This function imports from routers to avoid circular imports.
    """
    if not is_configured():
        raise RuntimeError("ShipStation not configured")

    import models as m
    from routers.inventory import _auto_deduct_on_ship, _recompute_committed
    from datetime import datetime, timezone

    # Find all orders pushed to ShipStation but not yet marked shipped
    in_flight = db.query(m.ShopifyOrder).filter(
        m.ShopifyOrder.app_status == "in_shipstation_not_shipped",
        m.ShopifyOrder.shipstation_order_id.isnot(None),
    ).all()

    if not in_flight:
        return {"synced": 0, "shipped": 0, "errors": []}

    ss_order_ids = [o.shipstation_order_id for o in in_flight]
    id_to_order = {o.shipstation_order_id: o for o in in_flight}

    synced = 0
    shipped = 0
    errors = []

    try:
        shipments = get_shipments(ss_order_ids)
    except Exception as e:
        return {"synced": 0, "shipped": 0, "errors": [str(e)]}

    warehouses_to_recompute = set()

    for shipment in shipments:
        ss_order_id = str(shipment.get("orderId", ""))
        order = id_to_order.get(ss_order_id)
        if not order:
            continue

        tracking = shipment.get("trackingNumber")
        voided = shipment.get("voided", False)

        if voided:
            continue

        try:
            order.app_status = "in_shipstation_shipped"
            if tracking:
                order.tracking_number = tracking
            order.last_synced_at = datetime.now(timezone.utc)
            estimated_delivery = shipment.get("estimatedDeliveryDate")
            if estimated_delivery:
                try:
                    order.estimated_delivery_date = datetime.fromisoformat(estimated_delivery.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    pass

            _auto_deduct_on_ship(order, db)
            warehouses_to_recompute.add(order.assigned_warehouse)
            shipped += 1
        except Exception as e:
            errors.append(f"Order {order.shopify_order_number}: {str(e)}")

        synced += 1

    db.flush()
    for wh in warehouses_to_recompute:
        _recompute_committed(wh, db)
    db.commit()

    return {"synced": synced, "shipped": shipped, "errors": errors}
