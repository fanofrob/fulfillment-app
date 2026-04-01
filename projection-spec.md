# Product Spec: Projection & Procurement System

## Overview

A projection and procurement system built into the existing fulfillment app that replaces manual spreadsheet-based demand forecasting and vendor ordering. The system projects demand at the **product type level**, manages vendor purchase orders, tracks receiving/inventory push, and provides alerts for short and long inventory situations.

This system shares data with the existing fulfillment system (inventory, SKU mappings, short ship configs, inventory holds, orders) but adds projection-specific concepts: projection periods, period-specific configurations, vendor management, purchase orders, and forecasting.

---

## Business Context

### The Weekly Rhythm

```
Wed 12:00am ──── Thu ──── Fri ──── Sat ──── Sun ──── Mon ──── Tue 11:59pm
│◄─── Orders accumulate (eligible for next fulfillment period) ──────►│
                                                      Mon ── Tue ── Wed
                                                      │◄─ Fulfillment ─►│
```

- **Default cutoff**: Midnight Tuesday (configurable per period)
- **Fulfillment**: Monday through Wednesday (pack and ship)
- **Projection point**: Typically Sunday or Monday morning
- Orders Wed-Sat = confirmed demand for next Mon-Wed fulfillment
- Orders Sun-Tue = projected demand (partially confirmed as orders come in)

### Two Projection Periods (Typical Week)

**Period 1 (Current Fulfillment):**
- Contains confirmed orders (Wed-Sat) + projected remaining orders (Sun-Tue)
- Vendor orders for Period 1 need to arrive by Tuesday
- Uses current fulfillment SKU mapping, short ship, and inventory hold configs

**Period 2 (Next Fulfillment):**
- Contains confirmed orders (if any) + projected orders (Wed-Tue)
- Vendor orders for Period 2 need to arrive by Friday
- Uses its own period-specific SKU mapping, short ship, and inventory hold configs
- Expected on-hand = inventory remaining after Period 1 fulfillment, net of expected spoilage

**Period 3+ (Rare):**
- For SKUs harvested infrequently (e.g., loquats every other week)
- Same model, extended forward

### Key Insight: Product Type vs SKU

Projections operate at the **product type** level (e.g., "Fruit: Mango, Honey"). Vendors sell product types, not internal SKUs. The exact SKU (e.g., `mango_honey-09x12` vs `mango_honey-09x18`) is unknown until fruit is received and inspected.

**Projection flow:**
1. Project Shopify SKU orders → apply period-specific SKU mapping → get pick SKU quantities
2. Aggregate pick SKUs up to product type level (using weight/piece conversion)
3. Order from vendors at product type level in cases
4. Receive delivery → inspect → confirm actual SKU → push to inventory

**Example:**
- Projection: 100 orders of `f.mango_honey-5lb` → SKU mapping says 7x `mango_honey-09x12` per order → 700 pieces → 525 lbs of "Fruit: Mango, Honey"
- Case weight: 9 lbs regardless of SKU → 525 / 9 = 58.33 cases → suggest 59 cases (531 lbs, +6 lbs overage)
- Receive: vendor sent `mango_honey-09x18` (0.5 lbs/piece) → 59 cases × 9 lbs = 531 lbs → 1,062 pieces of `mango_honey-09x18` imported into inventory

### Inventory Hold = Conditional Confirmed Demand

- **Fulfillment side**: inventory is NOT committed for inventory-hold orders
- **Projection side**: inventory-hold orders ARE treated as confirmed demand (because we expect to fulfill them if short SKUs are secured)
- This means the projection engine must account for hold orders when calculating total demand

---

## Core Concepts

### Projection Period
A named time window with:
- Start datetime, end datetime (configurable, default midnight boundaries)
- Associated SKU mapping (Google Sheets tab initially, in-app later)
- Associated short ship configuration
- Associated inventory hold configuration
- Status: draft → active → closed
- Link to previous/next period for cascade calculations

### Projection
A point-in-time demand forecast for a specific period, generated on demand ("Generate Projection" button). Contains:
- Timestamp of generation
- Shopify data pulled through (timestamp of last Shopify sync used)
- Per-product-type demand breakdown
- Confirmed orders vs projected orders split
- The historical date range and parameters used to generate it
- Promotion tags/adjustments applied
- Accuracy tracking (projected vs actual, calculated after period closes)

### Purchase Order (PO)
A vendor order containing one or more product types:
- Vendor, PO date, expected delivery date
- Status: draft → placed → in_transit → partially_received → delivered → imported → reconciled
- Line items (product type, qty ordered in cases, case weight, unit price, notes)
- Can span multiple projection periods
- Receiving records (actual qty, actual SKU, harvest date, quality notes)
- Invoice reconciliation (qty discrepancy, quality issues, price discrepancy)

### Vendor
- Name, contact info, communication method (WhatsApp/email/phone)
- Default product types they supply
- Default case sizes/weights per product type
- Lead time estimates
- Reliability notes

---

## Detailed Requirements

### R1: Projection Periods & Period-Specific Configs

**R1.1: Period Management**
- Create/edit/close projection periods with custom start/end datetimes
- Default period generation: auto-suggest Wed 12:00am → Tue 11:59pm boundaries
- Ability to create ad-hoc periods with arbitrary time ranges (e.g., "2pm Monday - midnight Wednesday")
- Visual timeline showing all active periods and their relationships

**R1.2: Period-Specific SKU Mapping (Interim)**
- Google Sheets tabs per period (e.g., "Walnut SKU Mapping", "Period 1 SKU Mapping", "Period 2 SKU Mapping")
- App reads from the appropriate tab based on selected period
- Projection engine uses period-specific mapping to calculate demand
- Eventually migrate to in-app SKU mapping per period (lower priority)

**R1.3: Period-Specific Short Ship & Inventory Hold**
- Each period has its own short ship configuration (which SKUs are short-shipped)
- Each period has its own inventory hold configuration
- Copy configs between periods in any direction, then tweak
- Visual diff view: side-by-side comparison of configs across periods
- Changes to configs in one period can be propagated to others (opt-in)

**R1.4: Period Cascade Logic**
- When Period 1 is finalized (orders staged/shipped), calculate expected remaining inventory
- Expected on-hand for Period 2 = (Period 1 starting inventory) - (Period 1 committed) - (Period 1 expected spoilage) + (Period 1 POs received)
- Spoilage rate configurable per SKU (default from `shelf_life_days` on `picklist_skus`)
- Short-shipping in Period 1 creates carry-over orders that become confirmed demand in Period 2 (with Period 2's configs applied)
- Orders not staged in Period 1 (e.g., DNSS issues, GM% too low) may or may not carry to Period 2 depending on Period 2 configs

### R2: Projection Engine

**R2.1: Historical Data Ingestion**
- Pull historical order data from Shopify (lifetime data, hourly granularity)
- Store locally for fast querying (don't hit Shopify API every time)
- Tag historical periods with promotions (store-wide or SKU-specific)
- Track which Shopify data was used for each projection (timestamp)

**R2.2: Demand Calculation**
- **Confirmed demand**: Orders already in the system for the period
  - Staged orders (inventory committed)
  - Inventory hold orders (not committed but treated as confirmed demand for projection)
  - Carry-over orders from previous period
- **Projected demand**: Forecasted orders for remaining time in the period
  - Based on historical sales patterns at hourly granularity
  - Weighted by day-of-week patterns
  - Adjusted for known promotions (upcoming promotions increase projection)
  - Historical promotion periods can be excluded or down-weighted
- **Total demand** = Confirmed + Projected, broken down by:
  - Shopify SKU → pick SKU (via period-specific mapping) → product type (aggregated by weight)

**R2.3: Projection Output (Per Product Type, Per Period)**

| Column | Description |
|--------|-------------|
| Product Type | e.g., "Fruit: Mango, Honey" |
| Confirmed Orders | Order count from confirmed demand |
| Confirmed Demand (lbs) | Weight from confirmed orders |
| Projected Orders | Forecasted order count for remaining period |
| Projected Demand (lbs) | Weight from projected orders |
| Total Demand (lbs) | Confirmed + Projected |
| On-Hand (lbs) | Current inventory in lbs |
| Expected On-Hand (lbs) | Inventory expected after preceding period (for Period 2+) |
| On Order (lbs) | POs placed but not yet received |
| Gap (lbs) | Total Demand - On-Hand - On Order - Expected On-Hand |
| Gap (cases) | Gap converted to cases (rounded up) |
| Status/Flag | Short / Long / OK |

**R2.4: Hourly Granularity Display**
- Show projected orders per time block (e.g., "15 orders expected 2pm-6pm")
- Show total remaining for period
- Both views available on the projection dashboard

**R2.5: Projection Transparency**
- Every projection includes a "methodology report":
  - Historical date range used
  - Periods excluded or re-weighted (with reasons, e.g., "promotion active")
  - Upcoming promotion adjustments applied
  - Confidence notes (high variability SKUs flagged)
- This is critical for trust-building — user needs to understand WHY the number is what it is

**R2.6: Real-Time Refresh**
- Projection is generated on-demand (click "Generate Projection")
- Uses data as of the last Shopify pull (not live Shopify data)
- After pulling new Shopify data → update fulfillment staging → then regenerate projection
- Projection timestamp clearly shown

**R2.7: Padding Configuration**
- Per-SKU or per-product-type padding percentage (some SKUs have higher spoilage/variability)
- Applied on top of projected demand
- Visible in projection output as a separate line

### R3: Vendor Management & Purchase Orders

**R3.1: Vendor Registry**
- CRUD for vendors: name, contact info, communication method
- Per vendor: default product types, default case sizes/weights, default pricing
- Lead time estimates per product type
- Reliability/notes field

**R3.2: Purchase Order Creation (from Projection)**
- From the projection dashboard gap view, click to create a PO
- System pre-fills:
  - Product type from the gap
  - Suggested vendor (default for that product type)
  - Suggested case size/weight (from vendor defaults)
  - Suggested quantity (gap rounded up to whole cases)
  - Flag if rounded-up order exceeds projection by >10%
- User confirms/adjusts vendor, quantity, case size, price, expected delivery date
- Notes field for delivery likelihood, harvest timing, etc.
- A single PO can cover multiple product types (one vendor, multiple line items)
- A single PO can supply multiple projection periods (with per-period allocation and spoilage adjustment)

**R3.3: Multi-Period PO Allocation**
- When a PO covers multiple periods, user specifies allocation:
  - e.g., 1200 lbs loquats: 200 lbs for Period 1, 1000 lbs for Period 2
  - Spoilage adjustment per period: e.g., Period 2 allocation -10% = 900 lbs effective
  - System calculates net effective supply per period
- This updates the "On Order" column in each period's projection

**R3.4: Purchase Order Lifecycle**

```
Draft → Placed → In Transit → Partially Received → Delivered → Imported → Reconciled
```

- **Draft**: PO created but not yet sent to vendor
- **Placed**: Confirmed with vendor (can log communication method)
- **In Transit**: Vendor confirmed shipment
- **Partially Received**: Some line items received, others pending
- **Delivered**: All items physically received
- **Imported**: SKU confirmed and pushed to inventory
- **Reconciled**: Invoice matched, discrepancies resolved

**R3.5: Receiving & SKU Confirmation**
- When delivery arrives, user opens the PO and records receiving:
  - Actual quantity received (cases, weight)
  - Actual SKU determined after inspection (e.g., `mango_honey-09x18`)
  - Harvest date (separate from receive date)
  - Quality notes (condition on arrival)
- System validates: confirmed SKU must match the PO line item's product type
  - e.g., `mango_honey-09x18` is valid for "Fruit: Mango, Honey" ✓
  - e.g., `apple_fuji-40lb` for "Fruit: Mango, Honey" ✗ → error
- SKU confirmation is required before pushing to inventory

**R3.6: Push to Inventory**
- After SKU confirmation, "Push to Inventory" creates:
  - Inventory batch with: SKU, quantity (pieces), harvest date, receive date, calculated expiration (harvest date + shelf life)
  - Inventory adjustment record (type: `po_receive`)
  - Updates on-hand quantity
- PO line status changes from "Delivered" to "Imported"
- Links batch back to PO for traceability

**R3.7: Invoice Reconciliation**
- After PO is imported, user can enter invoice details:
  - Invoiced quantity vs ordered vs received
  - Invoiced price vs quoted price
  - Quality claims (damaged, short-shipped by vendor)
- System highlights discrepancies
- Status → "Reconciled" when all discrepancies are resolved or noted

### R4: Alerts & Flags

**R4.1: Short Inventory Alert**
- Triggered when: projected demand > available inventory + on order + expected on-hand
- Shown on: projection dashboard (per product type row), inventory dashboard
- Severity: warning (close to short) vs critical (significantly short)
- Includes: how many lbs/cases short, which orders would be affected

**R4.2: Long Inventory Alert**
- Triggered when: on-hand inventory > X days of projected sales rate (X configurable per product type, default from shelf life)
- Shown on: projection dashboard, inventory dashboard
- Suggests: "Consider running a promotion — you have 15 days of mango inventory, shelf life is 7 days"
- Includes: estimated spoilage if not sold, days until expiration

**R4.3: Overage Alert (PO)**
- When a PO's rounded-up case quantity exceeds the projection by >10%
- Shown during PO creation and on PO detail view
- User acknowledges or adjusts

**R4.4: Cross-Period Impact Alerts**
- When a change in Period 1 (short ship, inventory adjustment, PO) materially affects Period 2
- e.g., "Short-shipping SKU X in Period 1 adds 45 carry-over orders to Period 2, increasing Period 2 mango demand by 180 lbs"

### R5: Inventory Enhancements

**R5.1: End-of-Week Physical Count**
- UI for entering total inventory count per SKU
- System calculates discrepancy vs app inventory
- Auto-adjusts inventory with adjustment type `physical_count`
- Batch handling for physical counts:
  - If actual < app total: deplete oldest batches first (FIFO), remaining batches get proportional reduction
  - If actual > app total: distribute proportionally across existing batches
  - Adjustment creates audit log entry

**R5.2: Spoilage Entry**
- Manual entry: SKU, quantity discarded, reason/notes
- Creates inventory adjustment (type: `spoilage`)
- Cannot tie to specific batch (known limitation) — deducted proportionally or from oldest batch
- Weekly spoilage report: total spoilage by SKU, cost of spoilage

**R5.3: Expected Spoilage Modeling**
- Per-SKU spoilage rate (percentage per period, configurable)
- Used in cascade calculations: Period 2 expected on-hand accounts for expected spoilage
- Tracks actual vs expected spoilage for model improvement

### R6: Reporting & Accuracy Tracking

**R6.1: Projection Accuracy Report**
- After a period closes, compare projected vs actual demand by product type
- Table: Product Type | Projected (lbs) | Actual (lbs) | Variance | Variance %
- Historical trend: is the projection getting more accurate over time?
- Flag product types with consistently high variance

**R6.2: Spoilage Report**
- Weekly/monthly spoilage by SKU and product type
- Cost of spoilage (using COGS)
- Trend over time

**R6.3: Vendor Performance Report**
- On-time delivery rate
- Quantity accuracy (ordered vs delivered)
- Price accuracy (quoted vs invoiced)
- Quality issues

**R6.4: Projection Methodology Report**
- For any projection: what historical data was used, what was excluded/weighted, what promotions factored in
- Exportable for review/discussion

### R7: BOL Generation
- Standard template: driver name, pickup/delivery location, vendor, items (product type, cases, weight), PO reference
- Editable before print
- PDF export/print

### R8: Klaviyo Integration (Low Priority)
- Pull campaign/flow data: campaign name, send date, audience size, SKU/product targeted
- Correlate with sales spikes in historical data
- Auto-tag historical periods with campaign activity
- Use campaign data to improve projection accuracy

### R9: AI Agent Readiness
- All projection, PO, and alert functionality exposed via well-documented REST API
- Deterministic projection algorithm (same inputs → same outputs) for reproducibility
- Audit trail on all actions (who/what triggered each projection, PO, adjustment)
- Structured data for all decisions (not free-text) to enable agent parsing

---

## Data Model (New Tables)

### projection_periods
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| name | VARCHAR | e.g., "Week 14 - Period 1" |
| start_datetime | DATETIME | Period start (configurable) |
| end_datetime | DATETIME | Period end (configurable) |
| fulfillment_start | DATETIME | When packing begins |
| fulfillment_end | DATETIME | When packing ends |
| status | VARCHAR | draft / active / closed |
| sku_mapping_sheet_tab | VARCHAR | Google Sheets tab name for this period |
| previous_period_id | INTEGER FK | Link to preceding period |
| spoilage_adjustments | JSON | Per-SKU spoilage % overrides for this period |
| notes | TEXT | |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### period_short_ship_configs
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| period_id | INTEGER FK | → projection_periods |
| shopify_sku | VARCHAR | SKU that is short-shipped in this period |
| created_at | DATETIME | |

### period_inventory_hold_configs
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| period_id | INTEGER FK | → projection_periods |
| shopify_sku | VARCHAR | SKU on inventory hold for this period |
| created_at | DATETIME | |

### projections
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| period_id | INTEGER FK | → projection_periods |
| generated_at | DATETIME | When projection was generated |
| shopify_data_as_of | DATETIME | Timestamp of last Shopify sync used |
| projection_start | DATETIME | Start of projected window |
| projection_end | DATETIME | End of projected window |
| historical_range_start | DATE | Start of historical data used |
| historical_range_end | DATE | End of historical data used |
| excluded_periods | JSON | Historical periods excluded (with reasons) |
| promotion_adjustments | JSON | Promotions factored into projection |
| methodology_notes | TEXT | Human-readable methodology summary |
| status | VARCHAR | draft / final |
| created_at | DATETIME | |

### projection_lines
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| projection_id | INTEGER FK | → projections |
| product_type | VARCHAR | e.g., "Fruit: Mango, Honey" |
| confirmed_order_count | INTEGER | Orders already in system |
| confirmed_demand_lbs | DECIMAL | Weight from confirmed orders |
| projected_order_count | INTEGER | Forecasted orders |
| projected_demand_lbs | DECIMAL | Weight from forecasted orders |
| total_demand_lbs | DECIMAL | Confirmed + Projected |
| padding_pct | DECIMAL | Padding applied (per product type) |
| padded_demand_lbs | DECIMAL | Total demand × (1 + padding) |
| on_hand_lbs | DECIMAL | Current inventory in lbs |
| expected_on_hand_lbs | DECIMAL | Expected after preceding period |
| on_order_lbs | DECIMAL | POs placed but not received |
| gap_lbs | DECIMAL | Padded demand - on_hand - on_order - expected_on_hand |
| gap_cases | DECIMAL | Gap / case weight (rounded up) |
| case_weight_lbs | DECIMAL | Case weight used for conversion |
| status_flag | VARCHAR | short / long / ok |

### historical_sales
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| hour_bucket | DATETIME | Hour-level bucket (e.g., 2026-03-15 14:00) |
| shopify_sku | VARCHAR | |
| order_count | INTEGER | Orders containing this SKU in this hour |
| quantity_sold | INTEGER | Total quantity sold |
| revenue | DECIMAL | Total revenue |

### historical_promotions
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| name | VARCHAR | Promotion name/description |
| start_datetime | DATETIME | |
| end_datetime | DATETIME | |
| scope | VARCHAR | store_wide / sku_specific |
| affected_skus | JSON | List of SKUs if sku_specific |
| discount_type | VARCHAR | percentage / fixed / bogo / etc. |
| discount_value | DECIMAL | |
| notes | TEXT | |
| source | VARCHAR | manual / klaviyo |

### vendors
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| name | VARCHAR | |
| contact_name | VARCHAR | |
| contact_email | VARCHAR | |
| contact_phone | VARCHAR | |
| contact_whatsapp | VARCHAR | |
| preferred_communication | VARCHAR | whatsapp / email / phone |
| notes | TEXT | |
| is_active | BOOLEAN | |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### vendor_products
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| vendor_id | INTEGER FK | → vendors |
| product_type | VARCHAR | e.g., "Fruit: Mango, Honey" |
| default_case_weight_lbs | DECIMAL | Standard case weight |
| default_case_count | INTEGER | Pieces per case (if applicable) |
| default_price_per_case | DECIMAL | |
| default_price_per_lb | DECIMAL | |
| lead_time_days | INTEGER | Typical lead time |
| order_unit | VARCHAR | case / lb / piece |
| is_preferred | BOOLEAN | Is this the preferred vendor for this product type? |
| notes | TEXT | Seasonality, reliability notes |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### purchase_orders
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| po_number | VARCHAR | Auto-generated PO number |
| vendor_id | INTEGER FK | → vendors |
| status | VARCHAR | draft / placed / in_transit / partially_received / delivered / imported / reconciled |
| order_date | DATE | |
| expected_delivery_date | DATE | |
| actual_delivery_date | DATE | |
| delivery_notes | TEXT | Likelihood, harvest timing notes |
| communication_method | VARCHAR | How order was placed |
| subtotal | DECIMAL | Calculated from line items |
| notes | TEXT | |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### purchase_order_lines
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| purchase_order_id | INTEGER FK | → purchase_orders |
| product_type | VARCHAR | What's being ordered |
| quantity_cases | DECIMAL | Number of cases ordered |
| case_weight_lbs | DECIMAL | Weight per case |
| total_weight_lbs | DECIMAL | quantity_cases × case_weight_lbs |
| unit_price | DECIMAL | Price per case or per lb |
| price_unit | VARCHAR | case / lb |
| total_price | DECIMAL | |
| notes | TEXT | |

### purchase_order_period_allocations
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| po_line_id | INTEGER FK | → purchase_order_lines |
| period_id | INTEGER FK | → projection_periods |
| allocated_lbs | DECIMAL | How much of this PO line goes to this period |
| spoilage_pct | DECIMAL | Expected spoilage by this period |
| effective_lbs | DECIMAL | allocated_lbs × (1 - spoilage_pct) |

### receiving_records
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| po_line_id | INTEGER FK | → purchase_order_lines |
| received_date | DATE | |
| received_cases | DECIMAL | Actual cases received |
| received_weight_lbs | DECIMAL | Actual weight |
| confirmed_pick_sku | VARCHAR | Actual SKU after inspection |
| confirmed_pieces | INTEGER | Actual piece count |
| harvest_date | DATE | When the fruit was harvested |
| quality_rating | VARCHAR | good / acceptable / poor |
| quality_notes | TEXT | |
| pushed_to_inventory | BOOLEAN | Whether imported to inventory |
| inventory_batch_id | INTEGER FK | → inventory_batches (after push) |
| created_at | DATETIME | |

### invoice_records
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| purchase_order_id | INTEGER FK | → purchase_orders |
| invoice_number | VARCHAR | Vendor invoice number |
| invoice_date | DATE | |
| invoice_total | DECIMAL | |
| qty_discrepancy_notes | TEXT | Ordered vs delivered |
| price_discrepancy_notes | TEXT | Quoted vs invoiced |
| quality_claim_notes | TEXT | Damage, condition issues |
| status | VARCHAR | pending / resolved / disputed |
| resolved_date | DATE | |
| resolution_notes | TEXT | |

### spoilage_entries
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| pick_sku | VARCHAR | |
| product_type | VARCHAR | |
| quantity_discarded | DECIMAL | Pieces or lbs |
| unit | VARCHAR | pieces / lbs |
| weight_lbs | DECIMAL | Always in lbs for aggregation |
| reason | TEXT | |
| entry_date | DATE | |
| entered_by | VARCHAR | |
| created_at | DATETIME | |

### physical_counts
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| count_date | DATE | |
| warehouse | VARCHAR | walnut / northlake |
| status | VARCHAR | pending / applied |
| notes | TEXT | |
| created_at | DATETIME | |

### physical_count_lines
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| physical_count_id | INTEGER FK | → physical_counts |
| pick_sku | VARCHAR | |
| app_quantity | DECIMAL | What the app thinks we have |
| counted_quantity | DECIMAL | What was actually counted |
| discrepancy | DECIMAL | counted - app |
| applied | BOOLEAN | Whether adjustment was applied |

### projection_padding_configs
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| product_type | VARCHAR | |
| padding_pct | DECIMAL | e.g., 0.10 for 10% padding |
| notes | TEXT | Why this product type has this padding |

---

## Phased Roadmap

### Phase 1: Foundation — Projection Periods & Historical Data
**Goal**: Establish the data model, ingest historical sales data, and build period management UI.

**Build:**
1. **Database migrations**: Create tables for `projection_periods`, `period_short_ship_configs`, `period_inventory_hold_configs`, `historical_sales`, `historical_promotions`
2. **Historical data ingestion API**: Endpoint to pull all historical Shopify orders and aggregate into `historical_sales` (hourly buckets by SKU). One-time backfill + incremental sync.
3. **Projection Period CRUD API**: Create, edit, close periods. Auto-suggest default boundaries (Wed-Tue). Support custom datetime ranges.
4. **Period-specific config APIs**: CRUD for short ship and inventory hold configs per period. Copy configs between periods. Visual diff endpoint.
5. **Google Sheets integration**: Extend `sheets_service.py` to read from period-specific tabs for SKU mapping.
6. **Frontend — Period Management page**: Create/edit periods, view timeline. Configure short ship and inventory hold per period. Copy configs with diff view.
7. **Frontend — Historical Promotions page**: Tag historical time periods as having promotions (store-wide or SKU-specific).

**Test:**
- [ ] Can create projection periods with custom date ranges
- [ ] Historical sales data correctly aggregated from Shopify orders at hourly granularity
- [ ] Period-specific short ship and inventory hold configs work independently
- [ ] Copying configs between periods works in both directions
- [ ] Period-specific Google Sheets tabs are read correctly
- [ ] Historical promotions can be tagged and stored

**Estimated scope**: ~3-4 sessions

---

### Phase 2: Core Projection Engine
**Goal**: Generate demand projections per period with confirmed + forecasted orders at the product type level.

**Build:**
1. **Projection engine service** (`projection_service.py`):
   - Calculate confirmed demand: pull orders for period, apply period-specific SKU mapping, aggregate to product type level (lbs)
   - Include inventory hold orders as confirmed demand
   - Include carry-over orders from previous period
   - Calculate projected demand: use historical hourly sales patterns, weighted by day-of-week
   - Apply promotion exclusions/adjustments from `historical_promotions`
   - Apply upcoming promotion multipliers
   - Convert pick SKU demand → product type demand (aggregate by weight)
2. **Padding configuration**: Per-product-type padding % stored in `projection_padding_configs`
3. **Projection generation API**: POST endpoint to generate projection for a period. Stores results in `projections` + `projection_lines`.
4. **Projection methodology**: Auto-generate methodology report (what data was used, what was excluded)
5. **On-hand calculation**: Current inventory aggregated to product type level
6. **Expected on-hand calculation**: For Period 2+, calculate expected remaining after preceding period

**Test:**
- [ ] Confirmed demand correctly includes staged orders, inventory hold orders, and carry-over orders
- [ ] Projected demand uses hourly patterns and day-of-week weighting
- [ ] Promotion-tagged historical periods are correctly excluded or re-weighted
- [ ] Product type aggregation correctly converts pick SKU quantities to lbs
- [ ] Period-specific SKU mapping is used (not global mapping)
- [ ] Padding is applied per product type and visible in output
- [ ] Expected on-hand for Period 2 accounts for Period 1 demand and spoilage
- [ ] Methodology report accurately describes what was done
- [ ] Same inputs produce same outputs (deterministic)

**Estimated scope**: ~4-5 sessions

---

### Phase 3: Projection Dashboard
**Goal**: Interactive dashboard to view, compare, and act on projections.

**Build:**
1. **Projection dashboard page**:
   - Period selector (toggle or side-by-side view for multiple periods)
   - Main table: product type rows with all columns from R2.3
   - Color-coded status flags (short = red, long = yellow, ok = green)
   - Gap column highlights with severity
   - Overage flag on PO suggestions (>10% over projection)
2. **Hourly breakdown panel**: Click on a product type to see projected orders by hour block
3. **Period comparison view**: Side-by-side columns showing how one period's inventory flows into the next
4. **Config diff panel**: View differences in SKU mapping, short ship, inventory hold across periods
5. **Projection history**: View past projections for a period, compare how projection changed over time
6. **Quick actions**: From the dashboard, link to "Create PO" pre-filled with gap data

**Test:**
- [ ] Dashboard loads with correct data for selected period
- [ ] Side-by-side comparison shows both periods with cross-period inventory flow
- [ ] Hourly breakdown shows correct sales distribution
- [ ] Status flags (short/long/ok) correctly calculated
- [ ] Config diff panel shows differences between periods
- [ ] Can navigate from gap to PO creation with pre-filled data
- [ ] Projection history shows all past projections for a period

**Estimated scope**: ~3-4 sessions

---

### Phase 4: Vendor Management & Purchase Orders
**Goal**: Full PO lifecycle from creation through placement.

**Build:**
1. **Vendor registry**: CRUD API and UI for vendors, contact info, default product types/case sizes/pricing
2. **Vendor-product defaults**: Store default case weights, prices, lead times per vendor + product type
3. **Purchase Order CRUD**:
   - Create PO from projection gap (pre-filled) or manually
   - Multi-line POs (multiple product types per vendor)
   - Case size suggestion: auto-calculate cases from lbs demand, always round up
   - Flag when rounded-up order >10% over projection
   - Multi-period allocation: allocate portions of a PO to different periods with spoilage adjustments
4. **PO dashboard**: List all POs with status, vendor, expected delivery, value
5. **PO detail page**: View/edit line items, allocation, status transitions, notes
6. **PO → Projection integration**: PO "on order" quantities feed into projection dashboard's "On Order" column per period

**Test:**
- [ ] Vendor CRUD with product type defaults works correctly
- [ ] PO creation from projection gap pre-fills correct values
- [ ] Case rounding always rounds up and flags >10% overage
- [ ] Multi-period allocation correctly splits lbs across periods with spoilage
- [ ] PO "on order" quantities appear in projection dashboard
- [ ] PO status transitions follow the defined lifecycle
- [ ] Multiple line items per PO work correctly

**Estimated scope**: ~3-4 sessions

---

### Phase 5: Receiving, SKU Confirmation & Inventory Push
**Goal**: Complete the PO lifecycle: receive deliveries, confirm SKUs, push to inventory.

**Build:**
1. **Receiving UI**: Open a PO and record what was actually received per line item
   - Actual cases/weight, harvest date, quality rating/notes
   - Support partial receiving (some lines received, others pending)
2. **SKU confirmation**: Select the actual pick SKU from a filtered list (only SKUs matching the PO line's product type)
   - Validation: SKU must belong to the correct product type
   - Calculate piece count from weight and SKU's per-piece weight
3. **Push to inventory**: One-click import that creates:
   - Inventory batch (harvest date, receive date, calculated expiration)
   - Inventory adjustment (`po_receive` type)
   - Updated on-hand quantity
   - Link back to PO for traceability
4. **PO status auto-progression**: Automatically advance PO status based on receiving state
5. **Receiving history**: View all receiving records for a PO

**Test:**
- [ ] Can record partial receipt (some lines but not all)
- [ ] SKU picker only shows SKUs matching the product type
- [ ] Invalid SKU-to-product-type mappings are rejected
- [ ] Piece count calculated correctly from weight / per-piece weight
- [ ] Inventory batch created with correct harvest date and expiration
- [ ] On-hand quantity updated accurately
- [ ] PO → batch traceability works (can trace batch back to PO)
- [ ] PO status auto-advances correctly

**Estimated scope**: ~3-4 sessions

---

### Phase 6: Alerts, Spoilage & Inventory Enhancements
**Goal**: Proactive alerts, spoilage tracking, and end-of-week physical counts.

**Build:**
1. **Alert engine**:
   - Short alert: projected demand > available + on order + expected on-hand
   - Long alert: on-hand > X days of projected sales rate (X from shelf life or configurable)
   - Show alerts on projection dashboard AND inventory dashboard
   - Alert severity: warning vs critical (configurable thresholds)
   - Cross-period impact alerts: changes in Period 1 that affect Period 2
2. **Spoilage entry UI**: Manual entry per SKU with quantity, reason, date
   - Auto-adjusts inventory (deducted proportionally from oldest batches)
   - Creates audit log entry
3. **Physical count UI**: End-of-week total count per SKU
   - System calculates discrepancy vs app inventory
   - Batch adjustment logic:
     - If actual < app total: deplete oldest batches first (FIFO), then proportional
     - If actual > app total: distribute proportionally across batches
   - Preview adjustment before applying
4. **Expected spoilage modeling**: Per-SKU spoilage rate used in cascade calculations
5. **Spoilage reporting**: Weekly/monthly spoilage by SKU, cost impact

**Test:**
- [ ] Short alerts fire correctly when demand exceeds supply
- [ ] Long alerts fire based on days-of-inventory vs shelf life
- [ ] Alerts appear on both projection and inventory dashboards
- [ ] Cross-period impact alerts show when Period 1 changes affect Period 2
- [ ] Spoilage entries correctly deduct inventory from oldest batches
- [ ] Physical count adjustment logic works for both over and under scenarios
- [ ] Batch adjustments follow FIFO for reductions and proportional for increases
- [ ] Spoilage report shows correct totals by SKU and cost

**Estimated scope**: ~3-4 sessions

---

### Phase 7: Reporting, Invoice Reconciliation & BOL
**Goal**: Accuracy tracking, invoice management, and document generation.

**Build:**
1. **Projection accuracy report**: After period closes, compare projected vs actual by product type
   - Variance tracking over time
   - Flag consistently inaccurate product types
2. **Vendor performance report**: On-time rate, quantity accuracy, price accuracy, quality
3. **Invoice reconciliation UI**: Enter invoice details per PO, compare to ordered/received
   - Quantity, price, and quality discrepancy tracking
   - Resolution workflow (pending → resolved/disputed)
4. **BOL generation**: Template-based PDF for driver pickups/deliveries
   - Pre-filled from PO data (vendor, items, weights, PO reference)
   - Editable fields (driver name, pickup location, delivery instructions)
   - Print/PDF export
5. **Spoilage & inventory report**: End-of-week summary with cost impact

**Test:**
- [ ] Projection accuracy calculated correctly after period closes
- [ ] Vendor performance metrics accurate across multiple POs
- [ ] Invoice reconciliation highlights discrepancies correctly
- [ ] BOL pre-fills from PO data and generates clean PDF
- [ ] Reports exportable / printable

**Estimated scope**: ~3-4 sessions

---

### Phase 8: Klaviyo Integration & AI Agent Readiness (Low Priority)
**Goal**: External integrations and automation preparation.

**Build:**
1. **Klaviyo integration**: Pull campaign/flow data, correlate with sales spikes, auto-tag historical periods
2. **AI agent API surface**: Ensure all projection, PO, and alert endpoints are well-documented, deterministic, and have structured responses
3. **Agent action endpoints**: Generate projection, create PO, flag anomalies — all callable programmatically
4. **Webhook/event system**: Emit events on projection generation, alert triggers, PO status changes (for future agent consumption)

**Test:**
- [ ] Klaviyo data correctly correlates with historical sales patterns
- [ ] All APIs return structured, consistent responses
- [ ] Agent can generate a projection and create a PO through API alone
- [ ] Events fire correctly on state changes

**Estimated scope**: ~2-3 sessions

---

## Summary: Build Order & Dependencies

```
Phase 1: Foundation (Periods, Historical Data, Configs)
    ↓
Phase 2: Projection Engine (Core forecasting logic)
    ↓
Phase 3: Projection Dashboard (View & interact with projections)
    ↓
Phase 4: Vendor Management & POs (Order from vendors)
    ↓
Phase 5: Receiving & Inventory Push (Complete PO lifecycle)
    ↓
Phase 6: Alerts, Spoilage & Inventory (Proactive monitoring)
    ↓
Phase 7: Reporting & Documents (Accuracy, invoices, BOL)
    ↓
Phase 8: Klaviyo & AI Agent (External integrations)
```

**Total estimated scope**: ~25-33 sessions

Each phase is independently valuable — you get increasing utility after each phase ships. Phase 3 alone replaces most of the spreadsheet.

---

## Open Decisions (To Revisit During Build)

1. **Projection algorithm details**: Exact weighting of day-of-week patterns, promotion multipliers, confidence intervals — will need tuning once we have historical data loaded and can evaluate
2. **Alert thresholds**: Starting with "demand > supply" for short and "days on hand > shelf life" for long; will need adjustment based on real usage
3. **SKU mapping migration**: Currently Google Sheets tabs per period; eventual in-app migration is deferred
4. **Batch adjustment edge cases**: What happens when physical count is 0 but app shows positive? (Wipe all batches) What about negative batches after spoilage? (Floor at 0)
5. **Multi-warehouse projections**: Current spec assumes single warehouse per projection period; may need to revisit
