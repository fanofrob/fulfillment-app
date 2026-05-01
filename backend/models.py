from sqlalchemy import Column, Integer, String, Float, Boolean, Date, DateTime, Text, JSON, ForeignKey, UniqueConstraint
from sqlalchemy.sql import func
from database import Base

PICKLIST_CATEGORIES = ("Basic", "Tropical", "Exotic")

class PicklistSku(Base):
    __tablename__ = "picklist_skus"
    id = Column(Integer, primary_key=True, index=True)
    pick_sku = Column(String, nullable=False, unique=True, index=True)
    customer_description = Column(String, nullable=True)
    weight_lb = Column(Float, nullable=True)
    pactor_multiplier = Column(Float, nullable=True)
    pactor = Column(Float, nullable=True)
    temperature = Column(String, nullable=True)
    type = Column(String, nullable=True)
    category = Column(String, nullable=True)  # one of PICKLIST_CATEGORIES, or NULL = uncategorized
    status = Column(String, nullable=True)
    cc_item_id = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    days_til_expiration = Column(Float, nullable=True)  # shelf life in days; used to default batch expiration date
    # SKU-level cost override (used for COGS/margin calculation)
    # Use cost_per_lb directly, OR set cost_per_case + case_weight_lb and the app computes cost_per_lb = cost_per_case / case_weight_lb
    cost_per_lb      = Column(Float, nullable=True)   # direct cost per lb override
    cost_per_case    = Column(Float, nullable=True)   # cost for one full case
    case_weight_lb   = Column(Float, nullable=True)   # weight of one full case in lbs
    synced_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class SkuMapping(Base):
    __tablename__ = "sku_mappings"
    id = Column(Integer, primary_key=True, index=True)
    warehouse = Column(String, nullable=False)  # 'walnut' or 'northlake'
    shopify_sku = Column(String, nullable=False, index=True)
    pick_sku = Column(String, nullable=True)
    mix_quantity = Column(Float, nullable=True, default=1.0)
    product_type = Column(String, nullable=True)
    pick_type = Column(String, nullable=True)
    pick_weight_lb = Column(Float, nullable=True)
    lineitem_weight = Column(Float, nullable=True)
    shop_status = Column(String, nullable=True)  # 'Active', 'Inactive'
    is_active = Column(Boolean, default=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

class SkuHelperMapping(Base):
    """
    Variant-to-canonical Shopify SKU normalization. A single product often gets
    re-published in Shopify with auto-suffixed SKUs (`-2lb_2`, `-1lb_pos`, etc.);
    this table maps every variant back to one helper SKU so we don't have to
    add every variant row to the SkuMapping table. Sourced originally from the
    INPUT_SKU_TYPE Google Sheet; the DB is the canonical source going forward.
    """
    __tablename__ = "sku_helper_mappings"
    id = Column(Integer, primary_key=True, index=True)
    shopify_sku = Column(String, nullable=False, unique=True, index=True)
    helper_sku = Column(String, nullable=False, index=True)
    notes = Column(Text, nullable=True)
    synced_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class CogsCost(Base):
    __tablename__ = "cogs_costs"
    id = Column(Integer, primary_key=True, index=True)
    product_type = Column(String, nullable=False, index=True)
    price_per_lb = Column(Float, nullable=False)
    effective_date = Column(Date, nullable=False)
    vendor = Column(String, nullable=True)
    invoice_number = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

class RateCard(Base):
    __tablename__ = "rate_cards"
    id = Column(Integer, primary_key=True, index=True)
    carrier = Column(String, nullable=False)  # 'USPS', 'UPS'
    service_name = Column(String, nullable=False)
    weight_lb = Column(Float, nullable=True)   # null for flat rate
    zone = Column(Integer, nullable=True)       # null for flat rate
    rate = Column(Float, nullable=False)
    is_flat_rate = Column(Boolean, default=False)
    effective_date = Column(Date, nullable=False)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class BoxType(Base):
    __tablename__ = "box_types"
    id           = Column(Integer, primary_key=True, index=True)
    name         = Column(String, nullable=False, unique=True)   # friendly display name
    pick_sku     = Column(String, nullable=True, index=True)     # inventory SKU for this box; if set, 1 unit committed/deducted per box used
    carrier      = Column(String, nullable=True)                 # USPS | FedEx | UPS
    package_code = Column(String, nullable=True)                 # exact ShipStation packageCode
    length_in    = Column(Float, nullable=True)                  # inches
    width_in     = Column(Float, nullable=True)
    height_in    = Column(Float, nullable=True)
    weight_oz    = Column(Float, nullable=True)                  # tare weight of the box in oz
    description  = Column(Text, nullable=True)
    is_active    = Column(Boolean, nullable=False, default=True)
    created_at   = Column(DateTime(timezone=True), server_default=func.now())
    updated_at   = Column(DateTime(timezone=True), onupdate=func.now())


class PackageRule(Base):
    __tablename__ = "package_rules"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    package_type = Column(String, nullable=False)  # e.g. '11x8x6', 'LFR', '12x12x12', '2x LFR'
    priority = Column(Integer, nullable=False, default=0)  # higher = evaluated first
    is_active = Column(Boolean, nullable=False, default=True)
    # JSON array of condition objects:
    # [{"field": "pactor"|"zone"|"tags", "operator": "lt"|"lte"|"gt"|"gte"|"eq"|"neq"|
    #   "between"|"contains"|"not_contains"|"is_exactly"|"is_empty"|"not_empty",
    #   "value": ..., "value2": ...}]
    conditions = Column(JSON, nullable=False, default=list)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

class CarrierServiceRule(Base):
    __tablename__ = "carrier_service_rules"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    carrier_code = Column(String, nullable=False)        # ShipStation carrierCode, e.g. 'stamps_com', 'fedex'
    service_code = Column(String, nullable=False)        # ShipStation serviceCode, e.g. 'usps_priority_mail'
    shipping_provider_id = Column(Integer, nullable=True)  # SS shippingProviderId — disambiguates multiple accounts with same carrierCode (e.g. two Stamps.com/USPS accounts). Sent as advancedOptions.billToMyOtherAccount.
    priority = Column(Integer, nullable=False, default=0)  # higher = evaluated first
    is_active = Column(Boolean, nullable=False, default=True)
    # JSON array of condition objects (same schema as PackageRule conditions)
    conditions = Column(JSON, nullable=False, default=list)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class OrderRule(Base):
    __tablename__ = "order_rules"
    id = Column(Integer, primary_key=True, index=True)
    tag = Column(String, nullable=False, index=True)
    action = Column(String, nullable=False)  # 'hold', 'dnss', 'priority_1', 'priority_2', 'priority_3', 'margin_override'
    min_margin_pct_override = Column(Float, nullable=True)
    description = Column(Text, nullable=True)
    priority = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


# ── Inventory (persistent, no sessions) ───────────────────────────────────────

class InventoryItem(Base):
    """
    Persistent inventory record per pick SKU per warehouse.
    on_hand_qty is manually managed via adjustments.
    committed_qty is auto-computed from open orders.
    available_qty = on_hand_qty - committed_qty.
    shipped_qty is informational (from shipped/fulfilled orders this cycle).
    """
    __tablename__ = "inventory_items"
    id            = Column(Integer, primary_key=True, index=True)
    pick_sku      = Column(String, nullable=False, index=True)
    warehouse     = Column(String, nullable=False)  # 'walnut' | 'northlake'
    name          = Column(String, nullable=True)
    on_hand_qty   = Column(Float, nullable=False, default=0.0)
    committed_qty = Column(Float, nullable=False, default=0.0)
    available_qty = Column(Float, nullable=False, default=0.0)
    shipped_qty   = Column(Float, nullable=False, default=0.0)
    days_on_hand  = Column(Float, nullable=True)
    batch_code    = Column(String, nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())
    updated_at    = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint('pick_sku', 'warehouse', name='uq_item_sku_warehouse'),
    )


class InventoryAdjustment(Base):
    """
    Audit log of every change to inventory on_hand_qty.
    delta is signed: positive = stock added, negative = stock removed.
    adjustment_type: 'manual_add' | 'manual_deduct' | 'initial_set' | 'ship_deduct' | 'restock' | 'batch_adjust'
    """
    __tablename__ = "inventory_adjustments"
    id               = Column(Integer, primary_key=True, index=True)
    pick_sku         = Column(String, nullable=False, index=True)
    warehouse        = Column(String, nullable=False)
    delta            = Column(Float, nullable=False)
    adjustment_type  = Column(String, nullable=False)
    note             = Column(Text, nullable=True)
    shopify_order_id = Column(String, nullable=True, index=True)
    batch_id         = Column(Integer, nullable=True, index=True)  # linked batch if applicable
    created_at       = Column(DateTime(timezone=True), server_default=func.now())


class InventoryBatch(Base):
    """
    A named batch of inventory received for a specific pick_sku/warehouse.
    quantity_remaining tracks how much of this batch is left after manual adjustments.
    expiration_date is informational only — no auto-depletion occurs.
    """
    __tablename__ = "inventory_batches"
    id                 = Column(Integer, primary_key=True, index=True)
    pick_sku           = Column(String, nullable=False, index=True)
    warehouse          = Column(String, nullable=False)
    batch_code         = Column(String, nullable=False)
    quantity_received  = Column(Float, nullable=False)   # original qty when received
    quantity_remaining = Column(Float, nullable=False)   # current qty after adjustments
    received_date      = Column(Date, nullable=False)
    expiration_date    = Column(Date, nullable=True)     # flagging only, not auto-deleted
    notes              = Column(Text, nullable=True)
    created_at         = Column(DateTime(timezone=True), server_default=func.now())
    updated_at         = Column(DateTime(timezone=True), onupdate=func.now())


# ── Orders ────────────────────────────────────────────────────────────────────

class ShopifyOrder(Base):
    __tablename__ = "shopify_orders"
    id                    = Column(Integer, primary_key=True, index=True)
    shopify_order_id      = Column(String, nullable=False, unique=True, index=True)
    shopify_order_number  = Column(String, nullable=True)
    customer_name         = Column(String, nullable=True)
    customer_email        = Column(String, nullable=True)
    shipping_name         = Column(String, nullable=True)
    shipping_address1     = Column(String, nullable=True)
    shipping_address2     = Column(String, nullable=True)
    shipping_city         = Column(String, nullable=True)
    shipping_province     = Column(String, nullable=True)
    shipping_zip          = Column(String, nullable=True)
    shipping_country      = Column(String, nullable=True)
    tags                  = Column(String, nullable=True)  # comma-separated
    financial_status      = Column(String, nullable=True)
    fulfillment_status    = Column(String, nullable=True)
    total_price           = Column(Float, nullable=True)
    subtotal_price        = Column(Float, nullable=True)
    total_discounts       = Column(Float, nullable=True)
    total_shipping_price  = Column(Float, nullable=True)  # what the customer paid for shipping
    total_weight_g        = Column(Integer, nullable=True)
    note                  = Column(Text, nullable=True)
    created_at_shopify    = Column(DateTime(timezone=True), nullable=True)
    pulled_at             = Column(DateTime(timezone=True), server_default=func.now())
    updated_at            = Column(DateTime(timezone=True), onupdate=func.now())
    # Fulfillment pipeline status
    app_status            = Column(String, nullable=False, default='not_processed', index=True)
    # 'not_processed' | 'staged' | 'in_shipstation_not_shipped' | 'in_shipstation_shipped'
    # | 'fulfilled' | 'partially_fulfilled'
    # staged = inventory committed; only staged orders can be pushed to ShipStation
    assigned_warehouse    = Column(String, nullable=False, default='walnut')
    shipstation_order_id  = Column(String, nullable=True)
    shipstation_order_key = Column(String, nullable=True)
    tracking_number           = Column(String, nullable=True)
    last_synced_at            = Column(DateTime(timezone=True), nullable=True)
    estimated_delivery_date   = Column(DateTime(timezone=True), nullable=True)
    shopify_hold              = Column(Boolean, nullable=False, default=False)  # True if Shopify has placed a fulfillment hold (e.g. fraud, manual hold)
    ss_duplicate              = Column(Boolean, nullable=False, default=False)  # True if order exists unshipped in ShipStation (pre-app duplicate)


class ShopifyLineItem(Base):
    __tablename__ = "shopify_line_items"
    id                        = Column(Integer, primary_key=True, index=True)
    shopify_order_id          = Column(String, ForeignKey("shopify_orders.shopify_order_id"), nullable=False, index=True)
    line_item_id              = Column(String, nullable=False)
    shopify_sku               = Column(String, nullable=True)
    pick_sku                  = Column(String, nullable=True)  # resolved from SKU mapping
    product_title             = Column(String, nullable=True)
    variant_title             = Column(String, nullable=True)
    quantity                  = Column(Integer, nullable=False, default=1)
    fulfillable_quantity      = Column(Integer, nullable=True)
    price                     = Column(Float, nullable=True)
    total_discount            = Column(Float, nullable=True)
    grams                     = Column(Integer, nullable=True)
    requires_shipping         = Column(Boolean, nullable=True)
    sku_mapped                = Column(Boolean, nullable=False, default=False)
    mix_quantity              = Column(Float, nullable=True, default=1.0)
    fulfillment_status        = Column(String, nullable=True)  # per-line: "fulfilled" or null (from Shopify)
    app_line_status           = Column(String, nullable=True)
    shipstation_line_item_id  = Column(String, nullable=True)


# ── Fulfillment Plans ─────────────────────────────────────────────────────────

class FulfillmentPlan(Base):
    """
    A fulfillment plan ties a Shopify order to one or more boxes.
    Status: draft | active | needs_review | needs_reconfiguration | completed | cancelled
    """
    __tablename__ = "fulfillment_plans"
    id               = Column(Integer, primary_key=True, index=True)
    shopify_order_id = Column(String, ForeignKey("shopify_orders.shopify_order_id"), nullable=False, index=True)
    version          = Column(Integer, default=1)
    status           = Column(String, default="draft")
    notes            = Column(Text, nullable=True)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())
    updated_at       = Column(DateTime(timezone=True), onupdate=func.now())


class FulfillmentBox(Base):
    """
    One box in a fulfillment plan. Each box maps 1:1 to a ShipStation order.
    Status: pending | packed | shipped
    """
    __tablename__ = "fulfillment_boxes"
    id                    = Column(Integer, primary_key=True, index=True)
    plan_id               = Column(Integer, ForeignKey("fulfillment_plans.id"), nullable=False, index=True)
    box_type_id           = Column(Integer, ForeignKey("box_types.id"), nullable=True)
    box_number            = Column(Integer, nullable=False)
    status                = Column(String, default="pending")
    shipstation_order_id  = Column(String, nullable=True)
    shipstation_order_key = Column(String, nullable=True)
    tracking_number           = Column(String, nullable=True)
    carrier                   = Column(String, nullable=True)
    notes                     = Column(Text, nullable=True)
    shipped_at                = Column(DateTime(timezone=True), nullable=True)
    estimated_delivery_date   = Column(DateTime(timezone=True), nullable=True)
    # Cost snapshots — frozen at ship time for accurate fulfilled GM%
    shipping_cost_snapshot    = Column(Float, nullable=True)
    packaging_cost_snapshot   = Column(Float, nullable=True)
    created_at            = Column(DateTime(timezone=True), server_default=func.now())
    updated_at            = Column(DateTime(timezone=True), onupdate=func.now())


class BoxLineItem(Base):
    """
    A line item assigned to a specific box.
    quantity is in pick units (mix_quantity already applied).
    """
    __tablename__ = "box_line_items"
    id                   = Column(Integer, primary_key=True, index=True)
    box_id               = Column(Integer, ForeignKey("fulfillment_boxes.id"), nullable=False, index=True)
    shopify_line_item_id = Column(String, nullable=True)
    pick_sku             = Column(String, nullable=False)
    shopify_sku          = Column(String, nullable=True)
    product_title        = Column(String, nullable=True)
    quantity             = Column(Float, nullable=False)
    # Cost snapshots — frozen at ship time for accurate fulfilled GM%
    cost_per_lb_snapshot = Column(Float, nullable=True)
    weight_lb_snapshot   = Column(Float, nullable=True)
    created_at           = Column(DateTime(timezone=True), server_default=func.now())
    updated_at           = Column(DateTime(timezone=True), onupdate=func.now())


class ShopifyProduct(Base):
    """
    Product catalog pulled from Shopify. One row per variant SKU.
    allow_short_ship: when True, orders containing this SKU will have
    those line items marked 'short_ship' and excluded from fulfillment/margin.
    inventory_hold: when True, orders containing this SKU will have those
    line items marked 'inventory_hold' and the order blocked from staging.
    Mutually exclusive with allow_short_ship.
    """
    __tablename__ = "shopify_products"
    id                 = Column(Integer, primary_key=True, index=True)
    shopify_product_id = Column(String, nullable=True, index=True)
    shopify_sku        = Column(String, nullable=False, unique=True, index=True)
    title              = Column(String, nullable=True)
    product_type       = Column(String, nullable=True)
    allow_short_ship   = Column(Boolean, nullable=False, default=False)
    inventory_hold     = Column(Boolean, nullable=False, default=False)
    synced_at          = Column(DateTime(timezone=True), nullable=True)
    created_at         = Column(DateTime(timezone=True), server_default=func.now())
    updated_at         = Column(DateTime(timezone=True), onupdate=func.now())


class LineItemChangeEvent(Base):
    """
    Recorded when Shopify line items diverge from the current plan's box items.
    old_line_items / new_line_items: JSON dicts keyed by pick_sku → quantity.
    Status: pending_approval | approved | rejected
    """
    __tablename__ = "line_item_change_events"
    id               = Column(Integer, primary_key=True, index=True)
    plan_id          = Column(Integer, ForeignKey("fulfillment_plans.id"), nullable=False, index=True)
    shopify_order_id = Column(String, nullable=False, index=True)
    detected_at      = Column(DateTime(timezone=True), server_default=func.now())
    old_line_items   = Column(JSON, nullable=False)   # {pick_sku: qty, ...}
    new_line_items   = Column(JSON, nullable=False)   # {pick_sku: qty, ...}
    status           = Column(String, default="pending_approval")
    reviewed_at      = Column(DateTime(timezone=True), nullable=True)
    notes            = Column(Text, nullable=True)


# ── Packaging Materials ───────────────────────────────────────────────────────

class PackagingMaterial(Base):
    """
    Individual packaging items with a per-unit cost (e.g., cardboard box, ice pack, liner).
    Associated with box types via BoxTypePackaging.
    """
    __tablename__ = "packaging_materials"
    id         = Column(Integer, primary_key=True, index=True)
    name       = Column(String, nullable=False, unique=True)
    unit_cost  = Column(Float, nullable=False, default=0.0)   # cost per unit ($)
    unit       = Column(String, nullable=True, default="each")  # "each", "oz", etc.
    is_active  = Column(Boolean, nullable=False, default=True)
    notes      = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class BoxTypePackaging(Base):
    """
    Defines which packaging materials go into a given box type, and in what quantity.
    Total packaging cost for a box = sum(material.unit_cost * quantity) for all entries.
    """
    __tablename__ = "box_type_packaging"
    id                    = Column(Integer, primary_key=True, index=True)
    box_type_id           = Column(Integer, ForeignKey("box_types.id"), nullable=False, index=True)
    packaging_material_id = Column(Integer, ForeignKey("packaging_materials.id"), nullable=False)
    quantity              = Column(Float, nullable=False, default=1.0)
    created_at            = Column(DateTime(timezone=True), server_default=func.now())
    updated_at            = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint('box_type_id', 'packaging_material_id', name='uq_box_material'),
    )


# ── GM Settings ───────────────────────────────────────────────────────────────

class GmSettings(Base):
    """
    Global gross margin estimate settings. Single-row table (always id=1).
    All pct fields are 0–100 (e.g., 1.0 = 1%).
    """
    __tablename__ = "gm_settings"
    id                    = Column(Integer, primary_key=True, index=True)
    replacement_pct       = Column(Float, nullable=False, default=1.0)
    refund_pct            = Column(Float, nullable=False, default=1.0)
    transaction_fee_pct   = Column(Float, nullable=False, default=2.9)
    updated_at            = Column(DateTime(timezone=True), onupdate=func.now())


class ArchivedOrder(Base):
    """
    Log of orders that were auto-archived in Shopify during a pull because they
    matched the no-address / subscription_recurring_order / $0 criteria.
    """
    __tablename__ = "archived_orders"
    id                   = Column(Integer, primary_key=True, index=True)
    shopify_order_id     = Column(String, nullable=False, unique=True, index=True)
    shopify_order_number = Column(String, nullable=True)
    customer_name        = Column(String, nullable=True)
    customer_email       = Column(String, nullable=True)
    tags                 = Column(String, nullable=True)
    total_price          = Column(Float, nullable=True)
    line_items_summary   = Column(String, nullable=True)
    shopify_archived     = Column(Boolean, nullable=False, default=False)
    archived_at          = Column(DateTime(timezone=True), server_default=func.now())


# ── Projection System ────────────────────────────────────────────────────────

class ProjectionPeriod(Base):
    """
    A named time window for demand projection with configurable date boundaries.
    Default cycle: Wed 12:00am → Tue 11:59pm.
    Status: draft | active | closed | archived.
    """
    __tablename__ = "projection_periods"
    id                    = Column(Integer, primary_key=True, index=True)
    name                  = Column(String, nullable=False)
    start_datetime        = Column(DateTime(timezone=True), nullable=False)
    end_datetime          = Column(DateTime(timezone=True), nullable=False)
    fulfillment_start     = Column(DateTime(timezone=True), nullable=True)
    fulfillment_end       = Column(DateTime(timezone=True), nullable=True)
    status                = Column(String, nullable=False, default="draft")  # draft | active | closed | archived
    sku_mapping_sheet_tab = Column(String, nullable=True)
    previous_period_id    = Column(Integer, ForeignKey("projection_periods.id"), nullable=True)
    spoilage_adjustments  = Column(JSON, nullable=True)   # per-SKU spoilage % overrides
    notes                 = Column(Text, nullable=True)
    # Confirmed-demand review/override layer (see ProjectionPeriodConfirmedOrder)
    confirmed_demand_auto_lbs     = Column(JSON, nullable=True)   # {product_type: lbs} computed by projection engine
    confirmed_demand_manual_lbs   = Column(JSON, nullable=True)   # {product_type: lbs} saved from the Projections Orders UI
    has_manual_confirmed_demand   = Column(Boolean, nullable=False, default=False)
    confirmed_demand_saved_at     = Column(DateTime(timezone=True), nullable=True)
    created_at            = Column(DateTime(timezone=True), server_default=func.now())
    updated_at            = Column(DateTime(timezone=True), onupdate=func.now())


class ProjectionPeriodConfirmedOrder(Base):
    """
    Join table tracking which orders a human has "confirmed" as demand for a projection period,
    along with the frozen box contents and SKU mapping used at confirm time so the rollup
    stays reproducible even if the underlying plan or mapping changes later.
    """
    __tablename__ = "projection_period_confirmed_orders"
    id               = Column(Integer, primary_key=True, index=True)
    period_id        = Column(Integer, ForeignKey("projection_periods.id"), nullable=False, index=True)
    shopify_order_id = Column(String, ForeignKey("shopify_orders.shopify_order_id"), nullable=False, index=True)
    boxes_snapshot   = Column(JSON, nullable=False)   # [{pick_sku, quantity, weight_lb, product_type}, ...]
    mapping_used     = Column(String, nullable=False) # Google Sheets tab name
    confirmed_at     = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint('period_id', 'shopify_order_id', name='uq_period_confirmed_order'),
    )


class PeriodShortShipConfig(Base):
    """
    Short-ship SKU configuration scoped to a specific projection period.

    Drives the *projection forecast engine only* (services/projection_service.py).
    Does NOT affect the Confirmed Orders view or Confirmed Demand rollup —
    those read from `ConfirmedDemandShortShipConfig` instead.
    """
    __tablename__ = "period_short_ship_configs"
    id          = Column(Integer, primary_key=True, index=True)
    period_id   = Column(Integer, ForeignKey("projection_periods.id"), nullable=False, index=True)
    shopify_sku = Column(String, nullable=False)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint('period_id', 'shopify_sku', name='uq_period_short_ship'),
    )


class PeriodInventoryHoldConfig(Base):
    """
    Inventory-hold counterpart to PeriodShortShipConfig — projection-forecast only.
    """
    __tablename__ = "period_inventory_hold_configs"
    id          = Column(Integer, primary_key=True, index=True)
    period_id   = Column(Integer, ForeignKey("projection_periods.id"), nullable=False, index=True)
    shopify_sku = Column(String, nullable=False)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint('period_id', 'shopify_sku', name='uq_period_inv_hold'),
    )


class ConfirmedDemandShortShipConfig(Base):
    """
    Short-ship SKU configuration for the Confirmed Demand Dashboard, scoped per
    projection period. Drives:
      - the confirmed-demand rollup
      - the Confirmed Demand Dashboard's confirmed-orders / inventory views
      - the Confirmed Orders page (orders awaiting confirmation for the period)

    Independent of `period_short_ship_configs` (which drives projection
    forecasts only) and `shopify_products.allow_short_ship` (which drives
    Operations / Staging).
    """
    __tablename__ = "confirmed_demand_short_ship_configs"
    id          = Column(Integer, primary_key=True, index=True)
    period_id   = Column(Integer, ForeignKey("projection_periods.id"), nullable=False, index=True)
    shopify_sku = Column(String, nullable=False)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint('period_id', 'shopify_sku', name='uq_cd_short_ship'),
    )


class ConfirmedDemandInventoryHoldConfig(Base):
    """Inventory-hold counterpart to ConfirmedDemandShortShipConfig."""
    __tablename__ = "confirmed_demand_inventory_hold_configs"
    id          = Column(Integer, primary_key=True, index=True)
    period_id   = Column(Integer, ForeignKey("projection_periods.id"), nullable=False, index=True)
    shopify_sku = Column(String, nullable=False)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint('period_id', 'shopify_sku', name='uq_cd_inv_hold'),
    )


class PeriodProjectionOverride(Base):
    """
    Per-product-type override of projection inputs, scoped to a period.
    Either use a narrower historical window (weeks OR custom date range — mutually
    exclusive) OR skip history entirely with a manual lbs/day rate.
    """
    __tablename__ = "period_projection_overrides"
    id                         = Column(Integer, primary_key=True, index=True)
    period_id                  = Column(Integer, ForeignKey("projection_periods.id"), nullable=False, index=True)
    product_type               = Column(String, nullable=False)
    # Range control — either_or: historical_weeks XOR (custom_range_start + custom_range_end)
    historical_weeks           = Column(Integer, nullable=True)
    custom_range_start         = Column(DateTime(timezone=True), nullable=True)
    custom_range_end           = Column(DateTime(timezone=True), nullable=True)
    # Manual rate — when set, replaces historical calc. Range fields are ignored.
    manual_daily_lbs           = Column(Float, nullable=True)
    apply_demand_multiplier    = Column(Boolean, nullable=False, default=False)
    apply_promotion_multiplier = Column(Boolean, nullable=False, default=True)
    apply_padding              = Column(Boolean, nullable=False, default=True)
    # Per-period padding override. When set, replaces the global ProjectionPaddingConfig
    # for this product type. Independent of the demand-mode radios above.
    padding_pct_override       = Column(Float, nullable=True)
    # Inventory haircut to model expiration / shrink before fulfillment.
    # Range: -100 (zero out) to 0 (no adjustment). Applied to on_hand + expected_on_hand.
    inventory_adjustment_pct   = Column(Float, nullable=True)
    notes                      = Column(Text, nullable=True)
    created_at                 = Column(DateTime(timezone=True), server_default=func.now())
    updated_at                 = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint('period_id', 'product_type', name='uq_period_projection_override'),
    )


class HistoricalSales(Base):
    """
    Hourly-bucketed historical sales data aggregated from Shopify orders.
    Used by the projection engine for demand forecasting.
    """
    __tablename__ = "historical_sales"
    id            = Column(Integer, primary_key=True, index=True)
    hour_bucket   = Column(DateTime(timezone=True), nullable=False, index=True)
    shopify_sku   = Column(String, nullable=False, index=True)
    order_count   = Column(Integer, nullable=False, default=0)
    quantity_sold = Column(Integer, nullable=False, default=0)
    revenue       = Column(Float, nullable=False, default=0.0)

    __table_args__ = (
        UniqueConstraint('hour_bucket', 'shopify_sku', name='uq_historical_hour_sku'),
    )


class HistoricalOrderLineItem(Base):
    """
    Flat per-line-item snapshot of historical Shopify orders used for CSV
    export and ad-hoc comparison with Shopify reports. Denormalizes order-level
    fields (order number, tags, created_at) onto each line item for simple
    spreadsheet workflows.
    """
    __tablename__ = "historical_order_line_items"
    id                   = Column(Integer, primary_key=True, index=True)
    shopify_order_id     = Column(String, nullable=False, index=True)
    shopify_order_number = Column(String, nullable=True)
    created_at_shopify   = Column(DateTime(timezone=True), nullable=False, index=True)
    tags                 = Column(Text, nullable=True)
    financial_status     = Column(String, nullable=True)
    fulfillment_status   = Column(String, nullable=True)
    shopify_sku          = Column(String, nullable=True, index=True)
    product_title        = Column(String, nullable=True)
    variant_title        = Column(String, nullable=True)
    quantity             = Column(Integer, nullable=False, default=0)
    price                = Column(Float, nullable=False, default=0.0)
    discount             = Column(Float, nullable=False, default=0.0)


class HistoricalDailyOrders(Base):
    """
    Per-day distinct order count for historical demand analysis.
    Populated by the same Shopify ingestion job that builds historical_sales,
    but tracks order-level counts (not SKU-level) so orders/day is accurate
    regardless of how many SKUs an order contains.
    """
    __tablename__ = "historical_daily_orders"
    id           = Column(Integer, primary_key=True, index=True)
    day          = Column(Date, nullable=False, unique=True, index=True)
    order_count  = Column(Integer, nullable=False, default=0)
    created_at   = Column(DateTime(timezone=True), server_default=func.now())
    updated_at   = Column(DateTime(timezone=True), onupdate=func.now())


class HistoricalPromotion(Base):
    """
    Tags a historical time period as having a promotion active.
    Used to exclude or re-weight promotional periods in demand forecasting.
    """
    __tablename__ = "historical_promotions"
    id             = Column(Integer, primary_key=True, index=True)
    name           = Column(String, nullable=False)
    start_datetime = Column(DateTime(timezone=True), nullable=False)
    end_datetime   = Column(DateTime(timezone=True), nullable=False)
    scope          = Column(String, nullable=False, default="store_wide")  # store_wide | sku_specific
    affected_skus  = Column(JSON, nullable=True)    # list of SKUs if sku_specific
    discount_type  = Column(String, nullable=True)   # percentage | fixed | bogo | etc.
    discount_value = Column(Float, nullable=True)
    notes          = Column(Text, nullable=True)
    source         = Column(String, nullable=False, default="manual")  # manual | klaviyo
    created_at     = Column(DateTime(timezone=True), server_default=func.now())
    updated_at     = Column(DateTime(timezone=True), onupdate=func.now())


# ── Projections ──────────────────────────────────────────────────────────────

class Projection(Base):
    """
    A point-in-time demand forecast for a specific projection period.
    Generated on demand; previous projections for the same period are marked 'superseded'.
    """
    __tablename__ = "projections"
    id                        = Column(Integer, primary_key=True, index=True)
    period_id                 = Column(Integer, ForeignKey("projection_periods.id"), nullable=False, index=True)
    generated_at              = Column(DateTime(timezone=True), server_default=func.now())
    shopify_data_as_of        = Column(DateTime(timezone=True), nullable=True)
    historical_range_start    = Column(DateTime(timezone=True), nullable=True)
    historical_range_end      = Column(DateTime(timezone=True), nullable=True)
    parameters                = Column(JSON, nullable=True)       # frozen snapshot of generation inputs
    methodology_report        = Column(Text, nullable=True)       # auto-generated transparency text
    status                    = Column(String, nullable=False, default="current")  # current | superseded
    total_confirmed_demand_lbs = Column(Float, nullable=False, default=0.0)
    total_projected_demand_lbs = Column(Float, nullable=False, default=0.0)
    total_demand_lbs          = Column(Float, nullable=False, default=0.0)
    created_at                = Column(DateTime(timezone=True), server_default=func.now())
    updated_at                = Column(DateTime(timezone=True), onupdate=func.now())


class ProjectionLine(Base):
    """Per-product-type row within a projection."""
    __tablename__ = "projection_lines"
    id                    = Column(Integer, primary_key=True, index=True)
    projection_id         = Column(Integer, ForeignKey("projections.id"), nullable=False, index=True)
    product_type          = Column(String, nullable=False, index=True)
    confirmed_order_count = Column(Integer, nullable=False, default=0)
    confirmed_demand_lbs  = Column(Float, nullable=False, default=0.0)
    projected_order_count = Column(Float, nullable=False, default=0.0)  # fractional (forecast)
    projected_demand_lbs  = Column(Float, nullable=False, default=0.0)
    total_demand_lbs      = Column(Float, nullable=False, default=0.0)
    padding_pct           = Column(Float, nullable=False, default=0.0)
    padded_demand_lbs     = Column(Float, nullable=False, default=0.0)
    on_hand_lbs           = Column(Float, nullable=False, default=0.0)
    expected_on_hand_lbs  = Column(Float, nullable=False, default=0.0)
    on_order_lbs          = Column(Float, nullable=False, default=0.0)   # 0 until PO system (Phase 4)
    gap_lbs               = Column(Float, nullable=False, default=0.0)
    gap_cases             = Column(Float, nullable=True)
    case_weight_lbs       = Column(Float, nullable=True)
    gap_status            = Column(String, nullable=False, default="ok")  # short | long | ok
    detail                = Column(JSON, nullable=True)   # per-SKU breakdown for drill-down
    created_at            = Column(DateTime(timezone=True), server_default=func.now())


class ProjectionPaddingConfig(Base):
    """Per-product-type padding percentage applied on top of projected demand."""
    __tablename__ = "projection_padding_configs"
    id           = Column(Integer, primary_key=True, index=True)
    product_type = Column(String, nullable=False, unique=True, index=True)
    padding_pct  = Column(Float, nullable=False, default=0.0)  # e.g., 10.0 means 10%
    notes        = Column(Text, nullable=True)
    created_at   = Column(DateTime(timezone=True), server_default=func.now())
    updated_at   = Column(DateTime(timezone=True), onupdate=func.now())


# ── Vendor Management & Purchase Orders (Phase 4) ───────────────────────────

class Vendor(Base):
    """Vendor registry with contact info and communication preferences."""
    __tablename__ = "vendors"
    id                       = Column(Integer, primary_key=True, index=True)
    name                     = Column(String, nullable=False)
    contact_name             = Column(String, nullable=True)
    contact_email            = Column(String, nullable=True)
    contact_phone            = Column(String, nullable=True)
    contact_whatsapp         = Column(String, nullable=True)
    preferred_communication  = Column(String, nullable=True)  # whatsapp | email | phone
    url                      = Column(String, nullable=True)
    pickup_address           = Column(Text, nullable=True)
    agg_location             = Column(String, nullable=True)
    # JSON-encoded list of product type tags (multi-select). Used for the
    # "suggested vendor" feature on Purchase Planning and as a quick filter on
    # the Vendors page. Detailed pricing/case info per product still lives on
    # vendor_products.
    product_catalog          = Column(Text, nullable=True)
    notes                    = Column(Text, nullable=True)
    is_active                = Column(Boolean, nullable=False, default=True)
    created_at               = Column(DateTime(timezone=True), server_default=func.now())
    updated_at               = Column(DateTime(timezone=True), onupdate=func.now())


class VendorProduct(Base):
    """Default product types, case sizes, pricing, and lead times per vendor."""
    __tablename__ = "vendor_products"
    id                      = Column(Integer, primary_key=True, index=True)
    vendor_id               = Column(Integer, ForeignKey("vendors.id"), nullable=False, index=True)
    product_type            = Column(String, nullable=False, index=True)
    default_case_weight_lbs = Column(Float, nullable=True)
    default_case_count      = Column(Integer, nullable=True)   # pieces per case
    default_price_per_case  = Column(Float, nullable=True)
    default_price_per_lb    = Column(Float, nullable=True)
    lead_time_days          = Column(Integer, nullable=True)
    order_unit              = Column(String, nullable=True, default="case")  # case | lb | piece
    is_preferred            = Column(Boolean, nullable=False, default=False)
    notes                   = Column(Text, nullable=True)
    created_at              = Column(DateTime(timezone=True), server_default=func.now())
    updated_at              = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint('vendor_id', 'product_type', name='uq_vendor_product_type'),
    )


class PurchaseOrder(Base):
    """
    A vendor order with lifecycle tracking.
    Status: draft → placed → in_transit → partially_received → delivered → imported → reconciled
    """
    __tablename__ = "purchase_orders"
    id                      = Column(Integer, primary_key=True, index=True)
    po_number               = Column(String, nullable=False, unique=True, index=True)
    vendor_id               = Column(Integer, ForeignKey("vendors.id"), nullable=False, index=True)
    status                  = Column(String, nullable=False, default="draft")
    order_date              = Column(Date, nullable=True)
    expected_delivery_date  = Column(Date, nullable=True)
    actual_delivery_date    = Column(Date, nullable=True)
    delivery_notes          = Column(Text, nullable=True)
    communication_method    = Column(String, nullable=True)   # how order was placed
    subtotal                = Column(Float, nullable=True)     # calculated from line items
    notes                   = Column(Text, nullable=True)
    created_at              = Column(DateTime(timezone=True), server_default=func.now())
    updated_at              = Column(DateTime(timezone=True), onupdate=func.now())


class PurchaseOrderLine(Base):
    """A line item on a purchase order — one product type per line."""
    __tablename__ = "purchase_order_lines"
    id                = Column(Integer, primary_key=True, index=True)
    purchase_order_id = Column(Integer, ForeignKey("purchase_orders.id"), nullable=False, index=True)
    product_type      = Column(String, nullable=False)
    quantity_cases    = Column(Float, nullable=False, default=0.0)
    case_weight_lbs   = Column(Float, nullable=True)
    total_weight_lbs  = Column(Float, nullable=True)   # quantity_cases × case_weight_lbs
    unit_price        = Column(Float, nullable=True)
    price_unit        = Column(String, nullable=True, default="case")  # case | lb
    total_price       = Column(Float, nullable=True)
    notes             = Column(Text, nullable=True)
    created_at        = Column(DateTime(timezone=True), server_default=func.now())
    updated_at        = Column(DateTime(timezone=True), onupdate=func.now())


class PurchaseOrderPeriodAllocation(Base):
    """Allocates portions of a PO line to specific projection periods with spoilage adjustments."""
    __tablename__ = "purchase_order_period_allocations"
    id             = Column(Integer, primary_key=True, index=True)
    po_line_id     = Column(Integer, ForeignKey("purchase_order_lines.id"), nullable=False, index=True)
    period_id      = Column(Integer, ForeignKey("projection_periods.id"), nullable=False, index=True)
    allocated_lbs  = Column(Float, nullable=False, default=0.0)
    spoilage_pct   = Column(Float, nullable=False, default=0.0)
    effective_lbs  = Column(Float, nullable=False, default=0.0)  # allocated_lbs × (1 - spoilage_pct)
    created_at     = Column(DateTime(timezone=True), server_default=func.now())
    updated_at     = Column(DateTime(timezone=True), onupdate=func.now())


# ── Purchase Planning (gap-driven, per projection period) ────────────────────

class PurchasePlanLine(Base):
    """
    A single planned-purchase row for a projection period. Lighter-weight than
    PurchaseOrder/PurchaseOrderLine — used as a working surface where the user
    sees gaps from the projection and decides how much to buy from each vendor
    for each product type. Multiple rows per (period, product_type) are allowed
    so a single product type's gap can be split across vendors.
    """
    __tablename__ = "purchase_plan_lines"
    id                    = Column(Integer, primary_key=True, index=True)
    projection_period_id  = Column(Integer, ForeignKey("projection_periods.id"), nullable=False, index=True)
    vendor_id             = Column(Integer, ForeignKey("vendors.id"), nullable=True, index=True)
    product_type          = Column(String, nullable=False, index=True)
    sub_product_type      = Column(String, nullable=True, index=True)  # substitute product type whose on-hand can fill base's gap
    purchase_weight_lbs   = Column(Float, nullable=True)   # user input — target buy in lbs
    case_weight_lbs       = Column(Float, nullable=True)   # user input — 1 means no case (per piece/lb)
    quantity              = Column(Float, nullable=True)   # user input — # of cases or lbs or pieces
    # Shipping/order status from the user's perspective. Free-form text so the
    # set can be expanded without a migration; UI restricts it to a known list.
    shipping_status       = Column(String, nullable=True)
    notes                 = Column(Text, nullable=True)
    # When set, this plan row is the source of truth for a PO line. Edits to
    # the plan row mirror to that line; vendor change clears the link and the
    # old PO line is deleted (caller is expected to re-link to a new PO).
    purchase_order_line_id = Column(Integer, ForeignKey("purchase_order_lines.id"), nullable=True, unique=True, index=True)
    created_at            = Column(DateTime(timezone=True), server_default=func.now())
    updated_at            = Column(DateTime(timezone=True), onupdate=func.now())


# ── Receiving (Phase 5) ──────────────────────────────────────────────────────

class ReceivingRecord(Base):
    """Records actual goods received against a PO line item."""
    __tablename__ = "receiving_records"
    id                  = Column(Integer, primary_key=True, index=True)
    po_line_id          = Column(Integer, ForeignKey("purchase_order_lines.id"), nullable=False, index=True)
    received_date       = Column(Date, nullable=False)
    received_cases      = Column(Float, nullable=False)
    received_weight_lbs = Column(Float, nullable=False)
    confirmed_pick_sku  = Column(String, nullable=True)
    confirmed_pieces    = Column(Float, nullable=True)
    harvest_date        = Column(Date, nullable=True)
    quality_rating      = Column(String, nullable=True)   # good | acceptable | poor
    quality_notes       = Column(Text, nullable=True)
    pushed_to_inventory = Column(Boolean, nullable=False, default=False)
    inventory_batch_id  = Column(Integer, ForeignKey("inventory_batches.id"), nullable=True)
    created_at          = Column(DateTime(timezone=True), server_default=func.now())


class AppConfig(Base):
    """Key/value store for runtime secrets and config that must survive restarts
    (e.g. Shopify OAuth access token). Used instead of on-disk JSON because
    Railway filesystems are ephemeral."""
    __tablename__ = "app_config"
    key        = Column(String, primary_key=True)
    value      = Column(Text, nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
