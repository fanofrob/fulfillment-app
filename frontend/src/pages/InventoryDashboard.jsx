import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { inventoryApi } from '../api'

const WAREHOUSES = ['walnut', 'northlake']

function fmt(n) {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

// ── Section A: Inventory Pivot ─────────────────────────────────────────────────

function InventoryPivot({ items }) {
  const nonZero = [...items]
    .filter(i => i.available_qty !== 0)
    .sort((a, b) => b.available_qty - a.available_qty)

  const grandTotal = nonZero.reduce((s, i) => s + i.available_qty, 0)

  return (
    <div className="inv-dash-panel">
      <div className="inv-dash-panel-header">Inventory Pivot</div>
      <table className="inv-dash-table">
        <thead>
          <tr>
            <th>Pick SKU</th>
            <th style={{ textAlign: 'right' }}>Available Qty</th>
          </tr>
        </thead>
        <tbody>
          {nonZero.map(item => (
            <tr key={item.pick_sku} className={item.available_qty < 0 ? 'row-neg' : 'row-pos'}>
              <td className="mono">{item.pick_sku}</td>
              <td style={{ textAlign: 'right', fontWeight: item.available_qty < 0 ? 600 : 400 }}>
                {fmt(item.available_qty)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="row-grand-total">
            <td>Grand Total</td>
            <td style={{ textAlign: 'right' }}>{fmt(grandTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Section B: Issue SKUs ──────────────────────────────────────────────────────

function IssueSkus({ analysis }) {
  // Only pick SKUs where ending balance (on_hand - total_demand) < 0
  const issues = analysis
    .filter(a => a.on_hand_qty - a.total_demand < 0)
    .sort((a, b) => (a.on_hand_qty - a.total_demand) - (b.on_hand_qty - b.total_demand))

  const grandMin = issues.length
    ? Math.min(...issues.map(a => a.on_hand_qty - a.total_demand))
    : 0

  return (
    <div className="inv-dash-panel">
      <div className="inv-dash-panel-header">Issue SKU</div>
      <table className="inv-dash-table">
        <thead>
          <tr>
            <th>Pick SKU</th>
            <th>Shopify SKU</th>
            <th style={{ textAlign: 'right' }}>Ending Balance</th>
          </tr>
        </thead>
        <tbody>
          {issues.map(item => {
            const ending = item.on_hand_qty - item.total_demand
            return (
              <>
                {/* Pick SKU group header */}
                <tr key={`${item.pick_sku}-hdr`} className="row-group-header">
                  <td className="mono">{item.pick_sku}</td>
                  <td />
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(ending)}</td>
                </tr>
                {/* Shopify SKU detail rows */}
                {item.shopify_sku_breakdown.map((b, i) => (
                  <tr key={`${item.pick_sku}-${i}`} className="row-shopify-detail">
                    <td />
                    <td className="mono" style={{ color: '#4f8ef7', paddingLeft: 16 }}>{b.shopify_sku}</td>
                    <td style={{ textAlign: 'right', color: '#c0392b' }}>{fmt(ending)}</td>
                  </tr>
                ))}
                {/* Group total */}
                <tr key={`${item.pick_sku}-total`} className="row-group-total">
                  <td colSpan={2} style={{ textAlign: 'right', fontStyle: 'italic' }}>
                    {item.pick_sku} Total
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmt(ending)}</td>
                </tr>
              </>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="row-grand-total">
            <td colSpan={2}>Grand Total</td>
            <td style={{ textAlign: 'right' }}>{fmt(grandMin)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Section C: Inventory Transaction / Committed ───────────────────────────────

function InventoryTransactions({ analysis }) {
  const rows = analysis
    .filter(a => a.total_demand > 0)
    .map(a => ({
      pick_sku: a.pick_sku,
      staged_qty: a.total_demand,
      ending: a.on_hand_qty - a.total_demand,
      deduction: -a.total_demand,
    }))
    .sort((a, b) => a.ending - b.ending)

  const grandQty = rows.reduce((s, r) => s + r.staged_qty, 0)
  const grandEnding = rows.length ? Math.min(...rows.map(r => r.ending)) : 0
  const grandDeduct = -grandQty

  return (
    <div className="inv-dash-panel">
      <div className="inv-dash-panel-header">Inventory Transaction / Committed</div>
      <table className="inv-dash-table">
        <thead>
          <tr>
            <th>Pick SKU</th>
            <th style={{ textAlign: 'right' }}>Staged Qty</th>
            <th style={{ textAlign: 'right' }}>Ending Balance</th>
            <th style={{ textAlign: 'right' }}>Qty Deduction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.pick_sku} className={r.ending < 0 ? 'row-neg' : 'row-pos'}>
              <td className="mono">{r.pick_sku}</td>
              <td style={{ textAlign: 'right' }}>{fmt(r.staged_qty)}</td>
              <td style={{ textAlign: 'right', fontWeight: r.ending < 0 ? 600 : 400 }}>
                {fmt(r.ending)}
              </td>
              <td style={{ textAlign: 'right', color: '#888' }}>{fmt(r.deduction)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="row-grand-total">
            <td>Grand Total</td>
            <td style={{ textAlign: 'right' }}>{fmt(grandQty)}</td>
            <td style={{ textAlign: 'right' }}>{fmt(grandEnding)}</td>
            <td style={{ textAlign: 'right' }}>{fmt(grandDeduct)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

const HEALTH_FILTERS = [
  { key: 'all', label: 'All Staged Orders' },
  { key: 'ok', label: 'No Errors', color: '#16a34a' },
  { key: 'errors', label: 'With Errors', color: '#dc2626' },
]

export default function InventoryDashboard() {
  const [warehouse, setWarehouse] = useState('walnut')
  const [healthFilter, setHealthFilter] = useState('all') // 'all' | 'ok' | 'errors'

  const { data: items = [], isLoading: loadingItems } = useQuery({
    queryKey: ['inventory-items', warehouse],
    queryFn: () => inventoryApi.listItems(warehouse),
    staleTime: 60000,
  })

  const { data: analysis = [], isLoading: loadingAnalysis, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['demand-analysis', warehouse, 'staged', healthFilter],
    queryFn: () => inventoryApi.demandAnalysis(warehouse, 'staged', healthFilter),
    staleTime: 60000,
  })

  const { data: shortages = [] } = useQuery({
    queryKey: ['staged-shortages', warehouse],
    queryFn: () => inventoryApi.stagedShortages(warehouse),
    staleTime: 30000,
  })

  const filteredShortages = useMemo(() => {
    if (healthFilter === 'errors') return shortages.filter(s => s.has_shortage)
    if (healthFilter === 'ok') return shortages.filter(s => !s.has_shortage)
    return shortages
  }, [shortages, healthFilter])

  const isLoading = loadingItems || loadingAnalysis
  const issueCount = analysis.filter(a => a.on_hand_qty - a.total_demand < 0).length

  return (
    <div>
      {/* Header */}
      <div className="page-header-row">
        <div className="page-header">
          <h1>Inventory Dashboard</h1>
          <p>
            Pivot of current available quantities, issue SKUs where staged orders would go negative,
            and ending balances if the staged batch is committed.
          </p>
        </div>
        <div className="page-header-actions">
          {dataUpdatedAt > 0 && (
            <span style={{ fontSize: 12, color: '#aaa' }}>
              Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
            </span>
          )}
          <button onClick={() => refetch()} disabled={isFetching} className="btn btn-secondary">
            {isFetching ? 'Refreshing…' : '↺ Refresh'}
          </button>
        </div>
      </div>

      {/* Health filter tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        {HEALTH_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setHealthFilter(f.key)}
            className={`wh-tab${healthFilter === f.key ? ' active' : ''}`}
            style={healthFilter === f.key && f.color ? { color: f.color } : {}}
          >
            {f.key === 'all'
              ? `${f.label} (${shortages.length})`
              : f.key === 'ok'
              ? `${f.label} (${shortages.filter(s => !s.has_shortage).length})`
              : `${f.label} (${shortages.filter(s => s.has_shortage).length})`}
          </button>
        ))}
      </div>

      {/* Warehouse tabs */}
      <div className="wh-tabs">
        {WAREHOUSES.map(wh => (
          <button
            key={wh}
            onClick={() => setWarehouse(wh)}
            className={`wh-tab${warehouse === wh ? ' active' : ''}`}
          >
            {wh.charAt(0).toUpperCase() + wh.slice(1)}
          </button>
        ))}
      </div>

      {/* Summary stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-num">{items.filter(i => i.available_qty !== 0).length}</div>
          <div className="stat-label">Non-Zero SKUs</div>
        </div>
        <div className="stat-card">
          <div className={`stat-num ${issueCount > 0 ? 'qty-zero' : 'qty-ok'}`}>
            {issueCount}
          </div>
          <div className="stat-label">Issue SKUs</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">
            {analysis.filter(a => a.total_demand > 0).length}
          </div>
          <div className="stat-label">SKUs with Staged Demand</div>
        </div>
      </div>

      {isLoading ? (
        <div className="loading">Loading inventory dashboard…</div>
      ) : (
        <>
        <div className="inv-dash-grid">
          <InventoryPivot items={items} />
          <IssueSkus analysis={analysis} />
          <InventoryTransactions analysis={analysis} />
        </div>

        {/* Per-order shortage view */}
        {filteredShortages.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#374151' }}>Staged Orders — Inventory Status</div>
            </div>
            <div className="inv-dash-panel">
              <table className="inv-dash-table">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Status</th>
                    <th>Short SKUs</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredShortages.map(s => (
                    <tr key={s.shopify_order_id} className={s.has_shortage ? 'row-neg' : 'row-pos'}>
                      <td className="mono" style={{ fontWeight: 600 }}>{s.shopify_order_number || s.shopify_order_id}</td>
                      <td>
                        {s.has_shortage ? (
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', background: '#fef2f2', padding: '2px 8px', borderRadius: 4, border: '1px solid #fca5a5' }}>
                            ⚠ Shortage
                          </span>
                        ) : s.no_plan ? (
                          <span style={{ fontSize: 11, color: '#d97706', background: '#fffbeb', padding: '2px 8px', borderRadius: 4, border: '1px solid #fcd34d' }}>
                            No Plan
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#16a34a', background: '#f0fdf4', padding: '2px 8px', borderRadius: 4, border: '1px solid #bbf7d0' }}>
                            ✓ OK
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {s.shortage_skus.length > 0 ? (
                          <span style={{ color: '#dc2626' }}>
                            {s.shortage_skus.map(sk => `${sk.pick_sku} (avail ${sk.available}, need ${sk.needed})`).join(', ')}
                          </span>
                        ) : (
                          <span style={{ color: '#9ca3af' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  )
}
