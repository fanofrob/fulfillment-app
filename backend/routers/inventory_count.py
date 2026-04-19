"""
Inventory Count router — photo-based inventory update workflow.

Flow:
1. POST /scan   — upload 1+ images + warehouse → Claude vision extracts rows → match against PicklistSku
2. POST /commit — reviewed rows → bulk-update InventoryItem on_hand_qty
"""
import os
import base64
import json
import re
from datetime import datetime, timezone
from typing import List, Optional

import anthropic
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import get_db
import models

router = APIRouter()

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

SCAN_PROMPT = """You are reading a handwritten weekly inventory report. Extract ALL inventory entries from every row in the table(s) in this image.

For each table row:
- SKU: the printed (not handwritten) text in the leftmost "SKU" column — copy it EXACTLY including underscores and dashes
- Batch: the handwritten value in the "Batch" column, or null if empty
- Lbs: the handwritten number in the "Updated Quantity" column
  - If multiple numbers with cross-outs, take the FINAL (last written) number only
  - If the cell contains a dash "—" or "-", use 0
  - If the cell is blank/empty, use 0

Also extract any freeform entries written OUTSIDE the table (e.g. "Avocado Gem - 250.0" written as free text). Mark these as write-ins.

Return ONLY valid JSON with this exact structure, no extra text:
{
  "rows": [
    {"sku": "apple_cosmic-01x02", "batch": null, "lbs": 144.0, "is_writein": false},
    {"sku": "Avocado Gem", "batch": null, "lbs": 250.0, "is_writein": true}
  ]
}"""


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class ScannedRow(BaseModel):
    extracted_sku: str
    matched_sku: Optional[str]
    matched_sku_id: Optional[int]
    inventory_item_id: Optional[int]
    current_on_hand_qty: Optional[float]
    batch: Optional[str]
    lbs: float
    weight_per_lb: Optional[float]
    calculated_pieces: Optional[float]
    is_flagged: bool
    flag_reason: Optional[str]


class ScanResponse(BaseModel):
    warehouse: str
    rows: List[ScannedRow]


class CommitRow(BaseModel):
    pick_sku: str
    name: Optional[str]
    on_hand_qty: float
    batch: Optional[str]


class CommitRequest(BaseModel):
    warehouse: str
    rows: List[CommitRow]


class CommitResult(BaseModel):
    committed: int
    created: int
    updated: int


# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_rows_from_images(image_contents: List[tuple[bytes, str]]) -> List[dict]:
    """Call Claude vision with all images and return extracted rows."""
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    content = []
    for img_bytes, media_type in image_contents:
        b64 = base64.standard_b64encode(img_bytes).decode("utf-8")
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": b64}
        })
    content.append({"type": "text", "text": SCAN_PROMPT})

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{"role": "user", "content": content}]
    )

    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    data = json.loads(raw)
    return data.get("rows", [])


def _match_sku(extracted_sku: str, sku_lookup: dict) -> Optional[models.PicklistSku]:
    """Try exact then case-insensitive match against PicklistSku lookup."""
    sku_lower = extracted_sku.lower().strip()
    # Exact match
    if extracted_sku in sku_lookup:
        return sku_lookup[extracted_sku]
    # Case-insensitive
    for key, sku_obj in sku_lookup.items():
        if key.lower() == sku_lower:
            return sku_obj
    return None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/scan", response_model=ScanResponse)
async def scan_images(
    warehouse: str = Form(...),
    images: List[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured")
    if not images:
        raise HTTPException(status_code=400, detail="At least one image is required")

    # Read all image bytes
    image_contents = []
    for img in images:
        content = await img.read()
        media_type = img.content_type or "image/jpeg"
        image_contents.append((content, media_type))

    # Call Claude
    try:
        extracted = _extract_rows_from_images(image_contents)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Claude API error: {e}")

    # Build PicklistSku lookup
    all_skus = db.query(models.PicklistSku).all()
    sku_lookup = {s.pick_sku: s for s in all_skus}

    # Build InventoryItem lookup for this warehouse
    inv_items = db.query(models.InventoryItem).filter(
        models.InventoryItem.warehouse == warehouse
    ).all()
    inv_lookup = {item.pick_sku: item for item in inv_items}

    rows: List[ScannedRow] = []
    for r in extracted:
        raw_sku = (r.get("sku") or "").strip()
        batch = r.get("batch") or None
        lbs = float(r.get("lbs") or 0)
        is_writein = bool(r.get("is_writein", False))

        matched = _match_sku(raw_sku, sku_lookup)
        inv_item = inv_lookup.get(matched.pick_sku if matched else None)

        if matched and matched.weight_lb:
            pieces = round(lbs / matched.weight_lb, 2) if lbs > 0 else 0.0
            is_flagged = is_writein
            flag_reason = "Write-in SKU (matched)" if is_writein else None
        elif matched and not matched.weight_lb:
            pieces = None
            is_flagged = True
            flag_reason = "SKU found but weight_lb not set — cannot convert lbs to pieces"
        else:
            pieces = None
            is_flagged = True
            flag_reason = "Write-in SKU: not found in database" if is_writein else "SKU not found in database"

        rows.append(ScannedRow(
            extracted_sku=raw_sku,
            matched_sku=matched.pick_sku if matched else None,
            matched_sku_id=matched.id if matched else None,
            inventory_item_id=inv_item.id if inv_item else None,
            current_on_hand_qty=inv_item.on_hand_qty if inv_item else None,
            batch=batch,
            lbs=lbs,
            weight_per_lb=matched.weight_lb if matched else None,
            calculated_pieces=pieces,
            is_flagged=is_flagged,
            flag_reason=flag_reason,
        ))

    return ScanResponse(warehouse=warehouse, rows=rows)


@router.post("/commit", response_model=CommitResult)
def commit_count(payload: CommitRequest, db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    note = f"Inventory count {now.strftime('%Y-%m-%d')}"

    created = 0
    updated = 0

    for row in payload.rows:
        if not row.pick_sku:
            continue

        item = db.query(models.InventoryItem).filter(
            models.InventoryItem.pick_sku == row.pick_sku,
            models.InventoryItem.warehouse == payload.warehouse,
        ).first()

        new_qty = row.on_hand_qty

        if item is None:
            # Look up name from PicklistSku if not provided
            name = row.name
            if not name:
                sku_obj = db.query(models.PicklistSku).filter(
                    models.PicklistSku.pick_sku == row.pick_sku
                ).first()
                name = sku_obj.customer_description if sku_obj else row.pick_sku

            item = models.InventoryItem(
                pick_sku=row.pick_sku,
                warehouse=payload.warehouse,
                name=name,
                on_hand_qty=new_qty,
                committed_qty=0.0,
                available_qty=new_qty,
                batch_code=row.batch,
            )
            db.add(item)
            db.flush()

            db.add(models.InventoryAdjustment(
                pick_sku=row.pick_sku,
                warehouse=payload.warehouse,
                delta=new_qty,
                adjustment_type="inventory_count",
                note=note,
            ))
            created += 1
        else:
            old_qty = item.on_hand_qty
            delta = new_qty - old_qty
            item.on_hand_qty = new_qty
            item.available_qty = new_qty - item.committed_qty
            if row.batch:
                item.batch_code = row.batch

            db.add(models.InventoryAdjustment(
                pick_sku=row.pick_sku,
                warehouse=payload.warehouse,
                delta=delta,
                adjustment_type="inventory_count",
                note=note,
            ))
            updated += 1

    db.commit()
    return CommitResult(committed=created + updated, created=created, updated=updated)
