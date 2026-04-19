import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { carrierServiceRulesApi } from '../api'
import { servicesByCarrier, findService, serviceKey, parseServiceKey } from '../shipstationServices'

// ── Field / Operator definitions ──────────────────────────────────────────────

const FIELDS = [
  { value: 'pactor', label: 'Pactor', type: 'number' },
  { value: 'zone',   label: 'Zone',   type: 'number' },
  { value: 'tags',   label: 'Tags',   type: 'string' },
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

function opsForField(field) {
  const f = FIELDS.find(x => x.value === field)
  return f?.type === 'string' ? STRING_OPS : NUMERIC_OPS
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
  return `${fieldLabel} ${opLabel} ${c.value}`
}

function serviceLabel(carrierCode, serviceCode, shippingProviderId = null) {
  const svc = findService(carrierCode, serviceCode, shippingProviderId)
  if (!svc) return `${carrierCode} / ${serviceCode}`
  return `${svc.carrierLabel} — ${svc.label}`
}

// ── Empty form helpers ─────────────────────────────────────────────────────────

const EMPTY_CONDITION = { field: 'pactor', operator: 'gte', value: '', value2: '' }

const EMPTY_FORM = {
  name: '',
  carrier_code: '',
  service_code: '',
  shipping_provider_id: null,
  priority: 0,
  is_active: true,
  conditions: [],
  notes: '',
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CarrierServiceRules() {
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [filterActive, setFilterActive] = useState('')

  // Derived: the selected catalog key for the service selector
  const selectedKey = form.carrier_code && form.service_code
    ? serviceKey({ carrierCode: form.carrier_code, shippingProviderId: form.shipping_provider_id ?? null, code: form.service_code })
    : ''

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['carrier-service-rules'],
    queryFn: () => carrierServiceRulesApi.list({ limit: 1000 }),
  })

  const createMut = useMutation({
    mutationFn: carrierServiceRulesApi.create,
    onSuccess: () => { qc.invalidateQueries(['carrier-service-rules']); closeModal() },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => carrierServiceRulesApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries(['carrier-service-rules']); closeModal() },
  })
  const deleteMut = useMutation({
    mutationFn: carrierServiceRulesApi.delete,
    onSuccess: () => qc.invalidateQueries(['carrier-service-rules']),
  })
  const pauseMut = useMutation({
    mutationFn: carrierServiceRulesApi.pause,
    onSuccess: () => qc.invalidateQueries(['carrier-service-rules']),
  })
  const unpauseMut = useMutation({
    mutationFn: carrierServiceRulesApi.unpause,
    onSuccess: () => qc.invalidateQueries(['carrier-service-rules']),
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
      carrier_code: row.carrier_code,
      service_code: row.service_code,
      shipping_provider_id: row.shipping_provider_id ?? null,
      priority: row.priority ?? 0,
      is_active: row.is_active ?? true,
      conditions: (row.conditions || []).map(c => ({ ...c, value: c.value ?? '', value2: c.value2 ?? '' })),
      notes: row.notes ?? '',
    })
    setShowModal(true)
  }
  function closeModal() { setShowModal(false); setEditing(null) }

  function handleServiceSelect(key) {
    if (!key) {
      setForm(f => ({ ...f, carrier_code: '', service_code: '', shipping_provider_id: null }))
      return
    }
    const { carrierCode, shippingProviderId, serviceCode } = parseServiceKey(key)
    setForm(f => ({ ...f, carrier_code: carrierCode, service_code: serviceCode, shipping_provider_id: shippingProviderId }))
  }

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
        if (key === 'operator' && NO_VALUE_OPS.has(val)) {
          updated.value = ''
          updated.value2 = ''
        }
        if (key === 'operator' && val !== 'between') {
          updated.value2 = ''
        }
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
      carrier_code: form.carrier_code,
      service_code: form.service_code,
      shipping_provider_id: form.shipping_provider_id ?? null,
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
        <h1>Carrier Service Rules</h1>
        <p>
          Configure which ShipStation carrier service to use based on order pactor, shipping zone, or tags.
          Rules are evaluated highest-priority first — the first matching rule wins.
        </p>
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
              ? 'No carrier service rules yet. Add a rule to define which service to use.'
              : 'No rules match the current filter.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 64 }}>Priority</th>
                <th>Name</th>
                <th>Service</th>
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
                      {serviceLabel(row.carrier_code, row.service_code, row.shipping_provider_id ?? null)}
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
            <h3>{editing ? 'Edit Carrier Service Rule' : 'Add Carrier Service Rule'}</h3>
            <form onSubmit={handleSubmit}>

              {/* Name + Priority */}
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Rule Name *</label>
                  <input
                    required
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Ground for local zones, Overnight for VIP"
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

              {/* Service selector + Active */}
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Carrier Service *</label>
                  <select
                    required
                    value={selectedKey}
                    onChange={e => handleServiceSelect(e.target.value)}
                    style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13, background: '#fff', width: '100%' }}
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
                  {form.carrier_code && (
                    <small style={{ color: '#888', marginTop: 2, display: 'block' }}>
                      Carrier: <code>{form.carrier_code}</code> &nbsp; Service: <code>{form.service_code}</code>
                    </small>
                  )}
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Active</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      id="csr_is_active_cb"
                      checked={form.is_active}
                      onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                      style={{ width: 16, height: 16, cursor: 'pointer' }}
                    />
                    <label htmlFor="csr_is_active_cb" style={{ fontWeight: 400, cursor: 'pointer', marginBottom: 0 }}>
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
  const fieldType = FIELDS.find(f => f.value === cond.field)?.type ?? 'number'

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 8,
      background: '#f8f9fb', border: '1px solid #e8e8e8', borderRadius: 6, padding: '8px 10px',
    }}>
      <select
        value={cond.field}
        onChange={e => onChange('field', e.target.value)}
        style={selectStyle}
      >
        {FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>

      <select
        value={cond.operator}
        onChange={e => onChange('operator', e.target.value)}
        style={{ ...selectStyle, minWidth: 160 }}
      >
        {ops.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
      </select>

      {needsValue && (
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
