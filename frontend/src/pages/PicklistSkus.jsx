import { useState } from 'react'
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

function EditableRow({ item, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({})

  function startEdit() {
    const initial = {}
    for (const f of EDITABLE_FIELDS) initial[f.key] = item[f.key] ?? ''
    setDraft(initial)
    setEditing(true)
  }

  function cancel() { setEditing(false) }

  function save() {
    const payload = {}
    for (const f of EDITABLE_FIELDS) {
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
        {EDITABLE_FIELDS.map(f => (
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
      {EDITABLE_FIELDS.map(f => (
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
  const [urlParams] = useSearchParams()
  const [search, setSearch] = useState(urlParams.get('search') || '')
  const [page, setPage] = useState(0)
  const limit = 200
  const [syncResult, setSyncResult] = useState(null)

  const { data = { total: 0, items: [] }, isLoading } = useQuery({
    queryKey: ['picklist-skus', search, page],
    queryFn: () => picklistSkusApi.list({ search: search || undefined, skip: page * limit, limit }),
  })

  const syncMut = useMutation({
    mutationFn: picklistSkusApi.sync,
    onSuccess: (res) => {
      setSyncResult(res)
      qc.invalidateQueries(['picklist-skus'])
      qc.invalidateQueries(['pactor-map'])
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, payload }) => picklistSkusApi.update(id, payload),
    onSuccess: () => qc.invalidateQueries(['picklist-skus']),
  })

  function handleSave(id, payload, done) {
    updateMut.mutate({ id, payload }, { onSuccess: done })
  }

  const { total, items } = data
  const totalPages = Math.ceil(total / limit)

  return (
    <div>
      <div className="page-header">
        <h1>Picklist SKUs</h1>
        <p>App is source of truth. Sync pulls from Google Sheets; edits here override sheet values.</p>
      </div>

      <div className="toolbar">
        <input
          placeholder="Search SKU or description..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          style={{ minWidth: 240 }}
        />
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
          {total} SKUs
        </span>
      </div>

      {total === 0 && !isLoading && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#9ca3af' }}>
          No picklist SKUs in database. Click <strong>Sync from Sheets</strong> to pull data.
        </div>
      )}

      {items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 1100 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 160 }}>Pick SKU</th>
                {EDITABLE_FIELDS.map(f => (
                  <th key={f.key} style={{ minWidth: f.width }} title={f.hint || undefined}>{f.label}</th>
                ))}
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <EditableRow key={item.id} item={item} onSave={handleSave} />
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
