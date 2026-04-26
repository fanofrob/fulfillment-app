/**
 * Shared Order Detail Panel and sub-components.
 * Used by both Orders.jsx and StagingDashboard.jsx.
 */
import { useState, useMemo, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ordersApi, shipstationApi, fulfillmentApi, boxTypesApi } from '../api'
import { findService } from '../shipstationServices'

// ── Constants ──────────────────────────────────────────────────────────────────

export const STATUS_BADGE = {
  not_processed:              { label: 'Awaiting Staging',     cls: 'badge-not-processed' },
  staged:                     { label: 'Staged',               cls: 'badge-staged' },
  in_shipstation_not_shipped: { label: 'In ShipStation',       cls: 'badge-ss-pending' },
  in_shipstation_shipped:     { label: 'Shipped',              cls: 'badge-ss-shipped' },
  fulfilled:                  { label: 'Fulfilled',            cls: 'badge-fulfilled' },
  partially_fulfilled:        { label: 'Partially Fulfilled',  cls: 'badge-partial' },
}

// ── Pactor helpers ─────────────────────────────────────────────────────────────

export function calcLinePactor(li, pactorMap) {
  if (!li.pick_sku || !pactorMap) return null
  const p = pactorMap[li.pick_sku]
  if (p == null) return null
  const qty = (li.fulfillable_quantity ?? li.quantity) * (li.mix_quantity ?? 1)
  return p * qty
}

export function calcBoxPactor(box, pactorMap) {
  if (!pactorMap) return null
  let total = 0, found = false
  for (const item of (box.items || [])) {
    const p = pactorMap[item.pick_sku]
    if (p != null) { total += p * item.quantity; found = true }
  }
  return found ? total : null
}

export function calcOrderPactor(lineItems, pactorMap) {
  if (!pactorMap) return null
  let total = 0, found = false
  for (const li of lineItems) {
    const p = calcLinePactor(li, pactorMap)
    if (p != null) { total += p; found = true }
  }
  return found ? total : null
}

export function fmtPactor(val) {
  if (val == null) return '—'
  return val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)
}

// ── Misc helpers ───────────────────────────────────────────────────────────────

export function fmtDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' })
}

export function tagChipClass(tag) {
  const t = tag.toLowerCase()
  if (t === 'hold') return 'tag-chip tag-chip-hold'
  if (t === 'vip') return 'tag-chip tag-chip-vip'
  if (t === 'replacement') return 'tag-chip tag-chip-replacement'
  return 'tag-chip'
}

// ── Items Table ────────────────────────────────────────────────────────────────

export function ItemsTable({ items, pactorMap, orderPactor, showPactorTotal, dimmed, fruitLines, skuWeights, showFulfilledQty, appFulfilledIds }) {
  const fruitMap = useMemo(() => {
    if (!fruitLines?.length) return {}
    const m = {}
    for (const fl of fruitLines) m[fl.pick_sku] = fl
    return m
  }, [fruitLines])

  const hasCogs = !!fruitLines?.length
  const hasWeights = !!(skuWeights && Object.keys(skuWeights).length > 0)

  const groups = useMemo(() => {
    const g = new Map()
    for (const li of items) {
      const key = li.line_item_id ?? li.id
      if (!g.has(key)) g.set(key, [])
      g.get(key).push(li)
    }
    return [...g.values()]
  }, [items])

  const [expandedKeys, setExpandedKeys] = useState(() => new Set())
  function toggleExpand(key) {
    setExpandedKeys(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function _displayQty(li) {
    if (showFulfilledQty) return Math.max(0, (li.quantity || 0) - (li.fulfillable_quantity ?? li.quantity))
    return li.fulfillable_quantity ?? li.quantity
  }
  function _isAppFulfilled(li) {
    if (!appFulfilledIds) return true // no data — assume app
    return appFulfilledIds.has(li.line_item_id)
  }
  function rowWeight(li) {
    const wt = skuWeights?.[li.pick_sku] ?? fruitMap[li.pick_sku]?.weight_lb
    if (wt == null) return null
    return wt * (li.mix_quantity ?? 1) * _displayQty(li)
  }
  function rowCogs(li) { return fruitMap[li.pick_sku]?.line_cost ?? null }
  function rowCostPerLb(li) { return fruitMap[li.pick_sku]?.cost_per_lb ?? null }

  let grandWeight = 0, grandCogs = 0, hasGrandWeight = false
  for (const rows of groups) {
    for (const li of rows) {
      const w = rowWeight(li); if (w != null) { grandWeight += w; hasGrandWeight = true }
      const c = rowCogs(li); if (c != null) grandCogs += c
    }
  }

  const showExtraCols = hasWeights || hasCogs

  return (
    <table className="ss-items-table" style={dimmed ? { opacity: 0.55 } : undefined}>
      <thead>
        <tr>
          <th>Item</th>
          <th>Pick SKU</th>
          <th style={{ textAlign: 'right' }}>Qty</th>
          <th style={{ textAlign: 'right' }}>Price</th>
          <th style={{ textAlign: 'right' }}>Pactor</th>
          {showExtraCols && <th style={{ textAlign: 'right' }}>Pick wt</th>}
          {hasCogs && <th style={{ textAlign: 'right' }}>COGS</th>}
        </tr>
      </thead>
      <tbody>
        {groups.map(rows => {
          const rep = rows[0]
          const isMulti = rows.length > 1
          const key = rep.line_item_id ?? rep.id
          const isExpanded = expandedKeys.has(key)

          let grpPactor = 0, anyPactor = false
          let grpWeight = 0, anyWeight = false
          let grpCogs = 0, anyCogs = false
          for (const li of rows) {
            const lp = calcLinePactor(li, pactorMap)
            if (lp != null) { grpPactor += lp; anyPactor = true }
            const w = rowWeight(li)
            if (w != null) { grpWeight += w; anyWeight = true }
            const c = rowCogs(li)
            if (c != null) { grpCogs += c; anyCogs = true }
          }

          return (
            <Fragment key={key}>
              <tr>
                <td>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                    {isMulti && (
                      <button
                        onClick={() => toggleExpand(key)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 9, color: '#9ca3af', marginTop: 3, flexShrink: 0 }}
                      >
                        {isExpanded ? '▼' : '▶'}
                      </button>
                    )}
                    <div>
                      <div style={dimmed ? { textDecoration: 'line-through', color: '#9ca3af' } : undefined}>{rep.product_title}</div>
                      {rep.variant_title && <div style={{ color: '#9ca3af', fontSize: 11 }}>{rep.variant_title}</div>}
                      <div className="mono" style={{ color: '#9ca3af', fontSize: 11 }}>{rep.shopify_sku}</div>
                      {rep.product_type
                        ? <div style={{ fontSize: 10, color: '#6b7280', marginTop: 1 }}>{rep.product_type}</div>
                        : rep.shopify_sku
                          ? <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 1 }} title="No product type set in Shopify catalog — may be a duplicate SKU issue">⚠ no product type</div>
                          : null
                      }
                    </div>
                  </div>
                </td>
                <td>
                  {showFulfilledQty && !_isAppFulfilled(rep)
                    ? <span style={{ color: '#9ca3af', fontSize: 11, fontStyle: 'italic' }}>N/A</span>
                    : isMulti
                      ? <span style={{ color: '#9ca3af', fontSize: 11 }}>{rows.length} pick SKUs</span>
                      : rep.sku_mapped
                        ? <span className="mono" style={{ color: '#16a34a', fontSize: 12 }}>{rep.pick_sku || 'No pick needed'}</span>
                        : <span className="unmapped-badge">UNMAPPED</span>
                  }
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{_displayQty(rep)}</td>
                <td style={{ textAlign: 'right', color: '#6b7280' }}>${(rep.price || 0).toFixed(2)}</td>
                <td style={{ textAlign: 'right' }}>
                  {anyPactor
                    ? <span className="pactor-chip pactor-line">{fmtPactor(grpPactor)}</span>
                    : <span style={{ color: '#d1d5db' }}>—</span>}
                </td>
                {showExtraCols && (
                  <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 11, whiteSpace: 'nowrap' }}>
                    {anyWeight ? `${grpWeight.toFixed(1)} lb` : <span style={{ color: '#d1d5db' }}>—</span>}
                  </td>
                )}
                {hasCogs && (
                  <td style={{ textAlign: 'right', fontSize: 11, whiteSpace: 'nowrap' }}>
                    {showFulfilledQty && !_isAppFulfilled(rep)
                      ? <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>N/A</span>
                      : anyCogs ? `$${grpCogs.toFixed(2)}` : <span style={{ color: '#d1d5db' }}>—</span>}
                  </td>
                )}
              </tr>

              {isMulti && isExpanded && rows.map(li => {
                const lp = calcLinePactor(li, pactorMap)
                const w = rowWeight(li)
                const c = rowCogs(li)
                const cpl = rowCostPerLb(li)
                const pickQty = _displayQty(li) * (li.mix_quantity ?? 1)
                return (
                  <tr key={li.id} style={{ background: '#f9fafb' }}>
                    <td style={{ paddingLeft: 20, color: '#9ca3af', fontSize: 11 }}>↳</td>
                    <td>
                      <span className="mono" style={{ color: '#16a34a', fontSize: 11 }}>{li.pick_sku}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 11, color: '#6b7280' }}>{pickQty % 1 === 0 ? pickQty : pickQty.toFixed(2)}</td>
                    <td />
                    <td style={{ textAlign: 'right' }}>
                      {lp != null
                        ? <span className="pactor-chip pactor-line" style={{ fontSize: 10 }}>{fmtPactor(lp)}</span>
                        : <span style={{ color: '#d1d5db' }}>—</span>}
                    </td>
                    {showExtraCols && (
                      <td style={{ textAlign: 'right', color: '#9ca3af', fontSize: 10 }}>
                        {w != null ? `${w.toFixed(1)} lb` : '—'}
                      </td>
                    )}
                    {hasCogs && (
                      <td style={{ textAlign: 'right', color: '#9ca3af', fontSize: 10 }} title={cpl != null ? `$${cpl.toFixed(4)}/lb` : undefined}>
                        {c != null ? `$${c.toFixed(2)}` : '—'}
                      </td>
                    )}
                  </tr>
                )
              })}
            </Fragment>
          )
        })}
      </tbody>
      <tfoot>
        {showPactorTotal && orderPactor != null && (
          <tr>
            <td colSpan={4} style={{ textAlign: 'right', color: '#9ca3af', fontSize: 11, paddingTop: 6 }}>Total pactor</td>
            <td style={{ textAlign: 'right', paddingTop: 6 }}>
              <span className="pactor-chip pactor-order">{fmtPactor(orderPactor)}</span>
            </td>
            {showExtraCols && <td />}
            {hasCogs && <td />}
          </tr>
        )}
        {(hasGrandWeight || hasCogs) && (
          <tr>
            <td colSpan={4} style={{ textAlign: 'right', color: '#9ca3af', fontSize: 11, paddingTop: 4 }}>Totals</td>
            <td />
            {showExtraCols && (
              <td style={{ textAlign: 'right', color: '#374151', fontSize: 11, fontWeight: 600, paddingTop: 4 }}>
                {hasGrandWeight ? `${grandWeight.toFixed(1)} lb` : '—'}
              </td>
            )}
            {hasCogs && (
              <td style={{ textAlign: 'right', color: '#374151', fontSize: 11, fontWeight: 600, paddingTop: 4 }}>
                ${grandCogs.toFixed(2)}
              </td>
            )}
          </tr>
        )}
      </tfoot>
    </table>
  )
}

// ── GM Row helper ──────────────────────────────────────────────────────────────

function GmRow({ label, value, bold, red, note }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 12 }}>
      <span style={{ color: '#6b7280', fontWeight: bold ? 700 : 400 }}>{label}</span>
      {value != null
        ? <span style={{ fontWeight: bold ? 700 : 500, color: red ? '#dc2626' : bold ? '#111' : '#374151' }}>
            {value < 0 ? '−' : ''}{value < 0 ? `$${Math.abs(value).toFixed(2)}` : `$${value.toFixed(2)}`}
          </span>
        : <span style={{ color: '#d97706', fontStyle: 'italic', fontSize: 11 }}>{note || '—'}</span>
      }
    </div>
  )
}

function GmGroupSection({ title, group, settings, missingCostSkus, showShippingBoxes, style }) {
  const gmColor = gm => gm >= 30 ? '#16a34a' : gm >= 10 ? '#d97706' : '#dc2626'
  return (
    <div style={{ background: '#f9fafb', border: '1px solid #e8e8e8', borderRadius: 6, padding: 12, fontSize: 12, ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, color: '#374151', fontSize: 12 }}>{title}</span>
        {group.gross_margin_pct != null && !missingCostSkus?.length && (
          <span style={{ fontSize: 13, fontWeight: 700, color: gmColor(group.gross_margin_pct) }}>
            {group.gross_margin_pct.toFixed(1)}%
          </span>
        )}
      </div>

      <div style={{ fontWeight: 700, color: '#374151', marginBottom: 6, fontSize: 12 }}>Revenue</div>
      <GmRow label="Line items" value={group.revenue_gross} />
      {group.revenue_discounts > 0 && <GmRow label="Discounts" value={-group.revenue_discounts} red />}
      {group.revenue_shipping > 0 && <GmRow label="Paid shipping" value={group.revenue_shipping} />}
      <GmRow label="Total revenue" value={group.revenue_total} bold />

      <div style={{ fontWeight: 700, color: '#374151', marginTop: 10, marginBottom: 6, fontSize: 12 }}>COGS</div>
      <GmRow label="Fruit / SKU cost" value={group.cogs_fruit} />
      {missingCostSkus?.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 4, padding: '4px 8px', margin: '4px 0', fontSize: 11, color: '#92400e' }}>
          ⚠ Missing COGS — update SKU cost for: <strong>{missingCostSkus.join(', ')}</strong>
        </div>
      )}
      {showShippingBoxes && group.cogs_shipping != null ? (
        <>
          <GmRow label={`Shipping est. (${group.shipping_boxes?.length || 0} box${(group.shipping_boxes?.length || 0) !== 1 ? 'es' : ''})`} value={group.cogs_shipping} />
          {(group.shipping_boxes || []).map((sb, i) => (
            <div key={sb.box_id || i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0 1px 12px', fontSize: 11, color: '#9ca3af' }}>
              <span>
                Box {sb.box_number}{sb.weight_lb != null && ` · ${sb.weight_lb.toFixed(1)} lb`}{sb.zone != null && ` · Zone ${sb.zone}`}{sb.service && ` · ${sb.service}`}{sb.source === 'snapshot' && ' (saved)'}
              </span>
              <span>{sb.rate != null ? `$${sb.rate.toFixed(2)}` : sb.error || '—'}</span>
            </div>
          ))}
        </>
      ) : showShippingBoxes && group.shipping_missing_reason ? (
        <GmRow label="Shipping est." value={null} note={group.shipping_missing_reason === 'no_plan' ? 'No plan' : group.shipping_missing_reason === 'no_boxes' ? 'No boxes' : 'Unavailable'} />
      ) : null}
      {group.cogs_packaging > 0 && <GmRow label="Packaging" value={group.cogs_packaging} />}
      <GmRow label={`Replacement (${settings?.replacement_pct ?? '?'}%)`} value={group.cogs_replacement} />
      <GmRow label={`Refund (${settings?.refund_pct ?? '?'}%)`} value={group.cogs_refund} />
      <GmRow label={`Transaction fee (${settings?.transaction_fee_pct ?? '?'}%)`} value={group.cogs_transaction_fee} />
      {group.cogs_total != null && <GmRow label="Total COGS" value={group.cogs_total} bold />}

      {group.gross_margin_pct != null && !missingCostSkus?.length && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e8e8e8', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, color: '#374151' }}>Gross Margin</span>
          <span style={{ fontWeight: 700, fontSize: 14, color: gmColor(group.gross_margin_pct) }}>
            {group.gross_margin_pct.toFixed(1)}%
            <span style={{ fontWeight: 400, fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>
              (${(group.revenue_total - (group.cogs_total ?? 0)).toFixed(2)})
            </span>
          </span>
        </div>
      )}
    </div>
  )
}

// ── Box Section ────────────────────────────────────────────────────────────────

function BoxSection({ plan, box, lineItems, boxTypes, pactorMap, ssConfigured, shippingBoxes, qc, order, isPreview = false }) {
  const [editing, setEditing] = useState(false)
  const [draftItems, setDraftItems] = useState([])
  const [addItemId, setAddItemId] = useState('')
  const [addQty, setAddQty] = useState('')
  const [collapsed, setCollapsed] = useState(box.status === 'cancelled')

  const BOX_STATUS = {
    pending:   { label: 'Pending',        cls: 'badge-not-processed' },
    packed:    { label: 'In ShipStation', cls: 'badge-ss-pending' },
    shipped:   { label: 'Shipped',        cls: 'badge-ss-shipped' },
    fulfilled: { label: 'Fulfilled',      cls: 'badge-fulfilled' },
    cancelled: { label: 'Cancelled',      cls: 'badge-partial' },
  }
  const boxCfg = BOX_STATUS[box.status] || { label: box.status, cls: 'badge-not-processed' }

  const isShipped   = box.status === 'shipped' || box.status === 'fulfilled'
  const isPacked    = box.status === 'packed'
  const isCancelled = box.status === 'cancelled'
  const boxPactor   = calcBoxPactor(box, pactorMap)
  const shippingEst = shippingBoxes?.find(sb => sb.box_id === box.id)

  const itemOptions = useMemo(() => {
    const groups = {}
    lineItems
      .filter(li => li.sku_mapped && li.pick_sku)
      .forEach(li => {
        const id = li.line_item_id
        if (!groups[id]) groups[id] = { line_item_id: id, product_title: li.product_title, shopify_sku: li.shopify_sku, rows: [] }
        groups[id].rows.push(li)
      })
    return Object.values(groups)
  }, [lineItems])

  const saveItemsMut = useMutation({
    mutationFn: (items) => fulfillmentApi.setBoxItems(plan.id, box.id, { items }),
    onSuccess: () => {
      qc.invalidateQueries(['plans', order.shopify_order_id])
      setEditing(false)
    },
  })

  const updateBoxMut = useMutation({
    mutationFn: (data) => fulfillmentApi.updateBox(plan.id, box.id, data),
    onSuccess: () => qc.invalidateQueries(['plans', order.shopify_order_id]),
  })

  const deleteBoxMut = useMutation({
    mutationFn: () => fulfillmentApi.deleteBox(plan.id, box.id),
    onSuccess: () => qc.invalidateQueries(['plans', order.shopify_order_id]),
  })

  const pushBoxMut = useMutation({
    mutationFn: () => fulfillmentApi.pushBox(plan.id, box.id),
    onSuccess: () => {
      qc.invalidateQueries(['plans', order.shopify_order_id])
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['orders-staged'])
    },
  })

  function startEdit() {
    setDraftItems(box.items.map(i => ({ ...i })))
    setEditing(true)
  }

  function saveItems() {
    const cleaned = draftItems
      .filter(it => it.pick_sku && parseFloat(it.quantity) > 0)
      .map(it => ({ ...it, quantity: parseFloat(it.quantity) }))
    saveItemsMut.mutate(cleaned)
  }

  function addItem() {
    if (!addItemId || !addQty) return
    const shopifyQty = parseFloat(addQty)
    const group = itemOptions.find(g => String(g.line_item_id) === String(addItemId))
    if (!group) return
    const newRows = group.rows.map(li => ({
      pick_sku: li.pick_sku,
      quantity: shopifyQty * (li.mix_quantity || 1),
      shopify_sku: li.shopify_sku || null,
      product_title: li.product_title || null,
      shopify_line_item_id: li.line_item_id || null,
    }))
    setDraftItems(prev => [...prev, ...newRows])
    setAddItemId('')
    setAddQty('')
  }

  return (
    <div className="ss-box-card">
      <div className="ss-box-header">
        <button
          onClick={() => setCollapsed(v => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px 0 0', color: '#9ca3af', fontSize: 12, lineHeight: 1 }}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▶' : '▼'}
        </button>
        <span className="ss-box-number">Box {box.box_number}</span>
        <span className={`badge ${boxCfg.cls}`} style={{ fontSize: 11 }}>{boxCfg.label}</span>
        {boxPactor != null && (
          <span className="pactor-chip pactor-box" title="Box pactor">⚡ {fmtPactor(boxPactor)}</span>
        )}
        {shippingEst?.weight_lb != null && (
          <span style={{ fontSize: 11, color: '#6b7280', background: '#f3f4f6', borderRadius: 4, padding: '1px 5px' }}
            title={shippingEst.rate != null ? `Est. $${shippingEst.rate.toFixed(2)} shipping` : undefined}>
            {shippingEst.weight_lb.toFixed(1)} lb
          </span>
        )}
        {box.tracking_number && (
          <span className="mono" style={{ fontSize: 11, color: '#16a34a' }}>{box.tracking_number}</span>
        )}
        {!isPreview && !isShipped && boxTypes.length > 0 && (
          <select
            value={box.box_type_id ?? ''}
            onChange={e => updateBoxMut.mutate({ box_type_id: e.target.value ? parseInt(e.target.value) : null })}
            className="ss-box-type-select"
            style={!box.box_type_id ? { borderColor: '#f59e0b', background: '#fffbeb' } : {}}
          >
            <option value="">Box type…</option>
            {boxTypes.map(bt => <option key={bt.id} value={bt.id}>{bt.name}</option>)}
          </select>
        )}
        {isPreview && box.box_type_id && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            {boxTypes.find(bt => bt.id === box.box_type_id)?.name || ''}
          </span>
        )}
        {!isShipped && !box.box_type_id && (
          <span style={{ fontSize: 11, color: '#d97706' }} title="No package rule matched this box">⚠ No rule</span>
        )}
        {!isPreview && isShipped && box.box_type_id && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            {boxTypes.find(bt => bt.id === box.box_type_id)?.name || ''}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {!isPreview && !editing && !isShipped && !isCancelled && (
          <button className="btn btn-sm" onClick={startEdit} style={{ fontSize: 11 }}>Edit Items</button>
        )}
        {!isPreview && !isPacked && !isShipped && !isCancelled && !editing && ssConfigured !== false && (
          <button
            className="btn btn-sm btn-primary"
            onClick={() => pushBoxMut.mutate()}
            disabled={pushBoxMut.isPending || box.items.length === 0}
            style={{ fontSize: 11 }}
          >
            {pushBoxMut.isPending ? 'Pushing…' : '→ ShipStation'}
          </button>
        )}
        {!isPreview && !isPacked && !isShipped && !isCancelled && !editing && (
          <button
            className="btn btn-sm btn-danger"
            onClick={() => {
              if (confirm(`Delete Box ${box.box_number}?`)) deleteBoxMut.mutate()
            }}
            disabled={deleteBoxMut.isPending}
            style={{ fontSize: 11 }}
          >
            {deleteBoxMut.isPending ? '…' : '✕'}
          </button>
        )}
        {!isPreview && (isPacked || isShipped) && !isCancelled && !editing && (
          <button
            className="btn btn-sm btn-danger"
            onClick={() => {
              const msg = isShipped
                ? `Cancel Box ${box.box_number}? This will void the shipment in ShipStation.`
                : `Cancel Box ${box.box_number}? This will also cancel the order in ShipStation.`
              if (confirm(msg)) deleteBoxMut.mutate()
            }}
            disabled={deleteBoxMut.isPending}
            style={{ fontSize: 11 }}
          >
            {deleteBoxMut.isPending ? 'Cancelling…' : 'Cancel Box'}
          </button>
        )}
      </div>

      {!collapsed && pushBoxMut.isError && (
        <p style={{ margin: '0 12px 0', padding: '6px 10px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, color: '#dc2626', fontSize: 12 }}>
          {pushBoxMut.error?.response?.data?.detail || 'Push to ShipStation failed'}
        </p>
      )}
      {!collapsed && deleteBoxMut.isError && (
        <p style={{ margin: '0 12px 0', padding: '6px 10px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, color: '#dc2626', fontSize: 12 }}>
          {deleteBoxMut.error?.response?.data?.detail || 'Cancel failed'}
        </p>
      )}

      {!collapsed && (
        <div className="ss-box-items">
          {!editing ? (
            box.items.length === 0 ? (
              <p style={{ margin: 0, color: '#9ca3af', fontSize: 12 }}>No items. Click Edit Items to add.</p>
            ) : (
              <table className="ss-box-items-table">
                <tbody>
                  {box.items.map(item => {
                    const p = pactorMap?.[item.pick_sku]
                    const itemPactor = p != null ? p * item.quantity : null
                    return (
                      <tr key={item.id}>
                        <td className="mono" style={{ fontSize: 12, color: '#6b7280' }}>{item.pick_sku}</td>
                        <td style={{ color: '#374151' }}>{item.product_title || '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{item.quantity}</td>
                        <td style={{ textAlign: 'right' }}>
                          {itemPactor != null
                            ? <span className="pactor-chip pactor-line">{fmtPactor(itemPactor)}</span>
                            : <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          ) : (
            <div>
              <table className="ss-box-items-table" style={{ marginBottom: 8 }}>
                <tbody>
                  {draftItems.map((item, idx) => (
                    <tr key={idx}>
                      <td className="mono" style={{ fontSize: 12, color: '#6b7280' }}>{item.pick_sku}</td>
                      <td style={{ color: '#374151' }}>{item.product_title || '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <input
                          type="number" min="0" step="0.01"
                          value={item.quantity}
                          onChange={e => setDraftItems(prev => prev.map((it, i) => i === idx ? { ...it, quantity: e.target.value } : it))}
                          style={{ width: 60, textAlign: 'right', padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                        />
                      </td>
                      <td>
                        <button onClick={() => setDraftItems(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14, padding: 0 }}>✕</button>
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background: '#f9fafb' }}>
                    <td colSpan={2}>
                      <select
                        value={addItemId}
                        onChange={e => setAddItemId(e.target.value)}
                        style={{ width: '100%', padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                      >
                        <option value="">— add item —</option>
                        {itemOptions.map(g => (
                          <option key={g.line_item_id} value={g.line_item_id}>
                            {g.product_title || g.shopify_sku || g.line_item_id}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        type="number" min="0" placeholder="Qty"
                        value={addQty}
                        onChange={e => setAddQty(e.target.value)}
                        style={{ width: 60, textAlign: 'right', padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                      />
                    </td>
                    <td>
                      <button onClick={addItem} style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', padding: '2px 6px', fontSize: 12 }}>+</button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-primary btn-sm" onClick={saveItems} disabled={saveItemsMut.isPending} style={{ fontSize: 11 }}>
                  {saveItemsMut.isPending ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn-sm" onClick={() => setEditing(false)} style={{ fontSize: 11 }}>Cancel</button>
              </div>
              {saveItemsMut.isError && (
                <p style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}>
                  {saveItemsMut.error?.response?.data?.detail || 'Save failed'}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Plan Section ───────────────────────────────────────────────────────────────

function PlanSection({ plan, lineItems, boxTypes, pactorMap, ssConfigured, shippingBoxes, onUpdatePlan, onAddBox, onResetUnpushed, resetUnpushedPending, qc, order, isPreview = false }) {
  const PLAN_STATUS = {
    draft:                  { label: 'Draft',           cls: 'badge-not-processed' },
    active:                 { label: 'Active',          cls: 'badge-fulfilled' },
    needs_review:           { label: 'Needs Review',    cls: 'badge-ss-pending' },
    needs_reconfiguration:  { label: 'Needs Reconfig',  cls: 'badge-partial' },
    completed:              { label: 'Completed',       cls: 'badge-fulfilled' },
    cancelled:              { label: 'Cancelled',       cls: 'badge-not-processed' },
  }
  const planCfg = PLAN_STATUS[plan.status] || { label: plan.status, cls: 'badge-not-processed' }
  const hasUnfulfilled = lineItems.some(li => (li.fulfillable_quantity ?? li.quantity) > 0)
  const cancelledCount = (plan.boxes || []).filter(b => b.status === 'cancelled').length
  const [showCancelled, setShowCancelled] = useState(false)
  const visibleBoxes = (plan.boxes || []).filter(b => showCancelled || b.status !== 'cancelled')

  return (
    <div>
      <div className="ss-plan-toolbar">
        <span className={`badge ${planCfg.cls}`} style={{ fontSize: 11 }}>{planCfg.label}</span>
        {!isPreview && plan.status === 'active' && (
          <button
            className="btn btn-sm"
            onClick={() => onUpdatePlan({ status: 'completed' })}
            disabled={hasUnfulfilled}
            title={hasUnfulfilled ? 'Order still has unfulfilled line items' : ''}
          >
            Mark Completed
          </button>
        )}
        {!isPreview && plan.status === 'completed' && hasUnfulfilled && (
          <button className="btn btn-sm btn-danger" onClick={() => onUpdatePlan({ status: 'draft' })} title="Plan is marked completed but order still has unfulfilled items">
            Reopen Plan
          </button>
        )}
        {!isPreview && (plan.boxes || []).some(b => b.status === 'pending') && (
          <button className="btn btn-sm btn-danger" onClick={onResetUnpushed} disabled={resetUnpushedPending} style={{ fontSize: 12 }}>
            {resetUnpushedPending ? 'Deleting…' : 'Reset Unpushed'}
          </button>
        )}
        {cancelledCount > 0 && (
          <button className="btn btn-sm" onClick={() => setShowCancelled(v => !v)} style={{ fontSize: 11, color: showCancelled ? '#374151' : '#9ca3af' }}>
            {showCancelled ? `Hide Cancelled (${cancelledCount})` : `Show Cancelled (${cancelledCount})`}
          </button>
        )}
        {!isPreview && (
          <button className="btn btn-sm" onClick={onAddBox} style={{ marginLeft: 'auto' }}>+ Add Box</button>
        )}
      </div>

      {plan.boxes?.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 13, marginTop: 8 }}>No boxes yet. Click "+ Add Box" to start.</p>
      ) : (
        visibleBoxes.map((box, idx) => (
          <BoxSection
            key={box.id ?? `preview-${idx}`}
            plan={plan}
            box={box}
            lineItems={lineItems}
            boxTypes={boxTypes}
            pactorMap={pactorMap}
            ssConfigured={ssConfigured}
            shippingBoxes={shippingBoxes}
            qc={qc}
            order={order}
            isPreview={isPreview}
          />
        ))
      )}
    </div>
  )
}

// ── Order Detail Panel ─────────────────────────────────────────────────────────

export default function OrderDetailPanel({ order, onClose, onPrev, onNext, hasPrev, hasNext, holdTags, ssConfigured, previewMappingTab = null }) {
  const qc = useQueryClient()

  // When previewMappingTab is set, the backend re-resolves pick SKUs and box
  // configs against that sheet tab (no DB writes). Cache key includes the tab
  // so React Query refetches when it changes.
  const { data: orderDetail } = useQuery({
    queryKey: ['order-detail', order.shopify_order_id, previewMappingTab],
    queryFn: () => ordersApi.get(
      order.shopify_order_id,
      previewMappingTab ? { mapping_tab: previewMappingTab } : undefined,
    ),
  })

  const { data: plans, isLoading: plansLoading } = useQuery({
    queryKey: ['plans', order.shopify_order_id, previewMappingTab],
    queryFn: () => fulfillmentApi.listPlans({
      shopify_order_id: order.shopify_order_id,
      ...(previewMappingTab ? { mapping_tab: previewMappingTab } : {}),
    }),
  })

  const { data: boxTypes = [] } = useQuery({
    queryKey: ['box-types'],
    queryFn: () => boxTypesApi.list({ is_active: true }),
  })

  const { data: pactorMap = {} } = useQuery({
    queryKey: ['pactor-map'],
    queryFn: () => fulfillmentApi.getPactorMap(),
    staleTime: 5 * 60 * 1000,
  })

  const { data: carrierServiceMatch } = useQuery({
    queryKey: ['carrier-service-for-order', order.shopify_order_id],
    queryFn: () => fulfillmentApi.getCarrierServiceForOrder(order.shopify_order_id),
    staleTime: 2 * 60 * 1000,
  })

  const { data: estDelivery, isLoading: estDeliveryLoading } = useQuery({
    queryKey: ['estimated-delivery', order.shopify_order_id],
    queryFn: () => shipstationApi.getEstimatedDelivery(order.shopify_order_id),
    enabled: ssConfigured && !!carrierServiceMatch?.carrier_code,
    staleTime: 10 * 60 * 1000,
    retry: false,
  })

  const { data: margin } = useQuery({
    queryKey: ['order-margin', order.shopify_order_id],
    queryFn: () => ordersApi.getMargin(order.shopify_order_id),
    staleTime: 2 * 60 * 1000,
    retry: false,
  })

  const plan = plans?.[0] || null
  const lineItems = orderDetail?.line_items || []
  const orderPactor = calcOrderPactor(lineItems, pactorMap)

  const orderTags = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean)
  const isHeld = order.shopify_hold || orderTags.some(t => holdTags?.has(t.toLowerCase()))

  const createPlanMut = useMutation({
    mutationFn: () => fulfillmentApi.createPlan({ shopify_order_id: order.shopify_order_id }),
    onSuccess: () => qc.invalidateQueries(['plans', order.shopify_order_id]),
  })

  const updatePlanMut = useMutation({
    mutationFn: ({ id, data }) => fulfillmentApi.updatePlan(id, data),
    onSuccess: () => qc.invalidateQueries(['plans', order.shopify_order_id]),
  })

  const addBoxMut = useMutation({
    mutationFn: (planId) => fulfillmentApi.addBox(planId, {}),
    onSuccess: () => qc.invalidateQueries(['plans', order.shopify_order_id]),
  })

  const deleteUnpushedMut = useMutation({
    mutationFn: (planId) => fulfillmentApi.deleteUnpushedBoxes(planId),
    onSuccess: () => qc.invalidateQueries(['plans', order.shopify_order_id]),
  })

  const stageMut = useMutation({
    mutationFn: () => ordersApi.stage(order.shopify_order_id),
    onSuccess: () => {
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['orders-staged'])
    },
  })

  const statusMut = useMutation({
    mutationFn: (status) => ordersApi.updateStatus(order.shopify_order_id, { app_status: status }),
    onSuccess: () => {
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['orders-staged'])
    },
  })

  const cancelMut = useMutation({
    mutationFn: () => ordersApi.cancelOrder(order.shopify_order_id),
    onSuccess: () => {
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['orders-staged'])
      qc.invalidateQueries(['plans', order.shopify_order_id])
    },
  })

  const unmapped = lineItems.filter(li => !li.sku_mapped)
  const shortShipItems = lineItems.filter(li => li.app_line_status === 'short_ship')
  const inventoryHoldItems = lineItems.filter(li => li.app_line_status === 'inventory_hold')
  const unfulfilledItems = lineItems.filter(li =>
    (li.fulfillable_quantity ?? li.quantity) > 0 && !['short_ship', 'removed', 'inventory_hold'].includes(li.app_line_status)
  )
  const fulfilledItems = lineItems.filter(li =>
    (li.fulfillable_quantity ?? li.quantity) === 0 && li.fulfillment_status === 'fulfilled' && !['short_ship', 'removed', 'inventory_hold'].includes(li.app_line_status)
  )
  const appFulfilledIds = useMemo(() => {
    const ids = margin?.app_fulfilled_line_item_ids
    return ids ? new Set(ids) : null
  }, [margin?.app_fulfilled_line_item_ids])
  const isPartial = unfulfilledItems.length > 0 && fulfilledItems.length > 0

  const [unfulfilledOpen, setUnfulfilledOpen] = useState(true)
  const [fulfilledOpen, setFulfilledOpen] = useState(false)
  const [shortShipOpen, setShortShipOpen] = useState(false)
  const [invHoldOpen, setInvHoldOpen] = useState(true)
  const [gmExpanded, setGmExpanded] = useState(false)
  const [itemsCollapsed, setItemsCollapsed] = useState(false)

  return (
    <div className="ss-detail-panel">
      {/* Header */}
      <div className="ss-detail-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={onPrev}
            disabled={!hasPrev}
            style={{ background: 'none', border: 'none', cursor: hasPrev ? 'pointer' : 'default', color: hasPrev ? '#374151' : '#d1d5db', fontSize: 16, padding: '0 2px', lineHeight: 1 }}
            title="Previous order"
          >‹</button>
          <button
            onClick={onNext}
            disabled={!hasNext}
            style={{ background: 'none', border: 'none', cursor: hasNext ? 'pointer' : 'default', color: hasNext ? '#374151' : '#d1d5db', fontSize: 16, padding: '0 2px', lineHeight: 1 }}
            title="Next order"
          >›</button>
          <div>
            <div className="ss-detail-order-num">
              {order.shopify_order_number ? `Order ${order.shopify_order_number}` : `Order ${order.shopify_order_id}`}
            </div>
            <div className="ss-detail-meta">
              {order.customer_name || '—'}
              {order.shipping_city && ` · ${order.shipping_city}, ${order.shipping_province}`}
            </div>
          </div>
        </div>
        <button className="ss-detail-close" onClick={onClose}>✕</button>
      </div>

      <div className="ss-detail-body">
        {/* Status + Tags */}
        <div className="ss-detail-section">
          <div className="ss-detail-row-spread">
            <div className="ss-detail-status-row">
              <span className={`badge ${STATUS_BADGE[order.app_status]?.cls || 'badge-not-processed'}`}>
                {STATUS_BADGE[order.app_status]?.label || order.app_status}
              </span>
              {isHeld && <span className="badge" style={{ background: '#fee2e2', color: '#dc2626' }}>HOLD</span>}
              {orderTags.map(t => <span key={t} className={tagChipClass(t)}>{t}</span>)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {(order.app_status === 'in_shipstation_not_shipped' || order.app_status === 'staged' || order.app_status === 'in_shipstation_shipped') && (
                <button
                  className="btn btn-sm"
                  style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', fontWeight: 600 }}
                  disabled={cancelMut.isPending}
                  onClick={() => {
                    const inSS = order.app_status === 'in_shipstation_not_shipped'
                    const inSSShipped = order.app_status === 'in_shipstation_shipped'
                    const msg = inSSShipped
                      ? `Reset order ${order.shopify_order_number}?\n\nThis will:\n• Attempt to void any ShipStation records\n• Restore inventory\n• Reset order to Not Processed\n\nOnly do this if the order was never actually shipped.`
                      : inSS
                      ? `Cancel order ${order.shopify_order_number}?\n\nThis will:\n• Void the order in ShipStation\n• Restore inventory\n• Reset order to Not Processed`
                      : `Cancel order ${order.shopify_order_number}?\n\nThis will:\n• Void any pushed boxes in ShipStation\n• Reset order to Not Processed`
                    if (window.confirm(msg)) cancelMut.mutate()
                  }}
                >
                  {cancelMut.isPending ? 'Cancelling…' : order.app_status === 'in_shipstation_shipped' ? '↩ Reset Order' : '✕ Cancel Order'}
                </button>
              )}
            </div>
          </div>
          {cancelMut.isError && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#dc2626' }}>
              {cancelMut.error?.response?.data?.detail || 'Cancel failed — check ShipStation manually'}
            </div>
          )}
          {cancelMut.isSuccess && cancelMut.data?.warnings?.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#d97706', background: '#fffbeb', padding: '6px 10px', borderRadius: 4, border: '1px solid #fcd34d' }}>
              ⚠ Partial cancel: {cancelMut.data.warnings.join('; ')}
            </div>
          )}
        </div>

        {/* Ship To */}
        <div className="ss-detail-section">
          <div className="ss-detail-section-title">Ship To</div>
          {orderDetail ? (
            <div className="ss-address-block">
              <div className="ss-address-name">{orderDetail.shipping_name || order.customer_name || '—'}</div>
              {orderDetail.shipping_address1 && <div>{orderDetail.shipping_address1}</div>}
              {orderDetail.shipping_address2 && <div>{orderDetail.shipping_address2}</div>}
              {(orderDetail.shipping_city || orderDetail.shipping_province || orderDetail.shipping_zip) && (
                <div>{[orderDetail.shipping_city, orderDetail.shipping_province, orderDetail.shipping_zip].filter(Boolean).join(', ')}</div>
              )}
              {orderDetail.shipping_country && <div>{orderDetail.shipping_country}</div>}
            </div>
          ) : (
            <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
          )}
        </div>

        {/* Order Summary */}
        <div className="ss-detail-section">
          <div className="ss-detail-section-title">Order Summary</div>
          <div className="ss-detail-kv-grid">
            <span>Order Date</span><span>{fmtDate(order.created_at_shopify)}</span>
            <span>Order Total</span><span>${(order.total_price || 0).toFixed(2)}</span>
            <span>Zone</span><span>{order.zone != null ? order.zone : <span style={{ color: '#9ca3af' }}>—</span>}</span>
            <span>Pactor</span>
            <span>
              {orderPactor != null
                ? <span className="pactor-chip pactor-order">{fmtPactor(orderPactor)}</span>
                : <span style={{ color: '#9ca3af' }}>—</span>}
            </span>
            <span>Carrier Service</span>
            <span>
              {carrierServiceMatch?.carrier_code ? (() => {
                const svc = findService(carrierServiceMatch.carrier_code, carrierServiceMatch.service_code, carrierServiceMatch.shipping_provider_id ?? null)
                return (
                  <span title={`Rule: ${carrierServiceMatch.rule_name}`} style={{ display: 'inline-flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>
                      {svc ? `${svc.carrierLabel} — ${svc.label}` : `${carrierServiceMatch.carrier_code} / ${carrierServiceMatch.service_code}`}
                    </span>
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>{carrierServiceMatch.rule_name}</span>
                  </span>
                )
              })() : <span style={{ color: '#9ca3af' }}>No rule matched</span>}
            </span>
            <span>Est. Delivery</span>
            <span>
              {order.estimated_delivery_date ? (
                <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 500 }}>
                  {new Date(order.estimated_delivery_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>(confirmed)</span>
                </span>
              ) : estDeliveryLoading ? (
                <span style={{ fontSize: 12, color: '#9ca3af' }}>Fetching…</span>
              ) : estDelivery?.estimated_delivery_date ? (
                <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 500 }}>
                  {new Date(estDelivery.estimated_delivery_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {estDelivery.transit_days != null && (
                    <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>({estDelivery.transit_days}d transit)</span>
                  )}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: '#9ca3af' }}>—</span>
              )}
            </span>
            {order.tracking_number && <><span>Tracking</span><span className="mono" style={{ fontSize: 12 }}>{order.tracking_number}</span></>}
            {margin && (
              <>
                <span style={{ paddingTop: 8, borderTop: '1px solid #f3f4f6', gridColumn: '1 / -1' }}>
                  <button
                    onClick={() => setGmExpanded(v => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: 0, width: '100%' }}
                  >
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>{gmExpanded ? '▼' : '▶'}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Revenue &amp; Gross Margin</span>
                    {margin.missing_cost_skus?.length > 0 ? (
                      <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: '#f59e0b' }}>⚠ Missing COGS</span>
                    ) : margin.gross_margin_pct != null && (
                      <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700,
                        color: margin.gross_margin_pct >= 30 ? '#16a34a' : margin.gross_margin_pct >= 10 ? '#d97706' : '#dc2626'
                      }}>
                        {margin.gross_margin_pct.toFixed(1)}%
                      </span>
                    )}
                  </button>
                </span>

                {gmExpanded && (
                  <span style={{ gridColumn: '1 / -1' }}>
                    {/* ── To Fulfill GM ── */}
                    {margin.to_fulfill?.revenue_gross > 0 && (
                      <GmGroupSection
                        title="To Fulfill"
                        group={margin.to_fulfill}
                        settings={margin.settings}
                        missingCostSkus={margin.missing_cost_skus}
                        showShippingBoxes
                      />
                    )}
                    {/* ── Fulfilled via App GM ── */}
                    {margin.fulfilled_app?.revenue_total > 0 && (
                      <GmGroupSection
                        title="Fulfilled (via App)"
                        group={margin.fulfilled_app}
                        settings={margin.settings}
                        showShippingBoxes
                        style={{ marginTop: margin.to_fulfill?.revenue_total > 0 ? 8 : 0 }}
                      />
                    )}
                    {/* ── Fulfilled outside App ── */}
                    {margin.fulfilled_external?.revenue_total > 0 && (
                      <div style={{ background: '#f9fafb', border: '1px solid #e8e8e8', borderRadius: 6, padding: 12, fontSize: 12, marginTop: (margin.to_fulfill?.revenue_total > 0 || margin.fulfilled_app?.revenue_total > 0) ? 8 : 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontWeight: 700, color: '#374151', fontSize: 12 }}>Fulfilled (outside App)</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#9ca3af' }}>N/A</span>
                        </div>
                        <div style={{ fontWeight: 700, color: '#374151', marginBottom: 6, fontSize: 12 }}>Revenue</div>
                        <GmRow label="Line items" value={margin.fulfilled_external.revenue_gross} />
                        {margin.fulfilled_external.revenue_discounts > 0 && <GmRow label="Discounts" value={-margin.fulfilled_external.revenue_discounts} red />}
                        {margin.fulfilled_external.revenue_shipping > 0 && <GmRow label="Paid shipping" value={margin.fulfilled_external.revenue_shipping} />}
                        <GmRow label="Total revenue" value={margin.fulfilled_external.revenue_total} bold />
                        <div style={{ fontWeight: 700, color: '#374151', marginTop: 10, marginBottom: 6, fontSize: 12 }}>COGS</div>
                        <div style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>Not available — fulfilled outside app</div>
                        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e8e8e8', display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontWeight: 700, color: '#374151' }}>Gross Margin</span>
                          <span style={{ fontWeight: 700, fontSize: 14, color: '#9ca3af' }}>N/A</span>
                        </div>
                      </div>
                    )}
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Line Items */}
        <div className="ss-detail-section">
          <div
            className="ss-detail-section-title"
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setItemsCollapsed(v => !v)}
          >
            <span style={{ fontSize: 10, color: '#9ca3af' }}>{itemsCollapsed ? '▶' : '▼'}</span>
            Items
            {itemsCollapsed && lineItems.length > 0 && (
              <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 4 }}>
                ({unfulfilledItems.length} item{unfulfilledItems.length !== 1 ? 's' : ''}{shortShipItems.length > 0 ? `, ${shortShipItems.length} short-shipped` : ''})
              </span>
            )}
          </div>
          {!itemsCollapsed && unmapped.length > 0 && (
            <div className="warning-banner" style={{ marginBottom: 8 }}>
              ⚠ {unmapped.length} unmapped SKU{unmapped.length > 1 ? 's' : ''}: {unmapped.map(u => u.shopify_sku || '?').join(', ')}
            </div>
          )}
          {!itemsCollapsed && order.has_plan_mismatch && (
            <div className="warning-banner" style={{ marginBottom: 8 }}>
              ⚠ Box quantities don't match the order — plan may need to be updated
            </div>
          )}
          {!itemsCollapsed && (
            lineItems.length === 0 ? (
              <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading items…</div>
            ) : (
              <>
                {unfulfilledItems.length > 0 && (
                  <>
                    {fulfilledItems.length > 0 && (
                      <button onClick={() => setUnfulfilledOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginBottom: 4, fontWeight: 600, fontSize: 12, color: '#374151' }}>
                        <span style={{ fontSize: 10 }}>{unfulfilledOpen ? '▼' : '▶'}</span>
                        To Fulfill ({unfulfilledItems.length})
                      </button>
                    )}
                    {(fulfilledItems.length === 0 || unfulfilledOpen) && (
                      <ItemsTable items={unfulfilledItems} pactorMap={pactorMap} orderPactor={orderPactor} showPactorTotal fruitLines={margin?.to_fulfill?.fruit_lines} skuWeights={margin?.sku_weights} />
                    )}
                  </>
                )}
                {fulfilledItems.length > 0 && (
                  <>
                    {unfulfilledItems.length > 0 ? (
                      // Mixed: collapsible section
                      <>
                        <button onClick={() => setFulfilledOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginTop: 8, marginBottom: 4, fontWeight: 600, fontSize: 12, color: '#6b7280' }}>
                          <span style={{ fontSize: 10 }}>{fulfilledOpen ? '▼' : '▶'}</span>
                          Already Fulfilled ({fulfilledItems.length})
                        </button>
                        {fulfilledOpen && <ItemsTable items={fulfilledItems} pactorMap={pactorMap} fruitLines={margin?.to_fulfill?.fruit_lines} skuWeights={margin?.sku_weights} showFulfilledQty appFulfilledIds={appFulfilledIds} />}
                      </>
                    ) : (
                      // All fulfilled: show table directly
                      <>
                        <div style={{ fontWeight: 600, fontSize: 12, color: '#6b7280', padding: '4px 0', marginBottom: 4 }}>Already Fulfilled ({fulfilledItems.length})</div>
                        <ItemsTable items={fulfilledItems} pactorMap={pactorMap} fruitLines={margin?.to_fulfill?.fruit_lines} skuWeights={margin?.sku_weights} showFulfilledQty appFulfilledIds={appFulfilledIds} />
                      </>
                    )}
                  </>
                )}
                {inventoryHoldItems.length > 0 && (
                  <>
                    <button onClick={() => setInvHoldOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginTop: 8, marginBottom: 4, fontWeight: 600, fontSize: 12, color: '#7c3aed' }}>
                      <span style={{ fontSize: 10 }}>{invHoldOpen ? '▼' : '▶'}</span>
                      Inventory Hold ({inventoryHoldItems.length}) — waiting on inventory
                    </button>
                    {invHoldOpen && (
                      <div style={{ background: '#f5f3ff', borderRadius: 6, padding: 2, border: '1px solid #c4b5fd' }}>
                        <ItemsTable items={inventoryHoldItems} pactorMap={pactorMap} />
                      </div>
                    )}
                  </>
                )}
                {shortShipItems.length > 0 && (
                  <>
                    <button onClick={() => setShortShipOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginTop: 8, marginBottom: 4, fontWeight: 600, fontSize: 12, color: '#dc2626' }}>
                      <span style={{ fontSize: 10 }}>{shortShipOpen ? '▼' : '▶'}</span>
                      Short Shipped ({shortShipItems.length}) — not shipping
                    </button>
                    {shortShipOpen && <ItemsTable items={shortShipItems} pactorMap={pactorMap} dimmed />}
                  </>
                )}
              </>
            )
          )}
        </div>

        {/* Fulfillment Plan */}
        <div className="ss-detail-section">
          <div className="ss-detail-section-title">
            Fulfillment Plan
            {plan?.is_preview && (
              <span
                style={{
                  marginLeft: 8, padding: '2px 8px', borderRadius: 999, fontSize: 10,
                  fontWeight: 700, letterSpacing: 0.3,
                  background: '#fef3c7', color: '#92400e',
                }}
                title={`Preview — boxes recomputed against mapping tab "${plan.mapping_tab}". Stored plan unchanged. Click Confirm Selected on this order to commit this layout.`}
              >
                PREVIEW · {plan.mapping_tab}
              </span>
            )}
          </div>
          {plan?.is_preview && plan.notes && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 10px', marginBottom: 8, fontSize: 12, color: '#92400e' }}>
              {plan.notes}
            </div>
          )}
          {plansLoading ? (
            <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
          ) : !plan ? (
            <div className="ss-no-plan">
              <p>No fulfillment plan yet.</p>
              <button className="btn btn-primary btn-sm" onClick={() => createPlanMut.mutate()} disabled={createPlanMut.isPending}>
                {createPlanMut.isPending ? 'Creating…' : 'Create Plan'}
              </button>
              {order.app_status === 'not_processed' && (
                <button className="btn btn-sm" onClick={() => stageMut.mutate()} disabled={stageMut.isPending} style={{ marginLeft: 8 }}>
                  {stageMut.isPending ? 'Staging…' : 'Stage Order'}
                </button>
              )}
              {stageMut.isError && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{stageMut.error?.response?.data?.detail || 'Stage failed'}</p>}
              {createPlanMut.isError && <p style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{createPlanMut.error?.response?.data?.detail || 'Failed'}</p>}
            </div>
          ) : (
            <PlanSection
              plan={plan}
              lineItems={lineItems}
              boxTypes={boxTypes}
              pactorMap={pactorMap}
              ssConfigured={ssConfigured && !plan.is_preview}
              shippingBoxes={margin?.shipping_boxes}
              onUpdatePlan={(data) => updatePlanMut.mutate({ id: plan.id, data })}
              onAddBox={() => addBoxMut.mutate(plan.id)}
              onResetUnpushed={() => {
                const count = (plan.boxes || []).filter(b => b.status === 'pending').length
                if (confirm(`Delete ${count} unpushed box${count !== 1 ? 'es' : ''}? This cannot be undone.`)) {
                  deleteUnpushedMut.mutate(plan.id)
                }
              }}
              resetUnpushedPending={deleteUnpushedMut.isPending}
              qc={qc}
              order={order}
              isPreview={!!plan.is_preview}
            />
          )}
        </div>
      </div>
    </div>
  )
}
