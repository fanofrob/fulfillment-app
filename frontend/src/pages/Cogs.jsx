import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { cogsApi, gmSettingsApi, picklistSkusApi } from '../api'

const EMPTY_FORM = { product_type: '', price_per_lb: '', effective_date: new Date().toISOString().slice(0,10), vendor: '', invoice_number: '', notes: '' }

export default function Cogs() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [gmDraft, setGmDraft] = useState(null)

  const { data: gmSettings } = useQuery({
    queryKey: ['gm-settings'],
    queryFn: gmSettingsApi.get,
  })
  const gmMut = useMutation({
    mutationFn: gmSettingsApi.update,
    onSuccess: () => qc.invalidateQueries(['gm-settings']),
  })

  useEffect(() => {
    if (gmSettings && gmDraft === null) setGmDraft(gmSettings)
  }, [gmSettings])

  const effectiveGm = gmDraft ?? gmSettings

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['cogs', search],
    queryFn: () => cogsApi.list({ product_type: search || undefined, limit: 500 }),
    retry: false,
  })

  const createMut = useMutation({
    mutationFn: cogsApi.create,
    onSuccess: () => { qc.invalidateQueries(['cogs']); closeModal() }
  })
  const refreshMut = useMutation({
    mutationFn: cogsApi.refresh,
    onSuccess: () => qc.invalidateQueries(['cogs']),
  })

  function closeModal() { setShowModal(false); setForm(EMPTY_FORM) }
  function handleSubmit(e) {
    e.preventDefault()
    createMut.mutate({ ...form, price_per_lb: parseFloat(form.price_per_lb) })
  }

  const { data: missingCogs = [], isLoading: missingLoading } = useQuery({
    queryKey: ['missing-cogs-skus'],
    queryFn: picklistSkusApi.missingCogs,
    retry: false,
  })

  const is503 = error?.response?.status === 503

  // Show most recent per product type
  const latestByType = {}
  data.forEach(r => {
    if (!latestByType[r.product_type] || r.effective_date > latestByType[r.product_type].effective_date)
      latestByType[r.product_type] = r
  })
  const displayed = Object.values(latestByType).sort((a, b) => a.product_type.localeCompare(b.product_type))

  return (
    <div>
      <div className="page-header">
        <h1>COGS — Cost of Goods</h1>
        <p>Live from Google Sheets — GHF: FRUIT DASHBOARD (Fruit cost tab). Add new entries here; they write directly to the sheet.</p>
      </div>

      {/* ── Missing COGS Alert Dashboard ────────────────────────────────────── */}
      {(missingLoading || missingCogs.length > 0) && (
        <div style={{ marginBottom: 32, border: '1px solid #fcd34d', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ background: '#fffbeb', padding: '12px 16px', borderBottom: '1px solid #fcd34d', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚠</span>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#92400e' }}>
              Missing COGS — affecting GM% on active orders
            </span>
            <span style={{ fontSize: 12, color: '#b45309', marginLeft: 4 }}>
              {missingLoading ? 'Loading…' : `${missingCogs.length} SKU${missingCogs.length !== 1 ? 's' : ''} need cost data`}
            </span>
          </div>
          {!missingLoading && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#fef9c3' }}>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#78350f', borderBottom: '1px solid #fcd34d' }}>Pick SKU</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#78350f', borderBottom: '1px solid #fcd34d' }}>Description</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#78350f', borderBottom: '1px solid #fcd34d' }}>Weight (lb)</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#78350f', borderBottom: '1px solid #fcd34d' }}>Active Orders Affected</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#78350f', borderBottom: '1px solid #fcd34d' }}>Revenue at Risk</th>
                  <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600, color: '#78350f', borderBottom: '1px solid #fcd34d' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {missingCogs.map((row, i) => (
                  <tr key={row.pick_sku} style={{ background: i % 2 === 0 ? '#fff' : '#fffbeb', borderBottom: '1px solid #fef3c7' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 600, color: '#1f2937' }}>{row.pick_sku}</td>
                    <td style={{ padding: '8px 12px', color: '#374151' }}>{row.customer_description || '—'}</td>
                    <td style={{ padding: '8px 12px', color: '#374151' }}>{row.weight_lb != null ? `${row.weight_lb} lb` : '—'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      {row.affected_order_count > 0
                        ? <span style={{ fontWeight: 700, color: '#dc2626' }}>{row.affected_order_count}</span>
                        : <span style={{ color: '#9ca3af' }}>0</span>
                      }
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: row.revenue_at_risk > 0 ? '#dc2626' : '#9ca3af', fontWeight: row.revenue_at_risk > 0 ? 600 : 400 }}>
                      {row.revenue_at_risk > 0 ? `$${row.revenue_at_risk.toFixed(2)}` : '—'}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                      <button
                        className="btn btn-secondary"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        onClick={() => navigate(`/picklist-skus?search=${encodeURIComponent(row.pick_sku)}`)}
                      >
                        Set Cost →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {is503 && <div className="error-msg">Google Sheets not connected. Add credentials.json to the backend folder first.</div>}

      {!is503 && (
        <>
          <div className="toolbar">
            <input placeholder="Search product type..." value={search} onChange={e => setSearch(e.target.value)} />
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Add Cost Entry → writes to Sheet</button>
            <button className="btn btn-secondary" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
              {refreshMut.isPending ? 'Refreshing...' : '↻ Refresh from Sheets'}
            </button>
          </div>

          <div className="data-table-wrap">
            {isLoading ? <div className="loading">Loading from Google Sheets...</div>
              : error ? <div className="error-msg">Error: {error.message}</div>
              : displayed.length === 0 ? <div className="empty">No COGS data found.</div> : (
              <table>
                <thead><tr><th>Product Type</th><th>Price / lb</th><th>Effective Date</th><th>Vendor</th><th>Invoice #</th></tr></thead>
                <tbody>{displayed.map((row, i) => (
                  <tr key={i}>
                    <td>{row.product_type}</td>
                    <td><strong>${row.price_per_lb?.toFixed(2)}</strong></td>
                    <td>{row.effective_date?.slice(0,10)}</td>
                    <td>{row.vendor || '—'}</td>
                    <td>{row.invoice_number || '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── GM Settings ────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 40, borderTop: '1px solid #e8e8e8', paddingTop: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1f2937', marginBottom: 4 }}>GM Estimate Settings</h2>
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
          Replacement, refund, and transaction fees are estimated as a percentage of shippable revenue and applied to every order's gross margin calculation.
        </p>
        {effectiveGm && (
          <form onSubmit={e => { e.preventDefault(); gmMut.mutate(effectiveGm) }}
            style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {[
              { key: 'replacement_pct',      label: 'Replacement (%)',         hint: '% of revenue estimated for replacements' },
              { key: 'refund_pct',           label: 'Refund (%)',              hint: '% of revenue estimated for refunds' },
              { key: 'transaction_fee_pct',  label: 'Transaction Fee (%)',     hint: 'Payment processing percentage (e.g. 2.9 for Shopify)' },
            ].map(({ key, label, hint }) => (
              <div key={key} style={{ minWidth: 160 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }} title={hint}>
                  {label}
                </label>
                <input
                  type="number" step="0.01" min="0"
                  value={effectiveGm[key] ?? ''}
                  onChange={e => setGmDraft(d => ({ ...d, [key]: parseFloat(e.target.value) || 0 }))}
                  style={{ width: '100%', fontSize: 14, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="submit" className="btn btn-primary" disabled={gmMut.isPending}>
                {gmMut.isPending ? 'Saving…' : 'Save Settings'}
              </button>
              {gmMut.isSuccess && <span style={{ fontSize: 12, color: '#16a34a' }}>Saved</span>}
              {gmMut.isError && <span style={{ fontSize: 12, color: '#dc2626' }}>Error saving</span>}
            </div>
          </form>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Add COGS Entry</h3>
            <p style={{fontSize:12, color:'#666', marginBottom:16}}>This will append a new row to the <strong>Fruit cost</strong> tab in Google Sheets.</p>
            <form onSubmit={handleSubmit}>
              <div className="form-group"><label>Product Type *</label><input required value={form.product_type} onChange={e => setForm(f => ({...f, product_type: e.target.value}))} placeholder='e.g. "Fruit: Apple, Envy"' /></div>
              <div className="form-row">
                <div className="form-group"><label>Price per lb ($) *</label><input required type="number" step="0.01" value={form.price_per_lb} onChange={e => setForm(f => ({...f, price_per_lb: e.target.value}))} /></div>
                <div className="form-group"><label>Effective Date *</label><input required type="date" value={form.effective_date} onChange={e => setForm(f => ({...f, effective_date: e.target.value}))} /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Vendor</label><input value={form.vendor} onChange={e => setForm(f => ({...f, vendor: e.target.value}))} /></div>
                <div className="form-group"><label>Invoice #</label><input value={form.invoice_number} onChange={e => setForm(f => ({...f, invoice_number: e.target.value}))} /></div>
              </div>
              {createMut.isError && <div className="error-msg">Error: {createMut.error?.response?.data?.detail || createMut.error?.message}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={createMut.isPending}>{createMut.isPending ? 'Saving to Sheet...' : 'Add to Sheet'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
