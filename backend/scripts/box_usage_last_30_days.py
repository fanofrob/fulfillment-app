"""
One-off: pull shipped boxes from ShipStation for the last 30 days and
group by dimensions. Excludes voided (canceled) shipments.
"""
import os
import sys
from base64 import b64encode
from datetime import datetime, timezone, timedelta
from collections import Counter, defaultdict

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

SS_API_KEY = os.getenv("SS_API_KEY", "").strip()
SS_API_SECRET = os.getenv("SS_API_SECRET", "").strip()
BASE = "https://ssapi.shipstation.com"

if not (SS_API_KEY and SS_API_SECRET):
    raise SystemExit("Missing SS_API_KEY / SS_API_SECRET in .env")

token = b64encode(f"{SS_API_KEY}:{SS_API_SECRET}".encode()).decode()
HEADERS = {"Authorization": f"Basic {token}", "Content-Type": "application/json"}

DAYS = 30
end_dt = datetime.now(timezone.utc)
start_dt = end_dt - timedelta(days=DAYS)
ship_date_start = start_dt.strftime("%Y-%m-%d")
ship_date_end = end_dt.strftime("%Y-%m-%d")

print(f"Window: {ship_date_start} → {ship_date_end} (UTC)")

dim_counter = Counter()
voided_counter = Counter()
package_code_counter = Counter()
total_seen = 0
voided_total = 0

page = 1
while True:
    resp = requests.get(
        f"{BASE}/shipments",
        params={
            "shipDateStart": ship_date_start,
            "shipDateEnd": ship_date_end,
            "pageSize": 500,
            "page": page,
        },
        headers=HEADERS,
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    shipments = data.get("shipments", [])
    total = data.get("total", 0)
    total_pages = data.get("pages", 1)
    if page == 1:
        print(f"Total shipments in window (incl. voided): {total} across {total_pages} pages")

    for s in shipments:
        total_seen += 1
        dims = s.get("dimensions") or {}
        L, W, H = dims.get("length"), dims.get("width"), dims.get("height")
        pkg = s.get("packageCode")

        if s.get("voided"):
            voided_total += 1
            if L is not None and W is not None and H is not None:
                key = f"{L}x{W}x{H}"
                voided_counter[key] += 1
            continue

        if L is not None and W is not None and H is not None:
            key = f"{int(L) if float(L).is_integer() else L}x{int(W) if float(W).is_integer() else W}x{int(H) if float(H).is_integer() else H}"
            dim_counter[key] += 1
        else:
            dim_counter["(no dimensions)"] += 1

        if pkg:
            package_code_counter[pkg] += 1

    if page >= total_pages or not shipments:
        break
    page += 1

print()
print(f"Shipped (non-voided) shipments: {total_seen - voided_total}")
print(f"Voided shipments: {voided_total}")
print()
print("=" * 60)
print("Non-voided shipments grouped by dimensions:")
print("=" * 60)
for key, n in sorted(dim_counter.items(), key=lambda x: -x[1]):
    print(f"  {key:>20s}  {n:>5d}")

print()
print("=" * 60)
print("Voided shipments grouped by dimensions (for reference):")
print("=" * 60)
for key, n in sorted(voided_counter.items(), key=lambda x: -x[1]):
    print(f"  {key:>20s}  {n:>5d}")

print()
print("=" * 60)
print("Non-voided shipments grouped by ShipStation packageCode:")
print("=" * 60)
for key, n in sorted(package_code_counter.items(), key=lambda x: -x[1]):
    print(f"  {key:>30s}  {n:>5d}")

print()
print("=" * 60)
print("Target box sizes — non-voided counts:")
print("=" * 60)
targets = ["8x8x8", "10x10x10", "12x12x12"]
for t in targets:
    print(f"  {t:>10s}: {dim_counter.get(t, 0)}")
