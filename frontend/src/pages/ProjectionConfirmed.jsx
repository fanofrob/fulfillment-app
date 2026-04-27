import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { projectionPeriodsApi, projectionConfirmedOrdersApi } from '../api'
import StagingPage from '../components/staging/StagingPage'

export default function ProjectionConfirmed() {
  const qc = useQueryClient()
  const [periodId, setPeriodId] = useState(null)

  const { data: periods = [] } = useQuery({
    queryKey: ['projection-periods', 'active'],
    queryFn: () => projectionPeriodsApi.list({ status: 'active' }),
  })

  const period = useMemo(() => periods.find(p => p.id === periodId) || null, [periods, periodId])

  const { data: stagedBlocking = { staged_count: 0 } } = useQuery({
    queryKey: ['projection-staged-blocking', periodId],
    queryFn: () => projectionConfirmedOrdersApi.getStagedBlocking(periodId),
    enabled: !!periodId,
    refetchInterval: 15000,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['confirmed-orders-enriched', periodId] })
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

  const header = (
    <div className="page-header" style={{ marginBottom: 16 }}>
      <h1>Confirmed Demand Dashboard</h1>
      <p>
        View confirmed orders, inventory status, and short-ship / inventory-hold configuration. This
        dashboard's short-ship/hold config drives the confirmed-demand rollup and the Confirmed
        Orders view for the same period — independent of Staging.
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>Period:</label>
        <select
          value={periodId || ''}
          onChange={e => setPeriodId(e.target.value ? Number(e.target.value) : null)}
          style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 240 }}
        >
          <option value="">— Select period —</option>
          {periods.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        {periodId && (
          <>
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
                padding: '4px 10px', background: '#fee2e2',
                color: '#991b1b', borderRadius: 6, fontSize: 12, fontWeight: 500,
              }}>
                ⚠ {stagedBlocking.staged_count} order(s) staged in Operations — unstage before saving
              </span>
            )}

            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saveMutation.isPending}
              title="Roll up confirmed orders' demand and write to this period as the manual override"
              style={{ marginLeft: 'auto' }}
            >
              {saveMutation.isPending ? 'Saving…' : '✓ Save Confirmed Demand'}
            </button>
            {period?.has_manual_confirmed_demand && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleRevert}
                disabled={revertMutation.isPending}
                title="Clear manual override; auto-calculated demand will be used"
              >
                {revertMutation.isPending ? 'Reverting…' : '↺ Revert to Auto'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )

  return (
    <StagingPage
      mode="confirmed-demand"
      periodId={periodId}
      header={header}
    />
  )
}
