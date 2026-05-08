import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import { pickupRunsApi, purchaseOrdersApi } from '../api'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function formatDate(d) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function mapsLink(addr) {
  if (!addr) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`
}

function telLink(phone) {
  if (!phone) return null
  return `tel:${phone.replace(/[^\d+]/g, '')}`
}

function whatsappLink(phone) {
  if (!phone) return null
  return `https://wa.me/${phone.replace(/[^\d]/g, '')}`
}

// Pick the vendor name to show as the group header. If pickups are consolidated
// at a known vendor, that's the host. Otherwise, if every PO at this stop ships
// from the same seller, use that seller's name. If sellers are mixed (e.g. a
// shared custom override address), fall back to a count.
function groupVendorLabel(g) {
  if (g.consolidator_vendor_name) return g.consolidator_vendor_name
  const sellers = [...new Set(g.pos.map(p => p.seller_vendor_name).filter(Boolean))]
  if (sellers.length === 1) return sellers[0]
  if (sellers.length > 1) return `${sellers.length} vendors`
  return null
}

export default function PickupRuns() {
  const [date, setDate] = useState(todayIso())
  const location = useLocation()
  const qc = useQueryClient()
  const inPackingMode = location.pathname.startsWith('/packing')
  const poHref = (poId) => inPackingMode
    ? `/packing?tab=purchase-orders${poId != null ? `&po=${poId}` : ''}`
    : `/purchase-orders${poId != null ? `?po=${poId}` : ''}`

  const { data, isLoading, error } = useQuery({
    queryKey: ['pickup-runs', date],
    queryFn: () => pickupRunsApi.get(date),
  })

  const markPickedUpMut = useMutation({
    mutationFn: (poId) => purchaseOrdersApi.update(poId, { status: 'in_transit' }),
    onSuccess: () => {
      qc.invalidateQueries(['pickup-runs'])
      qc.invalidateQueries(['purchase-orders'])
    },
    onError: (err) => alert('Failed to mark picked up: ' + (err.response?.data?.detail || err.message)),
  })

  function confirmMarkPickedUp(po) {
    const msg = `Mark ${po.po_number} (${po.seller_vendor_name || 'vendor'}) as picked up?\n\nThis moves the PO to "In Transit".`
    if (window.confirm(msg)) markPickedUpMut.mutate(po.id)
  }

  const groups = data?.groups || []
  const totalPos = groups.reduce((s, g) => s + g.po_count, 0)
  const totalCases = groups.reduce((s, g) => s + (g.total_cases || 0), 0)
  const totalWeight = groups.reduce((s, g) => s + (g.total_weight_lbs || 0), 0)

  return (
    <div className="pickup-runs-page">
      {/* Print-only stylesheet: hide the sidebar + header controls when printing */}
      <style>{`
        @media print {
          nav.sidebar, .pickup-runs-controls, .pickup-runs-noprint { display: none !important; }
          .main-content { padding: 0 !important; }
          .pickup-group { break-inside: avoid; page-break-inside: avoid; border: 1px solid #000 !important; }
          body { font-size: 12pt; }
        }
        .pickup-group { border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; margin-bottom: 16px; background: #fff; }
        .pickup-po { padding: 8px 0; border-top: 1px dashed #e5e7eb; }
        .pickup-po:first-of-type { border-top: none; }
      `}</style>

      <div className="pickup-runs-controls" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>Pickup Runs</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#6b7280' }}>Date:</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          <button className="btn btn-sm" onClick={() => setDate(todayIso())}>Today</button>
          <button className="btn btn-sm btn-primary" onClick={() => window.print()}>🖨 Print Manifest</button>
        </div>
      </div>

      {/* Print-friendly header */}
      <div style={{ marginBottom: 16, padding: 12, background: '#f9fafb', borderRadius: 6 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Driver Manifest — {formatDate(date)}</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
          {totalPos} PO{totalPos === 1 ? '' : 's'} across {groups.length} pickup location{groups.length === 1 ? '' : 's'}
          {totalCases > 0 && <> · {totalCases.toFixed(0)} cases</>}
          {totalWeight > 0 && <> · {totalWeight.toFixed(0)} lbs</>}
        </div>
        {data?.unscheduled_count > 0 && (
          <div className="pickup-runs-noprint" style={{ marginTop: 8, padding: 8, background: '#fef3c7', borderRadius: 4, fontSize: 13 }}>
            ⚠ {data.unscheduled_count} eligible PO{data.unscheduled_count === 1 ? '' : 's'} {data.unscheduled_count === 1 ? 'has' : 'have'} no pickup date set —{' '}
            <Link to={poHref()}>open Purchase Orders</Link> to schedule.
          </div>
        )}
      </div>

      {isLoading && <p>Loading…</p>}
      {error && <p style={{ color: '#dc2626' }}>Failed to load pickup run: {error.message}</p>}
      {!isLoading && groups.length === 0 && (
        <p style={{ color: '#6b7280', textAlign: 'center', marginTop: 40 }}>
          No pickups scheduled for {formatDate(date)}. Set a pickup date on a PO to add it here.
        </p>
      )}

      {groups.map((g, idx) => {
        const vendorLabel = groupVendorLabel(g)
        return (
        <div key={idx} className="pickup-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div>
              {vendorLabel && (
                <div style={{ fontSize: 16, fontWeight: 600 }}>
                  {vendorLabel}
                  {g.consolidator_vendor_name && (
                    <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: '#6b7280' }}>
                      (consolidated pickup)
                    </span>
                  )}
                </div>
              )}
              <div style={{ fontSize: 14, marginTop: 2 }}>
                {g.address ? (
                  <a href={mapsLink(g.address)} target="_blank" rel="noreferrer" style={{ color: '#2563eb', textDecoration: 'none' }}>
                    {g.address}
                  </a>
                ) : (
                  <em style={{ color: '#dc2626' }}>No address — see PO contact info below</em>
                )}
              </div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 13, color: '#6b7280' }}>
              {g.po_count} PO{g.po_count === 1 ? '' : 's'}
              {g.total_cases > 0 && <div>{g.total_cases.toFixed(0)} cases</div>}
              {g.total_weight_lbs > 0 && <div>{g.total_weight_lbs.toFixed(0)} lbs</div>}
            </div>
          </div>

          {g.pos.map(po => {
            const isPickedUp = po.status !== 'placed'  // anything past "placed" = already picked up
            return (
            <div key={po.id} className="pickup-po" style={{ opacity: isPickedUp ? 0.55 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    <Link to={poHref(po.id)} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {po.po_number}
                    </Link>
                    {' · '}
                    {po.seller_vendor_name}
                  </div>
                  {po.pickup_at_vendor_name && (
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      Goods from {po.seller_vendor_name} — picking up at {po.pickup_at_vendor_name}'s location
                    </div>
                  )}
                  {po.delivery_location && (
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                      → Deliver to: {po.delivery_location}
                    </div>
                  )}
                  {(po.delivery_notes || po.notes) && (
                    <div style={{ fontSize: 12, color: '#6b7280', fontStyle: 'italic', marginTop: 2 }}>
                      {[po.delivery_notes, po.notes].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 12, textAlign: 'right' }}>
                  <div style={{
                    display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11,
                    background: po.status === 'placed' ? '#bfdbfe' : po.status === 'in_transit' ? '#c4b5fd' : '#fde68a',
                    textTransform: 'capitalize',
                  }}>{po.status.replace(/_/g, ' ')}</div>
                  <div style={{ marginTop: 4, color: '#6b7280' }}>
                    {(po.seller_contact_name || po.seller_contact_phone) && (
                      <div>
                        {po.seller_contact_name}
                        {po.seller_contact_phone && (
                          <> · <a href={telLink(po.seller_contact_phone)} style={{ color: '#2563eb' }}>{po.seller_contact_phone}</a></>
                        )}
                        {po.seller_contact_whatsapp && (
                          <> · <a href={whatsappLink(po.seller_contact_whatsapp)} target="_blank" rel="noreferrer" style={{ color: '#16a34a' }}>WhatsApp</a></>
                        )}
                      </div>
                    )}
                    {po.driver_name && <div>Driver: {po.driver_name}</div>}
                  </div>
                  <div className="pickup-runs-noprint" style={{ marginTop: 6 }}>
                    {po.status === 'placed' ? (
                      <button className="btn btn-sm btn-primary"
                        disabled={markPickedUpMut.isPending}
                        onClick={() => confirmMarkPickedUp(po)}
                      >Mark Picked Up</button>
                    ) : (
                      <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>✓ Picked up</span>
                    )}
                  </div>
                </div>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 6 }}>
                <thead>
                  <tr style={{ color: '#6b7280' }}>
                    <th style={{ padding: '2px 4px', textAlign: 'left', fontWeight: 500 }}>Product</th>
                    <th style={{ padding: '2px 4px', textAlign: 'right', fontWeight: 500 }}>Cases</th>
                    <th style={{ padding: '2px 4px', textAlign: 'right', fontWeight: 500 }}>Case Wt</th>
                    <th style={{ padding: '2px 4px', textAlign: 'right', fontWeight: 500 }}>Total Wt</th>
                    <th style={{ padding: '2px 4px', textAlign: 'left', fontWeight: 500 }}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((line, li) => (
                    <tr key={li}>
                      <td style={{ padding: '2px 4px' }}>{line.product_type}</td>
                      <td style={{ padding: '2px 4px', textAlign: 'right' }}>{line.quantity_cases}</td>
                      <td style={{ padding: '2px 4px', textAlign: 'right' }}>{line.case_weight_lbs ? `${line.case_weight_lbs} lbs` : '—'}</td>
                      <td style={{ padding: '2px 4px', textAlign: 'right' }}>{line.total_weight_lbs ? `${line.total_weight_lbs.toFixed(1)} lbs` : '—'}</td>
                      <td style={{ padding: '2px 4px', color: '#6b7280' }}>{line.notes || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )
          })}
        </div>
        )
      })}
    </div>
  )
}
