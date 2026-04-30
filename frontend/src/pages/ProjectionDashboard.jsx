import { useState, useMemo, Fragment, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table'
import { projectionsApi, projectionPeriodsApi, projectionConfirmedOrdersApi } from '../api'

const STATUS_BG = { short: '#fef2f2', long: '#fffbeb', ok: '#f0fdf4' }
const STATUS_COLOR = { short: '#dc2626', long: '#d97706', ok: '#16a34a' }
const STATUS_LABEL = { short: 'Short', long: 'Long', ok: 'OK' }

const EMPTY_CREATE_FORM = {
  name: '', start_datetime: '', end_datetime: '',
  fulfillment_start: '', fulfillment_end: '',
  status: 'draft', sku_mapping_sheet_tab: '', previous_period_id: '',
  notes: '',
}

function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatLbs(v) { return v != null ? v.toFixed(1) : '—' }
function formatCases(v) { return v != null ? Math.ceil(v) : '—' }
function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}
function formatDateShort(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}
function formatDayOnly(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric' })
}

// ── Summary Bar ─────────────────────────────────────────────────────────────

function MappingUsedBadge({ breakdown }) {
  // Hover-to-expand. Single tab → show its name; multiple → "Mixed (N tabs)".
  const [open, setOpen] = useState(false)
  if (!breakdown || breakdown.length === 0) return null
  const isMixed = breakdown.length > 1
  const label = isMixed
    ? `Mixed (${breakdown.length} tabs)`
    : (breakdown[0].mapping_tab || '(none)')
  return (
    <span
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        style={{
          padding: '1px 6px', borderRadius: 999, fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
          background: isMixed ? '#fef3c7' : '#ecfeff',
          color: isMixed ? '#92400e' : '#0e7490',
          border: '1px solid',
          borderColor: isMixed ? '#fde68a' : '#a5f3fc',
          cursor: 'help',
        }}
      >
        {label}
      </span>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
            boxShadow: '0 6px 16px rgba(0,0,0,0.12)', padding: '8px 12px',
            minWidth: 220, fontSize: 12, color: '#374151', whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 6, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Confirmed orders by mapping
          </div>
          {breakdown.map(b => (
            <div key={b.mapping_tab || '__none__'} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '2px 0' }}>
              <span style={{ fontFamily: 'monospace', color: '#1e40af' }}>{b.mapping_tab || '(none)'}</span>
              <span style={{ color: '#6b7280' }}>{b.count} order{b.count !== 1 ? 's' : ''}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

function SummaryBar({ projection, period, onRegenerate, isRegenerating }) {
  const projectionId = projection?.id
  const { data: histSummary } = useQuery({
    queryKey: ['historical-summary', projectionId],
    queryFn: () => projectionsApi.getHistoricalSummary(projectionId),
    enabled: !!projectionId,
  })

  // mapping_used breakdown — surfaces which sheet tab(s) the period's confirmed
  // orders were captured under. Only meaningful when manual confirmed demand is
  // in play; for AUTO periods the rollup will be empty.
  const periodId = period?.id
  const { data: confirmedRollup } = useQuery({
    queryKey: ['confirmed-demand-rollup', periodId],
    queryFn: () => projectionConfirmedOrdersApi.getRollup(periodId),
    enabled: !!periodId,
  })
  const mappingBreakdown = confirmedRollup?.mapping_used_breakdown || []

  const existingMultiplier = projection?.parameters?.demand_multiplier ?? null
  const historicalAvg = histSummary?.overall_avg_orders_per_day || 0
  const [projectedPerDay, setProjectedPerDay] = useState('')

  useEffect(() => {
    const next = existingMultiplier != null && historicalAvg > 0
      ? Math.round(historicalAvg * existingMultiplier)
      : ''
    setProjectedPerDay(next)
  }, [projectionId, historicalAvg, existingMultiplier])

  if (!projection) return null
  const { total_confirmed_demand_lbs, total_projected_demand_lbs, total_demand_lbs, lines } = projection
  const totalOnHand = (lines || []).reduce((s, l) => s + (l.on_hand_lbs || 0), 0)
  const totalGap = (lines || []).reduce((s, l) => s + (l.gap_lbs || 0), 0)
  const shortCount = (lines || []).filter(l => l.gap_status === 'short').length
  const longCount = (lines || []).filter(l => l.gap_status === 'long').length
  const isManual = !!period?.has_manual_confirmed_demand

  const projectedNum = parseFloat(projectedPerDay)
  const computedMultiplier = (historicalAvg > 0 && projectedNum > 0)
    ? projectedNum / historicalAvg
    : null
  const pctDelta = computedMultiplier != null ? (computedMultiplier - 1) * 100 : null

  function handleApply() {
    if (computedMultiplier == null) return
    onRegenerate && onRegenerate({ demand_multiplier: computedMultiplier })
  }
  function handleReset() {
    setProjectedPerDay('')
    onRegenerate && onRegenerate({ demand_multiplier: null })
  }

  return (
    <>
      <div className="proj-summary-bar">
        <div className="proj-summary-item">
          <span className="proj-summary-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Confirmed
            <span
              style={{
                padding: '1px 6px', borderRadius: 999, fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                background: isManual ? '#dbeafe' : '#f3f4f6',
                color: isManual ? '#1e40af' : '#6b7280',
              }}
              title={
                isManual
                  ? `Manual confirmed demand saved${period.confirmed_demand_saved_at ? ' at ' + new Date(period.confirmed_demand_saved_at).toLocaleString() : ''}`
                  : 'Auto-calculated confirmed demand (no manual override)'
              }
            >
              {isManual ? 'MANUAL' : 'AUTO'}
            </span>
            {mappingBreakdown.length > 0 && (
              <MappingUsedBadge breakdown={mappingBreakdown} />
            )}
          </span>
          <span className="proj-summary-value">{formatLbs(total_confirmed_demand_lbs)} lbs</span>
        </div>
        <div className="proj-summary-item">
          <span className="proj-summary-label">Projected</span>
          <span className="proj-summary-value">{formatLbs(total_projected_demand_lbs)} lbs</span>
        </div>
        <div className="proj-summary-item">
          <span className="proj-summary-label">Total Demand</span>
          <span className="proj-summary-value" style={{ fontWeight: 700 }}>{formatLbs(total_demand_lbs)} lbs</span>
        </div>
        <div className="proj-summary-item">
          <span className="proj-summary-label">On Hand</span>
          <span className="proj-summary-value">{formatLbs(totalOnHand)} lbs</span>
        </div>
        <div className="proj-summary-item">
          <span className="proj-summary-label">Total Gap</span>
          <span className="proj-summary-value" style={{ color: totalGap > 0 ? '#dc2626' : '#16a34a' }}>
            {formatLbs(totalGap)} lbs
          </span>
        </div>
        <div className="proj-summary-item">
          <span className="proj-summary-label">Flags</span>
          <span className="proj-summary-value">
            {shortCount > 0 && <span className="badge" style={{ background: STATUS_BG.short, color: STATUS_COLOR.short, marginRight: 4 }}>{shortCount} short</span>}
            {longCount > 0 && <span className="badge" style={{ background: STATUS_BG.long, color: STATUS_COLOR.long, marginRight: 4 }}>{longCount} long</span>}
            {shortCount === 0 && longCount === 0 && <span style={{ color: '#16a34a' }}>All OK</span>}
          </span>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 11, color: '#999' }}>
          Generated {formatDateShort(projection.generated_at)}
        </div>
      </div>

      {/* Historical forecast panel */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8,
        padding: '10px 14px', margin: '8px 0 12px', fontSize: 12,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Historical Range
          </span>
          <span style={{ fontWeight: 600, color: '#334155' }}>
            {histSummary
              ? `${formatDayOnly(histSummary.historical_range_start)} – ${formatDayOnly(histSummary.historical_range_end)} (${histSummary.overall_days}d)`
              : 'Loading…'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          {(histSummary?.weekly_breakdown || []).map(w => {
            const dwd = w.days_with_data ?? w.days
            const noData = dwd === 0
            const partial = dwd > 0 && dwd < w.days
            const tooltip =
              `${formatDayOnly(w.week_start)} – ${formatDayOnly(w.week_end)} · ` +
              `${w.total_orders} orders across ${dwd}/${w.days} days with data` +
              (noData ? ' — no data ingested for this week' :
               partial ? ' — partial ingestion; avg uses days with data only' : '')
            return (
              <div
                key={w.week_number}
                title={tooltip}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  padding: '4px 10px',
                  background: noData ? '#fef3c7' : partial ? '#fffbeb' : '#fff',
                  border: `1px solid ${noData ? '#f59e0b' : partial ? '#fcd34d' : '#e2e8f0'}`,
                  borderRadius: 6, minWidth: 58,
                }}
              >
                <span style={{ fontSize: 10, color: '#64748b', fontWeight: 600 }}>W{w.week_number}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: noData ? '#92400e' : '#1e293b' }}>
                  {noData ? 'N/A' : w.avg_orders_per_day}
                </span>
                <span style={{ fontSize: 9, color: '#94a3b8' }}>
                  {noData ? 'no data' : partial ? `${dwd}/${w.days}d` : 'orders/d'}
                </span>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Historical Avg
          </span>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#0f172a' }}>
            {historicalAvg} <span style={{ fontSize: 10, fontWeight: 500, color: '#94a3b8' }}>orders/day</span>
          </span>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto',
          borderLeft: '1px solid #e2e8f0', paddingLeft: 16,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Projected Orders/Day
            </span>
            <input
              type="number"
              min="0"
              step="1"
              value={projectedPerDay}
              onChange={e => setProjectedPerDay(e.target.value)}
              placeholder={historicalAvg ? String(historicalAvg) : '—'}
              style={{
                width: 80, padding: '4px 8px', fontSize: 13, fontWeight: 600,
                border: '1px solid #cbd5e1', borderRadius: 6,
              }}
            />
          </div>
          {pctDelta != null && (
            <div style={{
              padding: '3px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
              background: pctDelta > 0 ? '#dcfce7' : pctDelta < 0 ? '#fee2e2' : '#f1f5f9',
              color: pctDelta > 0 ? '#15803d' : pctDelta < 0 ? '#b91c1c' : '#475569',
            }}>
              {pctDelta > 0 ? '+' : ''}{pctDelta.toFixed(1)}%
            </div>
          )}
          <button
            className="btn btn-sm btn-primary"
            onClick={handleApply}
            disabled={computedMultiplier == null || isRegenerating}
            title="Re-generate projection using this orders/day target"
          >
            {isRegenerating ? 'Applying…' : 'Apply'}
          </button>
          {existingMultiplier != null && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={handleReset}
              disabled={isRegenerating}
              title="Re-generate without multiplier"
            >
              Reset
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// ── Shop-wide Hourly Orders Chart (top of Projection tab) ───────────────────

function ShopHourlyOrdersChart({ projectionId }) {
  const { data, isLoading } = useQuery({
    queryKey: ['shop-hourly-breakdown', projectionId],
    queryFn: () => projectionsApi.getShopHourlyBreakdown(projectionId),
    enabled: !!projectionId,
  })

  if (isLoading) return <div style={{ padding: 12, color: '#999' }}>Loading shop hourly orders...</div>
  if (!data?.hours?.length) return null

  const byDay = {}
  for (const h of data.hours) {
    const d = new Date(h.hour)
    const dayKey = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    if (!byDay[dayKey]) byDay[dayKey] = []
    byDay[dayKey].push(h)
  }

  const maxOrders = Math.max(...data.hours.map(h => h.projected_orders), 1)
  const totalOrders = data.hours.reduce((s, h) => s + h.projected_orders, 0)

  return (
    <div className="hourly-breakdown-panel" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
        Shop-wide Hourly Projected Orders
        <span style={{ fontSize: 11, color: '#777', fontWeight: 400, marginLeft: 8 }}>
          remaining {totalOrders.toFixed(0)} orders across {data.hours.length} hours
        </span>
      </div>
      {Object.entries(byDay).map(([day, hours]) => (
        <div key={day} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 4 }}>{day}</div>
          <div className="hourly-grid">
            {hours.map((h, i) => {
              const d = new Date(h.hour)
              const pct = maxOrders > 0 ? (h.projected_orders / maxOrders) * 100 : 0
              return (
                <div key={i} className="hourly-bar-cell" title={`${h.projected_orders.toFixed(1)} orders`}>
                  <div className="hourly-bar-track">
                    <div className="hourly-bar-fill" style={{ height: `${Math.max(2, pct)}%` }} />
                  </div>
                  <div className="hourly-bar-label">{d.getHours() % 12 || 12}{d.getHours() < 12 ? 'a' : 'p'}</div>
                  <div className="hourly-bar-value">{h.projected_orders >= 0.5 ? h.projected_orders.toFixed(0) : ''}</div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}


// ── Per-PT Daily History Grid (expanded row, replaces hourly chart) ─────────

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function PtDailyHistory({ projectionId, productType }) {
  const { data, isLoading } = useQuery({
    queryKey: ['pt-daily-history', projectionId, productType],
    queryFn: () => projectionsApi.getPtDailyHistory(projectionId, productType),
    enabled: !!projectionId && !!productType,
  })

  if (isLoading) return <div style={{ padding: 12, color: '#999' }}>Loading daily history...</div>
  if (!data?.weeks?.length) {
    return <div style={{ padding: 12, color: '#aaa', fontStyle: 'italic' }}>No historical data for this product type.</div>
  }

  const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'
  const fmtDateLong = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  // Cell color intensity vs the max single-day lbs
  let maxDayLbs = 0
  for (const w of data.weeks) for (const d of w.days) if (d.lbs > maxDayLbs) maxDayLbs = d.lbs

  const cellBg = (lbs) => {
    if (lbs <= 0 || maxDayLbs <= 0) return '#fff'
    const intensity = Math.min(1, lbs / maxDayLbs)
    const alpha = 0.08 + intensity * 0.45
    return `rgba(37, 99, 235, ${alpha.toFixed(2)})`
  }

  const dowAvgByDow = {}
  for (const da of data.dow_averages || []) dowAvgByDow[da.dow] = da

  return (
    <div className="hourly-breakdown-panel">
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
        Daily Historical Demand: {productType}
        <span style={{ fontSize: 11, color: '#777', fontWeight: 400, marginLeft: 8 }}>
          range: {fmtDateLong(data.historical_range_start)} → {fmtDateLong(data.historical_range_end)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>
        Use these per-day pounds to size a manual <code>lbs/day</code> override. Overall avg:{' '}
        <strong>{data.overall_avg_lbs_per_day.toFixed(1)} lbs/day</strong>
      </div>

      <table style={{ fontSize: 12, width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#555', borderBottom: '1px solid #e5e7eb' }}>
            <th style={{ padding: '6px 8px', width: 110 }}>Week</th>
            {DOW_LABELS.map(l => (
              <th key={l} style={{ padding: '6px 8px', textAlign: 'right' }}>{l}</th>
            ))}
            <th style={{ padding: '6px 8px', textAlign: 'right', borderLeft: '1px solid #e5e7eb' }}>Avg lbs/day</th>
          </tr>
        </thead>
        <tbody>
          {data.weeks.map(w => {
            const byDow = {}
            for (const d of w.days) byDow[d.dow] = d
            return (
              <tr key={w.week_number} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '6px 8px', color: '#555' }}>
                  <div style={{ fontWeight: 500 }}>Week {w.week_number}</div>
                  <div style={{ fontSize: 10, color: '#999' }}>
                    {fmtDate(w.week_start)} – {fmtDate(new Date(new Date(w.week_end).getTime() - 86400000).toISOString())}
                  </div>
                </td>
                {[0, 1, 2, 3, 4, 5, 6].map(dow => {
                  const d = byDow[dow]
                  const lbs = d?.lbs ?? 0
                  const present = !!d
                  return (
                    <td
                      key={dow}
                      style={{
                        padding: '6px 8px',
                        textAlign: 'right',
                        background: present ? cellBg(lbs) : '#f9fafb',
                        color: present && lbs > 0 ? '#111' : '#bbb',
                        fontFeatureSettings: '"tnum"',
                      }}
                      title={d ? `${new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}: ${lbs.toFixed(1)} lbs` : 'no data'}
                    >
                      {present ? (lbs > 0 ? lbs.toFixed(1) : '0') : '—'}
                    </td>
                  )
                })}
                <td style={{
                  padding: '6px 8px', textAlign: 'right', fontWeight: 600,
                  borderLeft: '1px solid #e5e7eb',
                }}>
                  {w.avg_lbs_per_day.toFixed(1)}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 600 }}>
            <td style={{ padding: '6px 8px', color: '#555' }}>Avg by day</td>
            {[0, 1, 2, 3, 4, 5, 6].map(dow => {
              const da = dowAvgByDow[dow]
              return (
                <td key={dow} style={{ padding: '6px 8px', textAlign: 'right', color: '#111' }}>
                  {da ? da.avg_lbs.toFixed(1) : '—'}
                </td>
              )
            })}
            <td style={{ padding: '6px 8px', textAlign: 'right', borderLeft: '1px solid #e5e7eb' }}>
              {data.overall_avg_lbs_per_day.toFixed(1)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── SKU Diagnostics ─────────────────────────────────────────────────────────

const COVERAGE_DOT = { green: '#16a34a', yellow: '#eab308', red: '#dc2626' }
const COVERAGE_LABEL = { green: 'Good', yellow: 'Sparse / gappy', red: 'Insufficient' }

function CoverageBadge({ coverage, title }) {
  if (!coverage) return null
  return (
    <span
      title={title || COVERAGE_LABEL[coverage]}
      style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: COVERAGE_DOT[coverage], marginRight: 6, verticalAlign: 'middle',
      }}
    />
  )
}

function SkuDiagnostics({ projectionId, productType }) {
  const { data, isLoading } = useQuery({
    queryKey: ['sku-diagnostics', projectionId, productType],
    queryFn: () => projectionsApi.getSkuDiagnostics(projectionId, productType),
    enabled: !!projectionId && !!productType,
  })

  const [expandedSku, setExpandedSku] = useState(null)

  if (isLoading) return <div style={{ padding: 12, color: '#999' }}>Loading SKU diagnostics...</div>
  if (!data?.skus?.length) {
    return <div style={{ padding: 12, color: '#aaa', fontStyle: 'italic' }}>No SKUs mapped to this product type.</div>
  }

  const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'
  const fmtDateLong = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  return (
    <div style={{ padding: '12px 16px', borderTop: '1px solid #e5e7eb', background: '#fff' }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
        Per-SKU History Diagnostics
        <span style={{ fontSize: 11, color: '#777', fontWeight: 400, marginLeft: 8 }}>
          range: {fmtDateLong(data.historical_range_start)} → {fmtDateLong(data.historical_range_end)}
        </span>
      </div>

      <table className="sku-diag-table" style={{ fontSize: 12, width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#555', borderBottom: '1px solid #e5e7eb' }}>
            <th style={{ padding: '6px 8px', width: 28 }}></th>
            <th style={{ padding: '6px 8px' }}>Shopify SKU</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Active wks</th>
            <th style={{ padding: '6px 8px' }}>First seen</th>
            <th style={{ padding: '6px 8px' }}>Last seen</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Longest gap</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Zero-sale days</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Qty</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Orders</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Hist. lbs</th>
            <th style={{ padding: '6px 8px' }}>mix_qty</th>
          </tr>
        </thead>
        <tbody>
          {data.skus.map((s, i) => {
            const key = `${s.shopify_sku}-${i}`
            const canExpand = s.zero_sales_dates?.length > 0
            const isExpanded = expandedSku === key
            return (
              <Fragment key={key}>
                <tr
                  onClick={() => canExpand && setExpandedSku(isExpanded ? null : key)}
                  style={{
                    borderBottom: '1px solid #f1f5f9',
                    cursor: canExpand ? 'pointer' : 'default',
                    background: isExpanded ? '#f8fafc' : undefined,
                  }}
                >
                  <td style={{ padding: '6px 8px' }}>
                    <CoverageBadge coverage={s.coverage} />
                  </td>
                  <td style={{ padding: '6px 8px', fontFamily: 'ui-monospace, monospace' }}>
                    {s.shopify_sku}
                    {s.first_seen_days_ago != null && s.first_seen_days_ago < 14 && (
                      <span style={{ fontSize: 10, color: '#d97706', marginLeft: 6 }}>
                        new ({s.first_seen_days_ago.toFixed(0)}d)
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{s.active_weeks}</td>
                  <td style={{ padding: '6px 8px' }}>{fmtDate(s.first_seen)}</td>
                  <td style={{ padding: '6px 8px' }}>{fmtDate(s.last_seen)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {s.longest_gap_days != null
                      ? (s.longest_gap_days > 7
                          ? <span style={{ color: '#d97706', fontWeight: 600 }}>{s.longest_gap_days}d</span>
                          : `${s.longest_gap_days}d`)
                      : '—'}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {s.zero_sales_day_count > 0
                      ? <span style={{ color: canExpand ? '#2563eb' : '#777', textDecoration: canExpand ? 'underline' : 'none' }}>
                          {s.zero_sales_day_count}
                        </span>
                      : '0'}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{s.total_qty}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{s.total_orders}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 500 }}>
                    {s.historical_lbs_contribution.toFixed(1)}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#777' }}>{s.mix_quantity}</td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={11} style={{ padding: '8px 16px 12px 40px', background: '#f8fafc', fontSize: 11, color: '#555' }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        Days with zero sales ({s.zero_sales_dates.length}):
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {s.zero_sales_dates.map(d => (
                          <span key={d} style={{
                            padding: '2px 6px', background: '#fef2f2', color: '#991b1b',
                            border: '1px solid #fecaca', borderRadius: 3,
                          }}>
                            {new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 10, color: '#999', marginTop: 8 }}>
        🟢 ≥3 active weeks, no gap >7d, established • 🟡 sparse / gappy / new (3–14d) • 🔴 no data or &lt;3 days old.
        Click a row's zero-sale count to see the missing dates.
      </div>
    </div>
  )
}

// ── Per-product-type Override Modal ─────────────────────────────────────────

function isoToDateInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function OverrideModal({ periodId, productType, existing, onClose, onSaved }) {
  // Mode: 'default' (no override), 'weeks', 'range', 'manual'
  const initialMode = !existing
    ? 'default'
    : existing.manual_daily_lbs != null ? 'manual'
    : existing.custom_range_start ? 'range'
    : existing.historical_weeks != null ? 'weeks'
    : 'default'

  const [mode, setMode] = useState(initialMode)
  const [weeks, setWeeks] = useState(existing?.historical_weeks ?? 4)
  const [rangeStart, setRangeStart] = useState(isoToDateInput(existing?.custom_range_start))
  const [rangeEnd, setRangeEnd] = useState(isoToDateInput(existing?.custom_range_end))
  const [manualLbs, setManualLbs] = useState(existing?.manual_daily_lbs ?? '')
  const [applyDemand, setApplyDemand] = useState(existing?.apply_demand_multiplier ?? false)
  const [applyPromo, setApplyPromo] = useState(existing?.apply_promotion_multiplier ?? true)
  const [applyPadding, setApplyPadding] = useState(existing?.apply_padding ?? true)
  const [error, setError] = useState(null)

  const qc = useQueryClient()

  const upsertMut = useMutation({
    mutationFn: (body) => projectionsApi.upsertOverride(periodId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['overrides', periodId] })
      onSaved && onSaved()
      onClose()
    },
    onError: (err) => setError(err?.response?.data?.detail || err.message),
  })

  const deleteMut = useMutation({
    mutationFn: () => projectionsApi.deleteOverride(periodId, productType),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['overrides', periodId] })
      onSaved && onSaved()
      onClose()
    },
    onError: (err) => setError(err?.response?.data?.detail || err.message),
  })

  function save() {
    setError(null)
    const body = {
      product_type: productType,
      historical_weeks: null,
      custom_range_start: null,
      custom_range_end: null,
      manual_daily_lbs: null,
      apply_demand_multiplier: applyDemand,
      apply_promotion_multiplier: applyPromo,
      apply_padding: applyPadding,
    }
    if (mode === 'weeks') {
      const n = parseInt(weeks, 10)
      if (!n || n <= 0) { setError('Weeks must be a positive integer'); return }
      body.historical_weeks = n
    } else if (mode === 'range') {
      if (!rangeStart || !rangeEnd) { setError('Both start and end dates are required'); return }
      body.custom_range_start = new Date(rangeStart + 'T00:00:00').toISOString()
      body.custom_range_end = new Date(rangeEnd + 'T23:59:59').toISOString()
    } else if (mode === 'manual') {
      const n = parseFloat(manualLbs)
      if (isNaN(n) || n < 0) { setError('Manual lbs/day must be a non-negative number'); return }
      body.manual_daily_lbs = n
    } else {
      // 'default' — delete any existing override
      if (existing) {
        deleteMut.mutate()
      } else {
        onClose()
      }
      return
    }
    upsertMut.mutate(body)
  }

  const manualActive = mode === 'manual'
  const rangeDisabled = manualActive

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 6, padding: 20, width: 460,
          maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Projection Override</h3>
          <button onClick={onClose} style={{
            border: 'none', background: 'transparent', fontSize: 20, cursor: 'pointer', color: '#888',
          }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
          <span style={{ fontWeight: 500 }}>{productType}</span>
        </div>

        {/* Mode radio */}
        <div style={{ marginBottom: 16, fontSize: 13 }}>
          {[
            { value: 'default', label: 'Use global settings (no override)' },
            { value: 'weeks', label: 'Custom # of historical weeks' },
            { value: 'range', label: 'Custom date range' },
            { value: 'manual', label: 'Manual rate (lbs/day)' },
          ].map(opt => (
            <label key={opt.value} style={{ display: 'block', padding: '4px 0', cursor: 'pointer' }}>
              <input
                type="radio"
                name="override-mode"
                value={opt.value}
                checked={mode === opt.value}
                onChange={() => setMode(opt.value)}
                style={{ marginRight: 8 }}
              />
              {opt.label}
            </label>
          ))}
        </div>

        {/* Weeks */}
        <div style={{ marginBottom: 12, opacity: mode === 'weeks' ? 1 : 0.45 }}>
          <label style={{ fontSize: 12, color: '#555', display: 'block', marginBottom: 4 }}>
            Historical weeks
          </label>
          <input
            type="number" min={1}
            disabled={mode !== 'weeks'}
            value={weeks}
            onChange={e => setWeeks(e.target.value)}
            style={{ width: 80, padding: '4px 8px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 4 }}
          />
        </div>

        {/* Date range */}
        <div style={{ marginBottom: 12, opacity: mode === 'range' ? 1 : 0.45 }}>
          <label style={{ fontSize: 12, color: '#555', display: 'block', marginBottom: 4 }}>
            Custom date range
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="date"
              disabled={mode !== 'range'}
              value={rangeStart}
              onChange={e => setRangeStart(e.target.value)}
              style={{ padding: '4px 8px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 4 }}
            />
            <span style={{ color: '#888' }}>→</span>
            <input
              type="date"
              disabled={mode !== 'range'}
              value={rangeEnd}
              onChange={e => setRangeEnd(e.target.value)}
              style={{ padding: '4px 8px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 4 }}
            />
          </div>
          <div style={{ fontSize: 10, color: '#999', marginTop: 4 }}>
            Denominator for each (dow, hour) is how many times that slot occurs in the range.
          </div>
          {mode === 'range' && rangeStart && rangeEnd && (() => {
            const days = Math.round((new Date(rangeEnd) - new Date(rangeStart)) / 86400000) + 1
            if (days < 7) {
              return (
                <div style={{
                  marginTop: 8, padding: 8, fontSize: 11,
                  background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4,
                  color: '#92400e',
                }}>
                  ⚠️ Range is {days} day{days === 1 ? '' : 's'} — doesn't cover all 7 weekdays.
                  Uncovered (day-of-week, hour) slots in the forecast will fall back to this product type's
                  <strong> SKU-level daily rate ÷ 24</strong>, losing hour-of-day detail for those slots.
                </div>
              )
            }
            return null
          })()}
        </div>

        {/* Manual rate */}
        <div style={{ marginBottom: 12, opacity: mode === 'manual' ? 1 : 0.45 }}>
          <label style={{ fontSize: 12, color: '#555', display: 'block', marginBottom: 4 }}>
            Manual lbs/day
          </label>
          <input
            type="number" min={0} step="0.1"
            disabled={mode !== 'manual'}
            value={manualLbs}
            onChange={e => setManualLbs(e.target.value)}
            placeholder="e.g. 50"
            style={{ width: 120, padding: '4px 8px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 4 }}
          />
          <div style={{ fontSize: 10, color: '#999', marginTop: 4 }}>
            Total = lbs/day × remaining days in period. Chart distributes evenly across remaining hours.
          </div>
        </div>

        {/* Multiplier toggles — only meaningful for manual rate */}
        <div style={{
          padding: 10, background: manualActive ? '#fffbeb' : '#f8fafc',
          borderRadius: 4, marginBottom: 16,
          opacity: manualActive ? 1 : 0.5,
        }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
            Apply to manual rate:
          </div>
          {[
            { key: 'demand', label: 'Demand multiplier', val: applyDemand, setter: setApplyDemand },
            { key: 'promo', label: 'Promotion multiplier', val: applyPromo, setter: setApplyPromo },
            { key: 'padding', label: 'Padding %', val: applyPadding, setter: setApplyPadding },
          ].map(t => (
            <label key={t.key} style={{ display: 'block', fontSize: 12, padding: '2px 0', cursor: manualActive ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                disabled={!manualActive}
                checked={t.val}
                onChange={e => t.setter(e.target.checked)}
                style={{ marginRight: 6 }}
              />
              {t.label}
            </label>
          ))}
        </div>

        {error && (
          <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {existing && (
            <button
              onClick={() => deleteMut.mutate()}
              disabled={deleteMut.isPending}
              style={{
                padding: '6px 12px', fontSize: 12, border: '1px solid #fecaca',
                background: '#fff', color: '#dc2626', borderRadius: 4, cursor: 'pointer',
              }}
            >
              Remove override
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              padding: '6px 12px', fontSize: 12, border: '1px solid #d1d5db',
              background: '#fff', borderRadius: 4, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={upsertMut.isPending}
            style={{
              padding: '6px 12px', fontSize: 12, border: '1px solid #2563eb',
              background: '#2563eb', color: '#fff', borderRadius: 4, cursor: 'pointer',
            }}
          >
            {upsertMut.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
        <div style={{ fontSize: 10, color: '#999', marginTop: 12 }}>
          Saving will regenerate the projection automatically.
        </div>
      </div>
    </div>
  )
}

// ── Config Diff Panel ───────────────────────────────────────────────────────

function ConfigDiffPanel({ periodA, periodB }) {
  const [tab, setTab] = useState('short-ship')

  const { data: ssDiff } = useQuery({
    queryKey: ['config-diff-ss', periodA, periodB],
    queryFn: () => projectionPeriodsApi.diffShortShip(periodA, periodB),
    enabled: !!periodA && !!periodB && tab === 'short-ship',
  })
  const { data: ihDiff } = useQuery({
    queryKey: ['config-diff-ih', periodA, periodB],
    queryFn: () => projectionPeriodsApi.diffInventoryHold(periodA, periodB),
    enabled: !!periodA && !!periodB && tab === 'inv-hold',
  })

  const diff = tab === 'short-ship' ? ssDiff : ihDiff

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={`btn btn-sm ${tab === 'short-ship' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('short-ship')}>Short Ship</button>
        <button className={`btn btn-sm ${tab === 'inv-hold' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('inv-hold')}>Inventory Hold</button>
      </div>
      {!diff ? (
        <p style={{ color: '#999', fontStyle: 'italic' }}>Select two periods to compare configs.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#dc2626', marginBottom: 4 }}>Only in Period A ({diff.only_in_source?.length || 0})</div>
            {(diff.only_in_source || []).map(s => <div key={s} className="mono" style={{ fontSize: 12 }}>{s}</div>)}
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#16a34a', marginBottom: 4 }}>In Both ({diff.in_both?.length || 0})</div>
            {(diff.in_both || []).map(s => <div key={s} className="mono" style={{ fontSize: 12 }}>{s}</div>)}
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#2563eb', marginBottom: 4 }}>Only in Period B ({diff.only_in_target?.length || 0})</div>
            {(diff.only_in_target || []).map(s => <div key={s} className="mono" style={{ fontSize: 12 }}>{s}</div>)}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Projection History Panel ────────────────────────────────────────────────

function ProjectionHistory({ periodId, currentProjectionId, onSelect }) {
  const { data: projections = [] } = useQuery({
    queryKey: ['projections-history', periodId],
    queryFn: () => projectionsApi.list({ period_id: periodId }),
    enabled: !!periodId,
  })

  if (!projections.length) return <p style={{ color: '#aaa', fontStyle: 'italic' }}>No projections for this period yet.</p>

  return (
    <div className="data-table-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>Generated</th>
            <th>Status</th>
            <th style={{ textAlign: 'right' }}>Confirmed (lbs)</th>
            <th style={{ textAlign: 'right' }}>Projected (lbs)</th>
            <th style={{ textAlign: 'right' }}>Total (lbs)</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {projections.map(p => (
            <tr key={p.id} style={p.id === currentProjectionId ? { background: '#eff6ff' } : undefined}>
              <td>{formatDateShort(p.generated_at)}</td>
              <td>
                <span className="badge" style={{
                  background: p.status === 'current' ? '#dcfce7' : '#f3f4f6',
                  color: p.status === 'current' ? '#166534' : '#6b7280',
                }}>{p.status}</span>
              </td>
              <td style={{ textAlign: 'right' }}>{formatLbs(p.total_confirmed_demand_lbs)}</td>
              <td style={{ textAlign: 'right' }}>{formatLbs(p.total_projected_demand_lbs)}</td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatLbs(p.total_demand_lbs)}</td>
              <td>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => onSelect(p.id)}
                  disabled={p.id === currentProjectionId}
                >
                  {p.id === currentProjectionId ? 'Viewing' : 'Load'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Comparison View ─────────────────────────────────────────────────────────

function ComparisonView({ projectionId, periods }) {
  const [otherPeriodId, setOtherPeriodId] = useState('')
  const [otherId, setOtherId] = useState(null)

  // Get latest projection for the other period
  const { data: otherProjections = [] } = useQuery({
    queryKey: ['projections-for-compare', otherPeriodId],
    queryFn: () => projectionsApi.list({ period_id: otherPeriodId, status: 'current' }),
    enabled: !!otherPeriodId,
  })

  const otherProjectionId = otherId || (otherProjections.length > 0 ? otherProjections[0].id : null)

  const { data: comparison, isLoading } = useQuery({
    queryKey: ['projection-comparison', projectionId, otherProjectionId],
    queryFn: () => projectionsApi.compare(projectionId, otherProjectionId),
    enabled: !!projectionId && !!otherProjectionId,
  })

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Compare with period:</label>
        <select value={otherPeriodId} onChange={e => { setOtherPeriodId(e.target.value); setOtherId(null) }}>
          <option value="">Select period...</option>
          {periods.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {isLoading && <div className="loading">Loading comparison...</div>}

      {comparison && (
        <div className="data-table-wrap" style={{ overflow: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th rowSpan={2}>Product Type</th>
                <th colSpan={4} style={{ textAlign: 'center', borderLeft: '2px solid #e8e8e8' }}>
                  {comparison.projection_a?.generated_at ? `A: ${formatDate(comparison.projection_a.generated_at)}` : 'Projection A'}
                </th>
                <th colSpan={4} style={{ textAlign: 'center', borderLeft: '2px solid #e8e8e8' }}>
                  {comparison.projection_b?.generated_at ? `B: ${formatDate(comparison.projection_b.generated_at)}` : 'Projection B'}
                </th>
              </tr>
              <tr>
                <th style={{ textAlign: 'right', borderLeft: '2px solid #e8e8e8' }}>Demand</th>
                <th style={{ textAlign: 'right' }}>On Hand</th>
                <th style={{ textAlign: 'right' }}>Gap</th>
                <th>Status</th>
                <th style={{ textAlign: 'right', borderLeft: '2px solid #e8e8e8' }}>Demand</th>
                <th style={{ textAlign: 'right' }}>On Hand</th>
                <th style={{ textAlign: 'right' }}>Gap</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {comparison.lines.map(l => (
                <tr key={l.product_type}>
                  <td style={{ fontWeight: 500 }}>{l.product_type}</td>
                  <td style={{ textAlign: 'right', borderLeft: '2px solid #f0f0f0' }}>{formatLbs(l.a_padded_demand_lbs)}</td>
                  <td style={{ textAlign: 'right' }}>{formatLbs(l.a_on_hand_lbs)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: l.a_gap_lbs > 0 ? '#dc2626' : '#16a34a' }}>
                    {formatLbs(l.a_gap_lbs)}
                  </td>
                  <td><span className="badge" style={{ background: STATUS_BG[l.a_gap_status], color: STATUS_COLOR[l.a_gap_status] }}>{STATUS_LABEL[l.a_gap_status]}</span></td>
                  <td style={{ textAlign: 'right', borderLeft: '2px solid #f0f0f0' }}>{formatLbs(l.b_padded_demand_lbs)}</td>
                  <td style={{ textAlign: 'right' }}>{formatLbs(l.b_on_hand_lbs)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: l.b_gap_lbs > 0 ? '#dc2626' : '#16a34a' }}>
                    {formatLbs(l.b_gap_lbs)}
                  </td>
                  <td><span className="badge" style={{ background: STATUS_BG[l.b_gap_status], color: STATUS_COLOR[l.b_gap_status] }}>{STATUS_LABEL[l.b_gap_status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Period Edit Panel ────────────────────────────────────────────────────────

function toDatetimeLocal(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function PeriodEditPanel({ period, periods = [], onSave, isSaving, saveError, saveSuccess }) {
  const [form, setForm] = useState({
    name: '', start_datetime: '', end_datetime: '',
    fulfillment_start: '', fulfillment_end: '',
    sku_mapping_sheet_tab: '', notes: '', status: 'draft',
    previous_period_id: '',
  })

  useEffect(() => {
    if (!period) return
    setForm({
      name: period.name || '',
      start_datetime: toDatetimeLocal(period.start_datetime),
      end_datetime: toDatetimeLocal(period.end_datetime),
      fulfillment_start: toDatetimeLocal(period.fulfillment_start),
      fulfillment_end: toDatetimeLocal(period.fulfillment_end),
      sku_mapping_sheet_tab: period.sku_mapping_sheet_tab || '',
      notes: period.notes || '',
      status: period.status || 'draft',
      previous_period_id: period.previous_period_id ? String(period.previous_period_id) : '',
    })
  }, [period?.id])

  const { data: sheetTabs = [] } = useQuery({
    queryKey: ['sheets-tabs'],
    queryFn: () => projectionPeriodsApi.listSheetsTabs(),
  })

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  if (!period) return null

  const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4 }
  const labelStyle = { fontSize: 11, fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.03em' }

  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '16px 20px', marginBottom: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '12px 16px', alignItems: 'start' }}>
        <div style={{ ...fieldStyle, gridColumn: 'span 2' }}>
          <label style={labelStyle}>Name</label>
          <input value={form.name} onChange={e => set('name', e.target.value)} />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Period Start</label>
          <input type="datetime-local" value={form.start_datetime} onChange={e => set('start_datetime', e.target.value)} />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Period End</label>
          <input type="datetime-local" value={form.end_datetime} onChange={e => set('end_datetime', e.target.value)} />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Fulfillment Start <span style={{ color: '#aaa', fontWeight: 400 }}>(opt)</span></label>
          <input type="datetime-local" value={form.fulfillment_start} onChange={e => set('fulfillment_start', e.target.value)} />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Fulfillment End <span style={{ color: '#aaa', fontWeight: 400 }}>(opt)</span></label>
          <input type="datetime-local" value={form.fulfillment_end} onChange={e => set('fulfillment_end', e.target.value)} />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Status</label>
          <select value={form.status} onChange={e => set('status', e.target.value)}>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Previous Period</label>
          <select value={form.previous_period_id} onChange={e => set('previous_period_id', e.target.value)}>
            <option value="">None</option>
            {periods.filter(p => !period || p.id !== period.id).map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div style={{ ...fieldStyle, gridColumn: 'span 2' }}>
          <label style={labelStyle}>SKU Mapping Sheet Tab</label>
          <select value={form.sku_mapping_sheet_tab} onChange={e => set('sku_mapping_sheet_tab', e.target.value)}>
            <option value="">None (use default)</option>
            {sheetTabs.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={{ ...fieldStyle, gridColumn: 'span 2' }}>
          <label style={labelStyle}>Notes</label>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} style={{ resize: 'vertical' }} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => onSave({
            name: form.name,
            start_datetime: form.start_datetime,
            end_datetime: form.end_datetime,
            fulfillment_start: form.fulfillment_start || null,
            fulfillment_end: form.fulfillment_end || null,
            sku_mapping_sheet_tab: form.sku_mapping_sheet_tab || null,
            notes: form.notes || null,
            status: form.status,
            previous_period_id: form.previous_period_id ? parseInt(form.previous_period_id) : null,
          })}
          disabled={isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Period'}
        </button>
        {saveSuccess && <span style={{ color: '#16a34a', fontSize: 12 }}>Saved</span>}
        {saveError && <span style={{ color: '#dc2626', fontSize: 12 }}>Error: {saveError}</span>}
      </div>
    </div>
  )
}

// ── Main Dashboard ──────────────────────────────────────────────────────────

export default function ProjectionDashboard() {
  const qc = useQueryClient()
  const [selectedPeriodId, setSelectedPeriodId] = useState('')
  const [activeProjectionId, setActiveProjectionId] = useState(null)
  const [expandedRow, setExpandedRow] = useState(null)
  const [activeTab, setActiveTab] = useState('projection')
  const [showMethodology, setShowMethodology] = useState(false)
  const [sorting, setSorting] = useState([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState(EMPTY_CREATE_FORM)

  // Periods
  const { data: periods = [] } = useQuery({
    queryKey: ['projection-periods'],
    queryFn: () => projectionPeriodsApi.list(),
  })

  const { data: suggestedDates } = useQuery({
    queryKey: ['suggest-dates'],
    queryFn: () => projectionPeriodsApi.suggestDates(),
  })

  const { data: sheetTabs = [] } = useQuery({
    queryKey: ['sheets-tabs'],
    queryFn: () => projectionPeriodsApi.listSheetsTabs(),
  })

  // Auto-select first active period
  const activePeriods = useMemo(() => periods.filter(p => p.status === 'active'), [periods])
  const effectivePeriodId = selectedPeriodId || (activePeriods.length > 0 ? activePeriods[0].id : periods[0]?.id) || ''

  // Load latest "current" projection for the selected period
  const { data: periodProjections = [] } = useQuery({
    queryKey: ['projections-for-period', effectivePeriodId],
    queryFn: () => projectionsApi.list({ period_id: effectivePeriodId, status: 'current' }),
    enabled: !!effectivePeriodId,
  })

  const latestProjectionId = activeProjectionId || (periodProjections.length > 0 ? periodProjections[0].id : null)

  // Load projection with lines
  const { data: projection, isLoading: projLoading } = useQuery({
    queryKey: ['projection-detail', latestProjectionId],
    queryFn: () => projectionsApi.get(latestProjectionId),
    enabled: !!latestProjectionId,
  })

  // Coverage summary (one badge per product_type) — loaded alongside the table
  const { data: coverageSummary } = useQuery({
    queryKey: ['coverage-summary', latestProjectionId],
    queryFn: () => projectionsApi.getCoverageSummary(latestProjectionId),
    enabled: !!latestProjectionId,
  })

  // Overrides for the active period — drives the row tag + modal
  const { data: overridesList = [] } = useQuery({
    queryKey: ['overrides', effectivePeriodId],
    queryFn: () => projectionsApi.listOverrides(effectivePeriodId),
    enabled: !!effectivePeriodId,
  })
  const overridesByPt = useMemo(() => {
    const m = {}
    for (const o of overridesList) m[o.product_type] = o
    return m
  }, [overridesList])
  const [overrideModalPt, setOverrideModalPt] = useState(null)

  // Update period mutation
  const [periodSaveSuccess, setPeriodSaveSuccess] = useState(false)
  const updatePeriodMut = useMutation({
    mutationFn: (data) => projectionPeriodsApi.update(effectivePeriodId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projection-periods'] })
      setPeriodSaveSuccess(true)
      setTimeout(() => setPeriodSaveSuccess(false), 2000)
    },
  })

  // Generate projection mutation
  const generateMut = useMutation({
    mutationFn: (body = {}) => projectionsApi.generate(effectivePeriodId, body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['projections-for-period', effectivePeriodId] })
      qc.invalidateQueries({ queryKey: ['projections-history', effectivePeriodId] })
      setActiveProjectionId(data.id)
    },
  })

  // Create period mutation
  const createPeriodMut = useMutation({
    mutationFn: projectionPeriodsApi.create,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['projection-periods'] })
      setSelectedPeriodId(String(data.id))
      setActiveProjectionId(null)
      setExpandedRow(null)
      setShowCreateModal(false)
    },
  })

  function openCreateModal() {
    const now = new Date()
    const f = { ...EMPTY_CREATE_FORM }
    f.start_datetime = toLocalInput(now.toISOString())
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    f.fulfillment_start = toLocalInput(ninetyDaysAgo.toISOString())
    f.fulfillment_end = toLocalInput(now.toISOString())
    // Default end: upcoming Tuesday at 11:59 PM local time
    const day = now.getDay()
    const daysUntilTue = (2 - day + 7) % 7 || 7
    const tuesday = new Date(now)
    tuesday.setDate(now.getDate() + daysUntilTue)
    tuesday.setHours(23, 59, 0, 0)
    f.end_datetime = toLocalInput(tuesday.toISOString())
    setCreateForm(f)
    setShowCreateModal(true)
  }

  function handleCreateSubmit(e) {
    e.preventDefault()
    const payload = {
      ...createForm,
      previous_period_id: createForm.previous_period_id ? parseInt(createForm.previous_period_id) : null,
      sku_mapping_sheet_tab: createForm.sku_mapping_sheet_tab || null,
      fulfillment_start: createForm.fulfillment_start || null,
      fulfillment_end: createForm.fulfillment_end || null,
    }
    createPeriodMut.mutate(payload)
  }

  // Table columns
  const columns = useMemo(() => [
    {
      accessorKey: 'product_type',
      header: 'Product Type',
      cell: ({ getValue }) => {
        const pt = getValue()
        const cov = coverageSummary?.product_types?.[pt]
        const ovr = overridesByPt[pt]
        const title = cov
          ? `${COVERAGE_LABEL[cov.coverage]} — ${cov.green_count}🟢 ${cov.yellow_count}🟡 ${cov.red_count}🔴 across ${cov.sku_count} SKUs`
          : undefined
        let ovrLabel = null
        if (ovr) {
          if (ovr.manual_daily_lbs != null) ovrLabel = `manual ${ovr.manual_daily_lbs}/d`
          else if (ovr.custom_range_start) ovrLabel = `range ${ovr.custom_range_start.slice(5,10)}→${ovr.custom_range_end.slice(5,10)}`
          else if (ovr.historical_weeks) ovrLabel = `${ovr.historical_weeks}wk`
        }
        return (
          <span style={{ fontWeight: 500 }}>
            <CoverageBadge coverage={cov?.coverage} title={title} />
            {pt}
            <button
              onClick={(e) => { e.stopPropagation(); setOverrideModalPt(pt) }}
              title="Configure projection override"
              style={{
                marginLeft: 6, padding: '1px 6px', fontSize: 10,
                border: `1px solid ${ovr ? '#2563eb' : '#d1d5db'}`,
                background: ovr ? '#dbeafe' : '#fff',
                color: ovr ? '#1e40af' : '#777',
                borderRadius: 3, cursor: 'pointer', verticalAlign: 'middle',
              }}
            >
              {ovr ? ovrLabel : '⚙'}
            </button>
          </span>
        )
      },
      size: 240,
    },
    {
      accessorKey: 'confirmed_order_count',
      header: 'Conf. Orders',
      cell: ({ getValue }) => <span style={{ textAlign: 'right', display: 'block' }}>{getValue()}</span>,
      size: 90,
    },
    {
      accessorKey: 'confirmed_demand_lbs',
      header: 'Conf. (lbs)',
      cell: ({ getValue }) => <span style={{ textAlign: 'right', display: 'block' }}>{formatLbs(getValue())}</span>,
      size: 90,
    },
    {
      accessorKey: 'projected_order_count',
      header: 'Proj. Orders',
      cell: ({ getValue }) => <span style={{ textAlign: 'right', display: 'block', color: '#6b7280' }}>{Math.round(getValue())}</span>,
      size: 90,
    },
    {
      accessorKey: 'projected_demand_lbs',
      header: 'Proj. (lbs)',
      cell: ({ getValue }) => <span style={{ textAlign: 'right', display: 'block', color: '#6b7280' }}>{formatLbs(getValue())}</span>,
      size: 90,
    },
    {
      accessorKey: 'padded_demand_lbs',
      header: 'Padded (lbs)',
      cell: ({ row }) => {
        const pad = row.original.padding_pct
        return (
          <span style={{ textAlign: 'right', display: 'block', fontWeight: 600 }}>
            {formatLbs(row.original.padded_demand_lbs)}
            {pad > 0 && <span style={{ fontSize: 10, color: '#999', marginLeft: 2 }}>+{pad.toFixed(0)}%</span>}
          </span>
        )
      },
      size: 110,
    },
    {
      accessorKey: 'on_hand_lbs',
      header: 'On Hand (lbs)',
      cell: ({ getValue }) => <span style={{ textAlign: 'right', display: 'block' }}>{formatLbs(getValue())}</span>,
      size: 100,
    },
    {
      accessorKey: 'expected_on_hand_lbs',
      header: 'Exp. On Hand',
      cell: ({ getValue }) => {
        const v = getValue()
        return <span style={{ textAlign: 'right', display: 'block', color: v > 0 ? '#333' : '#ccc' }}>{formatLbs(v)}</span>
      },
      size: 100,
    },
    {
      accessorKey: 'on_order_lbs',
      header: 'On Order (lbs)',
      cell: ({ getValue }) => {
        const v = getValue()
        return <span style={{ textAlign: 'right', display: 'block', color: v > 0 ? '#2563eb' : '#ccc' }}>{formatLbs(v)}</span>
      },
      size: 100,
    },
    {
      accessorKey: 'gap_lbs',
      header: 'Gap (lbs)',
      cell: ({ getValue, row }) => (
        <span style={{
          textAlign: 'right', display: 'block', fontWeight: 700,
          color: row.original.gap_status === 'short' ? '#dc2626' : row.original.gap_status === 'long' ? '#d97706' : '#16a34a',
        }}>
          {formatLbs(getValue())}
        </span>
      ),
      size: 90,
    },
    {
      accessorKey: 'gap_cases',
      header: 'Gap (cases)',
      cell: ({ getValue }) => <span style={{ textAlign: 'right', display: 'block' }}>{formatCases(getValue())}</span>,
      size: 90,
    },
    {
      accessorKey: 'gap_status',
      header: 'Status',
      cell: ({ getValue }) => {
        const s = getValue()
        return (
          <span className="badge" style={{ background: STATUS_BG[s], color: STATUS_COLOR[s] }}>
            {STATUS_LABEL[s]}
          </span>
        )
      },
      size: 70,
    },
  ], [coverageSummary, overridesByPt])

  const lines = useMemo(() => projection?.lines || [], [projection])

  const table = useReactTable({
    data: lines,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const selectedPeriod = periods.find(p => String(p.id) === String(effectivePeriodId))

  return (
    <div>
      <div className="page-header">
        <h1>Projection Dashboard</h1>
        <p>View and manage demand projections by period</p>
      </div>

      {/* Toolbar: period selector + generate */}
      <div className="toolbar">
        <select
          value={effectivePeriodId}
          onChange={e => { setSelectedPeriodId(e.target.value); setActiveProjectionId(null); setExpandedRow(null) }}
          style={{ minWidth: 260 }}
        >
          {periods.length === 0 && <option value="">No periods</option>}
          {periods.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.status})
            </option>
          ))}
        </select>

        <button className="btn btn-secondary" onClick={openCreateModal}>
          + New Period
        </button>

        <button
          className="btn btn-primary"
          onClick={() => generateMut.mutate()}
          disabled={!effectivePeriodId || generateMut.isPending}
        >
          {generateMut.isPending ? 'Generating...' : 'Generate Projection'}
        </button>

        {generateMut.isError && (
          <span style={{ color: '#dc2626', fontSize: 12 }}>
            Error: {generateMut.error?.response?.data?.detail || generateMut.error?.message}
          </span>
        )}

        {selectedPeriod && (
          <span style={{ fontSize: 12, color: '#888' }}>
            {formatDateShort(selectedPeriod.start_datetime)} &mdash; {formatDateShort(selectedPeriod.end_datetime)}
          </span>
        )}
      </div>

      {/* Period edit panel */}
      <PeriodEditPanel
        period={selectedPeriod}
        periods={periods}
        onSave={(data) => updatePeriodMut.mutate(data)}
        isSaving={updatePeriodMut.isPending}
        saveError={updatePeriodMut.isError ? (updatePeriodMut.error?.response?.data?.detail || updatePeriodMut.error?.message) : null}
        saveSuccess={periodSaveSuccess}
      />

      {/* Summary bar */}
      <SummaryBar
        projection={projection}
        period={selectedPeriod}
        onRegenerate={(body) => generateMut.mutate(body)}
        isRegenerating={generateMut.isPending}
      />

      {/* Tabs */}
      <div className="proj-tabs">
        {['projection', 'comparison', 'history', 'config-diff'].map(t => (
          <button
            key={t}
            className={`proj-tab ${activeTab === t ? 'proj-tab-active' : ''}`}
            onClick={() => setActiveTab(t)}
          >
            {t === 'projection' ? 'Projection' : t === 'comparison' ? 'Comparison' : t === 'history' ? 'History' : 'Config Diff'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'projection' && (
        <>
          {projLoading && <div className="loading">Loading projection...</div>}

          {!projLoading && !projection && effectivePeriodId && (
            <div className="empty">No projection for this period yet. Click "Generate Projection" to create one.</div>
          )}

          {projection && (
            <>
              <ShopHourlyOrdersChart projectionId={projection.id} />

              <div className="data-table-wrap" style={{ overflow: 'auto' }}>
                <table>
                  <thead>
                    {table.getHeaderGroups().map(hg => (
                      <tr key={hg.id}>
                        {hg.headers.map(header => (
                          <th
                            key={header.id}
                            onClick={header.column.getToggleSortingHandler()}
                            style={{ cursor: 'pointer', userSelect: 'none', width: header.getSize() }}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {{ asc: ' \u2191', desc: ' \u2193' }[header.column.getIsSorted()] ?? ''}
                          </th>
                        ))}
                      </tr>
                    ))}
                  </thead>
                  <tbody>
                    {table.getRowModel().rows.map(row => {
                      const isExpanded = expandedRow === row.original.product_type
                      return (
                        <Fragment key={row.id}>
                          <tr
                            onClick={() => setExpandedRow(isExpanded ? null : row.original.product_type)}
                            style={{
                              cursor: 'pointer',
                              background: isExpanded ? '#f8fafc' : undefined,
                            }}
                          >
                            {row.getVisibleCells().map(cell => (
                              <td key={cell.id}>
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </td>
                            ))}
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={columns.length} style={{ padding: 0, background: '#f8fafc' }}>
                                <PtDailyHistory projectionId={projection.id} productType={row.original.product_type} />
                                <SkuDiagnostics projectionId={projection.id} productType={row.original.product_type} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Methodology report */}
              <div style={{ marginTop: 16 }}>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => setShowMethodology(!showMethodology)}
                >
                  {showMethodology ? 'Hide' : 'Show'} Methodology Report
                </button>
                {showMethodology && (
                  <pre className="methodology-report">{projection.methodology_report || 'No methodology report available.'}</pre>
                )}
              </div>
            </>
          )}
        </>
      )}

      {activeTab === 'comparison' && (
        <ComparisonView
          projectionId={latestProjectionId}
          periods={periods}
        />
      )}

      {activeTab === 'history' && (
        <ProjectionHistory
          periodId={effectivePeriodId}
          currentProjectionId={latestProjectionId}
          onSelect={(id) => setActiveProjectionId(id)}
        />
      )}

      {activeTab === 'config-diff' && (
        <ConfigDiffWithState periodA={effectivePeriodId} periods={periods} />
      )}

      {/* Projection Override Modal */}
      {overrideModalPt && (
        <OverrideModal
          periodId={effectivePeriodId}
          productType={overrideModalPt}
          existing={overridesByPt[overrideModalPt]}
          onClose={() => setOverrideModalPt(null)}
          onSaved={() => generateMut.mutate(projection?.parameters || {})}
        />
      )}

      {/* Create Period Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h2 style={{ marginTop: 0 }}>New Projection Period</h2>
            <form onSubmit={handleCreateSubmit}>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <label>Name</label>
                  <input
                    type="text" required value={createForm.name}
                    onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
                  />
                </div>
                <div style={{ border: '1px solid #bfdbfe', borderRadius: 8, padding: 12, background: '#eff6ff' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                    Confirmed Demand
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label>Start</label>
                      <input
                        type="datetime-local" value={createForm.fulfillment_start}
                        onChange={e => setCreateForm(f => ({ ...f, fulfillment_start: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #bfdbfe', borderRadius: 6 }}
                      />
                    </div>
                    <div>
                      <label>End</label>
                      <input
                        type="datetime-local" value={createForm.fulfillment_end}
                        onChange={e => setCreateForm(f => ({ ...f, fulfillment_end: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #bfdbfe', borderRadius: 6 }}
                      />
                    </div>
                  </div>
                </div>
                <div style={{ border: '1px solid #bbf7d0', borderRadius: 8, padding: 12, background: '#f0fdf4' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#15803d', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                    Projections Period
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label>Start</label>
                      <input
                        type="datetime-local" required value={createForm.start_datetime}
                        onChange={e => setCreateForm(f => ({ ...f, start_datetime: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #bbf7d0', borderRadius: 6 }}
                      />
                    </div>
                    <div>
                      <label>End</label>
                      <input
                        type="datetime-local" required value={createForm.end_datetime}
                        onChange={e => setCreateForm(f => ({ ...f, end_datetime: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #bbf7d0', borderRadius: 6 }}
                      />
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label>Status</label>
                    <select
                      value={createForm.status}
                      onChange={e => setCreateForm(f => ({ ...f, status: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
                    >
                      <option value="draft">Draft</option>
                      <option value="active">Active</option>
                      <option value="closed">Closed</option>
                    </select>
                  </div>
                  <div>
                    <label>Previous Period</label>
                    <select
                      value={createForm.previous_period_id}
                      onChange={e => setCreateForm(f => ({ ...f, previous_period_id: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
                    >
                      <option value="">None</option>
                      {periods.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label>SKU Mapping Sheet Tab</label>
                  <select
                    value={createForm.sku_mapping_sheet_tab}
                    onChange={e => setCreateForm(f => ({ ...f, sku_mapping_sheet_tab: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
                  >
                    <option value="">None (use default)</option>
                    {sheetTabs.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label>Notes</label>
                  <textarea
                    value={createForm.notes}
                    onChange={e => setCreateForm(f => ({ ...f, notes: e.target.value }))}
                    rows={2}
                    style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
                  />
                </div>
              </div>

              {suggestedDates && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreateForm(f => ({
                    ...f,
                    start_datetime: toLocalInput(suggestedDates.current_week.start),
                    end_datetime: toLocalInput(suggestedDates.current_week.end),
                  }))}>This Week (Wed-Tue)</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreateForm(f => ({
                    ...f,
                    start_datetime: toLocalInput(suggestedDates.next_week.start),
                    end_datetime: toLocalInput(suggestedDates.next_week.end),
                  }))}>Next Week (Wed-Tue)</button>
                </div>
              )}

              {createPeriodMut.isError && (
                <div style={{ marginTop: 12, color: '#dc2626', fontSize: 12 }}>
                  Error: {createPeriodMut.error?.response?.data?.detail || createPeriodMut.error?.message}
                </div>
              )}

              <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={createPeriodMut.isPending}>
                  {createPeriodMut.isPending ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// Small wrapper to manage config diff state
function ConfigDiffWithState({ periodA, periods }) {
  const [periodB, setPeriodB] = useState('')

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Compare with:</label>
        <select value={periodB} onChange={e => setPeriodB(e.target.value)}>
          <option value="">Select period...</option>
          {periods.filter(p => String(p.id) !== String(periodA)).map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {periodA && periodB ? (
        <ConfigDiffPanel periodA={periodA} periodB={periodB} />
      ) : (
        <p style={{ color: '#aaa', fontStyle: 'italic' }}>Select a second period to compare configurations.</p>
      )}
    </div>
  )
}
