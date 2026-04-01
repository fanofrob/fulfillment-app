import os
import time
import requests
from base64 import b64encode
from datetime import date

from fastapi import APIRouter, Query, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Optional
from services import sheets_service
from database import get_db
from models import RateCard

router = APIRouter()


def _db_rate_to_dict(r: RateCard) -> dict:
    return {
        "carrier": r.carrier,
        "service_name": r.service_name,
        "weight_lb": r.weight_lb,
        "zone": r.zone,
        "rate": r.rate,
        "is_flat_rate": r.is_flat_rate,
        "effective_date": r.effective_date.isoformat() if r.effective_date else None,
        "notes": r.notes,
        "source": "db",
    }


@router.get("/")
def list_rate_cards(
    carrier: Optional[str] = Query(None),
    is_flat_rate: Optional[bool] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(2000, ge=1, le=5000),
    db: Session = Depends(get_db),
):
    # Fetch DB-stored rates (UPS and any non-Sheets carriers)
    q = db.query(RateCard)
    if carrier:
        q = q.filter(RateCard.carrier == carrier.upper())
    if is_flat_rate is not None:
        q = q.filter(RateCard.is_flat_rate == is_flat_rate)
    db_rates = [_db_rate_to_dict(r) for r in q.order_by(RateCard.carrier, RateCard.service_name, RateCard.zone, RateCard.weight_lb).all()]

    # Fetch Sheets-stored rates (USPS) — only if Sheets is configured and we're not filtering to a non-USPS carrier
    sheets_rates = []
    sheets_carrier_filter = carrier.upper() if carrier else None
    if sheets_service.is_configured() and (sheets_carrier_filter is None or sheets_carrier_filter == "USPS"):
        try:
            sheets_rates = sheets_service.get_rate_cards(
                carrier=carrier,
                is_flat_rate=is_flat_rate,
                skip=0,
                limit=limit,
            )
            for r in sheets_rates:
                r["source"] = "sheets"
        except Exception:
            pass  # Sheets unavailable — just return DB rates

    # Merge: DB rates first, then Sheets rates
    all_rates = db_rates + sheets_rates

    # Apply pagination
    return all_rates[skip: skip + limit]


@router.post("/refresh")
def refresh_rate_cache():
    sheets_service.invalidate("rate_cards")
    return {"status": "cache cleared"}


# ---------------------------------------------------------------------------
# UPS rate rebuild (fetches live rates from ShipStation and stores in DB)
# ---------------------------------------------------------------------------

_ORIGIN_ZIP = "92028"
_WEIGHTS = list(range(1, 31))
_SERVICES = {
    "ups_ground":       "UPS Ground",
    "ups_next_day_air": "UPS Next Day Air",
}
_ZONE_ZIPS = {
    1: "90001",
    2: "90301",
    3: "91901",
    4: "84101",
    5: "59001",
    6: "51001",
    7: "35401",
    8: "00501",
}
_RATES_URL = "https://ssapi.shipstation.com/shipments/getrates"


def _fetch_rate(service_code: str, weight_lb: int, to_zip: str, auth_header: str) -> float | None:
    payload = {
        "carrierCode": "ups_walleted",
        "serviceCode": service_code,
        "packageCode": "package",
        "fromPostalCode": _ORIGIN_ZIP,
        "toPostalCode": to_zip,
        "toCountry": "US",
        "weight": {"value": weight_lb, "units": "pounds"},
        "dimensions": {"units": "inches", "length": 12, "width": 12, "height": 12},
        "confirmation": "none",
        "residential": True,
    }
    headers = {"Authorization": f"Basic {auth_header}", "Content-Type": "application/json"}
    resp = requests.post(_RATES_URL, json=payload, headers=headers, timeout=15)
    if resp.status_code != 200:
        return None
    for r in resp.json():
        if r.get("serviceCode") == service_code:
            return r.get("shipmentCost") or r.get("totalCost")
    return None


@router.post("/rebuild-ups")
def rebuild_ups_rates(db: Session = Depends(get_db)):
    api_key = os.environ.get("SS_API_KEY")
    api_secret = os.environ.get("SS_API_SECRET")
    if not api_key or not api_secret:
        raise HTTPException(status_code=503, detail="SS_API_KEY / SS_API_SECRET not configured in .env")

    auth_header = b64encode(f"{api_key}:{api_secret}".encode()).decode()
    today = date.today()

    # Delete existing UPS rates
    deleted = db.query(RateCard).filter(RateCard.carrier == "UPS").delete()
    db.commit()

    inserted = 0
    errors = 0

    for svc_code, svc_label in _SERVICES.items():
        for zone, dest_zip in sorted(_ZONE_ZIPS.items()):
            for weight in _WEIGHTS:
                rate = _fetch_rate(svc_code, weight, dest_zip, auth_header)
                if rate is not None:
                    db.add(RateCard(
                        carrier="UPS",
                        service_name=svc_label,
                        weight_lb=float(weight),
                        zone=zone,
                        rate=rate,
                        is_flat_rate=False,
                        effective_date=today,
                    ))
                    inserted += 1
                else:
                    errors += 1
                time.sleep(0.15)
            db.commit()

    return {"deleted": deleted, "inserted": inserted, "errors": errors, "effective_date": today.isoformat()}
