import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { picklistSkusApi } from '../api'

const EDITABLE_FIELDS = [
  { key: 'type',                 label: 'Pick Type',         type: 'text',   width: 140 },
  { key: 'weight_lb',            label: 'Weight (lb)',       type: 'number', width: 90 },
  { key: 'cost_per_lb',          label: 'Cost/lb ($)',       type: 'number', width: 90, hint: 'Direct cost per lb' },
  { key: 'cost_per_case',        label: 'Cost/case ($)',     type: 'number', width: 90, hint: 'Cost for one full case' },
  { key: 'case_weight_lb',       label: 'Case wt (lb)',      type: 'number', width: 90, hint: 'Weight of one full case — app computes cost/lb = cost_per_case ÷ case_weight' },
  { key: 'pactor_multiplier',    label: 'Pactor Mult.',      type: 'number', width: 90 },
  { key: 'pactor',               label: 'Pactor',            type: 'number', width: 80 },
  { key: 'temperature',          label: 'Temperature',       type: 'text',   width: 120 },
  { key: 'category',             label: 'Category',          type: 'text',   width: 110 },
  { key: 'status',               label: 'Status',            type: 'text',   width: 100 },
  { key: 'cc_item_id',           label: 'CC Item ID',        type: 'text',   width: 100 },
  { key: 'days_til_expiration',  label: 'Days til Expiry',   type: 'number', width: 110 },
  { key: 'notes',                label: 'Notes',             type: 'text',   width: 160 },
]

// Focused column set for the missing-COGS filter view — only shows the fields
// that actually need to be edited to clear a missing-COGS row.
const MISSING_COGS_FIELDS = EDITABLE_FIELDS.filter(f =>
  ['type', 'weight_lb', 'cost_per_lb', 'cost_per_case', 'case_weight_lb'].includes(f.key)
)

function EditableRow({ item, onSave, prefixCells = null, fields = EDITABLE_FIELDS }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({})

  function startEdit() {
    const initial = {}
    for (const f of fields) initial[f.key] = item[f.key] ?? ''
    setDraft(initial)
    setEditing(true)
  }

  function cancel() { setEditing(false) }

  function save() {
    const payload = {}
    for (const f of fields) {
      const raw = draft[f.key]
      if (f.type === 'number') {
        payload[f.key] = raw === '' || raw === null ? null : Number(raw)
      } else {
        payload[f.key] = raw === '' ? null : raw
      }
    }
    onSave(item.id, payload, () => setEditing(false))
  }

  function fmt(val) {
    if (val == null || val === '') return <span style={{ color: '#d1d5db' }}>—</span>
    return val
  }

  if (editing) {
    return (
      <tr style={{ background: '#fefce8' }}>
        <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{item.pick_sku}</td>
        {prefixCells}
        {fields.map(f => (
          <td key={f.key}>
            <input
              type={f.type === 'number' ? 'number' : 'text'}
              value={draft[f.key] ?? ''}
              onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
              style={{ width: f.width - 16, fontSize: 12, padding: '2px 4px', border: '1px solid #93c5fd', borderRadius: 3 }}
              step={f.type === 'number' ? 'any' : undefined}
            />
          </td>
        ))}
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="btn btn-primary" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }} onClick={save}>Save</button>
          <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={cancel}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ cursor: 'pointer' }} onDoubleClick={startEdit}>
      <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap', color: '#16a34a' }}>{item.pick_sku}</td>
      {prefixCells}
      {fields.map(f => (
        <td key={f.key} style={{ fontSize: 13 }} title={f.hint || undefined}>
          {f.key === 'pactor' && item[f.key] != null
            ? <span className="pactor-chip pactor-line">{item[f.key]}</span>
            : f.key === 'cost_per_lb' && item.cost_per_lb == null && item.cost_per_case != null && item.case_weight_lb
              ? <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>
                  ${(item.cost_per_case / item.case_weight_lb).toFixed(4)} <span style={{ fontSize: 11 }}>(calc)</span>
                </span>
              : f.key === 'cost_per_lb' && item.cost_per_lb != null
                ? <span style={{ color: '#16a34a', fontWeight: 500 }}>${item.cost_per_lb.toFixed(4)}</span>
                : fmt(item[f.key])
          }
        </td>
      ))}
      <td>
        <button
          className="btn btn-secondary"
          style={{ fontSize: 11, padding: '2px 8px' }}
          onClick={startEdit}
        >Edit</button>
      </td>
    </tr>
  )
}

export default function PicklistSkus() {
  const qc = useQueryClient()
  const [urlParams, setUrlParams] = useSearchParams()
  const filter = urlParams.get('filter') || ''
  const isMissingCogs = filter === 'missing-cogs'
  const [search, setSearch] = useState(urlParams.get('search') || '')
  const [page, setPage] = useState(0)
  const limit = 200
  const [syncResult, setSyncResult] = useState(null)

  const { data = { total: 0, items: [] }, isLoading } = useQuery({
    queryKey: ['picklist-skus', search, page],
    queryFn: () => picklistSkusApi.list({ search: search || undefined, skip: page * limit, limit }),
    enabled: !isMissingCogs,
  })

  const { data: missingCogsData = [], isLoading: missingLoading } = useQuery({
    queryKey: ['picklist-skus-missing-cogs'],
    queryFn: picklistSkusApi.missingCogs,
    enabled: isMissingCogs,
  })

  const syncMut = useMutation({
    mutationFn: picklistSkusApi.sync,
    onSuccess: (res) => {
      setSyncResult(res)
      qc.invalidateQueries(['picklist-skus'])
      qc.invalidateQueries(['picklist-skus-missing-cogs'])
      qc.invalidateQueries(['pactor-map'])
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, payload }) => picklistSkusApi.update(id, payload),
    onSuccess: () => {
      qc.invalidateQueries(['picklist-skus'])
      qc.invalidateQueries(['picklist-skus-missing-cogs'])
    },
  })

  function handleSave(id, payload, done) {
    updateMut.mutate({ id, payload }, { onSuccess: done })
  }

  function clearFilter() {
    const next = new URLSearchParams(urlParams)
    next.delete('filter')
    setUrlParams(next, { replace: true })
  }

  const missingTotals = useMemo(() => {
    if (!isMissingCogs) return null
    return { skus: missingCogsData.length }
  }, [isMissingCogs, missingCogsData])

  const { total, items } = isMissingCogs
    ? { total: missingCogsData.length, items: missingCogsData }
    : data
  const totalPages = isMissingCogs ? 1 : Math.ceil(total / limit)

  return (
    <div>
      <div className="page-header">
        <h1>Picklist SKUs</h1>
        <p>App is source of truth. Sync pulls from Google Sheets; edits here override sheet values.</p>
      </div>

      {isMissingCogs && (
        <div className="warning-banner" style={{ justifyContent: 'space-between' }}>
          <span>
            <strong>Filter: SKUs missing COGS</strong> — {missingTotals?.skus ?? 0} SKU{missingTotals?.skus === 1 ? '' : 's'} need cost data, sorted by orders blocked.
            Set <code>cost_per_lb</code> or <code>cost_per_case</code> + <code>case_weight_lb</code> to clear each row.
          </span>
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={clearFilter}>Clear filter</button>
        </div>
      )}

      <div className="toolbar">
        {!isMissingCogs && (
          <input
            placeholder="Search SKU or description..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0) }}
            style={{ minWidth: 240 }}
          />
        )}
        <button
          className="btn btn-primary"
          onClick={() => { setSyncResult(null); syncMut.mutate() }}
          disabled={syncMut.isPending}
        >
          {syncMut.isPending ? 'Syncing...' : '↓ Sync from Sheets'}
        </button>
        {syncResult && (
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

      {total === 0 && !isLoading && !missingLoading && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#9ca3af' }}>
          {isMissingCogs
            ? 'No SKUs missing COGS. All set!'
            : <>No picklist SKUs in database. Click <strong>Sync from Sheets</strong> to pull data.</>}
        </div>
      )}

      {items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: isMissingCogs ? 900 : 1100 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 160 }}>Pick SKU</th>
                {isMissingCogs && (
                  <>
                    <th style={{ minWidth: 90 }} title="Active orders blocked by this missing COGS">Orders blocked</th>
                    <th style={{ minWidth: 110 }} title="Total revenue of orders blocked by this SKU">Revenue at risk</th>
                  </>
                )}
                {(isMissingCogs ? MISSING_COGS_FIELDS : EDITABLE_FIELDS).map(f => (
                  <th key={f.key} style={{ minWidth: f.width }} title={f.hint || undefined}>{f.label}</th>
                ))}
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <EditableRow
                  key={item.id}
                  item={item}
                  onSave={handleSave}
                  fields={isMissingCogs ? MISSING_COGS_FIELDS : EDITABLE_FIELDS}
                  prefixCells={isMissingCogs ? (
                    <>
                      <td style={{ fontSize: 13, fontWeight: 600, color: '#dc2626' }}>{item.affected_order_count ?? 0}</td>
                      <td style={{ fontSize: 13 }}>${(item.revenue_at_risk ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    </>
                  ) : null}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, fontSize: 13 }}>
          <button className="btn btn-secondary" onClick={() => setPage(p => p - 1)} disabled={page === 0}>← Prev</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button className="btn btn-secondary" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1}>Next →</button>
        </div>
      )}
    </div>
  )
}
