import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { projectionPeriodsApi, projectionConfirmedOrdersApi } from '../api'

export default function ProjectionConfirmed() {
  const qc = useQueryClient()
  const [periodId, setPeriodId] = useState(null)
  const [selected, setSelected] = useState(new Set())

  const { data: periods = [] } = useQuery({
    queryKey: ['projection-periods', 'active'],
    queryFn: () => projectionPeriodsApi.list({ status: 'active' }),
  })

  const period = useMemo(() => periods.find(p => p.id === periodId) || null, [periods, periodId])

  const { data: confirmedOrders = [] } = useQuery({
    queryKey: ['projection-confirmed-orders', periodId],
    queryFn: () => projectionConfirmedOrdersApi.list(periodId),
    enabled: !!periodId,
  })

  const { data: rollup = { rollup_lbs_by_product_type: {} } } = useQuery({
    queryKey: ['projection-confirmed-rollup', periodId],
    queryFn: () => projectionConfirmedOrdersApi.getRollup(periodId),
    enabled: !!periodId,
  })

  const { data: stagedBlocking = { staged_count: 0 } } = useQuery({
    queryKey: ['projection-staged-blocking', periodId],
    queryFn: () => projectionConfirmedOrdersApi.getStagedBlocking(periodId),
    enabled: !!periodId,
    refetchInterval: 15000,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['projection-confirmed-orders', periodId] })
    qc.invalidateQueries({ queryKey: ['projection-confirmed-rollup', periodId] })
    qc.invalidateQueries({ queryKey: ['projection-periods'] })
  }

  const saveMutation = useMutation({
    mutationFn: () => projectionConfirmedOrdersApi.saveConfirmedDemand(periodId),
    onSuccess: () => { invalidate(); alert('Confirmed demand saved to period.') },
    onError: (err) => alert(`Save failed: ${err?.response?.data?.detail || err?.message || 'Unknown error'}`),
  })

  const revertMutation = useMutation({
    mutationFn: () => projectionConfirmedOrdersApi.revertConfirmedDemand(periodId),
    onSuccess: () => { invalidate(); alert('Reverted to auto-calculated confirmed demand.') },
    onError: (err) => alert(`Revert failed: ${err?.response?.data?.detail || err?.message || 'Unknown error'}`),
  })

  const unconfirmMutation = useMutation({
    mutationFn: (ids) => projectionConfirmedOrdersApi.unconfirmOrders(periodId, { order_ids: ids }),
    onSuccess: () => { invalidate(); setSelected(new Set()) },
  })

  const handleSave = () => {
    if (stagedBlocking.staged_count > 0) {
      alert(
        `Cannot save: ${stagedBlocking.staged_count} order(s) are currently staged in Operations. ` +
        `Unstage all orders before saving confirmed demand.`
      )
      return
    }
    if (period?.has_manual_confirmed_demand) {
      if (!confirm('This will overwrite the previously-saved manual confirmed demand for this period. Continue?')) return
    }
    saveMutation.mutate()
  }

  const handleRevert = () => {
    if (!confirm('Revert to auto-calculated confirmed demand? Saved manual values will be cleared.')) return
    revertMutation.mutate()
  }

  const handleUnconfirm = () => {
    if (selected.size === 0) return
    if (!confirm(`Unconfirm ${selected.size} order(s)?`)) return
    unconfirmMutation.mutate([...selected])
  }

  const toggleOne = (id) => setSelected(s => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n
  })

  const toggleAll = () => {
    if (selected.size === confirmedOrders.length) setSelected(new Set())
    else setSelected(new Set(confirmedOrders.map(o => o.shopify_order_id)))
  }

  const totalLbs = useMemo(() => {
    const r = rollup.rollup_lbs_by_product_type || {}
    return Object.values(r).reduce((s, v) => s + (Number(v) || 0), 0)
  }, [rollup])

  return (
    <div>
      <div className="page-header">
        <h1>Projection Confirmed Demand</h1>
        <p>Review confirmed orders for a projection period and save the rolled-up demand to the period. Save overrides the auto-calculated confirmed demand; Revert clears the override.</p>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <label style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>Period:</label>
        <select
          value={periodId || ''}
          onChange={e => { setPeriodId(e.target.value ? Number(e.target.value) : null); setSelected(new Set()) }}
          style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 240 }}
        >
          <option value="">— Select period —</option>
          {periods.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {!periodId && (
        <div className="empty" style={{ padding: 24, color: '#6b7280' }}>Select a projection period to review confirmed demand.</div>
      )}

      {periodId && (
        <>
          {/* Status strip */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 16, padding: 12,
            background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 16,
          }}>
            <span style={{
              padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
              background: period?.has_manual_confirmed_demand ? '#dbeafe' : '#f3f4f6',
              color: period?.has_manual_confirmed_demand ? '#1e40af' : '#4b5563',
            }}>
              {period?.has_manual_confirmed_demand ? 'MANUAL' : 'AUTO'}
            </span>
            {period?.confirmed_demand_saved_at && (
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                Last saved: {new Date(period.confirmed_demand_saved_at).toLocaleString()}
              </span>
            )}
            {stagedBlocking.staged_count > 0 && (
              <span style={{
                marginLeft: 'auto', padding: '4px 10px', background: '#fee2e2',
                color: '#991b1b', borderRadius: 6, fontSize: 12, fontWeight: 500,
              }}>
                ⚠ {stagedBlocking.staged_count} order(s) staged in Operations — unstage before saving
              </span>
            )}
          </div>

          {/* Rollup */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>
              Rollup (pending save)
            </div>
            <table className="table" style={{ maxWidth: 420 }}>
              <thead>
                <tr>
                  <th>Product Type</th>
                  <th style={{ textAlign: 'right' }}>Lbs</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(rollup.rollup_lbs_by_product_type || {}).length === 0 ? (
                  <tr><td colSpan={2} style={{ color: '#9ca3af' }}>No confirmed orders yet.</td></tr>
                ) : (
                  Object.entries(rollup.rollup_lbs_by_product_type)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([pt, lbs]) => (
                      <tr key={pt}>
                        <td>{pt}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Number(lbs).toFixed(2)}</td>
                      </tr>
                    ))
                )}
              </tbody>
              {totalLbs > 0 && (
                <tfoot>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Total</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{totalLbs.toFixed(2)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saveMutation.isPending || confirmedOrders.length === 0}
              title={confirmedOrders.length === 0 ? 'Confirm at least one order first' : 'Write rolled-up demand to the period'}
            >
              {saveMutation.isPending ? 'Saving…' : '✓ Save Confirmed Demand'}
            </button>
            {period?.has_manual_confirmed_demand && (
              <button
                className="btn btn-secondary"
                onClick={handleRevert}
                disabled={revertMutation.isPending}
                title="Clear manual override; auto-calculated demand will be used"
              >
                {revertMutation.isPending ? 'Reverting…' : '↺ Revert to Auto'}
              </button>
            )}
            {selected.size > 0 && (
              <button
                className="btn btn-secondary"
                onClick={handleUnconfirm}
                disabled={unconfirmMutation.isPending}
              >
                {unconfirmMutation.isPending ? 'Removing…' : `✕ Unconfirm Selected (${selected.size})`}
              </button>
            )}
          </div>

          {/* Confirmed orders list */}
          <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6 }}>
            Confirmed Orders ({confirmedOrders.length})
          </div>
          {confirmedOrders.length === 0 ? (
            <div className="empty" style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>
              No orders confirmed for this period yet. Confirm orders from the Projection Orders page.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={selected.size === confirmedOrders.length && confirmedOrders.length > 0}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>Order</th>
                  <th>Mapping Used</th>
                  <th>Box Items</th>
                  <th style={{ textAlign: 'right' }}>Lbs</th>
                  <th>Confirmed At</th>
                </tr>
              </thead>
              <tbody>
                {confirmedOrders.map(co => {
                  const lbs = (co.boxes_snapshot || []).reduce(
                    (s, it) => s + (Number(it.quantity) || 0) * (Number(it.weight_lb) || 0), 0
                  )
                  return (
                    <tr key={co.shopify_order_id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(co.shopify_order_id)}
                          onChange={() => toggleOne(co.shopify_order_id)}
                        />
                      </td>
                      <td style={{ fontWeight: 500 }}>#{co.shopify_order_id}</td>
                      <td style={{ fontSize: 12, color: '#6b7280' }}>{co.mapping_used}</td>
                      <td style={{ fontSize: 12, color: '#6b7280' }}>{(co.boxes_snapshot || []).length} item(s)</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{lbs.toFixed(2)}</td>
                      <td style={{ fontSize: 12, color: '#9ca3af' }}>
                        {co.confirmed_at ? new Date(co.confirmed_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
