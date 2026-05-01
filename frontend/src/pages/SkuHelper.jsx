import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { skuHelperApi, shopifySkuRulesApi } from '../api'

// ── Helper Mappings tab ─────────────────────────────────────────────────────

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

function HelperMappingsTab() {
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

// ── Rules tab ───────────────────────────────────────────────────────────────

function fmtNum(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—'
  return Number(v).toFixed(digits).replace(/\.?0+$/, '') || '0'
}

function listToCsv(arr) {
  if (!arr || arr.length === 0) return ''
  return arr.join(', ')
}

function csvToList(s) {
  const parts = (s || '').split(',').map(x => x.trim()).filter(Boolean)
  return parts.length === 0 ? null : parts
}

function emptyDraft() {
  return {
    shopify_sku: '',
    weight_lb: '',
    kind: '',
    single_substitute_product_types_csv: '',
    multi_min_picks: '',
    multi_max_picks: '',
    multi_min_categories: '',
    multi_max_categories: '',
    multi_max_cost_per_lb: '',
    multi_allowed_product_types_csv: '',
    multi_required_picks: [],
    notes: '',
  }
}

function itemToDraft(item) {
  return {
    shopify_sku: item.shopify_sku,
    weight_lb: item.weight_lb ?? '',
    kind: item.kind ?? '',
    single_substitute_product_types_csv: listToCsv(item.single_substitute_product_types),
    multi_min_picks: item.multi_min_picks ?? '',
    multi_max_picks: item.multi_max_picks ?? '',
    multi_min_categories: item.multi_min_categories ?? '',
    multi_max_categories: item.multi_max_categories ?? '',
    multi_max_cost_per_lb: item.multi_max_cost_per_lb ?? '',
    multi_allowed_product_types_csv: listToCsv(item.multi_allowed_product_types),
    multi_required_picks: (item.multi_required_picks || []).map(rp => ({ pick_sku: rp.pick_sku, qty: rp.qty })),
    notes: item.notes ?? '',
  }
}

function draftToPayload(draft) {
  const numOrNull = v => v === '' || v == null ? null : Number(v)
  const intOrNull = v => v === '' || v == null ? null : parseInt(v, 10)
  const kind = draft.kind || null
  const payload = {
    weight_lb: numOrNull(draft.weight_lb),
    kind,
    notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
  }
  if (kind === 'single') {
    payload.single_substitute_product_types = csvToList(draft.single_substitute_product_types_csv)
    payload.multi_min_picks = null
    payload.multi_max_picks = null
    payload.multi_min_categories = null
    payload.multi_max_categories = null
    payload.multi_max_cost_per_lb = null
    payload.multi_allowed_product_types = null
    payload.multi_required_picks = null
  } else if (kind === 'multi') {
    payload.single_substitute_product_types = null
    payload.multi_min_picks = intOrNull(draft.multi_min_picks)
    payload.multi_max_picks = intOrNull(draft.multi_max_picks)
    payload.multi_min_categories = intOrNull(draft.multi_min_categories)
    payload.multi_max_categories = intOrNull(draft.multi_max_categories)
    payload.multi_max_cost_per_lb = numOrNull(draft.multi_max_cost_per_lb)
    payload.multi_allowed_product_types = csvToList(draft.multi_allowed_product_types_csv)
    const picks = draft.multi_required_picks
      .filter(rp => rp.pick_sku.trim() !== '')
      .map(rp => ({ pick_sku: rp.pick_sku.trim(), qty: rp.qty === '' ? 1 : Number(rp.qty) }))
    payload.multi_required_picks = picks.length === 0 ? null : picks
  } else {
    payload.single_substitute_product_types = null
    payload.multi_min_picks = null
    payload.multi_max_picks = null
    payload.multi_min_categories = null
    payload.multi_max_categories = null
    payload.multi_max_cost_per_lb = null
    payload.multi_allowed_product_types = null
    payload.multi_required_picks = null
  }
  return payload
}

function ruleSummaryParts(item) {
  const parts = []
  if (item.kind === 'single') {
    if (item.single_substitute_product_types?.length > 0) {
      parts.push(`subs: ${item.single_substitute_product_types.join(', ')}`)
    }
  } else if (item.kind === 'multi') {
    if (item.multi_min_picks != null || item.multi_max_picks != null) {
      parts.push(`picks ${item.multi_min_picks ?? '—'}–${item.multi_max_picks ?? '—'}`)
    }
    if (item.multi_min_categories != null || item.multi_max_categories != null) {
      parts.push(`cats ${item.multi_min_categories ?? '—'}–${item.multi_max_categories ?? '—'}`)
    }
    if (item.multi_max_cost_per_lb != null) {
      parts.push(`≤$${fmtNum(item.multi_max_cost_per_lb, 2)}/lb`)
    }
    if (item.multi_allowed_product_types?.length > 0) {
      parts.push(`allow: ${item.multi_allowed_product_types.join(', ')}`)
    }
    if (item.multi_required_picks?.length > 0) {
      parts.push(`req: ${item.multi_required_picks.map(rp => `${rp.pick_sku}×${rp.qty}`).join(', ')}`)
    }
  }
  return parts
}

function RuleViewRow({ item, onEdit, onDelete }) {
  const summary = ruleSummaryParts(item)
  const kindColor = item.kind === 'single' ? '#1d4ed8' : item.kind === 'multi' ? '#7c3aed' : '#9ca3af'
  return (
    <tr style={{ cursor: 'pointer' }} onDoubleClick={onEdit}>
      <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap', color: '#16a34a' }}>{item.shopify_sku}</td>
      <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
        {item.weight_lb == null ? <span style={{ color: '#d1d5db' }}>—</span> : <strong>{fmtNum(item.weight_lb)} lb</strong>}
      </td>
      <td style={{ fontSize: 12, textTransform: 'capitalize', color: kindColor, fontWeight: item.kind ? 600 : 400 }}>
        {item.kind || '—'}
      </td>
      <td style={{ fontSize: 12, color: summary.length ? '#1f2937' : '#d1d5db' }}>
        {summary.length === 0 ? '—' : summary.join(' · ')}
      </td>
      <td style={{ fontSize: 12, color: item.notes ? '#1f2937' : '#d1d5db', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.notes || ''}>
        {item.notes || '—'}
      </td>
      <td style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
        {item.updated_at ? new Date(item.updated_at).toLocaleDateString() : (item.created_at ? new Date(item.created_at).toLocaleDateString() : '—')}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }} onClick={onEdit}>Edit</button>
        <button
          className="btn btn-secondary"
          style={{ fontSize: 11, padding: '2px 8px', color: '#dc2626' }}
          onClick={() => {
            if (window.confirm(`Delete rule for "${item.shopify_sku}"?`)) onDelete(item.id)
          }}
        >Delete</button>
      </td>
    </tr>
  )
}

function RuleEditRow({ isNew, item, onSave, onCancel, isPending, error }) {
  const [draft, setDraft] = useState(() => isNew ? emptyDraft() : itemToDraft(item))

  function set(k, v) { setDraft(d => ({ ...d, [k]: v })) }

  function addRequiredPick() {
    setDraft(d => ({ ...d, multi_required_picks: [...d.multi_required_picks, { pick_sku: '', qty: 1 }] }))
  }
  function updateRequiredPick(idx, patch) {
    setDraft(d => ({
      ...d,
      multi_required_picks: d.multi_required_picks.map((rp, i) => i === idx ? { ...rp, ...patch } : rp),
    }))
  }
  function removeRequiredPick(idx) {
    setDraft(d => ({ ...d, multi_required_picks: d.multi_required_picks.filter((_, i) => i !== idx) }))
  }

  function save() {
    const sku = (isNew ? draft.shopify_sku.trim() : item.shopify_sku)
    if (!sku) return
    onSave(sku, draftToPayload(draft))
  }

  const labelStyle = { fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }
  const inputStyle = { fontSize: 12, padding: '3px 6px', border: '1px solid #93c5fd', borderRadius: 3 }
  const sectionStyle = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 4, padding: '10px 12px', marginBottom: 8 }

  return (
    <tr style={{ background: isNew ? '#f0fdf4' : '#fefce8' }}>
      <td colSpan={7} style={{ padding: 12 }}>
        {/* Header row: SKU + weight + kind */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={labelStyle}>Canonical Shopify SKU</span>
              {isNew ? (
                <input
                  type="text"
                  placeholder="e.g. f.passionfruit_purple-5lb"
                  value={draft.shopify_sku}
                  onChange={e => set('shopify_sku', e.target.value)}
                  style={{ ...inputStyle, width: 280, fontFamily: 'monospace' }}
                  autoFocus
                />
              ) : (
                <code style={{ fontSize: 13, color: '#16a34a', padding: '3px 0' }}>{item.shopify_sku}</code>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={labelStyle}>Weight (lb)</span>
              <input
                type="number" step="any"
                placeholder="e.g. 5"
                value={draft.weight_lb}
                onChange={e => set('weight_lb', e.target.value)}
                style={{ ...inputStyle, width: 100 }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={labelStyle}>Kind</span>
              <div style={{ display: 'flex', gap: 12, paddingTop: 4 }}>
                {[
                  { val: '', label: 'None' },
                  { val: 'single', label: 'Single' },
                  { val: 'multi', label: 'Multi' },
                ].map(opt => (
                  <label key={opt.val} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name={`kind-${isNew ? 'new' : item.id}`}
                      checked={draft.kind === opt.val}
                      onChange={() => set('kind', opt.val)}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Single rules */}
        {draft.kind === 'single' && (
          <div style={sectionStyle}>
            <div style={{ ...labelStyle, marginBottom: 6 }}>Single rules</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Substitute product types (comma-separated)</span>
              <input
                type="text"
                placeholder="e.g. mango, papaya"
                value={draft.single_substitute_product_types_csv}
                onChange={e => set('single_substitute_product_types_csv', e.target.value)}
                style={{ ...inputStyle, width: '100%', maxWidth: 600 }}
              />
            </div>
          </div>
        )}

        {/* Multi rules */}
        {draft.kind === 'multi' && (
          <div style={sectionStyle}>
            <div style={{ ...labelStyle, marginBottom: 8 }}>Multi rules</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto auto auto', gap: '6px 16px', alignItems: 'center', fontSize: 12, marginBottom: 10 }}>
              <span style={{ color: '#6b7280' }}>Picks</span>
              <input type="number" min="0" placeholder="min" value={draft.multi_min_picks} onChange={e => set('multi_min_picks', e.target.value)} style={{ ...inputStyle, width: 70 }} />
              <span style={{ color: '#6b7280' }}>–</span>
              <input type="number" min="0" placeholder="max" value={draft.multi_max_picks} onChange={e => set('multi_max_picks', e.target.value)} style={{ ...inputStyle, width: 70 }} />
              <span></span>

              <span style={{ color: '#6b7280' }}>Categories</span>
              <input type="number" min="0" max="3" placeholder="min" value={draft.multi_min_categories} onChange={e => set('multi_min_categories', e.target.value)} style={{ ...inputStyle, width: 70 }} />
              <span style={{ color: '#6b7280' }}>–</span>
              <input type="number" min="0" max="3" placeholder="max" value={draft.multi_max_categories} onChange={e => set('multi_max_categories', e.target.value)} style={{ ...inputStyle, width: 70 }} />
              <span style={{ color: '#9ca3af', fontSize: 11 }}>(0–3: Basic / Tropical / Exotic)</span>

              <span style={{ color: '#6b7280' }}>Max $/lb</span>
              <input type="number" step="any" min="0" placeholder="e.g. 8.50" value={draft.multi_max_cost_per_lb} onChange={e => set('multi_max_cost_per_lb', e.target.value)} style={{ ...inputStyle, width: 90, gridColumn: 'span 3' }} />
              <span></span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Allowed product types (comma-separated)</span>
              <input
                type="text"
                placeholder="e.g. mango, papaya, dragonfruit"
                value={draft.multi_allowed_product_types_csv}
                onChange={e => set('multi_allowed_product_types_csv', e.target.value)}
                style={{ ...inputStyle, width: '100%', maxWidth: 600 }}
              />
            </div>

            <div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Required picks</div>
              {draft.multi_required_picks.length === 0 && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>None — every box must include these picks regardless of other rules.</div>
              )}
              {draft.multi_required_picks.map((rp, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                  <input
                    type="text"
                    placeholder="pick_sku"
                    value={rp.pick_sku}
                    onChange={e => updateRequiredPick(idx, { pick_sku: e.target.value })}
                    style={{ ...inputStyle, width: 200, fontFamily: 'monospace' }}
                  />
                  <span style={{ fontSize: 12, color: '#6b7280' }}>×</span>
                  <input
                    type="number" step="any" min="0"
                    placeholder="qty"
                    value={rp.qty}
                    onChange={e => updateRequiredPick(idx, { qty: e.target.value })}
                    style={{ ...inputStyle, width: 70 }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 11, padding: '2px 8px', color: '#dc2626' }}
                    onClick={() => removeRequiredPick(idx)}
                  >Remove</button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 11, padding: '2px 8px', marginTop: 4 }}
                onClick={addRequiredPick}
              >+ Add required pick</button>
            </div>
          </div>
        )}

        {/* Notes */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={labelStyle}>Notes</span>
            <textarea
              placeholder="(optional)"
              value={draft.notes}
              onChange={e => set('notes', e.target.value)}
              style={{ ...inputStyle, width: '100%', maxWidth: 600, minHeight: 50, fontFamily: 'inherit' }}
            />
          </div>
        </div>

        {error && (
          <div style={{ padding: '6px 10px', background: '#fee2e2', color: '#991b1b', fontSize: 12, borderRadius: 4, marginBottom: 8 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            style={{ fontSize: 12, padding: '4px 12px' }}
            onClick={save}
            disabled={isPending || (isNew && !draft.shopify_sku.trim())}
          >{isPending ? 'Saving...' : 'Save'}</button>
          <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 12px' }} onClick={onCancel}>Cancel</button>
        </div>
      </td>
    </tr>
  )
}

function RulesTab() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [editingId, setEditingId] = useState(null) // 'new' or item.id
  const [saveError, setSaveError] = useState(null)

  const { data = { total: 0, items: [] }, isLoading } = useQuery({
    queryKey: ['shopify-sku-rules', search, kindFilter],
    queryFn: () => shopifySkuRulesApi.list({
      search: search || undefined,
      kind: kindFilter || undefined,
      limit: 500,
    }),
  })

  const upsertMut = useMutation({
    mutationFn: ({ shopify_sku, payload }) => shopifySkuRulesApi.upsert(shopify_sku, payload),
    onSuccess: () => {
      setSaveError(null)
      setEditingId(null)
      qc.invalidateQueries({ queryKey: ['shopify-sku-rules'] })
      qc.invalidateQueries({ queryKey: ['sku-mappings'] })
      qc.invalidateQueries({ queryKey: ['sku-mappings-grouped'] })
    },
    onError: (err) => setSaveError(err?.response?.data?.detail || err.message),
  })

  const deleteMut = useMutation({
    mutationFn: shopifySkuRulesApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shopify-sku-rules'] })
      qc.invalidateQueries({ queryKey: ['sku-mappings'] })
      qc.invalidateQueries({ queryKey: ['sku-mappings-grouped'] })
    },
  })

  function handleSave(shopify_sku, payload) {
    setSaveError(null)
    upsertMut.mutate({ shopify_sku, payload })
  }
  function handleCancel() {
    setSaveError(null)
    setEditingId(null)
  }

  const { total, items } = data

  return (
    <div>
      <div className="toolbar">
        <input
          placeholder="Search canonical Shopify SKU..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <select value={kindFilter} onChange={e => setKindFilter(e.target.value)} style={{ fontSize: 13, padding: '4px 8px' }}>
          <option value="">All kinds</option>
          <option value="single">Single</option>
          <option value="multi">Multi</option>
        </select>
        <button
          className="btn btn-primary"
          onClick={() => { setSaveError(null); setEditingId('new') }}
          disabled={editingId === 'new'}
        >+ Add Rule</button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {total} rules
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ minWidth: 1100 }}>
          <thead>
            <tr>
              <th style={{ minWidth: 240 }}>Canonical Shopify SKU</th>
              <th style={{ minWidth: 80 }}>Weight</th>
              <th style={{ minWidth: 70 }}>Kind</th>
              <th style={{ minWidth: 320 }}>Rules</th>
              <th style={{ minWidth: 180 }}>Notes</th>
              <th style={{ minWidth: 90 }}>Updated</th>
              <th style={{ width: 130 }}></th>
            </tr>
          </thead>
          <tbody>
            {editingId === 'new' && (
              <RuleEditRow
                isNew
                onSave={handleSave}
                onCancel={handleCancel}
                isPending={upsertMut.isPending}
                error={saveError}
              />
            )}
            {items.map(item => (
              editingId === item.id ? (
                <RuleEditRow
                  key={item.id}
                  item={item}
                  onSave={handleSave}
                  onCancel={handleCancel}
                  isPending={upsertMut.isPending}
                  error={saveError}
                />
              ) : (
                <RuleViewRow
                  key={item.id}
                  item={item}
                  onEdit={() => { setSaveError(null); setEditingId(item.id) }}
                  onDelete={(id) => deleteMut.mutate(id)}
                />
              )
            ))}
          </tbody>
        </table>
      </div>

      {total === 0 && !isLoading && editingId !== 'new' && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af' }}>
          No rules defined yet. Click <strong>+ Add Rule</strong> to create one.
        </div>
      )}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function SkuHelper() {
  const [urlParams, setUrlParams] = useSearchParams()
  const initialTab = urlParams.get('tab') === 'rules' ? 'rules' : 'mappings'
  const [activeTab, setActiveTab] = useState(initialTab)

  function selectTab(t) {
    setActiveTab(t)
    const next = new URLSearchParams(urlParams)
    if (t === 'rules') next.set('tab', 'rules')
    else next.delete('tab')
    setUrlParams(next, { replace: true })
  }

  return (
    <div>
      <div className="page-header">
        <h1>SKU Helper</h1>
        <p>
          {activeTab === 'mappings' ? (
            <>
              Maps Shopify SKU variants (e.g. <code>-5lb_2</code>, <code>-1lb_pos</code>) onto a single canonical
              helper SKU so we don't have to add every variant to the SKU mapping. App is the source of truth;
              Sync pulls from the <code>INPUT_SKU_TYPE</code> sheet.
            </>
          ) : (
            <>
              Per-canonical-SKU rules: bundle weight, kind (single vs multi), and the constraints used by
              validation and the SKU Mapping page tooltip. Variant SKUs resolve to canonical via the helper
              mappings tab, so add a rule against the canonical form only.
            </>
          )}
        </p>
      </div>

      <div className="proj-tabs">
        <button
          className={`proj-tab ${activeTab === 'mappings' ? 'proj-tab-active' : ''}`}
          onClick={() => selectTab('mappings')}
        >Helper Mappings</button>
        <button
          className={`proj-tab ${activeTab === 'rules' ? 'proj-tab-active' : ''}`}
          onClick={() => selectTab('rules')}
        >Rules</button>
      </div>

      {activeTab === 'mappings' && <HelperMappingsTab />}
      {activeTab === 'rules' && <RulesTab />}
    </div>
  )
}
