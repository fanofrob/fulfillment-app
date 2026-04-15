import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { packageRulesApi, boxTypesApi, packagingMaterialsApi, boxTypePackagingApi } from '../api'
import { packagesByCarrier, findPackage, GENERIC_PACKAGES, catalogKey } from '../shipstationPackages'
import { servicesByCarrier, findService, serviceKey } from '../shipstationServices'

// ── Field / Operator definitions ──────────────────────────────────────────────

const FIELDS = [
  { value: 'pactor',          label: 'Pactor',          type: 'number' },
  { value: 'zone',            label: 'Zone',            type: 'number' },
  { value: 'weight',          label: 'Weight (lbs)',    type: 'number' },
  { value: 'tags',            label: 'Tags',            type: 'string' },
  { value: 'carrier_service', label: 'Carrier Service', type: 'service' },
]

const NUMERIC_OPS = [
  { value: 'is_empty',  label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
  { value: 'eq',        label: '= (equal to)' },
  { value: 'neq',       label: '≠ (not equal to)' },
  { value: 'lt',        label: '< (less than)' },
  { value: 'lte',       label: '≤ (less than or equal to)' },
  { value: 'gt',        label: '> (greater than)' },
  { value: 'gte',       label: '≥ (greater than or equal to)' },
  { value: 'between',   label: 'between' },
]

const STRING_OPS = [
  { value: 'is_empty',     label: 'is empty' },
  { value: 'not_empty',    label: 'is not empty' },
  { value: 'contains',     label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'is_exactly',   label: 'is exactly' },
]

const SERVICE_OPS = [
  { value: 'is_empty',  label: 'is empty' },
  { value: 'not_empty', label: 'is not empty' },
  { value: 'eq',        label: 'is' },
  { value: 'neq',       label: 'is not' },
]

function opsForField(field) {
  const f = FIELDS.find(x => x.value === field)
  if (f?.type === 'string') return STRING_OPS
  if (f?.type === 'service') return SERVICE_OPS
  return NUMERIC_OPS
}

const NO_VALUE_OPS = new Set(['is_empty', 'not_empty'])

// ── Condition display helpers ──────────────────────────────────────────────────

const OP_LABELS = {
  is_empty: 'is empty', not_empty: 'is not empty',
  eq: '=', neq: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥',
  between: 'between', contains: 'contains',
  not_contains: 'does not contain', is_exactly: 'is exactly',
}

function conditionLabel(c) {
  const fieldLabel = FIELDS.find(f => f.value === c.field)?.label ?? c.field
  const opLabel = OP_LABELS[c.operator] ?? c.operator
  if (NO_VALUE_OPS.has(c.operator)) return `${fieldLabel} ${opLabel}`
  if (c.operator === 'between') return `${fieldLabel} between ${c.value} and ${c.value2}`
  if (c.field === 'carrier_service' && c.value) {
    const [cc, sc] = c.value.split('::')
    const svc = findService(cc, sc)
    const svcLabel = svc ? `${svc.carrierLabel} — ${svc.label}` : c.value
    return `${fieldLabel} ${opLabel} ${svcLabel}`
  }
  return `${fieldLabel} ${opLabel} ${c.value}`
}

// ── Empty form helpers ─────────────────────────────────────────────────────────

const EMPTY_CONDITION = { field: 'pactor', operator: 'gte', value: '', value2: '' }

const EMPTY_FORM = {
  name: '',
  package_type: '',
  priority: 0,
  is_active: true,
  conditions: [],
  notes: '',
}

// ── BoxTypePackagingRow sub-component ─────────────────────────────────────────

function BoxTypePackagingRow({ bt, materials, expanded, onToggle }) {
  const qc = useQueryClient()
  const [addingMaterialId, setAddingMaterialId] = useState('')
  const [addingQty, setAddingQty] = useState('1')

  const { data: entries = [], refetch } = useQuery({
    queryKey: ['box-type-packaging', bt.id],
    queryFn: () => boxTypePackagingApi.list(bt.id),
    enabled: expanded,
  })

  const addMut = useMutation({
    mutationFn: (data) => boxTypePackagingApi.add(bt.id, data),
    onSuccess: () => { qc.invalidateQueries(['box-type-packaging', bt.id]); setAddingMaterialId(''); setAddingQty('1') },
  })
  const removeMut = useMutation({
    mutationFn: (entryId) => boxTypePackagingApi.remove(bt.id, entryId),
    onSuccess: () => qc.invalidateQueries(['box-type-packaging', bt.id]),
  })

  const totalCost = entries.reduce((s, e) => s + (e.line_cost || 0), 0)
  const assignedIds = new Set(entries.map(e => e.packaging_material_id))
  const availableToAdd = materials.filter(m => m.is_active && !assignedIds.has(m.id))

  return (
    <div style={{ border: '1px solid #e8e8e8', borderRadius: 6, marginBottom: 8, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', background: '#fafafa', border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 500, color: '#333', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 10, color: '#aaa' }}>{expanded ? '▼' : '▶'}</span>
        <strong>{bt.name}</strong>
        {bt.carrier && <span style={{ color: '#888', fontWeight: 400 }}>{bt.carrier}</span>}
        {entries.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#16a34a', fontWeight: 600 }}>
            ${totalCost.toFixed(2)} total ({entries.length} material{entries.length > 1 ? 's' : ''})
          </span>
        )}
        {entries.length === 0 && expanded && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#aaa' }}>no materials assigned</span>
        )}
      </button>
      {expanded && (
        <div style={{ padding: 12, borderTop: '1px solid #e8e8e8', background: '#fff' }}>
          {entries.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10, fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #eee' }}>
                  {['Material', 'Qty', 'Unit Cost', 'Line Cost', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '3px 8px', fontWeight: 600, color: '#888', fontSize: 11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} style={{ borderBottom: '1px solid #f5f5f5' }}>
                    <td style={{ padding: '4px 8px' }}>{e.material_name}</td>
                    <td style={{ padding: '4px 8px', color: '#666' }}>{e.quantity} {e.material_unit || 'each'}</td>
                    <td style={{ padding: '4px 8px', color: '#666' }}>${(e.material_unit_cost || 0).toFixed(4)}</td>
                    <td style={{ padding: '4px 8px', color: '#16a34a', fontWeight: 600 }}>${(e.line_cost || 0).toFixed(2)}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                      <button className="btn btn-danger btn-sm" style={{ fontSize: 11 }}
                        onClick={() => removeMut.mutate(e.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid #e8e8e8' }}>
                  <td colSpan={3} style={{ padding: '4px 8px', fontWeight: 600, color: '#444', fontSize: 13 }}>Total packaging cost</td>
                  <td style={{ padding: '4px 8px', fontWeight: 700, color: '#16a34a' }}>${totalCost.toFixed(2)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          )}
          {availableToAdd.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>Material</label>
                <select value={addingMaterialId} onChange={e => setAddingMaterialId(e.target.value)}
                  style={{ fontSize: 13, padding: '5px 8px', border: '1px solid #ddd', borderRadius: 4 }}>
                  <option value="">Select material…</option>
                  {availableToAdd.map(m => <option key={m.id} value={m.id}>{m.name} (${m.unit_cost.toFixed(4)}/{m.unit || 'each'})</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>Qty</label>
                <input type="number" min="0.01" step="0.01" value={addingQty} onChange={e => setAddingQty(e.target.value)}
                  style={{ width: 70, fontSize: 13, padding: '5px 8px', border: '1px solid #ddd', borderRadius: 4 }} />
              </div>
              <button className="btn btn-primary btn-sm" disabled={!addingMaterialId || addMut.isPending}
                onClick={() => addMut.mutate({ packaging_material_id: parseInt(addingMaterialId), quantity: parseFloat(addingQty) || 1 })}>
                + Add
              </button>
            </div>
          )}
          {availableToAdd.length === 0 && entries.length === 0 && (
            <p style={{ fontSize: 12, color: '#aaa', margin: 0 }}>No active materials in the library above. Add materials first.</p>
          )}
        </div>
      )}
    </div>
  )
}


// ── Main component ─────────────────────────────────────────────────────────────

export default function PackageRules() {
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [filterActive, setFilterActive] = useState('')
  const [showBoxMgr, setShowBoxMgr] = useState(false)
  const EMPTY_BOX_FORM = { catalogKey: '', name: '', pick_sku: '', carrier: '', package_code: '', length_in: '', width_in: '', height_in: '', weight_oz: '', description: '' }
  const [boxForm, setBoxForm] = useState(EMPTY_BOX_FORM)
  const [editingBox, setEditingBox] = useState(null)

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['package-rules'],
    queryFn: () => packageRulesApi.list({ limit: 1000 }),
  })

  const { data: boxTypes = [] } = useQuery({
    queryKey: ['box-types'],
    queryFn: () => boxTypesApi.list(),
  })

  const createBoxMut = useMutation({
    mutationFn: boxTypesApi.create,
    onSuccess: () => { qc.invalidateQueries(['box-types']); resetBoxForm() },
  })
  const updateBoxMut = useMutation({
    mutationFn: ({ id, data }) => boxTypesApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries(['box-types']); resetBoxForm() },
  })
  const deleteBoxMut = useMutation({
    mutationFn: boxTypesApi.delete,
    onSuccess: () => qc.invalidateQueries(['box-types']),
  })

  function resetBoxForm() { setBoxForm(EMPTY_BOX_FORM); setEditingBox(null) }
  function startEditBox(bt) {
    setEditingBox(bt)
    setBoxForm({
      catalogKey: bt.carrier && bt.package_code ? `${bt.carrier}::${bt.package_code}` : '',
      name: bt.name,
      pick_sku: bt.pick_sku ?? '',
      carrier: bt.carrier ?? '',
      package_code: bt.package_code ?? '',
      length_in: bt.length_in ?? '',
      width_in: bt.width_in ?? '',
      height_in: bt.height_in ?? '',
      weight_oz: bt.weight_oz ?? '',
      description: bt.description ?? '',
    })
  }
  function handleCatalogSelect(key) {
    if (!key) { setBoxForm(f => ({ ...f, catalogKey: '', carrier: '', package_code: '', length_in: '', width_in: '', height_in: '' })); return }
    const [carrier, code] = key.split('::')
    const pkg = findPackage(carrier, code)
    if (!pkg) return
    setBoxForm(f => ({
      ...f,
      catalogKey: key,
      carrier,
      package_code: code,
      name: f.name || pkg.label,
      length_in: pkg.dims ? pkg.dims.l : '',
      width_in:  pkg.dims ? pkg.dims.w : '',
      height_in: pkg.dims ? pkg.dims.h : '',
    }))
  }
  function handleBoxSubmit(e) {
    e.preventDefault()
    const payload = {
      name: boxForm.name.trim(),
      pick_sku: boxForm.pick_sku.trim() || null,
      carrier: boxForm.carrier || null,
      package_code: boxForm.package_code || null,
      length_in: boxForm.length_in !== '' ? parseFloat(boxForm.length_in) : null,
      width_in:  boxForm.width_in  !== '' ? parseFloat(boxForm.width_in)  : null,
      height_in: boxForm.height_in !== '' ? parseFloat(boxForm.height_in) : null,
      weight_oz: boxForm.weight_oz !== '' ? parseFloat(boxForm.weight_oz) : null,
      description: boxForm.description.trim() || null,
    }
    if (editingBox) updateBoxMut.mutate({ id: editingBox.id, data: payload })
    else createBoxMut.mutate(payload)
  }
  const selectedPkg = boxForm.catalogKey ? findPackage(...boxForm.catalogKey.split('::')) : null
  const dimRequired = selectedPkg?.requiresDims ?? false
  const dimReadOnly = selectedPkg && !selectedPkg.requiresDims && selectedPkg.dims != null

  // ── Packaging Materials ───────────────────────────────────────────────────
  const [showPackagingMgr, setShowPackagingMgr] = useState(false)
  const [expandedBoxId, setExpandedBoxId] = useState(null)
  const EMPTY_MAT_FORM = { name: '', unit_cost: '', unit: 'each', notes: '' }
  const [matForm, setMatForm] = useState(EMPTY_MAT_FORM)
  const [editingMat, setEditingMat] = useState(null)

  const { data: materials = [] } = useQuery({
    queryKey: ['packaging-materials'],
    queryFn: packagingMaterialsApi.list,
  })

  const createMatMut = useMutation({
    mutationFn: packagingMaterialsApi.create,
    onSuccess: () => { qc.invalidateQueries(['packaging-materials']); setMatForm(EMPTY_MAT_FORM); setEditingMat(null) },
  })
  const updateMatMut = useMutation({
    mutationFn: ({ id, data }) => packagingMaterialsApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries(['packaging-materials']); setMatForm(EMPTY_MAT_FORM); setEditingMat(null) },
  })
  const deleteMatMut = useMutation({
    mutationFn: packagingMaterialsApi.delete,
    onSuccess: () => qc.invalidateQueries(['packaging-materials']),
  })

  function startEditMat(m) {
    setEditingMat(m)
    setMatForm({ name: m.name, unit_cost: m.unit_cost, unit: m.unit || 'each', notes: m.notes || '' })
  }
  function handleMatSubmit(e) {
    e.preventDefault()
    const payload = { ...matForm, unit_cost: parseFloat(matForm.unit_cost) }
    if (editingMat) updateMatMut.mutate({ id: editingMat.id, data: payload })
    else createMatMut.mutate(payload)
  }

  const createMut = useMutation({
    mutationFn: packageRulesApi.create,
    onSuccess: () => { qc.invalidateQueries(['package-rules']); closeModal() },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => packageRulesApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries(['package-rules']); closeModal() },
  })
  const deleteMut = useMutation({
    mutationFn: packageRulesApi.delete,
    onSuccess: () => qc.invalidateQueries(['package-rules']),
  })
  const pauseMut = useMutation({
    mutationFn: packageRulesApi.pause,
    onSuccess: () => qc.invalidateQueries(['package-rules']),
  })
  const unpauseMut = useMutation({
    mutationFn: packageRulesApi.unpause,
    onSuccess: () => qc.invalidateQueries(['package-rules']),
  })

  function openCreate() {
    setEditing(null)
    setForm({ ...EMPTY_FORM, conditions: [] })
    setShowModal(true)
  }
  function openEdit(row) {
    setEditing(row)
    setForm({
      name: row.name,
      package_type: row.package_type,
      priority: row.priority ?? 0,
      is_active: row.is_active ?? true,
      conditions: (row.conditions || []).map(c => ({ ...c, value: c.value ?? '', value2: c.value2 ?? '' })),
      notes: row.notes ?? '',
    })
    setShowModal(true)
  }
  function closeModal() { setShowModal(false); setEditing(null) }

  // ── Condition mutations ──────────────────────────────────────────────────────

  function addCondition() {
    setForm(f => ({ ...f, conditions: [...f.conditions, { ...EMPTY_CONDITION }] }))
  }

  function removeCondition(idx) {
    setForm(f => ({ ...f, conditions: f.conditions.filter((_, i) => i !== idx) }))
  }

  function updateCondition(idx, key, val) {
    setForm(f => {
      const conds = f.conditions.map((c, i) => {
        if (i !== idx) return c
        const updated = { ...c, [key]: val }
        // Reset value when operator changes to/from no-value ops
        if (key === 'operator' && NO_VALUE_OPS.has(val)) {
          updated.value = ''
          updated.value2 = ''
        }
        // Reset value2 when operator changes away from 'between'
        if (key === 'operator' && val !== 'between') {
          updated.value2 = ''
        }
        // Reset operator when field type changes
        if (key === 'field') {
          const newOps = opsForField(val)
          if (!newOps.find(o => o.value === c.operator)) {
            updated.operator = newOps[0].value
          }
          updated.value = ''
          updated.value2 = ''
        }
        return updated
      })
      return { ...f, conditions: conds }
    })
  }

  // ── Submit ───────────────────────────────────────────────────────────────────

  function handleSubmit(e) {
    e.preventDefault()
    const payload = {
      name: form.name.trim(),
      package_type: form.package_type.trim(),
      priority: parseInt(form.priority) || 0,
      is_active: form.is_active,
      notes: form.notes.trim() || null,
      conditions: form.conditions.map(c => {
        const out = { field: c.field, operator: c.operator, value: null, value2: null }
        if (!NO_VALUE_OPS.has(c.operator)) {
          const f = FIELDS.find(x => x.value === c.field)
          out.value = f?.type === 'number' ? (parseFloat(c.value) || 0) : c.value
          if (c.operator === 'between') {
            out.value2 = f?.type === 'number' ? (parseFloat(c.value2) || 0) : c.value2
          }
        }
        return out
      }),
    }
    if (editing) updateMut.mutate({ id: editing.id, data: payload })
    else createMut.mutate(payload)
  }

  // ── Filtering ────────────────────────────────────────────────────────────────

  const filtered = rules.filter(r => {
    if (filterActive === 'active' && !r.is_active) return false
    if (filterActive === 'inactive' && r.is_active) return false
    return true
  })

  const isSaving = createMut.isPending || updateMut.isPending
  const saveError = createMut.error || updateMut.error

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div>
      <div className="page-header">
        <h1>Box Rules</h1>
        <p>
          Configure which box to use based on order pactor, shipping zone, or tags.
          Rules are evaluated highest-priority first — the first matching rule wins.
        </p>
      </div>

      {/* ── Manage Boxes panel ────────────────────────────────────────────── */}
      <div style={{ marginBottom: 20, border: '1px solid #e8e8e8', borderRadius: 8, overflow: 'hidden' }}>
        <button
          type="button"
          onClick={() => setShowBoxMgr(v => !v)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 16px', background: '#f8f9fb', border: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: 600, color: '#444', textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 11, color: '#888' }}>{showBoxMgr ? '▼' : '▶'}</span>
          Manage Boxes
          <span style={{ fontWeight: 400, color: '#aaa', fontSize: 12 }}>({boxTypes.length} configured)</span>
        </button>

        {showBoxMgr && (
          <div style={{ padding: 16, borderTop: '1px solid #e8e8e8', background: '#fff' }}>
            {/* Box list */}
            {boxTypes.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16, fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #eee' }}>
                    <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: '#888', fontSize: 12 }}>Display Name</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: '#888', fontSize: 12 }}>Inventory SKU</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: '#888', fontSize: 12 }}>Carrier</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: '#888', fontSize: 12 }}>Package Code</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: '#888', fontSize: 12 }}>Dimensions (L×W×H in)</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: '#888', fontSize: 12 }}>Weight (oz)</th>
                    <th style={{ width: 120 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {boxTypes.map(bt => (
                    <tr key={bt.id} style={{ borderBottom: '1px solid #f5f5f5' }}>
                      <td style={{ padding: '5px 8px', fontWeight: 500 }}>{bt.name}</td>
                      <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontSize: 12, color: bt.pick_sku ? '#333' : '#bbb' }}>
                        {bt.pick_sku || '—'}
                      </td>
                      <td style={{ padding: '5px 8px', color: '#666' }}>{bt.carrier || '—'}</td>
                      <td style={{ padding: '5px 8px' }}>
                        {bt.package_code
                          ? <span className="mono" style={{ background: '#f3f4f6', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>{bt.package_code}</span>
                          : <span style={{ color: '#bbb' }}>—</span>}
                      </td>
                      <td style={{ padding: '5px 8px', color: '#666', fontFamily: 'monospace', fontSize: 12 }}>
                        {bt.length_in != null
                          ? `${bt.length_in} × ${bt.width_in} × ${bt.height_in}`
                          : <span style={{ color: '#bbb' }}>—</span>}
                      </td>
                      <td style={{ padding: '5px 8px', color: '#666', fontFamily: 'monospace', fontSize: 12 }}>
                        {bt.weight_oz != null ? `${bt.weight_oz} oz` : <span style={{ color: '#bbb' }}>—</span>}
                      </td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => startEditBox(bt)}>Edit</button>{' '}
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => { if (confirm(`Delete box "${bt.name}"?`)) deleteBoxMut.mutate(bt.id) }}
                        >Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Add / Edit box form */}
            <div style={{ background: '#f8f9fb', border: '1px solid #e8e8e8', borderRadius: 8, padding: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, color: '#444' }}>
                {editingBox ? `Edit: ${editingBox.name}` : 'Add a box'}
              </div>
              <form onSubmit={handleBoxSubmit}>
                {/* Row 1: Catalog selector + Display name */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 2, minWidth: 200 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>
                      ShipStation Package *
                    </label>
                    <select
                      value={boxForm.catalogKey}
                      onChange={e => handleCatalogSelect(e.target.value)}
                      style={{ ...inputStyle, width: '100%', height: 32 }}
                    >
                      <option value="">Select a package…</option>
                      {GENERIC_PACKAGES.map(pkg => (
                        <option key={catalogKey(pkg)} value={catalogKey(pkg)}>
                          {pkg.label} (any carrier, custom dims required)
                        </option>
                      ))}
                      {packagesByCarrier().map(({ carrier, packages }) => (
                        <optgroup key={carrier} label={carrier}>
                          {packages.map(pkg => (
                            <option key={catalogKey(pkg)} value={catalogKey(pkg)}>
                              {pkg.label}{pkg.requiresDims ? ' (custom dims required)' : pkg.dims ? ` — ${pkg.dims.l}×${pkg.dims.w}×${pkg.dims.h}"` : ''}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div style={{ flex: 2, minWidth: 160 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>
                      Display Name *
                    </label>
                    <input
                      required
                      value={boxForm.name}
                      onChange={e => setBoxForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. LFR, Medium Flat Rate"
                      style={{ ...inputStyle, width: '100%' }}
                    />
                  </div>
                </div>

                {/* Row 2: Dimensions — shown when a package is selected */}
                {boxForm.catalogKey && (
                  <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>
                        Length (in){dimRequired ? ' *' : ''}
                      </label>
                      <input
                        type="number" step="0.01" min="0"
                        required={dimRequired}
                        readOnly={dimReadOnly}
                        value={boxForm.length_in}
                        onChange={e => setBoxForm(f => ({ ...f, length_in: e.target.value }))}
                        style={{ ...inputStyle, width: 90, background: dimReadOnly ? '#f3f4f6' : '#fff' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>
                        Width (in){dimRequired ? ' *' : ''}
                      </label>
                      <input
                        type="number" step="0.01" min="0"
                        required={dimRequired}
                        readOnly={dimReadOnly}
                        value={boxForm.width_in}
                        onChange={e => setBoxForm(f => ({ ...f, width_in: e.target.value }))}
                        style={{ ...inputStyle, width: 90, background: dimReadOnly ? '#f3f4f6' : '#fff' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>
                        Height (in){dimRequired ? ' *' : ''}
                      </label>
                      <input
                        type="number" step="0.01" min="0"
                        required={dimRequired}
                        readOnly={dimReadOnly}
                        value={boxForm.height_in}
                        onChange={e => setBoxForm(f => ({ ...f, height_in: e.target.value }))}
                        style={{ ...inputStyle, width: 90, background: dimReadOnly ? '#f3f4f6' : '#fff' }}
                      />
                    </div>
                    {dimReadOnly && (
                      <div style={{ fontSize: 11, color: '#888', paddingBottom: 4 }}>
                        Pre-filled from carrier specs
                      </div>
                    )}
                    {dimRequired && (
                      <div>
                        <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>
                          Box Weight (oz) *
                        </label>
                        <input
                          type="number" step="0.1" min="0"
                          required
                          value={boxForm.weight_oz}
                          onChange={e => setBoxForm(f => ({ ...f, weight_oz: e.target.value }))}
                          placeholder="e.g. 4.5"
                          style={{ ...inputStyle, width: 90 }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Row 3: Inventory SKU + Description + buttons */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>
                      Inventory SKU
                    </label>
                    <input
                      value={boxForm.pick_sku}
                      onChange={e => setBoxForm(f => ({ ...f, pick_sku: e.target.value }))}
                      placeholder="e.g. BOX-LFR"
                      style={{ ...inputStyle, width: '100%' }}
                    />
                  </div>
                  <div style={{ flex: 2, minWidth: 160 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>Notes</label>
                    <input
                      value={boxForm.description}
                      onChange={e => setBoxForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Optional"
                      style={{ ...inputStyle, width: '100%' }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={createBoxMut.isPending || updateBoxMut.isPending}>
                      {editingBox ? 'Save' : '+ Add Box'}
                    </button>
                    {editingBox && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={resetBoxForm}>Cancel</button>
                    )}
                  </div>
                </div>

                {(createBoxMut.error || updateBoxMut.error) && (
                  <div style={{ color: '#c00', fontSize: 12, marginTop: 8 }}>
                    {(createBoxMut.error || updateBoxMut.error)?.response?.data?.detail || 'Error saving box'}
                  </div>
                )}
              </form>
            </div>
          </div>
        )}
      </div>

      {/* ── Packaging Materials panel ─────────────────────────────────────── */}
      <div style={{ marginBottom: 20, border: '1px solid #e8e8e8', borderRadius: 8, overflow: 'hidden' }}>
        <button
          type="button"
          onClick={() => setShowPackagingMgr(v => !v)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 16px', background: '#f8f9fb', border: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: 600, color: '#444', textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 11, color: '#888' }}>{showPackagingMgr ? '▼' : '▶'}</span>
          Packaging Materials
          <span style={{ fontWeight: 400, color: '#aaa', fontSize: 12 }}>({materials.length} materials — assign to box types for packaging cost in GM)</span>
        </button>

        {showPackagingMgr && (
          <div style={{ padding: 16, borderTop: '1px solid #e8e8e8', background: '#fff' }}>
            {/* ── Material library ── */}
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: '#444' }}>Material Library</div>
            {materials.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12, fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #eee' }}>
                    {['Name', 'Cost / unit', 'Unit', 'Notes', ''].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, color: '#888', fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {materials.map(m => (
                    <tr key={m.id} style={{ borderBottom: '1px solid #f5f5f5' }}>
                      <td style={{ padding: '5px 8px', fontWeight: 500 }}>{m.name}</td>
                      <td style={{ padding: '5px 8px', color: '#16a34a', fontWeight: 600 }}>${m.unit_cost.toFixed(4)}</td>
                      <td style={{ padding: '5px 8px', color: '#666' }}>{m.unit || 'each'}</td>
                      <td style={{ padding: '5px 8px', color: '#888', fontSize: 12 }}>{m.notes || '—'}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => startEditMat(m)}>Edit</button>{' '}
                        <button className="btn btn-danger btn-sm" onClick={() => { if (confirm(`Delete "${m.name}"?`)) deleteMatMut.mutate(m.id) }}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {/* Add/Edit material form */}
            <form onSubmit={handleMatSubmit} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', background: '#f8f9fb', padding: 12, borderRadius: 8, border: '1px solid #e8e8e8', marginBottom: 20 }}>
              <div style={{ flex: 2, minWidth: 140 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>Name *</label>
                <input required value={matForm.name} onChange={e => setMatForm(f => ({ ...f, name: e.target.value }))}
                  placeholder='e.g. "12x12x12 Box"' style={{ width: '100%', fontSize: 13, padding: '5px 8px', border: '1px solid #ddd', borderRadius: 4 }} />
              </div>
              <div style={{ flex: 1, minWidth: 100 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>Cost / unit ($) *</label>
                <input required type="number" step="0.0001" min="0" value={matForm.unit_cost}
                  onChange={e => setMatForm(f => ({ ...f, unit_cost: e.target.value }))}
                  style={{ width: '100%', fontSize: 13, padding: '5px 8px', border: '1px solid #ddd', borderRadius: 4 }} />
              </div>
              <div style={{ flex: 1, minWidth: 80 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>Unit</label>
                <input value={matForm.unit} onChange={e => setMatForm(f => ({ ...f, unit: e.target.value }))}
                  placeholder='each' style={{ width: '100%', fontSize: 13, padding: '5px 8px', border: '1px solid #ddd', borderRadius: 4 }} />
              </div>
              <div style={{ flex: 2, minWidth: 120 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: '#888', display: 'block', marginBottom: 3 }}>Notes</label>
                <input value={matForm.notes} onChange={e => setMatForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Optional" style={{ width: '100%', fontSize: 13, padding: '5px 8px', border: '1px solid #ddd', borderRadius: 4 }} />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="submit" className="btn btn-primary btn-sm" disabled={createMatMut.isPending || updateMatMut.isPending}>
                  {editingMat ? 'Save' : '+ Add Material'}
                </button>
                {editingMat && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditingMat(null); setMatForm(EMPTY_MAT_FORM) }}>Cancel</button>}
              </div>
            </form>

            {/* ── Per-box-type material assignments ── */}
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: '#444' }}>Materials per Box Type</div>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12, marginTop: 0 }}>
              Expand a box type to assign which materials go inside it and in what quantity. The total packaging cost for GM is calculated from these entries.
            </p>
            {boxTypes.map(bt => (
              <BoxTypePackagingRow key={bt.id} bt={bt} materials={materials} expanded={expandedBoxId === bt.id} onToggle={() => setExpandedBoxId(expandedBoxId === bt.id ? null : bt.id)} />
            ))}
          </div>
        )}
      </div>

      <div className="toolbar">
        <select
          value={filterActive}
          onChange={e => setFilterActive(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13, background: '#fff' }}
        >
          <option value="">All Rules</option>
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
        </select>
        <button className="btn btn-primary" onClick={openCreate} style={{ marginLeft: 'auto' }}>
          + Add Rule
        </button>
      </div>

      <div className="data-table-wrap">
        {isLoading ? (
          <div className="loading">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            {rules.length === 0
              ? 'No box rules yet. Add a rule to define which box to use.'
              : 'No rules match the current filter.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 64 }}>Priority</th>
                <th>Name</th>
                <th>Box</th>
                <th>Conditions</th>
                <th style={{ width: 72 }}>Status</th>
                <th style={{ width: 120 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => (
                <tr key={row.id} style={{ opacity: row.is_active ? 1 : 0.5 }}>
                  <td style={{ fontWeight: 600, textAlign: 'center', color: '#888' }}>{row.priority}</td>
                  <td style={{ fontWeight: 500 }}>{row.name}</td>
                  <td>
                    <span className="mono" style={{ background: '#f3f4f6', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>
                      {row.package_type}
                    </span>
                  </td>
                  <td>
                    {(row.conditions || []).length === 0 ? (
                      <span style={{ color: '#bbb', fontSize: 12 }}>No conditions (always match)</span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {row.conditions.map((c, i) => (
                          <span key={i} style={{
                            fontSize: 12,
                            background: '#eff6ff',
                            border: '1px solid #bfdbfe',
                            borderRadius: 4,
                            padding: '1px 7px',
                            display: 'inline-block',
                            width: 'fit-content',
                          }}>
                            {conditionLabel(c)}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                      background: row.is_active ? '#dcfce7' : '#f3f4f6',
                      color: row.is_active ? '#166534' : '#888',
                    }}>
                      {row.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => openEdit(row)}>Edit</button>{' '}
                    {row.is_active
                      ? <button className="btn btn-secondary btn-sm" onClick={() => pauseMut.mutate(row.id)}>Pause</button>
                      : <button className="btn btn-secondary btn-sm" onClick={() => unpauseMut.mutate(row.id)}>Resume</button>
                    }{' '}
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => { if (confirm(`Delete rule "${row.name}"?`)) deleteMut.mutate(row.id) }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {filtered.length > 0 && (
          <div style={{ padding: '8px 14px', borderTop: '1px solid #f0f0f0', fontSize: 12, color: '#aaa' }}>
            {filtered.length}{filtered.length !== rules.length ? ` of ${rules.length}` : ''} rules
          </div>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 620, width: '100%' }}>
            <h3>{editing ? 'Edit Box Rule' : 'Add Box Rule'}</h3>
            <form onSubmit={handleSubmit}>

              {/* Name + Priority */}
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Rule Name *</label>
                  <input
                    required
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Small orders, Large flat rate"
                  />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Priority</label>
                  <input
                    type="number"
                    value={form.priority}
                    onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                    placeholder="0"
                  />
                  <small style={{ color: '#888', marginTop: 2, display: 'block' }}>Higher = evaluated first</small>
                </div>
              </div>

              {/* Box type + Active */}
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Box (Package Type) *</label>
                  {boxTypes.length > 0 ? (
                    <select
                      required
                      value={form.package_type}
                      onChange={e => setForm(f => ({ ...f, package_type: e.target.value }))}
                      style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13, background: '#fff', width: '100%' }}
                    >
                      <option value="">Select a box…</option>
                      {boxTypes.map(bt => (
                        <option key={bt.id} value={bt.name}>{bt.name}{bt.description ? ` — ${bt.description}` : ''}</option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <input
                        required
                        value={form.package_type}
                        onChange={e => setForm(f => ({ ...f, package_type: e.target.value }))}
                        placeholder="e.g. 12x12x12, LFR, 2x LFR"
                      />
                      <small style={{ color: '#888', marginTop: 2, display: 'block' }}>
                        No boxes configured yet. Add boxes in the "Manage Boxes" section above, or type manually.
                      </small>
                    </>
                  )}
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Active</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      id="is_active_cb"
                      checked={form.is_active}
                      onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                      style={{ width: 16, height: 16, cursor: 'pointer' }}
                    />
                    <label htmlFor="is_active_cb" style={{ fontWeight: 400, cursor: 'pointer', marginBottom: 0 }}>
                      {form.is_active ? 'Enabled' : 'Disabled'}
                    </label>
                  </div>
                </div>
              </div>

              {/* Conditions */}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label style={{ marginBottom: 6, display: 'block' }}>
                  Conditions
                  <span style={{ fontWeight: 400, color: '#888', fontSize: 12, marginLeft: 8 }}>
                    All conditions must match (AND). Leave empty to always match.
                  </span>
                </label>

                {form.conditions.length === 0 && (
                  <div style={{ padding: '8px 12px', background: '#fafafa', border: '1px dashed #e0e0e0', borderRadius: 6, fontSize: 12, color: '#aaa', marginBottom: 8 }}>
                    No conditions — this rule matches every order.
                  </div>
                )}

                {form.conditions.map((cond, idx) => (
                  <ConditionRow
                    key={idx}
                    cond={cond}
                    onChange={(key, val) => updateCondition(idx, key, val)}
                    onRemove={() => removeCondition(idx)}
                  />
                ))}

                <button
                  type="button"
                  onClick={addCondition}
                  style={{
                    marginTop: 4, padding: '5px 12px', fontSize: 12, border: '1px dashed #bbb',
                    borderRadius: 6, background: '#fafafa', cursor: 'pointer', color: '#555',
                  }}
                >
                  + Add Condition
                </button>
              </div>

              {/* Notes */}
              <div className="form-group" style={{ marginTop: 14 }}>
                <label>Notes</label>
                <input
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Optional description"
                />
              </div>

              {saveError && (
                <div className="error-banner" style={{ marginBottom: 12 }}>
                  {saveError?.response?.data?.detail || saveError.message}
                </div>
              )}

              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={isSaving}>
                  {isSaving ? 'Saving…' : editing ? 'Save Changes' : 'Add Rule'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Condition row sub-component ────────────────────────────────────────────────

function ConditionRow({ cond, onChange, onRemove }) {
  const ops = opsForField(cond.field)
  const needsValue = !NO_VALUE_OPS.has(cond.operator)
  const isBetween = cond.operator === 'between'
  const fieldDef = FIELDS.find(f => f.value === cond.field)
  const fieldType = fieldDef?.type ?? 'number'

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 8,
      background: '#f8f9fb', border: '1px solid #e8e8e8', borderRadius: 6, padding: '8px 10px',
    }}>
      {/* Field */}
      <select
        value={cond.field}
        onChange={e => onChange('field', e.target.value)}
        style={selectStyle}
      >
        {FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>

      {/* Operator */}
      <select
        value={cond.operator}
        onChange={e => onChange('operator', e.target.value)}
        style={{ ...selectStyle, minWidth: 160 }}
      >
        {ops.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
      </select>

      {/* Value(s) */}
      {needsValue && (
        <>
          {fieldType === 'service' ? (
            <select
              value={cond.value || ''}
              onChange={e => onChange('value', e.target.value)}
              style={{ ...selectStyle, minWidth: 200 }}
            >
              <option value="">Select a service…</option>
              {servicesByCarrier().map(({ carrierCode, carrierLabel, services }) => (
                <optgroup key={carrierCode} label={carrierLabel}>
                  {services.map(svc => (
                    <option key={serviceKey(svc)} value={serviceKey(svc)}>
                      {svc.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          ) : (
            <>
              <input
                type={fieldType === 'number' ? 'number' : 'text'}
                value={cond.value}
                onChange={e => onChange('value', e.target.value)}
                placeholder={isBetween ? 'min' : 'value'}
                style={{ ...inputStyle, width: isBetween ? 72 : 100 }}
              />
              {isBetween && (
                <>
                  <span style={{ lineHeight: '30px', color: '#888', fontSize: 12 }}>and</span>
                  <input
                    type={fieldType === 'number' ? 'number' : 'text'}
                    value={cond.value2}
                    onChange={e => onChange('value2', e.target.value)}
                    placeholder="max"
                    style={{ ...inputStyle, width: 72 }}
                  />
                </>
              )}
            </>
          )}
        </>
      )}

      {/* Remove */}
      <button
        type="button"
        onClick={onRemove}
        style={{
          marginLeft: 'auto', padding: '0 8px', height: 30, border: 'none',
          background: 'transparent', cursor: 'pointer', color: '#bbb', fontSize: 16, lineHeight: '30px',
        }}
        title="Remove condition"
      >
        ×
      </button>
    </div>
  )
}

const selectStyle = {
  padding: '4px 8px', border: '1px solid #ddd', borderRadius: 5, fontSize: 13,
  background: '#fff', height: 30, minWidth: 90,
}

const inputStyle = {
  padding: '4px 8px', border: '1px solid #ddd', borderRadius: 5, fontSize: 13, height: 30,
}
