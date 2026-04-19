import { useState, useRef, useCallback, useEffect } from 'react'
import { inventoryCountApi, picklistSkusApi } from '../api'

const WAREHOUSES = ['walnut', 'northlake']

function fmt(val, decimals = 1) {
  if (val === null || val === undefined) return '—'
  return Number(val).toFixed(decimals)
}

// Build initial editable state for a scanned row
function initRow(r, skuMap) {
  const actualSku = r.matched_sku || r.extracted_sku
  const skuObj = skuMap[actualSku] || null
  return {
    ...r,
    _actualSku: actualSku,
    _weightPerLb: r.weight_per_lb ?? (skuObj?.weight_lb ?? null),
    _batch: r.batch || '',
    // Count mode: 'lbs' | 'boxes' | 'pieces'
    _mode: 'lbs',
    _lbs: r.lbs,
    _boxes: '',
    _caseWeight: skuObj?.case_weight_lb ?? '',
    _directPieces: '',
  }
}

function computeLbs(row) {
  if (row._mode === 'pieces') return null
  if (row._mode === 'boxes') {
    const boxes = parseFloat(row._boxes)
    const cw = parseFloat(row._caseWeight)
    if (!isNaN(boxes) && !isNaN(cw)) return boxes * cw
    return null
  }
  const v = parseFloat(row._lbs)
  return isNaN(v) ? null : v
}

function computePieces(row) {
  if (row._mode === 'pieces') {
    const v = parseFloat(row._directPieces)
    return isNaN(v) ? null : v
  }
  const lbs = computeLbs(row)
  const wpp = parseFloat(row._weightPerLb)
  if (lbs === null || isNaN(wpp) || wpp <= 0) return null
  return Math.round((lbs / wpp) * 100) / 100
}

export default function InventoryCount() {
  const [warehouse, setWarehouse] = useState('walnut')
  const [files, setFiles] = useState([])
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState(null)
  const [rows, setRows] = useState(null)
  const [committing, setCommitting] = useState(false)
  const [commitResult, setCommitResult] = useState(null)
  const [commitError, setCommitError] = useState(null)
  const [allSkus, setAllSkus] = useState([])   // [{pick_sku, customer_description, weight_lb, case_weight_lb}]
  const [skuMap, setSkuMap] = useState({})     // pick_sku → sku obj
  const fileInputRef = useRef(null)

  // Load picklist SKUs once
  useEffect(() => {
    picklistSkusApi.list({ limit: 2000 }).then(data => {
      const list = Array.isArray(data) ? data : (data.items || data.skus || [])
      setAllSkus(list)
      const map = {}
      list.forEach(s => { map[s.pick_sku] = s })
      setSkuMap(map)
    }).catch(() => {})
  }, [])

  // ── File handling ────────────────────────────────────────────────────────────

  const addFiles = useCallback((newFiles) => {
    const images = Array.from(newFiles).filter(f => f.type.startsWith('image/'))
    setFiles(prev => {
      const existing = new Set(prev.map(f => f.name + f.size))
      return [...prev, ...images.filter(f => !existing.has(f.name + f.size))]
    })
    setRows(null)
    setCommitResult(null)
    setScanError(null)
  }, [])

  const removeFile = (idx) => {
    setFiles(prev => prev.filter((_, i) => i !== idx))
    setRows(null)
    setCommitResult(null)
  }

  // ── Scan ─────────────────────────────────────────────────────────────────────

  const scan = async () => {
    if (!files.length) return
    setScanning(true)
    setScanError(null)
    setCommitResult(null)
    try {
      const result = await inventoryCountApi.scan(warehouse, files)
      setRows(result.rows.map(r => initRow(r, skuMap)))
    } catch (e) {
      setScanError(e?.response?.data?.detail || e.message || 'Scan failed')
    } finally {
      setScanning(false)
    }
  }

  // ── Row editing ───────────────────────────────────────────────────────────────

  const updateRow = (idx, changes) => {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r
      const updated = { ...r, ...changes }
      // When actual SKU changes, pull weight_per_lb from skuMap
      if ('_actualSku' in changes) {
        const obj = skuMap[changes._actualSku]
        if (obj?.weight_lb) updated._weightPerLb = obj.weight_lb
        if (obj?.case_weight_lb && updated._mode === 'boxes') updated._caseWeight = obj.case_weight_lb
      }
      return updated
    }))
    setCommitResult(null)
  }

  const deleteRow = (idx) => setRows(prev => prev.filter((_, i) => i !== idx))

  // ── Derived flags ─────────────────────────────────────────────────────────────

  function rowFlags(r) {
    const reasons = []
    if (r.is_flagged && r.flag_reason) reasons.push(r.flag_reason)
    if (r._actualSku && r.extracted_sku && r._actualSku !== r.extracted_sku) {
      reasons.push('Actual SKU differs from scanned SKU')
    }
    if (!r._actualSku) reasons.push('No SKU selected')
    if (r._mode === 'boxes' && computeLbs(r) === null) reasons.push('Enter boxes and case weight')
    if (r._mode === 'pieces' && (r._directPieces === '' || isNaN(parseFloat(r._directPieces)))) reasons.push('Enter piece count')
    return reasons
  }

  // ── Commit ───────────────────────────────────────────────────────────────────

  const commit = async () => {
    if (!rows) return
    setCommitting(true)
    setCommitError(null)
    try {
      const commitRows = rows
        .filter(r => r._actualSku && computePieces(r) !== null)
        .map(r => ({
          pick_sku: r._actualSku,
          name: null,
          on_hand_qty: computePieces(r),
          batch: r._batch || null,
        }))
      const result = await inventoryCountApi.commit({ warehouse, rows: commitRows })
      setCommitResult(result)
    } catch (e) {
      setCommitError(e?.response?.data?.detail || e.message || 'Set inventory failed')
    } finally {
      setCommitting(false)
    }
  }

  const readyCount = rows ? rows.filter(r => rowFlags(r).length === 0 && computePieces(r) !== null).length : 0
  const flaggedCount = rows ? rows.filter(r => rowFlags(r).length > 0).length : 0
  const canCommit = rows && rows.length > 0 && !committing && !commitResult

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Inventory Count</h1>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 24 }}>
        Upload photos of your handwritten inventory report. Claude reads the data and converts to pieces.
        Setting inventory <strong>replaces</strong> the current count — it does not add to it.
      </p>

      {/* ── Setup panel ── */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap' }}>
        {/* Warehouse */}
        <div>
          <label style={labelStyle}>WAREHOUSE</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {WAREHOUSES.map(w => (
              <button key={w} onClick={() => { setWarehouse(w); setRows(null); setCommitResult(null) }}
                style={{ ...pillBtn, background: warehouse === w ? '#2563eb' : '#fff', color: warehouse === w ? '#fff' : '#374151', borderColor: warehouse === w ? '#2563eb' : '#d1d5db', textTransform: 'capitalize' }}>
                {w}
              </button>
            ))}
          </div>
        </div>

        {/* Upload */}
        <div style={{ flex: 1, minWidth: 280 }}>
          <label style={labelStyle}>PHOTOS</label>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={e => { e.preventDefault(); addFiles(e.dataTransfer.files) }}
            onDragOver={e => e.preventDefault()}
            style={{ border: '2px dashed #d1d5db', borderRadius: 8, padding: '18px 16px', textAlign: 'center', cursor: 'pointer', background: '#f9fafb', fontSize: 13, color: '#6b7280' }}
          >
            {files.length === 0 ? 'Drop photos here or click to select' : `${files.length} photo${files.length > 1 ? 's' : ''} — click to add more`}
            <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => addFiles(e.target.files)} />
          </div>
          {files.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {files.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#e0e7ff', borderRadius: 4, padding: '2px 8px', fontSize: 12, color: '#3730a3' }}>
                  <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <button onClick={e => { e.stopPropagation(); removeFile(i) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6366f1', fontSize: 14, padding: 0 }}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ alignSelf: 'flex-end' }}>
          <button className="btn btn-primary" onClick={scan} disabled={files.length === 0 || scanning} style={{ fontSize: 14, padding: '8px 24px' }}>
            {scanning ? 'Scanning...' : 'Scan Images'}
          </button>
        </div>
      </div>

      {scanError && <div style={errorBox}>{scanError}</div>}

      {scanning && (
        <div style={{ textAlign: 'center', padding: 48, color: '#6b7280', fontSize: 14 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
          Claude is reading your inventory photos… this may take 15–30 seconds.
        </div>
      )}

      {/* ── Review table ── */}
      {rows !== null && !scanning && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 14, color: '#374151' }}>
              <strong>{rows.length}</strong> rows &nbsp;·&nbsp;
              <span style={{ color: '#16a34a' }}><strong>{readyCount}</strong> ready to set</span>
              {flaggedCount > 0 && <>&nbsp;·&nbsp;<span style={{ color: '#dc2626' }}><strong>{flaggedCount}</strong> need review</span></>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {commitResult ? (
                <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, padding: '6px 14px', fontSize: 13, color: '#16a34a', fontWeight: 600 }}>
                  ✓ Set {commitResult.committed} SKUs ({commitResult.created} new, {commitResult.updated} updated)
                </div>
              ) : (
                <button className="btn btn-primary" onClick={commit} disabled={!canCommit} style={{ fontSize: 14 }}>
                  {committing ? 'Setting...' : `Set Inventory (${readyCount} SKUs)`}
                </button>
              )}
            </div>
          </div>

          {commitError && <div style={{ ...errorBox, marginBottom: 10 }}>{commitError}</div>}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e5e7eb', background: '#f9fafb' }}>
                  <th style={th}>Scanned SKU</th>
                  <th style={th}>Actual SKU</th>
                  <th style={{ ...th, textAlign: 'right' }}>Current Inv.</th>
                  <th style={th}>Batch</th>
                  <th style={th}>Count Type</th>
                  <th style={{ ...th, textAlign: 'right' }}>Lbs</th>
                  <th style={{ ...th, textAlign: 'right' }}>Boxes</th>
                  <th style={{ ...th, textAlign: 'right' }}>Case Wt (lb)</th>
                  <th style={{ ...th, textAlign: 'right' }}>Wt/Piece (lb)</th>
                  <th style={{ ...th, textAlign: 'right' }}>Pieces</th>
                  <th style={th}>Status</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const flags = rowFlags(r)
                  const pieces = computePieces(r)
                  const totalLbs = computeLbs(r)
                  const skuMismatch = r._actualSku && r.extracted_sku && r._actualSku !== r.extracted_sku
                  const rowBg = flags.length > 0 ? '#fff9f9' : (idx % 2 === 0 ? '#fff' : '#f9fafb')

                  return (
                    <tr key={idx} style={{ background: rowBg, borderBottom: '1px solid #e5e7eb' }}>

                      {/* Scanned SKU – read only */}
                      <td style={td}>
                        <span style={{ fontFamily: 'monospace', fontSize: 11, color: skuMismatch ? '#dc2626' : '#374151' }}>
                          {r.extracted_sku}
                        </span>
                      </td>

                      {/* Actual SKU – dropdown */}
                      <td style={td}>
                        <select
                          value={r._actualSku || ''}
                          onChange={e => updateRow(idx, { _actualSku: e.target.value })}
                          style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 11, minWidth: 170, maxWidth: 200 }}
                        >
                          {!skuMap[r._actualSku] && r._actualSku && (
                            <option value={r._actualSku}>{r._actualSku} (not in DB)</option>
                          )}
                          {allSkus.map(s => (
                            <option key={s.pick_sku} value={s.pick_sku}>{s.pick_sku}</option>
                          ))}
                        </select>
                        {skuMismatch && (
                          <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }}>⚠ differs from scanned</div>
                        )}
                      </td>

                      {/* Current inventory */}
                      <td style={{ ...td, textAlign: 'right', color: '#6b7280', fontWeight: 500 }}>
                        {r.current_on_hand_qty !== null && r.current_on_hand_qty !== undefined
                          ? fmt(r.current_on_hand_qty, 0)
                          : <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>

                      {/* Batch */}
                      <td style={td}>
                        <input value={r._batch} onChange={e => updateRow(idx, { _batch: e.target.value })}
                          placeholder="—" style={{ ...inputStyle, width: 70 }} />
                      </td>

                      {/* Count type toggle */}
                      <td style={td}>
                        <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #d1d5db', width: 'fit-content' }}>
                          {['lbs', 'boxes', 'pieces'].map(mode => (
                            <button key={mode} onClick={() => updateRow(idx, { _mode: mode })}
                              style={{ padding: '2px 8px', fontSize: 11, border: 'none', cursor: 'pointer', background: r._mode === mode ? '#2563eb' : '#fff', color: r._mode === mode ? '#fff' : '#374151', fontWeight: r._mode === mode ? 600 : 400 }}>
                              {mode}
                            </button>
                          ))}
                        </div>
                      </td>

                      {/* Lbs input (direct or computed) */}
                      <td style={{ ...td, textAlign: 'right' }}>
                        {r._mode === 'lbs' ? (
                          <input type="number" value={r._lbs} onChange={e => updateRow(idx, { _lbs: e.target.value })}
                            style={{ ...inputStyle, textAlign: 'right', width: 70 }} />
                        ) : r._mode === 'boxes' ? (
                          <span style={{ color: '#6b7280', fontSize: 12 }}>
                            {totalLbs !== null ? fmt(totalLbs) : '—'}
                          </span>
                        ) : <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>

                      {/* Boxes */}
                      <td style={{ ...td, textAlign: 'right' }}>
                        {r._mode === 'boxes' ? (
                          <input type="number" value={r._boxes} onChange={e => updateRow(idx, { _boxes: e.target.value })}
                            placeholder="0" style={{ ...inputStyle, textAlign: 'right', width: 60 }} />
                        ) : <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>

                      {/* Case weight */}
                      <td style={{ ...td, textAlign: 'right' }}>
                        {r._mode === 'boxes' ? (
                          <input type="number" value={r._caseWeight} onChange={e => updateRow(idx, { _caseWeight: e.target.value })}
                            placeholder="0" style={{ ...inputStyle, textAlign: 'right', width: 70 }} />
                        ) : <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>

                      {/* Weight per piece */}
                      <td style={{ ...td, textAlign: 'right' }}>
                        {r._mode !== 'pieces' ? (
                          <input type="number" value={r._weightPerLb ?? ''} onChange={e => updateRow(idx, { _weightPerLb: e.target.value })}
                            placeholder="?" style={{ ...inputStyle, textAlign: 'right', width: 60 }} />
                        ) : <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>

                      {/* Pieces */}
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontSize: 13, color: pieces !== null ? '#111827' : '#9ca3af' }}>
                        {r._mode === 'pieces' ? (
                          <input type="number" value={r._directPieces} onChange={e => updateRow(idx, { _directPieces: e.target.value })}
                            placeholder="0" style={{ ...inputStyle, textAlign: 'right', width: 70, fontWeight: 700 }} />
                        ) : (
                          pieces !== null ? fmt(pieces, 0) : '—'
                        )}
                      </td>

                      {/* Status */}
                      <td style={td}>
                        {flags.length > 0 ? (
                          <div title={flags.join('\n')} style={{ background: '#fef2f2', color: '#dc2626', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'help', whiteSpace: 'nowrap' }}>
                            ⚠ {flags[0].length > 28 ? flags[0].slice(0, 28) + '…' : flags[0]}
                          </div>
                        ) : (
                          <span style={{ background: '#f0fdf4', color: '#16a34a', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                            Ready
                          </span>
                        )}
                      </td>

                      {/* Delete */}
                      <td style={td}>
                        <button onClick={() => deleteRow(idx)}
                          title="Remove this row"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 16, lineHeight: 1, padding: '2px 4px' }}
                          onMouseEnter={e => e.currentTarget.style.color = '#dc2626'}
                          onMouseLeave={e => e.currentTarget.style.color = '#9ca3af'}>
                          ×
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {rows.length > 10 && !commitResult && (
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button className="btn btn-primary" onClick={commit} disabled={!canCommit} style={{ fontSize: 14 }}>
                {committing ? 'Setting...' : `Set Inventory (${readyCount} SKUs)`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.05em', marginBottom: 6 }

const pillBtn = { padding: '6px 14px', borderRadius: 6, border: '1px solid', fontWeight: 500, fontSize: 13, cursor: 'pointer' }

const errorBox = { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px', marginBottom: 16, color: '#dc2626', fontSize: 13 }

const th = { padding: '7px 8px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }

const td = { padding: '5px 8px', verticalAlign: 'middle' }

const inputStyle = { border: '1px solid #d1d5db', borderRadius: 4, padding: '3px 5px', fontSize: 12, background: '#fff', outline: 'none' }
