import { useState, useMemo, useCallback, useEffect, useRef, Component } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table'
import { inventoryApi } from '../api'

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32 }}>
          <h2 style={{ color: '#dc2626', marginBottom: 8 }}>Something went wrong</h2>
          <pre style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: 16, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const WAREHOUSES = ['walnut', 'northlake']

function formatQty(val) {
  if (val === null || val === undefined) return '—'
  return Number(val).toFixed(1)
}

function availClass(qty) {
  if (qty == null || qty <= 0) return 'qty-zero'
  if (qty < 10) return 'qty-low'
  return 'qty-ok'
}

// ─── CSV helpers ────────────────────────────────────────────────────────────

const CSV_HEADERS = ['pick_sku', 'name', 'on_hand_qty', 'committed_qty', 'available_qty', 'shipped_qty', 'batch_code', 'days_on_hand']

function csvEscape(val) {
  if (val === null || val === undefined) return ''
  const s = String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
  return s
}

async function printWeeklyReport(warehouse) {
  // Open window immediately (synchronous with user gesture) so popup blockers pass.
  const win = window.open('', '_blank')
  if (!win) { alert('Pop-up blocked — please allow pop-ups for this site.'); return }
  win.document.write('<p style="font-family:sans-serif;padding:32px">Loading…</p>')

  let items
  try {
    items = await inventoryApi.weeklyReport(warehouse)
  } catch (err) {
    win.close()
    alert('Failed to load weekly report')
    return
  }

  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const warehouseLabel = warehouse.charAt(0).toUpperCase() + warehouse.slice(1)

  const fruit = items.filter(i => i.category?.toLowerCase() === 'fruit')
  const packaging = items.filter(i => i.category?.toLowerCase() === 'packaging')
  const other = items.filter(i => {
    const cat = i.category?.toLowerCase()
    return !cat || (cat !== 'fruit' && cat !== 'packaging')
  })

  function renderSection(title, rows) {
    if (!rows.length) return ''
    return `
      <h3 style="margin:24px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#555;border-bottom:1px solid #ccc;padding-bottom:4px">${title}</h3>
      <table>
        <thead><tr>
          <th>SKU</th><th style="text-align:right">Available</th><th>Batch</th><th style="width:110px">Updated Quantity</th><th style="width:200px">Notes</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td>${r.pick_sku}</td>
            <td style="text-align:right">${r.available_qty != null ? Number(r.available_qty).toFixed(1) : '—'}</td>
            <td>${r.batch_code || ''}</td>
            <td></td>
            <td></td>
          </tr>`).join('')}
        </tbody>
      </table>`
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Weekly Inventory Report — ${warehouseLabel} — ${dateStr}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13.2px; color: #111; margin: 32px; }
    h1 { font-size: 19.8px; margin: 0 0 4px; }
    .subtitle { color: #666; font-size: 13.2px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th { text-align: left; font-size: 12.1px; font-weight: 600; color: #555; border: 1px solid #ddd; border-bottom: 2px solid #ddd; padding: 4.8px 8px; }
    td { padding: 4.8px 8px; border: 1px solid #eee; }
    @media print { body { margin: 16px; } }
  </style>
</head>
<body>
  <h1>Weekly Inventory Report — ${warehouseLabel}</h1>
  <div class="subtitle">SKUs with inventory &gt; 0 in the last 7 days &nbsp;·&nbsp; Printed ${dateStr} &nbsp;·&nbsp; ${items.length} SKU${items.length !== 1 ? 's' : ''}</div>
  ${renderSection('Fruit', fruit)}
  ${renderSection('Packaging', packaging)}
  ${renderSection('Other', other)}
</body>
</html>`

  win.document.write(html)
  win.document.close()
  win.focus()
  win.print()
}

function exportCsv(items, warehouse) {
  const rows = items.map(item => CSV_HEADERS.map(h => csvEscape(item[h])).join(','))
  const csv = [CSV_HEADERS.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `inventory-${warehouse}-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { headers: [], rows: [] }
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  const rows = lines.slice(1).map(line => {
    const values = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if (line[i] === ',' && !inQ) {
        values.push(cur.trim())
        cur = ''
      } else {
        cur += line[i]
      }
    }
    values.push(cur.trim())
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))
  })
  return { headers, rows }
}

// ─── CsvImportModal ──────────────────────────────────────────────────────────

function CsvImportModal({ items, onApply, onClose }) {
  const [mode, setMode] = useState('set')  // 'set' | 'add' | 'subtract'
  const [rawRows, setRawRows] = useState(null)  // null = no file yet
  const [note, setNote] = useState('')
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState(null)  // { ok, errors }
  const [parseError, setParseError] = useState('')
  const fileRef = useRef()

  const itemMap = useMemo(() => {
    const m = {}
    items.forEach(item => { m[item.pick_sku] = item })
    return m
  }, [items])

  const diffs = useMemo(() => {
    if (!rawRows) return null
    const changes = []
    for (const { sku, csvVal } of rawRows) {
      const current = itemMap[sku]
      if (!current) continue
      const currentQty = parseFloat(current.on_hand_qty) || 0
      let newOnHand
      if (mode === 'set') newOnHand = csvVal
      else if (mode === 'add') newOnHand = currentQty + csvVal
      else newOnHand = currentQty - csvVal
      if (newOnHand === currentQty) continue
      changes.push({ item: current, csvVal, newOnHand })
    }
    return changes
  }, [rawRows, mode, itemMap])

  const onFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setParseError('')
    setRawRows(null)
    setResult(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const { headers, rows } = parseCsv(ev.target.result)
        if (!headers.includes('pick_sku') || !headers.includes('on_hand_qty')) {
          setParseError('CSV must have columns: pick_sku, on_hand_qty')
          return
        }
        const parsed = []
        for (const row of rows) {
          const sku = row.pick_sku?.trim()
          if (!sku) continue
          const csvVal = parseFloat(row.on_hand_qty)
          if (isNaN(csvVal)) continue
          parsed.push({ sku, csvVal })
        }
        setRawRows(parsed)
      } catch {
        setParseError('Failed to parse CSV. Check the file format.')
      }
    }
    reader.readAsText(file)
  }

  const onApplyChanges = async () => {
    if (!diffs?.length) return
    setApplying(true)
    const ok = []
    const errors = []
    await Promise.all(diffs.map(async ({ item, newOnHand }) => {
      try {
        await onApply(item.id, { on_hand_qty: newOnHand, note: note || undefined })
        ok.push(item.pick_sku)
      } catch {
        errors.push(item.pick_sku)
      }
    }))
    setApplying(false)
    setResult({ ok, errors })
  }

  const modeDescriptions = {
    set: 'Set each SKU\'s on-hand quantity to the CSV value.',
    add: 'Add the CSV value to each SKU\'s current on-hand quantity.',
    subtract: 'Subtract the CSV value from each SKU\'s current on-hand quantity.',
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: 560 }}>
        <h3>Import Inventory CSV</h3>

        {!result ? (
          <>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
              Upload a CSV with <code>pick_sku</code> and <code>on_hand_qty</code> columns.
            </p>

            <div className="form-group" style={{ marginBottom: 16 }}>
              <label>Update Mode</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                {[['set', 'Set to value'], ['add', 'Add'], ['subtract', 'Subtract']].map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setMode(val)}
                    style={{
                      padding: '5px 14px',
                      borderRadius: 6,
                      border: '1px solid',
                      fontSize: 13,
                      cursor: 'pointer',
                      borderColor: mode === val ? '#2563eb' : '#d1d5db',
                      background: mode === val ? '#eff6ff' : '#fff',
                      color: mode === val ? '#1d4ed8' : '#374151',
                      fontWeight: mode === val ? 600 : 400,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{modeDescriptions[mode]}</div>
            </div>

            <div className="form-group">
              <label>CSV File</label>
              <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} />
            </div>

            {parseError && <div className="error-msg" style={{ marginBottom: 12 }}>{parseError}</div>}

            {diffs !== null && (
              <>
                {diffs.length === 0 ? (
                  <div style={{ padding: '12px 0', color: '#888', fontSize: 13 }}>
                    No changes detected — all on-hand quantities match current values.
                  </div>
                ) : (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>
                      {diffs.length} SKU{diffs.length !== 1 ? 's' : ''} will be updated:
                    </div>
                    <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 12, border: '1px solid #e5e7eb', borderRadius: 6 }}>
                      <table style={{ width: '100%', fontSize: 13 }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '6px 10px', background: '#f9fafb' }}>Pick SKU</th>
                            <th style={{ textAlign: 'right', padding: '6px 10px', background: '#f9fafb' }}>Current</th>
                            {mode !== 'set' && <th style={{ textAlign: 'right', padding: '6px 10px', background: '#f9fafb' }}>{mode === 'add' ? '+ Amount' : '− Amount'}</th>}
                            <th style={{ textAlign: 'right', padding: '6px 10px', background: '#f9fafb' }}>New</th>
                            <th style={{ textAlign: 'right', padding: '6px 10px', background: '#f9fafb' }}>Change</th>
                          </tr>
                        </thead>
                        <tbody>
                          {diffs.map(({ item, csvVal, newOnHand }) => {
                            const delta = newOnHand - (item.on_hand_qty ?? 0)
                            return (
                              <tr key={item.pick_sku}>
                                <td style={{ padding: '5px 10px' }} className="mono">{item.pick_sku}</td>
                                <td style={{ textAlign: 'right', padding: '5px 10px' }}>{formatQty(item.on_hand_qty)}</td>
                                {mode !== 'set' && <td style={{ textAlign: 'right', padding: '5px 10px', color: '#6b7280' }}>{formatQty(csvVal)}</td>}
                                <td style={{ textAlign: 'right', padding: '5px 10px', fontWeight: 600 }}>{formatQty(newOnHand)}</td>
                                <td style={{ textAlign: 'right', padding: '5px 10px', fontWeight: 600, color: delta >= 0 ? '#16a34a' : '#dc2626' }}>
                                  {delta >= 0 ? '+' : ''}{formatQty(delta)}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="form-group">
                      <label>Adjustment Note (applied to all updates)</label>
                      <input
                        type="text"
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        placeholder="e.g. Weekly recount 2024-03-18"
                      />
                    </div>
                  </>
                )}
              </>
            )}

            <div className="modal-actions">
              <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
              <button
                type="button"
                onClick={onApplyChanges}
                disabled={!diffs?.length || applying}
                className="btn btn-primary"
              >
                {applying ? 'Applying…' : `Apply ${diffs?.length ?? 0} Change${diffs?.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </>
        ) : (
          <>
            {result.ok.length > 0 && (
              <div style={{ color: '#16a34a', marginBottom: 8 }}>
                ✓ Updated {result.ok.length} SKU{result.ok.length !== 1 ? 's' : ''} successfully.
              </div>
            )}
            {result.errors.length > 0 && (
              <div style={{ color: '#dc2626', marginBottom: 8 }}>
                Failed to update: {result.errors.join(', ')}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" onClick={onClose} className="btn btn-primary">Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── QtyCell ─────────────────────────────────────────────────────────────────

function QtyCell({ row, column, table }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const item = row.original
  const currentVal = item[column.id]

  const onEdit = () => {
    setValue(String(currentVal ?? 0))
    setNote('')
    setEditing(true)
  }

  const onSave = async () => {
    const newVal = parseFloat(value)
    if (isNaN(newVal)) { setEditing(false); return }
    if (newVal === currentVal) { setEditing(false); return }
    setSaving(true)
    try {
      await table.options.meta.updateItem(item.id, { on_hand_qty: newVal, note: note || undefined })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  if (column.id !== 'on_hand_qty') {
    return <span>{formatQty(currentVal)}</span>
  }

  if (editing) {
    return (
      <div className="qty-edit-wrap">
        <input
          type="number"
          step="0.1"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') setEditing(false) }}
          autoFocus
          style={{ width: 80 }}
        />
        <input
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={e => setNote(e.target.value)}
        />
        <div className="qty-edit-actions">
          <button onClick={onSave} disabled={saving} className="btn btn-primary btn-sm">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => setEditing(false)} className="btn btn-secondary btn-sm">Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <button onClick={onEdit} className="qty-clickable" title="Click to edit">
      {formatQty(currentVal)}
    </button>
  )
}

// ─── ColumnFilter ─────────────────────────────────────────────────────────────

function ColumnFilter({ column }) {
  const value = column.getFilterValue() ?? ''
  return (
    <input
      type="text"
      value={value}
      onChange={e => column.setFilterValue(e.target.value)}
      placeholder="Filter…"
      className="col-filter"
    />
  )
}

// ─── ReceiveBatchModal ────────────────────────────────────────────────────────

function ReceiveBatchModal({ item, onClose }) {
  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({
    batch_code: '',
    quantity_received: '',
    received_date: today,
    expiration_date: '',
    notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const qc = useQueryClient()

  const onChange = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const onSubmit = async e => {
    e.preventDefault()
    setError('')
    if (!form.batch_code.trim()) { setError('Batch code is required'); return }
    const qty = parseFloat(form.quantity_received)
    if (isNaN(qty) || qty <= 0) { setError('Quantity must be a positive number'); return }
    if (!form.received_date) { setError('Received date is required'); return }
    setSaving(true)
    try {
      await inventoryApi.receiveBatch(item.id, {
        batch_code: form.batch_code.trim(),
        quantity_received: qty,
        received_date: form.received_date,
        expiration_date: form.expiration_date || undefined,
        notes: form.notes.trim() || undefined,
      })
      qc.invalidateQueries(['inventory-items', item.warehouse])
      qc.invalidateQueries(['inventory-batches', item.id])
      onClose()
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to receive batch')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: 440 }}>
        <h3>Receive Stock — {item.pick_sku}</h3>
        {item.name && <p style={{ margin: '-8px 0 16px', color: '#888', fontSize: 13 }}>{item.name}</p>}
        <form onSubmit={onSubmit}>
          <div className="form-group">
            <label>Batch Code *</label>
            <input value={form.batch_code} onChange={onChange('batch_code')} placeholder="e.g. LOT-2024-03-25" autoFocus />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Quantity Received *</label>
              <input type="number" step="0.1" min="0.1" value={form.quantity_received} onChange={onChange('quantity_received')} placeholder="0.0" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Received Date *</label>
              <input type="date" value={form.received_date} onChange={onChange('received_date')} />
            </div>
            <div className="form-group">
              <label>Expiration Date <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span></label>
              <input type="date" value={form.expiration_date} onChange={onChange('expiration_date')} />
            </div>
          </div>
          <div className="form-group">
            <label>Notes <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span></label>
            <input value={form.notes} onChange={onChange('notes')} placeholder="e.g. Vendor invoice #1234" />
          </div>
          {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? 'Receiving…' : 'Receive Stock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── EditInventoryDrawer ──────────────────────────────────────────────────────

function EditInventoryDrawer({ item, onClose }) {
  const [tab, setTab] = useState('batches') // 'batches' | 'adjust' | 'log'
  const qc = useQueryClient()

  // Batch data
  const { data: batches = [], isLoading: batchesLoading } = useQuery({
    queryKey: ['inventory-batches', item?.id],
    queryFn: () => inventoryApi.getItemBatches(item.id),
    enabled: !!item,
  })

  // Adjustment log data
  const { data: adjustments = [], isLoading: adjLoading } = useQuery({
    queryKey: ['inventory-adjustments', item?.id],
    queryFn: () => inventoryApi.getItemAdjustments(item.id),
    enabled: !!item && tab === 'log',
  })

  const updateBatchMut = useMutation({
    mutationFn: ({ batchId, data }) => inventoryApi.updateBatch(batchId, data),
    onSuccess: () => {
      qc.invalidateQueries(['inventory-batches', item.id])
      qc.invalidateQueries(['inventory-items', item.warehouse])
    },
  })

  const updateItemMut = useMutation({
    mutationFn: (data) => inventoryApi.updateItem(item.id, data),
    onSuccess: () => {
      qc.invalidateQueries(['inventory-items', item.warehouse])
    },
  })

  if (!item) return null

  const today = new Date().toISOString().slice(0, 10)
  const isExpired = (dateStr) => dateStr && new Date(dateStr) < new Date(today)
  const isExpiringSoon = (dateStr) => {
    if (!dateStr) return false
    const exp = new Date(dateStr)
    const now = new Date()
    const days = (exp - now) / (1000 * 60 * 60 * 24)
    return days >= 0 && days <= 7
  }

  return (
    <div className="side-drawer-overlay">
      <div className="side-drawer-backdrop" onClick={onClose} />
      <div className="side-drawer" style={{ width: 640 }}>
        <div className="side-drawer-header">
          <div>
            <div className="side-drawer-title">{item.pick_sku}</div>
            <div className="side-drawer-subtitle">{item.name || 'Inventory Management'}</div>
          </div>
          <button className="side-drawer-close" onClick={onClose}>×</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', padding: '0 24px' }}>
          {[['batches', 'Batches'], ['adjust', 'Adjust'], ['log', 'Adjustment Log']].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                background: 'none', border: 'none', padding: '10px 16px', cursor: 'pointer',
                fontSize: 13, fontWeight: tab === id ? 600 : 400,
                color: tab === id ? '#2563eb' : '#6b7280',
                borderBottom: tab === id ? '2px solid #2563eb' : '2px solid transparent',
                marginBottom: -1,
              }}
            >{label}</button>
          ))}
        </div>

        <div className="side-drawer-body">
          {/* ── Batches Tab ── */}
          {tab === 'batches' && (
            <BatchesTab
              item={item}
              batches={batches}
              loading={batchesLoading}
              onUpdateBatch={updateBatchMut.mutateAsync}
              isExpired={isExpired}
              isExpiringSoon={isExpiringSoon}
            />
          )}

          {/* ── Adjust Tab ── */}
          {tab === 'adjust' && (
            <AdjustTab item={item} onAdjust={updateItemMut.mutateAsync} />
          )}

          {/* ── Log Tab ── */}
          {tab === 'log' && (
            <LogTab adjustments={adjustments} loading={adjLoading} />
          )}
        </div>
      </div>
    </div>
  )
}

function BatchesTab({ item, batches, loading, onUpdateBatch, isExpired, isExpiringSoon }) {
  const [editingId, setEditingId] = useState(null)
  const [editQty, setEditQty] = useState('')
  const [editNote, setEditNote] = useState('')
  const [saving, setSaving] = useState(false)

  const startEdit = (batch) => {
    setEditingId(batch.id)
    setEditQty(String(batch.quantity_remaining))
    setEditNote('')
  }
  const cancelEdit = () => setEditingId(null)

  const saveEdit = async (batch) => {
    const newQty = parseFloat(editQty)
    if (isNaN(newQty) || newQty < 0) return
    setSaving(true)
    try {
      await onUpdateBatch({ batchId: batch.id, data: { quantity_remaining: newQty, notes: editNote || undefined } })
      setEditingId(null)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="loading">Loading batches…</div>

  return (
    <div>
      <div style={{ marginBottom: 12, fontSize: 13, color: '#6b7280' }}>
        Batches let you track individual lots of received inventory with received and expiration dates.
        Adjusting a batch quantity updates the item's on-hand total.
      </div>
      {batches.length === 0 ? (
        <div className="empty">No batches recorded. Use <strong>Receive Stock</strong> to add inventory as a named batch.</div>
      ) : (
        <table style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Batch Code</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Rcvd</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Remaining</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Received</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Expires</th>
              <th style={{ padding: '6px 8px' }}></th>
            </tr>
          </thead>
          <tbody>
            {batches.map(batch => {
              const expired = isExpired(batch.expiration_date)
              const expiring = isExpiringSoon(batch.expiration_date)
              return (
                <tr key={batch.id} style={{ background: expired ? '#fef2f2' : expiring ? '#fffbeb' : undefined }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }} className="mono">{batch.batch_code}</td>
                  <td style={{ textAlign: 'right', padding: '6px 8px', color: '#6b7280' }}>{formatQty(batch.quantity_received)}</td>
                  <td style={{ textAlign: 'right', padding: '6px 8px' }}>
                    {editingId === batch.id ? (
                      <input
                        type="number" step="0.1" min="0"
                        value={editQty}
                        onChange={e => setEditQty(e.target.value)}
                        style={{ width: 70, fontSize: 12, padding: '2px 4px' }}
                        autoFocus
                      />
                    ) : (
                      <span style={{ fontWeight: 600 }}>{formatQty(batch.quantity_remaining)}</span>
                    )}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#6b7280' }}>{batch.received_date || '—'}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {batch.expiration_date ? (
                      <span style={{
                        color: expired ? '#dc2626' : expiring ? '#d97706' : '#6b7280',
                        fontWeight: (expired || expiring) ? 600 : 400,
                      }}>
                        {batch.expiration_date}
                        {expired && ' (expired)'}
                        {!expired && expiring && ' (soon)'}
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    {editingId === batch.id ? (
                      <div style={{ display: 'flex', gap: 4, flexDirection: 'column' }}>
                        <input
                          type="text"
                          placeholder="Note (optional)"
                          value={editNote}
                          onChange={e => setEditNote(e.target.value)}
                          style={{ fontSize: 11, padding: '2px 4px', width: 120 }}
                        />
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => saveEdit(batch)} disabled={saving} className="btn btn-primary btn-sm" style={{ fontSize: 11 }}>
                            {saving ? '…' : 'Save'}
                          </button>
                          <button onClick={cancelEdit} className="btn btn-secondary btn-sm" style={{ fontSize: 11 }}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => startEdit(batch)} className="btn-link" style={{ fontSize: 12 }}>Adjust</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {batches.length > 0 && (
        <div style={{ marginTop: 16, padding: '8px 12px', background: '#f9fafb', borderRadius: 6, fontSize: 12, color: '#6b7280' }}>
          Total batch remaining: <strong>{formatQty(batches.reduce((s, b) => s + b.quantity_remaining, 0))}</strong>
          {' '} · Item on-hand: <strong>{formatQty(item.on_hand_qty)}</strong>
        </div>
      )}
    </div>
  )
}

function AdjustTab({ item, onAdjust }) {
  const [mode, setMode] = useState('set') // 'set' | 'delta'
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  const onSubmit = async e => {
    e.preventDefault()
    setError('')
    setSuccess(false)
    const num = parseFloat(value)
    if (isNaN(num)) { setError('Enter a valid number'); return }
    let newOnHand
    if (mode === 'set') {
      newOnHand = num
    } else {
      newOnHand = (item.on_hand_qty ?? 0) + num
    }
    if (newOnHand < 0) { setError('Resulting on-hand quantity cannot be negative'); return }
    setSaving(true)
    try {
      await onAdjust({ on_hand_qty: newOnHand, note: note.trim() || 'Unknown batch adjustment' })
      setSuccess(true)
      setValue('')
      setNote('')
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to save adjustment')
    } finally {
      setSaving(false)
    }
  }

  const preview = () => {
    const num = parseFloat(value)
    if (isNaN(num)) return null
    if (mode === 'set') return { new: num, delta: num - (item.on_hand_qty ?? 0) }
    return { new: (item.on_hand_qty ?? 0) + num, delta: num }
  }
  const p = preview()

  return (
    <div>
      <div style={{ marginBottom: 16, fontSize: 13, color: '#6b7280' }}>
        Adjust the total on-hand quantity without linking to a specific batch.
        Use this when you know the correct total but not which batch the difference belongs to.
      </div>
      <div style={{ marginBottom: 16, padding: '10px 14px', background: '#f9fafb', borderRadius: 6, fontSize: 13 }}>
        Current on-hand: <strong>{formatQty(item.on_hand_qty)}</strong>
        {' '} · Available: <strong className={availClass(item.available_qty)}>{formatQty(item.available_qty)}</strong>
      </div>

      <form onSubmit={onSubmit}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {[['set', 'Set to value'], ['delta', 'Add / subtract']].map(([m, label]) => (
            <button
              key={m} type="button"
              onClick={() => { setMode(m); setValue(''); setSuccess(false); setError('') }}
              className={mode === m ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            >{label}</button>
          ))}
        </div>

        <div className="form-group">
          <label>
            {mode === 'set' ? 'New on-hand quantity' : 'Adjustment amount (use negative to deduct)'}
          </label>
          <input
            type="number" step="0.1"
            value={value}
            onChange={e => { setValue(e.target.value); setSuccess(false) }}
            placeholder={mode === 'set' ? 'e.g. 150' : 'e.g. -10 or +25'}
            autoFocus
          />
        </div>

        {p !== null && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: p.delta >= 0 ? '#f0fdf4' : '#fef2f2', borderRadius: 6, fontSize: 13 }}>
            New on-hand: <strong>{formatQty(p.new)}</strong>
            {' '} · Change: <strong style={{ color: p.delta >= 0 ? '#16a34a' : '#dc2626' }}>
              {p.delta >= 0 ? '+' : ''}{formatQty(p.delta)}
            </strong>
          </div>
        )}

        <div className="form-group">
          <label>Note</label>
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="e.g. Physical count reconciliation 2024-03-25"
          />
        </div>

        {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
        {success && <div style={{ color: '#16a34a', marginBottom: 12, fontSize: 13 }}>✓ Adjustment saved.</div>}

        <button type="submit" disabled={saving} className="btn btn-primary">
          {saving ? 'Saving…' : 'Save Adjustment'}
        </button>
      </form>
    </div>
  )
}

function LogTab({ adjustments, loading }) {
  const adjClass = (type) => {
    if (type === 'ship_deduct' || type === 'manual_deduct') return 'adj-badge adj-deduct'
    if (type === 'manual_add' || type === 'initial_set' || type === 'restock' || type === 'batch_adjust') return 'adj-badge adj-add'
    return 'adj-badge adj-ship'
  }
  if (loading) return <div className="loading">Loading…</div>
  if (!adjustments.length) return <div className="empty">No adjustments recorded yet.</div>
  return (
    <table style={{ width: '100%', fontSize: 13 }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left', padding: '6px 8px' }}>Date</th>
          <th style={{ textAlign: 'left', padding: '6px 8px' }}>Type</th>
          <th style={{ textAlign: 'right', padding: '6px 8px' }}>Delta</th>
          <th style={{ textAlign: 'left', padding: '6px 8px' }}>Note</th>
        </tr>
      </thead>
      <tbody>
        {adjustments.map(adj => (
          <tr key={adj.id}>
            <td style={{ color: '#888', fontSize: 11, padding: '5px 8px' }}>
              {adj.created_at ? new Date(adj.created_at).toLocaleString() : '—'}
            </td>
            <td style={{ padding: '5px 8px' }}>
              <span className={adjClass(adj.adjustment_type)}>
                {adj.adjustment_type.replace(/_/g, ' ')}
              </span>
            </td>
            <td style={{ textAlign: 'right', fontWeight: 600, padding: '5px 8px', color: adj.delta >= 0 ? '#16a34a' : '#dc2626' }}>
              {adj.delta >= 0 ? '+' : ''}{formatQty(adj.delta)}
            </td>
            <td style={{ color: '#888', fontSize: 11, padding: '5px 8px', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={adj.note || ''}>
              {adj.note || '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ─── AdjustmentDrawer ────────────────────────────────────────────────────────

function AdjustmentDrawer({ item, onClose }) {
  const { data: adjustments, isLoading } = useQuery({
    queryKey: ['inventory-adjustments', item?.id],
    queryFn: () => inventoryApi.getItemAdjustments(item.id),
    enabled: !!item,
  })

  if (!item) return null

  const adjClass = (type) => {
    if (type === 'ship_deduct' || type === 'manual_deduct') return 'adj-badge adj-deduct'
    if (type === 'manual_add' || type === 'initial_set' || type === 'restock') return 'adj-badge adj-add'
    return 'adj-badge adj-ship'
  }

  return (
    <div className="side-drawer-overlay">
      <div className="side-drawer-backdrop" onClick={onClose} />
      <div className="side-drawer">
        <div className="side-drawer-header">
          <div>
            <div className="side-drawer-title">{item.pick_sku}</div>
            <div className="side-drawer-subtitle">{item.name || 'Adjustment Log'}</div>
          </div>
          <button className="side-drawer-close" onClick={onClose}>×</button>
        </div>
        <div className="side-drawer-body">
          {isLoading ? (
            <div className="loading">Loading…</div>
          ) : !adjustments?.length ? (
            <div className="empty">No adjustments recorded yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th style={{ textAlign: 'right' }}>Delta</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map(adj => (
                  <tr key={adj.id}>
                    <td style={{ color: '#888', fontSize: 11 }}>
                      {adj.created_at ? new Date(adj.created_at).toLocaleString() : '—'}
                    </td>
                    <td>
                      <span className={adjClass(adj.adjustment_type)}>
                        {adj.adjustment_type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: adj.delta >= 0 ? '#16a34a' : '#dc2626' }}>
                      {adj.delta >= 0 ? '+' : ''}{formatQty(adj.delta)}
                    </td>
                    <td style={{ color: '#888', fontSize: 11, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={adj.note || ''}>
                      {adj.note || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── AddSkuModal ─────────────────────────────────────────────────────────────

function AddSkuModal({ warehouse, onClose }) {
  const [form, setForm] = useState({ pick_sku: '', name: '', on_hand_qty: '0', batch_code: '', days_on_hand: '' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const qc = useQueryClient()

  const onChange = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const onSubmit = async e => {
    e.preventDefault()
    setError('')
    if (!form.pick_sku.trim()) { setError('Pick SKU is required'); return }
    setSaving(true)
    try {
      await inventoryApi.createItem({
        pick_sku: form.pick_sku.trim(),
        warehouse,
        name: form.name.trim() || undefined,
        on_hand_qty: parseFloat(form.on_hand_qty) || 0,
        batch_code: form.batch_code.trim() || undefined,
        days_on_hand: form.days_on_hand ? parseFloat(form.days_on_hand) : undefined,
      })
      qc.invalidateQueries(['inventory-items', warehouse])
      onClose()
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to create SKU')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: 420 }}>
        <h3>Add New Pick SKU</h3>
        <form onSubmit={onSubmit}>
          <div className="form-group">
            <label>Pick SKU *</label>
            <input value={form.pick_sku} onChange={onChange('pick_sku')} placeholder="e.g. apple-fuji-5lb" />
          </div>
          <div className="form-group">
            <label>Name</label>
            <input value={form.name} onChange={onChange('name')} placeholder="e.g. Fuji Apple 5lb Bag" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>On Hand Qty</label>
              <input type="number" step="0.1" value={form.on_hand_qty} onChange={onChange('on_hand_qty')} />
            </div>
            <div className="form-group">
              <label>Days on Hand</label>
              <input type="number" step="0.1" value={form.days_on_hand} onChange={onChange('days_on_hand')} placeholder="optional" />
            </div>
          </div>
          <div className="form-group">
            <label>Batch Code</label>
            <input value={form.batch_code} onChange={onChange('batch_code')} placeholder="optional" />
          </div>
          {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? 'Creating…' : 'Create SKU'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Inventory (main) ─────────────────────────────────────────────────────────

function InventoryInner({ warehouse, onWarehouseChange }) {
  const [globalSearch, setGlobalSearch] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [drawerItem, setDrawerItem] = useState(null)
  const [editItem, setEditItem] = useState(null)
  const [receiveItem, setReceiveItem] = useState(null)
  const [sorting, setSorting] = useState([])
  const [columnFilters, setColumnFilters] = useState([])
  const [shippedFrom, setShippedFrom] = useState('')
  const [shippedTo, setShippedTo] = useState('')
  const qc = useQueryClient()

  const { data: items = [], isLoading, error } = useQuery({
    queryKey: ['inventory-items', warehouse, shippedFrom, shippedTo],
    queryFn: () => inventoryApi.listItems(warehouse, {
      ...(shippedFrom ? { shipped_from: shippedFrom } : {}),
      ...(shippedTo ? { shipped_to: shippedTo } : {}),
    }),
    refetchInterval: 30000,
    placeholderData: (prev) => prev,
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => inventoryApi.updateItem(id, data),
    onSuccess: () => qc.invalidateQueries(['inventory-items', warehouse]),
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => inventoryApi.deleteItem(id),
    onSuccess: () => qc.invalidateQueries(['inventory-items', warehouse]),
  })

  const recomputeMutation = useMutation({
    mutationFn: () => inventoryApi.recomputeCommitted(warehouse),
    onSuccess: () => qc.invalidateQueries(['inventory-items', warehouse]),
  })

  // Use refs so callbacks are stable (never recreated) but always call the latest mutation
  const updateMutationRef = useRef(updateMutation)
  updateMutationRef.current = updateMutation
  const deleteMutationRef = useRef(deleteMutation)
  deleteMutationRef.current = deleteMutation

  const updateItem = useCallback(async (id, data) => {
    await updateMutationRef.current.mutateAsync({ id, data })
  }, [])

  const deleteItem = useCallback(async (item) => {
    if (item.committed_qty > 0) {
      alert(`Cannot delete ${item.pick_sku}: ${item.committed_qty} units committed to open orders`)
      return
    }
    if (!confirm(`Delete ${item.pick_sku}? This cannot be undone.`)) return
    await deleteMutationRef.current.mutateAsync(item.id)
  }, [])

  const columns = useMemo(() => [
    {
      accessorKey: 'pick_sku',
      header: 'Pick SKU',
      enableColumnFilter: true,
      cell: ({ getValue }) => <span className="mono" style={{ fontWeight: 600 }}>{getValue()}</span>,
    },
    {
      accessorKey: 'name',
      header: 'Name',
      enableColumnFilter: true,
      cell: ({ getValue }) => <span>{getValue() || '—'}</span>,
    },
    {
      accessorKey: 'on_hand_qty',
      header: 'On Hand',
      enableColumnFilter: false,
      cell: (props) => <QtyCell {...props} />,
    },
    {
      accessorKey: 'committed_qty',
      header: 'Committed',
      enableColumnFilter: false,
      cell: ({ getValue }) => (
        <span style={{ fontWeight: 500, color: getValue() > 0 ? '#c2410c' : '#bbb' }}>
          {formatQty(getValue())}
        </span>
      ),
    },
    {
      accessorKey: 'available_qty',
      header: 'Available',
      enableColumnFilter: false,
      cell: ({ getValue }) => (
        <span className={availClass(getValue())}>{formatQty(getValue())}</span>
      ),
    },
    {
      accessorKey: 'shipped_qty',
      header: 'Shipped',
      enableColumnFilter: false,
      cell: ({ getValue }) => <span style={{ color: '#bbb' }}>{formatQty(getValue())}</span>,
    },
    {
      accessorKey: 'batch_code',
      header: 'Batch Code',
      enableColumnFilter: true,
      cell: ({ getValue }) => <span className="mono" style={{ color: '#888' }}>{getValue() || '—'}</span>,
    },
    {
      accessorKey: 'days_on_hand',
      header: 'Days on Hand',
      enableColumnFilter: false,
      cell: ({ getValue }) => <span style={{ color: '#888' }}>{getValue() != null ? Number(getValue()).toFixed(1) : '—'}</span>,
    },
    {
      id: 'actions',
      header: '',
      enableColumnFilter: false,
      cell: ({ row }) => (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => setReceiveItem(row.original)} className="btn-link" title="Receive stock as a new batch">Receive</button>
          <button onClick={() => setEditItem(row.original)} className="btn-link" title="View batches and adjust inventory">Edit</button>
          <button onClick={() => setDrawerItem(row.original)} className="btn-link">Log</button>
          <button
            onClick={() => deleteItem(row.original)}
            disabled={row.original.committed_qty > 0}
            className="btn-link danger"
            title={row.original.committed_qty > 0 ? 'Cannot delete: has committed inventory' : 'Delete SKU'}
          >
            Delete
          </button>
        </div>
      ),
    },
  ], [])

  const filteredData = useMemo(() => {
    if (!globalSearch.trim()) return items
    const s = globalSearch.toLowerCase()
    return items.filter(item =>
      item.pick_sku?.toLowerCase().includes(s) ||
      item.name?.toLowerCase().includes(s)
    )
  }, [items, globalSearch])

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    meta: { updateItem },
  })

  const outOfStock = items.filter(i => (i.available_qty ?? 0) <= 0).length
  const lowStock   = items.filter(i => (i.available_qty ?? 0) > 0 && (i.available_qty ?? 0) < 10).length

  return (
    <div>
      <div className="page-header-row">
        <div className="page-header">
          <h1>Inventory</h1>
          <p>App is the source of truth. Click On Hand to edit. Committed is auto-calculated from open orders.</p>
        </div>
        <div className="page-header-actions">
          <button
            onClick={() => recomputeMutation.mutate()}
            disabled={recomputeMutation.isPending}
            className="btn btn-secondary"
            title="Recalculate committed quantities from open orders"
          >
            {recomputeMutation.isPending ? 'Recomputing…' : '⟳ Recompute Committed'}
          </button>
          <button onClick={() => setShowAddModal(true)} className="btn btn-primary">
            + Add SKU
          </button>
        </div>
      </div>

      {/* Warehouse tabs */}
      <div className="wh-tabs">
        {WAREHOUSES.map(wh => (
          <button
            key={wh}
            onClick={() => onWarehouseChange(wh)}
            className={`wh-tab${warehouse === wh ? ' active' : ''}`}
          >
            {wh.charAt(0).toUpperCase() + wh.slice(1)}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-num">{items.length}</div>
          <div className="stat-label">Total SKUs</div>
        </div>
        <div className="stat-card">
          <div className="stat-num qty-zero" style={{ fontSize: 24 }}>{outOfStock}</div>
          <div className="stat-label">Out of Stock</div>
        </div>
        <div className="stat-card">
          <div className="stat-num qty-low" style={{ fontSize: 24 }}>{lowStock}</div>
          <div className="stat-label">Low Stock (&lt;10)</div>
        </div>
        <div className="stat-card">
          <div className="stat-num qty-ok" style={{ fontSize: 24 }}>{items.length - outOfStock}</div>
          <div className="stat-label">In Stock</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="toolbar">
        <input
          type="text"
          placeholder="Search pick SKU or name…"
          value={globalSearch}
          onChange={e => setGlobalSearch(e.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <label style={{ color: '#666', whiteSpace: 'nowrap' }}>Shipped</label>
          <input
            type="date"
            value={shippedFrom}
            onChange={e => setShippedFrom(e.target.value)}
            style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
          />
          <span style={{ color: '#999' }}>–</span>
          <input
            type="date"
            value={shippedTo}
            onChange={e => setShippedTo(e.target.value)}
            style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
          />
          {(shippedFrom || shippedTo) && (
            <button
              onClick={() => { setShippedFrom(''); setShippedTo('') }}
              className="btn-link"
              style={{ fontSize: 12 }}
            >
              Clear
            </button>
          )}
        </div>
        {columnFilters.length > 0 && (
          <button onClick={() => setColumnFilters([])} className="btn btn-secondary btn-sm">
            Clear column filters
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#999' }}>
          {table.getFilteredRowModel().rows.length} of {items.length} SKUs
        </span>
        <button
          onClick={() => printWeeklyReport(warehouse)}
          className="btn btn-secondary btn-sm"
          title="Print SKUs that had inventory > 0 in the last 7 days"
        >
          Print Weekly Report
        </button>
        <button
          onClick={() => exportCsv(items, warehouse)}
          disabled={items.length === 0}
          className="btn btn-secondary btn-sm"
          title="Download current inventory as CSV"
        >
          ↓ Export CSV
        </button>
        <button
          onClick={() => setShowImportModal(true)}
          className="btn btn-secondary btn-sm"
          title="Upload a CSV to bulk-update on-hand quantities"
        >
          ↑ Import CSV
        </button>
      </div>

      {/* Table — split into Fruit / Packaging / Uncategorized sections */}
      {isLoading ? (
        <div className="loading">Loading inventory…</div>
      ) : error ? (
        <div className="error-msg">Error loading inventory</div>
      ) : (() => {
        const allRows = table.getRowModel().rows
        const fruitRows = allRows.filter(r => r.original.category?.toLowerCase() === 'fruit')
        const packagingRows = allRows.filter(r => r.original.category?.toLowerCase() === 'packaging')
        const otherRows = allRows.filter(r => {
          const cat = r.original.category?.toLowerCase()
          return !cat || (cat !== 'fruit' && cat !== 'packaging')
        })

        function renderSectionRows(rows) {
          return rows.map(row => (
            <tr key={row.id}>
              {row.getVisibleCells().map(cell => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))
        }

        const thead = (
          <thead>
            {table.getHeaderGroups().map(hg => (
              <tr key={hg.id}>
                {hg.headers.map(header => (
                  <th key={header.id}>
                    <div
                      style={header.column.getCanSort() ? { cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 } : {}}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === 'asc' && ' ↑'}
                      {header.column.getIsSorted() === 'desc' && ' ↓'}
                    </div>
                    {header.column.getCanFilter() && (
                      <ColumnFilter column={header.column} />
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
        )

        if (allRows.length === 0) {
          return (
            <div className="data-table-wrap">
              <table>
                {thead}
                <tbody>
                  <tr>
                    <td colSpan={columns.length} className="empty">
                      No inventory items found.{' '}
                      <button onClick={() => setShowAddModal(true)} className="btn-link">Add one.</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )
        }

        return (
          <>
            {fruitRows.length > 0 && (
              <div className="data-table-wrap" style={{ marginBottom: 24 }}>
                <div style={{ padding: '8px 0 6px', fontWeight: 700, fontSize: 15, color: '#16a34a', borderBottom: '2px solid #bbf7d0', marginBottom: 4 }}>
                  Fruit <span style={{ fontWeight: 400, fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>{fruitRows.length} SKUs</span>
                </div>
                <table>{thead}<tbody>{renderSectionRows(fruitRows)}</tbody></table>
              </div>
            )}
            {packagingRows.length > 0 && (
              <div className="data-table-wrap" style={{ marginBottom: 24 }}>
                <div style={{ padding: '8px 0 6px', fontWeight: 700, fontSize: 15, color: '#2563eb', borderBottom: '2px solid #bfdbfe', marginBottom: 4 }}>
                  Packaging <span style={{ fontWeight: 400, fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>{packagingRows.length} SKUs</span>
                </div>
                <table>{thead}<tbody>{renderSectionRows(packagingRows)}</tbody></table>
              </div>
            )}
            {otherRows.length > 0 && (
              <div className="data-table-wrap" style={{ marginBottom: 24 }}>
                <div style={{ padding: '8px 0 6px', fontWeight: 700, fontSize: 15, color: '#6b7280', borderBottom: '2px solid #e5e7eb', marginBottom: 4 }}>
                  Uncategorized <span style={{ fontWeight: 400, fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>{otherRows.length} SKUs</span>
                </div>
                <table>{thead}<tbody>{renderSectionRows(otherRows)}</tbody></table>
              </div>
            )}
          </>
        )
      })()}

      {showAddModal && (
        <AddSkuModal warehouse={warehouse} onClose={() => setShowAddModal(false)} />
      )}
      {showImportModal && (
        <CsvImportModal
          items={items}
          onApply={updateItem}
          onClose={() => { setShowImportModal(false); qc.invalidateQueries(['inventory-items', warehouse]) }}
        />
      )}
      {drawerItem && (
        <AdjustmentDrawer item={drawerItem} onClose={() => setDrawerItem(null)} />
      )}
      {editItem && (
        <EditInventoryDrawer item={editItem} onClose={() => setEditItem(null)} />
      )}
      {receiveItem && (
        <ReceiveBatchModal item={receiveItem} onClose={() => setReceiveItem(null)} />
      )}
    </div>
  )
}

export default function Inventory() {
  const [warehouse, setWarehouse] = useState('walnut')
  return (
    <ErrorBoundary>
      <InventoryInner key={warehouse} warehouse={warehouse} onWarehouseChange={setWarehouse} />
    </ErrorBoundary>
  )
}
