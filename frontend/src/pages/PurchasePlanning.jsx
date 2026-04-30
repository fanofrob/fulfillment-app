import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getExpandedRowModel,
  flexRender,
} from '@tanstack/react-table'
import { useSearchParams } from 'react-router-dom'
import {
  purchasePlanningApi,
  projectionPeriodsApi,
  vendorsApi,
} from '../api'

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtNum(v, digits = 1) {
  if (v == null || v === '') return ''
  const n = Number(v)
  if (Number.isNaN(n)) return ''
  return n.toFixed(digits)
}

function fmtPeriodLabel(p) {
  if (!p) return ''
  const start = p.start_datetime ? new Date(p.start_datetime).toLocaleDateString() : ''
  const end = p.end_datetime ? new Date(p.end_datetime).toLocaleDateString() : ''
  const status = p.status ? ` [${p.status}]` : ''
  return `${p.name} (${start} – ${end})${status}`
}

// ── Editable input cell ────────────────────────────────────────────────────
function NumberCell({ value, onSave, placeholder, step = 'any' }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => {
    setDraft(value == null ? '' : String(value))
  }, [value])

  function commit() {
    const trimmed = draft.trim()
    const next = trimmed === '' ? null : Number(trimmed)
    if (trimmed !== '' && Number.isNaN(next)) {
      setDraft(value == null ? '' : String(value))
      return
    }
    if (next !== value) onSave(next)
  }

  return (
    <input
      type="number"
      step={step}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
      style={{
        width: '100%', minWidth: 70, padding: '4px 6px', fontSize: 12,
        border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff',
      }}
    />
  )
}

function VendorCell({ value, vendors, productType, onSave }) {
  // Split vendors into "Suggested" (catalog contains the row's product_type)
  // and "Other". The suggested group renders as an <optgroup> at the top so
  // the user can pick a likely match without scanning the full list.
  const pt = (productType || '').trim().toLowerCase()
  const { suggested, other } = useMemo(() => {
    if (!pt) return { suggested: [], other: vendors }
    const sug = []
    const oth = []
    for (const v of vendors) {
      const cat = (v.product_catalog || []).map(t => String(t).toLowerCase())
      // Match if any catalog tag equals or contains the product type, OR vice-versa.
      const hit = cat.some(t => t === pt || t.includes(pt) || pt.includes(t))
      if (hit) sug.push(v)
      else oth.push(v)
    }
    return { suggested: sug, other: oth }
  }, [vendors, pt])

  return (
    <select
      value={value ?? ''}
      onChange={(e) => onSave(e.target.value === '' ? null : Number(e.target.value))}
      style={{
        width: '100%', minWidth: 120, padding: '4px 6px', fontSize: 12,
        border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff',
      }}
    >
      <option value="">—</option>
      {suggested.length > 0 && (
        <optgroup label={`★ Suggested for "${productType}"`}>
          {suggested.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </optgroup>
      )}
      <optgroup label={suggested.length > 0 ? 'All vendors' : 'Vendors'}>
        {other.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </optgroup>
    </select>
  )
}

function ProductTypeCell({ value, productTypes, onSave }) {
  // Free-text input with datalist of available product types from the projection.
  const listId = 'pt-list-purchase-planning'
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => { setDraft(value ?? '') }, [value])

  function commit() {
    const next = draft.trim()
    if (next === value) return
    if (next === '') {
      setDraft(value ?? '')
      return
    }
    onSave(next)
  }

  return (
    <>
      <input
        type="text"
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
        style={{
          width: '100%', minWidth: 140, padding: '4px 6px', fontSize: 12,
          border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff',
        }}
      />
      <datalist id={listId}>
        {productTypes.map((pt) => (<option key={pt} value={pt} />))}
      </datalist>
    </>
  )
}

function SubProductTypeCell({ value, productTypes, baseProductType, onSave }) {
  // Dropdown of all available product types for the substitute. Empty option
  // clears the substitution. Excludes the row's own base product_type.
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onSave(e.target.value === '' ? '' : e.target.value)}
      style={{
        width: '100%', minWidth: 140, padding: '4px 6px', fontSize: 12,
        border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff',
      }}
    >
      <option value="">—</option>
      {productTypes
        .filter((pt) => pt !== baseProductType)
        .map((pt) => (<option key={pt} value={pt}>{pt}</option>))}
    </select>
  )
}

// ── Column filter input (per-column) ───────────────────────────────────────
function ColumnFilter({ column }) {
  const value = column.getFilterValue() ?? ''
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => column.setFilterValue(e.target.value || undefined)}
      placeholder="filter…"
      style={{
        width: '100%', fontSize: 11, padding: '2px 4px',
        border: '1px solid #e5e7eb', borderRadius: 3, background: '#fff', fontWeight: 400,
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function PurchasePlanning() {
  const qc = useQueryClient()
  const [urlParams, setUrlParams] = useSearchParams()
  const [periodId, setPeriodId] = useState(() => {
    const fromUrl = urlParams.get('period_id')
    return fromUrl ? Number(fromUrl) : null
  })
  const [grouping, setGrouping] = useState([])
  const [sorting, setSorting] = useState([])
  const [columnFilters, setColumnFilters] = useState([])
  const [actionMsg, setActionMsg] = useState(null)

  // ── Data ────────────────────────────────────────────────────────────────
  const { data: periods = [] } = useQuery({
    queryKey: ['projection-periods'],
    queryFn: () => projectionPeriodsApi.list(),
  })
  const { data: vendors = [] } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => vendorsApi.list(),
  })

  // Default to most recent draft/active period if none selected yet
  useEffect(() => {
    if (periodId == null && periods.length > 0) {
      const preferred =
        periods.find((p) => p.status === 'active') ||
        periods.find((p) => p.status === 'draft') ||
        periods[0]
      if (preferred) setPeriodId(preferred.id)
    }
  }, [periods, periodId])

  // Sync periodId → URL
  useEffect(() => {
    if (periodId != null) {
      const np = new URLSearchParams(urlParams)
      np.set('period_id', String(periodId))
      setUrlParams(np, { replace: true })
    }
  }, [periodId])  // eslint-disable-line react-hooks/exhaustive-deps

  const { data: planData = { items: [], available_product_types: [], has_current_projection: false }, isLoading } = useQuery({
    queryKey: ['purchase-planning', periodId],
    queryFn: () => purchasePlanningApi.list(periodId),
    enabled: periodId != null,
  })

  const items = planData.items ?? []
  const productTypes = planData.available_product_types ?? []

  // ── Mutations ───────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (data) => purchasePlanningApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchase-planning', periodId] }),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => purchasePlanningApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchase-planning', periodId] }),
  })
  const deleteMut = useMutation({
    mutationFn: (id) => purchasePlanningApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchase-planning', periodId] }),
  })
  const seedMut = useMutation({
    mutationFn: (id) => purchasePlanningApi.seed(id),
    onSuccess: (res) => {
      setActionMsg(`Seeded ${res.created} row${res.created === 1 ? '' : 's'} from projection (skipped ${res.skipped_existing} existing)`)
      qc.invalidateQueries({ queryKey: ['purchase-planning', periodId] })
    },
    onError: (err) => setActionMsg(`Seed failed: ${err?.response?.data?.detail || err.message}`),
  })

  function handleUpdate(id, patch) {
    updateMut.mutate({ id, data: patch })
  }
  function handleAddRow() {
    if (!periodId) return
    createMut.mutate({
      projection_period_id: periodId,
      product_type: productTypes[0] || 'new product',
    })
  }

  // ── Columns ─────────────────────────────────────────────────────────────
  const columns = useMemo(() => [
    {
      id: 'vendor',
      header: 'Vendor',
      accessorFn: (row) => {
        const v = vendors.find((vv) => vv.id === row.vendor_id)
        return v ? v.name : '—'
      },
      cell: ({ row, getValue }) => {
        if (row.getIsGrouped()) return getValue()
        return (
          <VendorCell
            value={row.original.vendor_id}
            vendors={vendors}
            productType={row.original.product_type}
            onSave={(vendorId) => handleUpdate(row.original.id, { vendor_id: vendorId })}
          />
        )
      },
      filterFn: 'includesString',
      enableGrouping: true,
    },
    {
      id: 'product_type',
      header: 'Product Type',
      accessorKey: 'product_type',
      cell: ({ row }) => (
        <ProductTypeCell
          value={row.original.product_type}
          productTypes={productTypes}
          onSave={(pt) => handleUpdate(row.original.id, { product_type: pt })}
        />
      ),
      filterFn: 'includesString',
    },
    {
      id: 'sub_product_type',
      header: 'Sub Product Type',
      accessorKey: 'sub_product_type',
      cell: ({ row }) => (
        <SubProductTypeCell
          value={row.original.sub_product_type}
          productTypes={productTypes}
          baseProductType={row.original.product_type}
          onSave={(pt) => handleUpdate(row.original.id, { sub_product_type: pt })}
        />
      ),
      filterFn: 'includesString',
    },
    {
      id: 'inventory_lbs',
      header: 'Inventory (lbs)',
      accessorKey: 'inventory_lbs',
      cell: ({ getValue }) => {
        const v = getValue()
        return (
          <span style={{ color: v == null ? '#9ca3af' : '#374151' }}>
            {v == null ? '—' : fmtNum(v)}
          </span>
        )
      },
      sortingFn: 'basic',
      enableColumnFilter: false,
    },
    {
      id: 'sub_inventory_lbs',
      header: 'Sub Inventory (lbs)',
      accessorKey: 'sub_inventory_lbs',
      cell: ({ getValue }) => {
        const v = getValue()
        return (
          <span style={{ color: v == null ? '#9ca3af' : '#374151' }}>
            {v == null ? '—' : fmtNum(v)}
          </span>
        )
      },
      sortingFn: 'basic',
      enableColumnFilter: false,
    },
    {
      id: 'gap_lbs',
      header: 'Gap (lbs)',
      accessorKey: 'gap_lbs',
      cell: ({ getValue }) => {
        const v = getValue()
        return (
          <span style={{ color: v == null ? '#9ca3af' : v > 0 ? '#b45309' : '#374151' }}>
            {v == null ? '—' : fmtNum(v)}
          </span>
        )
      },
      sortingFn: 'basic',
      enableColumnFilter: false,
    },
    {
      id: 'net_after_purchase_lbs',
      header: 'Net After Purchase (lbs)',
      accessorKey: 'net_after_purchase_lbs',
      cell: ({ getValue }) => {
        const v = getValue()
        return (
          <span style={{ color: v == null ? '#9ca3af' : v > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
            {v == null ? '—' : fmtNum(v)}
          </span>
        )
      },
      sortingFn: 'basic',
      enableColumnFilter: false,
    },
    {
      id: 'purchase_weight_lbs',
      header: 'Purchase Weight (lbs)',
      accessorKey: 'purchase_weight_lbs',
      cell: ({ row }) => (
        <NumberCell
          value={row.original.purchase_weight_lbs}
          placeholder="lbs"
          onSave={(n) => handleUpdate(row.original.id, { purchase_weight_lbs: n })}
        />
      ),
      sortingFn: 'basic',
      enableColumnFilter: false,
    },
    {
      id: 'purchase_weight_helper_lbs',
      header: 'Purchase Weight Helper (lbs)',
      accessorKey: 'purchase_weight_helper_lbs',
      cell: ({ getValue }) => {
        const v = getValue()
        return (
          <span style={{ color: '#6b7280', fontStyle: 'italic' }}>
            {v == null ? '—' : fmtNum(v)}
          </span>
        )
      },
      sortingFn: 'basic',
      enableColumnFilter: false,
    },
    {
      id: 'case_weight_lbs',
      header: 'Case Weight (lbs)',
      accessorKey: 'case_weight_lbs',
      cell: ({ row }) => (
        <NumberCell
          value={row.original.case_weight_lbs}
          placeholder="1 = no case"
          onSave={(n) => handleUpdate(row.original.id, { case_weight_lbs: n })}
        />
      ),
      sortingFn: 'basic',
      enableColumnFilter: false,
    },
    {
      id: 'quantity',
      header: 'Qty (cases / lb / pieces)',
      accessorKey: 'quantity',
      cell: ({ row }) => (
        <NumberCell
          value={row.original.quantity}
          placeholder="qty"
          onSave={(n) => handleUpdate(row.original.id, { quantity: n })}
        />
      ),
      sortingFn: 'basic',
      enableColumnFilter: false,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        if (row.getIsGrouped()) return null
        return (
          <button
            className="btn btn-secondary"
            style={{ fontSize: 11, padding: '2px 8px', color: '#dc2626' }}
            onClick={() => {
              if (window.confirm('Delete this plan row?')) deleteMut.mutate(row.original.id)
            }}
          >Delete</button>
        )
      },
      enableSorting: false,
      enableColumnFilter: false,
      enableGrouping: false,
    },
  ], [vendors, productTypes])  // eslint-disable-line react-hooks/exhaustive-deps

  const table = useReactTable({
    data: items,
    columns,
    state: { grouping, sorting, columnFilters },
    onGroupingChange: setGrouping,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    autoResetExpanded: false,
  })

  const groupedByVendor = grouping.includes('vendor')

  // ── Render ──────────────────────────────────────────────────────────────
  const period = periods.find((p) => p.id === periodId)
  const totals = useMemo(() => {
    // Dedup gap by (product_type, sub_product_type) combo so multiple
    // vendor splits of the same combo only count once. Different sub values
    // for the same base count separately (parallel substitution strategies).
    const comboSeen = new Set()
    let gapSum = 0
    let purchaseSum = 0
    for (const r of items) {
      const key = `${r.product_type}::${r.sub_product_type ?? ''}`
      if (!comboSeen.has(key)) {
        comboSeen.add(key)
        if (r.gap_lbs != null) gapSum += r.gap_lbs
      }
      if (r.purchase_weight_lbs != null) purchaseSum += r.purchase_weight_lbs
    }
    return { gapSum, purchaseSum, netSum: gapSum - purchaseSum }
  }, [items])

  return (
    <div>
      <div className="page-header-row">
        <div className="page-header">
          <h1>Purchase Planning</h1>
          <p>
            Plan purchases against a projection period. Pick a period, fill in
            vendor / case weight / purchase weight per product type. Optionally
            set a Sub Product Type — its on-hand reduces the row's Gap and
            purchases on the substitute fill the same gap. Net After Purchase
            sums across all rows sharing the same (product type, sub product
            type) combo, so splits across vendors net out together.
          </p>
        </div>
      </div>

      <div className="toolbar">
        <select
          value={periodId ?? ''}
          onChange={(e) => setPeriodId(e.target.value === '' ? null : Number(e.target.value))}
          style={{ minWidth: 320 }}
        >
          <option value="">— Select projection period —</option>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>{fmtPeriodLabel(p)}</option>
          ))}
        </select>
        <button
          className="btn btn-primary"
          onClick={handleAddRow}
          disabled={!periodId || createMut.isPending}
        >+ Add Row</button>
        <button
          className="btn btn-secondary"
          onClick={() => seedMut.mutate(periodId)}
          disabled={!periodId || seedMut.isPending || !planData.has_current_projection}
          title={!planData.has_current_projection ? 'No current projection for this period — generate one in Projection Dashboard first' : 'Create one row per product type with positive gap'}
        >{seedMut.isPending ? 'Seeding…' : '↓ Seed from Projection'}</button>
        <button
          className={`btn btn-secondary${groupedByVendor ? ' active' : ''}`}
          onClick={() => setGrouping(groupedByVendor ? [] : ['vendor'])}
          style={groupedByVendor ? { background: '#3b82f6', color: '#fff' } : {}}
        >
          {groupedByVendor ? '✓ Grouped by Vendor' : 'Group by Vendor'}
        </button>
        {(columnFilters.length > 0 || sorting.length > 0) && (
          <button
            className="btn btn-secondary"
            onClick={() => { setColumnFilters([]); setSorting([]) }}
          >Clear filters & sort</button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
          {items.length} row{items.length === 1 ? '' : 's'}
          {' · '}
          gap: {fmtNum(totals.gapSum)} lb
          {' · '}
          buying: {fmtNum(totals.purchaseSum)} lb
          {' · '}
          net: <span style={{ color: totals.netSum > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{fmtNum(totals.netSum)} lb</span>
        </span>
      </div>

      {actionMsg && (
        <div style={{ margin: '8px 0', padding: '6px 10px', background: '#ecfdf5', color: '#065f46', fontSize: 12, borderRadius: 4 }}>
          {actionMsg}
          <button onClick={() => setActionMsg(null)} style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', color: '#065f46' }}>×</button>
        </div>
      )}

      {periodId && !planData.has_current_projection && (
        <div style={{ margin: '8px 0', padding: '8px 12px', background: '#fffbeb', color: '#92400e', fontSize: 12, borderRadius: 4 }}>
          No <strong>current</strong> projection found for this period — generate one in Projection Dashboard so the Gap column populates.
        </div>
      )}

      {!periodId && (
        <div className="empty">Select a projection period to begin planning purchases.</div>
      )}

      {periodId && (
        <div className="data-table-wrap" style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 1600 }}>
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => {
                    const sortDir = header.column.getIsSorted()
                    const canSort = header.column.getCanSort()
                    const canFilter = header.column.getCanFilter()
                    const canGroup = header.column.getCanGroup()
                    return (
                      <th key={header.id} style={{ verticalAlign: 'top' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {canGroup && (
                            <button
                              className="col-filter-btn"
                              onClick={() => header.column.toggleGrouping()}
                              title={header.column.getIsGrouped() ? 'Ungroup' : 'Group by this column'}
                              style={{ color: header.column.getIsGrouped() ? '#3b82f6' : '#9ca3af' }}
                            >
                              {header.column.getIsGrouped() ? '◉' : '○'}
                            </button>
                          )}
                          <span
                            onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                            style={{ cursor: canSort ? 'pointer' : 'default', userSelect: 'none' }}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {canSort && (
                              <span style={{ marginLeft: 4, color: '#9ca3af' }}>
                                {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '↕'}
                              </span>
                            )}
                          </span>
                        </div>
                        {canFilter && (
                          <div style={{ marginTop: 4 }}>
                            <ColumnFilter column={header.column} />
                          </div>
                        )}
                      </th>
                    )
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={columns.length} style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Loading…</td></tr>
              )}
              {!isLoading && items.length === 0 && (
                <tr><td colSpan={columns.length} style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>
                  No plan rows yet. Use <strong>Seed from Projection</strong> to auto-create one row per product type with a positive gap, or <strong>+ Add Row</strong> for a blank row.
                </td></tr>
              )}
              {table.getRowModel().rows.map((row) => {
                if (row.getIsGrouped()) {
                  return (
                    <tr key={row.id} style={{ background: '#f3f4f6' }}>
                      <td
                        colSpan={columns.length}
                        style={{ cursor: 'pointer', fontWeight: 600 }}
                        onClick={row.getToggleExpandedHandler()}
                      >
                        <span style={{ marginRight: 6, color: '#6b7280' }}>
                          {row.getIsExpanded() ? '▼' : '▶'}
                        </span>
                        Vendor: {row.getValue('vendor')}
                        <span style={{ marginLeft: 8, color: '#6b7280', fontWeight: 400, fontSize: 12 }}>
                          ({row.subRows.length} row{row.subRows.length === 1 ? '' : 's'})
                        </span>
                      </td>
                    </tr>
                  )
                }
                return (
                  <tr key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} style={{ padding: '4px 8px' }}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
