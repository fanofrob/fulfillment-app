import { Fragment, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ordersApi } from '../api'

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' })
}

function STATUS_LABEL(app_status) {
  return ({
    not_processed: 'Not Processed',
    staged: 'Staged',
    in_shipstation_not_shipped: 'In ShipStation',
    in_shipstation_shipped: 'Shipped',
    fulfilled: 'Fulfilled',
    partially_fulfilled: 'Partially Fulfilled',
  })[app_status] || app_status
}

export default function UnmappedSkus() {
  const qc = useQueryClient()
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['unmapped-skus'],
    queryFn: () => ordersApi.unmappedSkus(),
    refetchInterval: 60000,
  })

  const [expanded, setExpanded] = useState(() => new Set())

  const groups = data?.groups || []
  const totalSkus = data?.total_skus || 0
  const totalOrders = data?.total_orders || 0

  function toggle(sku) {
    setExpanded(s => {
      const n = new Set(s)
      if (n.has(sku)) n.delete(sku)
      else n.add(sku)
      return n
    })
  }

  function expandAll() {
    setExpanded(new Set(groups.map(g => g.shopify_sku)))
  }
  function collapseAll() {
    setExpanded(new Set())
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Unmapped SKUs</h1>
          <div style={{ color: '#6b7280', marginTop: 4, fontSize: 13 }}>
            Shopify SKUs without a warehouse mapping. Orders containing these can't be staged until the SKU is mapped.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => { qc.invalidateQueries({ queryKey: ['unmapped-skus'] }); refetch() }} disabled={isFetching}>
            {isFetching ? 'Refreshing…' : '↻ Refresh'}
          </button>
          <Link to="/sku-mapping" className="btn btn-primary" style={{ textDecoration: 'none' }}>
            Open SKU Mapping →
          </Link>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <div style={{ background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 6, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: '#92400e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>Unmapped SKUs</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#78350f' }}>{totalSkus}</div>
        </div>
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: '#991b1b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>Blocked Orders</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#7f1d1d' }}>{totalOrders}</div>
        </div>
      </div>

      {isLoading && <div style={{ color: '#6b7280' }}>Loading…</div>}
      {error && <div style={{ color: '#dc2626' }}>Failed to load: {String(error.message || error)}</div>}

      {!isLoading && !error && groups.length === 0 && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, padding: 16, color: '#166534' }}>
          ✓ No unmapped SKUs. All open orders have mapped SKUs.
        </div>
      )}

      {groups.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button className="btn btn-secondary" onClick={expandAll} style={{ fontSize: 12 }}>Expand all</button>
            <button className="btn btn-secondary" onClick={collapseAll} style={{ fontSize: 12 }}>Collapse all</button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: 'white', border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden' }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                <th style={th}>Shopify SKU</th>
                <th style={th}>Sample Title</th>
                <th style={th}>Warehouses</th>
                <th style={{ ...th, textAlign: 'right' }}>Blocked Orders</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const isOpen = expanded.has(g.shopify_sku)
                return (
                  <Fragment key={g.shopify_sku}>
                    <tr
                      onClick={() => toggle(g.shopify_sku)}
                      style={{ cursor: 'pointer', borderBottom: '1px solid #e5e7eb', background: isOpen ? '#fafafa' : 'white' }}
                    >
                      <td style={{ ...td, fontFamily: 'monospace', fontWeight: 600 }}>
                        <span style={{ display: 'inline-block', width: 14, color: '#6b7280' }}>{isOpen ? '▾' : '▸'}</span>
                        {g.shopify_sku}
                      </td>
                      <td style={{ ...td, color: '#4b5563' }}>{g.sample_title || '—'}</td>
                      <td style={td}>
                        {g.warehouses.length === 0
                          ? <span style={{ color: '#9ca3af' }}>—</span>
                          : g.warehouses.map(w => (
                              <span key={w} className="badge" style={{ marginRight: 4, fontSize: 11, background: '#e0e7ff', color: '#3730a3' }}>{w}</span>
                            ))}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: '#dc2626' }}>{g.order_count}</td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Link
                          to="/sku-mapping"
                          onClick={e => e.stopPropagation()}
                          style={{ fontSize: 12, color: '#2563eb', textDecoration: 'none' }}
                        >
                          Map SKU →
                        </Link>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr style={{ background: '#fafafa' }}>
                        <td colSpan={5} style={{ padding: 0, borderBottom: '1px solid #e5e7eb' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr style={{ color: '#6b7280' }}>
                                <th style={subTh}>Order #</th>
                                <th style={subTh}>Customer</th>
                                <th style={subTh}>Warehouse</th>
                                <th style={subTh}>Status</th>
                                <th style={subTh}>Date</th>
                                <th style={{ ...subTh, textAlign: 'right' }}>Qty</th>
                                <th style={{ ...subTh, textAlign: 'right' }}>Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.orders.map(o => (
                                <tr key={o.shopify_order_id} style={{ borderTop: '1px solid #e5e7eb' }}>
                                  <td style={subTd}>
                                    <Link to={`/orders?order=${o.shopify_order_id}`} style={{ color: '#2563eb', textDecoration: 'none', fontWeight: 600 }}>
                                      #{o.shopify_order_number}
                                    </Link>
                                  </td>
                                  <td style={subTd}>{o.customer_name || '—'}</td>
                                  <td style={subTd}>{o.warehouse || '—'}</td>
                                  <td style={subTd}>{STATUS_LABEL(o.app_status)}</td>
                                  <td style={subTd}>{fmtDate(o.order_date)}</td>
                                  <td style={{ ...subTd, textAlign: 'right' }}>{o.fulfillable_quantity}</td>
                                  <td style={{ ...subTd, textAlign: 'right' }}>${(o.total_price || 0).toFixed(2)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

const th = { padding: '10px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4 }
const td = { padding: '10px 12px', fontSize: 13, color: '#111827', verticalAlign: 'top' }
const subTh = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }
const subTd = { padding: '8px 12px' }
