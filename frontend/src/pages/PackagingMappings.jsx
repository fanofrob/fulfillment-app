import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { packagingMappingsApi, picklistSkusApi, boxTypesApi } from '../api'

/**
 * Two flavors of packaging consumption rules:
 *   - Per-product: "1lb_clamshell ships with every cherry-01x01"
 *   - Per-box: "2 shipping_labels per shipment"
 * The Box Type's own pick_sku still tracks 1 box per shipment.
 */
export default function PackagingMappings() {
  const [tab, setTab] = useState('product')
  return (
    <div>
      <div className="page-header">
        <h1>Packaging Mappings</h1>
        <p>
          Configure how packaging is consumed when orders ship. <strong>Per-product</strong> rules
          deduct based on units shipped; <strong>per-box</strong> rules deduct per shipment.
          The box itself (1 box per shipment) is set on each Box Type.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 16 }}>
        <TabButton active={tab === 'product'} onClick={() => setTab('product')}>
          Per-Product Mappings
        </TabButton>
        <TabButton active={tab === 'box'} onClick={() => setTab('box')}>
          Per-Box Mappings
        </TabButton>
      </div>

      {tab === 'product' && <ProductMappingsTab />}
      {tab === 'box' && <BoxMappingsTab />}
    </div>
  )
}

function TabButton({ active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 16px',
        border: 'none',
        borderBottom: `2px solid ${active ? '#1e40af' : 'transparent'}`,
        background: 'transparent',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        color: active ? '#1e40af' : '#6b7280',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function ProductMappingsTab() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState(null)

  const { data: mappingsData = { items: [] }, isLoading } = useQuery({
    queryKey: ['packaging-mappings'],
    queryFn: () => packagingMappingsApi.list({}),
  })

  // Pull product + packaging SKUs once for the dropdowns. Two queries so the
  // type filter happens in SQL (small payloads) instead of client-side.
  const { data: productSkus = { items: [] } } = useQuery({
    queryKey: ['picklist-skus', 'product', 'all'],
    queryFn: () => picklistSkusApi.list({ inventory_type: 'product', limit: 2000 }),
  })

  const { data: packagingSkus = { items: [] } } = useQuery({
    queryKey: ['picklist-skus', 'packaging', 'all'],
    queryFn: () => picklistSkusApi.list({ inventory_type: 'packaging', limit: 2000 }),
  })

  const filtered = useMemo(() => {
    const items = mappingsData.items || []
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter(m =>
      m.product_pick_sku.toLowerCase().includes(q) ||
      m.packaging_pick_sku.toLowerCase().includes(q) ||
      (m.product_description || '').toLowerCase().includes(q) ||
      (m.packaging_description || '').toLowerCase().includes(q)
    )
  }, [mappingsData.items, search])

  const updateMut = useMutation({
    mutationFn: ({ id, payload }) => packagingMappingsApi.update(id, payload),
    onSuccess: () => qc.invalidateQueries(['packaging-mappings']),
  })

  const deleteMut = useMutation({
    mutationFn: (id) => packagingMappingsApi.delete(id),
    onSuccess: () => qc.invalidateQueries(['packaging-mappings']),
  })

  const noPackagingSkus = packagingSkus.items.length === 0

  return (
    <div>
      <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0, marginBottom: 16 }}>
        When a product ships, the linked packaging SKUs are deducted from inventory at <em>qty_per_unit × shipped_units</em>.
      </p>

      {noPackagingSkus && (
        <div className="warning-banner">
          You don't have any packaging SKUs yet. Go to <strong>Picklist SKUs</strong>, click{' '}
          <strong>+ New SKU</strong>, and set Inventory Type to <em>Packaging</em>.
        </div>
      )}

      <div className="toolbar">
        <input
          placeholder="Search by product or packaging SKU…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <button
          className="btn btn-primary"
          onClick={() => setShowCreate(true)}
          disabled={noPackagingSkus || productSkus.items.length === 0}
        >
          + Add Mapping
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {filtered.length} mapping{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      {isLoading && <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>}

      {!isLoading && filtered.length === 0 && !noPackagingSkus && (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          {search ? 'No mappings match that search.' : 'No mappings yet. Click + Add Mapping to create one.'}
        </div>
      )}

      {filtered.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Product SKU</th>
                <th style={{ minWidth: 200 }}>Product Description</th>
                <th style={{ minWidth: 180 }}>Packaging SKU</th>
                <th style={{ minWidth: 200 }}>Packaging Description</th>
                <th style={{ width: 110, textAlign: 'right' }} title="Units of packaging consumed per unit of product">Qty / Unit</th>
                <th style={{ minWidth: 160 }}>Notes</th>
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(m => (
                <MappingRow
                  key={m.id}
                  m={m}
                  isEditing={editingId === m.id}
                  onEdit={() => setEditingId(m.id)}
                  onCancel={() => setEditingId(null)}
                  onSave={(payload) => {
                    updateMut.mutate({ id: m.id, payload }, {
                      onSuccess: () => setEditingId(null),
                    })
                  }}
                  onDelete={() => {
                    if (confirm(`Delete mapping ${m.product_pick_sku} → ${m.packaging_pick_sku}?`)) {
                      deleteMut.mutate(m.id)
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateMappingModal
          productSkus={productSkus.items}
          packagingSkus={packagingSkus.items}
          onClose={() => setShowCreate(false)}
          onCreated={() => qc.invalidateQueries(['packaging-mappings'])}
        />
      )}
    </div>
  )
}

function MappingRow({ m, isEditing, onEdit, onCancel, onSave, onDelete }) {
  const [draft, setDraft] = useState({ qty_per_unit: m.qty_per_unit, notes: m.notes || '' })

  function startEdit() {
    setDraft({ qty_per_unit: m.qty_per_unit, notes: m.notes || '' })
    onEdit()
  }

  function save() {
    const qty = Number(draft.qty_per_unit)
    if (!qty || qty <= 0) {
      alert('Qty per unit must be greater than 0')
      return
    }
    onSave({ qty_per_unit: qty, notes: draft.notes || null })
  }

  if (isEditing) {
    return (
      <tr style={{ background: '#fefce8' }}>
        <td className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{m.product_pick_sku}</td>
        <td style={{ fontSize: 13, color: '#6b7280' }}>{m.product_description || '—'}</td>
        <td className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{m.packaging_pick_sku}</td>
        <td style={{ fontSize: 13, color: '#6b7280' }}>{m.packaging_description || '—'}</td>
        <td>
          <input
            type="number"
            step="any"
            min="0.001"
            value={draft.qty_per_unit}
            onChange={e => setDraft({ ...draft, qty_per_unit: e.target.value })}
            style={{ width: 80, fontSize: 12, textAlign: 'right' }}
          />
        </td>
        <td>
          <input
            value={draft.notes}
            onChange={e => setDraft({ ...draft, notes: e.target.value })}
            style={{ width: '100%', fontSize: 12 }}
          />
        </td>
        <td>
          <button className="btn btn-primary" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }} onClick={save}>Save</button>
          <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onCancel}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td className="mono" style={{ fontSize: 13, fontWeight: 600, color: '#16a34a' }}>{m.product_pick_sku}</td>
      <td style={{ fontSize: 13, color: '#6b7280' }}>{m.product_description || <span style={{ color: '#d1d5db' }}>—</span>}</td>
      <td className="mono" style={{ fontSize: 13, fontWeight: 600, color: '#92400e' }}>{m.packaging_pick_sku}</td>
      <td style={{ fontSize: 13, color: '#6b7280' }}>{m.packaging_description || <span style={{ color: '#d1d5db' }}>—</span>}</td>
      <td style={{ textAlign: 'right', fontSize: 13, fontWeight: 600 }}>{m.qty_per_unit}</td>
      <td style={{ fontSize: 13, color: '#6b7280' }}>{m.notes || <span style={{ color: '#d1d5db' }}>—</span>}</td>
      <td>
        <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }} onClick={startEdit}>Edit</button>
        <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px', color: '#dc2626' }} onClick={onDelete}>Delete</button>
      </td>
    </tr>
  )
}

function CreateMappingModal({ productSkus, packagingSkus, onClose, onCreated }) {
  const [form, setForm] = useState({
    product_pick_sku: '',
    packaging_pick_sku: '',
    qty_per_unit: 1,
    notes: '',
  })

  const createMut = useMutation({
    mutationFn: packagingMappingsApi.create,
    onSuccess: () => {
      onCreated?.()
      onClose()
    },
  })

  function submit(e) {
    e.preventDefault()
    if (!form.product_pick_sku || !form.packaging_pick_sku) return
    const qty = Number(form.qty_per_unit)
    if (!qty || qty <= 0) {
      alert('Qty per unit must be greater than 0')
      return
    }
    createMut.mutate({
      product_pick_sku: form.product_pick_sku,
      packaging_pick_sku: form.packaging_pick_sku,
      qty_per_unit: qty,
      notes: form.notes || null,
    })
  }

  const errMsg = createMut.error?.response?.data?.detail || createMut.error?.message

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit}
        style={{ background: 'white', borderRadius: 8, padding: 24, minWidth: 540, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <h2 style={{ marginTop: 0, marginBottom: 6 }}>Add Packaging Mapping</h2>
        <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: '#6b7280' }}>
          Define how much packaging is consumed per unit of a product.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, fontSize: 13, alignItems: 'center' }}>
          <label>Product SKU *</label>
          <select value={form.product_pick_sku} onChange={e => setForm({ ...form, product_pick_sku: e.target.value })} required>
            <option value="">— Pick a product —</option>
            {productSkus.map(p => (
              <option key={p.pick_sku} value={p.pick_sku}>
                {p.pick_sku}{p.customer_description ? ` — ${p.customer_description}` : ''}
              </option>
            ))}
          </select>

          <label>Packaging SKU *</label>
          <select value={form.packaging_pick_sku} onChange={e => setForm({ ...form, packaging_pick_sku: e.target.value })} required>
            <option value="">— Pick packaging —</option>
            {packagingSkus.map(p => (
              <option key={p.pick_sku} value={p.pick_sku}>
                {p.pick_sku}{p.customer_description ? ` — ${p.customer_description}` : ''}
              </option>
            ))}
          </select>

          <label title="Units of packaging consumed per unit of product">Qty per unit *</label>
          <input
            type="number"
            step="any"
            min="0.001"
            value={form.qty_per_unit}
            onChange={e => setForm({ ...form, qty_per_unit: e.target.value })}
            required
          />

          <label>Notes</label>
          <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>

        <div style={{ marginTop: 12, padding: 10, fontSize: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, color: '#1e40af' }}>
          Example: <code>cherry-01x01 → 1lb_clamshell @ 1.0</code> means each cherry-01x01 unit shipped consumes one 1lb_clamshell.
        </div>

        {errMsg && (
          <div style={{ marginTop: 12, padding: 8, fontSize: 12, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4 }}>
            {errMsg}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={createMut.isPending || !form.product_pick_sku || !form.packaging_pick_sku}
          >
            {createMut.isPending ? 'Creating…' : 'Create Mapping'}
          </button>
        </div>
      </form>
    </div>
  )
}


// ── Per-box mappings (e.g. shipping_label @ 2 per box) ──────────────────────

function BoxMappingsTab() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState(null)

  const { data: mappingsData = { items: [] }, isLoading } = useQuery({
    queryKey: ['box-packaging-mappings'],
    queryFn: () => packagingMappingsApi.listBox({}),
  })

  const { data: boxTypes = [] } = useQuery({
    queryKey: ['box-types'],
    queryFn: () => boxTypesApi.list(),
  })

  const { data: packagingSkus = { items: [] } } = useQuery({
    queryKey: ['picklist-skus', 'packaging', 'all'],
    queryFn: () => picklistSkusApi.list({ inventory_type: 'packaging', limit: 2000 }),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, payload }) => packagingMappingsApi.updateBox(id, payload),
    onSuccess: () => qc.invalidateQueries(['box-packaging-mappings']),
  })

  const deleteMut = useMutation({
    mutationFn: (id) => packagingMappingsApi.deleteBox(id),
    onSuccess: () => qc.invalidateQueries(['box-packaging-mappings']),
  })

  const items = mappingsData.items || []
  const noPackagingSkus = packagingSkus.items.length === 0
  const noBoxTypes = boxTypes.length === 0

  return (
    <div>
      <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0, marginBottom: 16 }}>
        When a box of a given type ships, deduct <em>qty_per_box</em> of the linked packaging SKU.
        Use this for shipping labels, tape, void fill, thank-you cards — anything consumed at the
        shipment level, not per fruit unit.
      </p>

      {(noPackagingSkus || noBoxTypes) && (
        <div className="warning-banner">
          {noPackagingSkus && <>You don't have any packaging SKUs yet — go to <strong>Picklist SKUs</strong> first.</>}
          {noBoxTypes && <>No box types defined.</>}
        </div>
      )}

      <div className="toolbar">
        <button
          className="btn btn-primary"
          onClick={() => setShowCreate(true)}
          disabled={noPackagingSkus || noBoxTypes}
        >
          + Add Box Mapping
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {items.length} mapping{items.length === 1 ? '' : 's'}
        </span>
      </div>

      {isLoading && <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>}

      {!isLoading && items.length === 0 && !(noPackagingSkus || noBoxTypes) && (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          No box mappings yet. Click + Add Box Mapping to create one.
        </div>
      )}

      {items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 800 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Box Type</th>
                <th style={{ minWidth: 180 }}>Packaging SKU</th>
                <th style={{ minWidth: 200 }}>Packaging Description</th>
                <th style={{ width: 110, textAlign: 'right' }} title="Units of packaging consumed per shipment of this box type">Qty / Box</th>
                <th style={{ minWidth: 160 }}>Notes</th>
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(m => (
                <BoxMappingRow
                  key={m.id}
                  m={m}
                  isEditing={editingId === m.id}
                  onEdit={() => setEditingId(m.id)}
                  onCancel={() => setEditingId(null)}
                  onSave={(payload) => updateMut.mutate({ id: m.id, payload }, {
                    onSuccess: () => setEditingId(null),
                  })}
                  onDelete={() => {
                    if (confirm(`Delete mapping ${m.box_type_name} → ${m.packaging_pick_sku}?`)) {
                      deleteMut.mutate(m.id)
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateBoxMappingModal
          boxTypes={boxTypes}
          packagingSkus={packagingSkus.items}
          onClose={() => setShowCreate(false)}
          onCreated={() => qc.invalidateQueries(['box-packaging-mappings'])}
        />
      )}
    </div>
  )
}

function BoxMappingRow({ m, isEditing, onEdit, onCancel, onSave, onDelete }) {
  const [draft, setDraft] = useState({ qty_per_box: m.qty_per_box, notes: m.notes || '' })

  function startEdit() {
    setDraft({ qty_per_box: m.qty_per_box, notes: m.notes || '' })
    onEdit()
  }

  function save() {
    const qty = Number(draft.qty_per_box)
    if (!qty || qty <= 0) {
      alert('Qty per box must be greater than 0')
      return
    }
    onSave({ qty_per_box: qty, notes: draft.notes || null })
  }

  if (isEditing) {
    return (
      <tr style={{ background: '#fefce8' }}>
        <td className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{m.box_type_name}</td>
        <td className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{m.packaging_pick_sku}</td>
        <td style={{ fontSize: 13, color: '#6b7280' }}>{m.packaging_description || '—'}</td>
        <td>
          <input
            type="number" step="any" min="0.001"
            value={draft.qty_per_box}
            onChange={e => setDraft({ ...draft, qty_per_box: e.target.value })}
            style={{ width: 80, fontSize: 12, textAlign: 'right' }}
          />
        </td>
        <td>
          <input value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })}
            style={{ width: '100%', fontSize: 12 }} />
        </td>
        <td>
          <button className="btn btn-primary" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }} onClick={save}>Save</button>
          <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onCancel}>Cancel</button>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td className="mono" style={{ fontSize: 13, fontWeight: 600, color: '#1e40af' }}>{m.box_type_name}</td>
      <td className="mono" style={{ fontSize: 13, fontWeight: 600, color: '#92400e' }}>{m.packaging_pick_sku}</td>
      <td style={{ fontSize: 13, color: '#6b7280' }}>{m.packaging_description || <span style={{ color: '#d1d5db' }}>—</span>}</td>
      <td style={{ textAlign: 'right', fontSize: 13, fontWeight: 600 }}>{m.qty_per_box}</td>
      <td style={{ fontSize: 13, color: '#6b7280' }}>{m.notes || <span style={{ color: '#d1d5db' }}>—</span>}</td>
      <td>
        <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }} onClick={startEdit}>Edit</button>
        <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px', color: '#dc2626' }} onClick={onDelete}>Delete</button>
      </td>
    </tr>
  )
}

function CreateBoxMappingModal({ boxTypes, packagingSkus, onClose, onCreated }) {
  const [form, setForm] = useState({
    box_type_id: '',
    packaging_pick_sku: '',
    qty_per_box: 1,
    notes: '',
  })

  const createMut = useMutation({
    mutationFn: packagingMappingsApi.createBox,
    onSuccess: () => {
      onCreated?.()
      onClose()
    },
  })

  function submit(e) {
    e.preventDefault()
    if (!form.box_type_id || !form.packaging_pick_sku) return
    const qty = Number(form.qty_per_box)
    if (!qty || qty <= 0) {
      alert('Qty per box must be greater than 0')
      return
    }
    createMut.mutate({
      box_type_id: Number(form.box_type_id),
      packaging_pick_sku: form.packaging_pick_sku,
      qty_per_box: qty,
      notes: form.notes || null,
    })
  }

  const errMsg = createMut.error?.response?.data?.detail || createMut.error?.message

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit}
        style={{ background: 'white', borderRadius: 8, padding: 24, minWidth: 540, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <h2 style={{ marginTop: 0, marginBottom: 6 }}>Add Box Packaging Mapping</h2>
        <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: '#6b7280' }}>
          Define how much packaging is consumed per shipment of this box type.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, fontSize: 13, alignItems: 'center' }}>
          <label>Box Type *</label>
          <select value={form.box_type_id} onChange={e => setForm({ ...form, box_type_id: e.target.value })} required>
            <option value="">— Pick a box type —</option>
            {boxTypes.map(bt => (
              <option key={bt.id} value={bt.id}>{bt.name}</option>
            ))}
          </select>

          <label>Packaging SKU *</label>
          <select value={form.packaging_pick_sku} onChange={e => setForm({ ...form, packaging_pick_sku: e.target.value })} required>
            <option value="">— Pick packaging —</option>
            {packagingSkus.map(p => (
              <option key={p.pick_sku} value={p.pick_sku}>
                {p.pick_sku}{p.customer_description ? ` — ${p.customer_description}` : ''}
              </option>
            ))}
          </select>

          <label title="Units of packaging consumed per shipment">Qty per box *</label>
          <input
            type="number" step="any" min="0.001"
            value={form.qty_per_box}
            onChange={e => setForm({ ...form, qty_per_box: e.target.value })}
            required
          />

          <label>Notes</label>
          <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>

        <div style={{ marginTop: 12, padding: 10, fontSize: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, color: '#1e40af' }}>
          Example: <code>8x8x8 → shipping_label @ 2.0</code> means every 8x8x8 box that ships consumes 2 shipping labels.
          Use fractional values (e.g. <code>0.05</code>) for rolls of tape.
        </div>

        {errMsg && (
          <div style={{ marginTop: 12, padding: 8, fontSize: 12, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4 }}>
            {errMsg}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary"
            disabled={createMut.isPending || !form.box_type_id || !form.packaging_pick_sku}>
            {createMut.isPending ? 'Creating…' : 'Create Mapping'}
          </button>
        </div>
      </form>
    </div>
  )
}
