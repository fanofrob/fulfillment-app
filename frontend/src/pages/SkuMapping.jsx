import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { skuMappingApi } from '../api'

const ERROR_LABELS = {
  missing_pick_sku: 'No pick SKU',
  invalid_mix_qty:  'Invalid mix qty',
}

function fmtNum(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—'
  return Number(v).toFixed(digits).replace(/\.?0+$/, '') || '0'
}

function fmtPct(v) {
  if (v == null) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${(v * 100).toFixed(1)}%`
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

function ShopifyTooltip({ group, anchorRef }) {
  const { rule, summary, pick_lines, errors } = group
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (!anchorRef.current) return
    const r = anchorRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX })
  }, [anchorRef])

  return (
    <div style={{
      position: 'absolute', top: pos.top, left: pos.left,
      width: 380, zIndex: 50,
      background: '#fff', border: '1px solid #d1d5db', borderRadius: 6,
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      padding: 12, fontSize: 12, color: '#1f2937',
    }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        <code style={{ background: 'transparent' }}>{group.shopify_sku}</code>
        <span style={{ color: '#6b7280', marginLeft: 6, fontWeight: 400 }}>· {group.warehouse}</span>
      </div>

      {/* Rule block */}
      {rule ? (
        <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 4, padding: 8, marginBottom: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 2, columnGap: 8 }}>
            <span style={{ color: '#6b7280' }}>Weight</span>
            <span><strong>{fmtNum(rule.weight_lb)} lb</strong></span>
            <span style={{ color: '#6b7280' }}>Kind</span>
            <span style={{ textTransform: 'capitalize' }}>{rule.kind || '—'}</span>
            {rule.kind === 'single' && rule.single_substitute_product_types?.length > 0 && (
              <>
                <span style={{ color: '#6b7280' }}>Substitutes</span>
                <span>{rule.single_substitute_product_types.join(', ')}</span>
              </>
            )}
            {rule.kind === 'multi' && (
              <>
                {(rule.multi_min_picks != null || rule.multi_max_picks != null) && (
                  <>
                    <span style={{ color: '#6b7280' }}>Picks</span>
                    <span>{rule.multi_min_picks ?? '—'} – {rule.multi_max_picks ?? '—'}</span>
                  </>
                )}
                {(rule.multi_min_categories != null || rule.multi_max_categories != null) && (
                  <>
                    <span style={{ color: '#6b7280' }}>Categories</span>
                    <span>{rule.multi_min_categories ?? '—'} – {rule.multi_max_categories ?? '—'}</span>
                  </>
                )}
                {rule.multi_max_cost_per_lb != null && (
                  <>
                    <span style={{ color: '#6b7280' }}>Max $/lb</span>
                    <span>${fmtNum(rule.multi_max_cost_per_lb, 2)}</span>
                  </>
                )}
                {rule.multi_allowed_product_types?.length > 0 && (
                  <>
                    <span style={{ color: '#6b7280' }}>Allowed</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{rule.multi_allowed_product_types.join(', ')}</span>
                  </>
                )}
                {rule.multi_required_picks?.length > 0 && (
                  <>
                    <span style={{ color: '#6b7280' }}>Required</span>
                    <span>{rule.multi_required_picks.map(rp => `${rp.pick_sku} × ${rp.qty}`).join(', ')}</span>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: 4, padding: 6, marginBottom: 8, color: '#854d0e' }}>
          No rule defined yet — set one on the SKU Helper page.
        </div>
      )}

      {/* Pick list */}
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Pick lines ({pick_lines.length})</div>
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', marginBottom: 8 }}>
        <thead>
          <tr style={{ color: '#6b7280', textAlign: 'left' }}>
            <th style={{ padding: '2px 4px' }}>Pick SKU</th>
            <th style={{ padding: '2px 4px', textAlign: 'right' }}>Qty</th>
            <th style={{ padding: '2px 4px', textAlign: 'right' }}>Wt/u</th>
            <th style={{ padding: '2px 4px', textAlign: 'right' }}>$/lb</th>
            <th style={{ padding: '2px 4px' }}>Cat</th>
          </tr>
        </thead>
        <tbody>
          {pick_lines.map(pl => (
            <tr key={pl.id} style={{ borderTop: '1px solid #f3f4f6' }}>
              <td style={{ padding: '2px 4px', fontFamily: 'monospace', color: !pl.pick_sku ? '#dc2626' : '#16a34a' }}>{pl.pick_sku || '—'}</td>
              <td style={{ padding: '2px 4px', textAlign: 'right' }}>{fmtNum(pl.mix_quantity)}</td>
              <td style={{ padding: '2px 4px', textAlign: 'right' }}>{fmtNum(pl.pick_weight_lb)}</td>
              <td style={{ padding: '2px 4px', textAlign: 'right', color: pl.cost_per_lb == null ? '#9ca3af' : '#1f2937' }}>{pl.cost_per_lb == null ? '—' : `$${fmtNum(pl.cost_per_lb, 2)}`}</td>
              <td style={{ padding: '2px 4px', color: '#6b7280' }}>{pl.category || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 11, marginBottom: errors?.length ? 8 : 0 }}>
        <div>Total pick wt: <strong>{fmtNum(summary.total_pick_weight)} lb</strong></div>
        <div>Shopify wt: <strong>{summary.shopify_weight == null ? '—' : `${fmtNum(summary.shopify_weight)} lb`}</strong></div>
        {summary.weight_diff != null && (
          <div style={{ gridColumn: 'span 2', color: Math.abs(summary.weight_diff_pct) > 0.05 ? '#dc2626' : '#16a34a' }}>
            Diff: <strong>{summary.weight_diff > 0 ? '+' : ''}{fmtNum(summary.weight_diff)} lb ({fmtPct(summary.weight_diff_pct)})</strong>
          </div>
        )}
      </div>

      {/* Errors */}
      {errors?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {errors.map(e => (
            <span key={e} style={{ background: '#fca5a5', color: '#7f1d1d', borderRadius: 4, padding: '1px 6px', fontSize: 11 }}>
              {ERROR_LABELS[e] || e}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Pick chip (view + edit) ──────────────────────────────────────────────────

function PickChip({ line, group, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)

  function startEdit() {
    setDraft({
      pick_sku: line.pick_sku ?? '',
      mix_quantity: line.mix_quantity ?? '',
      pick_weight_lb: line.pick_weight_lb ?? '',
    })
    setEditing(true)
  }

  function save() {
    onSave(line.id, {
      pick_sku: draft.pick_sku.trim() || null,
      mix_quantity: draft.mix_quantity === '' ? null : Number(draft.mix_quantity),
      pick_weight_lb: draft.pick_weight_lb === '' ? null : Number(draft.pick_weight_lb),
    }, () => setEditing(false))
  }

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#fefce8', border: '1px solid #fde68a', borderRadius: 4, padding: '2px 6px', marginRight: 4, marginBottom: 4 }}>
        <input
          value={draft.pick_sku}
          placeholder="pick_sku"
          onChange={e => setDraft(d => ({ ...d, pick_sku: e.target.value }))}
          style={{ width: 130, fontSize: 11, padding: '1px 4px', border: '1px solid #d1d5db', borderRadius: 3, fontFamily: 'monospace' }}
        />
        <span>×</span>
        <input
          type="number" step="any"
          value={draft.mix_quantity}
          placeholder="qty"
          onChange={e => setDraft(d => ({ ...d, mix_quantity: e.target.value }))}
          style={{ width: 50, fontSize: 11, padding: '1px 4px', border: '1px solid #d1d5db', borderRadius: 3 }}
        />
        <input
          type="number" step="any"
          value={draft.pick_weight_lb}
          placeholder="wt"
          title="Per-unit pick weight (lb)"
          onChange={e => setDraft(d => ({ ...d, pick_weight_lb: e.target.value }))}
          style={{ width: 50, fontSize: 11, padding: '1px 4px', border: '1px solid #d1d5db', borderRadius: 3 }}
        />
        <button onClick={save} style={{ fontSize: 11, padding: '1px 6px', background: '#16a34a', color: 'white', border: 0, borderRadius: 3, cursor: 'pointer' }}>✓</button>
        <button onClick={() => setEditing(false)} style={{ fontSize: 11, padding: '1px 6px', background: '#e5e7eb', border: 0, borderRadius: 3, cursor: 'pointer' }}>✕</button>
      </span>
    )
  }

  const hasError = line.errors?.length > 0
  return (
    <span
      onClick={startEdit}
      title="Click to edit"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: hasError ? '#fef2f2' : '#f3f4f6',
        border: hasError ? '1px solid #fca5a5' : '1px solid #e5e7eb',
        borderRadius: 4, padding: '2px 6px', marginRight: 4, marginBottom: 4,
        fontSize: 11, cursor: 'pointer',
      }}
    >
      <code style={{ fontSize: 11, color: !line.pick_sku ? '#dc2626' : '#16a34a' }}>{line.pick_sku || '(empty)'}</code>
      <span style={{ color: '#6b7280' }}>×</span>
      <span>{fmtNum(line.mix_quantity)}</span>
      <button
        onClick={(e) => { e.stopPropagation(); if (confirm(`Delete pick line "${line.pick_sku}"?`)) onDelete(line.id) }}
        title="Delete this pick line"
        style={{ fontSize: 11, padding: '0 4px', background: 'transparent', border: 0, color: '#9ca3af', cursor: 'pointer' }}
      >×</button>
    </span>
  )
}

function NewPickForm({ group, onCreate, onCancel }) {
  const [draft, setDraft] = useState({ pick_sku: '', mix_quantity: '1', pick_weight_lb: '' })

  function save() {
    onCreate({
      warehouse: group.warehouse,
      shopify_sku: group.shopify_sku,
      pick_sku: draft.pick_sku.trim() || null,
      mix_quantity: draft.mix_quantity === '' ? null : Number(draft.mix_quantity),
      pick_weight_lb: draft.pick_weight_lb === '' ? null : Number(draft.pick_weight_lb),
      is_active: true,
    }, onCancel)
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#dbeafe', border: '1px solid #93c5fd', borderRadius: 4, padding: '2px 6px', marginRight: 4, marginBottom: 4 }}>
      <input
        value={draft.pick_sku}
        placeholder="pick_sku"
        autoFocus
        onChange={e => setDraft(d => ({ ...d, pick_sku: e.target.value }))}
        style={{ width: 130, fontSize: 11, padding: '1px 4px', border: '1px solid #d1d5db', borderRadius: 3, fontFamily: 'monospace' }}
      />
      <span>×</span>
      <input type="number" step="any" value={draft.mix_quantity} placeholder="qty"
        onChange={e => setDraft(d => ({ ...d, mix_quantity: e.target.value }))}
        style={{ width: 50, fontSize: 11, padding: '1px 4px', border: '1px solid #d1d5db', borderRadius: 3 }}
      />
      <input type="number" step="any" value={draft.pick_weight_lb} placeholder="wt"
        onChange={e => setDraft(d => ({ ...d, pick_weight_lb: e.target.value }))}
        style={{ width: 50, fontSize: 11, padding: '1px 4px', border: '1px solid #d1d5db', borderRadius: 3 }}
      />
      <button onClick={save} style={{ fontSize: 11, padding: '1px 6px', background: '#16a34a', color: 'white', border: 0, borderRadius: 3, cursor: 'pointer' }}>✓</button>
      <button onClick={onCancel} style={{ fontSize: 11, padding: '1px 6px', background: '#e5e7eb', border: 0, borderRadius: 3, cursor: 'pointer' }}>✕</button>
    </span>
  )
}

// ── Grouped row ──────────────────────────────────────────────────────────────

function GroupedRow({ group, onSavePickLine, onDeletePickLine, onCreatePickLine }) {
  const [hovered, setHovered] = useState(false)
  const [adding, setAdding] = useState(false)
  const anchorRef = useRef(null)
  const hoverTimerRef = useRef(null)

  function show() {
    clearTimeout(hoverTimerRef.current)
    setHovered(true)
  }
  function hide() {
    clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => setHovered(false), 100)
  }

  const errs = group.errors || []
  const wd = group.summary.weight_diff_pct
  const summaryColor = wd != null && Math.abs(wd) > 0.05 ? '#dc2626' : '#1f2937'

  return (
    <tr style={errs.length > 0 ? { background: '#fff8f8' } : undefined}>
      <td style={{ verticalAlign: 'top', position: 'relative' }}>
        <span ref={anchorRef} onMouseEnter={show} onMouseLeave={hide} style={{ cursor: 'help', borderBottom: '1px dotted #9ca3af' }}>
          <code style={{ fontSize: 12 }}>{group.shopify_sku}</code>
        </span>
        {hovered && <ShopifyTooltip group={group} anchorRef={anchorRef} />}
      </td>
      <td style={{ verticalAlign: 'top' }}><span className={`badge badge-${group.warehouse}`}>{group.warehouse}</span></td>
      <td style={{ verticalAlign: 'top' }}>
        {group.pick_lines.map(line => (
          <PickChip
            key={line.id}
            line={line}
            group={group}
            onSave={onSavePickLine}
            onDelete={onDeletePickLine}
          />
        ))}
        {adding ? (
          <NewPickForm group={group} onCreate={onCreatePickLine} onCancel={() => setAdding(false)} />
        ) : (
          <button
            onClick={() => setAdding(true)}
            title="Add pick line"
            style={{ fontSize: 11, padding: '2px 8px', background: '#f3f4f6', border: '1px dashed #9ca3af', borderRadius: 4, cursor: 'pointer', color: '#4b5563' }}
          >+ pick</button>
        )}
      </td>
      <td style={{ verticalAlign: 'top', fontSize: 12, color: summaryColor }}>
        <div>{fmtNum(group.summary.total_pick_weight)} / {group.summary.shopify_weight == null ? '—' : fmtNum(group.summary.shopify_weight)} lb</div>
        {wd != null && <div style={{ fontSize: 11 }}>{fmtPct(wd)}</div>}
      </td>
      <td style={{ verticalAlign: 'top', fontSize: 11 }}>
        {group.summary.categories.length === 0
          ? <span style={{ color: '#9ca3af' }}>—</span>
          : group.summary.categories.map(c => (
              <span key={c} style={{ display: 'inline-block', background: '#e0e7ff', color: '#3730a3', borderRadius: 4, padding: '1px 6px', marginRight: 3 }}>{c}</span>
            ))}
      </td>
      <td style={{ verticalAlign: 'top' }}>
        {errs.length === 0
          ? <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>
          : errs.map(e => (
              <span key={e} style={{ display: 'inline-block', background: '#fca5a5', color: '#7f1d1d', borderRadius: 4, padding: '1px 6px', fontSize: 11, marginRight: 4, marginBottom: 2 }}>
                {ERROR_LABELS[e] || e}
              </span>
            ))}
      </td>
    </tr>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SkuMapping() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [warehouse, setWarehouse] = useState('')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [page, setPage] = useState(0)
  const limit = errorsOnly ? 500 : 50

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['sku-mappings-grouped', search, warehouse, errorsOnly, page],
    queryFn: () => skuMappingApi.listGrouped({
      search: search || undefined,
      warehouse: warehouse || undefined,
      errors_only: errorsOnly || undefined,
      skip: page * limit,
      limit,
    }),
    retry: false,
  })

  const refreshMut = useMutation({
    mutationFn: skuMappingApi.refresh,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sku-mappings-grouped'] }),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, payload }) => skuMappingApi.update(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sku-mappings-grouped'] }),
  })

  const createMut = useMutation({
    mutationFn: (payload) => skuMappingApi.create(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sku-mappings-grouped'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (id) => skuMappingApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sku-mappings-grouped'] }),
  })

  function handleSavePickLine(id, payload, done) {
    updateMut.mutate({ id, payload }, { onSuccess: done })
  }
  function handleCreatePickLine(payload, done) {
    createMut.mutate(payload, { onSuccess: done })
  }
  function handleDeletePickLine(id) {
    deleteMut.mutate(id)
  }

  const is503 = error?.response?.status === 503

  return (
    <div>
      <div className="page-header">
        <h1>SKU Mapping</h1>
        <p>One row per Shopify SKU. Hover the SKU for rules, pick weights, and totals. Click a pick chip to edit; "+ pick" adds a new pick line. Refresh from Sheets upserts but won't clobber app edits.</p>
      </div>

      {is503 && (
        <div className="setup-banner">
          <h3>⚙️ Google Sheets not connected yet</h3>
          <p>Set <code>GOOGLE_CREDENTIALS_JSON</code> in Railway (or place <code>credentials.json</code> in the backend folder for local dev) and restart.</p>
        </div>
      )}

      {!is503 && (
        <>
          <div className="toolbar">
            <input placeholder="Search Shopify SKU or pick SKU..." value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} style={{ minWidth: 260 }} />
            <select value={warehouse} onChange={e => { setWarehouse(e.target.value); setPage(0) }}>
              <option value="">All Warehouses</option>
              <option value="walnut">Walnut</option>
              <option value="northlake">Northlake</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={errorsOnly} onChange={e => { setErrorsOnly(e.target.checked); setPage(0) }} />
              Errors only
            </label>
            <button className="btn btn-secondary" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
              {refreshMut.isPending ? 'Refreshing...' : '↻ Refresh from Sheets'}
            </button>
            {refreshMut.isSuccess && refreshMut.data && (
              <span style={{ fontSize: 12, color: '#16a34a' }}>
                {refreshMut.data.created} created, {refreshMut.data.updated} updated, {refreshMut.data.skipped_app_edited} app-edited skipped
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{data.length} Shopify SKU{data.length === 1 ? '' : 's'}</span>
          </div>

          {errorsOnly && data.length > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 14px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, fontSize: 13, color: '#c0392b' }}>
              ⚠ {data.length} Shopify SKU{data.length !== 1 ? 's' : ''} with mapping errors.
            </div>
          )}

          <div className="data-table-wrap">
            {isLoading ? <div className="loading">Loading...</div>
              : error ? <div className="error-msg">Error: {error.message}</div>
              : data.length === 0 ? <div className="empty">{errorsOnly ? 'No mapping errors found.' : 'No mappings found.'}</div> : (
              <table>
                <thead><tr>
                  <th>Shopify SKU</th>
                  <th>Warehouse</th>
                  <th>Pick SKUs</th>
                  <th>Wt (pick / shopify)</th>
                  <th>Categories</th>
                  <th>Errors</th>
                </tr></thead>
                <tbody>
                  {data.map(group => (
                    <GroupedRow
                      key={`${group.warehouse}-${group.shopify_sku}`}
                      group={group}
                      onSavePickLine={handleSavePickLine}
                      onCreatePickLine={handleCreatePickLine}
                      onDeletePickLine={handleDeletePickLine}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="pagination">
            {!errorsOnly && <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>}
            {!errorsOnly && <span>Page {page + 1}</span>}
            {!errorsOnly && <button disabled={data.length < limit} onClick={() => setPage(p => p + 1)}>Next →</button>}
          </div>
        </>
      )}
    </div>
  )
}
