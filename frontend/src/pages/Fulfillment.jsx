import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ordersApi, fulfillmentApi, boxTypesApi } from '../api'

// ── Status config ─────────────────────────────────────────────────────────────

const PLAN_STATUS = {
  draft:                  { label: 'Draft',                  cls: 'badge-not-processed' },
  active:                 { label: 'Active',                 cls: 'badge-fulfilled' },
  needs_review:           { label: 'Needs Review',           cls: 'badge-ss-pending' },
  needs_reconfiguration:  { label: 'Needs Reconfiguration',  cls: 'badge-partial' },
  completed:              { label: 'Completed',              cls: 'badge-fulfilled' },
  cancelled:              { label: 'Cancelled',              cls: 'badge-not-processed' },
}

const BOX_STATUS = {
  pending:   { label: 'Pending',        cls: 'badge-not-processed' },
  packed:    { label: 'In ShipStation', cls: 'badge-ss-pending' },
  shipped:   { label: 'Shipped',        cls: 'badge-ss-shipped' },
  cancelled: { label: 'Cancelled',      cls: 'badge-partial' },
}

function PlanBadge({ status }) {
  const cfg = PLAN_STATUS[status] || { label: status, cls: 'badge-not-processed' }
  return <span className={`badge ${cfg.cls}`} style={{ fontSize: 11 }}>{cfg.label}</span>
}

function BoxBadge({ status }) {
  const cfg = BOX_STATUS[status] || { label: status, cls: 'badge-not-processed' }
  return <span className={`badge ${cfg.cls}`} style={{ fontSize: 11 }}>{cfg.label}</span>
}

// ── Change diff display ───────────────────────────────────────────────────────

function ChangeDiff({ oldItems, newItems }) {
  const allSkus = new Set([...Object.keys(oldItems), ...Object.keys(newItems)])
  const rows = []
  for (const sku of allSkus) {
    const oldQty = oldItems[sku] ?? 0
    const newQty = newItems[sku] ?? 0
    if (oldQty === newQty) continue
    rows.push({ sku, oldQty, newQty })
  }
  if (!rows.length) return <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>No quantity changes detected.</p>
  return (
    <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ textAlign: 'left', color: '#6b7280' }}>
          <th style={{ padding: '3px 8px 3px 0' }}>Pick SKU</th>
          <th style={{ padding: '3px 8px' }}>Current Plan</th>
          <th style={{ padding: '3px 8px' }}>Shopify Now</th>
          <th style={{ padding: '3px 8px' }}>Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ sku, oldQty, newQty }) => {
          const delta = newQty - oldQty
          return (
            <tr key={sku}>
              <td style={{ padding: '3px 8px 3px 0', fontFamily: 'monospace' }}>{sku}</td>
              <td style={{ padding: '3px 8px' }}>{oldQty}</td>
              <td style={{ padding: '3px 8px' }}>{newQty}</td>
              <td style={{ padding: '3px 8px', color: delta > 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                {delta > 0 ? `+${delta}` : delta}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── Box item editor ───────────────────────────────────────────────────────────

function BoxCard({ plan, box, orderLineItems, boxTypes = [], onRefresh }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draftItems, setDraftItems] = useState([])
  const [addSku, setAddSku] = useState('')
  const [addQty, setAddQty] = useState('')

  // Available SKUs from the order (for the add-item dropdown)
  const skuOptions = useMemo(() => {
    const seen = new Set()
    return orderLineItems
      .filter(li => li.sku_mapped && li.pick_sku)
      .filter(li => { if (seen.has(li.pick_sku)) return false; seen.add(li.pick_sku); return true })
  }, [orderLineItems])

  function startEditing() {
    setDraftItems(box.items.map(i => ({ ...i })))
    setEditing(true)
  }

  function cancelEditing() {
    setEditing(false)
    setDraftItems([])
    setAddSku('')
    setAddQty('')
  }

  const saveItemsMut = useMutation({
    mutationFn: (items) => fulfillmentApi.setBoxItems(plan.id, box.id, { items }),
    onSuccess: () => { qc.invalidateQueries(['plan', plan.shopify_order_id]); setEditing(false) },
  })

  const pushBoxMut = useMutation({
    mutationFn: () => fulfillmentApi.pushBox(plan.id, box.id),
    onSuccess: () => { qc.invalidateQueries(['plan', plan.shopify_order_id]); onRefresh?.() },
  })

  const deleteBoxMut = useMutation({
    mutationFn: () => fulfillmentApi.deleteBox(plan.id, box.id),
    onSuccess: () => qc.invalidateQueries(['plan', plan.shopify_order_id]),
  })

  const updateBoxMut = useMutation({
    mutationFn: (data) => fulfillmentApi.updateBox(plan.id, box.id, data),
    onSuccess: () => qc.invalidateQueries(['plan', plan.shopify_order_id]),
  })

  function updateDraftQty(idx, val) {
    setDraftItems(items => items.map((it, i) => i === idx ? { ...it, quantity: val } : it))
  }

  function removeDraftItem(idx) {
    setDraftItems(items => items.filter((_, i) => i !== idx))
  }

  function addDraftItem() {
    if (!addSku || !addQty) return
    const matches = orderLineItems.filter(li => li.pick_sku === addSku)
    const meta = matches[0]
    setDraftItems(items => [
      ...items,
      {
        pick_sku: addSku,
        quantity: parseFloat(addQty),
        shopify_sku: meta?.shopify_sku || null,
        product_title: meta?.product_title || null,
        // When multiple line items share this pick_sku, leave shopify_line_item_id null
        // so the backend splits the quantity proportionally across all matching line items.
        shopify_line_item_id: matches.length === 1 ? (meta?.line_item_id || null) : null,
      },
    ])
    setAddSku('')
    setAddQty('')
  }

  function saveItems() {
    const cleaned = draftItems
      .filter(it => it.pick_sku && parseFloat(it.quantity) > 0)
      .map(it => ({ ...it, quantity: parseFloat(it.quantity) }))
    saveItemsMut.mutate(cleaned)
  }

  const isPacked  = box.status === 'packed'
  const isShipped = box.status === 'shipped'
  const canEdit   = !isShipped

  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 12,
      background: isShipped ? '#f0fdf4' : '#fff',
    }}>
      {/* Box header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', borderBottom: '1px solid #e5e7eb',
        background: '#f9fafb', borderRadius: '8px 8px 0 0',
      }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Box {box.box_number}</span>
        <BoxBadge status={box.status} />
        {box.shipstation_order_id && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>SS: {box.shipstation_order_id}</span>
        )}
        {box.tracking_number && (
          <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 500 }}>
            Tracking: {box.tracking_number}
          </span>
        )}
        {box.estimated_delivery_date && (
          <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 500 }}>
            Est. Delivery: {new Date(box.estimated_delivery_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        )}
        {boxTypes.length > 0 && !isShipped && (
          <select
            value={box.box_type_id ?? ''}
            onChange={e => updateBoxMut.mutate({ box_type_id: e.target.value ? parseInt(e.target.value) : null })}
            disabled={updateBoxMut.isPending}
            style={{ fontSize: 12, padding: '2px 6px', border: '1px solid #d1d5db', borderRadius: 5, background: '#fff', color: '#374151' }}
          >
            <option value="">Box type…</option>
            {boxTypes.map(bt => (
              <option key={bt.id} value={bt.id}>{bt.name}</option>
            ))}
          </select>
        )}
        {isShipped && box.box_type_id && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            {boxTypes.find(bt => bt.id === box.box_type_id)?.name || ''}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {!editing && canEdit && (
          <button className="btn btn-sm" onClick={startEditing} style={{ fontSize: 12 }}>Edit Items</button>
        )}
        {!isPacked && !isShipped && !editing && (
          <button
            className="btn btn-sm btn-primary"
            onClick={() => pushBoxMut.mutate()}
            disabled={pushBoxMut.isPending || box.items.length === 0}
            style={{ fontSize: 12 }}
          >
            {pushBoxMut.isPending ? 'Pushing…' : 'Push to ShipStation'}
          </button>
        )}
        {!isShipped && !editing && (
          <button
            className="btn btn-sm btn-danger"
            onClick={() => { if (confirm(`Delete Box ${box.box_number}?`)) deleteBoxMut.mutate() }}
            disabled={deleteBoxMut.isPending}
            style={{ fontSize: 12 }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Items */}
      <div style={{ padding: '10px 14px' }}>
        {!editing ? (
          box.items.length === 0 ? (
            <p style={{ margin: 0, color: '#9ca3af', fontSize: 13 }}>No items assigned. Click Edit Items to add.</p>
          ) : (
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: '#6b7280', textAlign: 'left' }}>
                  <th style={{ padding: '2px 8px 4px 0' }}>Pick SKU</th>
                  <th style={{ padding: '2px 8px 4px' }}>Product</th>
                  <th style={{ padding: '2px 8px 4px', textAlign: 'right' }}>Qty</th>
                </tr>
              </thead>
              <tbody>
                {box.items.map(item => (
                  <tr key={item.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '4px 8px 4px 0', fontFamily: 'monospace', fontSize: 12 }}>{item.pick_sku}</td>
                    <td style={{ padding: '4px 8px', color: '#374151' }}>{item.product_title || '—'}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>{item.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <div>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', marginBottom: 8 }}>
              <thead>
                <tr style={{ color: '#6b7280', textAlign: 'left' }}>
                  <th style={{ padding: '2px 8px 4px 0' }}>Pick SKU</th>
                  <th style={{ padding: '2px 8px 4px' }}>Product</th>
                  <th style={{ padding: '2px 8px 4px', width: 80, textAlign: 'right' }}>Qty</th>
                  <th style={{ padding: '2px 0 4px 8px', width: 32 }}></th>
                </tr>
              </thead>
              <tbody>
                {draftItems.map((item, idx) => (
                  <tr key={idx} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '4px 8px 4px 0', fontFamily: 'monospace', fontSize: 12 }}>{item.pick_sku}</td>
                    <td style={{ padding: '4px 8px', color: '#374151' }}>{item.product_title || '—'}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.quantity}
                        onChange={e => updateDraftQty(idx, e.target.value)}
                        style={{ width: 72, textAlign: 'right', padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
                      />
                    </td>
                    <td style={{ padding: '4px 0 4px 8px' }}>
                      <button onClick={() => removeDraftItem(idx)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14, padding: 0 }}>✕</button>
                    </td>
                  </tr>
                ))}
                {/* Add item row */}
                <tr style={{ borderTop: '1px solid #e5e7eb', background: '#fafafa' }}>
                  <td colSpan={2} style={{ padding: '6px 8px 6px 0' }}>
                    <select
                      value={addSku}
                      onChange={e => setAddSku(e.target.value)}
                      style={{ width: '100%', padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                    >
                      <option value="">— select pick SKU —</option>
                      {skuOptions.map(li => (
                        <option key={li.pick_sku} value={li.pick_sku}>
                          {li.pick_sku}{li.product_title ? ` — ${li.product_title}` : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Qty"
                      value={addQty}
                      onChange={e => setAddQty(e.target.value)}
                      style={{ width: 72, textAlign: 'right', padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13 }}
                    />
                  </td>
                  <td style={{ padding: '6px 0 6px 8px' }}>
                    <button onClick={addDraftItem} style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', padding: '2px 8px', fontSize: 13 }}>+</button>
                  </td>
                </tr>
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={saveItems}
                disabled={saveItemsMut.isPending}
                style={{ fontSize: 12 }}
              >
                {saveItemsMut.isPending ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn-sm" onClick={cancelEditing} style={{ fontSize: 12 }}>Cancel</button>
            </div>
            {saveItemsMut.isError && (
              <p style={{ color: '#dc2626', margin: '6px 0 0', fontSize: 12 }}>
                {saveItemsMut.error?.response?.data?.detail || 'Save failed'}
              </p>
            )}
          </div>
        )}
        {pushBoxMut.isError && (
          <p style={{ color: '#dc2626', margin: '6px 0 0', fontSize: 12 }}>
            {pushBoxMut.error?.response?.data?.detail || 'Push failed'}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Plan editor (right panel) ─────────────────────────────────────────────────

function PlanEditor({ order }) {
  const qc = useQueryClient()

  const { data: plans, isLoading } = useQuery({
    queryKey: ['plan', order.shopify_order_id],
    queryFn: () => fulfillmentApi.listPlans({ shopify_order_id: order.shopify_order_id }),
  })

  const { data: orderDetail } = useQuery({
    queryKey: ['order-detail', order.shopify_order_id],
    queryFn: () => ordersApi.get(order.shopify_order_id),
  })

  const orderLineItems = orderDetail?.line_items || []
  const plan = plans?.[0] || null

  const { data: boxTypes = [] } = useQuery({
    queryKey: ['box-types'],
    queryFn: () => boxTypesApi.list({ is_active: true }),
  })

  const createPlanMut = useMutation({
    mutationFn: () => fulfillmentApi.createPlan({ shopify_order_id: order.shopify_order_id }),
    onSuccess: () => qc.invalidateQueries(['plan', order.shopify_order_id]),
  })

  const updatePlanMut = useMutation({
    mutationFn: ({ id, data }) => fulfillmentApi.updatePlan(id, data),
    onSuccess: () => qc.invalidateQueries(['plan', order.shopify_order_id]),
  })

  const deletePlanMut = useMutation({
    mutationFn: (id) => fulfillmentApi.deletePlan(id),
    onSuccess: () => qc.invalidateQueries(['plan', order.shopify_order_id]),
  })

  const addBoxMut = useMutation({
    mutationFn: (planId) => fulfillmentApi.addBox(planId, {}),
    onSuccess: () => qc.invalidateQueries(['plan', order.shopify_order_id]),
  })

  const detectChangesMut = useMutation({
    mutationFn: () => fulfillmentApi.detectChanges(order.shopify_order_id),
    onSuccess: () => qc.invalidateQueries(['plan', order.shopify_order_id]),
  })

  const syncMut = useMutation({
    mutationFn: () => fulfillmentApi.sync(),
    onSuccess: () => qc.invalidateQueries(['plan', order.shopify_order_id]),
  })

  const approveChangeMut = useMutation({
    mutationFn: (id) => fulfillmentApi.approveChange(id),
    onSuccess: () => qc.invalidateQueries(['plan', order.shopify_order_id]),
  })

  const rejectChangeMut = useMutation({
    mutationFn: (id) => fulfillmentApi.rejectChange(id),
    onSuccess: () => qc.invalidateQueries(['plan', order.shopify_order_id]),
  })

  // Shopify line items summary for reference panel
  const shopifyItemsRef = useMemo(() => {
    const m = {}
    for (const li of orderLineItems) {
      if (!li.sku_mapped || !li.pick_sku) continue
      const qty = (li.fulfillable_quantity ?? li.quantity) * (li.mix_quantity || 1)
      m[li.pick_sku] = (m[li.pick_sku] || 0) + qty
    }
    return m
  }, [orderLineItems])

  // Assignment coverage: how much of each pick_sku is assigned across boxes
  const assignedItems = useMemo(() => {
    if (!plan) return {}
    const m = {}
    for (const box of plan.boxes || []) {
      for (const item of box.items || []) {
        m[item.pick_sku] = (m[item.pick_sku] || 0) + item.quantity
      }
    }
    return m
  }, [plan])

  if (isLoading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading…</div>

  return (
    <div style={{ padding: 20, height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      {/* Order header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 2px', fontSize: 18 }}>
          {order.shopify_order_number ? `Order ${order.shopify_order_number}` : `Order #${order.shopify_order_id}`}
        </h2>
        <div style={{ color: '#6b7280', fontSize: 13 }}>
          {order.customer_name || order.shipping_name || '—'}
          {order.shipping_city && ` · ${order.shipping_city}, ${order.shipping_province}`}
        </div>
      </div>

      {/* No plan yet */}
      {!plan && (
        <div style={{ border: '2px dashed #e5e7eb', borderRadius: 8, padding: 32, textAlign: 'center' }}>
          <p style={{ margin: '0 0 12px', color: '#6b7280', fontSize: 14 }}>
            No fulfillment plan for this order.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => createPlanMut.mutate()}
            disabled={createPlanMut.isPending}
          >
            {createPlanMut.isPending ? 'Creating…' : 'Create Fulfillment Plan'}
          </button>
          {createPlanMut.isError && (
            <p style={{ color: '#dc2626', marginTop: 8, fontSize: 13 }}>
              {createPlanMut.error?.response?.data?.detail || 'Failed to create plan'}
            </p>
          )}
        </div>
      )}

      {/* Plan exists */}
      {plan && (
        <>
          {/* Plan header toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <PlanBadge status={plan.status} />
            {(() => {
              const hasUnfulfilled = orderLineItems.some(li => (li.fulfillable_quantity ?? li.quantity) > 0)
              return (<>
                {plan.status === 'active' && (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => updatePlanMut.mutate({ id: plan.id, data: { status: 'completed' } })}
                    disabled={updatePlanMut.isPending || hasUnfulfilled}
                    title={hasUnfulfilled ? 'Order still has unfulfilled line items' : ''}
                    style={{ fontSize: 12 }}
                  >
                    Mark Completed
                  </button>
                )}
                {plan.status === 'completed' && hasUnfulfilled && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => updatePlanMut.mutate({ id: plan.id, data: { status: 'draft' } })}
                    disabled={updatePlanMut.isPending}
                    title="Plan is marked completed but order still has unfulfilled items"
                    style={{ fontSize: 12 }}
                  >
                    Reopen Plan
                  </button>
                )}
              </>)
            })()}
            <button
              className="btn btn-sm"
              onClick={() => detectChangesMut.mutate()}
              disabled={detectChangesMut.isPending}
              style={{ fontSize: 12 }}
            >
              {detectChangesMut.isPending ? 'Checking…' : 'Detect Changes'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => syncMut.mutate()}
              disabled={syncMut.isPending}
              style={{ fontSize: 12 }}
            >
              {syncMut.isPending ? 'Syncing…' : 'Sync ShipStation'}
            </button>
            <div style={{ flex: 1 }} />
            {plan.status === 'draft' && (
              <button
                className="btn btn-sm btn-danger"
                onClick={() => { if (confirm('Delete this plan?')) deletePlanMut.mutate(plan.id) }}
                disabled={deletePlanMut.isPending}
                style={{ fontSize: 12 }}
              >
                Delete Plan
              </button>
            )}
          </div>

          {/* Change event banners */}
          {(plan.pending_changes || []).map(change => (
            <div key={change.id} style={{
              background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 8,
              padding: 14, marginBottom: 14,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 13, color: '#92400e' }}>
                    ⚠ Line Item Change Detected — Review Required
                  </p>
                  <ChangeDiff oldItems={change.old_line_items} newItems={change.new_line_items} />
                  <p style={{ margin: '8px 0 0', fontSize: 12, color: '#78350f' }}>
                    Detected {new Date(change.detected_at).toLocaleString()}
                  </p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => approveChangeMut.mutate(change.id)}
                    disabled={approveChangeMut.isPending}
                    style={{ fontSize: 12 }}
                  >
                    {approveChangeMut.isPending ? '…' : 'Approve'}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => rejectChangeMut.mutate(change.id)}
                    disabled={rejectChangeMut.isPending}
                    style={{ fontSize: 12 }}
                  >
                    {rejectChangeMut.isPending ? '…' : 'Reject'}
                  </button>
                </div>
              </div>
            </div>
          ))}

          {/* Needs reconfiguration notice */}
          {plan.status === 'needs_reconfiguration' && (
            <div style={{
              background: '#eff6ff', border: '1px solid #3b82f6', borderRadius: 8,
              padding: 12, marginBottom: 14, fontSize: 13, color: '#1d4ed8',
            }}>
              Change approved — Box 1 has been reloaded with the updated line items. Reassign items across boxes as needed, then mark the plan Active.
            </div>
          )}

          {/* Shopify line items reference */}
          <div style={{ marginBottom: 16 }}>
            <p style={{ margin: '0 0 6px', fontWeight: 600, fontSize: 13, color: '#374151' }}>
              Shopify Line Items (reference)
            </p>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', background: '#f9fafb', borderRadius: 6, overflow: 'hidden' }}>
              <thead>
                <tr style={{ color: '#6b7280', textAlign: 'left', background: '#f3f4f6' }}>
                  <th style={{ padding: '5px 10px' }}>Pick SKU</th>
                  <th style={{ padding: '5px 10px' }}>Total Qty</th>
                  <th style={{ padding: '5px 10px', textAlign: 'right' }}>Assigned</th>
                  <th style={{ padding: '5px 10px', textAlign: 'right' }}>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(shopifyItemsRef).length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: '8px 10px', color: '#9ca3af' }}>
                      No mapped line items found. Pull the order from Shopify to refresh SKU mappings.
                    </td>
                  </tr>
                )}
                {Object.entries(shopifyItemsRef).map(([sku, qty]) => {
                  const assigned = assignedItems[sku] || 0
                  const remaining = qty - assigned
                  return (
                    <tr key={sku} style={{ borderTop: '1px solid #e5e7eb' }}>
                      <td style={{ padding: '5px 10px', fontFamily: 'monospace' }}>{sku}</td>
                      <td style={{ padding: '5px 10px' }}>{qty}</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right', color: assigned > 0 ? '#16a34a' : '#9ca3af' }}>{assigned}</td>
                      <td style={{
                        padding: '5px 10px', textAlign: 'right', fontWeight: 600,
                        color: remaining > 0 ? '#dc2626' : remaining < 0 ? '#9333ea' : '#16a34a',
                      }}>
                        {remaining > 0 ? remaining : remaining < 0 ? `+${Math.abs(remaining)} over` : '✓'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Boxes */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 13, color: '#374151' }}>
                Boxes ({(plan.boxes || []).length})
              </p>
              <div style={{ flex: 1 }} />
              <button
                className="btn btn-sm"
                onClick={() => addBoxMut.mutate(plan.id)}
                disabled={addBoxMut.isPending}
                style={{ fontSize: 12 }}
              >
                {addBoxMut.isPending ? 'Adding…' : '+ Add Box'}
              </button>
            </div>
            {(plan.boxes || []).length === 0 && (
              <p style={{ color: '#9ca3af', fontSize: 13 }}>No boxes yet. Click "+ Add Box" to create one.</p>
            )}
            {(plan.boxes || []).map(box => (
              <BoxCard
                key={box.id}
                plan={plan}
                box={box}
                orderLineItems={orderLineItems}
                boxTypes={boxTypes}
                onRefresh={() => qc.invalidateQueries(['plan', order.shopify_order_id])}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Main Fulfillment page ─────────────────────────────────────────────────────

export default function Fulfillment() {
  const [search, setSearch] = useState('')
  const [planFilter, setPlanFilter] = useState('all')
  const qc = useQueryClient()

  // Fetch all orders + all plans
  const { data: ordersData } = useQuery({
    queryKey: ['orders-fulfillment'],
    queryFn: () => ordersApi.list({ limit: 500 }),
  })

  const { data: allPlans } = useQuery({
    queryKey: ['all-plans'],
    queryFn: () => fulfillmentApi.listPlans(),
    refetchInterval: 30000,
  })

  const orders = Array.isArray(ordersData) ? ordersData : (ordersData?.orders || [])

  // Build plan-by-order lookup
  const planByOrder = useMemo(() => {
    const m = {}
    for (const p of allPlans || []) {
      m[p.shopify_order_id] = p
    }
    return m
  }, [allPlans])

  const bulkResetMut = useMutation({
    mutationFn: () => fulfillmentApi.bulkResetUnpushed(),
    onSuccess: () => qc.invalidateQueries(['all-plans']),
  })

  // Total unpushed boxes across all plans
  const totalUnpushed = useMemo(
    () => (allPlans || []).reduce((sum, p) => sum + (p.boxes || []).filter(b => b.status === 'pending').length, 0),
    [allPlans]
  )

  // Pending changes count
  const pendingChangesCount = useMemo(
    () => (allPlans || []).filter(p => p.status === 'needs_review').length,
    [allPlans]
  )

  const filteredOrders = useMemo(() => {
    let list = orders
    if (search) {
      const s = search.toLowerCase()
      list = list.filter(o =>
        (o.shopify_order_number || '').toLowerCase().includes(s) ||
        (o.customer_name || '').toLowerCase().includes(s) ||
        (o.shipping_name || '').toLowerCase().includes(s)
      )
    }
    if (planFilter === 'no_plan') list = list.filter(o => !planByOrder[o.shopify_order_id])
    else if (planFilter === 'has_plan') list = list.filter(o => planByOrder[o.shopify_order_id])
    else if (planFilter === 'needs_review') list = list.filter(o => planByOrder[o.shopify_order_id]?.status === 'needs_review')
    return list
  }, [orders, search, planFilter, planByOrder])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Fulfillment</h1>
          {pendingChangesCount > 0 && (
            <span style={{
              marginLeft: 8, background: '#f59e0b', color: '#fff',
              borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 600,
            }}>
              {pendingChangesCount} changes
            </span>
          )}
          <div style={{ flex: 1 }} />
          {totalUnpushed > 0 && (
            <button
              className="btn btn-sm btn-danger"
              style={{ fontSize: 11 }}
              disabled={bulkResetMut.isPending}
              onClick={() => {
                if (confirm(`Reset all ${totalUnpushed} unpushed box${totalUnpushed !== 1 ? 'es' : ''} across all plans? This cannot be undone.`)) {
                  bulkResetMut.mutate()
                }
              }}
            >
              {bulkResetMut.isPending ? 'Resetting…' : `Reset ${totalUnpushed} unpushed`}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="Search orders…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1, padding: '6px 10px', border: '1px solid #d1d5db',
              borderRadius: 6, fontSize: 13, boxSizing: 'border-box',
            }}
          />
          <select
            value={planFilter}
            onChange={e => setPlanFilter(e.target.value)}
            style={{
              padding: '5px 8px', border: '1px solid #d1d5db',
              borderRadius: 6, fontSize: 12, color: '#374151',
            }}
          >
            <option value="all">All Orders</option>
            <option value="no_plan">No Plan</option>
            <option value="has_plan">Has Plan</option>
            <option value="needs_review">Needs Review</option>
          </select>
        </div>
      </div>

      {/* Order list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filteredOrders.length === 0 && (
          <p style={{ padding: 16, color: '#9ca3af', fontSize: 13 }}>No orders found.</p>
        )}
        {filteredOrders.map(order => {
          const plan = planByOrder[order.shopify_order_id]
          return (
            <div
              key={order.shopify_order_id}
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid #f3f4f6',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  {order.shopify_order_number || order.shopify_order_id}
                </span>
                {plan
                  ? <PlanBadge status={plan.status} />
                  : <span className="badge badge-not-processed" style={{ fontSize: 10 }}>No Plan</span>
                }
              </div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                {order.customer_name || order.shipping_name || '—'}
              </div>
              {plan && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  {(plan.boxes || []).length} box{(plan.boxes || []).length !== 1 ? 'es' : ''}
                  {' · '}
                  {(plan.boxes || []).filter(b => b.status === 'shipped').length} shipped
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
