import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { picklistSkusApi } from '../api'

const PICKLIST_CATEGORIES = ['Basic', 'Tropical', 'Exotic']

const COLUMNS = [
  { key: 'type',                label: 'Pick Type',       type: 'text',   width: 150 },
  { key: 'weight_lb',          label: 'Weight (lb)',     type: 'number', width: 90  },
  { key: 'cost_per_lb',        label: 'Cost/lb ($)',     type: 'number', width: 95  },
  { key: 'cost_per_case',      label: 'Cost/case ($)',   type: 'number', width: 95  },
  { key: 'case_weight_lb',     label: 'Case wt (lb)',    type: 'number', width: 95  },
  { key: 'pactor_multiplier',  label: 'Pactor Mult.',    type: 'number', width: 90  },
  { key: 'pactor',             label: 'Pactor',          type: 'number', width: 80  },
  { key: 'temperature',        label: 'Temperature',     type: 'text',   width: 130 },
  { key: 'category',           label: 'Category',        type: 'select', width: 110, options: PICKLIST_CATEGORIES },
  { key: 'status',             label: 'Status',          type: 'text',   width: 100 },
  { key: 'cc_item_id',         label: 'CC Item ID',      type: 'text',   width: 100 },
  { key: 'days_til_expiration',label: 'Days til Expiry', type: 'number', width: 110 },
  { key: 'notes',              label: 'Notes',           type: 'text',   width: 200 },
]

const MISSING_COGS_COLS = COLUMNS.filter(c =>
  ['type', 'weight_lb', 'cost_per_lb', 'cost_per_case', 'case_weight_lb'].includes(c.key)
)

// ── Cell editor ─────────────────────────────────────────────────────────────

const editorStyle = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  border: 'none',
  outline: 'none',
  padding: '4px 6px',
  fontSize: 12,
  background: '#eff6ff',
  font: 'inherit',
  boxSizing: 'border-box',
  zIndex: 5,
}

function CellEditor({ col, initialValue, onCommit, onCancel }) {
  const [draft, setDraft] = useState(initialValue ?? '')
  const draftRef = useRef(draft)
  draftRef.current = draft
  const inputRef = useRef(null)
  const doneRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (typeof el.select === 'function') el.select()
  }, [])

  function commit(dir) {
    if (doneRef.current) return
    doneRef.current = true
    let parsed
    if (col.type === 'number') {
      const v = draftRef.current
      parsed = v === '' || v == null ? null : Number(v)
      if (Number.isNaN(parsed)) parsed = null
    } else {
      const v = draftRef.current
      parsed = v === '' ? null : v
    }
    onCommit(parsed, dir)
  }

  function cancel() {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }

  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(e.shiftKey ? 'up' : 'down') }
    else if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? 'left' : 'right') }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  }

  if (col.type === 'select') {
    return (
      <select
        ref={inputRef}
        value={draft ?? ''}
        onChange={e => {
          draftRef.current = e.target.value
          setTimeout(() => commit('down'), 0)
        }}
        onBlur={() => commit(null)}
        onKeyDown={onKey}
        style={editorStyle}
      >
        <option value="">—</option>
        {col.options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }

  return (
    <input
      ref={inputRef}
      type={col.type === 'number' ? 'number' : 'text'}
      step={col.type === 'number' ? 'any' : undefined}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => commit(null)}
      onKeyDown={onKey}
      style={editorStyle}
    />
  )
}

// ── Cell display ─────────────────────────────────────────────────────────────

const cellDisplayStyle = {
  display: 'block',
  width: '100%',
  padding: '4px 6px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  cursor: 'cell',
  userSelect: 'none',
  lineHeight: '22px',
  minHeight: 30,
}

function fmtCell(col, val, row, getVal) {
  if (col.key === 'cost_per_lb') {
    if (val != null)
      return <span style={{ color: '#16a34a', fontWeight: 500 }}>${Number(val).toFixed(4)}</span>
    const cpc = getVal(row, 'cost_per_case')
    const cwl = getVal(row, 'case_weight_lb')
    if (cpc != null && cwl)
      return (
        <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>
          ${(cpc / cwl).toFixed(4)} <span style={{ fontSize: 10 }}>(calc)</span>
        </span>
      )
    return <span style={{ color: '#e5e7eb' }}>—</span>
  }
  if (col.key === 'pactor' && val != null)
    return <span className="pactor-chip pactor-line">{val}</span>
  if (val == null || val === '')
    return <span style={{ color: '#e5e7eb' }}>—</span>
  return val
}

// ── Modals ───────────────────────────────────────────────────────────────────

function Overlay({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.4)',
      zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {children}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function PicklistSkus() {
  const qc = useQueryClient()
  const [urlParams, setUrlParams] = useSearchParams()
  const filter = urlParams.get('filter') || ''
  const isMissingCogs = filter === 'missing-cogs'
  const [search, setSearch] = useState(urlParams.get('search') || '')
  const [categoryFilter, setCategoryFilter] = useState(urlParams.get('category') || '')
  const [page, setPage] = useState(0)
  const limit = 200
  const [syncResult, setSyncResult] = useState(null)

  // Spreadsheet editing state
  const [editing, setEditing] = useState(null)   // { rowId, colIdx }
  const [dirtyRows, setDirtyRows] = useState({}) // { [rowId]: { [colKey]: value } }

  // UI state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newSkuDraft, setNewSkuDraft] = useState('')
  const [createError, setCreateError] = useState(null)
  const [saveMsg, setSaveMsg] = useState(null)
  const [saveMsgIsErr, setSaveMsgIsErr] = useState(false)

  const hasDirty = Object.keys(dirtyRows).length > 0
  const dirtyCount = Object.keys(dirtyRows).length

  // ── Navigation warnings (browser unload + SPA link clicks) ────────────────
  useEffect(() => {
    if (!hasDirty) return
    function onBeforeUnload(e) { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasDirty])

  useEffect(() => {
    if (!hasDirty) return
    function onNavClick(e) {
      const link = e.target.closest('a[href]')
      if (!link) return
      const href = link.getAttribute('href')
      if (!href || href.startsWith('http') || href.startsWith('#')) return
      if (!window.confirm('You have unsaved changes. Leave without saving?')) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('click', onNavClick, true)
    return () => document.removeEventListener('click', onNavClick, true)
  }, [hasDirty])

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data = { total: 0, items: [] }, isLoading } = useQuery({
    queryKey: ['picklist-skus', search, categoryFilter, page],
    queryFn: () => picklistSkusApi.list({
      search: search || undefined,
      category: categoryFilter || undefined,
      skip: page * limit,
      limit,
    }),
    enabled: !isMissingCogs,
  })

  const { data: missingCogsData = [], isLoading: missingLoading } = useQuery({
    queryKey: ['picklist-skus-missing-cogs'],
    queryFn: picklistSkusApi.missingCogs,
    enabled: isMissingCogs,
  })

  // ── Mutations ──────────────────────────────────────────────────────────────
  const syncMut = useMutation({
    mutationFn: picklistSkusApi.sync,
    onSuccess: (res) => {
      setSyncResult(res)
      qc.invalidateQueries(['picklist-skus'])
      qc.invalidateQueries(['picklist-skus-missing-cogs'])
      qc.invalidateQueries(['pactor-map'])
    },
  })

  const saveMut = useMutation({
    mutationFn: async () => {
      const count = Object.keys(dirtyRows).length
      await Promise.all(
        Object.entries(dirtyRows).map(([id, changes]) =>
          picklistSkusApi.update(parseInt(id), changes)
        )
      )
      return count
    },
    onSuccess: (count) => {
      setDirtyRows({})
      setSaveMsg(`Saved ${count} row${count === 1 ? '' : 's'}`)
      setSaveMsgIsErr(false)
      setTimeout(() => setSaveMsg(null), 3000)
      qc.invalidateQueries(['picklist-skus'])
      qc.invalidateQueries(['picklist-skus-missing-cogs'])
    },
    onError: (err) => {
      setSaveMsg(`Save failed: ${err?.response?.data?.detail || err.message}`)
      setSaveMsgIsErr(true)
    },
  })

  const createMut = useMutation({
    mutationFn: (payload) => picklistSkusApi.create(payload),
    onSuccess: () => {
      setShowCreateModal(false)
      setNewSkuDraft('')
      setCreateError(null)
      qc.invalidateQueries(['picklist-skus'])
    },
    onError: (err) => setCreateError(err?.response?.data?.detail || err.message),
  })

  // ── Derived ────────────────────────────────────────────────────────────────
  const { total, items } = isMissingCogs
    ? { total: missingCogsData.length, items: missingCogsData }
    : data
  const totalPages = isMissingCogs ? 1 : Math.ceil(total / limit)
  const activeCols = isMissingCogs ? MISSING_COGS_COLS : COLUMNS

  function getVal(row, colKey) {
    if (dirtyRows[row.id] && colKey in dirtyRows[row.id]) return dirtyRows[row.id][colKey]
    return row[colKey]
  }

  // ── Cell commit / navigation ───────────────────────────────────────────────
  function commitEdit(rowId, colIdx, value, dir) {
    const col = activeCols[colIdx]
    setDirtyRows(prev => ({
      ...prev,
      [rowId]: { ...(prev[rowId] || {}), [col.key]: value },
    }))
    if (dir === 'down') {
      const rowIdx = items.findIndex(r => r.id === rowId)
      const next = items[rowIdx + 1]
      setEditing(next ? { rowId: next.id, colIdx } : null)
    } else if (dir === 'up') {
      const rowIdx = items.findIndex(r => r.id === rowId)
      const prev = items[rowIdx - 1]
      setEditing(prev ? { rowId: prev.id, colIdx } : null)
    } else if (dir === 'right') {
      setEditing(colIdx + 1 < activeCols.length ? { rowId, colIdx: colIdx + 1 } : null)
    } else if (dir === 'left') {
      setEditing(colIdx > 0 ? { rowId, colIdx: colIdx - 1 } : null)
    } else {
      setEditing(null)
    }
  }

  function clearFilter() {
    const next = new URLSearchParams(urlParams)
    next.delete('filter')
    setUrlParams(next, { replace: true })
  }

  const missingCount = isMissingCogs ? missingCogsData.length : 0

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Create SKU modal */}
      {showCreateModal && (
        <Overlay>
          <div style={{
            background: '#fff', borderRadius: 8, padding: 24,
            width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Create New SKU</h3>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                Pick SKU <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input
                autoFocus
                value={newSkuDraft}
                onChange={e => { setNewSkuDraft(e.target.value); setCreateError(null) }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newSkuDraft.trim())
                    createMut.mutate({ pick_sku: newSkuDraft.trim() })
                }}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  fontSize: 13, padding: '6px 8px',
                  border: '1px solid #d1d5db', borderRadius: 4,
                }}
                placeholder="e.g. apple_honeycrisp-01x02"
              />
            </div>
            {createError && (
              <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 12 }}>{createError}</div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="btn btn-secondary"
                onClick={() => { setShowCreateModal(false); setNewSkuDraft(''); setCreateError(null) }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => newSkuDraft.trim() && createMut.mutate({ pick_sku: newSkuDraft.trim() })}
                disabled={!newSkuDraft.trim() || createMut.isPending}
              >
                {createMut.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </Overlay>
      )}

      <div className="page-header">
        <h1>Picklist SKUs</h1>
        <p>App is source of truth. Sync pulls from Google Sheets; edits here override sheet values.</p>
      </div>

      {isMissingCogs && (
        <div className="warning-banner" style={{ justifyContent: 'space-between' }}>
          <span>
            <strong>Filter: SKUs missing COGS</strong> — {missingCount} SKU{missingCount === 1 ? '' : 's'} need cost
            data, sorted by orders blocked. Set <code>cost_per_lb</code> or{' '}
            <code>cost_per_case</code> + <code>case_weight_lb</code> to clear each row.
          </span>
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={clearFilter}>
            Clear filter
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="toolbar">
        {!isMissingCogs && (
          <>
            <input
              placeholder="Search SKU or description…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(0) }}
              style={{ minWidth: 240 }}
            />
            <select
              value={categoryFilter}
              onChange={e => { setCategoryFilter(e.target.value); setPage(0) }}
              style={{ fontSize: 13, padding: '4px 6px' }}
            >
              <option value="">All categories</option>
              {PICKLIST_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="uncategorized">Uncategorized</option>
            </select>
          </>
        )}

        <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
          + New SKU
        </button>

        {hasDirty && (
          <>
            <button
              className="btn btn-primary"
              style={{ background: '#16a34a', borderColor: '#16a34a' }}
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
            >
              {saveMut.isPending ? 'Saving…' : `Save (${dirtyCount} row${dirtyCount === 1 ? '' : 's'})`}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => { setDirtyRows({}); setEditing(null) }}
              disabled={saveMut.isPending}
            >
              Discard
            </button>
          </>
        )}

        <button
          className="btn btn-primary"
          onClick={() => { setSyncResult(null); syncMut.mutate() }}
          disabled={syncMut.isPending}
        >
          {syncMut.isPending ? 'Syncing…' : '↓ Sync from Sheets'}
        </button>

        {saveMsg && (
          <span style={{ fontSize: 12, color: saveMsgIsErr ? '#dc2626' : '#16a34a' }}>
            {saveMsg}
          </span>
        )}
        {syncResult && !syncMut.isPending && (
          <span style={{ fontSize: 12, color: '#16a34a' }}>
            Synced: {syncResult.created} created, {syncResult.updated} updated ({syncResult.total} total)
          </span>
        )}
        {syncMut.isError && (
          <span style={{ fontSize: 12, color: '#dc2626' }}>
            Sync failed: {syncMut.error?.response?.data?.detail || syncMut.error?.message}
          </span>
        )}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {total} SKU{total === 1 ? '' : 's'}
        </span>
      </div>

      {/* Empty state */}
      {total === 0 && !isLoading && !missingLoading && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#9ca3af' }}>
          {isMissingCogs
            ? 'No SKUs missing COGS. All set!'
            : <>No picklist SKUs in database. Click <strong>Sync from Sheets</strong> to pull data.</>}
        </div>
      )}

      {/* Table */}
      {items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table
            className="data-table"
            style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}
          >
            <thead>
              <tr>
                <th style={{
                  position: 'sticky', left: 0, zIndex: 3,
                  background: '#f9fafb', minWidth: 170, whiteSpace: 'nowrap',
                  borderRight: '2px solid #e5e7eb',
                }}>
                  Pick SKU
                </th>
                {isMissingCogs && (
                  <>
                    <th style={{ minWidth: 90 }} title="Active orders blocked by this missing COGS">
                      Orders blocked
                    </th>
                    <th style={{ minWidth: 110 }} title="Total revenue of orders blocked by this SKU">
                      Revenue at risk
                    </th>
                  </>
                )}
                {activeCols.map(col => (
                  <th key={col.key} style={{ minWidth: col.width }}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(row => (
                <tr key={row.id}>
                  {/* Frozen Pick SKU column */}
                  <td style={{
                    position: 'sticky', left: 0, zIndex: 1,
                    background: '#fff',
                    borderRight: '2px solid #e5e7eb',
                    padding: '4px 8px',
                    fontSize: 12, whiteSpace: 'nowrap',
                    color: '#16a34a', fontWeight: 500,
                    fontFamily: 'monospace',
                  }}>
                    {row.pick_sku}
                  </td>

                  {/* Missing COGS extra columns */}
                  {isMissingCogs && (
                    <>
                      <td style={{ fontSize: 13, fontWeight: 600, color: '#dc2626' }}>
                        {row.affected_order_count ?? 0}
                      </td>
                      <td style={{ fontSize: 13 }}>
                        ${(row.revenue_at_risk ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                    </>
                  )}

                  {/* Editable cells */}
                  {activeCols.map((col, colIdx) => {
                    const isEditing = editing?.rowId === row.id && editing?.colIdx === colIdx
                    const isDirty = dirtyRows[row.id] != null && col.key in dirtyRows[row.id]
                    const val = getVal(row, col.key)
                    return (
                      <td
                        key={col.key}
                        style={{
                          position: 'relative',
                          padding: 0,
                          minWidth: col.width,
                          background: isEditing ? '#dbeafe' : isDirty ? '#fef9c3' : undefined,
                          outline: isEditing ? '2px solid #3b82f6' : isDirty ? '1px solid #fde047' : 'none',
                          outlineOffset: -1,
                        }}
                        onClick={() => !isEditing && setEditing({ rowId: row.id, colIdx })}
                      >
                        {isEditing ? (
                          <CellEditor
                            col={col}
                            initialValue={String(val ?? '')}
                            onCommit={(value, dir) => commitEdit(row.id, colIdx, value, dir)}
                            onCancel={() => setEditing(null)}
                          />
                        ) : (
                          <span style={cellDisplayStyle}>
                            {fmtCell(col, val, row, getVal)}
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, fontSize: 13 }}>
          <button
            className="btn btn-secondary"
            onClick={() => setPage(p => p - 1)}
            disabled={page === 0}
          >← Prev</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button
            className="btn btn-secondary"
            onClick={() => setPage(p => p + 1)}
            disabled={page >= totalPages - 1}
          >Next →</button>
        </div>
      )}
    </div>
  )
}
