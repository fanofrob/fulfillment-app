from pydantic import BaseModel
from typing import Optional, List, Any
from datetime import date, datetime


# ---------------------------------------------------------------------------
# SkuMapping
# ---------------------------------------------------------------------------

class SkuMappingBase(BaseModel):
    warehouse: str
    shopify_sku: str
    pick_sku: Optional[str] = None
    mix_quantity: Optional[float] = 1.0
    product_type: Optional[str] = None
    pick_type: Optional[str] = None
    pick_weight_lb: Optional[float] = None
    lineitem_weight: Optional[float] = None
    shop_status: Optional[str] = None
    is_active: Optional[bool] = True
    notes: Optional[str] = None

class SkuMappingCreate(SkuMappingBase):
    pass

class SkuMappingUpdate(BaseModel):
    warehouse: Optional[str] = None
    shopify_sku: Optional[str] = None
    pick_sku: Optional[str] = None
    mix_quantity: Optional[float] = None
    product_type: Optional[str] = None
    pick_type: Optional[str] = None
    pick_weight_lb: Optional[float] = None
    lineitem_weight: Optional[float] = None
    shop_status: Optional[str] = None
    is_active: Optional[bool] = None
    notes: Optional[str] = None

class SkuMappingResponse(SkuMappingBase):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# CogsCost
# ---------------------------------------------------------------------------

class CogsCostBase(BaseModel):
    product_type: str
    price_per_lb: float
    effective_date: date
    vendor: Optional[str] = None
    invoice_number: Optional[str] = None
    notes: Optional[str] = None

class CogsCostCreate(CogsCostBase):
    pass

class CogsCostUpdate(BaseModel):
    product_type: Optional[str] = None
    price_per_lb: Optional[float] = None
    effective_date: Optional[date] = None
    vendor: Optional[str] = None
    invoice_number: Optional[str] = None
    notes: Optional[str] = None

class CogsCostResponse(CogsCostBase):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# RateCard
# ---------------------------------------------------------------------------

class RateCardBase(BaseModel):
    carrier: str
    service_name: str
    weight_lb: Optional[float] = None
    zone: Optional[int] = None
    rate: float
    is_flat_rate: Optional[bool] = False
    effective_date: date
    notes: Optional[str] = None

class RateCardCreate(RateCardBase):
    pass

class RateCardUpdate(BaseModel):
    carrier: Optional[str] = None
    service_name: Optional[str] = None
    weight_lb: Optional[float] = None
    zone: Optional[int] = None
    rate: Optional[float] = None
    is_flat_rate: Optional[bool] = None
    effective_date: Optional[date] = None
    notes: Optional[str] = None

class RateCardResponse(RateCardBase):
    id: int
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# BoxType
# ---------------------------------------------------------------------------

class BoxTypeBase(BaseModel):
    name: str
    pick_sku: Optional[str] = None
    carrier: Optional[str] = None
    package_code: Optional[str] = None
    length_in: Optional[float] = None
    width_in: Optional[float] = None
    height_in: Optional[float] = None
    weight_oz: Optional[float] = None
    description: Optional[str] = None
    is_active: Optional[bool] = True

class BoxTypeCreate(BoxTypeBase):
    pass

class BoxTypeUpdate(BaseModel):
    name: Optional[str] = None
    pick_sku: Optional[str] = None
    carrier: Optional[str] = None
    package_code: Optional[str] = None
    length_in: Optional[float] = None
    width_in: Optional[float] = None
    height_in: Optional[float] = None
    weight_oz: Optional[float] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None

class BoxTypeResponse(BoxTypeBase):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# PackageRule
# ---------------------------------------------------------------------------

class PackageCondition(BaseModel):
    field: str       # 'pactor' | 'zone' | 'tags'
    operator: str    # 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq' |
                     # 'between' | 'contains' | 'not_contains' |
                     # 'is_exactly' | 'is_empty' | 'not_empty'
    value: Optional[Any] = None
    value2: Optional[Any] = None  # only used for 'between'

class PackageRuleBase(BaseModel):
    name: str
    package_type: str
    priority: Optional[int] = 0
    is_active: Optional[bool] = True
    conditions: Optional[List[PackageCondition]] = []
    notes: Optional[str] = None

class PackageRuleCreate(PackageRuleBase):
    pass

class PackageRuleUpdate(BaseModel):
    name: Optional[str] = None
    package_type: Optional[str] = None
    priority: Optional[int] = None
    is_active: Optional[bool] = None
    conditions: Optional[List[PackageCondition]] = None
    notes: Optional[str] = None

class PackageRuleResponse(PackageRuleBase):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# CarrierServiceRule
# ---------------------------------------------------------------------------

class CarrierServiceCondition(BaseModel):
    field: str       # 'pactor' | 'zone' | 'tags'
    operator: str    # 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq' |
                     # 'between' | 'contains' | 'not_contains' |
                     # 'is_exactly' | 'is_empty' | 'not_empty'
    value: Optional[Any] = None
    value2: Optional[Any] = None  # only used for 'between'

class CarrierServiceRuleBase(BaseModel):
    name: str
    carrier_code: str
    service_code: str
    priority: Optional[int] = 0
    is_active: Optional[bool] = True
    conditions: Optional[List[CarrierServiceCondition]] = []
    notes: Optional[str] = None

class CarrierServiceRuleCreate(CarrierServiceRuleBase):
    pass

class CarrierServiceRuleUpdate(BaseModel):
    name: Optional[str] = None
    carrier_code: Optional[str] = None
    service_code: Optional[str] = None
    priority: Optional[int] = None
    is_active: Optional[bool] = None
    conditions: Optional[List[CarrierServiceCondition]] = None
    notes: Optional[str] = None

class CarrierServiceRuleResponse(CarrierServiceRuleBase):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# OrderRule
# ---------------------------------------------------------------------------

class OrderRuleBase(BaseModel):
    tag: str
    action: str
    min_margin_pct_override: Optional[float] = None
    description: Optional[str] = None
    priority: Optional[int] = 0
    is_active: Optional[bool] = True

class OrderRuleCreate(OrderRuleBase):
    pass

class OrderRuleUpdate(BaseModel):
    tag: Optional[str] = None
    action: Optional[str] = None
    min_margin_pct_override: Optional[float] = None
    description: Optional[str] = None
    priority: Optional[int] = None
    is_active: Optional[bool] = None

class OrderRuleResponse(OrderRuleBase):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Inventory (persistent, sessionless)
# ---------------------------------------------------------------------------

class InventoryItemOut(BaseModel):
    id: int
    pick_sku: str
    warehouse: str
    name: Optional[str] = None
    on_hand_qty: float
    committed_qty: float
    available_qty: float
    shipped_qty: float
    days_on_hand: Optional[float] = None
    batch_code: Optional[str] = None
    updated_at: Optional[datetime] = None
    category: Optional[str] = None  # from picklist_skus join

    model_config = {"from_attributes": True}

class InventoryItemCreate(BaseModel):
    pick_sku: str
    warehouse: str
    name: Optional[str] = None
    on_hand_qty: float = 0.0
    days_on_hand: Optional[float] = None
    batch_code: Optional[str] = None

class InventoryItemUpdate(BaseModel):
    on_hand_qty: Optional[float] = None
    name: Optional[str] = None
    days_on_hand: Optional[float] = None
    batch_code: Optional[str] = None
    note: Optional[str] = None  # required when changing on_hand_qty


# ---------------------------------------------------------------------------
# InventoryBatch
# ---------------------------------------------------------------------------

class InventoryBatchCreate(BaseModel):
    batch_code: str
    quantity_received: float
    received_date: date
    expiration_date: Optional[date] = None
    notes: Optional[str] = None

class InventoryBatchUpdate(BaseModel):
    quantity_remaining: float
    notes: Optional[str] = None

class InventoryBatchOut(BaseModel):
    id: int
    pick_sku: str
    warehouse: str
    batch_code: str
    quantity_received: float
    quantity_remaining: float
    received_date: date
    expiration_date: Optional[date] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# InventoryAdjustment
# ---------------------------------------------------------------------------

class AdjustmentOut(BaseModel):
    id: int
    pick_sku: str
    warehouse: str
    delta: float
    adjustment_type: str
    note: Optional[str] = None
    shopify_order_id: Optional[str] = None
    batch_id: Optional[int] = None
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# ShopifyLineItem
# ---------------------------------------------------------------------------

class LineItemOut(BaseModel):
    id: int
    line_item_id: str
    shopify_sku: Optional[str] = None
    pick_sku: Optional[str] = None
    product_title: Optional[str] = None
    variant_title: Optional[str] = None
    product_type: Optional[str] = None   # joined from shopify_products
    quantity: int
    fulfillable_quantity: Optional[int] = None
    price: Optional[float] = None
    total_discount: Optional[float] = None
    grams: Optional[int] = None
    requires_shipping: Optional[bool] = None
    sku_mapped: bool
    mix_quantity: Optional[float] = None
    fulfillment_status: Optional[str] = None
    app_line_status: Optional[str] = None
    shipstation_line_item_id: Optional[str] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# ShopifyOrder
# ---------------------------------------------------------------------------

class ShopifyOrderOut(BaseModel):
    id: int
    shopify_order_id: str
    shopify_order_number: Optional[str] = None
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    shipping_name: Optional[str] = None
    shipping_address1: Optional[str] = None
    shipping_address2: Optional[str] = None
    shipping_city: Optional[str] = None
    shipping_province: Optional[str] = None
    shipping_zip: Optional[str] = None
    shipping_country: Optional[str] = None
    tags: Optional[str] = None
    financial_status: Optional[str] = None
    fulfillment_status: Optional[str] = None
    total_price: Optional[float] = None
    subtotal_price: Optional[float] = None
    total_discounts: Optional[float] = None
    total_shipping_price: Optional[float] = None
    note: Optional[str] = None
    created_at_shopify: Optional[datetime] = None
    pulled_at: Optional[datetime] = None
    last_synced_at: Optional[datetime] = None
    app_status: str
    assigned_warehouse: str
    shipstation_order_id: Optional[str] = None
    shipstation_order_key: Optional[str] = None
    tracking_number: Optional[str] = None
    estimated_delivery_date: Optional[datetime] = None
    line_items: Optional[List[LineItemOut]] = None
    zone: Optional[int] = None
    shopify_hold: bool = False  # True if Shopify has placed a native fulfillment hold (fraud, manual)
    has_plan: bool = False
    plan_box_unmatched: bool = False  # plan exists but no box type was resolved by package rules
    has_plan_mismatch: bool = False  # plan exists but box quantities don't match order (under or over)
    ss_duplicate: bool = False  # order exists unshipped in ShipStation (pre-app duplicate risk)

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Orders: pull + status update
# ---------------------------------------------------------------------------

class PullOrdersRequest(BaseModel):
    warehouse: str = "walnut"

class OrderStatusUpdate(BaseModel):
    app_status: str
    # Valid values: not_processed | in_shipstation_not_shipped |
    #               in_shipstation_shipped | fulfilled | partially_fulfilled


# ---------------------------------------------------------------------------
# Demand analysis
# ---------------------------------------------------------------------------

class ShopifySkuBreakdown(BaseModel):
    shopify_sku: str
    product_title: Optional[str] = None
    mix_quantity: float
    units_demanded: float

class DemandAnalysisItem(BaseModel):
    pick_sku: str
    name: Optional[str] = None
    available_qty: float
    on_hand_qty: float
    committed_qty: float
    total_demand: float
    shortfall: float
    affected_order_count: int
    shopify_sku_breakdown: List[ShopifySkuBreakdown] = []


# ---------------------------------------------------------------------------
# ShipStation
# ---------------------------------------------------------------------------

class ShipStationStatusOut(BaseModel):
    configured: bool
    message: str

class ShipStationSyncResult(BaseModel):
    synced: int
    shipped: int
    errors: List[str]

class ShipStationPushBatchRequest(BaseModel):
    order_ids: List[str]

class StageBatchRequest(BaseModel):
    order_ids: List[str]


# ---------------------------------------------------------------------------
# Archived Orders
# ---------------------------------------------------------------------------

class ArchivedOrderOut(BaseModel):
    id: int
    shopify_order_id: str
    shopify_order_number: Optional[str] = None
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    tags: Optional[str] = None
    total_price: Optional[float] = None
    line_items_summary: Optional[str] = None
    shopify_archived: bool
    archived_at: Optional[datetime] = None

    model_config = {"from_attributes": True}
