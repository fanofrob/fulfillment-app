import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { skuHelperApi } from '../api'

function EditableRow({ item, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({})

  function startEdit() {
    setDraft({ helper_sku: item.helper_sku ?? '', notes: item.notes ?? '' })
    setEditing(true)
  }
  function cancel() { setEditing(false) }
  function save() {
    onSave(item.id, {
      helper_sku: draft.helper_sku.trim(),
      notes: draft.notes === '' ? null : draft.notes,
    }, () => setEditing(false))
  }

  if (editing) {
    return (
      <tr style={{ background: '#fefce8' }}>
        <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{item.shopify_sku}</td>
        <td>
          <input
            type="text"
            value={draft.helper_sku}
            onChange={e => setDraft(d => ({ ...d, helper_sku: e.target.value }))}
            style={{ width: 240, fontSize: 12, padding: '2px 4px', border: '1px solid #93c5fd', borderRadius: 3 }}
          />
        </td>
        <td>
          <input
            type="text"
            value={draft.notes}
            onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
            style={{ width: 280, fontSize: 12, padding: '2px 4px', border: '1px solid #93c5fd', borderRadius: 3 }}
          />
        </td>
        <td style={{ fontSize: 11, color: '#9ca3af' }}>
          {item.synced_at ? new Date(item.synced_at).toLocaleDateString() : '—'}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="btn btn-primary" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }} onClick={save}>Save</button>
          <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={cancel}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ cursor: 'pointer' }} onDoubleClick={startEdit}>
      <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap', color: '#16a34a' }}>{item.shopify_sku}</td>
      <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{item.helper_sku}</td>
      <td style={{ fontSize: 13, color: item.notes ? '#111' : '#d1d5db' }}>{item.notes || '—'}</td>
      <td style={{ fontSize: 11, color: '#9ca3af' }}>
        {item.synced_at ? new Date(item.synced_at).toLocaleDateString() : '—'}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }} onClick={startEdit}>Edit</button>
        <button
          className="btn btn-secondary"
          style={{ fontSize: 11, padding: '2px 8px', color: '#dc2626' }}
          onClick={() => {
            if (window.confirm(`Delete mapping for "${item.shopify_sku}"?`)) onDelete(item.id)
          }}
        >Delete</button>
      </td>
    </tr>
  )
}

function NewRow({ onCreate, isPending }) {
  const [shopifySku, setShopifySku] = useState('')
  const [helperSku, setHelperSku] = useState('')
  const [notes, setNotes] = useState('')

  function submit() {
    if (!shopifySku.trim() || !helperSku.trim()) return
    onCreate({
      shopify_sku: shopifySku.trim(),
      helper_sku: helperSku.trim(),
      notes: notes.trim() || null,
    }, () => {
      setShopifySku(''); setHelperSku(''); setNotes('')
    })
  }

  return (
    <tr style={{ background: '#f0fdf4' }}>
      <td>
        <input
          type="text"
          placeholder="e.g. f.passionfruit_purple-5lb_2"
          value={shopifySku}
          onChange={e => setShopifySku(e.target.value)}
          style={{ width: 280, fontSize: 12, padding: '2px 4px', border: '1px solid #86efac', borderRadius: 3 }}
        />
      </td>
      <td>
        <input
          type="text"
          placeholder="e.g. f.passionfruit_purple-5lb"
          value={helperSku}
          onChange={e => setHelperSku(e.target.value)}
          style={{ width: 240, fontSize: 12, padding: '2px 4px', border: '1px solid #86efac', borderRadius: 3 }}
        />
      </td>
      <td>
        <input
          type="text"
          placeholder="(optional)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          style={{ width: 280, fontSize: 12, padding: '2px 4px', border: '1px solid #86efac', borderRadius: 3 }}
        />
      </td>
      <td>—</td>
      <td>
        <button
          className="btn btn-primary"
          style={{ fontSize: 11, padding: '2px 8px' }}
          onClick={submit}
          disabled={!shopifySku.trim() || !helperSku.trim() || isPending}
        >Add</button>
      </td>
    </tr>
  )
}

export default function SkuHelper() {
  const qc = useQueryClient()
  const [urlParams] = useSearchParams()
  const [search, setSearch] = useState(urlParams.get('search') || '')
  const [page, setPage] = useState(0)
  const limit = 200
  const [syncResult, setSyncResult] = useState(null)
  const [createError, setCreateError] = useState(null)

  const { data = { total: 0, items: [] }, isLoading } = useQuery({
    queryKey: ['sku-helper', search, page],
    queryFn: () => skuHelperApi.list({ search: search || undefined, skip: page * limit, limit }),
  })

  const syncMut = useMutation({
    mutationFn: skuHelperApi.sync,
    onSuccess: (res) => {
      setSyncResult(res)
      qc.invalidateQueries({ queryKey: ['sku-helper'] })
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, payload }) => skuHelperApi.update(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sku-helper'] }),
  })

  const createMut = useMutation({
    mutationFn: skuHelperApi.create,
    onSuccess: () => {
      setCreateError(null)
      qc.invalidateQueries({ queryKey: ['sku-helper'] })
    },
    onError: (err) => setCreateError(err?.response?.data?.detail || err.message),
  })

  const deleteMut = useMutation({
    mutationFn: skuHelperApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sku-helper'] }),
  })

  function handleSave(id, payload, done) {
    updateMut.mutate({ id, payload }, { onSuccess: done })
  }
  function handleCreate(payload, done) {
    createMut.mutate(payload, { onSuccess: done })
  }

  const { total, items } = data
  const totalPages = Math.ceil(total / limit)

  return (
    <div>
      <div className="page-header">
        <h1>SKU Helper</h1>
        <p>
          Maps Shopify SKU variants (e.g. <code>-5lb_2</code>, <code>-1lb_pos</code>) onto a single canonical
          helper SKU so we don't have to add every variant to the SKU mapping. App is the source of truth;
          Sync pulls from the <code>INPUT_SKU_TYPE</code> sheet.
        </p>
      </div>

      <div className="toolbar">
        <input
          placeholder="Search Shopify SKU or helper..."
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
            Synced: {syncResult.created} created, {syncResult.updated} updated, {syncResult.unchanged} unchanged ({syncResult.total_in_sheet} in sheet)
          </span>
        )}
        {syncMut.isError && (
          <span style={{ fontSize: 12, color: '#dc2626' }}>
            Sync failed: {syncMut.error?.response?.data?.detail || syncMut.error?.message}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {total} mappings
        </span>
      </div>

      {createError && (
        <div style={{ margin: '8px 0', padding: '6px 10px', background: '#fee2e2', color: '#991b1b', fontSize: 12, borderRadius: 4 }}>
          {createError}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: 1000 }}>
          <thead>
            <tr>
              <th style={{ minWidth: 280 }}>Shopify SKU</th>
              <th style={{ minWidth: 240 }}>Helper SKU</th>
              <th style={{ minWidth: 280 }}>Notes</th>
              <th style={{ minWidth: 100 }}>Last synced</th>
              <th style={{ width: 130 }}></th>
            </tr>
          </thead>
          <tbody>
            <NewRow onCreate={handleCreate} isPending={createMut.isPending} />
            {items.map(item => (
              <EditableRow
                key={item.id}
                item={item}
                onSave={handleSave}
                onDelete={(id) => deleteMut.mutate(id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {total === 0 && !isLoading && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af' }}>
          No helper mappings yet. Click <strong>Sync from Sheets</strong> to import from <code>INPUT_SKU_TYPE</code>, or add a row above.
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
