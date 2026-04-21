import { useState, useMemo, useEffect, useRef } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi, ordersApi } from '../api'

function fmt(n) {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function daysAgo(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 0
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

function fmtShortDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

function fmtGm(entry) {
  if (!entry) return '—'
  if (entry.missing_cost_skus?.length) return <span style={{ color: '#dc2626' }} title="Missing COGS">⚠</span>
  if (entry.gm_pct == null) return '—'
  const v = entry.gm_pct
  const color = v < 30 ? '#dc2626' : v < 45 ? '#d97706' : '#16a34a'
  return <span style={{ color, fontWeight: 600 }}>{v.toFixed(1)}%</span>
}

// ── Reusable table controls (mirrors Orders.jsx) ──────────────────────────────

function ColumnFilter({ type, label, options, value, onChange }) {
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

// ── Main page ─────────────────────────────────────────────────────────────────

const EMPTY_RANGE = { min: '', max: '' }

export default function IssueSkuDetail() {
  const { pickSku: rawPickSku } = useParams()
  const [searchParams] = useSearchParams()
  const pickSku = decodeURIComponent(rawPickSku || '')
  const warehouse = searchParams.get('warehouse') || null

  const qc = useQueryClient()
  const [selectedOrderIds, setSelectedOrderIds] = useState(() => new Set())
  const [unstageMsg, setUnstageMsg] = useState(null)

  // Search + sort + filter state
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState('order_date')
  const [sortDir, setSortDir] = useState('desc')
  const [colFilters, setColFilters] = useState({
    boxType: null,
    pickSku: null,
    tags: null,
    states: null,
    qty: { ...EMPTY_RANGE },
    gm: { ...EMPTY_RANGE },
    age: { ...EMPTY_RANGE },
  })
  const setCF = (key, v) => setColFilters(prev => ({ ...prev, [key]: v }))
  const clearAllFilters = () => setColFilters({
    boxType: null, pickSku: null, tags: null, states: null,
    qty: { ...EMPTY_RANGE }, gm: { ...EMPTY_RANGE }, age: { ...EMPTY_RANGE },
  })
  const anyFilterActive = (
    colFilters.boxType !== null || colFilters.pickSku !== null ||
    colFilters.tags !== null || colFilters.states !== null ||
    colFilters.qty.min !== '' || colFilters.qty.max !== '' ||
    colFilters.gm.min !== '' || colFilters.gm.max !== '' ||
    colFilters.age.min !== '' || colFilters.age.max !== ''
  )

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['staged-boxes-by-pick-sku', pickSku, warehouse],
    queryFn: () => inventoryApi.stagedBoxesByPickSku(pickSku, warehouse),
    enabled: !!pickSku,
    staleTime: 30000,
  })

  const boxes = data?.boxes || []
  const totalQty = data?.total_qty || 0
  const availableQty = data?.available_qty ?? 0
  const onHandQty = data?.on_hand_qty ?? 0

  const orderIds = useMemo(
    () => Array.from(new Set(boxes.map(b => b.shopify_order_id))),
    [boxes]
  )

  const { data: marginsMap = {} } = useQuery({
    queryKey: ['orders-margins', orderIds],
    queryFn: () => orderIds.length ? ordersApi.getBatchMargins(orderIds) : {},
    enabled: orderIds.length > 0,
    staleTime: 60000,
  })

  // Filter option values derived from data
  const allBoxTypes = useMemo(
    () => Array.from(new Set(boxes.map(b => b.box_type_name).filter(Boolean))).sort(),
    [boxes]
  )
  const allPickSkus = useMemo(() => {
    const s = new Set()
    for (const b of boxes) (b.pick_skus || []).forEach(sk => s.add(sk))
    return Array.from(s).sort()
  }, [boxes])
  const allTags = useMemo(() => {
    const s = new Set()
    for (const b of boxes) (b.tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => s.add(t))
    return Array.from(s).sort()
  }, [boxes])
  const allStates = useMemo(
    () => Array.from(new Set(boxes.map(b => b.shipping_province).filter(Boolean))).sort(),
    [boxes]
  )

  // Apply search + filters + sort
  const processedBoxes = useMemo(() => {
    let result = [...boxes]

    // Text search (order #, customer name, customer email)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(b =>
        String(b.shopify_order_number || b.shopify_order_id).toLowerCase().includes(q) ||
        (b.customer_name || '').toLowerCase().includes(q) ||
        (b.customer_email || '').toLowerCase().includes(q)
      )
    }

    // Column filters
    if (colFilters.boxType) {
      result = result.filter(b => colFilters.boxType.has(b.box_type_name || ''))
    }
    if (colFilters.pickSku) {
      result = result.filter(b => (b.pick_skus || []).some(sk => colFilters.pickSku.has(sk)))
    }
    if (colFilters.tags) {
      result = result.filter(b => {
        const t = (b.tags || '').split(',').map(s => s.trim()).filter(Boolean)
        return t.some(tag => colFilters.tags.has(tag))
      })
    }
    if (colFilters.states) {
      result = result.filter(b => colFilters.states.has(b.shipping_province || ''))
    }
    if (colFilters.qty.min !== '') result = result.filter(b => (b.target_qty || 0) >= Number(colFilters.qty.min))
    if (colFilters.qty.max !== '') result = result.filter(b => (b.target_qty || 0) <= Number(colFilters.qty.max))
    if (colFilters.gm.min !== '') result = result.filter(b => {
      const gm = marginsMap[b.shopify_order_id]?.gm_pct
      return gm != null && gm >= Number(colFilters.gm.min)
    })
    if (colFilters.gm.max !== '') result = result.filter(b => {
      const gm = marginsMap[b.shopify_order_id]?.gm_pct
      return gm != null && gm <= Number(colFilters.gm.max)
    })
    if (colFilters.age.min !== '') result = result.filter(b => (daysAgo(b.created_at_shopify) ?? 0) >= Number(colFilters.age.min))
    if (colFilters.age.max !== '') result = result.filter(b => (daysAgo(b.created_at_shopify) ?? 0) <= Number(colFilters.age.max))

    // Sort
    const sign = sortDir === 'asc' ? 1 : -1
    const getSortVal = (b) => {
      switch (sortCol) {
        case 'order_num': {
          const s = String(b.shopify_order_number || b.shopify_order_id || '').replace(/^#/, '')
          const n = Number(s)
          return Number.isFinite(n) ? n : s
        }
        case 'box_num': return b.box_number || 0
        case 'box_type': return (b.box_type_name || '').toLowerCase()
        case 'qty': return b.target_qty || 0
        case 'gm': return marginsMap[b.shopify_order_id]?.gm_pct ?? -Infinity
        case 'age': return daysAgo(b.created_at_shopify) ?? 0
        case 'order_date': return b.created_at_shopify ? new Date(b.created_at_shopify).getTime() : 0
        case 'customer': return (b.customer_name || b.customer_email || '').toLowerCase()
        default: return 0
      }
    }
    result.sort((a, b) => {
      const av = getSortVal(a)
      const bv = getSortVal(b)
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
      return String(av).localeCompare(String(bv)) * sign
    })

    return result
  }, [boxes, search, colFilters, sortCol, sortDir, marginsMap])

  // Selection-driven summary (over the filtered rows only: freed qty counts visible selected rows).
  const freedQty = useMemo(() => {
    if (selectedOrderIds.size === 0) return 0
    return processedBoxes
      .filter(b => selectedOrderIds.has(b.shopify_order_id))
      .reduce((s, b) => s + (b.target_qty || 0), 0)
  }, [processedBoxes, selectedOrderIds])

  const piecesShort = Math.max(0, -availableQty)
  const updatedEnding = availableQty + freedQty
  const updatedShort = Math.max(0, -updatedEnding)

  const toggleOrder = (orderId) => {
    setSelectedOrderIds(prev => {
      const next = new Set(prev)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }

  // Visible order ids (from filtered rows) are what "select all" toggles.
  const visibleOrderIds = useMemo(
    () => Array.from(new Set(processedBoxes.map(b => b.shopify_order_id))),
    [processedBoxes]
  )
  const allVisibleSelected = visibleOrderIds.length > 0 && visibleOrderIds.every(id => selectedOrderIds.has(id))
  const toggleAll = () => {
    if (allVisibleSelected) {
      // Deselect visible
      setSelectedOrderIds(prev => {
        const next = new Set(prev)
        visibleOrderIds.forEach(id => next.delete(id))
        return next
      })
    } else {
      setSelectedOrderIds(prev => {
        const next = new Set(prev)
        visibleOrderIds.forEach(id => next.add(id))
        return next
      })
    }
  }

  const unstageMut = useMutation({
    mutationFn: (ids) => ordersApi.unstageBatch(ids),
    onSuccess: (result) => {
      const msg = `Unstaged ${result.unstaged} order${result.unstaged !== 1 ? 's' : ''}${result.failed ? ` (${result.failed} failed)` : ''}.`
      setUnstageMsg({ ok: true, text: msg })
      setSelectedOrderIds(new Set())
      qc.invalidateQueries(['staged-boxes-by-pick-sku'])
      qc.invalidateQueries(['demand-analysis'])
      qc.invalidateQueries(['staged-shortages'])
      qc.invalidateQueries(['inventory-items'])
      qc.invalidateQueries(['orders-staged'])
      qc.invalidateQueries(['orders-margins'])
    },
    onError: (err) => {
      setUnstageMsg({ ok: false, text: `Unstage failed: ${err?.message || 'unknown error'}` })
    },
  })

  const doUnstage = () => {
    if (selectedOrderIds.size === 0) return
    const n = selectedOrderIds.size
    if (!window.confirm(`Unstage ${n} order${n !== 1 ? 's' : ''}? They'll return to Not Processed and release their inventory reservations.`)) {
      return
    }
    setUnstageMsg(null)
    unstageMut.mutate(Array.from(selectedOrderIds))
  }

  return (
    <div>
      {/* Header */}
      <div className="page-header-row">
        <div className="page-header">
          <h1>
            Staged orders containing <span className="mono" style={{ color: '#dc2626' }}>{pickSku}</span>
          </h1>
          <p>
            {warehouse
              ? <>Warehouse: <strong style={{ textTransform: 'capitalize' }}>{warehouse}</strong>. </>
              : null}
            Box-level view of staged orders that include this pick SKU. Select orders and click "Unstage Selected" to release them.
          </p>
        </div>
        <div className="page-header-actions">
          <Link to="/staging-dashboard" className="btn btn-secondary">← Back to Staging Dashboard</Link>
        </div>
      </div>

      {/* Summary stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-num">{fmt(onHandQty)}</div>
          <div className="stat-label">On Hand</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{fmt(totalQty)}</div>
          <div className="stat-label">Staged Demand ({boxes.length} box{boxes.length !== 1 ? 'es' : ''})</div>
        </div>
        <div className="stat-card">
          <div className="stat-num" style={{ color: piecesShort > 0 ? '#dc2626' : '#16a34a' }}>
            {fmt(piecesShort)}
          </div>
          <div className="stat-label">Pieces Short</div>
        </div>
        <div className="stat-card" style={selectedOrderIds.size > 0 ? { borderColor: '#2563eb', borderWidth: 2, borderStyle: 'solid' } : {}}>
          <div className="stat-num" style={{ color: updatedShort > 0 ? '#dc2626' : '#16a34a' }}>
            {fmt(updatedEnding)}
          </div>
          <div className="stat-label">
            Ending Balance
            {selectedOrderIds.size > 0 ? (
              <span style={{ display: 'block', fontSize: 11, color: '#2563eb', fontWeight: 600, marginTop: 2 }}>
                if {selectedOrderIds.size} order{selectedOrderIds.size !== 1 ? 's' : ''} unstaged (+{fmt(freedQty)} freed)
              </span>
            ) : (
              <span style={{ display: 'block', fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                current
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Bulk-action bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, marginTop: 8 }}>
        <span style={{ fontSize: 13, color: '#374151' }}>
          <strong>{selectedOrderIds.size}</strong> order{selectedOrderIds.size !== 1 ? 's' : ''} selected
          {selectedOrderIds.size > 0 && (
            <span style={{ color: '#6b7280', marginLeft: 8 }}>
              (frees <strong style={{ color: '#16a34a' }}>{fmt(freedQty)}</strong> units of {pickSku})
            </span>
          )}
        </span>
        <button
          onClick={doUnstage}
          disabled={selectedOrderIds.size === 0 || unstageMut.isPending}
          className="btn btn-danger"
          style={{
            opacity: selectedOrderIds.size === 0 ? 0.4 : 1,
            cursor: selectedOrderIds.size === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {unstageMut.isPending ? 'Unstaging…' : `Unstage Selected`}
        </button>
        {selectedOrderIds.size > 0 && (
          <button onClick={() => setSelectedOrderIds(new Set())} className="btn btn-secondary">
            Clear
          </button>
        )}
        {unstageMsg && (
          <span style={{
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 4,
            background: unstageMsg.ok ? '#f0fdf4' : '#fef2f2',
            color: unstageMsg.ok ? '#16a34a' : '#dc2626',
            border: `1px solid ${unstageMsg.ok ? '#bbf7d0' : '#fca5a5'}`,
          }}>
            {unstageMsg.text}
          </span>
        )}
      </div>

      {/* Search bar + filter banner */}
      <div className="ss-search-bar">
        <input
          type="text"
          placeholder="Search order #, customer…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="ss-search-input"
        />
        <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto' }}>
          {processedBoxes.length} of {boxes.length} box{boxes.length !== 1 ? 'es' : ''}
        </span>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="loading">Loading staged boxes…</div>
      ) : isError ? (
        <div className="empty" style={{ color: '#dc2626' }}>
          Error loading data: {error?.message || 'unknown error'}
        </div>
      ) : boxes.length === 0 ? (
        <div className="empty">
          No staged boxes contain <span className="mono">{pickSku}</span>
          {warehouse ? <> in the {warehouse} warehouse</> : null}.
        </div>
      ) : (
        <div className="ss-table-wrap">
          {anyFilterActive && (
            <div className="col-filter-active-bar">
              <span>Column filters active</span>
              <button onClick={clearAllFilters}>✕ Clear all filters</button>
            </div>
          )}
          {processedBoxes.length === 0 ? (
            <div className="empty">No boxes match the current filters.</div>
          ) : (
            <table className="ss-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} />
                  </th>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="order_num">Order #</SortTh>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="box_num">Box #</SortTh>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="box_type" filterEl={
                    <ColumnFilter type="select" label="Box Type" options={allBoxTypes} value={colFilters.boxType} onChange={v => setCF('boxType', v)} />
                  }>Box Type</SortTh>
                  <th>Pick SKUs in Box <ColumnFilter type="select" label="Pick SKU" options={allPickSkus} value={colFilters.pickSku} onChange={v => setCF('pickSku', v)} /></th>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="qty" style={{ textAlign: 'right' }} filterEl={
                    <ColumnFilter type="range" label={`Qty of ${pickSku}`} options={null} value={colFilters.qty} onChange={v => setCF('qty', v)} />
                  }>Qty of {pickSku}</SortTh>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="gm" style={{ textAlign: 'right' }} filterEl={
                    <ColumnFilter type="range" label="GM%" options={null} value={colFilters.gm} onChange={v => setCF('gm', v)} />
                  }>GM%</SortTh>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="age" filterEl={
                    <ColumnFilter type="range" label="Age (days)" options={null} value={colFilters.age} onChange={v => setCF('age', v)} />
                  }>Age</SortTh>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="order_date">Order Date</SortTh>
                  <SortTh sortCol={sortCol} sortDir={sortDir} onSort={handleSort} col="customer" filterEl={
                    <ColumnFilter type="select" label="State" options={allStates} value={colFilters.states} onChange={v => setCF('states', v)} />
                  }>Recipient</SortTh>
                  <th>Tags <ColumnFilter type="select" label="Tags" options={allTags} value={colFilters.tags} onChange={v => setCF('tags', v)} /></th>
                </tr>
              </thead>
              <tbody>
                {processedBoxes.map(box => {
                  const isSelected = selectedOrderIds.has(box.shopify_order_id)
                  return (
                    <tr
                      key={box.box_id}
                      className={isSelected ? 'selected' : ''}
                      style={{ cursor: 'pointer', background: isSelected ? '#eff6ff' : undefined }}
                      onClick={() => toggleOrder(box.shopify_order_id)}
                    >
                      <td onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOrder(box.shopify_order_id)}
                        />
                      </td>
                      <td style={{ fontWeight: 500 }}>
                        {box.shopify_order_number || box.shopify_order_id}
                      </td>
                      <td style={{ color: '#6b7280' }}>Box {box.box_number}</td>
                      <td>{box.box_type_name || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                      <td style={{ fontSize: 12 }}>
                        {(box.pick_skus || []).length === 0
                          ? <span style={{ color: '#9ca3af' }}>—</span>
                          : (box.pick_skus || []).map((sku, i) => {
                              const isTarget = sku.toLowerCase() === pickSku.toLowerCase()
                              return (
                                <span key={sku}>
                                  <span
                                    className="mono"
                                    style={isTarget
                                      ? { color: '#dc2626', fontWeight: 700 }
                                      : { color: '#6b7280' }}
                                  >
                                    {sku}
                                  </span>
                                  {i < box.pick_skus.length - 1 ? ', ' : ''}
                                </span>
                              )
                            })
                        }
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: '#dc2626' }}>
                        {fmt(box.target_qty)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {fmtGm(marginsMap[box.shopify_order_id])}
                      </td>
                      <td>{daysAgo(box.created_at_shopify) ?? '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtShortDate(box.created_at_shopify)}</td>
                      <td>
                        {box.customer_name || box.customer_email || '—'}
                        {box.shipping_province ? (
                          <span style={{ color: '#9ca3af', marginLeft: 6, fontSize: 11 }}>
                            {box.shipping_province}
                          </span>
                        ) : null}
                      </td>
                      <td style={{ fontSize: 11 }}>
                        {(box.tags || '').split(',').filter(t => t.trim()).map(t => (
                          <span key={t} className="tag-chip" style={{ marginRight: 2 }}>{t.trim()}</span>
                        ))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
