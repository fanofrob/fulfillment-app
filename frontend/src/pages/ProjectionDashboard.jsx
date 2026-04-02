import { useState, useMemo, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table'
import { projectionsApi, projectionPeriodsApi } from '../api'

const STATUS_BG = { short: '#fef2f2', long: '#fffbeb', ok: '#f0fdf4' }
const STATUS_COLOR = { short: '#dc2626', long: '#d97706', ok: '#16a34a' }
const STATUS_LABEL = { short: 'Short', long: 'Long', ok: 'OK' }

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

// ── Summary Bar ─────────────────────────────────────────────────────────────

function SummaryBar({ projection }) {
  if (!projection) return null
  const { total_confirmed_demand_lbs, total_projected_demand_lbs, total_demand_lbs, lines } = projection
  const totalOnHand = (lines || []).reduce((s, l) => s + (l.on_hand_lbs || 0), 0)
  const totalGap = (lines || []).reduce((s, l) => s + (l.gap_lbs || 0), 0)
  const shortCount = (lines || []).filter(l => l.gap_status === 'short').length
  const longCount = (lines || []).filter(l => l.gap_status === 'long').length

  return (
    <div className="proj-summary-bar">
      <div className="proj-summary-item">
        <span className="proj-summary-label">Confirmed</span>
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
  )
}

// ── Hourly Breakdown Panel ──────────────────────────────────────────────────

function HourlyBreakdown({ projectionId, productType }) {
  const { data, isLoading } = useQuery({
    queryKey: ['hourly-breakdown', projectionId, productType],
    queryFn: () => projectionsApi.getHourlyBreakdown(projectionId, productType),
    enabled: !!projectionId && !!productType,
  })

  if (isLoading) return <div style={{ padding: 12, color: '#999' }}>Loading hourly data...</div>
  if (!data?.hours?.length) return <div style={{ padding: 12, color: '#aaa', fontStyle: 'italic' }}>No hourly projection data available.</div>

  // Group by day
  const byDay = {}
  for (const h of data.hours) {
    const d = new Date(h.hour)
    const dayKey = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    if (!byDay[dayKey]) byDay[dayKey] = []
    byDay[dayKey].push(h)
  }

  const maxLbs = Math.max(...data.hours.map(h => h.projected_lbs), 1)

  return (
    <div className="hourly-breakdown-panel">
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
        Hourly Projected Demand: {productType}
      </div>
      {Object.entries(byDay).map(([day, hours]) => (
        <div key={day} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 4 }}>{day}</div>
          <div className="hourly-grid">
            {hours.map((h, i) => {
              const d = new Date(h.hour)
              const pct = maxLbs > 0 ? (h.projected_lbs / maxLbs) * 100 : 0
              return (
                <div key={i} className="hourly-bar-cell" title={`${h.projected_lbs.toFixed(1)} lbs, ${h.projected_orders.toFixed(1)} orders`}>
                  <div className="hourly-bar-track">
                    <div className="hourly-bar-fill" style={{ height: `${Math.max(2, pct)}%` }} />
                  </div>
                  <div className="hourly-bar-label">{d.getHours() % 12 || 12}{d.getHours() < 12 ? 'a' : 'p'}</div>
                  <div className="hourly-bar-value">{h.projected_lbs > 0 ? h.projected_lbs.toFixed(0) : ''}</div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
        Total remaining: {formatLbs(data.hours.reduce((s, h) => s + h.projected_lbs, 0))} lbs,{' '}
        {data.hours.reduce((s, h) => s + h.projected_orders, 0).toFixed(0)} orders
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

// ── Main Dashboard ──────────────────────────────────────────────────────────

export default function ProjectionDashboard() {
  const qc = useQueryClient()
  const [selectedPeriodId, setSelectedPeriodId] = useState('')
  const [activeProjectionId, setActiveProjectionId] = useState(null)
  const [expandedRow, setExpandedRow] = useState(null)
  const [activeTab, setActiveTab] = useState('projection')
  const [showMethodology, setShowMethodology] = useState(false)
  const [sorting, setSorting] = useState([])

  // Periods
  const { data: periods = [] } = useQuery({
    queryKey: ['projection-periods'],
    queryFn: () => projectionPeriodsApi.list(),
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

  // Generate projection mutation
  const generateMut = useMutation({
    mutationFn: () => projectionsApi.generate(effectivePeriodId),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['projections-for-period', effectivePeriodId] })
      qc.invalidateQueries({ queryKey: ['projections-history', effectivePeriodId] })
      setActiveProjectionId(data.id)
    },
  })

  // Table columns
  const columns = useMemo(() => [
    {
      accessorKey: 'product_type',
      header: 'Product Type',
      cell: ({ getValue }) => <span style={{ fontWeight: 500 }}>{getValue()}</span>,
      size: 200,
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
            {pad > 0 && <span style={{ fontSize: 10, color: '#999', marginLeft: 2 }}>+{(pad * 100).toFixed(0)}%</span>}
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
  ], [])

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

      {/* Summary bar */}
      <SummaryBar projection={projection} />

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
                                <HourlyBreakdown projectionId={projection.id} productType={row.original.product_type} />
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
