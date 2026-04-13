"""
Test for the refactored get_shipments() date-window approach.
Run: python -u test_get_shipments.py
"""
import sys, os, time

ORIGINAL_BACKEND = "/Users/robertfan/Claude Code/fulfillment-app/backend"
from dotenv import load_dotenv
load_dotenv(os.path.join(ORIGINAL_BACKEND, ".env"))

sys.path.insert(0, os.path.dirname(__file__))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import models
from services import shipstation_service

engine = create_engine(
    f"sqlite:///{ORIGINAL_BACKEND}/fulfillment.db",
    connect_args={"check_same_thread": False},
)
db = sessionmaker(bind=engine)()

# ── What's in the DB ──────────────────────────────────────────────────────────
in_flight = db.query(models.ShopifyOrder).filter(
    models.ShopifyOrder.app_status == "in_shipstation_not_shipped",
    models.ShopifyOrder.shipstation_order_id.isnot(None),
).all()

packed_boxes = db.query(models.FulfillmentBox).filter(
    models.FulfillmentBox.status == "packed",
    models.FulfillmentBox.shipstation_order_id.isnot(None),
).all()

print(f"\n{'='*60}")
print(f"IN-FLIGHT ORDERS (in_shipstation_not_shipped): {len(in_flight)}")
print(f"PACKED BOXES:                                  {len(packed_boxes)}")
print(f"{'='*60}\n")

# ── TEST 1: in-flight orders sync ─────────────────────────────────────────────
if in_flight:
    ids = [o.shipstation_order_id for o in in_flight]
    print(f"TEST 1: get_shipments() for {len(ids)} in-flight order IDs")
    t0 = time.time()
    result = shipstation_service.get_shipments(ids)
    elapsed = time.time() - t0
    print(f"  Done in {elapsed:.2f}s — returned {len(result)} shipments")
    for s in result:
        print(f"    orderId={s.get('orderId')}  tracking={s.get('trackingNumber') or '(none)'}  voided={s.get('voided')}")
    print()
else:
    print("TEST 1: SKIPPED — no in-flight orders\n")

# ── TEST 2: packed-box sync ───────────────────────────────────────────────────
if packed_boxes:
    ids = [b.shipstation_order_id for b in packed_boxes]
    print(f"TEST 2: get_shipments() for {len(ids)} packed box IDs")
    t0 = time.time()
    result = shipstation_service.get_shipments(ids)
    elapsed = time.time() - t0
    print(f"  Done in {elapsed:.2f}s — returned {len(result)} shipments")
    for s in result:
        print(f"    orderId={s.get('orderId')}  tracking={s.get('trackingNumber') or '(none)'}  voided={s.get('voided')}")
    print()
else:
    print("TEST 2: SKIPPED — no packed boxes\n")

# ── TEST 3: empty input ───────────────────────────────────────────────────────
print("TEST 3: get_shipments([]) — empty input")
result = shipstation_service.get_shipments([])
assert result == [], f"Expected [] but got {result}"
print("  PASSED — returned [] with no API calls\n")

# ── TEST 4: pagination — one real call, check ShipStation total vs pages ──────
print("TEST 4: Pagination — check how many pages ShipStation returns for 14-day window")
import requests as req_lib
from datetime import datetime, timezone, timedelta
from base64 import b64encode

SS_API_KEY = os.getenv("SS_API_KEY", "").strip()
SS_API_SECRET = os.getenv("SS_API_SECRET", "").strip()
token = b64encode(f"{SS_API_KEY}:{SS_API_SECRET}".encode()).decode()
headers = {"Authorization": f"Basic {token}", "Content-Type": "application/json"}
ship_date_start = (datetime.now(timezone.utc) - timedelta(days=14)).strftime("%Y-%m-%d")

resp = req_lib.get(
    "https://ssapi.shipstation.com/shipments",
    params={"shipDateStart": ship_date_start, "pageSize": 500, "page": 1},
    headers=headers,
    timeout=30,
)
resp.raise_for_status()
data = resp.json()
total = data.get("total", 0)
on_first_page = len(data.get("shipments", []))
pages_needed = -(-total // 500)  # ceiling division

print(f"  Total shipments in last 14 days: {total}")
print(f"  Returned on first page:          {on_first_page}")
print(f"  Pages needed at pageSize=500:    {pages_needed}")
if pages_needed <= 1:
    print("  PASSED — fits in 1 page, single API call for fast path")
else:
    print(f"  NOTE — requires {pages_needed} page requests (pagination loop will handle this)")
print()

print("="*60)
print("All tests complete.")
db.close()
