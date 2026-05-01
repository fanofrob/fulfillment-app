import React, { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { purchaseOrdersApi, vendorsApi, projectionPeriodsApi, receivingApi } from '../api'

const PO_STATUSES = ['draft', 'placed', 'in_transit', 'partially_received', 'delivered', 'imported', 'reconciled']
const STATUS_COLORS = {
  draft: '#e5e7eb', placed: '#bfdbfe', in_transit: '#c4b5fd',
  partially_received: '#fde68a', delivered: '#bbf7d0', imported: '#6ee7b7', reconciled: '#9ca3af',
}
const STATUS_TRANSITIONS = {
  draft: ['placed', 'in_transit'],
  placed: ['in_transit', 'partially_received', 'delivered'],
  in_transit: ['partially_received', 'delivered'],
  partially_received: ['delivered'],
  delivered: ['imported'],
  imported: ['reconciled'],
  reconciled: [],
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatCurrency(val) {
  if (val == null) return '—'
  return `$${Number(val).toFixed(2)}`
}

const EMPTY_PO = {
  vendor_id: '', status: 'draft', order_date: new Date().toISOString().slice(0, 10),
  expected_delivery_date: '', delivery_notes: '', communication_method: '', notes: '',
}

const EMPTY_LINE = {
  product_type: '', quantity_cases: '', case_weight_lbs: '',
  unit_price: '', price_unit: 'case', notes: '',
}

export default function PurchaseOrders() {
  const qc = useQueryClient()
  const [urlParams, setUrlParams] = useSearchParams()
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showDetailModal, setShowDetailModal] = useState(null)
  const [showLineModal, setShowLineModal] = useState(false)
  const [showAllocModal, setShowAllocModal] = useState(null)
  const [poForm, setPoForm] = useState(EMPTY_PO)
  const [lineForm, setLineForm] = useState(EMPTY_LINE)
  const [newLines, setNewLines] = useState([])
  const [statusFilter, setStatusFilter] = useState('')
  const [allocations, setAllocations] = useState([])
  // Receiving state
  const [receivingLineId, setReceivingLineId] = useState(null)
  const [receivingForm, setReceivingForm] = useState({ received_cases: '', received_weight_lbs: '', harvest_date: '', confirmed_pick_sku: '', quality_rating: '', quality_notes: '' })
  const [receivingRecords, setReceivingRecords] = useState([])
  const [availableSkus, setAvailableSkus] = useState([])

  const { data: pos = [], isLoading } = useQuery({
    queryKey: ['purchase-orders', statusFilter],
    queryFn: () => purchaseOrdersApi.list(statusFilter ? { status: statusFilter } : {}),
  })
  const { data: vendors = [] } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => vendorsApi.list(),
  })
  const { data: periods = [] } = useQuery({
    queryKey: ['projection-periods'],
    queryFn: () => projectionPeriodsApi.list(),
  })

  const vendorMap = useMemo(() => {
    const m = {}
    vendors.forEach(v => { m[v.id] = v })
    return m
  }, [vendors])

  // Get vendor product defaults for a vendor + product type
  function getVendorDefaults(vendorId, productType) {
    const vendor = vendorMap[vendorId]
    if (!vendor) return {}
    return vendor.products?.find(p => p.product_type === productType) || {}
  }

  const createMut = useMutation({
    mutationFn: purchaseOrdersApi.create,
    onSuccess: () => { qc.invalidateQueries(['purchase-orders']); closeCreateModal() },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => purchaseOrdersApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries(['purchase-orders']); if (showDetailModal) refreshDetail(showDetailModal) },
  })
  const deleteMut = useMutation({
    mutationFn: purchaseOrdersApi.delete,
    onSuccess: () => { qc.invalidateQueries(['purchase-orders']); setShowDetailModal(null) },
  })
  const addLineMut = useMutation({
    mutationFn: ({ poId, data }) => purchaseOrdersApi.addLine(poId, data),
    onSuccess: (_, vars) => { qc.invalidateQueries(['purchase-orders']); refreshDetail(vars.poId); setShowLineModal(false) },
  })
  const deleteLineMut = useMutation({
    mutationFn: ({ poId, lineId }) => purchaseOrdersApi.deleteLine(poId, lineId),
    onSuccess: (_, vars) => { qc.invalidateQueries(['purchase-orders']); refreshDetail(vars.poId) },
  })
  const setAllocMut = useMutation({
    mutationFn: ({ poId, lineId, data }) => purchaseOrdersApi.setAllocations(poId, lineId, data),
    onSuccess: (_, vars) => { qc.invalidateQueries(['purchase-orders']); refreshDetail(vars.poId); setShowAllocModal(null) },
  })

  // Receiving mutations
  const receiveMut = useMutation({
    mutationFn: ({ poId, lineId, data }) => receivingApi.receive(poId, lineId, data),
    onSuccess: (_, vars) => { loadReceivingRecords(vars.poId); refreshDetail(vars.poId); setReceivingLineId(null) },
  })
  const pushMut = useMutation({
    mutationFn: (recordId) => receivingApi.pushToInventory(recordId),
    onSuccess: () => { if (showDetailModal) { loadReceivingRecords(showDetailModal.id); refreshDetail(showDetailModal.id) } },
  })
  const pushAllMut = useMutation({
    mutationFn: (poId) => receivingApi.pushAll(poId),
    onSuccess: () => { if (showDetailModal) { loadReceivingRecords(showDetailModal.id); refreshDetail(showDetailModal.id) } },
  })
  const deleteRecMut = useMutation({
    mutationFn: (recordId) => receivingApi.delete(recordId),
    onSuccess: () => { if (showDetailModal) { loadReceivingRecords(showDetailModal.id); refreshDetail(showDetailModal.id) } },
  })

  function loadReceivingRecords(poId) {
    receivingApi.listForPO(poId).then(setReceivingRecords).catch(() => setReceivingRecords([]))
  }

  function refreshDetail(poId) {
    purchaseOrdersApi.get(poId).then(po => { setShowDetailModal(po); qc.invalidateQueries(['purchase-orders']) })
  }

  // Deep-link: ?po=N opens that PO's detail modal on mount. Used by the
  // "Open PO" link from the Purchase Planning page.
  useEffect(() => {
    const poId = urlParams.get('po')
    if (!poId) return
    if (showDetailModal && String(showDetailModal.id) === String(poId)) return
    purchaseOrdersApi.get(Number(poId)).then(po => {
      setShowDetailModal(po)
      loadReceivingRecords(po.id)
    }).catch(() => {
      // PO doesn't exist (e.g. deleted) — clear the param so we don't loop.
      const np = new URLSearchParams(urlParams)
      np.delete('po')
      setUrlParams(np, { replace: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlParams.get('po')])

  // Keep the URL ?po=N in sync when the modal opens/closes via in-page UI.
  useEffect(() => {
    const np = new URLSearchParams(urlParams)
    if (showDetailModal) np.set('po', String(showDetailModal.id))
    else np.delete('po')
    if (np.toString() !== urlParams.toString()) setUrlParams(np, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDetailModal?.id])

  function closeCreateModal() {
    setShowCreateModal(false)
    setPoForm(EMPTY_PO)
    setNewLines([])
  }

  function addNewLine() {
    setNewLines([...newLines, { ...EMPTY_LINE }])
  }

  function updateNewLine(idx, field, value) {
    const updated = [...newLines]
    updated[idx] = { ...updated[idx], [field]: value }
    // Auto-fill defaults from vendor
    if (field === 'product_type' && poForm.vendor_id) {
      const defaults = getVendorDefaults(Number(poForm.vendor_id), value)
      if (defaults.default_case_weight_lbs) updated[idx].case_weight_lbs = defaults.default_case_weight_lbs
      if (defaults.default_price_per_case) updated[idx].unit_price = defaults.default_price_per_case
      if (defaults.order_unit) updated[idx].price_unit = defaults.order_unit
    }
    setNewLines(updated)
  }

  function removeNewLine(idx) {
    setNewLines(newLines.filter((_, i) => i !== idx))
  }

  function handleCreateSubmit(e) {
    e.preventDefault()
    const data = {
      ...poForm,
      vendor_id: Number(poForm.vendor_id),
      lines: newLines.map(l => ({
        product_type: l.product_type,
        quantity_cases: Number(l.quantity_cases) || 0,
        case_weight_lbs: l.case_weight_lbs ? Number(l.case_weight_lbs) : null,
        unit_price: l.unit_price ? Number(l.unit_price) : null,
        price_unit: l.price_unit,
        notes: l.notes || null,
      })),
    }
    createMut.mutate(data)
  }

  function handleAddLine(poId) {
    const data = {
      product_type: lineForm.product_type,
      quantity_cases: Number(lineForm.quantity_cases) || 0,
      case_weight_lbs: lineForm.case_weight_lbs ? Number(lineForm.case_weight_lbs) : null,
      unit_price: lineForm.unit_price ? Number(lineForm.unit_price) : null,
      price_unit: lineForm.price_unit,
      notes: lineForm.notes || null,
    }
    addLineMut.mutate({ poId, data })
    setLineForm(EMPTY_LINE)
  }

  function handleStatusChange(po, newStatus) {
    updateMut.mutate({ id: po.id, data: { status: newStatus } })
  }

  function openAllocations(poId, line) {
    setAllocations(line.allocations?.map(a => ({ period_id: a.period_id, allocated_lbs: a.allocated_lbs, spoilage_pct: a.spoilage_pct })) || [])
    setShowAllocModal({ poId, lineId: line.id, productType: line.product_type, totalWeight: line.total_weight_lbs })
  }

  function addAllocation() {
    setAllocations([...allocations, { period_id: '', allocated_lbs: '', spoilage_pct: 0 }])
  }

  function updateAllocation(idx, field, value) {
    const updated = [...allocations]
    updated[idx] = { ...updated[idx], [field]: value }
    setAllocations(updated)
  }

  function removeAllocation(idx) {
    setAllocations(allocations.filter((_, i) => i !== idx))
  }

  function saveAllocations() {
    const data = allocations.filter(a => a.period_id && a.allocated_lbs).map(a => ({
      period_id: Number(a.period_id),
      allocated_lbs: Number(a.allocated_lbs),
      spoilage_pct: Number(a.spoilage_pct) || 0,
    }))
    setAllocMut.mutate({ poId: showAllocModal.poId, lineId: showAllocModal.lineId, data })
  }

  function openReceiveForm(line) {
    setReceivingLineId(line.id)
    setReceivingForm({ received_cases: '', received_weight_lbs: '', harvest_date: '', confirmed_pick_sku: '', quality_rating: '', quality_notes: '' })
    receivingApi.getSkusForProductType(line.product_type).then(setAvailableSkus).catch(() => setAvailableSkus([]))
  }

  function handleReceiveSubmit(poId, lineId) {
    const data = {
      received_date: new Date().toISOString().slice(0, 10),
      received_cases: Number(receivingForm.received_cases) || 0,
      received_weight_lbs: Number(receivingForm.received_weight_lbs) || 0,
      confirmed_pick_sku: receivingForm.confirmed_pick_sku || null,
      harvest_date: receivingForm.harvest_date || null,
      quality_rating: receivingForm.quality_rating || null,
      quality_notes: receivingForm.quality_notes || null,
    }
    receiveMut.mutate({ poId, lineId, data })
  }

  // Receiving records grouped by line
  function getRecordsForLine(lineId) {
    return receivingRecords.filter(r => r.po_line_id === lineId)
  }

  function getReceivedWeight(lineId) {
    return getRecordsForLine(lineId).reduce((sum, r) => sum + (r.received_weight_lbs || 0), 0)
  }

  const canReceive = showDetailModal && ['placed', 'in_transit', 'partially_received'].includes(showDetailModal.status)
  const hasUnpushedRecords = receivingRecords.some(r => !r.pushed_to_inventory && r.confirmed_pick_sku)

  // Product types from vendor products
  const vendorProductTypes = poForm.vendor_id
    ? (vendorMap[Number(poForm.vendor_id)]?.products?.map(p => p.product_type) || [])
    : []

  const pof = (field) => (e) => setPoForm({ ...poForm, [field]: e.target.value })
  const lf = (field) => (e) => setLineForm({ ...lineForm, [field]: e.target.value })

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Purchase Orders</h1>
        <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New PO</button>
      </div>

      {/* Status Filter */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          className={`btn btn-sm ${!statusFilter ? 'btn-primary' : ''}`}
          onClick={() => setStatusFilter('')}
        >All</button>
        {PO_STATUSES.map(s => (
          <button
            key={s}
            className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : ''}`}
            onClick={() => setStatusFilter(s)}
            style={{ textTransform: 'capitalize' }}
          >{s.replace(/_/g, ' ')}</button>
        ))}
      </div>

      {isLoading && <p>Loading...</p>}

      {/* PO List Table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '8px' }}>PO #</th>
            <th style={{ padding: '8px' }}>Vendor</th>
            <th style={{ padding: '8px' }}>Status</th>
            <th style={{ padding: '8px' }}>Order Date</th>
            <th style={{ padding: '8px' }}>Expected Delivery</th>
            <th style={{ padding: '8px' }}>Lines</th>
            <th style={{ padding: '8px' }}>Total</th>
            <th style={{ padding: '8px' }}></th>
          </tr>
        </thead>
        <tbody>
          {pos.map(po => (
            <tr key={po.id} style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }} onClick={() => { setShowDetailModal(po); loadReceivingRecords(po.id) }}>
              <td style={{ padding: '8px', fontWeight: 600 }}>{po.po_number}</td>
              <td style={{ padding: '8px' }}>{po.vendor_name || '—'}</td>
              <td style={{ padding: '8px' }}>
                <span style={{
                  padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 500,
                  background: STATUS_COLORS[po.status] || '#e5e7eb', textTransform: 'capitalize',
                }}>{po.status.replace(/_/g, ' ')}</span>
              </td>
              <td style={{ padding: '8px' }}>{formatDate(po.order_date)}</td>
              <td style={{ padding: '8px' }}>{formatDate(po.expected_delivery_date)}</td>
              <td style={{ padding: '8px' }}>{po.lines?.length || 0}</td>
              <td style={{ padding: '8px' }}>{formatCurrency(po.subtotal)}</td>
              <td style={{ padding: '8px' }}>
                <button className="btn btn-sm" onClick={e => { e.stopPropagation(); setShowDetailModal(po); loadReceivingRecords(po.id) }}>View</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {pos.length === 0 && !isLoading && (
        <p style={{ color: '#6b7280', textAlign: 'center', marginTop: 40 }}>No purchase orders found.</p>
      )}

      {/* Create PO Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={closeCreateModal}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 700 }}>
            <h2>New Purchase Order</h2>
            <form onSubmit={handleCreateSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>Vendor *</label>
                  <select required value={poForm.vendor_id} onChange={pof('vendor_id')}>
                    <option value="">Select vendor...</option>
                    {vendors.filter(v => v.is_active).map(v => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Order Date</label>
                  <input type="date" value={poForm.order_date} onChange={pof('order_date')} />
                </div>
                <div className="form-group">
                  <label>Expected Delivery</label>
                  <input type="date" value={poForm.expected_delivery_date} onChange={pof('expected_delivery_date')} />
                </div>
                <div className="form-group">
                  <label>Communication Method</label>
                  <select value={poForm.communication_method} onChange={pof('communication_method')}>
                    <option value="">—</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                    <option value="phone">Phone</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea value={poForm.notes} onChange={pof('notes')} rows={2} />
              </div>

              {/* Line Items */}
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h3 style={{ margin: 0 }}>Line Items</h3>
                  <button type="button" className="btn btn-sm" onClick={addNewLine}>+ Add Line</button>
                </div>
                {newLines.map((line, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto', gap: 8, marginBottom: 8, alignItems: 'end' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: 11 }}>Product Type</label>
                      <input
                        list={`pt-list-${idx}`}
                        value={line.product_type}
                        onChange={e => updateNewLine(idx, 'product_type', e.target.value)}
                        placeholder="Product type"
                      />
                      <datalist id={`pt-list-${idx}`}>
                        {vendorProductTypes.map(pt => <option key={pt} value={pt} />)}
                      </datalist>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: 11 }}>Cases</label>
                      <input type="number" step="0.1" value={line.quantity_cases} onChange={e => updateNewLine(idx, 'quantity_cases', e.target.value)} />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: 11 }}>Case Wt (lbs)</label>
                      <input type="number" step="0.01" value={line.case_weight_lbs} onChange={e => updateNewLine(idx, 'case_weight_lbs', e.target.value)} />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: 11 }}>Unit Price</label>
                      <input type="number" step="0.01" value={line.unit_price} onChange={e => updateNewLine(idx, 'unit_price', e.target.value)} />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: 11 }}>Price Unit</label>
                      <select value={line.price_unit} onChange={e => updateNewLine(idx, 'price_unit', e.target.value)}>
                        <option value="case">Case</option>
                        <option value="lb">Lb</option>
                      </select>
                    </div>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => removeNewLine(idx)} style={{ marginBottom: 0 }}>X</button>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button type="button" className="btn" onClick={closeCreateModal}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={!poForm.vendor_id}>Create PO</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PO Detail Modal */}
      {showDetailModal && (
        <div className="modal-overlay" onClick={() => setShowDetailModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 800 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ margin: '0 0 4px 0' }}>{showDetailModal.po_number}</h2>
                <div style={{ fontSize: 13, color: '#6b7280' }}>
                  {showDetailModal.vendor_name} &middot; {formatDate(showDetailModal.order_date)}
                </div>
              </div>
              <span style={{
                padding: '4px 12px', borderRadius: 12, fontSize: 13, fontWeight: 600,
                background: STATUS_COLORS[showDetailModal.status] || '#e5e7eb', textTransform: 'capitalize',
              }}>{showDetailModal.status.replace(/_/g, ' ')}</span>
            </div>

            {/* Status transition */}
            {STATUS_TRANSITIONS[showDetailModal.status]?.length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#6b7280' }}>Advance to:</span>
                {STATUS_TRANSITIONS[showDetailModal.status].map(s => (
                  <button key={s} className="btn btn-sm" style={{ textTransform: 'capitalize' }}
                    onClick={() => handleStatusChange(showDetailModal, s)}
                  >{s.replace(/_/g, ' ')}</button>
                ))}
              </div>
            )}

            {/* PO Info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 16, fontSize: 13 }}>
              <div><strong>Expected Delivery:</strong> {formatDate(showDetailModal.expected_delivery_date)}</div>
              <div><strong>Actual Delivery:</strong> {formatDate(showDetailModal.actual_delivery_date)}</div>
              <div><strong>Subtotal:</strong> {formatCurrency(showDetailModal.subtotal)}</div>
            </div>
            {showDetailModal.notes && <div style={{ marginTop: 8, fontSize: 13, color: '#6b7280' }}>{showDetailModal.notes}</div>}

            {/* Line Items */}
            <h3 style={{ marginTop: 20 }}>Line Items</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Product Type</th>
                  <th style={{ padding: '6px 8px' }}>Cases</th>
                  <th style={{ padding: '6px 8px' }}>Case Wt</th>
                  <th style={{ padding: '6px 8px' }}>Total Wt</th>
                  <th style={{ padding: '6px 8px' }}>Unit Price</th>
                  <th style={{ padding: '6px 8px' }}>Total</th>
                  <th style={{ padding: '6px 8px' }}>Received</th>
                  <th style={{ padding: '6px 8px' }}>Alloc</th>
                  <th style={{ padding: '6px 8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {showDetailModal.lines?.map(line => {
                  const lineRecords = getRecordsForLine(line.id)
                  const recvWt = getReceivedWeight(line.id)
                  const pct = line.total_weight_lbs ? Math.round((recvWt / line.total_weight_lbs) * 100) : 0
                  return (
                    <React.Fragment key={line.id}>
                      <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 500 }}>
                          {line.product_type}
                          {line.overage_flag && <span style={{ color: '#f59e0b', marginLeft: 6, fontSize: 11 }}>OVERAGE</span>}
                          {line.purchase_plan_line_id && (
                            <span title="This line is managed by a Purchase Planning row. Edit there." style={{ color: '#3b82f6', marginLeft: 6, fontSize: 11 }}>
                              ⌁ from planning
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '6px 8px' }}>{line.quantity_cases}</td>
                        <td style={{ padding: '6px 8px' }}>{line.case_weight_lbs ?? '—'} lbs</td>
                        <td style={{ padding: '6px 8px' }}>{line.total_weight_lbs?.toFixed(1) ?? '—'} lbs</td>
                        <td style={{ padding: '6px 8px' }}>{formatCurrency(line.unit_price)}/{line.price_unit}</td>
                        <td style={{ padding: '6px 8px' }}>{formatCurrency(line.total_price)}</td>
                        <td style={{ padding: '6px 8px' }}>
                          {lineRecords.length > 0 ? (
                            <span style={{ color: pct >= 100 ? '#16a34a' : '#d97706', fontWeight: 500 }}>
                              {recvWt.toFixed(1)} lbs ({pct}%)
                            </span>
                          ) : (
                            <span style={{ color: '#9ca3af' }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <button className="btn btn-xs" onClick={() => openAllocations(showDetailModal.id, line)}>
                            {line.allocations?.length || 0} period{line.allocations?.length !== 1 ? 's' : ''}
                          </button>
                        </td>
                        <td style={{ padding: '6px 8px', display: 'flex', gap: 4 }}>
                          {canReceive && (
                            <button className="btn btn-xs btn-primary" onClick={() => openReceiveForm(line)}>Receive</button>
                          )}
                          {showDetailModal.status === 'draft' && !line.purchase_plan_line_id && (
                            <button className="btn btn-xs btn-danger" onClick={() => deleteLineMut.mutate({ poId: showDetailModal.id, lineId: line.id })}>Del</button>
                          )}
                        </td>
                      </tr>

                      {/* Receiving form for this line */}
                      {receivingLineId === line.id && (
                        <tr><td colSpan={9} style={{ padding: '8px', background: '#f9fafb' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                            <div className="form-group" style={{ margin: 0 }}>
                              <label style={{ fontSize: 11 }}>Cases Received</label>
                              <input type="number" step="0.1" value={receivingForm.received_cases}
                                onChange={e => setReceivingForm({ ...receivingForm, received_cases: e.target.value })} />
                            </div>
                            <div className="form-group" style={{ margin: 0 }}>
                              <label style={{ fontSize: 11 }}>Weight (lbs)</label>
                              <input type="number" step="0.1" value={receivingForm.received_weight_lbs}
                                onChange={e => setReceivingForm({ ...receivingForm, received_weight_lbs: e.target.value })} />
                            </div>
                            <div className="form-group" style={{ margin: 0 }}>
                              <label style={{ fontSize: 11 }}>Harvest Date</label>
                              <input type="date" value={receivingForm.harvest_date}
                                onChange={e => setReceivingForm({ ...receivingForm, harvest_date: e.target.value })} />
                            </div>
                            <div className="form-group" style={{ margin: 0 }}>
                              <label style={{ fontSize: 11 }}>Confirmed SKU</label>
                              <select value={receivingForm.confirmed_pick_sku}
                                onChange={e => setReceivingForm({ ...receivingForm, confirmed_pick_sku: e.target.value })}>
                                <option value="">Select SKU...</option>
                                {availableSkus.map(s => (
                                  <option key={s.pick_sku} value={s.pick_sku}>
                                    {s.pick_sku} ({s.weight_lb ? `${s.weight_lb} lb/pc` : 'no weight'})
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, marginBottom: 8 }}>
                            <div className="form-group" style={{ margin: 0 }}>
                              <label style={{ fontSize: 11 }}>Quality</label>
                              <select value={receivingForm.quality_rating}
                                onChange={e => setReceivingForm({ ...receivingForm, quality_rating: e.target.value })}>
                                <option value="">—</option>
                                <option value="good">Good</option>
                                <option value="acceptable">Acceptable</option>
                                <option value="poor">Poor</option>
                              </select>
                            </div>
                            <div className="form-group" style={{ margin: 0 }}>
                              <label style={{ fontSize: 11 }}>Quality Notes</label>
                              <input value={receivingForm.quality_notes}
                                onChange={e => setReceivingForm({ ...receivingForm, quality_notes: e.target.value })}
                                placeholder="Condition notes..." />
                            </div>
                          </div>
                          {receivingForm.confirmed_pick_sku && receivingForm.received_weight_lbs && (() => {
                            const sku = availableSkus.find(s => s.pick_sku === receivingForm.confirmed_pick_sku)
                            if (sku?.weight_lb) return (
                              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                                Calculated pieces: {(Number(receivingForm.received_weight_lbs) / sku.weight_lb).toFixed(1)}
                              </div>
                            )
                            return null
                          })()}
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button className="btn btn-sm" onClick={() => setReceivingLineId(null)}>Cancel</button>
                            <button className="btn btn-sm btn-primary"
                              disabled={!receivingForm.received_cases || !receivingForm.received_weight_lbs}
                              onClick={() => handleReceiveSubmit(showDetailModal.id, line.id)}>
                              Save Receipt
                            </button>
                          </div>
                        </td></tr>
                      )}

                      {/* Receiving history for this line */}
                      {lineRecords.length > 0 && (
                        <tr><td colSpan={9} style={{ padding: '0 8px 8px 24px' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr style={{ color: '#6b7280' }}>
                                <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 500 }}>Date</th>
                                <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 500 }}>Cases</th>
                                <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 500 }}>Weight</th>
                                <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 500 }}>SKU</th>
                                <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 500 }}>Pieces</th>
                                <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 500 }}>Quality</th>
                                <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 500 }}>Status</th>
                                <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 500 }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {lineRecords.map(rec => (
                                <tr key={rec.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                                  <td style={{ padding: '4px 6px' }}>{formatDate(rec.received_date)}</td>
                                  <td style={{ padding: '4px 6px' }}>{rec.received_cases}</td>
                                  <td style={{ padding: '4px 6px' }}>{rec.received_weight_lbs} lbs</td>
                                  <td style={{ padding: '4px 6px' }}>{rec.confirmed_pick_sku || <span style={{ color: '#d97706' }}>Pending</span>}</td>
                                  <td style={{ padding: '4px 6px' }}>{rec.confirmed_pieces?.toFixed(1) ?? '—'}</td>
                                  <td style={{ padding: '4px 6px' }}>{rec.quality_rating || '—'}</td>
                                  <td style={{ padding: '4px 6px' }}>
                                    {rec.pushed_to_inventory ? (
                                      <span style={{ color: '#16a34a', fontWeight: 500 }}>Pushed</span>
                                    ) : (
                                      <span style={{ color: '#d97706' }}>Pending</span>
                                    )}
                                  </td>
                                  <td style={{ padding: '4px 6px', display: 'flex', gap: 4 }}>
                                    {!rec.pushed_to_inventory && rec.confirmed_pick_sku && (
                                      <button className="btn btn-xs btn-primary" onClick={() => pushMut.mutate(rec.id)}
                                        disabled={pushMut.isPending}>Push</button>
                                    )}
                                    {!rec.pushed_to_inventory && (
                                      <button className="btn btn-xs btn-danger" onClick={() => { if (confirm('Delete this receiving record?')) deleteRecMut.mutate(rec.id) }}>Del</button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td></tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>

            {/* Add line (draft only) */}
            {showDetailModal.status === 'draft' && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <input value={lineForm.product_type} onChange={lf('product_type')} placeholder="Product type" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <input type="number" step="0.1" value={lineForm.quantity_cases} onChange={lf('quantity_cases')} placeholder="Cases" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <input type="number" step="0.01" value={lineForm.case_weight_lbs} onChange={lf('case_weight_lbs')} placeholder="Case wt" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <input type="number" step="0.01" value={lineForm.unit_price} onChange={lf('unit_price')} placeholder="Price" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <select value={lineForm.price_unit} onChange={lf('price_unit')}>
                      <option value="case">Case</option>
                      <option value="lb">Lb</option>
                    </select>
                  </div>
                  <button className="btn btn-sm btn-primary" onClick={() => handleAddLine(showDetailModal.id)} disabled={!lineForm.product_type}>Add</button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              {hasUnpushedRecords && (
                <button className="btn btn-primary" onClick={() => pushAllMut.mutate(showDetailModal.id)}
                  disabled={pushAllMut.isPending}>
                  Push All to Inventory
                </button>
              )}
              {showDetailModal.status === 'draft' && (
                <button className="btn btn-danger" onClick={() => { if (confirm('Delete this PO?')) deleteMut.mutate(showDetailModal.id) }}>Delete PO</button>
              )}
              <button className="btn" onClick={() => setShowDetailModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Allocation Modal */}
      {showAllocModal && (
        <div className="modal-overlay" onClick={() => setShowAllocModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h2>Period Allocations</h2>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
              {showAllocModal.productType} &middot; Total: {showAllocModal.totalWeight?.toFixed(1) || '—'} lbs
            </div>

            {allocations.map((a, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, marginBottom: 8, alignItems: 'end' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Period</label>
                  <select value={a.period_id} onChange={e => updateAllocation(idx, 'period_id', e.target.value)}>
                    <option value="">Select...</option>
                    {periods.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Allocated (lbs)</label>
                  <input type="number" step="0.1" value={a.allocated_lbs} onChange={e => updateAllocation(idx, 'allocated_lbs', e.target.value)} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Spoilage %</label>
                  <input type="number" step="0.01" min="0" max="1" value={a.spoilage_pct} onChange={e => updateAllocation(idx, 'spoilage_pct', e.target.value)} />
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => removeAllocation(idx)}>X</button>
              </div>
            ))}

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <button className="btn btn-sm" onClick={addAllocation}>+ Add Period</button>
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                Total allocated: {allocations.reduce((sum, a) => sum + (Number(a.allocated_lbs) || 0), 0).toFixed(1)} lbs
                {' | '}
                Effective: {allocations.reduce((sum, a) => sum + ((Number(a.allocated_lbs) || 0) * (1 - (Number(a.spoilage_pct) || 0))), 0).toFixed(1)} lbs
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn" onClick={() => setShowAllocModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveAllocations}>Save Allocations</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
