from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
import models

router = APIRouter()


class GmSettingsUpdate(BaseModel):
    replacement_pct: float
    refund_pct: float
    transaction_fee_pct: float


def _to_dict(s: models.GmSettings) -> dict:
    return {
        "id": s.id,
        "replacement_pct": s.replacement_pct,
        "refund_pct": s.refund_pct,
        "transaction_fee_pct": s.transaction_fee_pct,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }


@router.get("/")
def get_gm_settings(db: Session = Depends(get_db)):
    settings = db.query(models.GmSettings).filter(models.GmSettings.id == 1).first()
    if not settings:
        settings = models.GmSettings(id=1)
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return _to_dict(settings)


@router.put("/")
def update_gm_settings(payload: GmSettingsUpdate, db: Session = Depends(get_db)):
    settings = db.query(models.GmSettings).filter(models.GmSettings.id == 1).first()
    if not settings:
        settings = models.GmSettings(id=1)
        db.add(settings)
    settings.replacement_pct = payload.replacement_pct
    settings.refund_pct = payload.refund_pct
    settings.transaction_fee_pct = payload.transaction_fee_pct
    db.commit()
    db.refresh(settings)
    return _to_dict(settings)
