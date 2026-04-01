import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { skuMappingApi } from '../api'

const ERROR_LABELS = {
  missing_pick_sku: 'No pick SKU',
  invalid_mix_qty:  'Invalid mix qty',
}

export default function SkuMapping() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [warehouse, setWarehouse] = useState('')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [page, setPage] = useState(0)
  const limit = errorsOnly ? 500 : 50

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['sku-mappings', search, warehouse, errorsOnly, page],
    queryFn: () => skuMappingApi.list({
      shopify_sku: search || undefined,
      warehouse: warehouse || undefined,
      errors_only: errorsOnly || undefined,
      skip: page * limit,
      limit,
    }),
    retry: false,
  })

  const refreshMut = useMutation({
    mutationFn: skuMappingApi.refresh,
    onSuccess: () => qc.invalidateQueries(['sku-mappings']),
  })

  const is503 = error?.response?.status === 503

  return (
    <div>
      <div className="page-header">
        <h1>SKU Mapping</h1>
        <p>Live from Google Sheets — GHF Inventory (INPUT_bundles_cvr_walnut &amp; _northlake tabs). Read-only; edit mappings directly in the sheet.</p>
      </div>

      {is503 && (
        <div className="setup-banner">
          <h3>⚙️ Google Sheets not connected yet</h3>
          <p>To connect, follow these steps:</p>
          <ol>
            <li>Go to <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer">console.cloud.google.com</a></li>
            <li>Create a project → enable <strong>Google Sheets API</strong> and <strong>Google Drive API</strong></li>
            <li>Go to <strong>Credentials → Create Credentials → Service Account</strong></li>
            <li>Click the service account → <strong>Keys → Add Key → JSON</strong> → download</li>
            <li>Save the file as <code>credentials.json</code> inside <code>fulfillment-app/backend/</code></li>
            <li>Share your 3 Google Sheets with the service account email (from the JSON file)</li>
            <li>Restart the backend server</li>
          </ol>
        </div>
      )}

      {!is503 && (
        <>
          <div className="toolbar">
            <input placeholder="Search Shopify SKU..." value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} />
            <select value={warehouse} onChange={e => { setWarehouse(e.target.value); setPage(0) }}>
              <option value="">All Warehouses</option>
              <option value="walnut">Walnut</option>
              <option value="northlake">Northlake</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={errorsOnly}
                onChange={e => { setErrorsOnly(e.target.checked); setPage(0) }}
              />
              Errors only
            </label>
            <button className="btn btn-secondary" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
              {refreshMut.isPending ? 'Refreshing...' : '↻ Refresh from Sheets'}
            </button>
          </div>

          {errorsOnly && data.length > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 14px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, fontSize: 13, color: '#c0392b' }}>
              ⚠ {data.length} mapping row{data.length !== 1 ? 's' : ''} with errors — fix these in Google Sheets to prevent orders being held.
            </div>
          )}

          <div className="data-table-wrap">
            {isLoading ? <div className="loading">Loading from Google Sheets...</div>
              : error ? <div className="error-msg">Error: {error.message}</div>
              : data.length === 0 ? <div className="empty">{errorsOnly ? 'No mapping errors found.' : 'No mappings found.'}</div> : (
              <table>
                <thead><tr>
                  <th>Shopify SKU</th><th>Warehouse</th><th>Pick SKU</th><th>Qty</th>
                  <th>Product Type</th><th>Pick Type</th><th>Weight (lb)</th><th>Status</th>
                  <th>Errors</th>
                </tr></thead>
                <tbody>{data.map((row, i) => {
                  const errs = row.errors || []
                  return (
                    <tr key={`${row.warehouse}-${row.id}-${i}`} style={errs.length > 0 ? { background: '#fff8f8' } : undefined}>
                      <td><code style={{fontSize:12}}>{row.shopify_sku}</code></td>
                      <td><span className={`badge badge-${row.warehouse}`}>{row.warehouse}</span></td>
                      <td><code style={{fontSize:12, color: !row.pick_sku ? '#c0392b' : 'inherit'}}>{row.pick_sku || '—'}</code></td>
                      <td>{row.mix_quantity ?? 1}</td>
                      <td style={{maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{row.product_type || '—'}</td>
                      <td style={{maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color: row.pick_type && row.pick_type !== row.product_type ? '#c0392b' : 'inherit'}}>{row.pick_type || '—'}</td>
                      <td>{row.pick_weight_lb ?? '—'}</td>
                      <td><span className={`badge badge-${row.shop_status === 'Active' ? 'active' : 'inactive'}`}>{row.shop_status || '—'}</span></td>
                      <td>
                        {errs.length > 0
                          ? errs.map(e => (
                            <span key={e} style={{ display:'inline-block', background:'#fca5a5', color:'#7f1d1d', borderRadius:4, padding:'1px 6px', fontSize:11, marginRight:4 }}>
                              {ERROR_LABELS[e] || e}
                            </span>
                          ))
                          : <span style={{ color: '#aaa', fontSize: 12 }}>—</span>}
                      </td>
                    </tr>
                  )
                })}</tbody>
              </table>
            )}
          </div>

          <div className="pagination">
            {!errorsOnly && <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>}
            {!errorsOnly && <span>Page {page + 1}</span>}
            {!errorsOnly && <button disabled={data.length < limit} onClick={() => setPage(p => p + 1)}>Next →</button>}
            <span style={{marginLeft:'auto'}}>{data.length} rows shown · cached 5 min</span>
          </div>
        </>
      )}
    </div>
  )
}
