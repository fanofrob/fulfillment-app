import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { packagingDashboardApi } from '../api'

const WAREHOUSES = ['walnut', 'northlake']

const ALERT_STYLES = {
  critical: { bg: '#fef2f2', border: '#fecaca', color: '#991b1b', label: 'CRITICAL' },
  warn:     { bg: '#fef3c7', border: '#fcd34d', color: '#78350f', label: 'LOW' },
  ok:       { bg: '#f0fdf4', border: '#bbf7d0', color: '#166534', label: 'OK' },
  no_data:  { bg: '#f3f4f6', border: '#d1d5db', color: '#6b7280', label: 'NO DATA' },
}

function AlertChip({ level }) {
  const style = ALERT_STYLES[level] || ALERT_STYLES.no_data
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
      background: style.bg, color: style.color, border: `1px solid ${style.border}`,
    }}>{style.label}</span>
  )
}

export default function PackagingDashboard() {
  const qc = useQueryClient()
  const [warehouse, setWarehouse] = useState('walnut')
  const [lookbackDays, setLookbackDays] = useState(30)
  const [alertWeeks, setAlertWeeks] = useState(2)
  const [targetWeeks, setTargetWeeks] = useState(4)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['packaging-dashboard', warehouse, lookbackDays, alertWeeks, targetWeeks],
    queryFn: () => packagingDashboardApi.get({
      warehouse,
      lookback_days: lookbackDays,
      alert_weeks: alertWeeks,
      target_weeks: targetWeeks,
    }),
  })

  const items = data?.items || []

  const summary = useMemo(() => {
    const counts = { critical: 0, warn: 0, ok: 0, no_data: 0 }
    let totalOrderQty = 0
    for (const it of items) {
      counts[it.alert_level] = (counts[it.alert_level] || 0) + 1
      totalOrderQty += it.order_qty_for_target_weeks || 0
    }
    return { counts, totalOrderQty }
  }, [items])

  return (
    <div>
      <div className="page-header-row">
        <div className="page-header">
          <h1>Packaging Dashboard</h1>
          <p>
            Tracks inventory burn rate for packaging SKUs (boxes, clamshells, labels, etc.).
            Usage is computed from <code>ship_deduct</code> adjustments over the lookback window.
            Order qty rounds up to hit the target weeks of cover.
          </p>
        </div>
        <div className="page-header-actions">
          <button onClick={() => refetch()} disabled={isFetching} className="btn btn-secondary">
            {isFetching ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="toolbar" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
        <label style={{ fontSize: 13 }}>
          Warehouse:{' '}
          <select value={warehouse} onChange={e => setWarehouse(e.target.value)}>
            {WAREHOUSES.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>

        <label style={{ fontSize: 13 }}>
          Lookback:{' '}
          <select value={lookbackDays} onChange={e => setLookbackDays(Number(e.target.value))}>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>

        <label style={{ fontSize: 13 }}>
          Alert when cover &lt;{' '}
          <input
            type="number"
            value={alertWeeks}
            onChange={e => setAlertWeeks(Math.max(0.1, Number(e.target.value)))}
            step="0.5"
            min="0.1"
            style={{ width: 60 }}
          /> wks
        </label>

        <label style={{ fontSize: 13 }}>
          Target supply:{' '}
          <input
            type="number"
            value={targetWeeks}
            onChange={e => setTargetWeeks(Math.max(0.1, Number(e.target.value)))}
            step="0.5"
            min="0.1"
            style={{ width: 60 }}
          /> wks
        </label>

        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
          {items.length} packaging SKU{items.length === 1 ? '' : 's'}
          {' · '}
          <span style={{ color: '#991b1b', fontWeight: 600 }}>{summary.counts.critical} critical</span>
          {' · '}
          <span style={{ color: '#78350f' }}>{summary.counts.warn} low</span>
          {' · '}
          <span style={{ color: '#166534' }}>{summary.counts.ok} ok</span>
          {summary.counts.no_data > 0 && (
            <>{' · '}<span style={{ color: '#6b7280' }}>{summary.counts.no_data} no data</span></>
          )}
        </span>
      </div>

      {summary.totalOrderQty > 0 && (
        <div style={{
          margin: '16px 0', padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe',
          borderRadius: 6, fontSize: 13, color: '#1e3a8a',
        }}>
          <strong>Total recommended order qty for {targetWeeks}-week supply: {summary.totalOrderQty.toLocaleString()} units</strong>
          {' '}across {items.filter(i => i.order_qty_for_target_weeks > 0).length} SKUs that need restock.
        </div>
      )}

      {isLoading && <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>}

      {!isLoading && items.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          No packaging SKUs found. Go to <Link to="/picklist-skus">Picklist SKUs</Link>, click <strong>+ New SKU</strong>,
          and set Inventory Type to <em>Packaging</em>.
        </div>
      )}

      {items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>Packaging SKU</th>
                <th>Description</th>
                <th style={{ textAlign: 'right' }}>On hand</th>
                <th style={{ textAlign: 'right' }} title={`Total units shipped over the last ${lookbackDays} days`}>
                  Used ({lookbackDays}d)
                </th>
                <th style={{ textAlign: 'right' }}>Weekly avg</th>
                <th style={{ textAlign: 'right' }}>Weeks of cover</th>
                <th>Alert</th>
                <th style={{ textAlign: 'right' }} title={`Qty needed to reach ${targetWeeks} weeks of supply`}>
                  Order for {targetWeeks}w
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => {
                const rowBg = it.alert_level === 'critical' ? '#fef2f2'
                  : it.alert_level === 'warn' ? '#fffbeb'
                  : 'transparent'
                return (
                  <tr key={it.pick_sku} style={{ background: rowBg }}>
                    <td className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{it.pick_sku}</td>
                    <td style={{ fontSize: 13 }}>{it.description || <span style={{ color: '#d1d5db' }}>—</span>}</td>
                    <td style={{ textAlign: 'right', fontSize: 13 }}>{it.on_hand_qty.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontSize: 13 }}>{it.units_used.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontSize: 13 }}>{it.weekly_avg.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontSize: 13, fontWeight: it.alert_level === 'critical' ? 700 : 400 }}>
                      {it.weeks_of_cover != null ? it.weeks_of_cover.toFixed(2) : <span style={{ color: '#d1d5db' }}>—</span>}
                    </td>
                    <td><AlertChip level={it.alert_level} /></td>
                    <td style={{ textAlign: 'right', fontSize: 13, fontWeight: it.order_qty_for_target_weeks > 0 ? 600 : 400 }}>
                      {it.order_qty_for_target_weeks > 0
                        ? it.order_qty_for_target_weeks.toLocaleString()
                        : <span style={{ color: '#d1d5db' }}>0</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
