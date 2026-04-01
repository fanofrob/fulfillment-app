import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { rateCardApi } from '../api'

export default function RateCards() {
  const qc = useQueryClient()
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['rate-cards'],
    queryFn: () => rateCardApi.list({ limit: 2000 }),
    retry: false,
  })
  const refreshMut = useMutation({
    mutationFn: rateCardApi.refresh,
    onSuccess: () => qc.invalidateQueries(['rate-cards']),
  })
  const rebuildMut = useMutation({
    mutationFn: rateCardApi.rebuildUps,
    onSuccess: () => qc.invalidateQueries(['rate-cards']),
  })

  const is503 = error?.response?.status === 503
  const flatRate = data.filter(r => r.is_flat_rate)
  const weightBased = data.filter(r => !r.is_flat_rate)

  // Group weight-based rates by "carrier — service_name"
  const serviceGroups = {}
  for (const r of weightBased) {
    const key = `${r.carrier}||${r.service_name}`
    if (!serviceGroups[key]) serviceGroups[key] = { carrier: r.carrier, service_name: r.service_name, rows: [] }
    serviceGroups[key].rows.push(r)
  }

  return (
    <div>
      <div className="page-header">
        <h1>Rate Cards</h1>
        <p>USPS rates live from Google Sheets. UPS rates fetched live from ShipStation.</p>
      </div>

      {is503 && <div className="error-msg">Google Sheets not connected. Add credentials.json to the backend folder first.</div>}

      {!is503 && (
        <>
          <div className="toolbar">
            <button className="btn btn-secondary" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending || rebuildMut.isPending}>
              {refreshMut.isPending ? 'Refreshing...' : '↻ Refresh from Sheets'}
            </button>
            <button className="btn btn-secondary" onClick={() => rebuildMut.mutate()} disabled={rebuildMut.isPending || refreshMut.isPending}>
              {rebuildMut.isPending ? 'Fetching UPS rates (~60s)...' : '↻ Rebuild UPS from ShipStation'}
            </button>
            {rebuildMut.isSuccess && (
              <span style={{fontSize:13, color:'#555'}}>
                Done — {rebuildMut.data?.inserted} rates inserted
              </span>
            )}
            {rebuildMut.isError && (
              <span style={{fontSize:13, color:'red'}}>
                Error: {rebuildMut.error?.response?.data?.detail || rebuildMut.error?.message}
              </span>
            )}
          </div>

          {isLoading ? <div className="loading">Loading rate cards...</div>
            : error ? <div className="error-msg">Error: {error.message}</div>
            : (
            <>
              {flatRate.length > 0 && (
                <>
                  <h3 style={{marginBottom:12, fontWeight:600, fontSize:15}}>Flat Rate Options</h3>
                  <div className="data-table-wrap" style={{marginBottom:28}}>
                    <table>
                      <thead><tr><th>Carrier</th><th>Service</th><th>Rate (any zone)</th><th>Effective Date</th></tr></thead>
                      <tbody>{flatRate.map((r,i) => (
                        <tr key={i}><td>{r.carrier}</td><td>{r.service_name}</td><td><strong>${r.rate?.toFixed(2)}</strong></td><td>{r.effective_date}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </>
              )}

              {Object.values(serviceGroups).map(({ carrier, service_name, rows }) => {
                const zones = [...new Set(rows.map(r => r.zone))].filter(Boolean).sort((a,b) => a-b)
                const weights = [...new Set(rows.map(r => r.weight_lb))].sort((a,b) => a-b)
                function getRate(w, z) { return rows.find(r => r.weight_lb === w && r.zone === z)?.rate }
                return (
                  <div key={`${carrier}||${service_name}`} style={{marginBottom:32}}>
                    <h3 style={{marginBottom:12, fontWeight:600, fontSize:15}}>{carrier} — {service_name} — by Weight &amp; Zone</h3>
                    <div className="data-table-wrap" style={{overflowX:'auto'}}>
                      <table>
                        <thead><tr><th>Weight</th>{zones.map(z => <th key={z}>Zone {z}</th>)}</tr></thead>
                        <tbody>{weights.map(w => (
                          <tr key={w}>
                            <td><strong>{w} lb</strong></td>
                            {zones.map(z => { const r = getRate(w,z); return <td key={z} style={{color: r ? 'inherit' : '#ccc'}}>{r ? `$${r.toFixed(2)}` : '—'}</td> })}
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </div>
                )
              })}

              {data.length === 0 && <div className="empty">No rate card data loaded.</div>}
            </>
          )}
        </>
      )}
    </div>
  )
}
