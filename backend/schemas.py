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
    field: str       # 'pactor' | 'zone' | 'weight' | 'tags'
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
    shipping_provider_id: Optional[int] = None  # disambiguates multiple accounts sharing the same carrierCode
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
    shipping_provider_id: Optional[int] = None
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
    healed: Optional[int] = 0

class ShipStationPushBatchRequest(BaseModel):
    order_ids: List[str]

class StageBatchRequest(BaseModel):
    order_ids: List[str]

class BulkCancelSSBoxesRequest(BaseModel):
    order_ids: List[str]

class RecomputeOrdersRequest(BaseModel):
    """Optional list of order IDs to scope recompute. Empty/None = all open orders."""
    order_ids: Optional[List[str]] = None
    auto_replan: bool = True


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


# ---------------------------------------------------------------------------
# Projection Periods
# ---------------------------------------------------------------------------

class ProjectionPeriodBase(BaseModel):
    name: str
    start_datetime: datetime
    end_datetime: datetime
    fulfillment_start: Optional[datetime] = None
    fulfillment_end: Optional[datetime] = None
    status: Optional[str] = "draft"
    sku_mapping_sheet_tab: Optional[str] = None
    previous_period_id: Optional[int] = None
    spoilage_adjustments: Optional[dict] = None
    notes: Optional[str] = None

class ProjectionPeriodCreate(ProjectionPeriodBase):
    pass

class ProjectionPeriodUpdate(BaseModel):
    name: Optional[str] = None
    start_datetime: Optional[datetime] = None
    end_datetime: Optional[datetime] = None
    fulfillment_start: Optional[datetime] = None
    fulfillment_end: Optional[datetime] = None
    status: Optional[str] = None
    sku_mapping_sheet_tab: Optional[str] = None
    previous_period_id: Optional[int] = None
    spoilage_adjustments: Optional[dict] = None
    notes: Optional[str] = None

class ProjectionPeriodResponse(ProjectionPeriodBase):
    id: int
    confirmed_demand_auto_lbs: Optional[dict] = None
    confirmed_demand_manual_lbs: Optional[dict] = None
    has_manual_confirmed_demand: bool = False
    confirmed_demand_saved_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Projection Period Confirmed Orders (review/override layer)
# ---------------------------------------------------------------------------

class BoxSnapshotItem(BaseModel):
    pick_sku: str
    quantity: float
    weight_lb: Optional[float] = None
    product_type: Optional[str] = None

class ConfirmOrdersRequest(BaseModel):
    order_ids: List[str]
    mapping_tab: str

class UnconfirmOrdersRequest(BaseModel):
    order_ids: List[str]

class ProjectionPeriodConfirmedOrderResponse(BaseModel):
    id: int
    period_id: int
    shopify_order_id: str
    boxes_snapshot: List[BoxSnapshotItem]
    mapping_used: str
    confirmed_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class ConfirmOrdersResult(BaseModel):
    confirmed: int
    skipped: int
    results: List[dict]

class SaveConfirmedDemandResponse(BaseModel):
    period_id: int
    confirmed_demand_manual_lbs: dict
    has_manual_confirmed_demand: bool
    confirmed_demand_saved_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Period Short Ship / Inventory Hold Configs
# ---------------------------------------------------------------------------

class PeriodConfigItem(BaseModel):
    shopify_sku: str

class PeriodShortShipResponse(BaseModel):
    id: int
    period_id: int
    shopify_sku: str
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class PeriodInventoryHoldResponse(BaseModel):
    id: int
    period_id: int
    shopify_sku: str
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class CopyConfigsRequest(BaseModel):
    source_period_id: int

class ConfigDiffResponse(BaseModel):
    only_in_source: List[str]
    only_in_target: List[str]
    in_both: List[str]

# ---------------------------------------------------------------------------
# Confirmed Demand short-ship / inventory-hold configs (independent layer)
# ---------------------------------------------------------------------------

class ConfirmedDemandShortShipResponse(BaseModel):
    id: int
    period_id: int
    shopify_sku: str
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class ConfirmedDemandInventoryHoldResponse(BaseModel):
    id: int
    period_id: int
    shopify_sku: str
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# Per-product-type projection overrides
class PeriodProjectionOverrideBase(BaseModel):
    product_type: str
    historical_weeks: Optional[int] = None
    custom_range_start: Optional[datetime] = None
    custom_range_end: Optional[datetime] = None
    manual_daily_lbs: Optional[float] = None
    apply_demand_multiplier: bool = False
    apply_promotion_multiplier: bool = True
    apply_padding: bool = True
    notes: Optional[str] = None


class PeriodProjectionOverrideCreate(PeriodProjectionOverrideBase):
    pass


class PeriodProjectionOverrideResponse(PeriodProjectionOverrideBase):
    id: int
    period_id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Historical Sales
# ---------------------------------------------------------------------------

class HistoricalSalesResponse(BaseModel):
    id: int
    hour_bucket: datetime
    shopify_sku: str
    order_count: int
    quantity_sold: int
    revenue: float

    model_config = {"from_attributes": True}

class HistoricalSalesIngestionResult(BaseModel):
    total_orders_processed: int
    total_sales_rows_upserted: int
    date_range_start: Optional[datetime] = None
    date_range_end: Optional[datetime] = None
    errors: List[str] = []


# ---------------------------------------------------------------------------
# Historical Promotions
# ---------------------------------------------------------------------------

class HistoricalPromotionBase(BaseModel):
    name: str
    start_datetime: datetime
    end_datetime: datetime
    scope: Optional[str] = "store_wide"
    affected_skus: Optional[List[str]] = None
    discount_type: Optional[str] = None
    discount_value: Optional[float] = None
    notes: Optional[str] = None
    source: Optional[str] = "manual"

class HistoricalPromotionCreate(HistoricalPromotionBase):
    pass

class HistoricalPromotionUpdate(BaseModel):
    name: Optional[str] = None
    start_datetime: Optional[datetime] = None
    end_datetime: Optional[datetime] = None
    scope: Optional[str] = None
    affected_skus: Optional[List[str]] = None
    discount_type: Optional[str] = None
    discount_value: Optional[float] = None
    notes: Optional[str] = None
    source: Optional[str] = None

class HistoricalPromotionResponse(HistoricalPromotionBase):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Projection Padding Configs
# ---------------------------------------------------------------------------

class PaddingConfigBase(BaseModel):
    product_type: str
    padding_pct: float = 0.0
    notes: Optional[str] = None

class PaddingConfigCreate(PaddingConfigBase):
    pass

class PaddingConfigResponse(PaddingConfigBase):
    id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Projections
# ---------------------------------------------------------------------------

class ProjectionGenerateRequest(BaseModel):
    historical_weeks: Optional[int] = 4
    excluded_promo_ids: Optional[List[int]] = None
    promotion_multiplier: Optional[float] = None
    demand_multiplier: Optional[float] = None
    warehouse: str = "walnut"

class ProjectionLineResponse(BaseModel):
    id: int
    product_type: str
    confirmed_order_count: int = 0
    confirmed_demand_lbs: float = 0.0
    projected_order_count: float = 0.0
    projected_demand_lbs: float = 0.0
    total_demand_lbs: float = 0.0
    padding_pct: float = 0.0
    padded_demand_lbs: float = 0.0
    on_hand_lbs: float = 0.0
    expected_on_hand_lbs: float = 0.0
    on_order_lbs: float = 0.0
    gap_lbs: float = 0.0
    gap_cases: Optional[float] = None
    case_weight_lbs: Optional[float] = None
    gap_status: str = "ok"
    detail: Optional[Any] = None

    model_config = {"from_attributes": True}

# Shop-wide projected orders per hour (one curve, summed across PTs)
class ShopHourlyBucketResponse(BaseModel):
    hour: datetime
    projected_orders: float = 0.0

class ShopHourlyBreakdownResponse(BaseModel):
    projection_id: int
    period_name: str
    hours: List[ShopHourlyBucketResponse] = []


# Per-PT daily historical lbs, grouped by week — informs manual_daily_lbs overrides
class PtDailyHistoryDay(BaseModel):
    date: str
    dow: int  # 0=Mon … 6=Sun
    lbs: float = 0.0

class PtDailyHistoryWeek(BaseModel):
    week_number: int
    week_start: datetime
    week_end: datetime
    days: List[PtDailyHistoryDay] = []
    total_lbs: float = 0.0
    avg_lbs_per_day: float = 0.0

class PtDailyHistoryDowAverage(BaseModel):
    dow: int
    avg_lbs: float = 0.0
    sample_count: int = 0

class PtDailyHistoryResponse(BaseModel):
    product_type: str
    projection_id: int
    historical_range_start: Optional[datetime] = None
    historical_range_end: Optional[datetime] = None
    weeks: List[PtDailyHistoryWeek] = []
    dow_averages: List[PtDailyHistoryDowAverage] = []
    overall_avg_lbs_per_day: float = 0.0


# Historical orders/day summary (weekly breakdown) for a projection
class HistoricalWeekBucket(BaseModel):
    week_number: int
    week_start: datetime
    week_end: datetime
    days: int
    total_orders: int
    avg_orders_per_day: float

class HistoricalOrdersSummaryResponse(BaseModel):
    historical_range_start: Optional[datetime] = None
    historical_range_end: Optional[datetime] = None
    weekly_breakdown: List[HistoricalWeekBucket] = []
    overall_avg_orders_per_day: float = 0.0
    overall_total_orders: int = 0
    overall_days: int = 0

# Projection comparison (two projections side-by-side by product type)
class ComparisonLineResponse(BaseModel):
    product_type: str
    # Projection A
    a_confirmed_demand_lbs: float = 0.0
    a_projected_demand_lbs: float = 0.0
    a_total_demand_lbs: float = 0.0
    a_padded_demand_lbs: float = 0.0
    a_on_hand_lbs: float = 0.0
    a_expected_on_hand_lbs: float = 0.0
    a_gap_lbs: float = 0.0
    a_gap_cases: Optional[float] = None
    a_gap_status: str = "ok"
    # Projection B
    b_confirmed_demand_lbs: float = 0.0
    b_projected_demand_lbs: float = 0.0
    b_total_demand_lbs: float = 0.0
    b_padded_demand_lbs: float = 0.0
    b_on_hand_lbs: float = 0.0
    b_expected_on_hand_lbs: float = 0.0
    b_gap_lbs: float = 0.0
    b_gap_cases: Optional[float] = None
    b_gap_status: str = "ok"

class ProjectionComparisonResponse(BaseModel):
    projection_a: "ProjectionResponse"
    projection_b: "ProjectionResponse"
    lines: List[ComparisonLineResponse] = []


class ProjectionResponse(BaseModel):
    id: int
    period_id: int
    generated_at: Optional[datetime] = None
    shopify_data_as_of: Optional[datetime] = None
    historical_range_start: Optional[datetime] = None
    historical_range_end: Optional[datetime] = None
    methodology_report: Optional[str] = None
    status: str = "current"
    total_confirmed_demand_lbs: float = 0.0
    total_projected_demand_lbs: float = 0.0
    total_demand_lbs: float = 0.0
    parameters: Optional[Any] = None
    lines: Optional[List[ProjectionLineResponse]] = None
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Vendors (Phase 4)
# ---------------------------------------------------------------------------

class VendorProductBase(BaseModel):
    product_type: str
    default_case_weight_lbs: Optional[float] = None
    default_case_count: Optional[int] = None
    default_price_per_case: Optional[float] = None
    default_price_per_lb: Optional[float] = None
    lead_time_days: Optional[int] = None
    order_unit: Optional[str] = "case"
    is_preferred: bool = False
    notes: Optional[str] = None

class VendorProductCreate(VendorProductBase):
    pass

class VendorProductUpdate(BaseModel):
    product_type: Optional[str] = None
    default_case_weight_lbs: Optional[float] = None
    default_case_count: Optional[int] = None
    default_price_per_case: Optional[float] = None
    default_price_per_lb: Optional[float] = None
    lead_time_days: Optional[int] = None
    order_unit: Optional[str] = None
    is_preferred: Optional[bool] = None
    notes: Optional[str] = None

class VendorProductResponse(VendorProductBase):
    id: int
    vendor_id: int
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class VendorBase(BaseModel):
    name: str
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_whatsapp: Optional[str] = None
    preferred_communication: Optional[str] = None
    notes: Optional[str] = None
    is_active: bool = True

class VendorCreate(VendorBase):
    products: Optional[List[VendorProductCreate]] = None

class VendorUpdate(BaseModel):
    name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_whatsapp: Optional[str] = None
    preferred_communication: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None

class VendorResponse(VendorBase):
    id: int
    products: List[VendorProductResponse] = []
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Purchase Orders (Phase 4)
# ---------------------------------------------------------------------------

class POPeriodAllocationBase(BaseModel):
    period_id: int
    allocated_lbs: float = 0.0
    spoilage_pct: float = 0.0

class POPeriodAllocationCreate(POPeriodAllocationBase):
    pass

class POPeriodAllocationResponse(POPeriodAllocationBase):
    id: int
    po_line_id: int
    effective_lbs: float = 0.0
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class POLineBase(BaseModel):
    product_type: str
    quantity_cases: float = 0.0
    case_weight_lbs: Optional[float] = None
    total_weight_lbs: Optional[float] = None
    unit_price: Optional[float] = None
    price_unit: Optional[str] = "case"
    total_price: Optional[float] = None
    notes: Optional[str] = None

class POLineCreate(POLineBase):
    allocations: Optional[List[POPeriodAllocationCreate]] = None

class POLineUpdate(BaseModel):
    product_type: Optional[str] = None
    quantity_cases: Optional[float] = None
    case_weight_lbs: Optional[float] = None
    unit_price: Optional[float] = None
    price_unit: Optional[str] = None
    notes: Optional[str] = None

class POLineResponse(POLineBase):
    id: int
    purchase_order_id: int
    allocations: List[POPeriodAllocationResponse] = []
    overage_flag: bool = False  # True if rounded-up order >10% over projection gap
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class PurchaseOrderBase(BaseModel):
    vendor_id: int
    status: str = "draft"
    order_date: Optional[date] = None
    expected_delivery_date: Optional[date] = None
    actual_delivery_date: Optional[date] = None
    delivery_notes: Optional[str] = None
    communication_method: Optional[str] = None
    notes: Optional[str] = None

class PurchaseOrderCreate(PurchaseOrderBase):
    lines: List[POLineCreate] = []

class PurchaseOrderUpdate(BaseModel):
    vendor_id: Optional[int] = None
    status: Optional[str] = None
    order_date: Optional[date] = None
    expected_delivery_date: Optional[date] = None
    actual_delivery_date: Optional[date] = None
    delivery_notes: Optional[str] = None
    communication_method: Optional[str] = None
    notes: Optional[str] = None

class PurchaseOrderResponse(PurchaseOrderBase):
    id: int
    po_number: str
    subtotal: Optional[float] = None
    lines: List[POLineResponse] = []
    vendor_name: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class POFromProjectionRequest(BaseModel):
    """Create a PO pre-filled from projection gap data."""
    period_id: int
    projection_id: int
    product_types: List[str]  # which product types to create PO lines for
    vendor_id: Optional[int] = None  # if not provided, use preferred vendor


# ---------------------------------------------------------------------------
# Receiving Records (Phase 5)
# ---------------------------------------------------------------------------

class ReceivingRecordCreate(BaseModel):
    received_date: date
    received_cases: float
    received_weight_lbs: float
    confirmed_pick_sku: Optional[str] = None
    harvest_date: Optional[date] = None
    quality_rating: Optional[str] = None   # good | acceptable | poor
    quality_notes: Optional[str] = None

class ReceivingRecordUpdate(BaseModel):
    received_date: Optional[date] = None
    received_cases: Optional[float] = None
    received_weight_lbs: Optional[float] = None
    confirmed_pick_sku: Optional[str] = None
    harvest_date: Optional[date] = None
    quality_rating: Optional[str] = None
    quality_notes: Optional[str] = None

class ReceivingRecordResponse(BaseModel):
    id: int
    po_line_id: int
    received_date: date
    received_cases: float
    received_weight_lbs: float
    confirmed_pick_sku: Optional[str] = None
    confirmed_pieces: Optional[float] = None
    harvest_date: Optional[date] = None
    quality_rating: Optional[str] = None
    quality_notes: Optional[str] = None
    pushed_to_inventory: bool = False
    inventory_batch_id: Optional[int] = None
    product_type: Optional[str] = None  # from PO line for convenience
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class InventoryPushRequest(BaseModel):
    warehouse: str = "walnut"
    batch_code: Optional[str] = None

class InventoryPushResponse(BaseModel):
    receiving_record_id: int
    inventory_batch_id: int
    inventory_adjustment_id: int
    pick_sku: str
    quantity_added: float
    expiration_date: Optional[date] = None

class SkuForProductTypeResponse(BaseModel):
    pick_sku: str
    weight_lb: Optional[float] = None
    days_til_expiration: Optional[float] = None
