"""
Projection endpoints — generate projections, manage padding configs.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Optional

import models
import schemas
from database import get_db
from services import projection_service, projection_diagnostics

router = APIRouter()


# ── Padding Configs (must be before /{projection_id} to avoid route conflict) ─

@router.get("/padding-configs", response_model=list[schemas.PaddingConfigResponse])
def list_padding_configs(db: Session = Depends(get_db)):
    """List all projection padding configurations."""
    return db.query(models.ProjectionPaddingConfig).order_by(
        models.ProjectionPaddingConfig.product_type
    ).all()


@router.post("/padding-configs", response_model=schemas.PaddingConfigResponse)
def upsert_padding_config(
    body: schemas.PaddingConfigCreate,
    db: Session = Depends(get_db),
):
    """Create or update a padding config (upsert on product_type)."""
    existing = db.query(models.ProjectionPaddingConfig).filter(
        models.ProjectionPaddingConfig.product_type == body.product_type
    ).first()

    if existing:
        existing.padding_pct = body.padding_pct
        if body.notes is not None:
            existing.notes = body.notes
        db.commit()
        db.refresh(existing)
        return existing

    config = models.ProjectionPaddingConfig(
        product_type=body.product_type,
        padding_pct=body.padding_pct,
        notes=body.notes,
    )
    db.add(config)
    db.commit()
    db.refresh(config)
    return config


@router.delete("/padding-configs/{config_id}")
def delete_padding_config(config_id: int, db: Session = Depends(get_db)):
    """Delete a padding config."""
    config = db.query(models.ProjectionPaddingConfig).filter(
        models.ProjectionPaddingConfig.id == config_id
    ).first()
    if not config:
        raise HTTPException(status_code=404, detail="Padding config not found")

    db.delete(config)
    db.commit()
    return {"detail": "Padding config deleted"}


# ── Projection Generation & Retrieval ────────────────────────────────────────

@router.post("/generate/{period_id}", response_model=schemas.ProjectionResponse)
def generate_projection(
    period_id: int,
    body: schemas.ProjectionGenerateRequest = schemas.ProjectionGenerateRequest(),
    db: Session = Depends(get_db),
):
    """Generate a demand projection for a projection period."""
    try:
        projection = projection_service.generate_projection(
            db=db,
            period_id=period_id,
            historical_weeks=body.historical_weeks or 4,
            excluded_promo_ids=body.excluded_promo_ids,
            promotion_multiplier=body.promotion_multiplier,
            demand_multiplier=body.demand_multiplier,
            warehouse=body.warehouse,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Projection generation failed: {e}")

    # Load lines for response
    lines = db.query(models.ProjectionLine).filter(
        models.ProjectionLine.projection_id == projection.id
    ).all()

    return schemas.ProjectionResponse(
        id=projection.id,
        period_id=projection.period_id,
        generated_at=projection.generated_at,
        shopify_data_as_of=projection.shopify_data_as_of,
        historical_range_start=projection.historical_range_start,
        historical_range_end=projection.historical_range_end,
        methodology_report=projection.methodology_report,
        status=projection.status,
        total_confirmed_demand_lbs=projection.total_confirmed_demand_lbs,
        total_projected_demand_lbs=projection.total_projected_demand_lbs,
        total_demand_lbs=projection.total_demand_lbs,
        parameters=projection.parameters,
        lines=[schemas.ProjectionLineResponse.model_validate(l) for l in lines],
        created_at=projection.created_at,
    )


@router.get("/", response_model=list[schemas.ProjectionResponse])
def list_projections(
    period_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """List projections, optionally filtered by period and/or status."""
    query = db.query(models.Projection)
    if period_id is not None:
        query = query.filter(models.Projection.period_id == period_id)
    if status is not None:
        query = query.filter(models.Projection.status == status)
    query = query.order_by(models.Projection.generated_at.desc())
    projections = query.all()

    result = []
    for p in projections:
        result.append(schemas.ProjectionResponse(
            id=p.id,
            period_id=p.period_id,
            generated_at=p.generated_at,
            shopify_data_as_of=p.shopify_data_as_of,
            historical_range_start=p.historical_range_start,
            historical_range_end=p.historical_range_end,
            methodology_report=p.methodology_report,
            status=p.status,
            total_confirmed_demand_lbs=p.total_confirmed_demand_lbs,
            total_projected_demand_lbs=p.total_projected_demand_lbs,
            total_demand_lbs=p.total_demand_lbs,
            parameters=p.parameters,
            lines=None,  # Don't load lines for list view
            created_at=p.created_at,
        ))
    return result


@router.get("/{projection_id}", response_model=schemas.ProjectionResponse)
def get_projection(projection_id: int, db: Session = Depends(get_db)):
    """Get a projection with all its lines."""
    projection = db.query(models.Projection).filter(
        models.Projection.id == projection_id
    ).first()
    if not projection:
        raise HTTPException(status_code=404, detail="Projection not found")

    lines = db.query(models.ProjectionLine).filter(
        models.ProjectionLine.projection_id == projection.id
    ).all()

    return schemas.ProjectionResponse(
        id=projection.id,
        period_id=projection.period_id,
        generated_at=projection.generated_at,
        shopify_data_as_of=projection.shopify_data_as_of,
        historical_range_start=projection.historical_range_start,
        historical_range_end=projection.historical_range_end,
        methodology_report=projection.methodology_report,
        status=projection.status,
        total_confirmed_demand_lbs=projection.total_confirmed_demand_lbs,
        total_projected_demand_lbs=projection.total_projected_demand_lbs,
        total_demand_lbs=projection.total_demand_lbs,
        parameters=projection.parameters,
        lines=[schemas.ProjectionLineResponse.model_validate(l) for l in lines],
        created_at=projection.created_at,
    )


@router.get("/{projection_id}/shop-hourly-breakdown", response_model=schemas.ShopHourlyBreakdownResponse)
def get_shop_hourly_breakdown(
    projection_id: int,
    db: Session = Depends(get_db),
):
    """Shop-wide projected orders per hour, summed across all product types."""
    try:
        return projection_service.get_shop_hourly_breakdown(db, projection_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{projection_id}/pt-daily-history", response_model=schemas.PtDailyHistoryResponse)
def get_pt_daily_history(
    projection_id: int,
    product_type: str = Query(...),
    db: Session = Depends(get_db),
):
    """Per-day historical lbs for a product type, grouped by week."""
    try:
        return projection_service.get_pt_daily_history(db, projection_id, product_type)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{projection_id}/historical-summary", response_model=schemas.HistoricalOrdersSummaryResponse)
def get_historical_summary(projection_id: int, db: Session = Depends(get_db)):
    """Weekly + overall distinct-orders-per-day for this projection's historical window."""
    try:
        return projection_service.get_historical_orders_summary(db, projection_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{projection_id}/sku-diagnostics")
def get_sku_diagnostics(
    projection_id: int,
    product_type: str = Query(...),
    db: Session = Depends(get_db),
):
    """Per-SKU data-quality diagnostics for every Shopify SKU that rolls up to this product type."""
    try:
        return projection_diagnostics.get_sku_diagnostics(db, projection_id, product_type)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{projection_id}/coverage-summary")
def get_coverage_summary(projection_id: int, db: Session = Depends(get_db)):
    """One coverage flag per product_type (worst color among material contributors)."""
    try:
        return projection_diagnostics.get_coverage_summary(db, projection_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{projection_id}/compare/{other_id}", response_model=schemas.ProjectionComparisonResponse)
def compare_projections(
    projection_id: int,
    other_id: int,
    db: Session = Depends(get_db),
):
    """Compare two projections side-by-side, matching by product type."""
    try:
        result = projection_service.compare_projections(db, projection_id, other_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    pa = result["projection_a"]
    pb = result["projection_b"]

    def _to_response(p):
        return schemas.ProjectionResponse(
            id=p.id, period_id=p.period_id,
            generated_at=p.generated_at, shopify_data_as_of=p.shopify_data_as_of,
            historical_range_start=p.historical_range_start,
            historical_range_end=p.historical_range_end,
            methodology_report=p.methodology_report, status=p.status,
            total_confirmed_demand_lbs=p.total_confirmed_demand_lbs,
            total_projected_demand_lbs=p.total_projected_demand_lbs,
            total_demand_lbs=p.total_demand_lbs,
            parameters=p.parameters, lines=None, created_at=p.created_at,
        )

    return schemas.ProjectionComparisonResponse(
        projection_a=_to_response(pa),
        projection_b=_to_response(pb),
        lines=[schemas.ComparisonLineResponse(**l) for l in result["lines"]],
    )


@router.delete("/{projection_id}")
def delete_projection(projection_id: int, db: Session = Depends(get_db)):
    """Soft-delete a projection by marking it as superseded."""
    projection = db.query(models.Projection).filter(
        models.Projection.id == projection_id
    ).first()
    if not projection:
        raise HTTPException(status_code=404, detail="Projection not found")

    projection.status = "superseded"
    db.commit()
    return {"detail": "Projection marked as superseded"}
