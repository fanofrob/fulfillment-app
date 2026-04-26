# Fulfillment App — Persistent Rules

## Shopify API Token

- The token is stored in `shopify_token.json`, **not** `.env`.
- The current token (`shpat_...`) was created before new OAuth scopes were added, so it may be missing required scopes.
- **To get a fresh token with updated scopes:** re-run the connect flow by visiting `http://localhost:8000/api/shopify/connect` in the browser. This re-authenticates with Shopify, creates a new `shpat_` token that includes the new scopes, and automatically saves it to `shopify_token.json`.
- After updating scopes or getting auth errors, always re-run the connect flow rather than manually editing the token file.

## SKU Helper Table

- **Purpose:** maps Shopify SKU variants (e.g. `f.passionfruit_purple-5lb_2`, `f.passionfruit_purple-1lb_pos`) onto a single canonical SKU (`f.passionfruit_purple-5lb`). Shopify auto-suffixes SKUs when a product is republished, so without this map every variant would need its own row in the warehouse SKU mapping — and unmapped variants get silently dropped from projections, fulfillment plans, etc.
- **Source of truth:** the database table `sku_helper_mappings` (model `models.SkuHelperMapping`). Editable in the UI under **Reference Data → SKU Helper** (`/sku-helper`).
- **Sheet relationship:** the original data lives in the `INPUT_SKU_TYPE` Google Sheet (columns `SKU` and `SKU Helper`). The "Sync from Sheets" button pulls new rows from the sheet and upserts them into the DB. **Sync is one-way:** UI edits don't write back to the sheet, and rows added in the UI but not in the sheet are NOT deleted on sync.
- **`Bundle Needed` column** on the same sheet (used to mark intentionally-unbundled SKUs) still reads directly from the sheet — it is intentionally NOT mirrored into the DB.
- **Consumers:** `sheets_service.get_sku_type_helper_map()` (cached, 5-minute TTL) reads from the DB and is invalidated on every helper CRUD call. Used by `get_sku_mapping_lookup()` (warehouse SKU resolution), the `/sku-mappings/resolve` debug endpoint, the projection engine's historical-sales attribution, and any path that resolves a Shopify SKU to a pick SKU.
- **When the user reports "missing sales" or "0 orders" for SKUs that should be selling:** check the `sku_helper_mappings` table first — it's almost always a missing variant suffix mapping (see `f.passionfruit_purple-5lb_2 → f.passionfruit_purple-5lb`).
