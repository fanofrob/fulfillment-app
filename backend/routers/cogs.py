from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from pydantic import BaseModel
from services import sheets_service

router = APIRouter()


class CogsAppend(BaseModel):
    product_type: str
    price_per_lb: float
    effective_date: str
    vendor: Optional[str] = None
    invoice_number: Optional[str] = None
    notes: Optional[str] = None


@router.get("/")
def list_cogs(
    product_type: Optional[str] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
):
    if not sheets_service.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured yet. Add credentials.json to the backend folder.")
    try:
        return sheets_service.get_cogs(product_type_search=product_type, skip=skip, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
def append_cogs(payload: CogsAppend):
    """Append a new COGS entry directly to the Fruit cost tab in Google Sheets."""
    if not sheets_service.is_configured():
        raise HTTPException(status_code=503, detail="Google Sheets not configured yet.")
    try:
        sheets_service.append_cogs_row(
            product_type=payload.product_type,
            price_per_lb=payload.price_per_lb,
            effective_date=payload.effective_date,
            vendor=payload.vendor,
            invoice_number=payload.invoice_number,
        )
        return {"status": "appended", "product_type": payload.product_type}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/refresh")
def refresh_cogs_cache():
    sheets_service.invalidate("cogs")
    return {"status": "cache cleared"}
