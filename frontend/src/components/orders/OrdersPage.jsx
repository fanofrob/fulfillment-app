import { useState, useMemo, useEffect, Fragment, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ordersApi, shopifyAuthApi, shipstationApi, rulesApi, fulfillmentApi, boxTypesApi, projectionPeriodsApi, projectionConfirmedOrdersApi } from '../../api'
import { productsApi } from '../../api'
import OrderDetailPanel, { STATUS_BADGE, calcLinePactor, calcBoxPactor, calcOrderPactor, fmtPactor, fmtDate, tagChipClass, ItemsTable } from '../../pages/OrderDetailPanel'

// ── Constants ──────────────────────────────────────────────────────────────────

const WAREHOUSES = ['walnut', 'northlake']

// Classify an order by its short-ship configuration on unfulfilled items
// Returns 'ship_all' | 'ship_partial' | 'ship_none' | 'inv_hold' | null (if no unfulfilled items)
function getShipCategory(order) {
  const items = order.line_items || []
  const unfulfilled = items.filter(li => (li.fulfillable_quantity ?? li.quantity ?? 0) > 0)
  if (unfulfilled.length === 0) return null
  const hasShortShip = unfulfilled.some(li => li.app_line_status === 'short_ship')
  const hasInvHold = unfulfilled.some(li => li.app_line_status === 'inventory_hold')
  const hasNormal = unfulfilled.some(li => !['short_ship', 'inventory_hold'].includes(li.app_line_status))
  if (hasInvHold) return 'inv_hold'
  if (hasShortShip && hasNormal) return 'ship_partial'
  if (hasShortShip) return 'ship_none'
  return 'ship_all'
}

// True when more lines are being short-shipped than are actually being fulfilled.
// Used to raise the ship_partial margin floor (less actually ships, so the
// remaining items need to carry more margin to be worth running).
function hasMoreShortThanFulfill(order) {
  const items = order.line_items || []
  const toFulfillCount = items.filter(li =>
    (li.fulfillable_quantity ?? li.quantity ?? 0) > 0 &&
    !['short_ship', 'removed', 'inventory_hold'].includes(li.app_line_status)
  ).length
  const shortShipCount = items.filter(li => li.app_line_status === 'short_ship').length
  return shortShipCount > toFulfillCount
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function daysAgo(dateStr) {
  if (!dateStr) return null
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000)
}

// ── CSV Export ─────────────────────────────────────────────────────────────────

function csvEscape(val) {
  if (val === null || val === undefined) return ''
  const s = String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
  return s
}

const ORDER_CSV_HEADERS = [
  'order_number', 'customer', 'status', 'order_date', 'age_days',
  'order_total', 'tags', 'city', 'state', 'has_plan', 'gross_margin_pct',
  'pick_sku', 'product_title', 'fulfillable_qty', 'pick_qty', 'line_status',
]

function exportOrdersCsv(orders, marginsMap, label) {
  const rows = []
  for (const o of orders) {
    const marginEntry = marginsMap?.[o.shopify_order_id]
    const gmPct = (!marginEntry?.missing_cost_skus?.length && marginEntry?.gm_pct != null)
      ? marginEntry.gm_pct.toFixed(1)
      : ''
    const orderFields = [
      o.shopify_order_number || o.shopify_order_id,
      o.customer_name || '',
      STATUS_BADGE[o.app_status]?.label || o.app_status || '',
      o.created_at_shopify ? new Date(o.created_at_shopify).toLocaleDateString() : '',
      daysAgo(o.created_at_shopify) ?? '',
      (marginEntry?.fulfillable_revenue ?? o.total_price) != null ? Number(marginEntry?.fulfillable_revenue ?? o.total_price).toFixed(2) : '',
      (o.tags || '').split(',').map(t => t.trim()).filter(Boolean).join('; '),
      o.shipping_city || '',
      o.shipping_province || '',
      o.has_plan ? 'yes' : 'no',
      gmPct,
    ]
    const fulfillableItems = (o.line_items || []).filter(li => (li.fulfillable_quantity ?? li.quantity ?? 0) > 0)
    if (fulfillableItems.length === 0) {
      rows.push([...orderFields, '', '', '', '', ''].map(csvEscape).join(','))
    } else {
      for (const li of fulfillableItems) {
        const fq = li.fulfillable_quantity ?? li.quantity ?? 0
        const pickQty = fq * (li.mix_quantity ?? 1)
        rows.push([
          ...orderFields,
          li.pick_sku || '',
          li.product_title || '',
          fq,
          pickQty % 1 === 0 ? pickQty : pickQty.toFixed(2),
          li.app_line_status || '',
        ].map(csvEscape).join(','))
      }
    }
  }
  const csv = [ORDER_CSV_HEADERS.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `orders-${label}-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Left Status Sidebar ────────────────────────────────────────────────────────

function StatusSidebar({ orders, statusFilter, setStatusFilter, holdTags, dnssTags, marginOverrideTags = new Set(), plans = [], archivedCount = 0, marginsMap = {}, mode = 'operations', confirmedCount = 0 }) {
  const counts = useMemo(() => {
    const c = { all: 0, not_processed: 0, needs_plan: 0, on_hold: 0, no_box_rule: 0, plan_mismatch: 0, ss_duplicate: 0, cogs_error: 0, pending_payment: 0, ship_all: 0, ship_partial: 0, ship_none: 0, inv_hold: 0 }
    for (const o of orders) {
      c[o.app_status] = (c[o.app_status] || 0) + 1
      if (o.app_status !== 'fulfilled') c.all++
      const tags = (o.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
      const isHeld = o.shopify_hold || tags.some(t => holdTags.has(t))
      const isDNSS = tags.some(t => dnssTags && dnssTags.has(t))
      const hasShortShip = (o.line_items || []).some(li => li.app_line_status === 'short_ship')
      const hasInvHold = (o.line_items || []).some(li => li.app_line_status === 'inventory_hold')
      const shipCat = getShipCategory(o)
      // "Nothing to ship" — all unfulfilled lines are short-shipped (or none exist).
      // These orders don't need a plan, and belong in Ship None, not Needs Plan.
      const hasNothingToShip = shipCat === 'ship_none' || shipCat === null
      if (o.app_status === 'not_processed' && !o.has_plan && !isHeld && !hasNothingToShip) c.needs_plan++
      const hasPlanIssue = (o.app_status === 'not_processed' && !o.has_plan && !hasNothingToShip) || (o.has_plan && o.plan_box_unmatched) || o.has_plan_mismatch || o.ss_duplicate
      if (o.has_plan && o.plan_box_unmatched && !isHeld) c.no_box_rule++
      if (o.has_plan_mismatch) c.plan_mismatch++
      if (o.ss_duplicate) c.ss_duplicate++
      if (isHeld) c.on_hold++
      if (hasInvHold && o.app_status === 'not_processed') c.inv_hold++
      if (o.financial_status === 'pending' || o.financial_status === 'partially_paid') c.pending_payment++
      const marginEntry = marginsMap[o.shopify_order_id]
      const hasCOGSError = marginEntry?.missing_cost_skus?.length > 0
      if (hasCOGSError) c.cogs_error++
      const isPaymentPending = o.financial_status === 'pending' || o.financial_status === 'partially_paid'
      const isExcludedFromShipViews = isHeld || isPaymentPending || hasInvHold || hasPlanIssue || hasCOGSError ||
        o.app_status === 'staged' || o.app_status === 'in_shipstation_not_shipped' || o.app_status === 'in_shipstation_shipped' || o.app_status === 'fulfilled'
      if (!isExcludedFromShipViews) {
        // Check if order should be forced to ship_none due to margin rules.
        // Threshold tiers: ship_all 30%, ship_partial 40%, ship_partial where
        // more lines are short-shipped than to-fulfill 50% (less ships, so the
        // remaining items must carry more margin).
        const hasMarginOverride = tags.some(t => marginOverrideTags.has(t))
        const marginEntry = marginsMap[o.shopify_order_id]
        const hasMarginData = marginEntry !== undefined
        const gmPct = marginEntry?.gm_pct
        const fulfillableRevenue = marginEntry?.fulfillable_revenue ?? 0
        const isMostlyShort = shipCat === 'ship_partial' && hasMoreShortThanFulfill(o)
        const marginThreshold = isMostlyShort ? 50 : (shipCat === 'ship_partial' ? 40 : 30)
        const isLowMargin = hasMarginData && !hasMarginOverride && gmPct != null && gmPct < marginThreshold
        const isZeroRevenue = hasMarginData && !hasMarginOverride && (fulfillableRevenue <= 0 || gmPct == null)
        const forceShipNone = isLowMargin || isZeroRevenue

        if (shipCat === 'ship_none' || (isDNSS && hasShortShip && !isHeld && !isPaymentPending) || (forceShipNone && (shipCat === 'ship_all' || shipCat === 'ship_partial'))) c.ship_none++
        else if (shipCat === 'ship_all' && !(isDNSS && hasShortShip)) c.ship_all++
        else if (shipCat === 'ship_partial' && !(isDNSS && hasShortShip)) c.ship_partial++
      }
    }
    return c
  }, [orders, holdTags, dnssTags, marginOverrideTags, marginsMap])

  // Group plans by status for "Open Batches" section
  const planGroups = useMemo(() => {
    const groups = {}
    for (const p of plans) {
      const key = p.batch_label || p.shopify_order_number || p.shopify_order_id
      groups[key] = (groups[key] || 0) + 1
    }
    return groups
  }, [plans])

  const sections = mode === 'projections' ? [
    { label: 'Awaiting Shipment', items: [
      { key: 'all',                 label: 'All Orders',          icon: '☰' },
      { key: 'not_processed',       label: 'Not Processed',       icon: '○' },
      { key: 'partially_fulfilled', label: 'Partially Fulfilled', icon: '◑' },
    ]},
    { label: 'Confirming', items: [
      { key: 'ship_all',     label: 'Ship All',     icon: '▶' },
      { key: 'ship_partial', label: 'Ship Partial', icon: '◑' },
      { key: 'ship_none',    label: 'Ship None',    icon: '○' },
      { key: 'confirmed',    label: 'Confirmed',    icon: '✓' },
    ]},
    { label: 'Plan & Box Issues', items: [
      { key: 'needs_plan',    label: 'Needs Plan',    icon: '⚠' },
      { key: 'no_box_rule',   label: 'No Box Rule',   icon: '⬜' },
      { key: 'plan_mismatch', label: 'Plan Mismatch', icon: '!' },
    ]},
  ] : [
    { label: 'Awaiting Shipment', items: [
      { key: 'all',                  label: 'All Orders',          icon: '☰' },
      { key: 'not_processed',       label: 'Not Processed',       icon: '○' },
      { key: 'partially_fulfilled', label: 'Partially Fulfilled', icon: '◑' },
    ]},
    { label: 'Staging', items: [
      { key: 'ship_all',    label: 'Ship All',     icon: '▶' },
      { key: 'ship_partial', label: 'Ship Partial', icon: '◑' },
      { key: 'ship_none',   label: 'Ship None',    icon: '○' },
      { key: 'inv_hold',    label: 'Inventory Hold', icon: '⏸' },
      { key: 'staged',      label: 'Staged',       icon: '▶' },
    ]},
    { label: 'Plan & Box Issues', items: [
      { key: 'needs_plan',    label: 'Needs Plan',    icon: '⚠' },
      { key: 'no_box_rule',   label: 'No Box Rule',   icon: '⬜' },
      { key: 'plan_mismatch', label: 'Plan Mismatch', icon: '!' },
      { key: 'ss_duplicate',  label: 'SS Duplicate',  icon: '⚠' },
      { key: 'cogs_error',    label: 'COGS Error',    icon: '⚠' },
    ]},
    { label: 'Shipments', items: [
      { key: 'in_shipstation_not_shipped', label: 'In ShipStation',  icon: '🚚' },
      { key: 'in_shipstation_shipped',     label: 'Shipped',         icon: '✓' },
      { key: 'fulfilled',                  label: 'Fulfilled',       icon: '✓' },
    ]},
    { label: 'Not Shipping', items: [
      { key: 'on_hold',          label: 'On Hold',         icon: '⏸' },
      { key: 'pending_payment',  label: 'Pending Payment', icon: '$' },
      { key: 'archived',         label: 'Auto-Archived',   icon: '🗄' },
    ]},
  ]

  return (
    <div className="ss-status-sidebar">
      {sections.map((section, si) => (
        <div key={si} className="ss-sidebar-group">
          {section.label && <div className="ss-sidebar-section-label">{section.label}</div>}
          {section.items.map(cat => {
            const count = cat.key === 'archived' ? archivedCount
              : cat.key === 'confirmed' ? confirmedCount
              : (counts[cat.key] || 0)
            return (
              <button
                key={cat.key}
                className={`ss-status-item${statusFilter === cat.key ? ' active' : ''}`}
                onClick={() => setStatusFilter(cat.key)}
              >
                <span className="ss-status-item-label">{cat.label}</span>
                {count > 0 && <span className="ss-status-item-count">{count}</span>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// ── Orders Table Row ───────────────────────────────────────────────────────────

function OrderRow({ order, isSelected, isChecked, onClick, onCheck, holdTags, grossMarginPct, missingCostSkus = [], fulfillableRevenue, mappingUsed = null, currentMappingTab = null }) {
  const tags = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean)
  const isHeld = order.shopify_hold || tags.some(t => holdTags.has(t.toLowerCase()))
  const isPendingPayment = order.financial_status === 'pending' || order.financial_status === 'partially_paid'
  const hasPlanIssue = (order.app_status === 'not_processed' && !order.has_plan) || (order.has_plan && order.plan_box_unmatched) || order.has_plan_mismatch || order.ss_duplicate
  const age = daysAgo(order.created_at_shopify)
  const isOld = age !== null && age >= 7

  // Summarize items
  const itemSummary = order.line_items_summary || ''

  return (
    <tr
      className={`ss-order-row${isSelected ? ' selected' : ''}${isHeld ? ' held' : ''}`}
      onClick={onClick}
    >
      <td onClick={e => e.stopPropagation()} style={{ width: 36 }}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={onCheck}
          disabled={isPendingPayment || hasPlanIssue}
          style={{ cursor: 'pointer' }}
        />
      </td>
      <td className="ss-order-num-cell">
        <span className="ss-order-link">{order.shopify_order_number}</span>
      </td>
      <td className={`ss-age-cell${isOld ? ' old' : ''}`}>
        {age !== null ? `${age}d` : '—'}
      </td>
      <td className="ss-date-cell">
        {fmtDate(order.created_at_shopify)}
      </td>
      <td className="ss-tags-cell">
        {tags.map(t => <span key={t} className={tagChipClass(t)}>{t}</span>)}
      </td>
      <td className="ss-item-cell">
        {itemSummary || <span style={{ color: '#9ca3af' }}>—</span>}
      </td>
      <td className="ss-recipient-cell">
        {order.customer_name || '—'}
        {order.shipping_city && (
          <div style={{ fontSize: 11, color: '#9ca3af' }}>{order.shipping_city}, {order.shipping_province}</div>
        )}
      </td>
      <td className="ss-qty-cell">
        {order.total_quantity || '—'}
      </td>
      <td className="ss-total-cell">
        ${(fulfillableRevenue != null ? fulfillableRevenue : (order.total_price || 0)).toFixed(2)}
      </td>
      <td style={{ textAlign: 'right', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap',
        color: missingCostSkus.length > 0 ? '#f59e0b' : grossMarginPct == null ? '#9ca3af' : grossMarginPct >= 30 ? '#16a34a' : grossMarginPct >= 10 ? '#d97706' : '#dc2626' }}>
        {missingCostSkus.length > 0
          ? <span title={`Missing COGS for: ${missingCostSkus.join(', ')}`}>⚠ COGS</span>
          : grossMarginPct == null ? '—' : `${grossMarginPct.toFixed(1)}%`
        }
      </td>
      <td className="ss-status-cell">
        <span className={`badge ${STATUS_BADGE[order.app_status]?.cls || 'badge-not-processed'}`} style={{ fontSize: 11 }}>
          {STATUS_BADGE[order.app_status]?.label || order.app_status}
        </span>
        {order.has_plan && (order.app_status === 'not_processed' || order.app_status === 'partially_fulfilled') && !order.plan_box_unmatched && (
          <span className="badge badge-fulfilled" style={{ fontSize: 10, marginLeft: 4 }}>Plan</span>
        )}
        {order.plan_box_unmatched && (
          <span className="badge" style={{ fontSize: 10, marginLeft: 4, background: '#fef3c7', color: '#d97706' }} title="No package rule matched — box type unassigned">No Box Rule</span>
        )}
        {order.has_plan_mismatch && (
          <span className="badge" style={{ fontSize: 10, marginLeft: 4, background: '#fee2e2', color: '#dc2626' }} title="Box quantities don't match the order — under or over coverage">Plan Mismatch</span>
        )}
        {order.ss_duplicate && (
          <span className="badge" style={{ fontSize: 10, marginLeft: 4, background: '#fef3c7', color: '#92400e' }} title="Order already exists unshipped in ShipStation — cancel in SS first">SS Duplicate</span>
        )}
        {isHeld && (
          <span className="badge" style={{ fontSize: 10, marginLeft: 4, background: '#fee2e2', color: '#dc2626' }}>HOLD</span>
        )}
        {isPendingPayment && (
          <span className="badge" style={{ fontSize: 10, marginLeft: 4, background: '#fef3c7', color: '#92400e' }} title={`Payment status: ${order.financial_status}`}>Pending Payment</span>
        )}
        {mappingUsed && (
          <span
            className="badge"
            style={{
              fontSize: 10, marginLeft: 4,
              background: currentMappingTab && mappingUsed !== currentMappingTab ? '#fef3c7' : '#dbeafe',
              color: currentMappingTab && mappingUsed !== currentMappingTab ? '#92400e' : '#1e40af',
            }}
            title={
              currentMappingTab && mappingUsed !== currentMappingTab
                ? `Confirmed under "${mappingUsed}" — current selection is "${currentMappingTab}". Re-confirming will overwrite the snapshot.`
                : `Confirmed under "${mappingUsed}"`
            }
          >
            ✓ {mappingUsed}
          </span>
        )}
      </td>
    </tr>
  )
}

// ── Column Filter ──────────────────────────────────────────────────────────────

function ColumnFilter({ type, label, options, value, onChange }) {
  // type: 'select' | 'range'
  // For 'select': options=[string], value=Set|null (null=all), onChange(Set|null)
  // For 'range': value={min:'',max:''}, onChange({min,max})
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const isActive = type === 'select' ? value !== null : (value.min !== '' || value.max !== '')

  function toggleOption(opt) {
    const base = value === null ? new Set(options) : new Set(value)
    base.has(opt) ? base.delete(opt) : base.add(opt)
    onChange(base.size === 0 ? new Set() : base.size === options.length ? null : base)
  }

  const filteredOpts = options ? options.filter(o => String(o).toLowerCase().includes(search.toLowerCase())) : []

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className={`col-filter-btn${isActive ? ' active' : ''}`}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        title={`Filter ${label}`}
      >▾</button>
      {open && (
        <div className="col-filter-dropdown" onClick={e => e.stopPropagation()}>
          {type === 'select' ? (
            <>
              <input
                autoFocus
                type="text"
                className="col-filter-search"
                placeholder="Search values…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <div className="col-filter-sel-actions">
                <button onClick={() => onChange(null)}>All</button>
                <button onClick={() => onChange(new Set())}>None</button>
              </div>
              <div className="col-filter-list">
                {filteredOpts.map(opt => (
                  <label key={opt} className="col-filter-option">
                    <input
                      type="checkbox"
                      checked={value === null || value.has(opt)}
                      onChange={() => toggleOption(opt)}
                    />
                    <span>{opt || '(blank)'}</span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <div className="col-filter-range">
              <label>Min<input type="number" value={value.min} onChange={e => onChange({ ...value, min: e.target.value })} placeholder="Min" /></label>
              <label>Max<input type="number" value={value.max} onChange={e => onChange({ ...value, max: e.target.value })} placeholder="Max" /></label>
            </div>
          )}
          <div className="col-filter-footer">
            {isActive && <button className="col-filter-clear-btn" onClick={() => { onChange(type === 'select' ? null : { min: '', max: '' }); setSearch('') }}>Clear</button>}
            <button className="col-filter-done-btn" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </span>
  )
}

function SortTh({ col, sortCol, sortDir, onSort, children, style = {}, filterEl }) {
  const active = sortCol === col
  return (
    <th
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...style }}
      onClick={() => onSort(col)}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: style.textAlign === 'right' ? 'flex-end' : 'flex-start' }}>
        {children} {active ? (sortDir === 'asc' ? '↑' : '↓') : <span style={{ color: '#d1d5db', fontSize: 10 }}>↕</span>}
        {filterEl}
      </span>
    </th>
  )
}

// ── Main Orders Component ──────────────────────────────────────────────────────

export default function OrdersPage({
  mode = 'operations',
  periodId = null,
  mappingTab = '',
  onPeriodChange = null,
  onMappingChange = null,
}) {
  const isProjections = mode === 'projections'
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [tagSearch, setTagSearch] = useState('')
  const [warehouse, setWarehouse] = useState('walnut')
  const [selectedOrderId, setSelectedOrderId] = useState(null)
  const [selectedForBatch, setSelectedForBatch] = useState(new Set())
  const [sortCol, setSortCol] = useState('order_date')
  const [sortDir, setSortDir] = useState('desc')
  const [syncBanner, setSyncBanner] = useState(null) // { type: 'syncing'|'success'|'error', message: string }
  const syncBannerTimer = useRef(null)
  const [colFilters, setColFilters] = useState({
    tags: null,     // Set | null
    items: null,    // Set | null
    states: null,   // Set | null
    statuses: null, // Set | null
    age: { min: '', max: '' },
    total: { min: '', max: '' },
    gm: { min: '', max: '' },
  })
  function setCF(key, val) { setColFilters(f => ({ ...f, [key]: val })) }

  const [ssBoxColFilters, setSsBoxColFilters] = useState({ boxType: null, pickSku: null })
  function setSsBoxCF(key, val) { setSsBoxColFilters(f => ({ ...f, [key]: val })) }

  // Re-confirm safety guard: when the user clicks Confirm Selected and any of
  // the selected orders are already confirmed under a *different* mapping tab,
  // we surface this modal so an accidental overwrite is a deliberate choice.
  const [reconfirmModal, setReconfirmModal] = useState(null)
  // shape: { conflicts: [{shopify_order_id, order_number, original_tab}], allIds: [...] }

  const qc = useQueryClient()
  const navigate = useNavigate()

  const CLIENT_SIDE_FILTERS = new Set(['all', 'not_processed', 'needs_plan', 'on_hold', 'no_box_rule', 'plan_mismatch', 'ss_duplicate', 'cogs_error', 'pending_payment', 'ship_all', 'ship_partial', 'ship_none', 'inv_hold', 'confirmed'])
  // In projections mode, mappingTab drives a live preview re-resolution of pick
  // SKUs and box configs server-side. Empty string = no override (show stored).
  // periodId, when set, layers the period's short-ship/inventory-hold configs
  // as in-memory overrides on app_line_status (also no DB writes).
  const previewTab = isProjections && mappingTab ? mappingTab : null
  const previewPeriodId = isProjections && periodId ? periodId : null
  const ordersParams = {
    ...(statusFilter !== 'all' && !CLIENT_SIDE_FILTERS.has(statusFilter) ? { app_status: statusFilter } : {}),
    ...(search ? { search } : {}),
    ...(tagSearch ? { tag: tagSearch } : {}),
    ...(previewTab ? { mapping_tab: previewTab } : {}),
    ...(previewPeriodId ? { period_id: previewPeriodId } : {}),
    limit: 2000,
  }

  // Always fetch all orders (no status filter) for sidebar counts. Mapping_tab
  // only affects margin/COGS preview (not classification), so it's omitted to
  // keep the cache hot. Period_id IS needed: it layers the period's short-ship
  // / inventory-hold configs onto app_line_status, which drives ship_partial /
  // ship_none / inv_hold counts.
  const allOrdersParams = {
    ...(search ? { search } : {}),
    ...(tagSearch ? { tag: tagSearch } : {}),
    ...(previewPeriodId ? { period_id: previewPeriodId } : {}),
    limit: 2000,
  }

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['orders', ordersParams],
    queryFn: () => ordersApi.list(ordersParams),
    refetchInterval: 60000,
  })

  const { data: allOrders = [] } = useQuery({
    queryKey: ['orders', allOrdersParams],
    queryFn: () => ordersApi.list(allOrdersParams),
    refetchInterval: 60000,
  })

  const { data: archivedOrders = [], isLoading: isLoadingArchived } = useQuery({
    queryKey: ['orders-archived'],
    queryFn: () => ordersApi.listArchived(),
  })

  const orderIds = useMemo(() => orders.map(o => o.shopify_order_id), [orders])
  const allOrderIds = useMemo(() => allOrders.map(o => o.shopify_order_id), [allOrders])
  const { data: marginsMap = {} } = useQuery({
    queryKey: ['orders-margins', orderIds, previewPeriodId, previewTab],
    queryFn: () => orderIds.length ? ordersApi.getBatchMargins(orderIds, previewPeriodId, previewTab) : {},
    enabled: orderIds.length > 0,
    staleTime: 2 * 60 * 1000,
  })
  const { data: allMarginsMap = {} } = useQuery({
    queryKey: ['orders-margins', allOrderIds, previewPeriodId, previewTab],
    queryFn: () => allOrderIds.length ? ordersApi.getBatchMargins(allOrderIds, previewPeriodId, previewTab) : {},
    enabled: allOrderIds.length > 0,
    staleTime: 2 * 60 * 1000,
  })

  const { data: ssBoxes = [], isLoading: isLoadingBoxes } = useQuery({
    queryKey: ['in-shipstation-boxes'],
    queryFn: () => shipstationApi.listInShipStationBoxes(),
    enabled: statusFilter === 'in_shipstation_not_shipped',
    refetchInterval: 60000,
  })

  const { data: shopifyStatus } = useQuery({
    queryKey: ['shopify-status'],
    queryFn: shopifyAuthApi.status,
    refetchOnWindowFocus: true,
  })

  const { data: ssStatus } = useQuery({
    queryKey: ['shipstation-status'],
    queryFn: shipstationApi.status,
  })

  const { data: orderRules = [] } = useQuery({
    queryKey: ['order-rules'],
    queryFn: rulesApi.listOrders,
  })

  // ── Projections-mode queries ─────────────────────────────────────────────────
  const { data: projectionPeriods = [] } = useQuery({
    queryKey: ['projection-periods', 'active'],
    queryFn: () => projectionPeriodsApi.list({ status: 'active' }),
    enabled: isProjections,
  })
  const { data: sheetsTabs = [] } = useQuery({
    queryKey: ['projection-sheets-tabs'],
    queryFn: () => projectionPeriodsApi.listSheetsTabs(),
    enabled: isProjections,
  })
  const { data: confirmedOrders = [] } = useQuery({
    queryKey: ['projection-confirmed-orders', periodId],
    queryFn: () => projectionConfirmedOrdersApi.list(periodId),
    enabled: isProjections && !!periodId,
  })
  const confirmedOrderIds = useMemo(
    () => new Set(confirmedOrders.map(o => o.shopify_order_id)),
    [confirmedOrders]
  )

  const confirmMutation = useMutation({
    mutationFn: (ids) => projectionConfirmedOrdersApi.confirmOrders(periodId, {
      order_ids: ids, mapping_tab: mappingTab,
    }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['projection-confirmed-orders', periodId] })
      setSelectedForBatch(new Set())
      if (data.skipped > 0) {
        const reasons = (data.results || [])
          .filter(r => !r.success)
          .slice(0, 5)
          .map(r => `  #${r.order_id}: ${r.error}`)
          .join('\n')
        alert(`Confirmed ${data.confirmed} order${data.confirmed !== 1 ? 's' : ''}, skipped ${data.skipped}${reasons ? '\n\n' + reasons : ''}`)
      }
    },
    onError: (err) => {
      alert(`Confirm failed: ${err?.response?.data?.detail || err?.message || 'Unknown error'}`)
    },
  })

  const unconfirmMutation = useMutation({
    mutationFn: (ids) => projectionConfirmedOrdersApi.unconfirmOrders(periodId, { order_ids: ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projection-confirmed-orders', periodId] })
      setSelectedForBatch(new Set())
    },
  })

  const reConfirmAllMutation = useMutation({
    mutationFn: () => projectionConfirmedOrdersApi.reConfirmAll(periodId, { mapping_tab: mappingTab }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['projection-confirmed-orders', periodId] })
      setSelectedForBatch(new Set())
      const reasons = (data.results || [])
        .filter(r => !r.success)
        .slice(0, 5)
        .map(r => `  #${r.order_id}: ${r.error}`)
        .join('\n')
      const skippedNote = data.skipped > 0 && reasons ? '\n\n' + reasons : ''
      alert(`Re-confirmed ${data.confirmed} order${data.confirmed !== 1 ? 's' : ''}` +
            (data.skipped > 0 ? `, skipped ${data.skipped}` : '') + skippedNote)
    },
    onError: (err) => {
      alert(`Re-confirm failed: ${err?.response?.data?.detail || err?.message || 'Unknown error'}`)
    },
  })

  const forceRefreshAllMutation = useMutation({
    mutationFn: () => projectionConfirmedOrdersApi.forceRefreshAll(periodId, { mapping_tab: mappingTab }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['projection-confirmed-orders', periodId] })
      qc.invalidateQueries({ queryKey: ['orders'] })
      setSelectedForBatch(new Set())
      const reasons = (data.results || [])
        .filter(r => !r.success)
        .slice(0, 5)
        .map(r => `  #${r.order_id}: ${r.error}`)
        .join('\n')
      const tail = data.skipped > 0 && reasons ? '\n\n' + reasons : ''
      const r = data.recompute || {}
      alert(
        `Force refresh complete:\n` +
        `  ${data.reconfirmed} re-confirmed (snapshots refreshed)\n` +
        `  ${data.newly_confirmed} newly confirmed\n` +
        `  ${data.skipped} skipped\n\n` +
        `Operations replan:\n` +
        `  ${r.orders_with_sku_changes || 0} orders with SKU changes\n` +
        `  ${r.orders_replanned_created || 0} plans created, ${r.orders_replanned_repaired || 0} repaired` +
        tail
      )
    },
    onError: (err) => {
      alert(`Force refresh failed: ${err?.response?.data?.detail || err?.message || 'Unknown error'}`)
    },
  })

  const holdTags = useMemo(() => new Set(
    orderRules.filter(r => r.action === 'hold' && r.is_active).map(r => r.tag.toLowerCase())
  ), [orderRules])

  const nonConfirmableCounts = useMemo(() => {
    if (!isProjections) return null
    const stats = { in_shipstation: 0, shipped: 0, on_hold: 0, pending_payment: 0 }
    for (const o of allOrders) {
      const isPending = o.financial_status === 'pending' || o.financial_status === 'partially_paid'
      const tags = (o.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
      const isHeld = o.shopify_hold || tags.some(t => holdTags.has(t))
      if (o.app_status === 'in_shipstation_not_shipped') stats.in_shipstation++
      else if (o.app_status === 'in_shipstation_shipped' || o.app_status === 'fulfilled') stats.shipped++
      else if (isHeld) stats.on_hold++
      else if (isPending) stats.pending_payment++
    }
    return stats
  }, [isProjections, allOrders, holdTags])

  const dnssTags = useMemo(() => new Set(
    orderRules.filter(r => r.action === 'dnss' && r.is_active).map(r => r.tag.toLowerCase())
  ), [orderRules])

  const marginOverrideTags = useMemo(() => new Set(
    orderRules.filter(r => r.action === 'margin_override' && r.is_active).map(r => r.tag.toLowerCase())
  ), [orderRules])

  const allTags = useMemo(() => {
    const s = new Set()
    for (const o of orders) {
      (o.tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => s.add(t))
    }
    return [...s].sort()
  }, [orders])

  const allItems = useMemo(() => {
    const s = new Set()
    for (const o of orders) {
      (o.line_items || []).forEach(li => { if (li.product_title) s.add(li.product_title) })
    }
    return [...s].sort()
  }, [orders])

  const allStates = useMemo(() => {
    const s = new Set()
    for (const o of orders) { if (o.shipping_province) s.add(o.shipping_province) }
    return [...s].sort()
  }, [orders])

  const allStatuses = useMemo(() => {
    const s = new Set()
    for (const o of orders) { if (o.app_status) s.add(o.app_status) }
    return [...s].sort()
  }, [orders])

  const allBoxTypes = useMemo(() => {
    const s = new Set()
    for (const b of ssBoxes) if (b.box_type_name) s.add(b.box_type_name)
    return [...s].sort()
  }, [ssBoxes])

  const allPickSkus = useMemo(() => {
    const s = new Set()
    for (const b of ssBoxes) for (const sku of (b.pick_skus || [])) s.add(sku)
    return [...s].sort()
  }, [ssBoxes])

  const processedBoxes = useMemo(() => {
    if (statusFilter !== 'in_shipstation_not_shipped') return []
    let result = [...ssBoxes]
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(b =>
        (b.shopify_order_number || '').toLowerCase().includes(q) ||
        (b.customer_name || '').toLowerCase().includes(q) ||
        (b.customer_email || '').toLowerCase().includes(q)
      )
    }
    if (tagSearch) {
      const q = tagSearch.toLowerCase()
      result = result.filter(b => (b.tags || '').toLowerCase().includes(q))
    }
    if (ssBoxColFilters.boxType !== null && ssBoxColFilters.boxType.size > 0) {
      result = result.filter(b => ssBoxColFilters.boxType.has(b.box_type_name || ''))
    }
    if (ssBoxColFilters.pickSku !== null && ssBoxColFilters.pickSku.size > 0) {
      result = result.filter(b => (b.pick_skus || []).some(sku => ssBoxColFilters.pickSku.has(sku)))
    }
    result.sort((a, bx) => {
      if (sortCol === 'order_num') {
        const av = a.shopify_order_number || '', bv = bx.shopify_order_number || ''
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      if (sortCol === 'age' || sortCol === 'order_date') {
        const at = a.created_at_shopify ? new Date(a.created_at_shopify).getTime() : 0
        const bt = bx.created_at_shopify ? new Date(bx.created_at_shopify).getTime() : 0
        return sortDir === 'asc' ? at - bt : bt - at
      }
      if (sortCol === 'customer') {
        const av = (a.customer_name || '').toLowerCase(), bv = (bx.customer_name || '').toLowerCase()
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return 0
    })
    return result
  }, [ssBoxes, statusFilter, search, tagSearch, ssBoxColFilters, sortCol, sortDir])

  const pullMutation = useMutation({
    mutationFn: () => ordersApi.pull({ warehouse }),
    onSuccess: () => {
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['orders-archived'])
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || err?.message || 'Unknown error'
      setSyncBanner({ type: 'error', message: `Pull failed: ${detail}` })
      if (syncBannerTimer.current) clearTimeout(syncBannerTimer.current)
      syncBannerTimer.current = setTimeout(() => setSyncBanner(null), 10000)
    },
  })

  const syncSSMutation = useMutation({
    mutationFn: async () => {
      setSyncBanner({ type: 'syncing', message: 'Syncing with ShipStation...' })
      if (syncBannerTimer.current) clearTimeout(syncBannerTimer.current)
      const [ss, ff] = await Promise.all([shipstationApi.sync(), fulfillmentApi.sync()])
      return {
        synced: (ss.synced || 0) + (ff.synced || 0),
        shipped: (ss.shipped || 0) + (ff.shipped || 0),
        shopify_fulfillments: ff.shopify_fulfillments || 0,
        healed: (ss.healed || 0) + (ff.healed || 0),
        errors: [...(ss.errors || []), ...(ff.errors || [])],
      }
    },
    onSuccess: (data) => {
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['in-shipstation-boxes'])
      const parts = []
      if (data.synced) parts.push(`${data.synced} order${data.synced !== 1 ? 's' : ''} synced`)
      if (data.shipped) parts.push(`${data.shipped} shipped`)
      if (data.shopify_fulfillments) parts.push(`${data.shopify_fulfillments} Shopify fulfillment${data.shopify_fulfillments !== 1 ? 's' : ''} created`)
      if (data.healed) parts.push(`${data.healed} stuck order${data.healed !== 1 ? 's' : ''} healed`)
      if (data.errors.length) parts.push(`${data.errors.length} error${data.errors.length !== 1 ? 's' : ''}`)
      const message = parts.length ? parts.join(', ') : 'No new updates from ShipStation'
      setSyncBanner({ type: data.errors.length ? 'error' : 'success', message })
      syncBannerTimer.current = setTimeout(() => setSyncBanner(null), 8000)
    },
    onError: (err) => {
      setSyncBanner({ type: 'error', message: `Sync failed: ${err.message || 'Unknown error'}` })
      syncBannerTimer.current = setTimeout(() => setSyncBanner(null), 10000)
    },
  })

  const stageBatchMutation = useMutation({
    mutationFn: (ids) => ordersApi.stageBatch({ order_ids: ids }),
    onSuccess: (data) => {
      qc.invalidateQueries(['orders'])
      setSelectedForBatch(new Set())
      if (data.failed > 0) alert(`${data.staged} staged, ${data.failed} failed`)
    },
  })

  const unstageBatchMutation = useMutation({
    mutationFn: (ids) => ordersApi.unstageBatch(ids),
    onSuccess: () => {
      qc.invalidateQueries(['orders'])
      setSelectedForBatch(new Set())
    },
  })

  const bulkResetUnpushedMutation = useMutation({
    mutationFn: (order_ids) => fulfillmentApi.bulkResetUnpushedByOrders(order_ids),
    onSuccess: (data) => {
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['plans'])
      setSelectedForBatch(new Set())
      alert(`Reset complete: ${data.deleted} box${data.deleted !== 1 ? 'es' : ''} deleted across ${data.plans_affected} plan${data.plans_affected !== 1 ? 's' : ''}`)
    },
  })

  const checkDupsMutation = useMutation({
    mutationFn: () => shipstationApi.checkDuplicates(),
    onSuccess: (data) => {
      qc.invalidateQueries(['orders'])
      alert(`ShipStation check complete: ${data.duplicates_flagged} new duplicate${data.duplicates_flagged !== 1 ? 's' : ''} found, ${data.duplicates_cleared} cleared (${data.ss_unshipped_count} unshipped orders in ShipStation)`)
    },
    onError: (err) => {
      alert(`Check duplicates failed: ${err?.response?.data?.detail || err?.message || 'Unknown error'}`)
    },
  })

  const autoPlanMutation = useMutation({
    mutationFn: (orderIds) => fulfillmentApi.bulkAutoPlan(orderIds),
    onSuccess: (data) => {
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['plans'])
      const parts = []
      if (data.created > 0) parts.push(`${data.created} plans created`)
      if (data.repaired > 0) parts.push(`${data.repaired} plans repaired`)
      if (data.unmatched_box_type > 0) parts.push(`${data.unmatched_box_type} with no box rule matched`)
      if (data.skipped > 0) parts.push(`${data.skipped} skipped`)
      alert(parts.length ? parts.join(', ') : 'All orders already up to date')
    },
  })

  // ── Bulk cancel ShipStation boxes ──────────────────────────────────────────
  const [cancelSSModal, setCancelSSModal] = useState(null) // { step: 1|2|3, preview: {...} }
  const [cancelConfirmText, setCancelConfirmText] = useState('')

  const bulkCancelSSMutation = useMutation({
    mutationFn: (order_ids) => ordersApi.bulkCancelSSBoxes(order_ids),
    onSuccess: (data) => {
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['plans'])
      qc.invalidateQueries(['inventory'])
      qc.invalidateQueries(['in-shipstation-boxes'])
      setSelectedForBatch(new Set())
      setCancelSSModal(null)
      setCancelConfirmText('')
      const warnings = data.total_warnings > 0 ? ` (${data.total_warnings} ShipStation warnings — check manually)` : ''
      alert(`Cancelled ${data.total_boxes_cancelled} box${data.total_boxes_cancelled !== 1 ? 'es' : ''} across ${data.total_orders} order${data.total_orders !== 1 ? 's' : ''}. Inventory restored.${warnings}`)
    },
    onError: (err) => {
      setCancelSSModal(null)
      setCancelConfirmText('')
      alert(`Cancel failed: ${err.response?.data?.detail || err.message}`)
    },
  })

  async function startBulkCancelSS() {
    const ids = [...selectedForBatch]
    if (ids.length === 0) return
    try {
      const preview = await ordersApi.bulkCancelSSBoxesPreview(ids)
      if (preview.total_boxes === 0) {
        alert('No cancellable ShipStation boxes found for the selected orders.')
        return
      }
      setCancelSSModal({ step: 1, preview, orderIds: ids })
    } catch (err) {
      alert(`Preview failed: ${err.response?.data?.detail || err.message}`)
    }
  }

  const isOrderHeld = (order) => {
    if (order.shopify_hold) return true
    const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
    return tags.some(t => holdTags.has(t))
  }

  const isOrderDNSS = (order) => {
    const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
    return tags.some(t => dnssTags.has(t))
  }

  const isPaymentPending = (order) =>
    order.financial_status === 'pending' || order.financial_status === 'partially_paid'

  const hasPlanBoxIssue = (order) => {
    // "No plan" is only a plan issue if there's something to plan. Orders with
    // nothing to ship (all lines short-shipped) belong in Ship None, not Needs Plan.
    const cat = getShipCategory(order)
    const hasNothingToShip = cat === 'ship_none' || cat === null
    return (order.app_status === 'not_processed' && !order.has_plan && !hasNothingToShip) || (order.has_plan && order.plan_box_unmatched) || order.has_plan_mismatch || order.ss_duplicate
  }

  // Filter + sort
  const processedOrders = useMemo(() => {
    let result = [...orders]

    // Projections mode: only unfulfilled / partially-unfulfilled orders are confirmable.
    // Everything else (fulfilled, shipped, in ShipStation, on hold, pending payment) lives
    // in the non-confirmable info strip, not the main table.
    if (isProjections) {
      result = result.filter(o =>
        o.app_status === 'not_processed' || o.app_status === 'partially_fulfilled'
      )
    }

    if (statusFilter === 'all') {
      result = result.filter(o => o.app_status !== 'fulfilled')
    } else if (statusFilter === 'confirmed') {
      // Projections-only: show orders the user has confirmed for the selected period
      result = result.filter(o => confirmedOrderIds.has(o.shopify_order_id))
    } else if (statusFilter === 'not_processed') {
      result = result.filter(o => o.app_status === 'not_processed')
    } else if (statusFilter === 'needs_plan') {
      result = result.filter(o => {
        if (o.app_status !== 'not_processed' || o.has_plan) return false
        if (isOrderHeld(o)) return false
        const cat = getShipCategory(o)
        if (cat === 'ship_none' || cat === null) return false
        return true
      })
    } else if (statusFilter === 'on_hold') {
      result = result.filter(o => isOrderHeld(o))
    } else if (statusFilter === 'no_box_rule') {
      result = result.filter(o => o.has_plan && o.plan_box_unmatched && !isOrderHeld(o))
    } else if (statusFilter === 'plan_mismatch') {
      result = result.filter(o => o.has_plan_mismatch)
    } else if (statusFilter === 'ss_duplicate') {
      result = result.filter(o => o.ss_duplicate)
    } else if (statusFilter === 'cogs_error') {
      result = result.filter(o => marginsMap[o.shopify_order_id]?.missing_cost_skus?.length > 0)
    } else if (statusFilter === 'pending_payment') {
      result = result.filter(o => isPaymentPending(o))
    } else if (statusFilter === 'inv_hold') {
      result = result.filter(o => {
        if (o.app_status !== 'not_processed') return false
        return (o.line_items || []).some(li => li.app_line_status === 'inventory_hold')
      })
    } else if (statusFilter === 'ship_all' || statusFilter === 'ship_partial' || statusFilter === 'ship_none') {
      result = result.filter(o => {
        const cat = getShipCategory(o)
        const hasInvHold = (o.line_items || []).some(li => li.app_line_status === 'inventory_hold')
        const hasCOGSErr = marginsMap[o.shopify_order_id]?.missing_cost_skus?.length > 0
        const excluded = isOrderHeld(o) || isPaymentPending(o) || hasInvHold || hasPlanBoxIssue(o) || hasCOGSErr ||
          o.app_status === 'staged' ||
          o.app_status === 'in_shipstation_not_shipped' ||
          o.app_status === 'in_shipstation_shipped' ||
          o.app_status === 'fulfilled'
        if (excluded) return false

        // Check margin-based reclassification to ship_none.
        // Threshold tiers: ship_all 30%, ship_partial 40%, ship_partial where
        // more lines are short-shipped than to-fulfill 50% (less ships, so the
        // remaining items must carry more margin).
        const orderTags = (o.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
        const hasMarginOverride = orderTags.some(t => marginOverrideTags.has(t))
        const marginEntry = marginsMap[o.shopify_order_id]
        const hasMarginData = marginEntry !== undefined
        const gmPct = marginEntry?.gm_pct
        const fulfillableRevenue = marginEntry?.fulfillable_revenue ?? 0
        const isMostlyShort = cat === 'ship_partial' && hasMoreShortThanFulfill(o)
        const marginThreshold = isMostlyShort ? 50 : (cat === 'ship_partial' ? 40 : 30)
        const isLowMargin = hasMarginData && !hasMarginOverride && gmPct != null && gmPct < marginThreshold
        const isZeroRevenue = hasMarginData && !hasMarginOverride && (fulfillableRevenue <= 0 || gmPct == null)
        const forceShipNone = isLowMargin || isZeroRevenue

        // DNSS orders with any short-ship lines → always in ship_none bucket
        if (statusFilter === 'ship_none') {
          const hasDNSS = isOrderDNSS(o)
          const hasShortShip = (o.line_items || []).some(li => li.app_line_status === 'short_ship')
          if (hasDNSS && hasShortShip) return true
          // Low margin / $0 revenue orders forced to ship_none
          if (forceShipNone && (cat === 'ship_all' || cat === 'ship_partial')) return true
        }
        // For ship_all/ship_partial: exclude DNSS orders that have short-ship lines
        if (statusFilter !== 'ship_none' && isOrderDNSS(o)) {
          const hasShortShip = (o.line_items || []).some(li => li.app_line_status === 'short_ship')
          if (hasShortShip) return false
        }
        // Exclude orders forced to ship_none from ship_all/ship_partial views
        if (statusFilter !== 'ship_none' && forceShipNone) return false
        return cat === statusFilter
      })
    }

    // Column-level filters
    // Multi-select filters (null = show all)
    if (colFilters.tags !== null && colFilters.tags.size > 0) {
      result = result.filter(o => {
        const orderTags = (o.tags || '').split(',').map(t => t.trim()).filter(Boolean)
        return orderTags.some(t => colFilters.tags.has(t))
      })
    }
    if (colFilters.items !== null && colFilters.items.size > 0) {
      result = result.filter(o =>
        (o.line_items || []).some(li => colFilters.items.has(li.product_title))
      )
    }
    if (colFilters.states !== null && colFilters.states.size > 0) {
      result = result.filter(o => colFilters.states.has(o.shipping_province || ''))
    }
    if (colFilters.statuses !== null && colFilters.statuses.size > 0) {
      result = result.filter(o => colFilters.statuses.has(o.app_status))
    }
    // Range filters
    if (colFilters.age.min !== '') result = result.filter(o => { const a = daysAgo(o.created_at_shopify); return a === null || a >= Number(colFilters.age.min) })
    if (colFilters.age.max !== '') result = result.filter(o => { const a = daysAgo(o.created_at_shopify); return a === null || a <= Number(colFilters.age.max) })
    if (colFilters.total.min !== '') result = result.filter(o => (marginsMap[o.shopify_order_id]?.fulfillable_revenue ?? (o.total_price || 0)) >= Number(colFilters.total.min))
    if (colFilters.total.max !== '') result = result.filter(o => (marginsMap[o.shopify_order_id]?.fulfillable_revenue ?? (o.total_price || 0)) <= Number(colFilters.total.max))
    if (colFilters.gm.min !== '') result = result.filter(o => { const gm = marginsMap[o.shopify_order_id]?.gm_pct; return gm == null || gm >= Number(colFilters.gm.min) })
    if (colFilters.gm.max !== '') result = result.filter(o => { const gm = marginsMap[o.shopify_order_id]?.gm_pct; return gm == null || gm <= Number(colFilters.gm.max) })

    result.sort((a, b) => {
      let aVal, bVal
      if (sortCol === 'order_num') { aVal = a.shopify_order_number || ''; bVal = b.shopify_order_number || '' }
      else if (sortCol === 'age' || sortCol === 'order_date') {
        aVal = a.created_at_shopify ? new Date(a.created_at_shopify).getTime() : 0
        bVal = b.created_at_shopify ? new Date(b.created_at_shopify).getTime() : 0
      }
      else if (sortCol === 'total') { aVal = marginsMap[a.shopify_order_id]?.fulfillable_revenue ?? (a.total_price || 0); bVal = marginsMap[b.shopify_order_id]?.fulfillable_revenue ?? (b.total_price || 0) }
      else if (sortCol === 'customer') { aVal = (a.customer_name || '').toLowerCase(); bVal = (b.customer_name || '').toLowerCase() }
      else if (sortCol === 'gm') {
        const aEntry = marginsMap[a.shopify_order_id]
        const bEntry = marginsMap[b.shopify_order_id]
        const aGm = (!aEntry?.missing_cost_skus?.length && aEntry?.gm_pct != null) ? aEntry.gm_pct : null
        const bGm = (!bEntry?.missing_cost_skus?.length && bEntry?.gm_pct != null) ? bEntry.gm_pct : null
        // nulls always sort last
        if (aGm == null && bGm == null) return 0
        if (aGm == null) return 1
        if (bGm == null) return -1
        return sortDir === 'asc' ? aGm - bGm : bGm - aGm
      }
      else return 0
      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return result
  }, [orders, statusFilter, sortCol, sortDir, holdTags, dnssTags, marginsMap, colFilters, isProjections, confirmedOrderIds])

  const selectedOrder = selectedOrderId ? orders.find(o => o.shopify_order_id === selectedOrderId) : null
  const selectedOrderIdx = selectedOrderId ? processedOrders.findIndex(o => o.shopify_order_id === selectedOrderId) : -1

  useEffect(() => {
    if (!selectedOrderId) return
    const handleKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
      if (e.key === 'ArrowLeft' && selectedOrderIdx > 0) {
        setSelectedOrderId(processedOrders[selectedOrderIdx - 1].shopify_order_id)
      } else if (e.key === 'ArrowRight' && selectedOrderIdx < processedOrders.length - 1) {
        setSelectedOrderId(processedOrders[selectedOrderIdx + 1].shopify_order_id)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [selectedOrderId, selectedOrderIdx, processedOrders])

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  function toggleBatch(orderId) {
    setSelectedForBatch(s => {
      const n = new Set(s)
      if (n.has(orderId)) n.delete(orderId)
      else n.add(orderId)
      return n
    })
  }

  function selectAllVisible() {
    if (statusFilter === 'in_shipstation_not_shipped') {
      setSelectedForBatch(new Set(processedBoxes.map(b => b.shopify_order_id)))
    } else {
      const ids = processedOrders
        .filter(o => !isPaymentPending(o))
        .map(o => o.shopify_order_id)
      setSelectedForBatch(new Set(ids))
    }
  }

  const selectableCount = statusFilter === 'in_shipstation_not_shipped'
    ? new Set(processedBoxes.map(b => b.shopify_order_id)).size
    : processedOrders.filter(o => !isPaymentPending(o)).length

  // Errors that block staging/shipping. Add new error types to this list.
  const errorAlerts = useMemo(() => {
    const alerts = []
    let cogsCount = 0
    for (const o of allOrders) {
      if (o.app_status === 'fulfilled') continue
      if (allMarginsMap[o.shopify_order_id]?.missing_cost_skus?.length > 0) cogsCount++
    }
    if (cogsCount > 0) {
      alerts.push({
        key: 'cogs_error',
        label: `${cogsCount} order${cogsCount === 1 ? '' : 's'} have missing COGS data`,
        actionLabel: 'Fix SKUs →',
        onAction: () => navigate('/picklist-skus?filter=missing-cogs'),
        onView: () => setStatusFilter('cogs_error'),
      })
    }
    return alerts
  }, [allOrders, allMarginsMap, navigate])


  return (
    <div className="ss-orders-layout">
      {/* Left status sidebar */}
      <StatusSidebar
        orders={allOrders}
        statusFilter={statusFilter}
        setStatusFilter={(f) => { setStatusFilter(f); setSelectedOrderId(null) }}
        holdTags={holdTags}
        dnssTags={dnssTags}
        marginOverrideTags={marginOverrideTags}
        archivedCount={archivedOrders.length}
        marginsMap={allMarginsMap}
        mode={mode}
        confirmedCount={confirmedOrderIds.size}
      />

      {/* Main content */}
      <div className="ss-orders-main">
        {errorAlerts.length > 0 && (
          <div className="orders-error-alerts">
            {errorAlerts.map(a => (
              <div key={a.key} className="orders-error-alert">
                <span className="orders-error-alert-icon">⚠</span>
                <span className="orders-error-alert-label">{a.label}</span>
                <div className="orders-error-alert-actions">
                  <button className="orders-error-alert-link" onClick={a.onView}>View orders</button>
                  <button className="btn btn-danger" style={{ fontSize: 12, padding: '4px 10px' }} onClick={a.onAction}>{a.actionLabel}</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Top action bar */}
        <div className="ss-action-bar">
          <div className="ss-action-bar-left">
            {!isProjections && (
              <>
                <button
                  className="btn btn-primary"
                  onClick={() => pullMutation.mutate()}
                  disabled={pullMutation.isPending || !shopifyStatus?.connected}
                >
                  {pullMutation.isPending ? 'Pulling…' : '↓ Pull Shopify'}
                </button>
                {ssStatus?.configured && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => syncSSMutation.mutate()}
                    disabled={syncSSMutation.isPending}
                  >
                    {syncSSMutation.isPending ? 'Syncing…' : '↺ Sync ShipStation'}
                  </button>
                )}
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    const ids = selectedForBatch.size > 0
                      ? [...selectedForBatch]
                      : processedOrders.map(o => o.shopify_order_id)
                    if (ids.length === 0) return
                    autoPlanMutation.mutate(ids)
                  }}
                  disabled={autoPlanMutation.isPending || processedOrders.length === 0}
                  title={selectedForBatch.size > 0
                    ? `Auto-plan ${selectedForBatch.size} selected order${selectedForBatch.size !== 1 ? 's' : ''}`
                    : `Auto-plan all ${processedOrders.length} orders in current view`}
                >
                  {autoPlanMutation.isPending
                    ? 'Planning…'
                    : selectedForBatch.size > 0
                      ? `⚙ Auto Plan (${selectedForBatch.size})`
                      : `⚙ Auto Plan (${processedOrders.length})`}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    const ids = processedOrders.map(o => o.shopify_order_id)
                    if (ids.length === 0) return
                    if (confirm(`Reset unpushed boxes for all ${ids.length} filtered order${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) {
                      bulkResetUnpushedMutation.mutate(ids)
                    }
                  }}
                  disabled={bulkResetUnpushedMutation.isPending || processedOrders.length === 0}
                  title="Delete all unpushed (pending) boxes across all currently filtered orders"
                >
                  {bulkResetUnpushedMutation.isPending ? 'Resetting…' : `↺ Reset Filtered (${processedOrders.length})`}
                </button>
                {statusFilter === 'ss_duplicate' && ssStatus?.configured && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => checkDupsMutation.mutate()}
                    disabled={checkDupsMutation.isPending}
                    title="Pull unshipped orders from ShipStation and flag duplicates"
                  >
                    {checkDupsMutation.isPending ? 'Checking…' : '↺ Check SS Duplicates'}
                  </button>
                )}
                {(statusFilter === 'ship_all' || statusFilter === 'ship_partial') && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => stageBatchMutation.mutate([...selectedForBatch])}
                    disabled={stageBatchMutation.isPending || selectedForBatch.size === 0}
                    title={selectedForBatch.size === 0 ? 'Select orders with checkboxes to stage' : `Stage ${selectedForBatch.size} selected order${selectedForBatch.size !== 1 ? 's' : ''}`}
                  >
                    {stageBatchMutation.isPending ? 'Staging…' : `▶ Stage Selected${selectedForBatch.size > 0 ? ` (${selectedForBatch.size})` : ''}`}
                  </button>
                )}
                {statusFilter === 'staged' && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      if (selectedForBatch.size === 0) return
                      if (confirm(`Remove ${selectedForBatch.size} order${selectedForBatch.size !== 1 ? 's' : ''} from staged?`)) {
                        unstageBatchMutation.mutate([...selectedForBatch])
                      }
                    }}
                    disabled={unstageBatchMutation.isPending || selectedForBatch.size === 0}
                    title={selectedForBatch.size === 0 ? 'Select orders with checkboxes to remove from staged' : `Remove ${selectedForBatch.size} selected order${selectedForBatch.size !== 1 ? 's' : ''} from staged`}
                  >
                    {unstageBatchMutation.isPending ? 'Removing…' : `✕ Remove Selected${selectedForBatch.size > 0 ? ` (${selectedForBatch.size})` : ''}`}
                  </button>
                )}
                {statusFilter === 'in_shipstation_not_shipped' && (
                  <button
                    className="btn btn-danger"
                    onClick={startBulkCancelSS}
                    disabled={bulkCancelSSMutation.isPending || selectedForBatch.size === 0}
                    title={selectedForBatch.size === 0
                      ? 'Select orders with checkboxes to cancel their ShipStation boxes'
                      : `Cancel ShipStation boxes for ${selectedForBatch.size} selected order${selectedForBatch.size !== 1 ? 's' : ''}`}
                  >
                    {bulkCancelSSMutation.isPending
                      ? 'Cancelling…'
                      : `✕ Cancel ShipStation${selectedForBatch.size > 0 ? ` (${selectedForBatch.size})` : ''}`}
                  </button>
                )}
              </>
            )}
            {isProjections && (
              <>
                <select
                  value={periodId || ''}
                  onChange={e => onPeriodChange?.(e.target.value ? Number(e.target.value) : null)}
                  style={{ padding: '7px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 180 }}
                  title="Select projection period"
                >
                  <option value="">— Select period —</option>
                  {projectionPeriods.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <select
                  value={mappingTab || ''}
                  onChange={e => onMappingChange?.(e.target.value)}
                  style={{ padding: '7px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 220 }}
                  title="SKU mapping tab (required before confirming)"
                  disabled={!periodId}
                >
                  <option value="">— Select SKU mapping —</option>
                  {sheetsTabs.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                {(statusFilter === 'ship_all' || statusFilter === 'ship_partial' || statusFilter === 'ship_none') && (
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      const ids = [...selectedForBatch]
                      // Find any already-confirmed order whose mapping_used
                      // differs from the currently-selected tab. Show the
                      // safety modal before overwriting.
                      const confirmedById = new Map(confirmedOrders.map(c => [c.shopify_order_id, c]))
                      const conflicts = ids
                        .map(oid => {
                          const c = confirmedById.get(oid)
                          if (!c || c.mapping_used === mappingTab) return null
                          const ord = orders.find(o => o.shopify_order_id === oid)
                          return {
                            shopify_order_id: oid,
                            order_number: ord?.shopify_order_number || oid,
                            original_tab: c.mapping_used,
                          }
                        })
                        .filter(Boolean)
                      if (conflicts.length > 0) {
                        setReconfirmModal({ conflicts, allIds: ids })
                      } else {
                        confirmMutation.mutate(ids)
                      }
                    }}
                    disabled={
                      confirmMutation.isPending ||
                      selectedForBatch.size === 0 ||
                      !periodId ||
                      !mappingTab
                    }
                    title={
                      !periodId ? 'Select a projection period first'
                      : !mappingTab ? 'Select a SKU mapping first'
                      : selectedForBatch.size === 0 ? 'Select orders with checkboxes to confirm'
                      : `Confirm demand for ${selectedForBatch.size} order${selectedForBatch.size !== 1 ? 's' : ''}`
                    }
                  >
                    {confirmMutation.isPending
                      ? 'Confirming…'
                      : `✓ Confirm Selected${selectedForBatch.size > 0 ? ` (${selectedForBatch.size})` : ''}`}
                  </button>
                )}
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    if (!confirm(`Re-confirm every eligible order in this period using "${mappingTab}"? Already-confirmed orders are skipped — this only re-snapshots the unconfirmed ones (e.g. those just kicked back by a CD short-ship/hold change).`)) return
                    reConfirmAllMutation.mutate()
                  }}
                  disabled={
                    reConfirmAllMutation.isPending ||
                    !periodId ||
                    !mappingTab
                  }
                  title={
                    !periodId ? 'Select a projection period first'
                    : !mappingTab ? 'Select a SKU mapping first'
                    : 'Bulk-confirm every eligible-but-unconfirmed order using the period\'s current short-ship/hold + mapping config'
                  }
                >
                  {reConfirmAllMutation.isPending ? 'Re-confirming…' : '↻ Re-confirm All'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    if (!confirm(
                      `Force refresh EVERY eligible order in this period?\n\n` +
                      `This will:\n` +
                      `  • Re-resolve pick SKUs against the latest mapping\n` +
                      `  • Replan operations boxes\n` +
                      `  • Re-confirm already-confirmed orders (using each order's stored mapping)\n` +
                      `  • Confirm still-unconfirmed eligibles using "${mappingTab}"\n\n` +
                      `Use after a SKU mapping or short-ship/hold change to clean up stuck orders.`
                    )) return
                    forceRefreshAllMutation.mutate()
                  }}
                  disabled={
                    forceRefreshAllMutation.isPending ||
                    !periodId ||
                    !mappingTab
                  }
                  title={
                    !periodId ? 'Select a projection period first'
                    : !mappingTab ? 'Select a SKU mapping first'
                    : 'Recompute pick SKUs, replan boxes, and (re-)confirm every eligible order in this period using the latest config'
                  }
                >
                  {forceRefreshAllMutation.isPending ? 'Refreshing…' : '⟳ Force Refresh All'}
                </button>
                {statusFilter === 'confirmed' && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      if (selectedForBatch.size === 0) return
                      if (confirm(`Unconfirm ${selectedForBatch.size} order${selectedForBatch.size !== 1 ? 's' : ''} from this period?`)) {
                        unconfirmMutation.mutate([...selectedForBatch])
                      }
                    }}
                    disabled={unconfirmMutation.isPending || selectedForBatch.size === 0}
                  >
                    {unconfirmMutation.isPending ? 'Removing…' : `✕ Unconfirm Selected${selectedForBatch.size > 0 ? ` (${selectedForBatch.size})` : ''}`}
                  </button>
                )}
              </>
            )}
            <button
              className="btn btn-secondary"
              onClick={() => {
                const toExport = statusFilter === 'archived' ? archivedOrders : processedOrders
                if (toExport.length === 0) return
                exportOrdersCsv(toExport, marginsMap, statusFilter || 'all')
              }}
              disabled={statusFilter === 'archived' ? archivedOrders.length === 0 : processedOrders.length === 0}
              title="Export currently visible orders to CSV"
            >
              ↓ Export CSV
            </button>
            {!isProjections && (
              <select
                value={warehouse}
                onChange={e => setWarehouse(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13, background: '#fff' }}
              >
                {WAREHOUSES.map(w => <option key={w} value={w}>{w.charAt(0).toUpperCase() + w.slice(1)}</option>)}
              </select>
            )}
          </div>
          <div className="ss-action-bar-right">
            {selectedForBatch.size > 0 && (
              <>
                <span style={{ fontSize: 13, color: '#6b7280' }}>{selectedForBatch.size} selected</span>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    if (confirm(`Reset unpushed boxes for ${selectedForBatch.size} selected order${selectedForBatch.size !== 1 ? 's' : ''}? This cannot be undone.`)) {
                      bulkResetUnpushedMutation.mutate([...selectedForBatch])
                    }
                  }}
                  disabled={bulkResetUnpushedMutation.isPending}
                >
                  {bulkResetUnpushedMutation.isPending ? 'Resetting…' : 'Reset Unpushed'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedForBatch(new Set())}>Clear</button>
              </>
            )}
          </div>
        </div>

        {/* Banners */}
        {shopifyStatus && !shopifyStatus.connected && (
          <div className="setup-banner" style={{ margin: '0 0 12px' }}>
            Shopify not connected.{' '}
            <a href="/api/shopify/connect">Connect Shopify →</a>
          </div>
        )}
        {pullMutation.isSuccess && (
          <div className="success-banner">
            ✓ Pulled {pullMutation.data?.orders_pulled} orders — {pullMutation.data?.created} new, {pullMutation.data?.updated} updated
            {pullMutation.data?.auto_archived > 0 && `, ${pullMutation.data.auto_archived} auto-archived`}
          </div>
        )}
        {syncBanner && (
          <div className={`sync-status-banner sync-status-${syncBanner.type}`}>
            <span>
              {syncBanner.type === 'syncing' && <span className="sync-spinner" />}
              {syncBanner.type === 'success' && '✓ '}
              {syncBanner.type === 'error' && '✗ '}
              {syncBanner.message}
            </span>
            {syncBanner.type !== 'syncing' && (
              <button className="sync-banner-dismiss" onClick={() => { setSyncBanner(null); if (syncBannerTimer.current) clearTimeout(syncBannerTimer.current) }}>×</button>
            )}
          </div>
        )}

        {/* Non-confirmable info strip (projections mode) */}
        {isProjections && nonConfirmableCounts && (
          <div style={{
            padding: '8px 12px', margin: '0 0 10px', background: '#f9fafb',
            border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, color: '#6b7280',
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <strong style={{ color: '#374151' }}>Not confirmable:</strong>
            <span>{nonConfirmableCounts.in_shipstation} In ShipStation</span>
            <span>·</span>
            <span>{nonConfirmableCounts.shipped} Shipped</span>
            <span>·</span>
            <span>{nonConfirmableCounts.on_hold} On Hold</span>
            <span>·</span>
            <span>{nonConfirmableCounts.pending_payment} Pending Payment</span>
          </div>
        )}

        {/* Search bar */}
        <div className="ss-search-bar">
          <input
            type="text"
            placeholder="Search order #, customer…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="ss-search-input"
          />
          <input
            type="text"
            placeholder="Filter by tag…"
            value={tagSearch}
            onChange={e => setTagSearch(e.target.value)}
            className="ss-search-input"
            style={{ maxWidth: 160 }}
          />
          <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto' }}>
            {statusFilter === 'archived'
              ? `${archivedOrders.length} orders`
              : statusFilter === 'in_shipstation_not_shipped'
                ? `${processedBoxes.length} box${processedBoxes.length !== 1 ? 'es' : ''}`
                : `${processedOrders.length} orders`}
          </span>
        </div>

        {/* Table */}
        <div className="ss-table-wrap">
          {statusFilter === 'in_shipstation_not_shipped' ? (
            Object.values(ssBoxColFilters).some(v => v !== null) && (
              <div className="col-filter-active-bar">
                <span>Column filters active</span>
                <button onClick={() => setSsBoxColFilters({ boxType: null, pickSku: null })}>✕ Clear all filters</button>
              </div>
            )
          ) : (
            Object.entries(colFilters).some(([k, v]) => {
              if (k === 'age' || k === 'total' || k === 'gm') return v.min !== '' || v.max !== ''
              return v !== null
            }) && (
              <div className="col-filter-active-bar">
                <span>Column filters active</span>
                <button onClick={() => setColFilters({ tags: null, items: null, states: null, statuses: null, age: { min: '', max: '' }, total: { min: '', max: '' }, gm: { min: '', max: '' } })}>✕ Clear all filters</button>
              </div>
            )
          )}
          {statusFilter === 'archived' ? (
            isLoadingArchived ? (
              <div className="loading">Loading archived orders…</div>
            ) : archivedOrders.length === 0 ? (
              <div className="empty">No auto-archived orders yet.</div>
            ) : (
              <table className="ss-table">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Customer</th>
                    <th>Items</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th>Tags</th>
                    <th>Archived</th>
                    <th>Shopify</th>
                  </tr>
                </thead>
                <tbody>
                  {archivedOrders.map(o => (
                    <tr key={o.shopify_order_id}>
                      <td style={{ fontWeight: 500 }}>{o.shopify_order_number || o.shopify_order_id}</td>
                      <td>{o.customer_name || o.customer_email || '—'}</td>
                      <td style={{ color: '#6b7280', fontSize: 12 }}>{o.line_items_summary || '—'}</td>
                      <td style={{ textAlign: 'right' }}>${(o.total_price || 0).toFixed(2)}</td>
                      <td style={{ fontSize: 11 }}>
                        {(o.tags || '').split(',').filter(t => t.trim()).map(t => (
                          <span key={t} className="tag-chip" style={{ marginRight: 2 }}>{t.trim()}</span>
                        ))}
                      </td>
                      <td style={{ color: '#9ca3af', fontSize: 12 }}>
                        {o.archived_at ? new Date(o.archived_at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' }) : '—'}
                      </td>
                      <td>
                        {o.shopify_archived
                          ? <span style={{ color: '#10b981', fontSize: 12 }}>✓ Closed</span>
                          : <span style={{ color: '#ef4444', fontSize: 12 }}>✗ Failed</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : statusFilter === 'in_shipstation_not_shipped' ? (
            isLoadingBoxes ? (
              <div className="loading">Loading boxes…</div>
            ) : processedBoxes.length === 0 ? (
              <div className="empty">No boxes in ShipStation.</div>
            ) : (
              <table className="ss-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        onChange={e => e.target.checked ? selectAllVisible() : setSelectedForBatch(new Set())}
                        checked={selectableCount > 0 && selectedForBatch.size === selectableCount}
                      />
                    </th>
                    <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="order_num">Order #</SortTh>
                    <th>Box #</th>
                    <th>Box Type <ColumnFilter type="select" label="Box Type" options={allBoxTypes} value={ssBoxColFilters.boxType} onChange={v => setSsBoxCF('boxType', v)} /></th>
                    <th>Pick SKUs <ColumnFilter type="select" label="Pick SKU" options={allPickSkus} value={ssBoxColFilters.pickSku} onChange={v => setSsBoxCF('pickSku', v)} /></th>
                    <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="age">Age</SortTh>
                    <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="order_date">Order Date</SortTh>
                    <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="customer">Recipient</SortTh>
                    <th>Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {processedBoxes.map(box => (
                    <tr
                      key={box.box_id}
                      className={selectedForBatch.has(box.shopify_order_id) ? 'selected' : ''}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSelectedOrderId(selectedOrderId === box.shopify_order_id ? null : box.shopify_order_id)}
                    >
                      <td onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedForBatch.has(box.shopify_order_id)}
                          onChange={() => toggleBatch(box.shopify_order_id)}
                        />
                      </td>
                      <td style={{ fontWeight: 500 }}>{box.shopify_order_number || box.shopify_order_id}</td>
                      <td style={{ color: '#6b7280' }}>Box {box.box_number}</td>
                      <td>{box.box_type_name || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                      <td style={{ fontSize: 12 }}>{(box.pick_skus || []).join(', ') || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                      <td>{daysAgo(box.created_at_shopify) ?? '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{box.created_at_shopify ? new Date(box.created_at_shopify).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : '—'}</td>
                      <td>{box.customer_name || box.customer_email || '—'}</td>
                      <td style={{ fontSize: 11 }}>
                        {(box.tags || '').split(',').filter(t => t.trim()).map(t => (
                          <span key={t} className="tag-chip" style={{ marginRight: 2 }}>{t.trim()}</span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : isLoading ? (
            <div className="loading">Loading orders…</div>
          ) : processedOrders.length === 0 ? (
            <div className="empty">
              No orders.{' '}
              {shopifyStatus?.connected && (
                <button className="btn-link" onClick={() => pullMutation.mutate()}>Pull from Shopify</button>
              )}
            </div>
          ) : (
            <table className="ss-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      onChange={e => e.target.checked ? selectAllVisible() : setSelectedForBatch(new Set())}
                      checked={selectableCount > 0 && selectedForBatch.size === selectableCount}
                    />
                  </th>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="order_num">Order #</SortTh>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="age" filterEl={
                    <ColumnFilter type="range" label="Age (days)" options={null} value={colFilters.age} onChange={v => setCF('age', v)} />
                  }>Age</SortTh>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="order_date">Order Date</SortTh>
                  <th>Tags <ColumnFilter type="select" label="Tags" options={allTags} value={colFilters.tags} onChange={v => setCF('tags', v)} /></th>
                  <th>Item Name <ColumnFilter type="select" label="Item" options={allItems} value={colFilters.items} onChange={v => setCF('items', v)} /></th>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="customer">Recipient <ColumnFilter type="select" label="State" options={allStates} value={colFilters.states} onChange={v => setCF('states', v)} /></SortTh>
                  <th>Qty</th>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="total" style={{ textAlign: 'right' }} filterEl={
                    <ColumnFilter type="range" label="Total ($)" options={null} value={colFilters.total} onChange={v => setCF('total', v)} />
                  }>Total</SortTh>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="gm" style={{ textAlign: 'right' }} filterEl={
                    <ColumnFilter type="range" label="GM%" options={null} value={colFilters.gm} onChange={v => setCF('gm', v)} />
                  }>GM%</SortTh>
                  <th>Status <ColumnFilter type="select" label="Status" options={allStatuses} value={colFilters.statuses} onChange={v => setCF('statuses', v)} /></th>
                </tr>
              </thead>
              <tbody>
                {processedOrders.map(order => {
                  const confirmed = isProjections
                    ? confirmedOrders.find(c => c.shopify_order_id === order.shopify_order_id)
                    : null
                  return (
                    <OrderRow
                      key={order.shopify_order_id}
                      order={order}
                      isSelected={selectedOrderId === order.shopify_order_id || selectedForBatch.has(order.shopify_order_id)}
                      isChecked={selectedForBatch.has(order.shopify_order_id)}
                      onClick={() => setSelectedOrderId(
                        selectedOrderId === order.shopify_order_id ? null : order.shopify_order_id
                      )}
                      onCheck={() => toggleBatch(order.shopify_order_id)}
                      holdTags={holdTags}
                      grossMarginPct={marginsMap[order.shopify_order_id]?.gm_pct ?? null}
                      missingCostSkus={marginsMap[order.shopify_order_id]?.missing_cost_skus ?? []}
                      fulfillableRevenue={marginsMap[order.shopify_order_id]?.fulfillable_revenue ?? null}
                      mappingUsed={confirmed?.mapping_used || null}
                      currentMappingTab={isProjections ? mappingTab : null}
                    />
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Right detail panel */}
      {selectedOrder && (
        <OrderDetailPanel
          order={selectedOrder}
          onClose={() => setSelectedOrderId(null)}
          onPrev={() => selectedOrderIdx > 0 && setSelectedOrderId(processedOrders[selectedOrderIdx - 1].shopify_order_id)}
          onNext={() => selectedOrderIdx < processedOrders.length - 1 && setSelectedOrderId(processedOrders[selectedOrderIdx + 1].shopify_order_id)}
          hasPrev={selectedOrderIdx > 0}
          hasNext={selectedOrderIdx < processedOrders.length - 1}
          holdTags={holdTags}
          ssConfigured={ssStatus?.configured}
          previewMappingTab={previewTab}
          previewPeriodId={previewPeriodId}
        />
      )}

      {/* Re-confirm safety guard modal: shown when user is about to overwrite
          one or more confirmed-order snapshots with a different mapping tab. */}
      {reconfirmModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setReconfirmModal(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 560, width: '92%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 8px', color: '#92400e' }}>Mapping mismatch on confirmed orders</h3>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#374151' }}>
              {reconfirmModal.conflicts.length} of the {reconfirmModal.allIds.length} selected order{reconfirmModal.allIds.length !== 1 ? 's' : ''} {reconfirmModal.conflicts.length === 1 ? 'is' : 'are'} already confirmed under a different mapping. Re-confirming will overwrite their stored snapshot{reconfirmModal.conflicts.length !== 1 ? 's' : ''}.
            </p>
            <div style={{ maxHeight: 220, overflowY: 'auto', margin: '8px 0 12px', fontSize: 12, color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, padding: 8, background: '#f9fafb' }}>
              {reconfirmModal.conflicts.map(c => (
                <div key={c.shopify_order_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                  <span>#{(c.order_number || '').toString().replace(/^#/, '')}</span>
                  <span style={{ color: '#6b7280' }}>
                    confirmed under <strong style={{ color: '#92400e' }}>{c.original_tab || '(none)'}</strong>
                  </span>
                </div>
              ))}
            </div>
            <p style={{ margin: '4px 0 16px', fontSize: 12, color: '#6b7280' }}>
              Currently selected: <strong>{mappingTab}</strong>
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setReconfirmModal(null)}>
                Cancel
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  const conflictIds = new Set(reconfirmModal.conflicts.map(c => c.shopify_order_id))
                  const safeIds = reconfirmModal.allIds.filter(id => !conflictIds.has(id))
                  setReconfirmModal(null)
                  if (safeIds.length > 0) confirmMutation.mutate(safeIds)
                }}
              >
                Skip already-confirmed ({reconfirmModal.allIds.length - reconfirmModal.conflicts.length})
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const ids = reconfirmModal.allIds
                  setReconfirmModal(null)
                  confirmMutation.mutate(ids)
                }}
              >
                Overwrite with {mappingTab}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Triple-confirm modal for bulk cancel ShipStation boxes */}
      {cancelSSModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => { setCancelSSModal(null); setCancelConfirmText('') }}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 28, maxWidth: 480, width: '90%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          }} onClick={e => e.stopPropagation()}>

            {cancelSSModal.step === 1 && (
              <>
                <h3 style={{ margin: '0 0 12px', color: '#dc2626' }}>Cancel ShipStation Boxes</h3>
                <p style={{ margin: '0 0 8px', fontSize: 14, color: '#374151' }}>
                  You are about to cancel <strong>{cancelSSModal.preview.total_boxes} box{cancelSSModal.preview.total_boxes !== 1 ? 'es' : ''}</strong> across <strong>{cancelSSModal.preview.total_orders} order{cancelSSModal.preview.total_orders !== 1 ? 's' : ''}</strong> in ShipStation.
                </p>
                <div style={{ maxHeight: 180, overflowY: 'auto', margin: '12px 0', fontSize: 13, color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 6, padding: 8 }}>
                  {cancelSSModal.preview.orders.map(o => (
                    <div key={o.shopify_order_id}>#{o.order_number?.toString().replace(/^#/, '')} — {o.cancellable_boxes} box{o.cancellable_boxes !== 1 ? 'es' : ''}</div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="btn btn-secondary" onClick={() => { setCancelSSModal(null); setCancelConfirmText('') }}>No, go back</button>
                  <button className="btn btn-danger" onClick={() => setCancelSSModal(m => ({ ...m, step: 2 }))}>Yes, continue</button>
                </div>
              </>
            )}

            {cancelSSModal.step === 2 && (
              <>
                <h3 style={{ margin: '0 0 12px', color: '#dc2626' }}>Are you absolutely sure?</h3>
                <p style={{ margin: '0 0 4px', fontSize: 14, color: '#374151' }}>
                  This will:
                </p>
                <ul style={{ margin: '4px 0 12px', fontSize: 13, color: '#374151', paddingLeft: 20 }}>
                  <li>Void {cancelSSModal.preview.total_boxes} box{cancelSSModal.preview.total_boxes !== 1 ? 'es' : ''} in ShipStation</li>
                  <li>Mark them as cancelled in the app</li>
                  <li>Restore allocated inventory back to available stock</li>
                  <li>Recalculate order statuses</li>
                </ul>
                <p style={{ margin: '0 0 0', fontSize: 13, color: '#9ca3af' }}>
                  Already-shipped and pending boxes will not be affected.
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="btn btn-secondary" onClick={() => setCancelSSModal(m => ({ ...m, step: 1 }))}>Go back</button>
                  <button className="btn btn-danger" onClick={() => setCancelSSModal(m => ({ ...m, step: 3 }))}>Yes, I'm sure</button>
                </div>
              </>
            )}

            {cancelSSModal.step === 3 && (
              <>
                <h3 style={{ margin: '0 0 12px', color: '#dc2626' }}>Final confirmation</h3>
                <p style={{ margin: '0 0 12px', fontSize: 14, color: '#374151' }}>
                  Type <strong>CANCEL</strong> below to confirm cancellation of {cancelSSModal.preview.total_boxes} ShipStation box{cancelSSModal.preview.total_boxes !== 1 ? 'es' : ''}.
                </p>
                <input
                  type="text"
                  value={cancelConfirmText}
                  onChange={e => setCancelConfirmText(e.target.value)}
                  placeholder='Type "CANCEL" to confirm'
                  autoFocus
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="btn btn-secondary" onClick={() => { setCancelSSModal(null); setCancelConfirmText('') }}>Abort</button>
                  <button
                    className="btn btn-danger"
                    disabled={cancelConfirmText !== 'CANCEL' || bulkCancelSSMutation.isPending}
                    onClick={() => bulkCancelSSMutation.mutate(cancelSSModal.orderIds)}
                  >
                    {bulkCancelSSMutation.isPending ? 'Cancelling…' : 'Confirm Cancel'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
