# Product Spec: Order Processing & Fulfillment Automation

## Overview

A web app that replaces a manual spreadsheet-based workflow for processing Shopify orders and pushing shipments through ShipStation. The operator opens the app once or multiple times per day, reviews system-generated shipping decisions with full margin and cost visibility, makes overrides as needed, then pushes to ShipStation and fulfills back to Shopify — with no CSV files.

---

## Business Context

### What the Business Does
Ships fresh fruit (perishable/expiring commodity) to customers via Shopify. Inventory is irregular and difficult to track precisely due to the nature of the product (fruit varies in size, comes in boxes not by piece).

### Why This Can't Use Native Shopify–ShipStation Integration
- Inventory accuracy is not reliable enough to automate fulfillment directly
- Orders may need to be shipped partially depending on margin and priority rules
- Orders need filtering, sorting, and extra decision logic not available in Shopify
- The operator needs visibility and control before committing any shipment

### Current Manual Workflow (to be replaced)
1. Export all orders from Shopify into a spreadsheet
2. Determine which orders and line items to ship
3. Convert Shopify SKUs to Pick/Pack SKUs; determine carrier, service, and box size; split orders into multiple shipments if needed
4. Import converted orders into ShipStation via CSV
5. After shipping, export ShipStation tracking CSV and match tracking numbers to Shopify line item IDs
6. Import fulfillment data back into Shopify via CSV

### Core Problems with Current Spreadsheet
- Rules fail frequently due to incorrect SKU data, product type mismatches, incorrect tags in Shopify
- Discounts (line-level and order-level) are not reliably accounted for, breaking margin calculations
- SKU mapping table is static — can't handle conditional/seasonal conversions dynamically
- No real-time visibility into inventory depletion as orders are confirmed
- Not robust enough to hand off to a junior employee
- Not designed to run multiple times per day

---

## Key Business Rules & Constraints

### Inventory
- Tracked per SKU as a quantity count (not binary in/out)
- Managed in a Google Sheet today; app must read from and write to it
- Restocks can happen mid-day and must re-trigger evaluation of held orders
- Inventory counts can be imprecise due to irregular fruit sizes and box-based delivery

### Orders
- Pulled from Shopify; all unfulfilled orders
- Run #1 of the day pulls all open orders
- Subsequent runs pull new orders since last run + any previously held orders
- Orders tagged `hold` must not ship
- Orders tagged `VIP` are prioritized; no partial unless margin collapses
- Orders tagged `replacement` ship regardless of margin
- Tags and rules change frequently as the business grows — rule editing must not require code changes

### Partial Fulfillment Logic
- Triggered when one or more line items can't be fulfilled due to inventory
- Decision to ship partial vs. hold is based on:
  - Gross margin of the partial shipment (revenue minus COGS minus estimated shipping)
  - Order-level tags (e.g. `VIP`, `hold`, `replacement`)
  - Configurable margin threshold
- System must surface both full and partial scenarios with margin for each before the operator commits

### Gross Margin Calculation
- Revenue = normalized actual revenue per line item
  - Must account for line-level discounts, order-level discounts (prorated), and price-level adjustments
  - This is a known failure point in the current spreadsheet
- COGS = per-SKU cost, updated weekly, tracked with effective dates
- Shipping cost = estimated from rate cards (not live quote); good enough for go/no-go decisions

### SKU Conversion
- Shopify SKU → one or more Pick/Pack SKUs
- Mapping is **conditional**: same Shopify SKU can map differently based on season or available inventory
- Example: a "variety box" SKU maps to 5–10 fruit SKUs; if one fruit runs out, operator can swap in a substitute mid-day
- Missing or invalid mappings must be surfaced as exceptions before an order can proceed

### Shipping
- Box sizes: 8×8×8, 10×10×10, 12×12×12 (standard boxes); USPS medium and large flat rate boxes
- Carriers: USPS and UPS
- Box and carrier selection based on: weight, destination zone, cost, and speed
- Rate cards will be provided; estimated costs (not live API quotes) are sufficient for decision-making
- Orders can be split into multiple shipments if they don't fit in one box

### COGS Data
- Tracked in a spreadsheet; changes weekly based on season, vendor, or batch
- Must be connectable to the app as a live data source
- Effective dates required so historical margin calculations remain accurate

---

## System Architecture

### Stack
- **Backend**: Python (FastAPI) — all business logic, rule engine, API integrations
- **Frontend**: React — daily operator UI
- **Data sources**: Google Sheets (inventory + COGS, live-connected during transition; replaceable later)
- **Integrations**: Shopify API, ShipStation API
- **No CSV files** in the final system

### Who Uses This
- **Now**: Just the operator (Rob), running it once or multiple times per day
- **Future**: Designed to be handed off to a junior employee; must include a simplified view and plain-language exception explanations

---

## Phase Breakdown

### Phase 1 — Data Foundation

**Task 1.1 — SKU Mapping Table**
Migrate Shopify→Pick/Pack SKU conversion into a structured, queryable format. Must support conditional mappings (e.g. variety box → different fruit SKUs by season or substitution). Editable mid-day without touching code.

**Task 1.2 — COGS Table**
Connect existing COGS-per-SKU spreadsheet as a live data source. Build lightweight edit UI for weekly updates. Track effective dates for historical accuracy.

**Task 1.3 — Rate Card Table**
Enter USPS and UPS rate cards by weight, destination zone, and box size. Powers shipping cost estimates used in go/no-go decisions. Must be editable when rates change.

**Task 1.4 — Rule Engine (Config, Not Code)**
Build a rules configuration interface for order-level tags and behaviors. Initial rules:
- `hold` → do not ship
- `VIP` → prioritize; no partial unless margin collapses
- `replacement` → ship regardless of margin

Rules must be editable without a developer. This replaces the brittle spreadsheet formulas.

**Milestone**: All reference data is live, editable, and returning correct lookups for 10 real test orders.

---

### Phase 2 — Inventory Management

**Task 2.1 — Inventory Import & Display**
Pull today's opening inventory from Google Sheet via API. Display current available quantities per SKU in the app as the starting point for each run.

**Task 2.2 — Inventory Commitment & Deduction**
When orders are confirmed, inventory is deducted in real time. Tracks committed vs. available across multiple runs per day. Held orders from earlier runs remain visible and re-enter the queue if inventory is restocked.

**Task 2.3 — Restock Input**
Simple UI to log a mid-day restock (SKU + qty added). Updates available inventory immediately and re-evaluates held orders blocked by that SKU.

**Task 2.4 — Inventory Warning Flags**
When inventory runs low mid-processing, surface a clear flag before committing: "3 orders still need this SKU, only 2 units left." Options: substitute SKU, ship partial, or hold. This drives the dynamic substitution flow (e.g. variety box replacements).

**Milestone**: Full simulated day — open inventory, process orders, restock mid-day, run again — with accurate inventory throughout.

---

### Phase 3 — Order Ingestion & Decision Engine

**Task 3.1 — Shopify Order Pull**
Connect to Shopify API. Pull unfulfilled orders since last run (first run of day = all open orders; subsequent runs = new + previously held). Capture: line items, quantities, SKUs, prices, discounts (line-level and order-level), tags, customer info, shipping address.

**Task 3.2 — Revenue Normalization**
Correctly compute actual revenue per line item accounting for line-level discounts, order-level discounts (prorated), and price-level adjustments. This fixes the core bug in the current spreadsheet.

**Task 3.3 — SKU Conversion**
Apply conditional SKU mapping to each line item. Flag any line items with no valid mapping as exceptions requiring manual resolution before the order can proceed.

**Task 3.4 — Margin & Shipping Cost Calculation**
For each order — full and partial scenarios:
- Gross margin = normalized revenue − COGS of items shipping
- Estimated shipping cost = rate card lookup (box size from weight/dimensions, carrier/service from zone + speed + cost rules)
- Surface: revenue, COGS, shipping cost, and gross margin % for full and each viable partial scenario

**Task 3.5 — Automated Decision per Order**
Apply rule engine and produce a recommended action: Ship Full, Ship Partial (specific line items listed), or Hold. Show reasoning. Examples:
- "Holding: tagged hold"
- "Partial recommended: SKU X unavailable, margin at 34% still above threshold"
- "Exception: SKU mapping missing for item Y"

**Milestone**: Feed in 20 real historical orders and verify every decision matches what the operator would have done manually.

---

### Phase 4 — Review UI

**Task 4.1 — Order Review Dashboard**
Single screen showing all orders for the current run, grouped by status: Ready to Ship, Partial (needs confirmation), Exceptions, Held. Each row shows: order ID, customer, tags, items, recommended action, margin %, estimated shipping cost.

**Task 4.2 — Order Detail & Override**
Click into any order to see full breakdown: line items, SKU conversions, box assignment, carrier, margin waterfall. Override any decision — change carrier, swap SKU substitution, change partial→full or full→hold — and margin/cost recalculates live.

**Task 4.3 — Exception Queue**
Dedicated view for orders the engine couldn't resolve: missing SKU mappings, tag conflicts, margin edge cases. Each exception shows exactly what's wrong and what needs to be fixed. Designed so a junior employee can handle most exceptions without escalation.

**Task 4.4 — Inventory Warning Flow**
When inventory runs short mid-review (as orders are approved and stock depletes), surface a modal: show which orders are affected, how many units short, and offer options — substitute SKU (from mapping table), convert to partial, or hold. Confirm and the decision propagates.

**Milestone**: Operator processes a full day's real orders end-to-end in the UI faster than the current spreadsheet workflow.

---

### Phase 5 — ShipStation & Shopify Integration

**Task 5.1 — ShipStation Order Push**
After operator confirms, push all approved shipments to ShipStation via API. Each shipment includes: converted pick/pack SKUs, box size, carrier/service, recipient info. Split orders into multiple ShipStation shipments where required.

**Task 5.2 — Tracking Number Ingestion**
Poll ShipStation API after labels are generated. Pull tracking numbers back and match to internal order/line item records.

**Task 5.3 — Shopify Fulfillment Push**
Push fulfillments back to Shopify via API. Mark the correct line items as fulfilled with tracking numbers. Handle partial fulfillments correctly — only mark the line items that actually shipped.

**Task 5.4 — Run Summary & Audit Log**
After each run: show a summary (orders shipped, held, partial, total units, total estimated shipping cost). Write a full audit log of every decision, override, and exception resolution. Required for junior employee handoff and accountability.

**Milestone**: Full end-to-end run — Shopify → app → ShipStation → tracking → Shopify fulfillment — with zero manual CSV steps.

---

### Phase 6 — Hardening & Handoff

**Task 6.1 — Edge Case Library**
Document and test the 10 most common failure modes from the current spreadsheet (wrong tags, missing SKUs, discount edge cases, irregular inventory counts, etc.). Write explicit handling for each.

**Task 6.2 — Rule Engine Expansion**
UI for creating and editing new rules as the business grows — without code. New tags, margin thresholds, carrier preferences, SKU substitution logic.

**Task 6.3 — Junior Employee Mode**
Simplified view surfacing only what needs a human decision, with plain-language exception explanations. Escalation path for anything outside defined rules.

**Task 6.4 — Rerun Safety**
Prevent double-pushing orders to ShipStation or double-fulfilling in Shopify if the app is run twice or a browser tab is refreshed mid-run.

---

## Key Decision Points & Open Questions

| Topic | Decision |
|---|---|
| ShipStation integration | Direct API (no CSV) |
| Shipping cost for go/no-go | Estimated from rate cards (not live API quote) |
| SKU mapping | Conditional — season and inventory dependent |
| Inventory source | Google Sheet (live-connected via API) |
| COGS source | Spreadsheet (live-connected; operator updates weekly) |
| Rule editing | Config UI — no code required |
| Multi-run behavior | New orders + held orders re-enter queue each run |
| Primary user | Operator now; junior employee handoff planned |

---

## Known Failure Modes to Address

1. Incorrect tags in Shopify causing wrong shipping decisions
2. Missing or mismatched SKU mappings
3. Line-level and order-level discounts not prorated correctly
4. Price-level adjustments not captured in revenue
5. Inventory counts imprecise due to irregular fruit sizes
6. Variety box SKU conversion becoming stale when a fruit runs out mid-day
7. COGS not updated in time for weekly price changes
8. Orders double-pushed to ShipStation on rerun
9. Partial fulfillment incorrectly marking all line items as fulfilled in Shopify
10. Rules breaking when new product types or tags are added to the website
