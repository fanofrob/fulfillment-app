import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { vendorsApi } from '../api'

const COMM_OPTIONS = ['whatsapp', 'email', 'phone']

const EMPTY_VENDOR = {
  name: '', contact_name: '', contact_email: '', contact_phone: '',
  contact_whatsapp: '', preferred_communication: 'email', notes: '', is_active: true,
}

const EMPTY_PRODUCT = {
  product_type: '', default_case_weight_lbs: '', default_case_count: '',
  default_price_per_case: '', default_price_per_lb: '', lead_time_days: '',
  order_unit: 'case', is_preferred: false, notes: '',
}

export default function Vendors() {
  const qc = useQueryClient()
  const [showVendorModal, setShowVendorModal] = useState(false)
  const [showProductModal, setShowProductModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [editingProduct, setEditingProduct] = useState(null)
  const [vendorForm, setVendorForm] = useState(EMPTY_VENDOR)
  const [productForm, setProductForm] = useState(EMPTY_PRODUCT)
  const [activeVendorId, setActiveVendorId] = useState(null)
  const [expandedVendor, setExpandedVendor] = useState(null)

  const { data: vendors = [], isLoading } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => vendorsApi.list(),
  })

  const createVendorMut = useMutation({
    mutationFn: vendorsApi.create,
    onSuccess: () => { qc.invalidateQueries(['vendors']); closeVendorModal() },
  })
  const updateVendorMut = useMutation({
    mutationFn: ({ id, data }) => vendorsApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries(['vendors']); closeVendorModal() },
  })
  const deleteVendorMut = useMutation({
    mutationFn: vendorsApi.delete,
    onSuccess: () => qc.invalidateQueries(['vendors']),
  })

  const addProductMut = useMutation({
    mutationFn: ({ vendorId, data }) => vendorsApi.addProduct(vendorId, data),
    onSuccess: () => { qc.invalidateQueries(['vendors']); closeProductModal() },
  })
  const updateProductMut = useMutation({
    mutationFn: ({ vendorId, productId, data }) => vendorsApi.updateProduct(vendorId, productId, data),
    onSuccess: () => { qc.invalidateQueries(['vendors']); closeProductModal() },
  })
  const deleteProductMut = useMutation({
    mutationFn: ({ vendorId, productId }) => vendorsApi.deleteProduct(vendorId, productId),
    onSuccess: () => qc.invalidateQueries(['vendors']),
  })

  function closeVendorModal() {
    setShowVendorModal(false)
    setEditing(null)
    setVendorForm(EMPTY_VENDOR)
  }

  function closeProductModal() {
    setShowProductModal(false)
    setEditingProduct(null)
    setProductForm(EMPTY_PRODUCT)
  }

  function openEditVendor(v) {
    setEditing(v)
    setVendorForm({
      name: v.name || '', contact_name: v.contact_name || '', contact_email: v.contact_email || '',
      contact_phone: v.contact_phone || '', contact_whatsapp: v.contact_whatsapp || '',
      preferred_communication: v.preferred_communication || 'email', notes: v.notes || '',
      is_active: v.is_active,
    })
    setShowVendorModal(true)
  }

  function openEditProduct(vendorId, p) {
    setActiveVendorId(vendorId)
    setEditingProduct(p)
    setProductForm({
      product_type: p.product_type || '', default_case_weight_lbs: p.default_case_weight_lbs ?? '',
      default_case_count: p.default_case_count ?? '', default_price_per_case: p.default_price_per_case ?? '',
      default_price_per_lb: p.default_price_per_lb ?? '', lead_time_days: p.lead_time_days ?? '',
      order_unit: p.order_unit || 'case', is_preferred: p.is_preferred || false, notes: p.notes || '',
    })
    setShowProductModal(true)
  }

  function handleVendorSubmit(e) {
    e.preventDefault()
    if (editing) {
      updateVendorMut.mutate({ id: editing.id, data: vendorForm })
    } else {
      createVendorMut.mutate(vendorForm)
    }
  }

  function handleProductSubmit(e) {
    e.preventDefault()
    const data = {
      ...productForm,
      default_case_weight_lbs: productForm.default_case_weight_lbs ? Number(productForm.default_case_weight_lbs) : null,
      default_case_count: productForm.default_case_count ? Number(productForm.default_case_count) : null,
      default_price_per_case: productForm.default_price_per_case ? Number(productForm.default_price_per_case) : null,
      default_price_per_lb: productForm.default_price_per_lb ? Number(productForm.default_price_per_lb) : null,
      lead_time_days: productForm.lead_time_days ? Number(productForm.lead_time_days) : null,
    }
    if (editingProduct) {
      updateProductMut.mutate({ vendorId: activeVendorId, productId: editingProduct.id, data })
    } else {
      addProductMut.mutate({ vendorId: activeVendorId, data })
    }
  }

  const vf = (field) => (e) => setVendorForm({ ...vendorForm, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const pf = (field) => (e) => setProductForm({ ...productForm, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Vendor Management</h1>
        <button className="btn btn-primary" onClick={() => setShowVendorModal(true)}>+ Add Vendor</button>
      </div>

      {isLoading && <p>Loading...</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {vendors.map(v => (
          <div key={v.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 16, background: v.is_active ? '#fff' : '#f9fafb' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: '0 0 4px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {v.name}
                  {!v.is_active && <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 400 }}>Inactive</span>}
                </h3>
                <div style={{ fontSize: 13, color: '#6b7280' }}>
                  {v.contact_name && <span>{v.contact_name} &middot; </span>}
                  {v.preferred_communication && <span style={{ textTransform: 'capitalize' }}>{v.preferred_communication}</span>}
                  {v.contact_email && <span> &middot; {v.contact_email}</span>}
                  {v.contact_phone && <span> &middot; {v.contact_phone}</span>}
                </div>
                {v.notes && <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 4 }}>{v.notes}</div>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-sm" onClick={() => openEditVendor(v)}>Edit</button>
                <button className="btn btn-sm btn-danger" onClick={() => { if (confirm('Delete vendor?')) deleteVendorMut.mutate(v.id) }}>Delete</button>
              </div>
            </div>

            {/* Products */}
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  Products ({v.products?.length || 0})
                  <button
                    style={{ marginLeft: 8, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer' }}
                    onClick={() => setExpandedVendor(expandedVendor === v.id ? null : v.id)}
                  >
                    {expandedVendor === v.id ? 'Collapse' : 'Expand'}
                  </button>
                </span>
                <button className="btn btn-sm" onClick={() => { setActiveVendorId(v.id); setShowProductModal(true) }}>+ Product</button>
              </div>

              {expandedVendor === v.id && v.products?.length > 0 && (
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
                      <th style={{ padding: '4px 8px' }}>Product Type</th>
                      <th style={{ padding: '4px 8px' }}>Case Wt (lbs)</th>
                      <th style={{ padding: '4px 8px' }}>$/Case</th>
                      <th style={{ padding: '4px 8px' }}>$/lb</th>
                      <th style={{ padding: '4px 8px' }}>Lead Time</th>
                      <th style={{ padding: '4px 8px' }}>Unit</th>
                      <th style={{ padding: '4px 8px' }}>Pref</th>
                      <th style={{ padding: '4px 8px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.products.map(p => (
                      <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '4px 8px', fontWeight: 500 }}>{p.product_type}</td>
                        <td style={{ padding: '4px 8px' }}>{p.default_case_weight_lbs ?? '—'}</td>
                        <td style={{ padding: '4px 8px' }}>{p.default_price_per_case != null ? `$${p.default_price_per_case.toFixed(2)}` : '—'}</td>
                        <td style={{ padding: '4px 8px' }}>{p.default_price_per_lb != null ? `$${p.default_price_per_lb.toFixed(2)}` : '—'}</td>
                        <td style={{ padding: '4px 8px' }}>{p.lead_time_days != null ? `${p.lead_time_days}d` : '—'}</td>
                        <td style={{ padding: '4px 8px' }}>{p.order_unit || '—'}</td>
                        <td style={{ padding: '4px 8px' }}>{p.is_preferred ? 'Yes' : ''}</td>
                        <td style={{ padding: '4px 8px', display: 'flex', gap: 4 }}>
                          <button className="btn btn-xs" onClick={() => openEditProduct(v.id, p)}>Edit</button>
                          <button className="btn btn-xs btn-danger" onClick={() => { if (confirm('Delete product?')) deleteProductMut.mutate({ vendorId: v.id, productId: p.id }) }}>Del</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ))}
      </div>

      {vendors.length === 0 && !isLoading && (
        <p style={{ color: '#6b7280', textAlign: 'center', marginTop: 40 }}>No vendors yet. Click "+ Add Vendor" to get started.</p>
      )}

      {/* Vendor Modal */}
      {showVendorModal && (
        <div className="modal-overlay" onClick={closeVendorModal}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h2>{editing ? 'Edit Vendor' : 'New Vendor'}</h2>
            <form onSubmit={handleVendorSubmit}>
              <div className="form-group">
                <label>Name *</label>
                <input required value={vendorForm.name} onChange={vf('name')} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>Contact Name</label>
                  <input value={vendorForm.contact_name} onChange={vf('contact_name')} />
                </div>
                <div className="form-group">
                  <label>Preferred Communication</label>
                  <select value={vendorForm.preferred_communication} onChange={vf('preferred_communication')}>
                    {COMM_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Email</label>
                  <input type="email" value={vendorForm.contact_email} onChange={vf('contact_email')} />
                </div>
                <div className="form-group">
                  <label>Phone</label>
                  <input value={vendorForm.contact_phone} onChange={vf('contact_phone')} />
                </div>
                <div className="form-group">
                  <label>WhatsApp</label>
                  <input value={vendorForm.contact_whatsapp} onChange={vf('contact_whatsapp')} />
                </div>
                <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 24 }}>
                  <input type="checkbox" checked={vendorForm.is_active} onChange={vf('is_active')} />
                  <label style={{ margin: 0 }}>Active</label>
                </div>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea value={vendorForm.notes} onChange={vf('notes')} rows={2} />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button type="button" className="btn" onClick={closeVendorModal}>Cancel</button>
                <button type="submit" className="btn btn-primary">
                  {editing ? 'Save' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Product Modal */}
      {showProductModal && (
        <div className="modal-overlay" onClick={closeProductModal}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h2>{editingProduct ? 'Edit Product' : 'Add Product'}</h2>
            <form onSubmit={handleProductSubmit}>
              <div className="form-group">
                <label>Product Type *</label>
                <input required value={productForm.product_type} onChange={pf('product_type')} placeholder='e.g., "Fruit: Mango, Honey"' />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>Case Weight (lbs)</label>
                  <input type="number" step="0.01" value={productForm.default_case_weight_lbs} onChange={pf('default_case_weight_lbs')} />
                </div>
                <div className="form-group">
                  <label>Pieces per Case</label>
                  <input type="number" value={productForm.default_case_count} onChange={pf('default_case_count')} />
                </div>
                <div className="form-group">
                  <label>Price per Case ($)</label>
                  <input type="number" step="0.01" value={productForm.default_price_per_case} onChange={pf('default_price_per_case')} />
                </div>
                <div className="form-group">
                  <label>Price per lb ($)</label>
                  <input type="number" step="0.01" value={productForm.default_price_per_lb} onChange={pf('default_price_per_lb')} />
                </div>
                <div className="form-group">
                  <label>Lead Time (days)</label>
                  <input type="number" value={productForm.lead_time_days} onChange={pf('lead_time_days')} />
                </div>
                <div className="form-group">
                  <label>Order Unit</label>
                  <select value={productForm.order_unit} onChange={pf('order_unit')}>
                    <option value="case">Case</option>
                    <option value="lb">Lb</option>
                    <option value="piece">Piece</option>
                  </select>
                </div>
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={productForm.is_preferred} onChange={pf('is_preferred')} />
                <label style={{ margin: 0 }}>Preferred vendor for this product type</label>
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea value={productForm.notes} onChange={pf('notes')} rows={2} />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button type="button" className="btn" onClick={closeProductModal}>Cancel</button>
                <button type="submit" className="btn btn-primary">
                  {editingProduct ? 'Save' : 'Add'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
