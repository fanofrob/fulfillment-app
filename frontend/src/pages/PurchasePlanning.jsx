import { useEffect, useMemo, useRef, useState } from 'react'
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

// ── TSV / selection helpers ────────────────────────────────────────────────
function cellsEqual(a, b) {
  if (!a || !b) return false
  return a.rowIdx === b.rowIdx && a.colIdx === b.colIdx
}

function selectionBox(sel) {
  if (!sel.anchor || !sel.focus) return null
  return {
    rs: Math.min(sel.anchor.rowIdx, sel.focus.rowIdx),
    re: Math.max(sel.anchor.rowIdx, sel.focus.rowIdx),
    cs: Math.min(sel.anchor.colIdx, sel.focus.colIdx),
    ce: Math.max(sel.anchor.colIdx, sel.focus.colIdx),
  }
}

function parseTSV(text) {
  // Excel/Sheets paste = newline-separated rows, tab-separated cols.
  // Strip a single trailing newline (added by most copy actions).
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => l.split('\t'))
}

function buildTSV(rows) {
  return rows.map((cells) => cells.join('\t')).join('\n')
}

// ── Cell display & editor ──────────────────────────────────────────────────
// In display mode, every cell is plain text — no input bezels — so the
// table reads like a spreadsheet, not a form. The editor is only mounted
// while the user is actively editing one cell.

const PT_DATALIST_ID = 'pt-list-purchase-planning'
const VENDOR_DATALIST_ID = 'vendor-list-purchase-planning'

const editorBaseStyle = {
  width: '100%',
  height: '100%',
  border: 'none',
  outline: 'none',
  padding: '4px 6px',
  fontSize: 12,
  background: '#fff',
  font: 'inherit',
  boxSizing: 'border-box',
}

function CellEditor({
  editorType,
  initialValue,
  vendors,
  productTypes,
  baseProductType,
  onCommit,   // (advanceDir: 'down' | 'up' | 'right' | 'left' | null) => void; reads draft via ref
  onCancel,
}) {
  const [draft, setDraft] = useState(initialValue ?? '')
  const draftRef = useRef(draft)
  draftRef.current = draft
  const inputRef = useRef(null)
  // Guards a double-call when the editor is unmounting: keydown commits, then
  // the input's removal-from-DOM triggers blur which would commit again.
  const doneRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (typeof el.select === 'function') el.select()
  }, [])

  function commitNow(advance) {
    if (doneRef.current) return
    doneRef.current = true
    onCommit(advance, draftRef.current)
  }
  function cancel() {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }
  function onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitNow(e.shiftKey ? 'up' : 'down')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitNow(e.shiftKey ? 'left' : 'right')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  if (editorType === 'vendor') {
    // Use input + datalist instead of <select> — native <select> auto-opens
    // its dropdown on focus, which fights the spreadsheet feel. Datalist
    // gives autocomplete without the modal popup. Sort vendors so ones whose
    // catalog mentions the row's product_type show up first in the suggestions.
    const pt = (baseProductType || '').trim().toLowerCase()
    const suggested = []
    const other = []
    for (const v of vendors) {
      const cat = (v.product_catalog || []).map((t) => String(t).toLowerCase())
      const hit = pt && cat.some((t) => t === pt || t.includes(pt) || pt.includes(t))
      if (hit) suggested.push(v)
      else other.push(v)
    }
    const ordered = [...suggested, ...other]
    return (
      <>
        <input
          ref={inputRef}
          type="text"
          list={VENDOR_DATALIST_ID}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commitNow(null)}
          onKeyDown={onKey}
          style={editorBaseStyle}
        />
        <datalist id={VENDOR_DATALIST_ID}>
          {ordered.map((v) => (<option key={v.id} value={v.name} />))}
        </datalist>
      </>
    )
  }

  if (editorType === 'subProductType') {
    return (
      <input
        ref={inputRef}
        type="text"
        list={PT_DATALIST_ID}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commitNow(null)}
        onKeyDown={onKey}
        style={editorBaseStyle}
      />
    )
  }

  if (editorType === 'productType') {
    return (
      <input
        ref={inputRef}
        type="text"
        list={PT_DATALIST_ID}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commitNow(null)}
        onKeyDown={onKey}
        style={editorBaseStyle}
      />
    )
  }

  // number
  return (
    <input
      ref={inputRef}
      type="number"
      step="any"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commitNow(null)}
      onKeyDown={onKey}
      style={editorBaseStyle}
    />
  )
}

const cellDisplayStyle = {
  display: 'block',
  width: '100%',
  height: '100%',
  padding: '4px 6px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  cursor: 'cell',
  userSelect: 'none',
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
  // Excel-like cell selection. anchor = "active" cell (paste target /
  // range origin), focus = the other end of a shift-click range.
  // Both reference visible (sorted/filtered) data-row index + editable-col index.
  const [selection, setSelection] = useState({ anchor: null, focus: null })
  // Edit mode: { rowIdx, colIdx, initialValue }. Null when not editing.
  const [editing, setEditing] = useState(null)
  // Drag-select tracking — mousedown on a cell starts a drag; mouseenter on
  // others extends `focus`; mouseup ends it. Lives in a ref so re-renders
  // don't churn it.
  const draggingRef = useRef(false)

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

  // ── Editable column metadata for copy/paste ─────────────────────────────
  // Order here defines the colIdx used by the selection model. Must match
  // visual column order so a range selection across screen columns maps
  // 1:1 to the indices used for TSV serialize/deserialize.
  const vendorByName = useMemo(() => {
    const m = new Map()
    for (const v of vendors) m.set((v.name || '').trim().toLowerCase(), v.id)
    return m
  }, [vendors])

  const productTypeSet = useMemo(() => new Set(productTypes), [productTypes])

  // Selection grid metadata: ALL columns the user can highlight, in DOM
  // (visible) order. Editable cols carry editorType + parseValue; read-only
  // cols only contribute to copy/range — paste skips them. Order matters
  // because shift-click and drag operate on these indices.
  const numStr = (v) => v == null ? '' : fmtNum(v)
  const gridColumnMeta = useMemo(() => [
    {
      colId: 'vendor',
      editable: true,
      editorType: 'vendor',
      getValue: (row) => {
        const v = vendors.find((vv) => vv.id === row.vendor_id)
        return v ? v.name : ''
      },
      getDisplay: (row) => {
        const v = vendors.find((vv) => vv.id === row.vendor_id)
        return v ? v.name : '—'
      },
      parseValue: (str) => {
        const t = String(str ?? '').trim()
        if (t === '') return { vendor_id: null }
        const id = vendorByName.get(t.toLowerCase())
        if (id == null) return null
        return { vendor_id: id }
      },
    },
    {
      colId: 'product_type',
      editable: true,
      editorType: 'productType',
      getValue: (row) => row.product_type || '',
      getDisplay: (row) => row.product_type || '',
      parseValue: (str) => {
        const t = String(str ?? '').trim()
        if (t === '') return null
        return { product_type: t }
      },
    },
    {
      colId: 'sub_product_type',
      editable: true,
      editorType: 'subProductType',
      getValue: (row) => row.sub_product_type || '',
      getDisplay: (row) => row.sub_product_type || '—',
      parseValue: (str) => {
        const t = String(str ?? '').trim()
        if (t === '') return { sub_product_type: '' }
        if (!productTypeSet.has(t)) return null
        return { sub_product_type: t }
      },
    },
    {
      colId: 'inventory_lbs',
      editable: false,
      getValue: (row) => numStr(row.inventory_lbs),
    },
    {
      colId: 'sub_inventory_lbs',
      editable: false,
      getValue: (row) => numStr(row.sub_inventory_lbs),
    },
    {
      colId: 'gap_lbs',
      editable: false,
      getValue: (row) => numStr(row.gap_lbs),
    },
    {
      colId: 'net_after_purchase_lbs',
      editable: false,
      getValue: (row) => numStr(row.net_after_purchase_lbs),
    },
    {
      colId: 'purchase_weight_lbs',
      editable: true,
      editorType: 'number',
      getValue: (row) => row.purchase_weight_lbs == null ? '' : String(row.purchase_weight_lbs),
      getDisplay: (row) => numStr(row.purchase_weight_lbs),
      parseValue: (str) => {
        const t = String(str ?? '').trim()
        if (t === '') return { purchase_weight_lbs: null }
        const n = Number(t)
        if (Number.isNaN(n)) return null
        return { purchase_weight_lbs: n }
      },
    },
    {
      colId: 'purchase_weight_helper_lbs',
      editable: false,
      getValue: (row) => numStr(row.purchase_weight_helper_lbs),
    },
    {
      colId: 'case_weight_lbs',
      editable: true,
      editorType: 'number',
      getValue: (row) => row.case_weight_lbs == null ? '' : String(row.case_weight_lbs),
      getDisplay: (row) => numStr(row.case_weight_lbs),
      parseValue: (str) => {
        const t = String(str ?? '').trim()
        if (t === '') return { case_weight_lbs: null }
        const n = Number(t)
        if (Number.isNaN(n)) return null
        return { case_weight_lbs: n }
      },
    },
    {
      colId: 'quantity',
      editable: true,
      editorType: 'number',
      getValue: (row) => row.quantity == null ? '' : String(row.quantity),
      getDisplay: (row) => numStr(row.quantity),
      parseValue: (str) => {
        const t = String(str ?? '').trim()
        if (t === '') return { quantity: null }
        const n = Number(t)
        if (Number.isNaN(n)) return null
        return { quantity: n }
      },
    },
  ], [vendors, vendorByName, productTypeSet])

  const colIdxByColId = useMemo(() => {
    const m = new Map()
    gridColumnMeta.forEach((c, idx) => m.set(c.colId, idx))
    return m
  }, [gridColumnMeta])

  // Latest-value refs for use inside event handlers whose effect we don't
  // want to re-bind on every render. Updated in render, read on event.
  const dataRowsRef = useRef([])
  const gridColumnMetaRef = useRef(gridColumnMeta)
  gridColumnMetaRef.current = gridColumnMeta

  // ── Edit transitions ────────────────────────────────────────────────────
  function startEditing(rowIdx, colIdx, initialValue) {
    setEditing({ rowIdx, colIdx, initialValue: initialValue ?? null })
  }
  function cancelEditing() {
    setEditing(null)
  }
  // Move the anchor without entering edit mode. Used by Tab/Enter advance and
  // arrow-key navigation. Caller passes the current dataRows length so we
  // don't capture a stale value across re-renders.
  function moveAnchor(rowIdx, colIdx, dir, rowsLen) {
    let nr = rowIdx, nc = colIdx
    if (dir === 'right') nc = Math.min(gridColumnMeta.length - 1, colIdx + 1)
    else if (dir === 'left') nc = Math.max(0, colIdx - 1)
    else if (dir === 'down') nr = Math.min(rowsLen - 1, rowIdx + 1)
    else if (dir === 'up') nr = Math.max(0, rowIdx - 1)
    setSelection({ anchor: { rowIdx: nr, colIdx: nc }, focus: { rowIdx: nr, colIdx: nc } })
  }
  // Shift+Arrow: keep anchor pinned and slide the focus by one cell.
  function extendFocus(dir, rowsLen) {
    setSelection((s) => {
      if (!s.anchor) return s
      const f = s.focus || s.anchor
      let nr = f.rowIdx, nc = f.colIdx
      if (dir === 'right') nc = Math.min(gridColumnMeta.length - 1, nc + 1)
      else if (dir === 'left') nc = Math.max(0, nc - 1)
      else if (dir === 'down') nr = Math.min(rowsLen - 1, nr + 1)
      else if (dir === 'up') nr = Math.max(0, nr - 1)
      return { anchor: s.anchor, focus: { rowIdx: nr, colIdx: nc } }
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
      // Editable: rendered by the td block below. This stub only covers
      // unusual paths (e.g. tooling that calls flexRender directly).
      cell: ({ row, getValue }) => {
        if (row.getIsGrouped()) return getValue()
        const v = vendors.find((vv) => vv.id === row.original.vendor_id)
        return v ? v.name : '—'
      },
      filterFn: 'includesString',
      enableGrouping: true,
    },
    {
      id: 'product_type',
      header: 'Product Type',
      accessorKey: 'product_type',
      cell: ({ row }) => row.original.product_type || '',
      filterFn: 'includesString',
    },
    {
      id: 'sub_product_type',
      header: 'Sub Product Type',
      accessorKey: 'sub_product_type',
      cell: ({ row }) => row.original.sub_product_type || '—',
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
      cell: ({ row }) => fmtNum(row.original.purchase_weight_lbs),
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
      cell: ({ row }) => fmtNum(row.original.case_weight_lbs),
      sortingFn: 'basic',
      enableColumnFilter: false,
    },
    {
      id: 'quantity',
      header: 'Qty (cases / lb / pieces)',
      accessorKey: 'quantity',
      cell: ({ row }) => fmtNum(row.original.quantity),
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

  // Visible data rows (no group headers). rowIdx in `selection` indexes into this.
  const dataRows = useMemo(
    () => table.getRowModel().rows.filter((r) => !r.getIsGrouped()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table.getRowModel().rows],
  )
  dataRowsRef.current = dataRows

  // Clear selection when the underlying view changes — indices would otherwise
  // point at the wrong cells.
  useEffect(() => {
    setSelection({ anchor: null, focus: null })
  }, [periodId, grouping, sorting, columnFilters])

  // ── Cell selection: mousedown handler ───────────────────────────────────
  // mousedown on a cell starts a drag selection. mouseEnter on other cells
  // extends the focus while the mouse is held; a window-level mouseup ends
  // the drag. Plain click → single-cell selection. Shift-click → extend range
  // from the existing anchor.
  function handleCellMouseDown(e, rowIdx, colIdx) {
    // Cells we're editing should accept native input events; don't hijack.
    if (editing && editing.rowIdx === rowIdx && editing.colIdx === colIdx) return
    e.preventDefault()  // don't let focus land on neighboring inputs
    if (e.shiftKey) {
      setSelection((s) => ({
        anchor: s.anchor || { rowIdx, colIdx },
        focus: { rowIdx, colIdx },
      }))
    } else {
      setSelection({ anchor: { rowIdx, colIdx }, focus: { rowIdx, colIdx } })
      draggingRef.current = true
    }
    // Cancel any in-progress edit elsewhere
    if (editing && (editing.rowIdx !== rowIdx || editing.colIdx !== colIdx)) {
      setEditing(null)
    }
  }
  function handleCellMouseEnter(rowIdx, colIdx) {
    if (!draggingRef.current) return
    setSelection((s) => ({
      anchor: s.anchor || { rowIdx, colIdx },
      focus: { rowIdx, colIdx },
    }))
  }
  function handleCellDoubleClick(rowIdx, colIdx) {
    const colMeta = gridColumnMeta[colIdx]
    if (!colMeta || !colMeta.editable) return
    const rowItem = dataRows[rowIdx]?.original
    if (!rowItem) return
    startEditing(rowIdx, colIdx, colMeta.getValue(rowItem))
  }
  // End drag-selection on window mouseup so the user can release outside the table.
  useEffect(() => {
    function onMouseUp() { draggingRef.current = false }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [])

  // ── Copy / Paste handlers ───────────────────────────────────────────────
  // Bulk paste applies many cells in parallel without invalidating the query
  // between each one — invalidate once when the whole batch finishes.
  async function distributeToCells(matrix, anchor) {
    if (!matrix.length) return
    const updates = []  // [{ id, patch }]
    const byId = new Map()
    for (let i = 0; i < matrix.length; i++) {
      const r = anchor.rowIdx + i
      if (r >= dataRows.length) break
      const rowItem = dataRows[r].original
      let patch = byId.get(rowItem.id) || {}
      let touched = false
      for (let j = 0; j < matrix[i].length; j++) {
        const c = anchor.colIdx + j
        if (c >= gridColumnMeta.length) break
        const colMeta = gridColumnMeta[c]
        if (!colMeta.editable) continue  // read-only cells silently skip
        const update = colMeta.parseValue(matrix[i][j])
        if (update) {
          patch = { ...patch, ...update }
          touched = true
        }
      }
      if (touched) {
        byId.set(rowItem.id, patch)
      }
    }
    for (const [id, patch] of byId) {
      updates.push({ id, patch })
    }
    if (!updates.length) return
    try {
      await Promise.all(updates.map(({ id, patch }) => purchasePlanningApi.update(id, patch)))
    } catch (err) {
      setActionMsg(`Paste failed: ${err?.response?.data?.detail || err.message}`)
    }
    qc.invalidateQueries({ queryKey: ['purchase-planning', periodId] })

    // Extend selection to cover the pasted region for visual feedback.
    const lastRow = Math.min(anchor.rowIdx + matrix.length - 1, dataRows.length - 1)
    const widest = matrix.reduce((m, r) => Math.max(m, r.length), 0)
    const lastCol = Math.min(anchor.colIdx + widest - 1, gridColumnMeta.length - 1)
    setSelection({ anchor, focus: { rowIdx: lastRow, colIdx: lastCol } })
    setActionMsg(`Pasted ${updates.length} row${updates.length === 1 ? '' : 's'}`)
  }

  function selectionToTSV() {
    const box = selectionBox(selection)
    if (!box) return ''
    const rows = []
    for (let r = box.rs; r <= box.re; r++) {
      if (r >= dataRows.length) continue
      const rowItem = dataRows[r].original
      const cells = []
      for (let c = box.cs; c <= box.ce; c++) {
        if (c >= gridColumnMeta.length) continue
        cells.push(gridColumnMeta[c].getValue(rowItem))
      }
      rows.push(cells)
    }
    return buildTSV(rows)
  }

  useEffect(() => {
    function isEditableField(el) {
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
    }

    function onCopy(e) {
      // Only handle multi-cell range; a single-cell copy lets the focused input
      // copy its own selected text natively.
      if (!selection.anchor || !selection.focus) return
      if (cellsEqual(selection.anchor, selection.focus)) return
      const tsv = selectionToTSV()
      if (!tsv) return
      e.clipboardData.setData('text/plain', tsv)
      e.preventDefault()
    }

    function onPaste(e) {
      if (!selection.anchor) return
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      const matrix = parseTSV(text)
      const isMulti = matrix.length > 1 || (matrix[0]?.length ?? 0) > 1
      // Single-value paste into a focused input: let native handle so the user
      // can paste mid-text. Only intercept multi-cell pastes.
      if (!isMulti && isEditableField(document.activeElement)) return
      e.preventDefault()
      distributeToCells(matrix, selection.anchor)
    }

    function clearSelectionCells() {
      const rows = dataRowsRef.current
      const cols = gridColumnMetaRef.current
      const box = selectionBox(selection)
      if (!box) return
      const updates = []
      for (let r = box.rs; r <= box.re; r++) {
        const rowItem = rows[r]?.original
        if (!rowItem) continue
        const patch = {}
        for (let c = box.cs; c <= box.ce; c++) {
          const colMeta = cols[c]
          if (!colMeta || !colMeta.editable) continue
          const cleared = colMeta.parseValue('')
          if (cleared) Object.assign(patch, cleared)
        }
        if (Object.keys(patch).length) updates.push({ id: rowItem.id, patch })
      }
      if (updates.length) {
        Promise.all(updates.map(({ id, patch }) => purchasePlanningApi.update(id, patch)))
          .then(() => qc.invalidateQueries({ queryKey: ['purchase-planning', periodId] }))
      }
    }

    async function onKeyDown(e) {
      const rows = dataRowsRef.current
      const cols = gridColumnMetaRef.current
      // Ignore keystrokes that originate inside any input (column filters,
      // toolbar selects, the active cell editor). They handle their own keys.
      if (isEditableField(document.activeElement)) {
        if (e.key === 'Escape' && editing) {
          // Editor handles its own Escape via its onKeyDown; nothing to do.
        }
        return
      }
      if (e.key === 'Escape') {
        if (editing) { setEditing(null); return }
        if (selection.anchor || selection.focus) setSelection({ anchor: null, focus: null })
        return
      }
      const cmd = e.metaKey || e.ctrlKey

      // Active-cell navigation when not editing.
      const anc = selection.anchor
      if (!editing && anc) {
        // Arrow keys: plain → move anchor; with shift → extend the focus
        // (selection range), keeping anchor pinned, like Excel.
        const arrowDir = {
          ArrowUp: 'up', ArrowDown: 'down',
          ArrowLeft: 'left', ArrowRight: 'right',
        }[e.key]
        if (arrowDir) {
          e.preventDefault()
          if (e.shiftKey) extendFocus(arrowDir, rows.length)
          else moveAnchor(anc.rowIdx, anc.colIdx, arrowDir, rows.length)
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          moveAnchor(anc.rowIdx, anc.colIdx, e.shiftKey ? 'left' : 'right', rows.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault()
          const colMeta = cols[anc.colIdx]
          const rowItem = rows[anc.rowIdx]?.original
          if (colMeta && colMeta.editable && rowItem) {
            startEditing(anc.rowIdx, anc.colIdx, colMeta.getValue(rowItem))
          }
          return
        }
        if (!cmd && (e.key === 'Backspace' || e.key === 'Delete')) {
          e.preventDefault()
          clearSelectionCells()
          return
        }
        // Type-to-edit: a printable single-character keypress replaces the
        // current value with that char and enters edit mode (only for
        // editable cols — read-only cells just ignore the keypress).
        if (!cmd && e.key.length === 1) {
          const colMeta = cols[anc.colIdx]
          if (colMeta && colMeta.editable) {
            e.preventDefault()
            startEditing(anc.rowIdx, anc.colIdx, e.key)
          }
          return
        }
      }

      if (!cmd) return
      const k = e.key.toLowerCase()
      // Cmd+C: copy selected range as TSV.
      if (k === 'c' && selection.anchor && selection.focus) {
        e.preventDefault()
        const tsv = selectionToTSV()
        if (tsv) {
          try { await navigator.clipboard.writeText(tsv) } catch {}
        }
        return
      }
      // Cmd+V: paste (distributes TSV from anchor).
      if (k === 'v' && selection.anchor) {
        e.preventDefault()
        try {
          const text = await navigator.clipboard.readText()
          const matrix = parseTSV(text)
          if (matrix.length) distributeToCells(matrix, selection.anchor)
        } catch {}
        return
      }
      // Cmd+X: cut = copy then clear.
      if (k === 'x' && selection.anchor && selection.focus) {
        e.preventDefault()
        const tsv = selectionToTSV()
        if (tsv) { try { await navigator.clipboard.writeText(tsv) } catch {} }
        clearSelectionCells()
      }
    }

    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('keydown', onKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, periodId, editing])

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
          <p style={{ fontSize: 12, color: '#6b7280' }}>
            <strong>Spreadsheet shortcuts:</strong> click to select, drag or
            shift-click for a range, arrow keys to move, shift+arrow to extend
            the range. Double-click / Enter / F2 / start typing to edit (Tab
            and Enter commit). Cmd/Ctrl+C, V, X copy / paste / cut — works
            with Excel & Google Sheets. Read-only columns (Inventory, Gap…)
            are still selectable for copy. Delete / Backspace clears, Esc
            cancels.
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

      <datalist id={PT_DATALIST_ID}>
        {productTypes.map((pt) => (<option key={pt} value={pt} />))}
      </datalist>

      {periodId && (
        <div
          className="data-table-wrap"
          style={{
            overflow: 'auto',
            // Keep the table inside its own scroll container so the sticky
            // <thead> has something to stick within. 75vh leaves the page
            // header / toolbar / tip visible; the table scrolls beneath.
            maxHeight: 'calc(100vh - 220px)',
          }}
        >
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
              {(() => {
                const selBox = selectionBox(selection)
                let dataRowIdx = -1
                return table.getRowModel().rows.map((row) => {
                  if (row.getIsGrouped()) {
                    return (
                      <tr key={row.id} style={{ background: '#f3f4f6' }}>
                        <td
                          colSpan={columns.length}
                          style={{ cursor: 'pointer', fontWeight: 600, padding: '4px 8px' }}
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
                  dataRowIdx += 1
                  const rIdx = dataRowIdx
                  return (
                    <tr key={row.id}>
                      {row.getVisibleCells().map((cell) => {
                        const colId = cell.column.id
                        const colIdx = colIdxByColId.get(colId)
                        // colIdx === undefined for non-selectable cols (just 'actions').
                        const isSelectable = colIdx !== undefined
                        const colMeta = isSelectable ? gridColumnMeta[colIdx] : null
                        const isEditable = !!colMeta?.editable
                        const inRange = isSelectable && selBox != null
                          && rIdx >= selBox.rs && rIdx <= selBox.re
                          && colIdx >= selBox.cs && colIdx <= selBox.ce
                        const isAnchor = isSelectable && selection.anchor
                          && selection.anchor.rowIdx === rIdx && selection.anchor.colIdx === colIdx
                        const isEditing = isEditable && editing
                          && editing.rowIdx === rIdx && editing.colIdx === colIdx
                        const tdStyle = {
                          padding: 0,
                          background: inRange && !isAnchor ? '#dbeafe' : 'transparent',
                          boxShadow: isAnchor
                            ? 'inset 0 0 0 2px #1d4ed8'
                            : (inRange ? 'inset 0 0 0 1px #93c5fd' : 'none'),
                          position: 'relative',
                          height: 28,
                          verticalAlign: 'middle',
                        }
                        // Non-selectable (e.g. the actions column): no selection visuals.
                        if (!isSelectable) {
                          return (
                            <td key={cell.id} style={{ padding: '4px 8px' }}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          )
                        }
                        // Read-only but selectable: keep the column's existing
                        // formatted renderer (coloured gap / net values etc.) and
                        // wrap with selection styles + handlers. No double-click.
                        if (!isEditable) {
                          return (
                            <td
                              key={cell.id}
                              style={{ ...tdStyle, padding: '4px 8px' }}
                              onMouseDown={(e) => handleCellMouseDown(e, rIdx, colIdx)}
                              onMouseEnter={() => handleCellMouseEnter(rIdx, colIdx)}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          )
                        }
                        return (
                          <td
                            key={cell.id}
                            style={tdStyle}
                            onMouseDown={(e) => handleCellMouseDown(e, rIdx, colIdx)}
                            onMouseEnter={() => handleCellMouseEnter(rIdx, colIdx)}
                            onDoubleClick={() => handleCellDoubleClick(rIdx, colIdx)}
                          >
                            {isEditing ? (
                              <CellEditor
                                editorType={colMeta.editorType}
                                initialValue={
                                  editing.initialValue != null
                                    ? editing.initialValue
                                    : colMeta.getValue(row.original)
                                }
                                vendors={vendors}
                                productTypes={productTypes}
                                baseProductType={row.original.product_type}
                                onCommit={(dir, draftValue) => {
                                  const update = colMeta.parseValue(draftValue)
                                  if (update) {
                                    updateMut.mutate({ id: row.original.id, data: update })
                                  }
                                  setEditing(null)
                                  if (dir) moveAnchor(rIdx, colIdx, dir, dataRows.length)
                                }}
                                onCancel={() => setEditing(null)}
                              />
                            ) : (
                              <span style={cellDisplayStyle}>
                                {colMeta.getDisplay(row.original) || ' '}
                              </span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })
              })()}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
