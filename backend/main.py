from dotenv import load_dotenv
load_dotenv()

import os
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import text, inspect
from database import engine
import models


def _migrate_db():
    """Drop tables that have stale schemas so create_all rebuilds them."""
    insp = inspect(engine)
    # Drop package_rules if it still has the old weight_lb/zone schema
    if "package_rules" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("package_rules")}
        if "weight_lb" in cols:
            with engine.connect() as conn:
                conn.execute(text("DROP TABLE package_rules"))
                conn.commit()
    # Drop box_types if it still has the old sort_order column
    if "box_types" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("box_types")}
        if "sort_order" in cols:
            with engine.connect() as conn:
                conn.execute(text("DROP TABLE box_types"))
                conn.commit()
    # Add new columns to box_types if missing (non-destructive)
    if "box_types" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("box_types")}
        with engine.connect() as conn:
            for col_def in [
                ("pick_sku",     "TEXT"),
                ("carrier",      "TEXT"),
                ("package_code", "TEXT"),
                ("length_in",    "REAL"),
                ("width_in",     "REAL"),
                ("height_in",    "REAL"),
                ("weight_oz",    "REAL"),
            ]:
                if col_def[0] not in cols:
                    conn.execute(text(f"ALTER TABLE box_types ADD COLUMN {col_def[0]} {col_def[1]}"))
            conn.commit()
    # Add box_type_id to fulfillment_boxes if missing
    if "fulfillment_boxes" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("fulfillment_boxes")}
        if "box_type_id" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE fulfillment_boxes ADD COLUMN box_type_id INTEGER REFERENCES box_types(id)"))
                conn.commit()
    # Add estimated_delivery_date to fulfillment_boxes if missing
    if "fulfillment_boxes" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("fulfillment_boxes")}
        if "estimated_delivery_date" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE fulfillment_boxes ADD COLUMN estimated_delivery_date TIMESTAMP"))
                conn.commit()
    # Add estimated_delivery_date to shopify_orders if missing
    if "shopify_orders" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("shopify_orders")}
        if "estimated_delivery_date" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE shopify_orders ADD COLUMN estimated_delivery_date TIMESTAMP"))
                conn.commit()
    # Add days_til_expiration to picklist_skus if missing
    if "picklist_skus" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("picklist_skus")}
        if "days_til_expiration" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE picklist_skus ADD COLUMN days_til_expiration REAL"))
                conn.commit()
    # Add category to picklist_skus if missing
    if "picklist_skus" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("picklist_skus")}
        if "category" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE picklist_skus ADD COLUMN category TEXT"))
                conn.commit()
    # Add batch_id to inventory_adjustments if missing
    if "inventory_adjustments" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("inventory_adjustments")}
        if "batch_id" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE inventory_adjustments ADD COLUMN batch_id INTEGER"))
                conn.commit()
    # Drop unique constraint on order_rules.tag so multiple rules per tag are allowed
    if "order_rules" in insp.get_table_names():
        indexes = insp.get_indexes("order_rules")
        unique_tag_idx = [i for i in indexes if i.get("unique") and "tag" in i.get("column_names", [])]
        if unique_tag_idx:
            with engine.connect() as conn:
                for idx in unique_tag_idx:
                    conn.execute(text(f'DROP INDEX IF EXISTS "{idx["name"]}"'))
                conn.commit()
    # shopify_products table is created by create_all — no manual migration needed.
    # shopify_line_items: ensure app_line_status column exists (may be missing on older DBs)
    if "shopify_line_items" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("shopify_line_items")}
        if "app_line_status" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE shopify_line_items ADD COLUMN app_line_status TEXT"))
                conn.commit()
    # Add total_shipping_price to shopify_orders if missing
    if "shopify_orders" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("shopify_orders")}
        if "total_shipping_price" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE shopify_orders ADD COLUMN total_shipping_price REAL"))
                conn.commit()
    # Add inventory_hold to shopify_products if missing
    if "shopify_products" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("shopify_products")}
        if "inventory_hold" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE shopify_products ADD COLUMN inventory_hold BOOLEAN NOT NULL DEFAULT FALSE"))
                conn.commit()
    # Add ss_duplicate to shopify_orders if missing
    if "shopify_orders" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("shopify_orders")}
        if "ss_duplicate" not in cols:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE shopify_orders ADD COLUMN ss_duplicate BOOLEAN NOT NULL DEFAULT FALSE"))
                conn.commit()
    # Add SKU cost columns to picklist_skus if missing
    if "picklist_skus" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("picklist_skus")}
        with engine.connect() as conn:
            for col_name, col_type in [("cost_per_lb", "REAL"), ("cost_per_case", "REAL"), ("case_weight_lb", "REAL")]:
                if col_name not in cols:
                    conn.execute(text(f"ALTER TABLE picklist_skus ADD COLUMN {col_name} {col_type}"))
            conn.commit()
    # Add new vendor columns (url, pickup_address, agg_location, product_catalog) if missing
    if "vendors" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("vendors")}
        with engine.connect() as conn:
            for col_name, col_type in [
                ("url",             "TEXT"),
                ("pickup_address",  "TEXT"),
                ("agg_location",    "TEXT"),
                ("product_catalog", "TEXT"),
            ]:
                if col_name not in cols:
                    conn.execute(text(f"ALTER TABLE vendors ADD COLUMN {col_name} {col_type}"))
            conn.commit()
    # Add confirmed-demand review/override fields to projection_periods if missing.
    # confirmed_demand_*_lbs must be JSON: SQLAlchemy's JSON type round-trips
    # dicts on Postgres only when the column is native JSON, not TEXT.
    if "projection_periods" in insp.get_table_names():
        cols_info = {c["name"]: c for c in insp.get_columns("projection_periods")}
        with engine.connect() as conn:
            for col_name, col_type in [
                ("confirmed_demand_auto_lbs",   "JSON"),
                ("confirmed_demand_manual_lbs", "JSON"),
                ("has_manual_confirmed_demand", "BOOLEAN NOT NULL DEFAULT FALSE"),
                ("confirmed_demand_saved_at",   "TIMESTAMP"),
            ]:
                if col_name not in cols_info:
                    conn.execute(text(f"ALTER TABLE projection_periods ADD COLUMN {col_name} {col_type}"))
            conn.commit()
        # Heal pre-existing Postgres deploys where confirmed_demand_*_lbs were
        # added as TEXT — list_periods crashes with ResponseValidationError
        # because raw TEXT doesn't deserialize into the Pydantic dict field.
        if engine.dialect.name == "postgresql":
            for col_name in ("confirmed_demand_auto_lbs", "confirmed_demand_manual_lbs"):
                col = cols_info.get(col_name)
                if col is None:
                    continue
                col_type_str = str(col.get("type", "")).upper()
                if "TEXT" in col_type_str or "CHAR" in col_type_str:
                    with engine.connect() as conn:
                        conn.execute(text(
                            f"ALTER TABLE projection_periods "
                            f"ALTER COLUMN {col_name} TYPE JSON "
                            f"USING NULLIF({col_name}, '')::json"
                        ))
                        conn.commit()
    # Add sub_product_type / shipping_status / purchase_order_line_id to purchase_plan_lines if missing
    if "purchase_plan_lines" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("purchase_plan_lines")}
        with engine.connect() as conn:
            for col_name, col_type in [
                ("sub_product_type",        "TEXT"),
                ("shipping_status",         "TEXT"),
                ("purchase_order_line_id",  "INTEGER"),
            ]:
                if col_name not in cols:
                    conn.execute(text(f"ALTER TABLE purchase_plan_lines ADD COLUMN {col_name} {col_type}"))
            conn.commit()
    # Add per-row padding & inventory adjustment to period_projection_overrides if missing
    if "period_projection_overrides" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("period_projection_overrides")}
        with engine.connect() as conn:
            for col_name, col_type in [
                ("padding_pct_override",     "REAL"),
                ("inventory_adjustment_pct", "REAL"),
            ]:
                if col_name not in cols:
                    conn.execute(text(f"ALTER TABLE period_projection_overrides ADD COLUMN {col_name} {col_type}"))
            conn.commit()


def _seed_ups_rates():
    """Seed 2025 UPS retail rates into the rate_cards DB table if not already present."""
    from sqlalchemy.orm import Session
    db = Session(engine)
    try:
        existing = db.query(models.RateCard).filter(models.RateCard.carrier == "UPS").count()
        if existing > 0:
            return  # already seeded

        from datetime import date
        effective = date(2025, 1, 1)

        # UPS Ground rates (zones 2-8, weights 1-30 lbs)
        ground_rates = {
            1:  {2: 10.06, 3: 10.42, 4: 10.65, 5: 10.99, 6: 11.48, 7: 12.09, 8: 12.71},
            2:  {2: 10.55, 3: 10.96, 4: 11.20, 5: 11.65, 6: 12.35, 7: 13.05, 8: 13.83},
            3:  {2: 10.91, 3: 11.44, 4: 11.73, 5: 12.32, 6: 13.20, 7: 13.98, 8: 14.98},
            4:  {2: 11.28, 3: 11.90, 4: 12.27, 5: 12.98, 6: 14.04, 7: 14.90, 8: 16.11},
            5:  {2: 11.67, 3: 12.38, 4: 12.83, 5: 13.66, 6: 14.90, 7: 15.84, 8: 17.24},
            6:  {2: 12.08, 3: 12.88, 4: 13.41, 5: 14.35, 6: 15.77, 7: 16.81, 8: 18.40},
            7:  {2: 12.50, 3: 13.40, 4: 14.01, 5: 15.05, 6: 16.65, 7: 17.80, 8: 19.58},
            8:  {2: 12.94, 3: 13.93, 4: 14.63, 5: 15.76, 6: 17.54, 7: 18.80, 8: 20.77},
            9:  {2: 13.39, 3: 14.48, 4: 15.26, 5: 16.49, 6: 18.44, 7: 19.81, 8: 21.98},
            10: {2: 13.87, 3: 15.05, 4: 15.92, 5: 17.24, 6: 19.37, 7: 20.84, 8: 23.23},
            11: {2: 14.36, 3: 15.64, 4: 16.59, 5: 18.01, 6: 20.31, 7: 21.90, 8: 24.51},
            12: {2: 14.87, 3: 16.25, 4: 17.28, 5: 18.80, 6: 21.28, 7: 22.98, 8: 25.81},
            13: {2: 15.40, 3: 16.88, 4: 17.99, 5: 19.61, 6: 22.27, 7: 24.09, 8: 27.15},
            14: {2: 15.95, 3: 17.53, 4: 18.72, 5: 20.44, 6: 23.28, 7: 25.23, 8: 28.51},
            15: {2: 16.51, 3: 18.20, 4: 19.47, 5: 21.29, 6: 24.31, 7: 26.39, 8: 29.90},
            16: {2: 17.09, 3: 18.89, 4: 20.24, 5: 22.16, 6: 25.36, 7: 27.58, 8: 31.32},
            17: {2: 17.69, 3: 19.60, 4: 21.03, 5: 23.05, 6: 26.43, 7: 28.79, 8: 32.77},
            18: {2: 18.31, 3: 20.33, 4: 21.84, 5: 23.96, 6: 27.53, 7: 30.03, 8: 34.25},
            19: {2: 18.95, 3: 21.08, 4: 22.67, 5: 24.90, 6: 28.65, 7: 31.30, 8: 35.76},
            20: {2: 19.61, 3: 21.85, 4: 23.52, 5: 25.86, 6: 29.80, 7: 32.60, 8: 37.31},
            25: {2: 23.18, 3: 26.06, 4: 28.28, 5: 31.44, 6: 36.73, 7: 40.49, 8: 47.11},
            30: {2: 27.07, 3: 30.65, 4: 33.45, 5: 37.56, 6: 44.36, 7: 49.27, 8: 58.00},
        }

        # UPS Next Day Air rates (zones 2-8, weights 1-10 lbs — higher weights unavailable as public retail data)
        nda_rates = {
            1:  {2: 68.92, 3: 88.95,  4: 104.73, 5: 113.06, 6: 118.72, 7: 123.97, 8: 127.47},
            2:  {2: 70.76, 3: 92.10,  4: 110.84, 5: 120.05, 6: 126.20, 7: 132.14, 8: 139.64},
            3:  {2: 73.15, 3: 95.24,  4: 118.91, 5: 131.10, 6: 138.92, 7: 146.11, 8: 149.89},
            4:  {2: 76.52, 3: 98.40,  4: 129.46, 5: 140.69, 6: 145.08, 7: 156.13, 8: 160.47},
            5:  {2: 77.54, 3: 101.55, 4: 131.63, 5: 141.80, 6: 148.67, 7: 157.27, 8: 163.59},
            6:  {2: 83.85, 3: 104.89, 4: 144.20, 5: 160.05, 6: 166.90, 7: 176.63, 8: 182.16},
            7:  {2: 84.48, 3: 108.05, 4: 149.42, 5: 167.04, 6: 172.67, 7: 183.03, 8: 192.93},
            8:  {2: 84.96, 3: 111.20, 4: 154.60, 5: 176.12, 6: 183.18, 7: 192.08, 8: 198.00},
            9:  {2: 85.67, 3: 114.37, 4: 162.55, 5: 177.08, 6: 184.24, 7: 194.12, 8: 230.20},
            10: {2: 86.16, 3: 117.53, 4: 165.22, 5: 180.27, 6: 187.63, 7: 197.45, 8: 242.88},
        }

        rows = []
        for weight, zones in ground_rates.items():
            for zone, rate in zones.items():
                rows.append(models.RateCard(
                    carrier="UPS", service_name="UPS Ground",
                    weight_lb=float(weight), zone=zone, rate=rate,
                    is_flat_rate=False, effective_date=effective,
                    notes="2025 UPS retail rates (seeded)"
                ))
        for weight, zones in nda_rates.items():
            for zone, rate in zones.items():
                rows.append(models.RateCard(
                    carrier="UPS", service_name="UPS Next Day Air",
                    weight_lb=float(weight), zone=zone, rate=rate,
                    is_flat_rate=False, effective_date=effective,
                    notes="2025 UPS retail rates (seeded)"
                ))

        db.add_all(rows)
        db.commit()
        print(f"[startup] Seeded {len(rows)} UPS rate card entries")
    except Exception as e:
        db.rollback()
        print(f"[startup] UPS rate seeding failed: {e}")
    finally:
        db.close()


def _seed_gm_settings():
    """Ensure a single GmSettings row exists."""
    from sqlalchemy.orm import Session
    db = Session(engine)
    try:
        if not db.query(models.GmSettings).first():
            db.add(models.GmSettings(id=1))
            db.commit()
    except Exception as e:
        db.rollback()
        print(f"[startup] GmSettings seed failed: {e}")
    finally:
        db.close()


_migrate_db()
models.Base.metadata.create_all(bind=engine)
_seed_ups_rates()
_seed_gm_settings()

from routers import sku_mapping, sku_helper, cogs, rate_cards, rules, inventory, orders, shopify_auth, shipstation, fulfillment, picklist_skus, products, gm_settings, projection_periods, projection_confirmed_orders, historical_data, projections, vendors, purchase_orders, purchase_planning, inventory_count, receiving
from services import sheets_service, shopify_service, shipstation_service

app = FastAPI(title="Fulfillment App API")

# CORS_ORIGINS is a comma-separated list of allowed origins.
# In production the frontend is served from the same origin as the API so CORS
# isn't strictly needed — but it's cheap to leave flexible. Default covers local dev.
_cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sku_mapping.router, prefix="/api/sku-mappings", tags=["SKU Mappings"])
app.include_router(cogs.router, prefix="/api/cogs", tags=["COGS"])
app.include_router(rate_cards.router, prefix="/api/rate-cards", tags=["Rate Cards"])
app.include_router(rules.router, prefix="/api/rules", tags=["Order Rules"])
app.include_router(inventory.router, prefix="/api/inventory", tags=["Inventory"])
app.include_router(orders.router, prefix="/api/orders", tags=["Orders"])
app.include_router(shopify_auth.router, prefix="/api/shopify", tags=["Shopify Auth"])
app.include_router(shipstation.router, prefix="/api/shipstation", tags=["ShipStation"])
app.include_router(fulfillment.router, prefix="/api/fulfillment", tags=["Fulfillment"])
app.include_router(picklist_skus.router, prefix="/api/picklist-skus", tags=["Picklist SKUs"])
app.include_router(sku_helper.router, prefix="/api/sku-helper", tags=["SKU Helper"])
app.include_router(products.router, prefix="/api/products", tags=["Products"])
app.include_router(gm_settings.router, prefix="/api/gm-settings", tags=["GM Settings"])
app.include_router(projection_periods.router, prefix="/api/projection-periods", tags=["Projection Periods"])
app.include_router(projection_confirmed_orders.router, prefix="/api/projection-periods", tags=["Projection Confirmed Orders"])
app.include_router(historical_data.router, prefix="/api/historical", tags=["Historical Data"])
app.include_router(projections.router, prefix="/api/projections", tags=["Projections"])
app.include_router(vendors.router, prefix="/api/vendors", tags=["Vendors"])
app.include_router(purchase_orders.router, prefix="/api/purchase-orders", tags=["Purchase Orders"])
app.include_router(purchase_planning.router, prefix="/api/purchase-planning", tags=["Purchase Planning"])
app.include_router(inventory_count.router, prefix="/api/inventory-count", tags=["Inventory Count"])
app.include_router(receiving.router, prefix="/api/receiving", tags=["Receiving"])

@app.get("/api/ping")
def ping():
    return {"status": "ok", "message": "Fulfillment App API"}

@app.get("/api/status")
def status():
    return {
        "sheets_configured": sheets_service.is_configured(),
        "credentials_path": sheets_service.CREDENTIALS_PATH,
        "shopify_configured": shopify_service.is_configured(),
        "shopify_oauth_ready": shopify_service.oauth_ready(),
        "shipstation_configured": shipstation_service.is_configured(),
    }

@app.post("/api/refresh")
def refresh_all_caches():
    sheets_service.invalidate()
    return {"status": "all caches cleared"}


# --- Serve the built frontend (SPA) ---
# In production the Vite build output lives in frontend/dist and is served from
# the same origin as the API. Locally, when running `npm run dev`, this block
# is skipped (dist doesn't exist) and Vite handles the frontend on :5173.
_FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

if _FRONTEND_DIST.is_dir():
    _assets_dir = _FRONTEND_DIST / "assets"
    if _assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        # Don't shadow /api/* routes — let FastAPI return their real 404s.
        # Also mimic FastAPI's default redirect_slashes behavior, which this
        # catch-all otherwise pre-empts: /api/foo/ → 307 → /api/foo.
        if full_path.startswith("api/") or full_path == "api":
            if full_path.endswith("/"):
                return RedirectResponse(url="/" + full_path.rstrip("/"), status_code=307)
            raise HTTPException(status_code=404)
        # Serve any real file in dist (favicon, robots.txt, etc.); otherwise
        # fall back to index.html so React Router can handle the route.
        if full_path:
            candidate = _FRONTEND_DIST / full_path
            if candidate.is_file():
                return FileResponse(candidate)
        return FileResponse(_FRONTEND_DIST / "index.html")
else:
    @app.get("/", include_in_schema=False)
    def root_dev_hint():
        return {
            "status": "ok",
            "message": "Fulfillment App API (dev mode — frontend not built; run `npm run dev` for the UI)",
        }
