# Fulfillment App — Persistent Rules

## Branch & Deployment Workflow (READ FIRST)

This repo deploys to Railway. There are two branches that auto-deploy:

- **`main`** → live production (customers and warehouse staff use this)
- **`staging-env`** → staging (a parallel deployment for testing, separate Postgres DB)

**Default working branch is `staging-env`.** At the start of every session, check the current branch and surface it to the user before editing code. A SessionStart hook (`.claude/hooks/branch-banner.sh`) also prints a banner showing which branch we're on.

**Never push, merge, or commit to `main` without explicit chat confirmation in the current session** — phrases like *"ship it"*, *"push to live"*, *"promote to main"*. A general "yes proceed" earlier in a conversation is NOT authorization to touch `main` later.

Before any push to `main`, always run `./scripts/backup-prod-db.sh` first (requires `PROD_DATABASE_URL` env var) and confirm the backup file exists.

**Workflow for a new feature:**
1. Confirm we're on `staging-env`
2. Edit code, commit, push to `staging-env` → Railway auto-deploys to staging URL
3. User tests on staging URL
4. When user says "ship it": take prod backup, merge `staging-env` → `main`, push `main`

**Recovery:**
- Code-only bug on prod → `git revert <bad-commit>` on `main`, push (Railway redeploys good state)
- Schema/data corruption → `git revert` AND `psql $PROD_DATABASE_URL < backups/prod_<timestamp>.sql`

## DB Helper Scripts

- `./scripts/backup-prod-db.sh` — timestamped pg_dump of prod into `backups/`. Run before every prod merge.
- `./scripts/refresh-staging-db.sh` — wipes staging DB and reloads it from a fresh prod copy. Run at the start of any project where staging needs to mirror prod, or before testing risky migrations. Always backs staging up first.

Both scripts require env vars (`PROD_DATABASE_URL`, `STAGING_DATABASE_URL`) which come from Railway → service → Variables tab.

## Shopify API Token

- The token is stored in `shopify_token.json`, **not** `.env`.
- The current token (`shpat_...`) was created before new OAuth scopes were added, so it may be missing required scopes.
- **To get a fresh token with updated scopes:** re-run the connect flow by visiting `http://localhost:8000/api/shopify/connect` in the browser. This re-authenticates with Shopify, creates a new `shpat_` token that includes the new scopes, and automatically saves it to `shopify_token.json`.
- After updating scopes or getting auth errors, always re-run the connect flow rather than manually editing the token file.

## SKU Mapping System

Three DB tables together drive Shopify-SKU → pick-SKU resolution. All three were moved out of Google Sheets in the phase-2/3 migration; sheets remain only as a one-way sync source via "Refresh from Sheets" buttons. App is the source of truth, sync is upsert-only with an **app-wins skip** rule (any row with `last_edited_in_app_at IS NOT NULL` is skipped on refresh).

### `sku_helper_mappings` — variant → canonical alias
- **Purpose:** maps variant SKUs (e.g. `f.passionfruit_purple-5lb_2`, `-5lb_pos`) onto a single canonical SKU (`f.passionfruit_purple-5lb`). Shopify auto-suffixes SKUs when a product is republished, so without this map every variant would need its own row downstream and unmapped variants silently disappear from projections / fulfillment plans.
- **UI:** **Reference Data → SKU Helper** (`/sku-helper`) → "Helper Mappings" tab.
- **Sync source:** `INPUT_SKU_TYPE` sheet (columns `SKU`, `SKU Helper`).
- **`Bundle Needed` column** on the same sheet (marks intentionally-unbundled SKUs) still reads directly from the sheet — intentionally NOT mirrored into the DB.
- **When the user reports "missing sales" or "0 orders" for SKUs that should be selling:** check `sku_helper_mappings` first — it's almost always a missing variant suffix mapping.

### `bundle_mappings` — canonical → pick SKUs
- **Purpose:** the canonical Shopify SKU → list of pick SKUs (with mix_quantity, pick_weight_lb, product_type, warehouse). One row per (warehouse, shopify_sku, pick_sku); a bundle is multiple rows that share the canonical SKU.
- **UI:** **Reference Data → SKU Mapping** (`/sku-mapping`) — grouped view with one row per canonical SKU, hover for tooltip with rule + pick weights + cost-per-lb + warnings.
- **Sync source:** `INPUT_bundles_cvr_walnut` and `INPUT_bundles_cvr_northlake` sheets.
- **Consumers:** `sheets_service.get_sku_mapping_lookup(warehouse)` reads this table (cached, helper indirection applied) and is used by Operations, Confirmed Orders, Projection Orders, the projection engine, and the `/sku-mappings/resolve` debug endpoint.

### `shopify_sku_rules` — per-canonical-SKU constraints
- **Purpose:** weight + kind (`single` | `multi` | null) + validation rules for each canonical Shopify SKU. Keyed by canonical SKU; variant SKUs resolve through `sku_helper_mappings` first.
- **UI:** **Reference Data → SKU Helper** (`/sku-helper`) → "Rules" tab.
- **No sheet sync** — DB-only.
- **Single-pick rules:** `single_substitute_product_types` (allow-list). **Multi-pick rules:** min/max picks, min/max categories, max $/lb, allowed product types, required picks.

### Warnings (Phase 6, never blockers)
The `/sku-mappings/grouped` endpoint computes warnings per canonical SKU and surfaces them as badges on the SKU Mapping page (with a top-of-page summary panel) and on the Staging Dashboard (only SKUs that appear in staged orders): `missing_pick_sku`, `invalid_mix_qty`, `missing_weight`, `under_weight` (>5% or 1lb short), `over_weight` (>20% or 1lb over — asymmetric to be strict on shortships), `multi_same_product_type`, `single_product_type_mismatch`. Adding a new pick line auto-fills mix_quantity from `floor(shopify_weight / pick_weight_lb)` (rounded ceil if frac > 0.05) when this is the first/only pick line in the bundle.

### Out of scope
- Period-specific SKU mappings (`period.sku_mapping_sheet_tab`) intentionally still live in sheets — they're per-projection-period overrides and are NOT part of this migration.
- The legacy `models.SkuMapping` table (separate from `BundleMapping`) is still read as a `pick_weight_lb` cache by `shipstation.py`, `receiving.py`, `orders.py`, `fulfillment.py`. It isn't written by any active path. Migrating those reads to `bundle_mappings` and dropping the old table is a follow-up.
