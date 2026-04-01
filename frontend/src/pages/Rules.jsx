import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { rulesApi } from '../api'

const ACTION_LABELS = {
  hold: 'Hold — Do not ship',
  dnss: 'DNSS — Do not short ship',
  priority_1: 'Priority 1',
  priority_2: 'Priority 2',
  priority_3: 'Priority 3',
  margin_override: 'Margin Override — Can stage regardless of margin',
}
const ACTION_COLORS = {
  hold: '#fef2f2',
  dnss: '#fff7ed',
  priority_1: '#f0fdf4',
  priority_2: '#f0fdf4',
  priority_3: '#f0fdf4',
  margin_override: '#eff6ff',
}
const EMPTY_FORM = { tag: '', action: 'hold', min_margin_pct_override: '', description: '', priority: 0, is_active: true }

export default function Rules() {
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)

  const { data: orderRules = [], isLoading } = useQuery({ queryKey: ['order-rules'], queryFn: rulesApi.listOrders })
  const { data: availableTags = [] } = useQuery({ queryKey: ['order-tags'], queryFn: rulesApi.listOrderTags })
  const [tagSearch, setTagSearch] = useState('')
  const [showTagDropdown, setShowTagDropdown] = useState(false)
  const createMut = useMutation({ mutationFn: rulesApi.createOrder, onSuccess: () => { qc.invalidateQueries(['order-rules']); closeModal() } })
  const updateMut = useMutation({ mutationFn: ({ id, data }) => rulesApi.updateOrder(id, data), onSuccess: () => { qc.invalidateQueries(['order-rules']); closeModal() } })
  const deleteMut = useMutation({ mutationFn: rulesApi.deleteOrder, onSuccess: () => qc.invalidateQueries(['order-rules']) })
  const pauseMut = useMutation({ mutationFn: rulesApi.pauseOrder, onSuccess: () => qc.invalidateQueries(['order-rules']) })
  const unpauseMut = useMutation({ mutationFn: rulesApi.unpauseOrder, onSuccess: () => qc.invalidateQueries(['order-rules']) })

  function openCreate() { setEditing(null); setForm(EMPTY_FORM); setTagSearch(''); setShowModal(true) }
  function openEdit(row) { setEditing(row); setForm({ ...row, min_margin_pct_override: row.min_margin_pct_override ?? '' }); setTagSearch(row.tag); setShowModal(true) }
  function closeModal() { setShowModal(false); setEditing(null) }
  function handleSubmit(e) {
    e.preventDefault()
    const payload = { ...form, min_margin_pct_override: form.min_margin_pct_override !== '' ? parseFloat(form.min_margin_pct_override) : null, priority: parseInt(form.priority) || 0 }
    if (editing) updateMut.mutate({ id: editing.id, data: payload })
    else createMut.mutate(payload)
  }

  return (
    <div>
      <div className="page-header">
        <h1>Order Rules</h1>
        <p>Tag-based rules that control shipping behavior. Add or edit rules here without touching code.</p>
      </div>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={openCreate}>+ Add Rule</button>
      </div>
      <div className="data-table-wrap">
        {isLoading ? <div className="loading">Loading...</div> : orderRules.length === 0 ? <div className="empty">No rules found.</div> : (
          <table>
            <thead><tr><th>Tag</th><th>Action</th><th>Min Margin Override</th><th>Priority</th><th>Active</th><th>Description</th><th>Actions</th></tr></thead>
            <tbody>{[...orderRules].sort((a,b) => b.priority - a.priority).map(row => (
              <tr key={row.id}>
                <td><span className={`tag tag-${row.tag.toLowerCase()}`}>{row.tag}</span></td>
                <td><span style={{padding:'3px 8px', borderRadius:4, background: ACTION_COLORS[row.action] || '#eee', fontSize:12}}>{ACTION_LABELS[row.action] || row.action}</span></td>
                <td>{row.min_margin_pct_override != null ? `${row.min_margin_pct_override}%` : '—'}</td>
                <td>{row.priority}</td>
                <td><span className={`badge badge-${row.is_active ? 'active' : 'inactive'}`}>{row.is_active ? 'Active' : 'Off'}</span></td>
                <td style={{maxWidth:240, color:'#666'}}>{row.description || '—'}</td>
                <td>
                  <button className="btn btn-secondary btn-sm" onClick={() => openEdit(row)}>Edit</button>{' '}
                  {row.is_active
                    ? <button className="btn btn-secondary btn-sm" onClick={() => pauseMut.mutate(row.id)}>Pause</button>
                    : <button className="btn btn-secondary btn-sm" onClick={() => unpauseMut.mutate(row.id)}>Resume</button>
                  }{' '}
                  <button className="btn btn-danger btn-sm" onClick={() => { if(confirm('Delete rule?')) deleteMut.mutate(row.id) }}>Del</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{editing ? 'Edit Rule' : 'Add Order Rule'}</h3>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group" style={{position:'relative'}}>
                  <label>Shopify Order Tag *</label>
                  <input
                    required
                    value={form.tag}
                    onChange={e => { setForm(f => ({...f, tag: e.target.value})); setTagSearch(e.target.value); setShowTagDropdown(true) }}
                    onFocus={() => { setTagSearch(form.tag); setShowTagDropdown(true) }}
                    onBlur={() => setTimeout(() => setShowTagDropdown(false), 150)}
                    placeholder="Search or type a tag..."
                    autoComplete="off"
                  />
                  {showTagDropdown && (() => {
                    const filtered = availableTags.filter(t => t.toLowerCase().includes((tagSearch || '').toLowerCase()))
                    return filtered.length > 0 ? (
                      <div style={{position:'absolute',top:'100%',left:0,right:0,maxHeight:180,overflowY:'auto',background:'#fff',border:'1px solid #ddd',borderRadius:4,zIndex:10,boxShadow:'0 2px 8px rgba(0,0,0,.12)'}}>
                        {filtered.map(t => (
                          <div key={t} style={{padding:'6px 10px',cursor:'pointer',fontSize:13}} onMouseDown={() => { setForm(f => ({...f, tag: t})); setShowTagDropdown(false) }}
                            onMouseEnter={e => e.currentTarget.style.background='#f0f4ff'} onMouseLeave={e => e.currentTarget.style.background='#fff'}>
                            {t}
                          </div>
                        ))}
                      </div>
                    ) : null
                  })()}
                </div>
                <div className="form-group">
                  <label>Priority (higher = evaluated first)</label>
                  <input type="number" value={form.priority} onChange={e => setForm(f => ({...f, priority: e.target.value}))} />
                </div>
              </div>
              <div className="form-group">
                <label>Action *</label>
                <select value={form.action} onChange={e => setForm(f => ({...f, action: e.target.value}))}>
                  <option value="hold">Hold — Do not ship</option>
                  <option value="dnss">DNSS — Do not short ship</option>
                  <option value="priority_1">Priority 1</option>
                  <option value="priority_2">Priority 2</option>
                  <option value="priority_3">Priority 3</option>
                  <option value="margin_override">Margin Override — Can stage regardless of margin</option>
                </select>
              </div>
              <div className="form-group">
                <label>Min Margin % Override (optional)</label>
                <input type="number" step="0.1" value={form.min_margin_pct_override} onChange={e => setForm(f => ({...f, min_margin_pct_override: e.target.value}))} placeholder="Leave blank to use global threshold" />
              </div>
              <div className="form-group">
                <label>Active</label>
                <select value={String(form.is_active)} onChange={e => setForm(f => ({...f, is_active: e.target.value === 'true'}))}>
                  <option value="true">Active</option>
                  <option value="false">Disabled</option>
                </select>
              </div>
              <div className="form-group"><label>Description</label><textarea value={form.description} onChange={e => setForm(f => ({...f, description: e.target.value}))} /></div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={closeModal}>Cancel</button>
                <button type="submit" className="btn btn-primary">{editing ? 'Save' : 'Add Rule'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
