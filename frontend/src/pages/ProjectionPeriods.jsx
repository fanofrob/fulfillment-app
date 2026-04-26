import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { projectionPeriodsApi } from '../api'

const STATUS_COLORS = { draft: '#f3f4f6', active: '#dcfce7', closed: '#fee2e2', archived: '#e5e7eb' }
const STATUS_TEXT_COLORS = { draft: '#6b7280', active: '#166534', closed: '#991b1b', archived: '#374151' }

const EMPTY_FORM = {
  name: '', start_datetime: '', end_datetime: '',
  fulfillment_start: '', fulfillment_end: '',
  status: 'draft', sku_mapping_sheet_tab: '', previous_period_id: '',
  notes: '',
}

function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toISOString().slice(0, 16)
}

function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export default function ProjectionPeriods() {
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [configTab, setConfigTab] = useState('short-ship')
  const [skuInput, setSkuInput] = useState('')
  const [copySource, setCopySource] = useState('')
  const [diffTarget, setDiffTarget] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const { data: periods = [], isLoading } = useQuery({
    queryKey: ['projection-periods', { includeArchived: showArchived }],
    queryFn: () => projectionPeriodsApi.list({ include_archived: showArchived }),
  })
  const { data: suggestedDates } = useQuery({
    queryKey: ['suggest-dates'],
    queryFn: projectionPeriodsApi.suggestDates,
  })
  const { data: sheetsTabs } = useQuery({
    queryKey: ['sheets-tabs'],
    queryFn: projectionPeriodsApi.listSheetsTabs,
  })

  // Config queries for selected period
  const { data: shortShipSkus = [] } = useQuery({
    queryKey: ['period-short-ship', selectedPeriod],
    queryFn: () => projectionPeriodsApi.listShortShip(selectedPeriod),
    enabled: !!selectedPeriod,
  })
  const { data: holdSkus = [] } = useQuery({
    queryKey: ['period-inv-hold', selectedPeriod],
    queryFn: () => projectionPeriodsApi.listInventoryHold(selectedPeriod),
    enabled: !!selectedPeriod,
  })

  // Diff query
  const { data: diffData } = useQuery({
    queryKey: ['config-diff', selectedPeriod, configTab, diffTarget],
    queryFn: () => configTab === 'short-ship'
      ? projectionPeriodsApi.diffShortShip(selectedPeriod, diffTarget)
      : projectionPeriodsApi.diffInventoryHold(selectedPeriod, diffTarget),
    enabled: !!selectedPeriod && !!diffTarget,
  })

  const createMut = useMutation({
    mutationFn: projectionPeriodsApi.create,
    onSuccess: () => { qc.invalidateQueries(['projection-periods']); closeModal() },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => projectionPeriodsApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries(['projection-periods']); closeModal() },
  })
  const deleteMut = useMutation({
    mutationFn: projectionPeriodsApi.delete,
    onSuccess: () => { qc.invalidateQueries(['projection-periods']); setSelectedPeriod(null) },
  })
  const archiveMut = useMutation({
    mutationFn: projectionPeriodsApi.archive,
    onSuccess: () => { qc.invalidateQueries(['projection-periods']); setSelectedPeriod(null) },
    onError: (err) => alert(`Archive failed: ${err?.response?.data?.detail || err?.message || 'Unknown error'}`),
  })
  const unarchiveMut = useMutation({
    mutationFn: projectionPeriodsApi.unarchive,
    onSuccess: () => qc.invalidateQueries(['projection-periods']),
    onError: (err) => alert(`Unarchive failed: ${err?.response?.data?.detail || err?.message || 'Unknown error'}`),
  })

  const addShortShipMut = useMutation({
    mutationFn: ({ periodId, sku }) => projectionPeriodsApi.addShortShip(periodId, { shopify_sku: sku }),
    onSuccess: () => { qc.invalidateQueries(['period-short-ship']); setSkuInput('') },
  })
  const removeShortShipMut = useMutation({
    mutationFn: ({ periodId, sku }) => projectionPeriodsApi.removeShortShip(periodId, sku),
    onSuccess: () => qc.invalidateQueries(['period-short-ship']),
  })
  const addHoldMut = useMutation({
    mutationFn: ({ periodId, sku }) => projectionPeriodsApi.addInventoryHold(periodId, { shopify_sku: sku }),
    onSuccess: () => { qc.invalidateQueries(['period-inv-hold']); setSkuInput('') },
  })
  const removeHoldMut = useMutation({
    mutationFn: ({ periodId, sku }) => projectionPeriodsApi.removeInventoryHold(periodId, sku),
    onSuccess: () => qc.invalidateQueries(['period-inv-hold']),
  })

  const copyShortShipMut = useMutation({
    mutationFn: ({ periodId, sourceId }) => projectionPeriodsApi.copyShortShip(periodId, { source_period_id: sourceId }),
    onSuccess: (data) => { qc.invalidateQueries(['period-short-ship']); alert(`Copied ${data.copied} SKUs (${data.already_existed} already existed)`) },
  })
  const copyHoldMut = useMutation({
    mutationFn: ({ periodId, sourceId }) => projectionPeriodsApi.copyInventoryHold(periodId, { source_period_id: sourceId }),
    onSuccess: (data) => { qc.invalidateQueries(['period-inv-hold']); alert(`Copied ${data.copied} SKUs (${data.already_existed} already existed)`) },
  })
  const importGlobalSSMut = useMutation({
    mutationFn: (periodId) => projectionPeriodsApi.importGlobalShortShip(periodId),
    onSuccess: (data) => { qc.invalidateQueries(['period-short-ship']); alert(`Imported ${data.imported} SKUs`) },
  })
  const importGlobalHoldMut = useMutation({
    mutationFn: (periodId) => projectionPeriodsApi.importGlobalInventoryHold(periodId),
    onSuccess: (data) => { qc.invalidateQueries(['period-inv-hold']); alert(`Imported ${data.imported} SKUs`) },
  })

  function openCreate() {
    setEditing(null)
    const now = new Date()
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const f = { ...EMPTY_FORM }
    f.fulfillment_start = toLocalInput(ninetyDaysAgo.toISOString())
    f.fulfillment_end = toLocalInput(now.toISOString())
    f.start_datetime = toLocalInput(now.toISOString())
    if (suggestedDates?.current_week) {
      f.end_datetime = toLocalInput(suggestedDates.current_week.end)
      const weekNum = Math.ceil((new Date(suggestedDates.current_week.start).getTime() - new Date(new Date().getFullYear(), 0, 1).getTime()) / (7 * 86400000))
      f.name = `Week ${weekNum} - Period 1`
    } else {
      const day = now.getDay()
      const daysUntilTue = (2 - day + 7) % 7 || 7
      const tuesday = new Date(now)
      tuesday.setDate(now.getDate() + daysUntilTue)
      tuesday.setHours(23, 59, 0, 0)
      f.end_datetime = toLocalInput(tuesday.toISOString())
    }
    setForm(f)
    setShowModal(true)
  }

  function openEdit(period) {
    setEditing(period)
    setForm({
      name: period.name,
      start_datetime: toLocalInput(period.start_datetime),
      end_datetime: toLocalInput(period.end_datetime),
      fulfillment_start: toLocalInput(period.fulfillment_start),
      fulfillment_end: toLocalInput(period.fulfillment_end),
      status: period.status,
      sku_mapping_sheet_tab: period.sku_mapping_sheet_tab || '',
      previous_period_id: period.previous_period_id || '',
      notes: period.notes || '',
    })
    setShowModal(true)
  }

  function closeModal() { setShowModal(false); setEditing(null) }

  function handleSubmit(e) {
    e.preventDefault()
    const payload = {
      ...form,
      previous_period_id: form.previous_period_id ? parseInt(form.previous_period_id) : null,
      sku_mapping_sheet_tab: form.sku_mapping_sheet_tab || null,
      fulfillment_start: form.fulfillment_start || null,
      fulfillment_end: form.fulfillment_end || null,
    }
    if (editing) updateMut.mutate({ id: editing.id, data: payload })
    else createMut.mutate(payload)
  }

  function handleAddSku() {
    if (!skuInput.trim() || !selectedPeriod) return
    if (configTab === 'short-ship') {
      addShortShipMut.mutate({ periodId: selectedPeriod, sku: skuInput.trim() })
    } else {
      addHoldMut.mutate({ periodId: selectedPeriod, sku: skuInput.trim() })
    }
  }

  function handleCopy() {
    if (!copySource || !selectedPeriod) return
    if (configTab === 'short-ship') {
      copyShortShipMut.mutate({ periodId: selectedPeriod, sourceId: parseInt(copySource) })
    } else {
      copyHoldMut.mutate({ periodId: selectedPeriod, sourceId: parseInt(copySource) })
    }
  }

  const selectedPeriodObj = periods.find(p => p.id === selectedPeriod)
  const configItems = configTab === 'short-ship' ? shortShipSkus : holdSkus

  return (
    <div>
      <div className="page-header">
        <h1>Projection Periods</h1>
        <p>Manage projection periods and their per-period short ship / inventory hold configurations.</p>
      </div>

      <div className="toolbar" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-primary" onClick={openCreate}>+ New Period</button>
        <label style={{ fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={e => { setShowArchived(e.target.checked); setSelectedPeriod(null) }}
          />
          Show archived
        </label>
      </div>

      {/* Periods Table */}
      <div className="data-table-wrap">
        {isLoading ? <div className="loading">Loading...</div> : periods.length === 0 ? (
          <div className="empty">No projection periods yet. Create one to get started.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Confirmed Demand</th>
                <th>Projections Period</th>
                <th>Status</th>
                <th>SKU Mapping Tab</th>
                <th>Configs</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {periods.map(p => {
                const isArchived = p.status === 'archived'
                return (
                <tr key={p.id} style={{
                  ...(selectedPeriod === p.id ? { background: '#eff6ff' } : {}),
                  ...(isArchived ? { opacity: 0.7 } : {}),
                }}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td style={{ fontSize: 13 }}>
                    {p.fulfillment_start ? `${formatDate(p.fulfillment_start)} → ${formatDate(p.fulfillment_end)}` : '—'}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {formatDate(p.start_datetime)} → {formatDate(p.end_datetime)}
                  </td>
                  <td>
                    <span style={{
                      padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                      background: STATUS_COLORS[p.status], color: STATUS_TEXT_COLORS[p.status],
                    }}>
                      {p.status}
                    </span>
                  </td>
                  <td style={{ color: '#666', fontSize: 13 }}>{p.sku_mapping_sheet_tab || '—'}</td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => { setSelectedPeriod(selectedPeriod === p.id ? null : p.id); setDiffTarget('') }}
                      disabled={isArchived}
                      title={isArchived ? 'Archived periods are read-only' : undefined}
                    >
                      {selectedPeriod === p.id ? 'Hide' : 'Configure'}
                    </button>
                  </td>
                  <td>
                    {!isArchived && (
                      <>
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(p)}>Edit</button>{' '}
                      </>
                    )}
                    {!isArchived && p.status !== 'active' && (
                      <>
                        <button className="btn btn-secondary btn-sm" onClick={() => {
                          if (confirm(`Archive period "${p.name}"? It will be hidden from the default list and become read-only.`)) {
                            archiveMut.mutate(p.id)
                          }
                        }} disabled={archiveMut.isPending}>Archive</button>{' '}
                        <button className="btn btn-danger btn-sm" onClick={() => {
                          if (confirm(`Delete period "${p.name}"?`)) deleteMut.mutate(p.id)
                        }}>Del</button>
                      </>
                    )}
                    {isArchived && (
                      <button className="btn btn-secondary btn-sm" onClick={() => {
                        if (confirm(`Unarchive period "${p.name}"? It will return to draft status.`)) {
                          unarchiveMut.mutate(p.id)
                        }
                      }} disabled={unarchiveMut.isPending}>Unarchive</button>
                    )}
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        )}
      </div>

      {/* Config Panel */}
      {selectedPeriod && selectedPeriodObj && (
        <div style={{ marginTop: 24, border: '1px solid #e5e7eb', borderRadius: 8, padding: 20 }}>
          <h3 style={{ marginTop: 0 }}>
            Config for: {selectedPeriodObj.name}
          </h3>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              className={`btn btn-sm ${configTab === 'short-ship' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setConfigTab('short-ship')}
            >
              Short Ship ({shortShipSkus.length})
            </button>
            <button
              className={`btn btn-sm ${configTab === 'inventory-hold' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setConfigTab('inventory-hold')}
            >
              Inventory Hold ({holdSkus.length})
            </button>
          </div>

          {/* Add SKU */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text" placeholder="Add shopify_sku..."
              value={skuInput} onChange={e => setSkuInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddSku() }}
              style={{ flex: 1, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
            />
            <button className="btn btn-primary btn-sm" onClick={handleAddSku}>Add</button>
          </div>

          {/* Bulk actions */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => {
              if (configTab === 'short-ship') importGlobalSSMut.mutate(selectedPeriod)
              else importGlobalHoldMut.mutate(selectedPeriod)
            }}>
              Import from Global Config
            </button>

            <span style={{ color: '#999', fontSize: 12 }}>|</span>
            <label style={{ fontSize: 13 }}>Copy from:</label>
            <select value={copySource} onChange={e => setCopySource(e.target.value)}
              style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
              <option value="">Select period...</option>
              {periods.filter(p => p.id !== selectedPeriod).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button className="btn btn-secondary btn-sm" onClick={handleCopy} disabled={!copySource}>Copy</button>

            <span style={{ color: '#999', fontSize: 12 }}>|</span>
            <label style={{ fontSize: 13 }}>Diff with:</label>
            <select value={diffTarget} onChange={e => setDiffTarget(e.target.value)}
              style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
              <option value="">Select period...</option>
              {periods.filter(p => p.id !== selectedPeriod).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Diff display */}
          {diffData && diffTarget && (
            <div style={{ marginBottom: 16, padding: 12, background: '#f9fafb', borderRadius: 6, fontSize: 13 }}>
              <strong>Diff: {selectedPeriodObj.name} vs {periods.find(p => p.id === parseInt(diffTarget))?.name}</strong>
              <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, color: '#166534', marginBottom: 4 }}>Only in this period ({diffData.only_in_source.length})</div>
                  {diffData.only_in_source.map(s => <div key={s} style={{ fontSize: 12 }}>{s}</div>)}
                  {diffData.only_in_source.length === 0 && <div style={{ color: '#999', fontSize: 12 }}>None</div>}
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: '#991b1b', marginBottom: 4 }}>Only in other ({diffData.only_in_target.length})</div>
                  {diffData.only_in_target.map(s => <div key={s} style={{ fontSize: 12 }}>{s}</div>)}
                  {diffData.only_in_target.length === 0 && <div style={{ color: '#999', fontSize: 12 }}>None</div>}
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: '#1e40af', marginBottom: 4 }}>In both ({diffData.in_both.length})</div>
                  {diffData.in_both.length > 10
                    ? <div style={{ fontSize: 12 }}>{diffData.in_both.length} SKUs in common</div>
                    : diffData.in_both.map(s => <div key={s} style={{ fontSize: 12 }}>{s}</div>)
                  }
                </div>
              </div>
            </div>
          )}

          {/* SKU list */}
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {configItems.length === 0 ? (
              <div style={{ color: '#999', padding: 12 }}>No {configTab} SKUs configured for this period.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Shopify SKU</th><th>Added</th><th></th></tr>
                </thead>
                <tbody>
                  {configItems.map(item => (
                    <tr key={item.id}>
                      <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{item.shopify_sku}</td>
                      <td style={{ color: '#999', fontSize: 12 }}>{formatDate(item.created_at)}</td>
                      <td>
                        <button className="btn btn-danger btn-sm" onClick={() => {
                          if (configTab === 'short-ship')
                            removeShortShipMut.mutate({ periodId: selectedPeriod, sku: item.shopify_sku })
                          else
                            removeHoldMut.mutate({ periodId: selectedPeriod, sku: item.shopify_sku })
                        }}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h2>{editing ? 'Edit Period' : 'New Projection Period'}</h2>
            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <label>Name</label>
                  <input type="text" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }} />
                </div>
                <div style={{ border: '1px solid #bfdbfe', borderRadius: 8, padding: 12, background: '#eff6ff' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                    Confirmed Demand
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label>Start</label>
                      <input type="datetime-local" value={form.fulfillment_start}
                        onChange={e => setForm(f => ({ ...f, fulfillment_start: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #bfdbfe', borderRadius: 6 }} />
                    </div>
                    <div>
                      <label>End</label>
                      <input type="datetime-local" value={form.fulfillment_end}
                        onChange={e => setForm(f => ({ ...f, fulfillment_end: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #bfdbfe', borderRadius: 6 }} />
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
                      <input type="datetime-local" required value={form.start_datetime}
                        onChange={e => setForm(f => ({ ...f, start_datetime: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #bbf7d0', borderRadius: 6 }} />
                    </div>
                    <div>
                      <label>End</label>
                      <input type="datetime-local" required value={form.end_datetime}
                        onChange={e => setForm(f => ({ ...f, end_datetime: e.target.value }))}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #bbf7d0', borderRadius: 6 }} />
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label>Status</label>
                    <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}>
                      <option value="draft">Draft</option>
                      <option value="active">Active</option>
                      <option value="closed">Closed</option>
                    </select>
                  </div>
                  <div>
                    <label>Previous Period</label>
                    <select value={form.previous_period_id} onChange={e => setForm(f => ({ ...f, previous_period_id: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}>
                      <option value="">None</option>
                      {periods.filter(p => !editing || p.id !== editing.id).map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label>SKU Mapping Sheet Tab</label>
                  <select value={form.sku_mapping_sheet_tab} onChange={e => setForm(f => ({ ...f, sku_mapping_sheet_tab: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}>
                    <option value="">None (use default)</option>
                    {(sheetsTabs?.tabs || []).map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Notes</label>
                  <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    rows={2} style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }} />
                </div>
              </div>

              {/* Quick date fill buttons */}
              {!editing && suggestedDates && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm(f => ({
                    ...f,
                    start_datetime: toLocalInput(suggestedDates.current_week.start),
                    end_datetime: toLocalInput(suggestedDates.current_week.end),
                  }))}>This Week (Wed-Tue)</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm(f => ({
                    ...f,
                    start_datetime: toLocalInput(suggestedDates.next_week.start),
                    end_datetime: toLocalInput(suggestedDates.next_week.end),
                  }))}>Next Week (Wed-Tue)</button>
                </div>
              )}

              <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={createMut.isPending || updateMut.isPending}>
                  {editing ? 'Save' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
