import axios from 'axios'

// Same-origin: in production the FastAPI backend serves the built frontend,
// so '/api' hits the same host. In `npm run dev`, Vite proxies '/api' to :8000
// (see vite.config.js). Override with VITE_API_BASE_URL if you ever need to
// point the frontend at a different backend.
const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

const api = axios.create({ baseURL: API_BASE })

export const skuMappingApi = {
  list: (params) => api.get('/sku-mappings/', { params }).then(r => r.data),
  listGrouped: (params) => api.get('/sku-mappings/grouped', { params }).then(r => r.data),
  stagedErrors: () => api.get('/sku-mappings/staged-errors').then(r => r.data),
  refresh: () => api.post('/sku-mappings/refresh').then(r => r.data),
  create: (data) => api.post('/sku-mappings/', data).then(r => r.data),
  update: (id, data) => api.put(`/sku-mappings/${id}`, data).then(r => r.data),
  remove: (id) => api.delete(`/sku-mappings/${id}`).then(r => r.data),
}

export const shopifySkuRulesApi = {
  list: (params) => api.get('/shopify-sku-rules/', { params }).then(r => r.data),
  lookup: (shopify_sku) => api.get('/shopify-sku-rules/lookup', { params: { shopify_sku } }).then(r => r.data),
  upsert: (shopify_sku, data) => api.put(`/shopify-sku-rules/by-shopify-sku/${encodeURIComponent(shopify_sku)}`, data).then(r => r.data),
  remove: (id) => api.delete(`/shopify-sku-rules/${id}`).then(r => r.data),
}

export const cogsApi = {
  list: (params) => api.get('/cogs/', { params }).then(r => r.data),
  create: (data) => api.post('/cogs/', data).then(r => r.data),
  refresh: () => api.post('/cogs/refresh').then(r => r.data),
}

export const rateCardApi = {
  list: (params) => api.get('/rate-cards/', { params }).then(r => r.data),
  refresh: () => api.post('/rate-cards/refresh').then(r => r.data),
  rebuildUps: () => api.post('/rate-cards/rebuild-ups', {}, { timeout: 180000 }).then(r => r.data),
}

export const rulesApi = {
  listOrders: () => api.get('/rules/orders').then(r => r.data),
  listOrderTags: () => api.get('/rules/orders/tags').then(r => r.data),
  createOrder: (data) => api.post('/rules/orders', data).then(r => r.data),
  updateOrder: (id, data) => api.put(`/rules/orders/${id}`, data).then(r => r.data),
  deleteOrder: (id) => api.delete(`/rules/orders/${id}`).then(r => r.data),
  pauseOrder: (id) => api.patch(`/rules/orders/${id}/pause`).then(r => r.data),
  unpauseOrder: (id) => api.patch(`/rules/orders/${id}/unpause`).then(r => r.data),
}

export const boxTypesApi = {
  list: (params) => api.get('/rules/box-types', { params }).then(r => r.data),
  create: (data) => api.post('/rules/box-types', data).then(r => r.data),
  update: (id, data) => api.put(`/rules/box-types/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/rules/box-types/${id}`).then(r => r.data),
}

export const packageRulesApi = {
  list: (params) => api.get('/rules/packages', { params }).then(r => r.data),
  create: (data) => api.post('/rules/packages', data).then(r => r.data),
  update: (id, data) => api.put(`/rules/packages/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/rules/packages/${id}`).then(r => r.data),
  pause: (id) => api.patch(`/rules/packages/${id}/pause`).then(r => r.data),
  unpause: (id) => api.patch(`/rules/packages/${id}/unpause`).then(r => r.data),
}

export const carrierServiceRulesApi = {
  list: (params) => api.get('/rules/carrier-services', { params }).then(r => r.data),
  create: (data) => api.post('/rules/carrier-services', data).then(r => r.data),
  update: (id, data) => api.put(`/rules/carrier-services/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/rules/carrier-services/${id}`).then(r => r.data),
  pause: (id) => api.patch(`/rules/carrier-services/${id}/pause`).then(r => r.data),
  unpause: (id) => api.patch(`/rules/carrier-services/${id}/unpause`).then(r => r.data),
}

export const statusApi = {
  get: () => api.get('/status').then(r => r.data),
  refreshAll: () => api.post('/refresh').then(r => r.data),
}

export const inventoryApi = {
  // Items CRUD
  listItems: (warehouse, params) =>
    api.get('/inventory/items', { params: { warehouse, ...params } }).then(r => r.data),
  createItem: (data) => api.post('/inventory/items', data).then(r => r.data),
  updateItem: (id, data) => api.put(`/inventory/items/${id}`, data).then(r => r.data),
  deleteItem: (id) => api.delete(`/inventory/items/${id}`).then(r => r.data),

  // Adjustment log
  getItemAdjustments: (itemId) =>
    api.get(`/inventory/items/${itemId}/adjustments`).then(r => r.data),
  listAdjustments: (warehouse, params) =>
    api.get('/inventory/adjustments', { params: { warehouse, ...params } }).then(r => r.data),

  // Batches
  getItemBatches: (itemId) =>
    api.get(`/inventory/items/${itemId}/batches`).then(r => r.data),
  receiveBatch: (itemId, data) =>
    api.post(`/inventory/items/${itemId}/batches`, data).then(r => r.data),
  updateBatch: (batchId, data) =>
    api.put(`/inventory/batches/${batchId}`, data).then(r => r.data),

  // Weekly count report (items with on_hand_qty > 0)
  weeklyReport: (warehouse) =>
    api.get('/inventory/weekly-report', { params: { warehouse } }).then(r => r.data),

  // Recompute committed from live orders
  recomputeCommitted: (warehouse) =>
    api.post('/inventory/recompute-committed', null, { params: { warehouse } }).then(r => r.data),

  // Out-of-stock demand analysis
  demandAnalysis: (warehouse, order_scope = 'staged', health_filter = 'all') =>
    api.get('/inventory/demand-analysis', { params: { warehouse, order_scope, health_filter } }).then(r => r.data),

  stagedShortages: (warehouse) =>
    api.get('/inventory/staged-shortages', { params: warehouse ? { warehouse } : {} }).then(r => r.data),

  stagedBoxesByPickSku: (pick_sku, warehouse) =>
    api.get('/inventory/staged-boxes-by-pick-sku', {
      params: warehouse ? { pick_sku, warehouse } : { pick_sku },
    }).then(r => r.data),
}

export const shopifyAuthApi = {
  status: () => api.get('/shopify/status').then(r => r.data),
  // connect is a browser redirect, not an axios call — use window.location
  connectUrl: () => `${API_BASE}/shopify/connect`,
  disconnect: () => api.delete('/shopify/disconnect').then(r => r.data),
}

export const ordersApi = {
  list: (params) => api.get('/orders/', { params }).then(r => r.data),
  pull: (data) => api.post('/orders/pull', data).then(r => r.data),
  get: (id, params) => api.get(`/orders/${id}`, { params }).then(r => r.data),
  updateStatus: (id, data) => api.put(`/orders/${id}/status`, data).then(r => r.data),
  stage: (id) => api.post(`/orders/${id}/stage`).then(r => r.data),
  stageBatch: (data) => api.post('/orders/stage-batch', data).then(r => r.data),
  unstageBatch: (order_ids) => api.post('/orders/unstage-batch', { order_ids }).then(r => r.data),
  unstagePlanIssues: () => api.post('/orders/unstage-plan-issues').then(r => r.data),
  recompute: (body = {}) => api.post('/orders/recompute', body, { timeout: 180000 }).then(r => r.data),
  getMargin: (id, params) => api.get(`/orders/${id}/margin`, { params }).then(r => r.data),
  getBatchMargins: (ids, periodId, mappingTab) => api.get('/orders/margins', {
    params: {
      ids: ids.join(','),
      ...(periodId ? { period_id: periodId } : {}),
      ...(mappingTab ? { mapping_tab: mappingTab } : {}),
    },
  }).then(r => r.data),
  listArchived: () => api.get('/orders/archived').then(r => r.data),
  cancelOrder: (id) => api.post(`/orders/${id}/cancel`).then(r => r.data),
  bulkCancelSSBoxesPreview: (order_ids) => api.post('/orders/bulk-cancel-shipstation-boxes/preview', { order_ids }).then(r => r.data),
  bulkCancelSSBoxes: (order_ids) => api.post('/orders/bulk-cancel-shipstation-boxes', { order_ids }).then(r => r.data),
}

export const shipstationApi = {
  status: () => api.get('/shipstation/status').then(r => r.data),
  push: (orderId) => api.post(`/shipstation/push/${orderId}`).then(r => r.data),
  pushBatch: (data) => api.post('/shipstation/push-batch', data).then(r => r.data),
  sync: () => api.post('/shipstation/sync').then(r => r.data),
  getEstimatedDelivery: (orderId) => api.get(`/shipstation/estimated-delivery/${orderId}`).then(r => r.data),
  checkDuplicates: () => api.post('/shipstation/check-duplicates').then(r => r.data),
  listInShipStationBoxes: () => api.get('/shipstation/in-shipstation-boxes').then(r => r.data),
}

export const picklistSkusApi = {
  list: (params) => api.get('/picklist-skus/', { params }).then(r => r.data),
  sync: () => api.post('/picklist-skus/sync').then(r => r.data),
  update: (id, data) => api.put(`/picklist-skus/${id}`, data).then(r => r.data),
  missingCogs: () => api.get('/picklist-skus/missing-cogs').then(r => r.data),
}

export const skuHelperApi = {
  list: (params) => api.get('/sku-helper/', { params }).then(r => r.data),
  create: (data) => api.post('/sku-helper/', data).then(r => r.data),
  update: (id, data) => api.put(`/sku-helper/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/sku-helper/${id}`).then(r => r.data),
  sync: () => api.post('/sku-helper/sync').then(r => r.data),
}

export const gmSettingsApi = {
  get: () => api.get('/gm-settings/').then(r => r.data),
  update: (data) => api.put('/gm-settings/', data).then(r => r.data),
}

export const packagingMaterialsApi = {
  list: () => api.get('/rules/packaging-materials').then(r => r.data),
  create: (data) => api.post('/rules/packaging-materials', data).then(r => r.data),
  update: (id, data) => api.put(`/rules/packaging-materials/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/rules/packaging-materials/${id}`).then(r => r.data),
}

export const boxTypePackagingApi = {
  list: (boxTypeId) => api.get(`/rules/box-types/${boxTypeId}/packaging`).then(r => r.data),
  add: (boxTypeId, data) => api.post(`/rules/box-types/${boxTypeId}/packaging`, data).then(r => r.data),
  update: (boxTypeId, entryId, data) => api.put(`/rules/box-types/${boxTypeId}/packaging/${entryId}`, data).then(r => r.data),
  remove: (boxTypeId, entryId) => api.delete(`/rules/box-types/${boxTypeId}/packaging/${entryId}`).then(r => r.data),
}

export const productsApi = {
  list: (params) => api.get('/products/', { params }).then(r => r.data),
  listProductTypes: () => api.get('/products/product-types').then(r => r.data),
  catalogErrors: () => api.get('/products/catalog-errors').then(r => r.data),
  update: (id, data) => api.patch(`/products/${id}`, data).then(r => r.data),
  setShortShipByType: (data) => api.post('/products/set-short-ship-by-type', data).then(r => r.data),
  setInventoryHoldByType: (data) => api.post('/products/set-inventory-hold-by-type', data).then(r => r.data),
  apply: () => api.post('/products/apply').then(r => r.data),
  sync: () => api.post('/products/sync').then(r => r.data),
}

export const projectionPeriodsApi = {
  list: (params) => api.get('/projection-periods/', { params }).then(r => r.data),
  get: (id) => api.get(`/projection-periods/${id}`).then(r => r.data),
  create: (data) => api.post('/projection-periods/', data).then(r => r.data),
  update: (id, data) => api.put(`/projection-periods/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/projection-periods/${id}`).then(r => r.data),
  suggestDates: () => api.get('/projection-periods/suggest-dates').then(r => r.data),
  // Short ship configs
  listShortShip: (periodId) => api.get(`/projection-periods/${periodId}/short-ship`).then(r => r.data),
  addShortShip: (periodId, data) => api.post(`/projection-periods/${periodId}/short-ship`, data).then(r => r.data),
  removeShortShip: (periodId, sku) => api.delete(`/projection-periods/${periodId}/short-ship/${encodeURIComponent(sku)}`).then(r => r.data),
  bulkSetShortShip: (periodId, data) => api.post(`/projection-periods/${periodId}/short-ship/bulk`, data).then(r => r.data),
  copyShortShip: (periodId, data) => api.post(`/projection-periods/${periodId}/short-ship/copy`, data).then(r => r.data),
  diffShortShip: (periodId, otherId) => api.get(`/projection-periods/${periodId}/short-ship/diff/${otherId}`).then(r => r.data),
  importGlobalShortShip: (periodId) => api.post(`/projection-periods/${periodId}/short-ship/import-global`).then(r => r.data),
  // Inventory hold configs
  listInventoryHold: (periodId) => api.get(`/projection-periods/${periodId}/inventory-hold`).then(r => r.data),
  addInventoryHold: (periodId, data) => api.post(`/projection-periods/${periodId}/inventory-hold`, data).then(r => r.data),
  removeInventoryHold: (periodId, sku) => api.delete(`/projection-periods/${periodId}/inventory-hold/${encodeURIComponent(sku)}`).then(r => r.data),
  copyInventoryHold: (periodId, data) => api.post(`/projection-periods/${periodId}/inventory-hold/copy`, data).then(r => r.data),
  diffInventoryHold: (periodId, otherId) => api.get(`/projection-periods/${periodId}/inventory-hold/diff/${otherId}`).then(r => r.data),
  importGlobalInventoryHold: (periodId) => api.post(`/projection-periods/${periodId}/inventory-hold/import-global`).then(r => r.data),
  // SKU mappings
  getSkuMappings: (periodId, params) => api.get(`/projection-periods/${periodId}/sku-mappings`, { params }).then(r => r.data),
  listSheetsTabs: () => api.get('/projection-periods/sheets/tabs').then(r => r.data.tabs || []),
  // Archive
  archive: (periodId) => api.post(`/projection-periods/${periodId}/archive`).then(r => r.data),
  unarchive: (periodId) => api.post(`/projection-periods/${periodId}/unarchive`).then(r => r.data),
}

export const projectionConfirmedOrdersApi = {
  list: (periodId) => api.get(`/projection-periods/${periodId}/confirmed-orders`).then(r => r.data),
  confirmOrders: (periodId, data) => api.post(`/projection-periods/${periodId}/confirm-orders`, data).then(r => r.data),
  unconfirmOrders: (periodId, data) => api.post(`/projection-periods/${periodId}/unconfirm-orders`, data).then(r => r.data),
  reConfirmAll: (periodId, data) => api.post(`/projection-periods/${periodId}/re-confirm-all`, data).then(r => r.data),
  forceRefreshAll: (periodId, data) => api.post(`/projection-periods/${periodId}/force-refresh-all`, data, { timeout: 300000 }).then(r => r.data),
  getRollup: (periodId) => api.get(`/projection-periods/${periodId}/confirmed-demand-rollup`).then(r => r.data),
  saveConfirmedDemand: (periodId) => api.post(`/projection-periods/${periodId}/save-confirmed-demand`).then(r => r.data),
  revertConfirmedDemand: (periodId) => api.post(`/projection-periods/${periodId}/revert-confirmed-demand`).then(r => r.data),
  getStagedBlocking: (periodId) => api.get(`/projection-periods/${periodId}/staged-orders-blocking`).then(r => r.data),
  // Inventory pivot scoped to confirmed demand for the period (respects this dashboard's short-ship/hold)
  getInventory: (periodId) => api.get(`/projection-periods/${periodId}/confirmed-demand-inventory`).then(r => r.data),
  // Confirmed orders enriched with ShopifyOrder fields + line items, matching the staged-orders shape
  listEnriched: (periodId) => api.get(`/projection-periods/${periodId}/confirmed-orders/enriched`).then(r => r.data),
}

// Confirmed Demand Dashboard's per-period short-ship / inventory-hold configs.
// Drives the confirmed-demand rollup, the dashboard's own views, AND the
// Confirmed Orders page (orders awaiting confirmation for the same period).
// Independent of Operations (shopify_products) and the projection forecast
// engine (period_*_configs).
export const confirmedDemandConfigsApi = {
  listShortShip: (periodId) =>
    api.get(`/projection-periods/${periodId}/confirmed-demand/short-ship`).then(r => r.data),
  addShortShip: (periodId, data) =>
    api.post(`/projection-periods/${periodId}/confirmed-demand/short-ship`, data).then(r => r.data),
  removeShortShip: (periodId, sku) =>
    api.delete(`/projection-periods/${periodId}/confirmed-demand/short-ship/${encodeURIComponent(sku)}`).then(r => r.data),
  bulkSetShortShip: (periodId, data) =>
    api.post(`/projection-periods/${periodId}/confirmed-demand/short-ship/bulk`, data).then(r => r.data),
  importGlobalShortShip: (periodId) =>
    api.post(`/projection-periods/${periodId}/confirmed-demand/short-ship/import-global`).then(r => r.data),

  listInventoryHold: (periodId) =>
    api.get(`/projection-periods/${periodId}/confirmed-demand/inventory-hold`).then(r => r.data),
  addInventoryHold: (periodId, data) =>
    api.post(`/projection-periods/${periodId}/confirmed-demand/inventory-hold`, data).then(r => r.data),
  removeInventoryHold: (periodId, sku) =>
    api.delete(`/projection-periods/${periodId}/confirmed-demand/inventory-hold/${encodeURIComponent(sku)}`).then(r => r.data),
  bulkSetInventoryHold: (periodId, data) =>
    api.post(`/projection-periods/${periodId}/confirmed-demand/inventory-hold/bulk`, data).then(r => r.data),
  importGlobalInventoryHold: (periodId) =>
    api.post(`/projection-periods/${periodId}/confirmed-demand/inventory-hold/import-global`).then(r => r.data),

  // Bulk-by-product-type — mirrors productsApi.setShortShipByType / setInventoryHoldByType
  setShortShipByType: (periodId, data) =>
    api.post(`/projection-periods/${periodId}/confirmed-demand/short-ship/by-product-type`, data).then(r => r.data),
  setInventoryHoldByType: (periodId, data) =>
    api.post(`/projection-periods/${periodId}/confirmed-demand/inventory-hold/by-product-type`, data).then(r => r.data),
}

export const historicalDataApi = {
  // Sales
  ingestSales: (params) => api.post('/historical/sales/ingest', null, { params, timeout: 600000 }).then(r => r.data),
  salesSummary: () => api.get('/historical/sales/summary').then(r => r.data),
  listSales: (params) => api.get('/historical/sales/', { params }).then(r => r.data),
  clearSales: () => api.delete('/historical/sales/').then(r => r.data),
  // Promotions
  listPromotions: () => api.get('/historical/promotions/').then(r => r.data),
  getPromotion: (id) => api.get(`/historical/promotions/${id}`).then(r => r.data),
  createPromotion: (data) => api.post('/historical/promotions/', data).then(r => r.data),
  updatePromotion: (id, data) => api.put(`/historical/promotions/${id}`, data).then(r => r.data),
  deletePromotion: (id) => api.delete(`/historical/promotions/${id}`).then(r => r.data),
}

export const fulfillmentApi = {
  // Carrier service rule evaluation
  getCarrierServiceForOrder: (shopifyOrderId) =>
    api.get(`/fulfillment/carrier-service-for-order/${shopifyOrderId}`).then(r => r.data),

  // Pactor map
  getPactorMap: () => api.get('/fulfillment/pactor-map').then(r => r.data),

  // Plans
  listPlans: (params) => api.get('/fulfillment/plans', { params }).then(r => r.data),
  createPlan: (data) => api.post('/fulfillment/plans', data).then(r => r.data),
  getPlan: (id) => api.get(`/fulfillment/plans/${id}`).then(r => r.data),
  updatePlan: (id, data) => api.put(`/fulfillment/plans/${id}`, data).then(r => r.data),
  deletePlan: (id) => api.delete(`/fulfillment/plans/${id}`).then(r => r.data),

  // Boxes
  addBox: (planId, data) => api.post(`/fulfillment/plans/${planId}/boxes`, data).then(r => r.data),
  updateBox: (planId, boxId, data) => api.put(`/fulfillment/plans/${planId}/boxes/${boxId}`, data).then(r => r.data),
  deleteBox: (planId, boxId) => api.delete(`/fulfillment/plans/${planId}/boxes/${boxId}`).then(r => r.data),
  deleteUnpushedBoxes: (planId) => api.delete(`/fulfillment/plans/${planId}/boxes/unpushed`).then(r => r.data),
  bulkResetUnpushed: () => api.delete('/fulfillment/bulk-reset-unpushed').then(r => r.data),
  bulkResetUnpushedByOrders: (order_ids) => api.delete('/fulfillment/bulk-reset-unpushed-by-orders', { data: { order_ids } }).then(r => r.data),

  // Box items
  setBoxItems: (planId, boxId, data) => api.put(`/fulfillment/plans/${planId}/boxes/${boxId}/items`, data).then(r => r.data),

  // ShipStation
  pushBox: (planId, boxId) => api.post(`/fulfillment/plans/${planId}/boxes/${boxId}/push`).then(r => r.data),
  sync: () => api.post('/fulfillment/sync').then(r => r.data),

  // Bulk push plan boxes for multiple orders (legacy, non-streaming)
  bulkPush: (data) => api.post('/fulfillment/bulk-push', data).then(r => r.data),

  // Streaming bulk push — returns an EventSource-like reader
  bulkPushStream: ({ order_ids, onProgress, onStart, onDone, onError }) => {
    const ctrl = new AbortController()
    fetch(`${API_BASE}/fulfillment/bulk-push-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_ids }),
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const detail = await res.text()
          throw new Error(detail)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() // keep incomplete line
          let eventType = null
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6))
              if (eventType === 'start' && onStart) onStart(data)
              else if (eventType === 'progress' && onProgress) onProgress(data)
              else if (eventType === 'done' && onDone) onDone(data)
            }
          }
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError' && onError) onError(err)
      })
    return ctrl // caller can call ctrl.abort() to cancel
  },

  // Poll push job status (survives page refresh)
  getPushStatus: (jobId) => api.get(`/fulfillment/bulk-push-status/${jobId}`).then(r => r.data),

  // Auto-create plans for all unplanned not_processed orders
  bulkAutoPlan: (orderIds) => api.post('/fulfillment/bulk-auto-plan', orderIds ? { order_ids: orderIds } : {}).then(r => r.data),
  bulkAutoPlanWithMapping: (orderIds, mappingTab, periodId) => api.post(
    '/fulfillment/bulk-auto-plan-with-mapping',
    { order_ids: orderIds, mapping_tab: mappingTab, period_id: periodId || null },
    { timeout: 300000 },
  ).then(r => r.data),

  // Change detection
  detectChanges: (shopifyOrderId) => api.post('/fulfillment/detect-changes', null, {
    params: shopifyOrderId ? { shopify_order_id: shopifyOrderId } : {},
  }).then(r => r.data),
  listChanges: (params) => api.get('/fulfillment/changes', { params }).then(r => r.data),
  approveChange: (id, data) => api.post(`/fulfillment/changes/${id}/approve`, data || {}).then(r => r.data),
  rejectChange: (id, data) => api.post(`/fulfillment/changes/${id}/reject`, data || {}).then(r => r.data),
}

export const projectionsApi = {
  generate: (periodId, data = {}) => api.post(`/projections/generate/${periodId}`, data).then(r => r.data),
  list: (params) => api.get('/projections/', { params }).then(r => r.data),
  get: (id) => api.get(`/projections/${id}`).then(r => r.data),
  delete: (id) => api.delete(`/projections/${id}`).then(r => r.data),

  // Shop-wide hourly orders chart + per-PT daily history grid
  getShopHourlyBreakdown: (projectionId) =>
    api.get(`/projections/${projectionId}/shop-hourly-breakdown`).then(r => r.data),
  getPtDailyHistory: (projectionId, productType) =>
    api.get(`/projections/${projectionId}/pt-daily-history`, { params: { product_type: productType } }).then(r => r.data),
  getHistoricalSummary: (projectionId) =>
    api.get(`/projections/${projectionId}/historical-summary`).then(r => r.data),
  getSkuDiagnostics: (projectionId, productType) =>
    api.get(`/projections/${projectionId}/sku-diagnostics`, { params: { product_type: productType } }).then(r => r.data),
  getCoverageSummary: (projectionId) =>
    api.get(`/projections/${projectionId}/coverage-summary`).then(r => r.data),

  // Per-product-type overrides (Phase 2)
  listOverrides: (periodId) => api.get(`/projection-periods/${periodId}/overrides`).then(r => r.data),
  upsertOverride: (periodId, data) => api.post(`/projection-periods/${periodId}/overrides`, data).then(r => r.data),
  deleteOverride: (periodId, productType) =>
    api.delete(`/projection-periods/${periodId}/overrides/${encodeURIComponent(productType)}`).then(r => r.data),
  compare: (id, otherId) =>
    api.get(`/projections/${id}/compare/${otherId}`).then(r => r.data),

  // Padding configs
  listPaddingConfigs: () => api.get('/projections/padding-configs').then(r => r.data),
  upsertPaddingConfig: (data) => api.post('/projections/padding-configs', data).then(r => r.data),
  deletePaddingConfig: (id) => api.delete(`/projections/padding-configs/${id}`).then(r => r.data),
}

export const vendorsApi = {
  list: (params) => api.get('/vendors/', { params }).then(r => r.data),
  get: (id) => api.get(`/vendors/${id}`).then(r => r.data),
  create: (data) => api.post('/vendors/', data).then(r => r.data),
  update: (id, data) => api.put(`/vendors/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/vendors/${id}`).then(r => r.data),
  // Vendor products
  addProduct: (vendorId, data) => api.post(`/vendors/${vendorId}/products`, data).then(r => r.data),
  updateProduct: (vendorId, productId, data) => api.put(`/vendors/${vendorId}/products/${productId}`, data).then(r => r.data),
  deleteProduct: (vendorId, productId) => api.delete(`/vendors/${vendorId}/products/${productId}`).then(r => r.data),
  // Lookups
  getPreferred: (productType) => api.get(`/vendors/preferred/${encodeURIComponent(productType)}`).then(r => r.data),
  getByProductType: (productType) => api.get(`/vendors/by-product-type/${encodeURIComponent(productType)}`).then(r => r.data),
  // Sheet sync
  syncFromSheets: () => api.post('/vendors/sync-from-sheets').then(r => r.data),
  // Duplicate consolidation
  consolidateDuplicates: (dryRun = false) =>
    api.post(`/vendors/consolidate-duplicates?dry_run=${dryRun}`).then(r => r.data),
}

export const purchaseOrdersApi = {
  list: (params) => api.get('/purchase-orders/', { params }).then(r => r.data),
  get: (id) => api.get(`/purchase-orders/${id}`).then(r => r.data),
  create: (data) => api.post('/purchase-orders/', data).then(r => r.data),
  update: (id, data) => api.put(`/purchase-orders/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/purchase-orders/${id}`).then(r => r.data),
  // Lines
  addLine: (poId, data) => api.post(`/purchase-orders/${poId}/lines`, data).then(r => r.data),
  updateLine: (poId, lineId, data) => api.put(`/purchase-orders/${poId}/lines/${lineId}`, data).then(r => r.data),
  deleteLine: (poId, lineId) => api.delete(`/purchase-orders/${poId}/lines/${lineId}`).then(r => r.data),
  // Allocations
  setAllocations: (poId, lineId, data) => api.put(`/purchase-orders/${poId}/lines/${lineId}/allocations`, data).then(r => r.data),
  // From projection
  createFromProjection: (data) => api.post('/purchase-orders/from-projection', data).then(r => r.data),
  // On-order summary
  getOnOrder: (periodId) => api.get(`/purchase-orders/on-order/${periodId}`).then(r => r.data),
}

export const purchasePlanningApi = {
  list: (projectionPeriodId) =>
    api.get('/purchase-planning/', { params: { projection_period_id: projectionPeriodId } }).then(r => r.data),
  create: (data) => api.post('/purchase-planning/', data).then(r => r.data),
  update: (id, data) => api.put(`/purchase-planning/${id}`, data).then(r => r.data),
  delete: (id) => api.delete(`/purchase-planning/${id}`).then(r => r.data),
  bulkDelete: (ids) => api.post('/purchase-planning/bulk-delete', { ids }).then(r => r.data),
  seed: (projectionPeriodId) =>
    api.post('/purchase-planning/seed', null, { params: { projection_period_id: projectionPeriodId } }).then(r => r.data),
  // PO linkage: action ∈ {"link" + purchase_order_id, "create", "unlink"}
  setPo: (id, body) => api.put(`/purchase-planning/${id}/po`, body).then(r => r.data),
  // Bulk PO linkage: body { ids, action: "link"|"create", purchase_order_id? }
  bulkSetPo: (body) => api.post('/purchase-planning/bulk-set-po', body).then(r => r.data),
  eligiblePos: (vendorId) =>
    api.get('/purchase-planning/eligible-pos', { params: { vendor_id: vendorId } }).then(r => r.data),
}

export const receivingApi = {
  listForPO: (poId) => api.get(`/receiving/po/${poId}`).then(r => r.data),
  receive: (poId, lineId, data) => api.post(`/receiving/po/${poId}/lines/${lineId}/receive`, data).then(r => r.data),
  update: (recordId, data) => api.put(`/receiving/${recordId}`, data).then(r => r.data),
  delete: (recordId) => api.delete(`/receiving/${recordId}`).then(r => r.data),
  // poLineId is optional — when provided the backend uses the linked plan
  // row's base + sub product types as additional suggestion candidates.
  getSkusForProductType: (productType, poLineId) =>
    api.get(`/receiving/skus-for-product-type/${encodeURIComponent(productType)}`, {
      params: poLineId ? { po_line_id: poLineId } : {},
    }).then(r => r.data),
  pushToInventory: (recordId, data) => api.post(`/receiving/${recordId}/push-to-inventory`, data || {}).then(r => r.data),
  pushAll: (poId, data) => api.post(`/receiving/po/${poId}/push-all`, data || {}).then(r => r.data),
}

export const inventoryCountApi = {
  scan: (warehouse, imageFiles) => {
    const form = new FormData()
    form.append('warehouse', warehouse)
    imageFiles.forEach(f => form.append('images', f))
    return api.post('/inventory-count/scan', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    }).then(r => r.data)
  },
  commit: (data) => api.post('/inventory-count/commit', data).then(r => r.data),
}
