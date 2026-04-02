import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { historicalDataApi } from '../api'

const SCOPE_LABELS = { store_wide: 'Store-wide', sku_specific: 'SKU-specific' }
const SCOPE_COLORS = { store_wide: '#eff6ff', sku_specific: '#fef3c7' }

const EMPTY_FORM = {
  name: '', start_datetime: '', end_datetime: '',
  scope: 'store_wide', affected_skus: '',
  discount_type: '', discount_value: '', notes: '',
}

function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toISOString().slice(0, 16)
}

export default function HistoricalPromotions() {
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [ingesting, setIngesting] = useState(false)
  const [ingestResult, setIngestResult] = useState(null)

  const { data: promotions = [], isLoading } = useQuery({
    queryKey: ['historical-promotions'],
    queryFn: historicalDataApi.listPromotions,
  })
  const { data: salesSummary } = useQuery({
    queryKey: ['sales-summary'],
    queryFn: historicalDataApi.salesSummary,
  })

  const createMut = useMutation({
    mutationFn: historicalDataApi.createPromotion,
    onSuccess: () => { qc.invalidateQueries(['historical-promotions']); closeModal() },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => historicalDataApi.updatePromotion(id, data),
    onSuccess: () => { qc.invalidateQueries(['historical-promotions']); closeModal() },
  })
  const deleteMut = useMutation({
    mutationFn: historicalDataApi.deletePromotion,
    onSuccess: () => qc.invalidateQueries(['historical-promotions']),
  })

  async function handleIngest() {
    setIngesting(true)
    setIngestResult(null)
    try {
      const result = await historicalDataApi.ingestSales()
      setIngestResult(result)
      qc.invalidateQueries(['sales-summary'])
    } catch (err) {
      setIngestResult({ errors: [err.message || 'Ingestion failed'] })
    }
    setIngesting(false)
  }

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }

  function openEdit(promo) {
    setEditing(promo)
    setForm({
      name: promo.name,
      start_datetime: toLocalInput(promo.start_datetime),
      end_datetime: toLocalInput(promo.end_datetime),
      scope: promo.scope,
      affected_skus: (promo.affected_skus || []).join(', '),
      discount_type: promo.discount_type || '',
      discount_value: promo.discount_value ?? '',
      notes: promo.notes || '',
    })
    setShowModal(true)
  }

  function closeModal() { setShowModal(false); setEditing(null) }

  function handleSubmit(e) {
    e.preventDefault()
    const payload = {
      ...form,
      affected_skus: form.scope === 'sku_specific' && form.affected_skus
        ? form.affected_skus.split(',').map(s => s.trim()).filter(Boolean)
        : null,
      discount_value: form.discount_value !== '' ? parseFloat(form.discount_value) : null,
      discount_type: form.discount_type || null,
    }
    if (editing) updateMut.mutate({ id: editing.id, data: payload })
    else createMut.mutate(payload)
  }

  return (
    <div>
      <div className="page-header">
        <h1>Historical Data</h1>
        <p>Ingest historical sales from Shopify and tag promotional periods for projection accuracy.</p>
      </div>

      {/* Sales Data Section */}
      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Historical Sales Data</h3>
        {salesSummary ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
            <div style={{ padding: 12, background: '#f9fafb', borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: '#666' }}>Data Rows</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{salesSummary.total_rows.toLocaleString()}</div>
            </div>
            <div style={{ padding: 12, background: '#f9fafb', borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: '#666' }}>Unique SKUs</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{salesSummary.unique_skus}</div>
            </div>
            <div style={{ padding: 12, background: '#f9fafb', borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: '#666' }}>Date Range</div>
              <div style={{ fontSize: 13 }}>
                {salesSummary.date_range_start ? formatDate(salesSummary.date_range_start) : '—'}
                {' to '}
                {salesSummary.date_range_end ? formatDate(salesSummary.date_range_end) : '—'}
              </div>
            </div>
            <div style={{ padding: 12, background: '#f9fafb', borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: '#666' }}>Total Orders</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{(salesSummary.total_orders || 0).toLocaleString()}</div>
            </div>
          </div>
        ) : (
          <div style={{ color: '#999', marginBottom: 16 }}>No sales data ingested yet.</div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={handleIngest} disabled={ingesting}>
            {ingesting ? 'Ingesting...' : (salesSummary?.total_rows ? 'Sync New Orders' : 'Ingest All Historical Sales')}
          </button>
          {salesSummary?.total_rows > 0 && (
            <button className="btn btn-danger btn-sm" onClick={async () => {
              if (confirm('Delete all historical sales data? You can re-ingest afterwards.')) {
                await historicalDataApi.clearSales()
                qc.invalidateQueries(['sales-summary'])
                setIngestResult(null)
              }
            }}>Clear All Data</button>
          )}
        </div>

        {ingestResult && (
          <div style={{ marginTop: 12, padding: 12, background: ingestResult.errors?.length ? '#fef2f2' : '#f0fdf4', borderRadius: 6, fontSize: 13 }}>
            {ingestResult.errors?.length ? (
              <div style={{ color: '#991b1b' }}>{ingestResult.errors.join(', ')}</div>
            ) : (
              <div>
                Processed <strong>{ingestResult.total_orders_processed}</strong> orders,
                upserted <strong>{ingestResult.total_sales_rows_upserted}</strong> hourly sales rows.
                {ingestResult.date_range_start && (
                  <span> Range: {formatDate(ingestResult.date_range_start)} to {formatDate(ingestResult.date_range_end)}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Promotions Section */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>Historical Promotions</h3>
          <button className="btn btn-primary btn-sm" onClick={openCreate}>+ Tag Promotion</button>
        </div>

        <div className="data-table-wrap">
          {isLoading ? <div className="loading">Loading...</div> : promotions.length === 0 ? (
            <div className="empty">No promotions tagged yet. Tag historical promotions to improve projection accuracy.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Scope</th>
                  <th>Discount</th>
                  <th>Source</th>
                  <th>Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {promotions.map(p => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td>{formatDate(p.start_datetime)}</td>
                    <td>{formatDate(p.end_datetime)}</td>
                    <td>
                      <span style={{
                        padding: '2px 8px', borderRadius: 10, fontSize: 12,
                        background: SCOPE_COLORS[p.scope] || '#f3f4f6',
                      }}>
                        {SCOPE_LABELS[p.scope] || p.scope}
                      </span>
                      {p.scope === 'sku_specific' && p.affected_skus && (
                        <span style={{ fontSize: 11, color: '#666', marginLeft: 4 }}>
                          ({p.affected_skus.length} SKUs)
                        </span>
                      )}
                    </td>
                    <td>
                      {p.discount_type ? `${p.discount_type}${p.discount_value ? ': ' + p.discount_value : ''}` : '—'}
                    </td>
                    <td style={{ fontSize: 12, color: '#666' }}>{p.source}</td>
                    <td style={{ maxWidth: 200, color: '#666', fontSize: 13 }}>{p.notes || '—'}</td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(p)}>Edit</button>{' '}
                      <button className="btn btn-danger btn-sm" onClick={() => {
                        if (confirm(`Delete promotion "${p.name}"?`)) deleteMut.mutate(p.id)
                      }}>Del</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h2>{editing ? 'Edit Promotion' : 'Tag Historical Promotion'}</h2>
            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <label>Promotion Name</label>
                  <input type="text" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g., Valentine's Day Sale 2026"
                    style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label>Start Date/Time</label>
                    <input type="datetime-local" required value={form.start_datetime}
                      onChange={e => setForm(f => ({ ...f, start_datetime: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }} />
                  </div>
                  <div>
                    <label>End Date/Time</label>
                    <input type="datetime-local" required value={form.end_datetime}
                      onChange={e => setForm(f => ({ ...f, end_datetime: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label>Scope</label>
                    <select value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}>
                      <option value="store_wide">Store-wide</option>
                      <option value="sku_specific">SKU-specific</option>
                    </select>
                  </div>
                  <div>
                    <label>Discount Type</label>
                    <select value={form.discount_type} onChange={e => setForm(f => ({ ...f, discount_type: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}>
                      <option value="">None</option>
                      <option value="percentage">Percentage</option>
                      <option value="fixed">Fixed Amount</option>
                      <option value="bogo">BOGO</option>
                      <option value="free_shipping">Free Shipping</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                </div>
                {form.discount_type && (
                  <div>
                    <label>Discount Value</label>
                    <input type="number" step="any" value={form.discount_value}
                      onChange={e => setForm(f => ({ ...f, discount_value: e.target.value }))}
                      placeholder={form.discount_type === 'percentage' ? 'e.g., 20 (for 20%)' : 'e.g., 10.00'}
                      style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }} />
                  </div>
                )}
                {form.scope === 'sku_specific' && (
                  <div>
                    <label>Affected SKUs (comma-separated)</label>
                    <textarea value={form.affected_skus}
                      onChange={e => setForm(f => ({ ...f, affected_skus: e.target.value }))}
                      placeholder="sku1, sku2, sku3"
                      rows={2} style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }} />
                  </div>
                )}
                <div>
                  <label>Notes</label>
                  <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder="Context about this promotion..."
                    rows={2} style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }} />
                </div>
              </div>

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
