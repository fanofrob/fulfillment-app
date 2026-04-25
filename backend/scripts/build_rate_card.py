"""
Build UPS rate card (Ground + Next Day Air) for zones 1-8 from origin 92028.
Weights 1-30 lbs. Outputs CSV and prints a formatted table.

Usage:
    python scripts/build_rate_card.py
"""
from __future__ import annotations

import os
import csv
import time
import requests
from base64 import b64encode
from pathlib import Path
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv(Path(__file__).parent.parent / ".env")

SS_API_KEY    = os.environ["SS_API_KEY"]
SS_API_SECRET = os.environ["SS_API_SECRET"]
AUTH_HEADER   = b64encode(f"{SS_API_KEY}:{SS_API_SECRET}".encode()).decode()

ORIGIN_ZIP  = "92028"
WEIGHTS     = list(range(1, 31))          # 1–30 lbs
SERVICES    = {
    "ups_ground":       "UPS Ground",
    "ups_next_day_air": "UPS Next Day Air",
}

# One representative destination zip per zone from 92028.
# Derived from zip_zones.csv (origin 92028) — first prefix per zone + "01" suffix.
ZONE_ZIPS = {
    1: "90001",   # Zone 1 – Los Angeles, CA  (prefix 900)
    2: "90301",   # Zone 2 – Inglewood, CA    (prefix 903)
    3: "91901",   # Zone 3 – Alpine, CA        (prefix 919)
    4: "84101",   # Zone 4 – Salt Lake City   (prefix 841)
    5: "59001",   # Zone 5 – Montana          (prefix 590)
    6: "51001",   # Zone 6 – Iowa             (prefix 510)
    7: "35401",   # Zone 7 – Alabama          (prefix 354)
    8: "00501",   # Zone 8 – New York (IRS)   (prefix 005)
}

RATES_URL = "https://ssapi.shipstation.com/shipments/getrates"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_rate(service_code: str, weight_lb: int, to_zip: str) -> float | None:
    """Return the rate in dollars for one service/weight/destination combo."""
    payload = {
        "carrierCode": "ups_walleted",
        "serviceCode": service_code,
        "packageCode": "package",
        "fromPostalCode": ORIGIN_ZIP,
        "toPostalCode": to_zip,
        "toCountry": "US",
        "weight": {"value": weight_lb, "units": "pounds"},
        "dimensions": {"units": "inches", "length": 12, "width": 12, "height": 12},
        "confirmation": "none",
        "residential": True,
    }
    headers = {
        "Authorization": f"Basic {AUTH_HEADER}",
        "Content-Type": "application/json",
    }
    resp = requests.post(RATES_URL, json=payload, headers=headers, timeout=15)
    if resp.status_code != 200:
        print(f"  [WARN] {service_code} {weight_lb}lb → {to_zip}: HTTP {resp.status_code} {resp.text[:120]}")
        return None

    rates = resp.json()
    for r in rates:
        if r.get("serviceCode") == service_code:
            return r.get("shipmentCost") or r.get("totalCost")

    # Service not available for this zone/weight
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    results = []   # list of dicts

    for svc_code, svc_label in SERVICES.items():
        print(f"\n{'='*60}")
        print(f"Fetching rates for {svc_label} ...")
        print(f"{'='*60}")

        for zone, dest_zip in sorted(ZONE_ZIPS.items()):
            print(f"  Zone {zone} ({dest_zip}):", end="", flush=True)
            for weight in WEIGHTS:
                rate = get_rate(svc_code, weight, dest_zip)
                results.append({
                    "service":     svc_label,
                    "service_code": svc_code,
                    "zone":        zone,
                    "dest_zip":    dest_zip,
                    "weight_lb":   weight,
                    "rate_usd":    rate,
                })
                print(".", end="", flush=True)
                time.sleep(0.15)   # gentle rate limiting
            print()

    # --- Write CSV -----------------------------------------------------------
    out_path = Path(__file__).parent.parent.parent / "data" / "ups_rate_card.csv"
    out_path.parent.mkdir(exist_ok=True)

    fieldnames = ["service", "zone", "dest_zip", "weight_lb", "rate_usd"]
    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in results:
            writer.writerow({k: row[k] for k in fieldnames})

    print(f"\nSaved → {out_path}")

    # --- Print summary table -------------------------------------------------
    print_summary(results)


def print_summary(results: list[dict]):
    for svc_code, svc_label in SERVICES.items():
        rows = [r for r in results if r["service_code"] == svc_code]
        if not rows:
            continue

        zones = sorted(set(r["zone"] for r in rows))
        print(f"\n{svc_label}  (origin {ORIGIN_ZIP})")
        header = f"{'Wt':>4}" + "".join(f"  Z{z:>2}" for z in zones)
        print(header)
        print("-" * len(header))

        for weight in WEIGHTS:
            line = f"{weight:>4}"
            for zone in zones:
                match = next((r for r in rows if r["zone"] == zone and r["weight_lb"] == weight), None)
                if match and match["rate_usd"] is not None:
                    line += f"  {match['rate_usd']:>4.0f}"
                else:
                    line += "    --"
            print(line)


if __name__ == "__main__":
    main()
