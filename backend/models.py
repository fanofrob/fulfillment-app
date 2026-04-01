from sqlalchemy import Column, Integer, String, Float, Boolean, Date, DateTime, Text, JSON, ForeignKey, UniqueConstraint
from sqlalchemy.sql import func
from database import Base

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
    category = Column(String, nullable=True)  # 'fruit' | 'packaging' | other
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
    carrier_code = Column(String, nullable=False)   # ShipStation carrierCode, e.g. 'stamps_com', 'fedex'
    service_code = Column(String, nullable=False)   # ShipStation serviceCode, e.g. 'usps_priority_mail'
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
