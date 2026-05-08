import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { inventoryApi } from '../api'

const WAREHOUSES = ['walnut', 'northlake']
const CATEGORY_OPTIONS = [
  ['fruit', 'Fruit'],
  ['packaging', 'Packaging'],
  ['other', 'Other'],
  ['', 'All'],
]
const PRESETS = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['custom', 'Custom'],
]

function isoDateNDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function fmt(n, decimals = 1) {
  if (n === null || n === undefined) return '—'
  return Number(n).toFixed(decimals)
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function csvEscape(val) {
  if (val === null || val === undefined) return ''
  const s = String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
  return s
}

function downloadCsv(filename, headers, rows) {
  const lines = [headers.join(','), ...rows.map(r => r.map(csvEscape).join(','))]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function DiscardReport() {
  const [warehouse, setWarehouse] = useState('walnut')
  const [preset, setPreset] = useState('30')
  const [fromDate, setFromDate] = useState(isoDateNDaysAgo(30))
  const [toDate, setToDate] = useState(todayIso())
  const [category, setCategory] = useState('fruit')
  const [view, setView] = useState('by_sku')  // 'by_sku' | 'by_event'

  // Apply preset → date range
  useEffect(() => {
    if (preset === 'custom') return
    const days = parseInt(preset, 10)
    setFromDate(isoDateNDaysAgo(days))
    setToDate(todayIso())
  }, [preset])

  const { data, isLoading, error } = useQuery({
    queryKey: ['discard-report', warehouse, fromDate, toDate, category],
    queryFn: () => inventoryApi.discardReport(warehouse, {
      from_date: fromDate || undefined,
      to_date: toDate || undefined,
      category: category || undefined,
    }),
    placeholderData: (prev) => prev,
  })

  const totals = data?.totals || { pieces: 0, lbs: 0, events: 0, skus: 0 }
  const bySku = data?.by_sku || []
  const byEvent = data?.by_event || []

  const exportCurrentView = () => {
    const ds = `${fromDate || 'start'}_${toDate || 'today'}`
    const catTag = category || 'all'
    if (view === 'by_sku') {
      downloadCsv(
        `discard-by-sku-${warehouse}-${catTag}-${ds}.csv`,
        ['pick_sku', 'name', 'category', 'pieces_discarded', 'lbs_discarded', 'event_count', 'last_discard_at'],
        bySku.map(r => [r.pick_sku, r.name, r.category || '', r.pieces_discarded, r.lbs_discarded ?? '', r.event_count, r.last_discard_at || '']),
      )
    } else {
      downloadCsv(
        `discard-by-event-${warehouse}-${catTag}-${ds}.csv`,
        ['created_at', 'pick_sku', 'name', 'category', 'pieces', 'lbs', 'note'],
        byEvent.map(r => [r.created_at, r.pick_sku, r.name, r.category || '', r.pieces, r.lbs ?? '', r.note || '']),
      )
    }
  }

  const printReport = () => {
    const win = window.open('', '_blank')
    if (!win) { alert('Pop-up blocked — please allow pop-ups for this site.'); return }
    const warehouseLabel = warehouse.charAt(0).toUpperCase() + warehouse.slice(1)
    const catLabel = category ? category.charAt(0).toUpperCase() + category.slice(1) : 'All Categories'
    const dateRange = `${fmtDate(fromDate)} – ${fmtDate(toDate)}`
    const title = `Discard Report — ${warehouseLabel} — ${catLabel} — ${dateRange}`

    let body = `<h1>${title}</h1>`
    body += `<div class="summary">${totals.skus} SKUs &middot; ${fmt(totals.pieces, 0)} pieces &middot; ${fmt(totals.lbs, 1)} lbs &middot; ${totals.events} events</div>`

    if (view === 'by_sku') {
      body += '<table><thead><tr><th>SKU</th><th>Name</th><th>Category</th><th style="text-align:right">Pieces</th><th style="text-align:right">Lbs</th><th style="text-align:right">Events</th><th>Last</th></tr></thead><tbody>'
      bySku.forEach(r => {
        body += `<tr><td>${r.pick_sku}</td><td>${r.name || ''}</td><td>${r.category || ''}</td><td style="text-align:right">${fmt(r.pieces_discarded, 1)}</td><td style="text-align:right">${r.lbs_discarded != null ? fmt(r.lbs_discarded, 1) : '—'}</td><td style="text-align:right">${r.event_count}</td><td>${fmtDate(r.last_discard_at)}</td></tr>`
      })
      body += '</tbody></table>'
    } else {
      body += '<table><thead><tr><th>Date</th><th>SKU</th><th>Name</th><th>Category</th><th style="text-align:right">Pieces</th><th style="text-align:right">Lbs</th><th>Note</th></tr></thead><tbody>'
      byEvent.forEach(r => {
        body += `<tr><td>${fmtDateTime(r.created_at)}</td><td>${r.pick_sku}</td><td>${r.name || ''}</td><td>${r.category || ''}</td><td style="text-align:right">${fmt(r.pieces, 1)}</td><td style="text-align:right">${r.lbs != null ? fmt(r.lbs, 1) : '—'}</td><td>${r.note || ''}</td></tr>`
      })
      body += '</tbody></table>'
    }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #111; margin: 32px; }
        h1 { font-size: 20px; margin: 0 0 4px; }
        .summary { color: #555; font-size: 13px; margin-bottom: 24px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
        th { text-align: left; font-size: 12px; font-weight: 600; color: #555; border: 1px solid #ddd; border-bottom: 2px solid #ddd; padding: 5px 8px; }
        td { padding: 5px 8px; border: 1px solid #eee; }
        .page-header { display: none; }
        @media print {
          body { margin: 56px 16px 16px; }
          .page-header { display: block; position: fixed; top: 0; left: 0; right: 0; padding: 6px 16px; border-bottom: 1px solid #999; background: #fff; font-size: 11px; font-weight: 600; color: #991b1b; }
        }
      </style></head><body>
      <div class="page-header">${title}</div>
      ${body}
      </body></html>`
    win.document.write(html)
    win.document.close()
    win.focus()
    win.print()
  }

  return (
    <div style={{ padding: 24, maxWidth: 1400 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Discard Report</h1>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 20 }}>
        Aggregated and per-event view of inventory discards (Discard mode counts) over a date range. Lbs are computed as <code>pieces × weight_lb</code> from the Picklist SKU table; SKUs without a weight show "—".
      </p>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 20, padding: 14, background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
        <div>
          <label style={lblStyle}>WAREHOUSE</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {WAREHOUSES.map(w => (
              <button
                key={w}
                onClick={() => setWarehouse(w)}
                style={{ ...pillStyle, background: warehouse === w ? '#2563eb' : '#fff', color: warehouse === w ? '#fff' : '#374151', borderColor: warehouse === w ? '#2563eb' : '#d1d5db', textTransform: 'capitalize' }}
              >
                {w}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={lblStyle}>CATEGORY</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {CATEGORY_OPTIONS.map(([val, label]) => (
              <button
                key={val}
                onClick={() => setCategory(val)}
                style={{ ...pillStyle, background: category === val ? '#16a34a' : '#fff', color: category === val ? '#fff' : '#374151', borderColor: category === val ? '#16a34a' : '#d1d5db' }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={lblStyle}>RANGE</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {PRESETS.map(([val, label]) => (
              <button
                key={val}
                onClick={() => setPreset(val)}
                style={{ ...pillStyle, background: preset === val ? '#374151' : '#fff', color: preset === val ? '#fff' : '#374151', borderColor: preset === val ? '#374151' : '#d1d5db' }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={lblStyle}>FROM</label>
          <input
            type="date"
            value={fromDate}
            onChange={e => { setFromDate(e.target.value); setPreset('custom') }}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={lblStyle}>TO</label>
          <input
            type="date"
            value={toDate}
            onChange={e => { setToDate(e.target.value); setPreset('custom') }}
            style={inputStyle}
          />
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={exportCurrentView} className="btn btn-secondary btn-sm" disabled={isLoading || !data}>
            ↓ Export CSV
          </button>
          <button onClick={printReport} className="btn btn-secondary btn-sm" disabled={isLoading || !data}>
            🖨 Print
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Tile label="SKUs Discarded" value={totals.skus} />
        <Tile label="Total Pieces" value={fmt(totals.pieces, 0)} />
        <Tile label="Total Lbs" value={fmt(totals.lbs, 1)} accent="#dc2626" />
        <Tile label="Discard Events" value={totals.events} />
      </div>

      {/* View toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div role="group" aria-label="View" style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden' }}>
          {[['by_sku', 'By SKU'], ['by_event', 'By Event']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setView(val)}
              style={{
                padding: '5px 14px',
                fontSize: 13,
                cursor: 'pointer',
                border: 'none',
                background: view === val ? '#374151' : '#fff',
                color: view === val ? '#fff' : '#374151',
                fontWeight: view === val ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {view === 'by_sku' ? 'Aggregated totals per SKU' : 'One row per discard event (chronological)'}
        </div>
      </div>

      {/* Table */}
      {error ? (
        <div style={errorBox}>{String(error.message || error)}</div>
      ) : isLoading && !data ? (
        <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>
      ) : view === 'by_sku' ? (
        <BySkuTable rows={bySku} />
      ) : (
        <ByEventTable rows={byEvent} />
      )}
    </div>
  )
}

function Tile({ label, value, accent }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', minWidth: 130 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || '#111827', marginTop: 2 }}>{value}</div>
    </div>
  )
}

function BySkuTable({ rows }) {
  if (!rows.length) return <div style={emptyStyle}>No discards in this period.</div>
  return (
    <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
            <th style={th}>Pick SKU</th>
            <th style={th}>Name</th>
            <th style={th}>Category</th>
            <th style={{ ...th, textAlign: 'right' }}>Pieces</th>
            <th style={{ ...th, textAlign: 'right' }}>Lbs</th>
            <th style={{ ...th, textAlign: 'right' }}>Events</th>
            <th style={th}>Last Discard</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.pick_sku} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ ...td, fontFamily: 'monospace', fontWeight: 600 }}>{r.pick_sku}</td>
              <td style={td}>{r.name || '—'}</td>
              <td style={td}>{r.category || <span style={{ color: '#9ca3af' }}>—</span>}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmt(r.pieces_discarded, 1)}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: '#dc2626' }}>{r.lbs_discarded != null ? fmt(r.lbs_discarded, 1) : <span style={{ color: '#9ca3af', fontWeight: 400 }}>—</span>}</td>
              <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>{r.event_count}</td>
              <td style={{ ...td, color: '#6b7280' }}>{fmtDate(r.last_discard_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ByEventTable({ rows }) {
  if (!rows.length) return <div style={emptyStyle}>No discards in this period.</div>
  return (
    <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
            <th style={th}>Date / Time</th>
            <th style={th}>Pick SKU</th>
            <th style={th}>Name</th>
            <th style={th}>Category</th>
            <th style={{ ...th, textAlign: 'right' }}>Pieces</th>
            <th style={{ ...th, textAlign: 'right' }}>Lbs</th>
            <th style={th}>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ ...td, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDateTime(r.created_at)}</td>
              <td style={{ ...td, fontFamily: 'monospace', fontWeight: 600 }}>{r.pick_sku}</td>
              <td style={td}>{r.name || '—'}</td>
              <td style={td}>{r.category || <span style={{ color: '#9ca3af' }}>—</span>}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmt(r.pieces, 1)}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: '#dc2626' }}>{r.lbs != null ? fmt(r.lbs, 1) : <span style={{ color: '#9ca3af', fontWeight: 400 }}>—</span>}</td>
              <td style={{ ...td, color: '#6b7280', fontSize: 12 }}>{r.note || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const lblStyle = { display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.05em', marginBottom: 6 }
const pillStyle = { padding: '5px 12px', borderRadius: 6, border: '1px solid', fontWeight: 500, fontSize: 13, cursor: 'pointer' }
const inputStyle = { padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' }
const errorBox = { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '12px 16px', color: '#dc2626' }
const emptyStyle = { padding: 32, textAlign: 'center', color: '#9ca3af', background: '#f9fafb', borderRadius: 8, border: '1px dashed #e5e7eb' }
const th = { padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }
const td = { padding: '6px 10px' }
