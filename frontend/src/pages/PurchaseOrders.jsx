import React, { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { purchaseOrdersApi, vendorsApi, projectionPeriodsApi, receivingApi } from '../api'
import { useIsMobile } from '../useIsMobile'

const PO_STATUSES = ['draft', 'placed', 'in_transit', 'partially_received', 'delivered', 'imported', 'reconciled']
const STATUS_COLORS = {
  draft: '#e5e7eb', placed: '#bfdbfe', in_transit: '#c4b5fd',
  partially_received: '#fde68a', delivered: '#bbf7d0', imported: '#6ee7b7', reconciled: '#9ca3af',
}

// Once a PO is "imported" it's locked except for the bookkeeping move to
// "reconciled". Before that it can move to any other non-reconciled status.
function allowedTransitions(current) {
  if (current === 'imported') return ['reconciled']
  if (current === 'reconciled') return []
  return PO_STATUSES.filter(s => s !== current && s !== 'reconciled')
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
  pickup_at_vendor_id: '', pickup_address_override: '', pickup_run_date: '',
  driver_name: '', delivery_location: '',
}

const EMPTY_LINE = {
  product_type: '', quantity_cases: '', case_weight_lbs: '',
  unit_price: '', price_unit: 'case', notes: '',
}

// Compress an image file in the browser before upload. Phone photos are
// often 4–8 MB which is wasteful to store; rescaling to 1600px max and
// re-encoding as JPEG quality 0.82 lands at ~300–600 KB without visible loss.
async function compressImage(file, maxDim = 1600, quality = 0.82) {
  if (!file.type.startsWith('image/')) return file
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = url
    })
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.round(img.naturalWidth * scale)
    const h = Math.round(img.naturalHeight * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(url)
  }
}

export default function PurchaseOrders() {
  const qc = useQueryClient()
  const isMobile = useIsMobile()
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
  const [receivingForm, setReceivingForm] = useState({ received_cases: '', case_weight_lbs: '', received_weight_lbs: '', harvest_date: '', confirmed_pick_sku: '', quality_rating: '', quality_notes: '', received_by: '' })
  const [receivingRecords, setReceivingRecords] = useState([])
  const [availableSkus, setAvailableSkus] = useState([])
  // Attachment upload state (loading flag for spinner; preview URL for lightbox)
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [attachmentPreview, setAttachmentPreview] = useState(null)  // { url, filename }
  // Pickup-location editor state per detail modal
  const [pickupForm, setPickupForm] = useState({
    pickup_at_vendor_id: '', pickup_address_override: '', pickup_run_date: '',
    driver_name: '', delivery_location: '', expected_delivery_date: '',
  })
  // Bulk selection — set of PO ids checked in the list
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  // Bulk-edit pickup modal state
  const [showBulkEditModal, setShowBulkEditModal] = useState(false)
  // Per-field "apply this field" toggles — only checked fields get sent
  const [bulkApply, setBulkApply] = useState({
    pickup_run_date: false, expected_delivery_date: false, driver_name: false,
    pickup_at_vendor_id: false, pickup_address_override: false, delivery_location: false,
  })
  const [bulkValues, setBulkValues] = useState({
    pickup_run_date: '', expected_delivery_date: '', driver_name: '',
    pickup_at_vendor_id: '', pickup_address_override: '', delivery_location: '',
  })

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

  const deleteAttMut = useMutation({
    mutationFn: ({ poId, attId }) => purchaseOrdersApi.deleteAttachment(poId, attId),
    onSuccess: (_, vars) => refreshDetail(vars.poId),
  })

  const bulkPickupMut = useMutation({
    mutationFn: (data) => purchaseOrdersApi.bulkUpdatePickup(data),
    onSuccess: () => {
      qc.invalidateQueries(['purchase-orders'])
      setShowBulkEditModal(false)
      setSelectedIds(new Set())
    },
  })

  const bulkStatusMut = useMutation({
    mutationFn: (data) => purchaseOrdersApi.bulkUpdateStatus(data),
    onSuccess: (resp) => {
      qc.invalidateQueries(['purchase-orders'])
      setSelectedIds(new Set())
      setBulkStatusValue('')
      // Surface skipped POs (locked at imported/reconciled) — bulk endpoints
      // partial-succeed on purpose so a single locked PO doesn't fail the batch.
      if (resp.skipped?.length) {
        const lines = resp.skipped.slice(0, 5).map(s => `• ${s.po_number || `#${s.id}`}: ${s.reason}`).join('\n')
        const more = resp.skipped.length > 5 ? `\n…and ${resp.skipped.length - 5} more.` : ''
        alert(`Updated ${resp.updated}. Skipped ${resp.skipped.length}:\n${lines}${more}`)
      }
    },
  })

  const [bulkStatusValue, setBulkStatusValue] = useState('')

  function toggleSelected(poId) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(poId)) next.delete(poId)
      else next.add(poId)
      return next
    })
  }

  function toggleSelectAllVisible(visiblePos) {
    const allSelected = visiblePos.length > 0 && visiblePos.every(p => selectedIds.has(p.id))
    if (allSelected) {
      // Unselect just the visible ones (preserve any selections outside the current filter).
      setSelectedIds(prev => {
        const next = new Set(prev)
        visiblePos.forEach(p => next.delete(p.id))
        return next
      })
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        visiblePos.forEach(p => next.add(p.id))
        return next
      })
    }
  }

  function openBulkEdit() {
    // Reset modal to a clean slate every time so a stale "apply" toggle from
    // a previous edit doesn't sneak through.
    setBulkApply({
      pickup_run_date: false, expected_delivery_date: false, driver_name: false,
      pickup_at_vendor_id: false, pickup_address_override: false, delivery_location: false,
    })
    setBulkValues({
      pickup_run_date: '', expected_delivery_date: '', driver_name: '',
      pickup_at_vendor_id: '', pickup_address_override: '', delivery_location: '',
    })
    setShowBulkEditModal(true)
  }

  function handleBulkSubmit() {
    const fields_to_update = Object.entries(bulkApply).filter(([, on]) => on).map(([k]) => k)
    if (!fields_to_update.length) {
      alert('Tick at least one field to apply.')
      return
    }
    const payload = { ids: Array.from(selectedIds), fields_to_update }
    fields_to_update.forEach(f => {
      const v = bulkValues[f]
      // Empty string → null (clear). Number-FK → number. Otherwise pass through.
      if (f === 'pickup_at_vendor_id') payload[f] = v ? Number(v) : null
      else payload[f] = v === '' ? null : v
    })
    bulkPickupMut.mutate(payload)
  }

  async function handleUploadAttachment(poId, file) {
    if (!file) return
    setUploadingAttachment(true)
    try {
      const compressed = await compressImage(file)
      await purchaseOrdersApi.uploadAttachment(poId, compressed, 'invoice')
      refreshDetail(poId)
    } catch (e) {
      alert('Upload failed: ' + (e.response?.data?.detail || e.message))
    } finally {
      setUploadingAttachment(false)
    }
  }

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

  // Sync pickup form whenever the detail modal's PO changes (opens, refreshes after save).
  useEffect(() => {
    if (!showDetailModal) return
    setPickupForm({
      pickup_at_vendor_id: showDetailModal.pickup_at_vendor_id ?? '',
      pickup_address_override: showDetailModal.pickup_address_override ?? '',
      pickup_run_date: showDetailModal.pickup_run_date ?? '',
      driver_name: showDetailModal.driver_name ?? '',
      delivery_location: showDetailModal.delivery_location ?? '',
      expected_delivery_date: showDetailModal.expected_delivery_date ?? '',
    })
  }, [showDetailModal?.id, showDetailModal?.updated_at])

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
    // Pre-fill from the PO line so the user only needs to confirm or tweak.
    // Cases/case-weight/total-weight default to what was ordered; harvest
    // defaults to today (the receiving date). The SKU default is filled in
    // below once we know which SKUs are stocked.
    const today = new Date().toISOString().slice(0, 10)
    setReceivingForm({
      received_cases: line.quantity_cases ?? '',
      case_weight_lbs: line.case_weight_lbs ?? '',
      received_weight_lbs: line.total_weight_lbs ?? '',
      harvest_date: today,
      confirmed_pick_sku: '',
      quality_rating: '',
      quality_notes: '',
      // Default received_by to the PO's driver_name so the receipt is attributed
      // by default; user can override.
      received_by: showDetailModal?.driver_name ?? '',
    })
    receivingApi.getSkusForProductType(line.product_type, line.id)
      .then(skus => {
        setAvailableSkus(skus)
        // Default selection priority:
        //   1) Suggested SKU with inventory on hand
        //   2) Suggested SKU even if zero on hand
        //   3) Any SKU with on hand > 0 (last resort — flagged as "not in suggestions")
        const suggested = skus.filter(s => s.match_reason)
        const stockedSuggested = suggested.find(s => (s.total_on_hand ?? 0) > 0)
        const anySuggested = suggested[0]
        const stockedAny = skus.find(s => (s.total_on_hand ?? 0) > 0)
        const pick = stockedSuggested || anySuggested || stockedAny
        if (pick) {
          setReceivingForm(f => ({ ...f, confirmed_pick_sku: pick.pick_sku }))
        }
      })
      .catch(() => setAvailableSkus([]))
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
      received_by: receivingForm.received_by || null,
    }
    receiveMut.mutate({ poId, lineId, data })
  }

  function handleSavePickup(poId) {
    const data = {
      pickup_at_vendor_id: pickupForm.pickup_at_vendor_id ? Number(pickupForm.pickup_at_vendor_id) : null,
      pickup_address_override: pickupForm.pickup_address_override || null,
      pickup_run_date: pickupForm.pickup_run_date || null,
      driver_name: pickupForm.driver_name || null,
      delivery_location: pickupForm.delivery_location || null,
      expected_delivery_date: pickupForm.expected_delivery_date || null,
    }
    updateMut.mutate({ id: poId, data })
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

      {/* Bulk action toolbar — appears when >=1 POs are selected (desktop only) */}
      {!isMobile && selectedIds.size > 0 && (
        <div style={{
          marginBottom: 12, padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe',
          borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 14 }}>
            <strong>{selectedIds.size}</strong> PO{selectedIds.size === 1 ? '' : 's'} selected
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-primary" onClick={openBulkEdit}>
              Edit Pickup &amp; Delivery
            </button>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>Set status:</span>
              <select
                value={bulkStatusValue}
                onChange={e => setBulkStatusValue(e.target.value)}
                style={{ textTransform: 'capitalize' }}
              >
                <option value="">— pick status —</option>
                {PO_STATUSES.map(s => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <button className="btn btn-sm btn-primary"
                disabled={!bulkStatusValue || bulkStatusMut.isPending}
                onClick={() => {
                  if (!bulkStatusValue) return
                  bulkStatusMut.mutate({ ids: Array.from(selectedIds), status: bulkStatusValue })
                }}
              >Apply</button>
            </div>
            <button className="btn btn-sm" onClick={() => setSelectedIds(new Set())}>
              Clear selection
            </button>
          </div>
        </div>
      )}

      {/* PO List — table on desktop, cards on mobile */}
      {isMobile ? (
        <div>
          {pos.map(po => (
            <div key={po.id}
              className="po-mobile-card"
              onClick={() => { setShowDetailModal(po); loadReceivingRecords(po.id) }}
            >
              <div className="po-mobile-card-row">
                <span className="po-mobile-card-num">{po.po_number}</span>
                <span style={{
                  padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 500,
                  background: STATUS_COLORS[po.status] || '#e5e7eb', textTransform: 'capitalize',
                }}>{po.status.replace(/_/g, ' ')}</span>
              </div>
              <div className="po-mobile-card-vendor">{po.vendor_name || '—'}</div>
              <div className="po-mobile-card-meta">
                {formatDate(po.order_date)}
                {po.expected_delivery_date && <> · ETA {formatDate(po.expected_delivery_date)}</>}
              </div>
              <div className="po-mobile-card-meta">
                {po.lines?.length || 0} line{po.lines?.length === 1 ? '' : 's'} · {formatCurrency(po.subtotal)}
              </div>
            </div>
          ))}
        </div>
      ) : (() => {
        const allVisibleSelected = pos.length > 0 && pos.every(p => selectedIds.has(p.id))
        const someVisibleSelected = pos.some(p => selectedIds.has(p.id))
        return (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '8px', width: 32 }}>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                ref={el => { if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected }}
                onChange={() => toggleSelectAllVisible(pos)}
                title="Select all in current view"
              />
            </th>
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
            <tr key={po.id}
                style={{
                  borderBottom: '1px solid #f3f4f6', cursor: 'pointer',
                  background: selectedIds.has(po.id) ? '#eff6ff' : undefined,
                }}
                onClick={() => { setShowDetailModal(po); loadReceivingRecords(po.id) }}>
              <td style={{ padding: '8px' }} onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(po.id)}
                  onChange={() => toggleSelected(po.id)}
                />
              </td>
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
        )
      })()}

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

      {/* PO Detail — mobile sheet on phones, big modal on desktop */}
      {showDetailModal && (isMobile ? (
        <div className="modal-overlay" onClick={() => setShowDetailModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="po-mobile-back-bar">
              <button className="po-mobile-back-btn" onClick={() => setShowDetailModal(null)}>← Back to list</button>
            </div>
            <div className="po-mobile-detail">
              {/* Header */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <h2 style={{ margin: 0, fontSize: 18 }}>{showDetailModal.po_number}</h2>
                  <span style={{
                    padding: '4px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                    background: STATUS_COLORS[showDetailModal.status] || '#e5e7eb', textTransform: 'capitalize', whiteSpace: 'nowrap',
                  }}>{showDetailModal.status.replace(/_/g, ' ')}</span>
                </div>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
                  {showDetailModal.vendor_name} · {formatDate(showDetailModal.order_date)}
                </div>
              </div>

              {/* Status transition (compact dropdown) */}
              {(() => {
                const choices = allowedTransitions(showDetailModal.status)
                if (!choices.length) {
                  if (showDetailModal.status === 'reconciled') {
                    return <div style={{ fontSize: 12, color: '#6b7280' }}>Status locked — reconciled.</div>
                  }
                  return null
                }
                return (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>Change status:</span>
                    <select
                      value=""
                      onChange={e => { if (e.target.value) handleStatusChange(showDetailModal, e.target.value) }}
                      style={{ flex: 1, fontSize: 14, padding: '8px 10px', minWidth: 0 }}
                    >
                      <option value="">— pick —</option>
                      {choices.map(s => (
                        <option key={s} value={s} style={{ textTransform: 'capitalize' }}>{s.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </div>
                )
              })()}

              {/* Invoice & Photos — top-prominent for warehouse use */}
              <div className="po-mobile-section">
                <div className="po-mobile-section-title">Invoice & Photos</div>
                <label className="po-mobile-photo-btn" style={{ cursor: uploadingAttachment ? 'wait' : 'pointer' }}>
                  {uploadingAttachment ? 'Uploading…' : '📷 Take Photo / Upload'}
                  <input
                    type="file" accept="image/*" capture="environment"
                    style={{ display: 'none' }}
                    disabled={uploadingAttachment}
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) handleUploadAttachment(showDetailModal.id, f)
                      e.target.value = ''
                    }}
                  />
                </label>
                {showDetailModal.attachments?.length > 0 && (
                  <div className="po-mobile-photo-grid">
                    {showDetailModal.attachments.map(att => {
                      const url = purchaseOrdersApi.attachmentDownloadUrl(showDetailModal.id, att.id)
                      const isImage = (att.content_type || '').startsWith('image/')
                      return (
                        <div key={att.id} style={{ position: 'relative' }}>
                          {isImage ? (
                            <img
                              src={url}
                              alt={att.filename || ''}
                              onClick={() => setAttachmentPreview({ url, filename: att.filename })}
                            />
                          ) : (
                            <a href={url} target="_blank" rel="noreferrer"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', aspectRatio: '1', padding: 8, fontSize: 11, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, textDecoration: 'none', color: '#374151', wordBreak: 'break-word' }}>
                              📎 {att.filename || 'file'}
                            </a>
                          )}
                          <button
                            onClick={() => { if (confirm('Delete this attachment?')) deleteAttMut.mutate({ poId: showDetailModal.id, attId: att.id }) }}
                            style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', borderRadius: '50%', width: 22, height: 22, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}
                          >×</button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Order Info compact */}
              <div className="po-mobile-section">
                <div className="po-mobile-section-title">Order Info</div>
                <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                  <div><span style={{ color: '#6b7280' }}>Expected:</span> {formatDate(showDetailModal.expected_delivery_date)}</div>
                  <div><span style={{ color: '#6b7280' }}>Actual:</span> {formatDate(showDetailModal.actual_delivery_date)}</div>
                  <div><span style={{ color: '#6b7280' }}>Subtotal:</span> {formatCurrency(showDetailModal.subtotal)}</div>
                  {showDetailModal.notes && <div style={{ marginTop: 6, color: '#6b7280', fontStyle: 'italic' }}>{showDetailModal.notes}</div>}
                </div>
              </div>

              {/* Pickup & Delivery — single column */}
              <div className="po-mobile-section">
                <div className="po-mobile-section-title">Pickup & Delivery</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                  Effective: {showDetailModal.effective_pickup_address ? (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(showDetailModal.effective_pickup_address)}`}
                      target="_blank" rel="noreferrer"
                      style={{ color: '#2563eb' }}
                    >{showDetailModal.effective_pickup_address}</a>
                  ) : <em style={{ color: '#9ca3af' }}>No address on file</em>}
                </div>
                <div className="po-mobile-receive-form" style={{ display: 'grid', gap: 8 }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Pickup Date</label>
                    <input type="date" value={pickupForm.pickup_run_date || ''}
                      onChange={e => setPickupForm({ ...pickupForm, pickup_run_date: e.target.value })} />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Expected Delivery</label>
                    <input type="date" value={pickupForm.expected_delivery_date || ''}
                      onChange={e => setPickupForm({ ...pickupForm, expected_delivery_date: e.target.value })} />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Driver</label>
                    <input value={pickupForm.driver_name || ''}
                      onChange={e => setPickupForm({ ...pickupForm, driver_name: e.target.value })}
                      placeholder="Driver name" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>Delivery Location</label>
                    <input value={pickupForm.delivery_location || ''}
                      onChange={e => setPickupForm({ ...pickupForm, delivery_location: e.target.value })}
                      placeholder="The farm" />
                  </div>
                </div>
                <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }}
                  onClick={() => handleSavePickup(showDetailModal.id)}
                  disabled={updateMut.isPending}>
                  Save Pickup Details
                </button>
              </div>

              {/* Line Items */}
              <div>
                <div className="po-mobile-section-title" style={{ paddingLeft: 4, marginBottom: 6 }}>Line Items</div>
                {showDetailModal.lines?.map(line => {
                  const lineRecords = getRecordsForLine(line.id)
                  const recvWt = getReceivedWeight(line.id)
                  const pct = line.total_weight_lbs ? Math.round((recvWt / line.total_weight_lbs) * 100) : 0
                  return (
                    <div key={line.id} className="po-mobile-line">
                      <div style={{ fontWeight: 600, fontSize: 15 }}>
                        {line.product_type}
                        {line.overage_flag && <span style={{ color: '#f59e0b', marginLeft: 6, fontSize: 11 }}>OVERAGE</span>}
                      </div>
                      <div className="po-mobile-card-meta" style={{ marginTop: 2 }}>
                        {line.quantity_cases} cases × {line.case_weight_lbs ?? '—'} lb/case = {line.total_weight_lbs?.toFixed(1) ?? '—'} lbs
                      </div>
                      <div className="po-mobile-card-meta">
                        {formatCurrency(line.unit_price)}/{line.price_unit} · {formatCurrency(line.total_price)}
                      </div>
                      {lineRecords.length > 0 && (
                        <>
                          <div style={{ marginTop: 8, fontSize: 12, color: pct >= 100 ? '#16a34a' : '#d97706', fontWeight: 600 }}>
                            Received: {recvWt.toFixed(1)} lbs ({pct}%)
                          </div>
                          <div className="po-mobile-line-progress">
                            <div className="po-mobile-line-progress-fill" style={{ width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? '#16a34a' : '#f59e0b' }} />
                          </div>
                        </>
                      )}

                      {canReceive && receivingLineId !== line.id && (
                        <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }}
                          onClick={() => openReceiveForm(line)}>
                          Receive This Line
                        </button>
                      )}

                      {/* Receive form — single column on mobile */}
                      {receivingLineId === line.id && (
                        <div className="po-mobile-receive-form" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #e5e7eb' }}>
                          <div className="form-group">
                            <label>Cases Received</label>
                            <input type="number" inputMode="decimal" step="0.1" value={receivingForm.received_cases}
                              onChange={e => {
                                const cases = e.target.value
                                const cw = receivingForm.case_weight_lbs
                                setReceivingForm({
                                  ...receivingForm,
                                  received_cases: cases,
                                  received_weight_lbs: (cases !== '' && cw !== '' && cw != null)
                                    ? Number(cases) * Number(cw)
                                    : receivingForm.received_weight_lbs,
                                })
                              }} />
                          </div>
                          <div className="form-group">
                            <label>Case Weight (lbs)</label>
                            <input type="number" inputMode="decimal" step="0.1" value={receivingForm.case_weight_lbs ?? ''}
                              onChange={e => {
                                const cw = e.target.value
                                const cases = receivingForm.received_cases
                                setReceivingForm({
                                  ...receivingForm,
                                  case_weight_lbs: cw,
                                  received_weight_lbs: (cases !== '' && cw !== '')
                                    ? Number(cases) * Number(cw)
                                    : receivingForm.received_weight_lbs,
                                })
                              }} />
                          </div>
                          <div className="form-group">
                            <label>Total Weight (lbs)</label>
                            <input type="number" inputMode="decimal" step="0.1" value={receivingForm.received_weight_lbs}
                              onChange={e => setReceivingForm({ ...receivingForm, received_weight_lbs: e.target.value })} />
                          </div>
                          <div className="form-group">
                            <label>Harvest Date</label>
                            <input type="date" value={receivingForm.harvest_date}
                              onChange={e => setReceivingForm({ ...receivingForm, harvest_date: e.target.value })} />
                          </div>
                          <div className="form-group">
                            <label>Confirmed SKU</label>
                            <select value={receivingForm.confirmed_pick_sku}
                              onChange={e => setReceivingForm({ ...receivingForm, confirmed_pick_sku: e.target.value })}>
                              {availableSkus.length === 0 && <option value="">No SKUs found</option>}
                              {(() => {
                                const fmtOpt = (s) => {
                                  const w = s.weight_lb ? `${s.weight_lb} lb/pc` : 'no weight'
                                  const oh = s.total_on_hand > 0 ? ` · ${s.total_on_hand} on hand` : ''
                                  const tag = s.match_reason && s.match_reason !== 'exact'
                                    ? ` · ${s.match_reason}`
                                    : ''
                                  return `${s.pick_sku} (${w})${oh}${tag}`
                                }
                                const suggested = availableSkus.filter(s => s.match_reason)
                                const others = availableSkus.filter(s => !s.match_reason)
                                return (
                                  <>
                                    {suggested.length > 0 && (
                                      <optgroup label="Suggested">
                                        {suggested.map(s => (
                                          <option key={s.pick_sku} value={s.pick_sku}>{fmtOpt(s)}</option>
                                        ))}
                                      </optgroup>
                                    )}
                                    {others.length > 0 && (
                                      <optgroup label="Other">
                                        {others.map(s => (
                                          <option key={s.pick_sku} value={s.pick_sku}>{fmtOpt(s)}</option>
                                        ))}
                                      </optgroup>
                                    )}
                                  </>
                                )
                              })()}
                            </select>
                          </div>
                          <div className="form-group">
                            <label>Received By</label>
                            <input value={receivingForm.received_by}
                              onChange={e => setReceivingForm({ ...receivingForm, received_by: e.target.value })}
                              placeholder="Driver / runner name" />
                          </div>
                          <div className="form-group">
                            <label>Quality</label>
                            <select value={receivingForm.quality_rating}
                              onChange={e => setReceivingForm({ ...receivingForm, quality_rating: e.target.value })}>
                              <option value="">—</option>
                              <option value="good">Good</option>
                              <option value="acceptable">Acceptable</option>
                              <option value="poor">Poor</option>
                            </select>
                          </div>
                          <div className="form-group">
                            <label>Quality Notes</label>
                            <input value={receivingForm.quality_notes}
                              onChange={e => setReceivingForm({ ...receivingForm, quality_notes: e.target.value })}
                              placeholder="Condition notes…" />
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
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button className="btn" style={{ flex: 1 }} onClick={() => setReceivingLineId(null)}>Cancel</button>
                            <button className="btn btn-primary" style={{ flex: 2 }}
                              disabled={!receivingForm.received_cases || !receivingForm.received_weight_lbs}
                              onClick={() => handleReceiveSubmit(showDetailModal.id, line.id)}>
                              Save Receipt
                            </button>
                          </div>
                        </div>
                      )}

                      {/* History compact */}
                      {lineRecords.length > 0 && (
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #f3f4f6' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6, letterSpacing: 0.4 }}>History</div>
                          {lineRecords.map(rec => (
                            <div key={rec.id} style={{ padding: '8px 0', borderTop: '1px solid #f9fafb', fontSize: 12 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontWeight: 500 }}>
                                  {formatDate(rec.received_date)} — {rec.received_cases} cs / {rec.received_weight_lbs} lbs
                                </span>
                                {rec.pushed_to_inventory ? (
                                  <span style={{ color: '#16a34a', fontWeight: 600, fontSize: 11 }}>Pushed</span>
                                ) : (
                                  <span style={{ color: '#d97706', fontWeight: 600, fontSize: 11 }}>Pending</span>
                                )}
                              </div>
                              <div style={{ color: '#6b7280', marginTop: 2 }}>
                                {rec.received_by && <>{rec.received_by} · </>}
                                {rec.confirmed_pick_sku || <span style={{ color: '#d97706' }}>SKU pending</span>}
                                {rec.quality_rating && <> · {rec.quality_rating}</>}
                              </div>
                              {!rec.pushed_to_inventory && (
                                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                  {rec.confirmed_pick_sku && (
                                    <button className="btn btn-sm btn-primary" style={{ flex: 1 }}
                                      onClick={() => pushMut.mutate(rec.id)}
                                      disabled={pushMut.isPending}>
                                      Push to Inventory
                                    </button>
                                  )}
                                  <button className="btn btn-sm btn-danger"
                                    onClick={() => { if (confirm('Delete this receipt?')) deleteRecMut.mutate(rec.id) }}>
                                    Del
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Sticky footer actions */}
              <div className="po-mobile-sticky-footer">
                {hasUnpushedRecords && (
                  <button className="btn btn-primary"
                    onClick={() => pushAllMut.mutate(showDetailModal.id)}
                    disabled={pushAllMut.isPending}>
                    Push All to Inventory
                  </button>
                )}
                <button className="btn" onClick={() => setShowDetailModal(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="modal-overlay" onClick={() => setShowDetailModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 1100, maxWidth: '95vw' }}>
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
            {(() => {
              const choices = allowedTransitions(showDetailModal.status)
              if (!choices.length) return (
                <div style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>
                  Status is locked — this PO has been reconciled.
                </div>
              )
              return (
                <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>
                    {showDetailModal.status === 'imported' ? 'Mark as:' : 'Change status to:'}
                  </span>
                  {choices.map(s => (
                    <button key={s} className="btn btn-sm" style={{ textTransform: 'capitalize' }}
                      onClick={() => handleStatusChange(showDetailModal, s)}
                    >{s.replace(/_/g, ' ')}</button>
                  ))}
                </div>
              )
            })()}

            {/* PO Info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 16, fontSize: 13 }}>
              <div><strong>Expected Delivery:</strong> {formatDate(showDetailModal.expected_delivery_date)}</div>
              <div><strong>Actual Delivery:</strong> {formatDate(showDetailModal.actual_delivery_date)}</div>
              <div><strong>Subtotal:</strong> {formatCurrency(showDetailModal.subtotal)}</div>
            </div>
            {showDetailModal.notes && <div style={{ marginTop: 8, fontSize: 13, color: '#6b7280' }}>{showDetailModal.notes}</div>}

            {/* Pickup & Delivery */}
            <div style={{ marginTop: 16, padding: 12, background: '#f9fafb', borderRadius: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 15 }}>Pickup &amp; Delivery</h3>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  Effective pickup: {showDetailModal.effective_pickup_address ? (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(showDetailModal.effective_pickup_address)}`}
                      target="_blank" rel="noreferrer"
                      style={{ color: '#2563eb' }}
                    >{showDetailModal.effective_pickup_address}</a>
                  ) : <em style={{ color: '#9ca3af' }}>No address on file — set vendor pickup address or add an override below</em>}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Pickup Date</label>
                  <input type="date" value={pickupForm.pickup_run_date || ''}
                    onChange={e => setPickupForm({ ...pickupForm, pickup_run_date: e.target.value })} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Expected Delivery</label>
                  <input type="date" value={pickupForm.expected_delivery_date || ''}
                    onChange={e => setPickupForm({ ...pickupForm, expected_delivery_date: e.target.value })} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Driver</label>
                  <input value={pickupForm.driver_name || ''}
                    onChange={e => setPickupForm({ ...pickupForm, driver_name: e.target.value })}
                    placeholder="Driver name" />
                </div>
                <div className="form-group" style={{ margin: 0, gridColumn: 'span 2' }}>
                  <label style={{ fontSize: 11 }}>
                    Consolidate Pickup at Another Vendor
                    {pickupForm.pickup_at_vendor_id && (
                      <span style={{ marginLeft: 8, color: '#6b7280', fontWeight: 400 }}>
                        — driver picks up here instead of {showDetailModal.vendor_name}
                      </span>
                    )}
                  </label>
                  <select value={pickupForm.pickup_at_vendor_id}
                    onChange={e => setPickupForm({ ...pickupForm, pickup_at_vendor_id: e.target.value })}>
                    <option value="">— Pick up from {showDetailModal.vendor_name || 'seller'} directly —</option>
                    {vendors.filter(v => v.is_active && v.id !== showDetailModal.vendor_id).map(v => (
                      <option key={v.id} value={v.id}>
                        {v.name}{v.pickup_address ? ` — ${v.pickup_address}` : ' (no address on file)'}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11 }}>Delivery Location (where it goes)</label>
                  <input value={pickupForm.delivery_location || ''}
                    onChange={e => setPickupForm({ ...pickupForm, delivery_location: e.target.value })}
                    placeholder="The farm" />
                </div>
                <div className="form-group" style={{ margin: 0, gridColumn: 'span 3' }}>
                  <label style={{ fontSize: 11 }}>Custom Pickup Address (override — wins over both options above)</label>
                  <input value={pickupForm.pickup_address_override || ''}
                    onChange={e => setPickupForm({ ...pickupForm, pickup_address_override: e.target.value })}
                    placeholder="Free-form address — use this for parking-lot meets, etc." />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-sm btn-primary"
                  onClick={() => handleSavePickup(showDetailModal.id)}
                  disabled={updateMut.isPending}>
                  Save Pickup Details
                </button>
              </div>
            </div>

            {/* Attachments — invoice photos etc. */}
            <div style={{ marginTop: 12, padding: 12, background: '#f9fafb', borderRadius: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 15 }}>Invoice &amp; Photos</h3>
                <label className="btn btn-sm btn-primary" style={{ cursor: uploadingAttachment ? 'wait' : 'pointer', margin: 0 }}>
                  {uploadingAttachment ? 'Uploading…' : '+ Add Photo'}
                  {/* capture="environment" tells phones to open the rear camera directly. */}
                  <input
                    type="file" accept="image/*" capture="environment"
                    style={{ display: 'none' }}
                    disabled={uploadingAttachment}
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) handleUploadAttachment(showDetailModal.id, f)
                      e.target.value = ''  // reset so picking the same file twice still fires onChange
                    }}
                  />
                </label>
              </div>
              {showDetailModal.attachments?.length > 0 ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {showDetailModal.attachments.map(att => {
                    const url = purchaseOrdersApi.attachmentDownloadUrl(showDetailModal.id, att.id)
                    const isImage = (att.content_type || '').startsWith('image/')
                    return (
                      <div key={att.id} style={{ position: 'relative', width: 120 }}>
                        {isImage ? (
                          <img
                            src={url}
                            alt={att.filename || 'attachment'}
                            style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 4, cursor: 'pointer', border: '1px solid #e5e7eb' }}
                            onClick={() => setAttachmentPreview({ url, filename: att.filename })}
                          />
                        ) : (
                          <a href={url} target="_blank" rel="noreferrer"
                            style={{ display: 'block', width: 120, height: 120, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 4, padding: 8, fontSize: 11, textDecoration: 'none' }}>
                            📎 {att.filename || 'file'}
                          </a>
                        )}
                        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2, textAlign: 'center' }}>
                          {att.kind} · {att.size_bytes ? `${Math.round(att.size_bytes / 1024)} KB` : '—'}
                        </div>
                        <button className="btn btn-xs btn-danger"
                          style={{ position: 'absolute', top: 2, right: 2 }}
                          onClick={() => { if (confirm('Delete this attachment?')) deleteAttMut.mutate({ poId: showDetailModal.id, attId: att.id }) }}
                        >×</button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: '#9ca3af' }}>No invoice or photos uploaded yet. Tap "+ Add Photo" to take or attach one.</div>
              )}
            </div>

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
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 8 }}>
                            <div className="form-group" style={{ margin: 0 }}>
                              <label style={{ fontSize: 11 }}>Cases Received</label>
                              <input type="number" step="0.1" value={receivingForm.received_cases}
                                onChange={e => {
                                  // Recompute total weight when cases or case-weight changes,
                                  // unless the user has already typed a custom total weight.
                                  const cases = e.target.value
                                  const cw = receivingForm.case_weight_lbs
                                  setReceivingForm({
                                    ...receivingForm,
                                    received_cases: cases,
                                    received_weight_lbs: (cases !== '' && cw !== '' && cw != null)
                                      ? Number(cases) * Number(cw)
                                      : receivingForm.received_weight_lbs,
                                  })
                                }} />
                            </div>
                            <div className="form-group" style={{ margin: 0 }}>
                              <label style={{ fontSize: 11 }}>Case Wt (lbs)</label>
                              <input type="number" step="0.1" value={receivingForm.case_weight_lbs ?? ''}
                                onChange={e => {
                                  const cw = e.target.value
                                  const cases = receivingForm.received_cases
                                  setReceivingForm({
                                    ...receivingForm,
                                    case_weight_lbs: cw,
                                    received_weight_lbs: (cases !== '' && cw !== '')
                                      ? Number(cases) * Number(cw)
                                      : receivingForm.received_weight_lbs,
                                  })
                                }} />
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
                              <label style={{ fontSize: 11 }}>
                                Confirmed SKU
                                {(() => {
                                  // Yellow flag if the selected SKU isn't in the suggested set.
                                  // The user can still pick anything, but this surfaces the
                                  // off-list choice so it's deliberate, not an accident.
                                  const sel = availableSkus.find(s => s.pick_sku === receivingForm.confirmed_pick_sku)
                                  if (!sel || sel.match_reason) return null
                                  return (
                                    <span title="This SKU is outside the suggested matches for this product type" style={{ color: '#b45309', marginLeft: 6, fontSize: 11 }}>
                                      ⚠ Not in suggestions
                                    </span>
                                  )
                                })()}
                              </label>
                              <select value={receivingForm.confirmed_pick_sku}
                                onChange={e => setReceivingForm({ ...receivingForm, confirmed_pick_sku: e.target.value })}>
                                {availableSkus.length === 0 && <option value="">No SKUs found</option>}
                                {(() => {
                                  // Render two groups: Suggested (any match_reason set) and Other.
                                  // Each option renders the SKU, weight, on-hand qty, and — for
                                  // suggested items — a short tag explaining why it's suggested.
                                  const fmtOpt = (s) => {
                                    const w = s.weight_lb ? `${s.weight_lb} lb/pc` : 'no weight'
                                    const oh = s.total_on_hand > 0 ? ` · ${s.total_on_hand} on hand` : ''
                                    const tag = s.match_reason && s.match_reason !== 'exact'
                                      ? ` · ${s.match_reason}`
                                      : ''
                                    return `${s.pick_sku} (${w})${oh}${tag}`
                                  }
                                  const suggested = availableSkus.filter(s => s.match_reason)
                                  const others = availableSkus.filter(s => !s.match_reason)
                                  return (
                                    <>
                                      {suggested.length > 0 && (
                                        <optgroup label="Suggested">
                                          {suggested.map(s => (
                                            <option key={s.pick_sku} value={s.pick_sku}>{fmtOpt(s)}</option>
                                          ))}
                                        </optgroup>
                                      )}
                                      {others.length > 0 && (
                                        <optgroup label="──────────  Other  ──────────">
                                          {others.map(s => (
                                            <option key={s.pick_sku} value={s.pick_sku}>{fmtOpt(s)}</option>
                                          ))}
                                        </optgroup>
                                      )}
                                    </>
                                  )
                                })()}
                              </select>
                            </div>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 8, marginBottom: 8 }}>
                            <div className="form-group" style={{ margin: 0 }}>
                              <label style={{ fontSize: 11 }}>Received By</label>
                              <input value={receivingForm.received_by}
                                onChange={e => setReceivingForm({ ...receivingForm, received_by: e.target.value })}
                                placeholder="Driver / runner name" />
                            </div>
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
                                <th style={{ padding: '4px 6px', textAlign: 'left', fontWeight: 500 }}>By</th>
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
                                  <td style={{ padding: '4px 6px' }}>{rec.received_by || <span style={{ color: '#9ca3af' }}>—</span>}</td>
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
      ))}

      {/* Bulk Pickup Edit Modal */}
      {showBulkEditModal && (
        <div className="modal-overlay" onClick={() => setShowBulkEditModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <h2 style={{ margin: '0 0 4px 0' }}>Bulk Edit Pickup &amp; Delivery</h2>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
              Applying to <strong>{selectedIds.size}</strong> selected PO{selectedIds.size === 1 ? '' : 's'}.
              Tick a checkbox to update that field — unchecked fields are left as-is on each PO.
              Leaving a checked field blank clears it.
            </div>

            {[
              { key: 'pickup_run_date', label: 'Pickup Date', type: 'date' },
              { key: 'expected_delivery_date', label: 'Expected Delivery', type: 'date' },
              { key: 'driver_name', label: 'Driver', type: 'text', placeholder: 'Driver name' },
              { key: 'pickup_at_vendor_id', label: 'Consolidate Pickup at Vendor', type: 'vendor-select' },
              { key: 'delivery_location', label: 'Delivery Location', type: 'text', placeholder: 'The farm' },
              { key: 'pickup_address_override', label: 'Custom Pickup Address', type: 'text', placeholder: 'Free-form override' },
            ].map(f => (
              <div key={f.key} style={{ display: 'grid', gridTemplateColumns: 'auto 180px 1fr', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={bulkApply[f.key]}
                  onChange={e => setBulkApply({ ...bulkApply, [f.key]: e.target.checked })}
                />
                <label style={{ fontSize: 13, color: bulkApply[f.key] ? '#111827' : '#9ca3af' }}>
                  {f.label}
                </label>
                {f.type === 'vendor-select' ? (
                  <select
                    value={bulkValues[f.key]}
                    disabled={!bulkApply[f.key]}
                    onChange={e => setBulkValues({ ...bulkValues, [f.key]: e.target.value })}
                  >
                    <option value="">— Clear consolidation (pick up from sellers directly) —</option>
                    {vendors.filter(v => v.is_active).map(v => (
                      <option key={v.id} value={v.id}>
                        {v.name}{v.pickup_address ? ` — ${v.pickup_address}` : ' (no address)'}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type}
                    value={bulkValues[f.key]}
                    disabled={!bulkApply[f.key]}
                    placeholder={f.placeholder}
                    onChange={e => setBulkValues({ ...bulkValues, [f.key]: e.target.value })}
                  />
                )}
              </div>
            ))}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn" onClick={() => setShowBulkEditModal(false)}>Cancel</button>
              <button className="btn btn-primary"
                onClick={handleBulkSubmit}
                disabled={bulkPickupMut.isPending}>
                {bulkPickupMut.isPending ? 'Applying…' : `Apply to ${selectedIds.size} PO${selectedIds.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Attachment Lightbox */}
      {attachmentPreview && (
        <div className="modal-overlay" onClick={() => setAttachmentPreview(null)} style={{ background: 'rgba(0,0,0,0.85)' }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: '92vw', maxHeight: '92vh' }}>
            <img src={attachmentPreview.url} alt={attachmentPreview.filename || ''}
              style={{ maxWidth: '92vw', maxHeight: '88vh', display: 'block' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, color: '#fff', fontSize: 13 }}>
              <span>{attachmentPreview.filename}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <a href={attachmentPreview.url} target="_blank" rel="noreferrer" style={{ color: '#fff' }}>Open in new tab</a>
                <button className="btn btn-sm" onClick={() => setAttachmentPreview(null)}>Close</button>
              </div>
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
