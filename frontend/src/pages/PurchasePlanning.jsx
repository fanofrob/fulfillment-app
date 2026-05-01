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
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  purchasePlanningApi,
  projectionPeriodsApi,
  vendorsApi,
  purchaseOrdersApi,
} from '../api'

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtNum(v, digits = 1) {
  if (v == null || v === '') return ''
  const n = Number(v)
  if (Number.isNaN(n)) return ''
  return n.toFixed(digits)
}

// "Converted Order" amount: case-aware purchase quantity for a row.
// - case_weight_lbs > 0 → ceil(purchase_weight / case_weight) "cases"
// - otherwise           → purchase_weight "lbs"
// - missing purchase_weight → ''
// Used both by the column cell and by the vendor-popover copy-paste text.
function fmtConvertedOrder(row) {
  const w = row?.purchase_weight_lbs
  if (w == null || w === '') return ''
  const wn = Number(w)
  if (Number.isNaN(wn)) return ''
  const cw = Number(row.case_weight_lbs)
  if (cw > 0) {
    const cases = Math.ceil(wn / cw)
    return `${cases} case${cases === 1 ? '' : 's'}`
  }
  const text = Number.isInteger(wn) ? String(wn) : wn.toFixed(1)
  return `${text} lbs`
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

// Shipping status enum — matches the dropdown values asked for. Empty string
// = "no status set" (clears the column). Order here is the dropdown order.
const SHIPPING_STATUS_OPTIONS = [
  'Pending',
  'Confirmed',
  'In Transit',
  'Delivered',
  'Imported',
  'N/A',
]
const SHIPPING_STATUS_SET = new Set(SHIPPING_STATUS_OPTIONS)

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
  // PO-editor only:
  eligiblePos,
  eligiblePosLoading,
  noVendor,
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

  if (editorType === 'shippingStatus') {
    // Native <select> — its dropdown opens immediately on focus, which is
    // exactly the behavior we want for a constrained-value cell. Choosing an
    // option fires onChange; we commit and advance down so it feels like
    // entering a number into the next row.
    return (
      <select
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          // Defer commit so the new draft is in the ref when commitNow reads it.
          setTimeout(() => commitNow('down'), 0)
        }}
        onBlur={() => commitNow(null)}
        onKeyDown={onKey}
        style={editorBaseStyle}
      >
        <option value="">—</option>
        {SHIPPING_STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
    )
  }

  if (editorType === 'po') {
    // PO link selector. Option values are sentinels handled by the page's
    // commit handler (not parseValue): "" → unlink, "new" → create new PO,
    // "<id>" → link to existing PO. eligiblePos is fetched lazily for the
    // row's vendor before this mounts; if it's still loading we show a
    // disabled placeholder.
    return (
      <select
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setTimeout(() => commitNow('down'), 0)
        }}
        onBlur={() => commitNow(null)}
        onKeyDown={onKey}
        disabled={noVendor || eligiblePosLoading}
        style={editorBaseStyle}
      >
        {noVendor ? (
          <option value="">— set a vendor first —</option>
        ) : eligiblePosLoading ? (
          <option value="">loading…</option>
        ) : (
          <>
            <option value="">— (unlink)</option>
            <option value="new">+ New PO</option>
            {(eligiblePos || []).map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.po_number} [{p.status}]
              </option>
            ))}
          </>
        )}
      </select>
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

// Frozen left columns: stay pinned during horizontal scroll. Each entry's
// `left` is the cumulative width of the columns before it. The leading
// `select` column carries the bulk-delete checkbox; vendor and product_type
// shift right to make room.
const STICKY_COLS = {
  select:       { left: 0,   width: 36  },
  vendor:       { left: 36,  width: 200 },
  product_type: { left: 236, width: 220 },
}
const STICKY_LEFT_TOTAL = 36 + 200 + 220

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

// ── PO cell chip ──────────────────────────────────────────────────────────
// Rendered inside the PO # cell when the row is bound to a PO. Two pieces:
// the PO label + status badge, and a small "↗" button that navigates to the
// PO detail modal. Hovering anywhere on the chip pops up a summary panel
// (vendor / dates / lines / subtotal) — fetched lazily and cached.
const PO_STATUS_COLORS = {
  draft: '#e5e7eb', placed: '#bfdbfe', in_transit: '#c4b5fd',
  partially_received: '#fde68a', delivered: '#bbf7d0',
  imported: '#6ee7b7', reconciled: '#9ca3af',
}

function PoCellChip({ poId, poNumber, poStatus }) {
  const navigate = useNavigate()
  const [hover, setHover] = useState(false)
  const [anchorRect, setAnchorRect] = useState(null)
  const wrapRef = useRef(null)
  const timerRef = useRef(null)

  function showSoon(e) {
    if (timerRef.current) clearTimeout(timerRef.current)
    const rect = wrapRef.current?.getBoundingClientRect()
    timerRef.current = setTimeout(() => {
      setAnchorRect(rect ? { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right } : null)
      setHover(true)
    }, 200)
  }
  function hideSoon() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setHover(false), 100)
  }
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return (
    <span
      ref={wrapRef}
      style={poChipWrapStyle}
      onMouseEnter={showSoon}
      onMouseLeave={hideSoon}
    >
      <span style={poChipLabelStyle}>{poNumber}</span>
      <span style={{ ...poStatusBadgeStyle, background: PO_STATUS_COLORS[poStatus] || '#e5e7eb' }}>
        {poStatus}
      </span>
      <button
        type="button"
        title={`Open ${poNumber}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          navigate(`/purchase-orders?po=${poId}`)
        }}
        style={poOpenIconStyle}
      >↗</button>
      {hover && anchorRect && <PoSummaryPopover poId={poId} anchorRect={anchorRect} />}
    </span>
  )
}

function PoSummaryPopover({ poId, anchorRect }) {
  const { data: po, isLoading } = useQuery({
    queryKey: ['po-summary', poId],
    queryFn: () => purchaseOrdersApi.get(poId),
    staleTime: 30_000,
  })

  const PANEL_W = 280
  const margin = 8
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  let top = (anchorRect?.bottom ?? 100) + margin
  let left = (anchorRect?.left ?? 100)
  if (left + PANEL_W > vw - margin) left = vw - PANEL_W - margin
  if (left < margin) left = margin

  return (
    <div
      style={{
        ...popoverPanelStyle,
        top, left, width: PANEL_W,
        // Above sticky table headers (z=4) and sticky cells (z=1/3) so the
        // panel paints over them instead of letting their content show through.
        zIndex: 60,
        // No backdrop — popover sits inline under the chip and dismisses on mouseleave.
        pointerEvents: 'none',
      }}
    >
      <div style={{ padding: 10, fontSize: 12, lineHeight: 1.5 }}>
        {isLoading || !po ? (
          <span style={{ color: '#9ca3af' }}>Loading…</span>
        ) : (
          <>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{po.po_number}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', color: '#374151' }}>
              <span style={{ color: '#6b7280' }}>Vendor</span><span>{po.vendor_name || '—'}</span>
              <span style={{ color: '#6b7280' }}>Status</span><span style={{ textTransform: 'capitalize' }}>{po.status?.replace(/_/g, ' ')}</span>
              <span style={{ color: '#6b7280' }}>Order date</span><span>{po.order_date ? new Date(po.order_date).toLocaleDateString() : '—'}</span>
              <span style={{ color: '#6b7280' }}>Expected</span><span>{po.expected_delivery_date ? new Date(po.expected_delivery_date).toLocaleDateString() : '—'}</span>
              <span style={{ color: '#6b7280' }}>Lines</span><span>{po.lines?.length ?? 0}</span>
              <span style={{ color: '#6b7280' }}>Subtotal</span><span>{po.subtotal != null ? `$${Number(po.subtotal).toFixed(2)}` : '—'}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const poChipWrapStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 4px',
  fontSize: 12,
  cursor: 'cell',
  userSelect: 'none',
  whiteSpace: 'nowrap',
}
const poChipLabelStyle = {
  fontVariantNumeric: 'tabular-nums',
}
const poStatusBadgeStyle = {
  fontSize: 10,
  padding: '1px 5px',
  borderRadius: 4,
  textTransform: 'capitalize',
  color: '#1f2937',
}
const poOpenIconStyle = {
  marginLeft: 2,
  padding: '0 4px',
  background: 'transparent',
  border: 'none',
  color: '#3b82f6',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
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

  // Bulk-delete checkbox selection: stored as a Set of plan-line ids so it
  // survives sorting/filtering/grouping (which can reorder dataRows).
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  // Vendor info popover: which vendor's details are open. null = closed.
  // { vendorId, anchorRect } — anchorRect positions the panel near its icon.
  const [vendorInfo, setVendorInfo] = useState(null)

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

  // Sync periodId → URL. Also clears row-selection so the checkbox set
  // doesn't carry stale ids from another period.
  useEffect(() => {
    if (periodId != null) {
      const np = new URLSearchParams(urlParams)
      np.set('period_id', String(periodId))
      setUrlParams(np, { replace: true })
    }
    setSelectedIds(new Set())
    setVendorInfo(null)
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
  const bulkDeleteMut = useMutation({
    mutationFn: (ids) => purchasePlanningApi.bulkDelete(ids),
    onSuccess: (res) => {
      setActionMsg(`Deleted ${res.deleted} row${res.deleted === 1 ? '' : 's'}`)
      setSelectedIds(new Set())
      qc.invalidateQueries({ queryKey: ['purchase-planning', periodId] })
    },
    onError: (err) => setActionMsg(`Bulk delete failed: ${err?.response?.data?.detail || err.message}`),
  })
  const seedMut = useMutation({
    mutationFn: (id) => purchasePlanningApi.seed(id),
    onSuccess: (res) => {
      setActionMsg(`Seeded ${res.created} row${res.created === 1 ? '' : 's'} from projection (skipped ${res.skipped_existing} existing)`)
      qc.invalidateQueries({ queryKey: ['purchase-planning', periodId] })
    },
    onError: (err) => setActionMsg(`Seed failed: ${err?.response?.data?.detail || err.message}`),
  })
  // Wires the PO # column to the backend. Action shape mirrors the API:
  //   { id, body: { action: 'unlink' } | { action: 'create' } | { action: 'link', purchase_order_id }
  const setPoMut = useMutation({
    mutationFn: ({ id, body }) => purchasePlanningApi.setPo(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-planning', periodId] })
      // The eligible-PO list could shift (a "create" added one, an "unlink"
      // may have deleted an empty PO); refresh both sides.
      qc.invalidateQueries({ queryKey: ['eligible-pos'] })
    },
    onError: (err) => setActionMsg(`Could not update PO: ${err?.response?.data?.detail || err.message}`),
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
      colId: 'converted_order',
      editable: false,
      getValue: (row) => fmtConvertedOrder(row),
    },
    {
      // PO link cell. Editor commits go through a custom path in the cell
      // render (it calls setPoMut, not updateMut), so parseValue is unused
      // here — we treat copy/paste as a no-op for this column.
      colId: 'purchase_order',
      editable: true,
      editorType: 'po',
      getValue: (row) => row.purchase_order_id != null ? String(row.purchase_order_id) : '',
      getDisplay: (row) => row.purchase_order_number
        ? `${row.purchase_order_number} [${row.purchase_order_status || '?'}]`
        : '—',
      parseValue: () => null,
    },
    {
      colId: 'shipping_status',
      editable: true,
      editorType: 'shippingStatus',
      getValue: (row) => row.shipping_status || '',
      getDisplay: (row) => row.shipping_status || '—',
      parseValue: (str) => {
        const t = String(str ?? '').trim()
        if (t === '') return { shipping_status: '' }  // empty string clears
        if (!SHIPPING_STATUS_SET.has(t)) return null
        return { shipping_status: t }
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
      // Bulk-delete checkbox column. Header rendering is handled inline in
      // the table body (we need access to dataRows + setSelectedIds, which
      // live in component scope, not in column meta). The cell render below
      // only fires for non-grouped data rows.
      id: 'select',
      header: '',
      cell: ({ row }) => {
        if (row.getIsGrouped()) return null
        const id = row.original.id
        const checked = selectedIds.has(id)
        return (
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => {
              setSelectedIds((s) => {
                const next = new Set(s)
                if (e.target.checked) next.add(id)
                else next.delete(id)
                return next
              })
            }}
            // Don't let the checkbox click bleed into the cell-selection
            // model — clicking it shouldn't move the spreadsheet anchor.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{ cursor: 'pointer' }}
          />
        )
      },
      enableSorting: false,
      enableColumnFilter: false,
      enableGrouping: false,
    },
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
      id: 'converted_order',
      header: 'Converted Order',
      accessorFn: (row) => fmtConvertedOrder(row),
      cell: ({ row }) => fmtConvertedOrder(row.original) || '—',
      enableSorting: false,
      enableColumnFilter: false,
    },
    {
      id: 'purchase_order',
      header: 'PO #',
      accessorKey: 'purchase_order_number',
      cell: ({ row }) => row.original.purchase_order_number
        ? `${row.original.purchase_order_number} [${row.original.purchase_order_status || '?'}]`
        : '—',
      filterFn: 'includesString',
    },
    {
      id: 'shipping_status',
      header: 'Shipping Status',
      accessorKey: 'shipping_status',
      cell: ({ row }) => row.original.shipping_status || '—',
      filterFn: 'includesString',
    },
  ], [vendors, productTypes, selectedIds])  // eslint-disable-line react-hooks/exhaustive-deps

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

  // Eligible PO list for the row currently being edited. Lazy: only fetched
  // when a PO-cell editor is open, keyed by vendor so each vendor caches
  // independently.
  const editingRow = editing ? dataRows[editing.rowIdx]?.original ?? null : null
  const editingColId = editing ? gridColumnMeta[editing.colIdx]?.colId : null
  const editingPoCellVendorId = editingColId === 'purchase_order' ? (editingRow?.vendor_id ?? null) : null
  const { data: eligiblePos = [], isLoading: eligiblePosLoading } = useQuery({
    queryKey: ['eligible-pos', editingPoCellVendorId],
    queryFn: () => purchasePlanningApi.eligiblePos(editingPoCellVendorId),
    enabled: editingPoCellVendorId != null,
  })

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
          title={!planData.has_current_projection ? 'No current projection for this period — generate one in Projection Dashboard first' : 'Create one row per product type from the projection'}
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
        {selectedIds.size > 0 && (
          <button
            className="btn btn-secondary"
            style={{ color: '#dc2626', borderColor: '#fecaca' }}
            onClick={() => {
              const ids = Array.from(selectedIds)
              if (window.confirm(`Delete ${ids.length} selected row${ids.length === 1 ? '' : 's'}?`)) {
                bulkDeleteMut.mutate(ids)
              }
            }}
            disabled={bulkDeleteMut.isPending}
          >
            {bulkDeleteMut.isPending ? 'Deleting…' : `Delete ${selectedIds.size} selected`}
          </button>
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
          <table className="data-table" style={{ minWidth: 1780 }}>
            {/* The global CSS sets thead { z-index: 1 }, but the body's
                sticky-left cells are also at z:1 — so they paint over the
                header (later in document order wins). Bump thead higher so
                rows scroll under the header instead of through it. */}
            <thead style={{ zIndex: 4 }}>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => {
                    const sortDir = header.column.getIsSorted()
                    const canSort = header.column.getCanSort()
                    const canFilter = header.column.getCanFilter()
                    const canGroup = header.column.getCanGroup()
                    const sticky = STICKY_COLS[header.column.id]
                    const thStyle = {
                      verticalAlign: 'top',
                      ...(sticky && {
                        position: 'sticky',
                        left: sticky.left,
                        // thead is already sticky-top; combining left+top
                        // lets the corner cells stay pinned during scroll
                        // in either direction.
                        zIndex: 3,
                        background: '#f8f8f8',
                        width: sticky.width,
                        minWidth: sticky.width,
                      }),
                    }
                    // The bulk-delete checkbox column: render a "select all"
                    // checkbox instead of the standard sort/filter/group UI.
                    // Indeterminate when some-but-not-all visible rows are
                    // selected — mirrors Gmail / standard table behavior.
                    if (header.column.id === 'select') {
                      const visibleIds = dataRows.map((r) => r.original.id)
                      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
                      const someSelected = visibleIds.some((id) => selectedIds.has(id))
                      return (
                        <th key={header.id} style={{ ...thStyle, textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected }}
                            onChange={(e) => {
                              const checked = e.target.checked
                              setSelectedIds((s) => {
                                const next = new Set(s)
                                if (checked) visibleIds.forEach((id) => next.add(id))
                                else visibleIds.forEach((id) => next.delete(id))
                                return next
                              })
                            }}
                            disabled={visibleIds.length === 0}
                            title={allSelected ? 'Clear selection' : 'Select all visible rows'}
                            style={{ cursor: visibleIds.length === 0 ? 'not-allowed' : 'pointer' }}
                          />
                        </th>
                      )
                    }
                    return (
                      <th key={header.id} style={thStyle}>
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
                  No plan rows yet. Use <strong>Seed from Projection</strong> to auto-create one row per product type in the projection, or <strong>+ Add Row</strong> for a blank row.
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
                        // Mirror lock: when the row is bound to a PO past
                        // in_transit, fields that the PO depends on become
                        // read-only. Status / notes stay editable since they
                        // don't propagate to the PO line.
                        const lockedByPo = !!row.original.locked_by_po
                        const lockedColIds = new Set([
                          'vendor', 'product_type', 'sub_product_type',
                          'purchase_weight_lbs', 'case_weight_lbs', 'purchase_order',
                        ])
                        const isEditable = !!colMeta?.editable && !(lockedByPo && lockedColIds.has(colId))
                        const inRange = isSelectable && selBox != null
                          && rIdx >= selBox.rs && rIdx <= selBox.re
                          && colIdx >= selBox.cs && colIdx <= selBox.ce
                        const isAnchor = isSelectable && selection.anchor
                          && selection.anchor.rowIdx === rIdx && selection.anchor.colIdx === colIdx
                        const isEditing = isEditable && editing
                          && editing.rowIdx === rIdx && editing.colIdx === colIdx
                        // Sticky-left styling for the frozen first columns.
                        // Sticky cells need an opaque background or the cells
                        // they overlap during horizontal scroll bleed through.
                        const sticky = STICKY_COLS[colId]
                        const stickyStyle = sticky ? {
                          position: 'sticky',
                          left: sticky.left,
                          zIndex: 1,
                          width: sticky.width,
                          minWidth: sticky.width,
                        } : {}
                        const rangeBg = inRange && !isAnchor ? '#dbeafe' : null
                        const tdStyle = {
                          padding: 0,
                          background: rangeBg ?? (sticky ? '#fff' : 'transparent'),
                          boxShadow: isAnchor
                            ? 'inset 0 0 0 2px #1d4ed8'
                            : (inRange ? 'inset 0 0 0 1px #93c5fd' : 'none'),
                          position: sticky ? 'sticky' : 'relative',
                          height: 28,
                          verticalAlign: 'middle',
                          ...stickyStyle,
                        }
                        // Non-selectable (the bulk-delete checkbox column).
                        // No spreadsheet-selection visuals; sticky styling is
                        // still applied so the column stays pinned during
                        // horizontal scroll (sticky cells need an opaque
                        // background or the body cells they overlap bleed
                        // through during scroll).
                        if (!isSelectable) {
                          const stickyStyleNS = sticky ? {
                            position: 'sticky',
                            left: sticky.left,
                            zIndex: 1,
                            width: sticky.width,
                            minWidth: sticky.width,
                            background: '#fff',
                          } : {}
                          return (
                            <td
                              key={cell.id}
                              style={{
                                padding: '4px 8px',
                                textAlign: sticky ? 'center' : undefined,
                                ...stickyStyleNS,
                              }}
                            >
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
                                eligiblePos={eligiblePos}
                                eligiblePosLoading={eligiblePosLoading}
                                noVendor={colId === 'purchase_order' && row.original.vendor_id == null}
                                onCommit={(dir, draftValue) => {
                                  if (colId === 'purchase_order') {
                                    // Custom commit: route to setPoMut. Sentinels:
                                    //   ""    → unlink, "new" → create, "<id>" → link.
                                    const v = String(draftValue ?? '')
                                    const current = row.original.purchase_order_id
                                    if (v === '' && current != null) {
                                      setPoMut.mutate({ id: row.original.id, body: { action: 'unlink' } })
                                    } else if (v === 'new') {
                                      setPoMut.mutate({ id: row.original.id, body: { action: 'create' } })
                                    } else if (v && Number(v) !== current) {
                                      setPoMut.mutate({ id: row.original.id, body: { action: 'link', purchase_order_id: Number(v) } })
                                    }
                                  } else {
                                    const update = colMeta.parseValue(draftValue)
                                    if (update) {
                                      updateMut.mutate({ id: row.original.id, data: update })
                                    }
                                  }
                                  setEditing(null)
                                  if (dir) moveAnchor(rIdx, colIdx, dir, dataRows.length)
                                }}
                                onCancel={() => setEditing(null)}
                              />
                            ) : colId === 'purchase_order' && row.original.purchase_order_id ? (
                              <PoCellChip
                                poId={row.original.purchase_order_id}
                                poNumber={row.original.purchase_order_number}
                                poStatus={row.original.purchase_order_status}
                              />
                            ) : colId === 'vendor' && row.original.vendor_id ? (
                              // Vendor cell: name + ⓘ icon that opens the
                              // vendor info popover. Stop both mousedown and
                              // click on the icon so it doesn't move the
                              // spreadsheet anchor or trigger cell editing.
                              <span style={vendorCellDisplayStyle}>
                                <span style={vendorNameTextStyle}>
                                  {colMeta.getDisplay(row.original) || ' '}
                                </span>
                                <button
                                  type="button"
                                  title="Show vendor details and planned items for this period"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const rect = e.currentTarget.getBoundingClientRect()
                                    setVendorInfo({
                                      vendorId: row.original.vendor_id,
                                      anchorRect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right },
                                    })
                                  }}
                                  style={vendorInfoIconStyle}
                                >ⓘ</button>
                              </span>
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
      {vendorInfo && (
        <VendorInfoPopover
          vendorId={vendorInfo.vendorId}
          anchorRect={vendorInfo.anchorRect}
          vendor={vendors.find((v) => v.id === vendorInfo.vendorId)}
          items={items.filter((it) => it.vendor_id === vendorInfo.vendorId)}
          onClose={() => setVendorInfo(null)}
        />
      )}
    </div>
  )
}

// ── Vendor info popover ─────────────────────────────────────────────────────
// Floating panel anchored near the ⓘ icon in the vendor cell. Lists vendor
// contact + address and a copy-paste-ready summary of every planned product
// type for this vendor in the current period.

function buildPlannedItemsText(items) {
  // Two-column layout: "<amount>   <product_type>".
  // - When sub_product_type is set, that substitute IS what we're ordering
  //   from this vendor, so use it and hide the base product type.
  // - Amount uses the same case-vs-lbs rule as the on-screen Converted
  //   Order column, so the copy-pasted message matches the table.
  // - Right-pad amounts with regular spaces to the longest amount + a
  //   2-space gutter so product types line up. The popover textarea is
  //   monospaced, so spaces give a clean column. Falls back gracefully if
  //   it's pasted into a non-monospace surface.
  const rows = items.map((it) => ({
    amount: fmtConvertedOrder(it) || 'TBD',
    name: it.sub_product_type || it.product_type,
  }))
  if (rows.length === 0) return ''
  const colWidth = rows.reduce((m, r) => Math.max(m, r.amount.length), 0) + 2
  return rows
    .map((r) => `${r.amount.padEnd(colWidth)}${r.name}`)
    .join('\n')
}

function VendorInfoPopover({ vendor, items, anchorRect, onClose }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!vendor) {
    return (
      <div style={popoverBackdropStyle} onClick={onClose}>
        <div style={{ ...popoverPanelStyle, top: 100, left: 100 }} onClick={(e) => e.stopPropagation()}>
          <div style={{ padding: 12 }}>Vendor not found.</div>
        </div>
      </div>
    )
  }

  const PANEL_W = 380
  const PANEL_MAX_H = 480
  const margin = 8
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  let top = (anchorRect?.bottom ?? 100) + margin
  if (top + PANEL_MAX_H > vh) top = Math.max(margin, (anchorRect?.top ?? 100) - PANEL_MAX_H - margin)
  let left = (anchorRect?.left ?? 100) - 8
  if (left + PANEL_W > vw - margin) left = vw - PANEL_W - margin
  if (left < margin) left = margin

  // Body of the copy/paste textarea is just the items list — vendor name and
  // period are already visible to the user in the popover header and the
  // page itself, so including them in the pasted message is just noise.
  const fullCopyText = buildPlannedItemsText(items)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fullCopyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard API can fail in non-secure contexts; user can fall back to
      // selecting the textarea manually.
    }
  }

  const contactLines = []
  if (vendor.contact_name) contactLines.push(['Contact', vendor.contact_name])
  if (vendor.contact_email) contactLines.push(['Email', vendor.contact_email])
  if (vendor.contact_phone) contactLines.push(['Phone', vendor.contact_phone])
  if (vendor.contact_whatsapp) contactLines.push(['WhatsApp', vendor.contact_whatsapp])
  if (vendor.preferred_communication) contactLines.push(['Preferred', vendor.preferred_communication])

  return (
    <div style={popoverBackdropStyle} onMouseDown={onClose}>
      <div
        style={{ ...popoverPanelStyle, top, left, width: PANEL_W, maxHeight: PANEL_MAX_H }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={popoverHeaderStyle}>
          <div style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{vendor.name}</div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none', border: 'none', fontSize: 18, lineHeight: 1,
              color: '#6b7280', cursor: 'pointer', padding: 0,
            }}
            title="Close"
          >×</button>
        </div>
        <div style={popoverBodyStyle}>
          {vendor.pickup_address && (
            <div style={popoverSectionStyle}>
              <div style={popoverLabelStyle}>Pickup address</div>
              <div style={popoverAddressStyle}>{vendor.pickup_address}</div>
            </div>
          )}
          {contactLines.length > 0 && (
            <div style={popoverSectionStyle}>
              <div style={popoverLabelStyle}>Contact</div>
              <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                <tbody>
                  {contactLines.map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ color: '#6b7280', paddingRight: 8, verticalAlign: 'top' }}>{k}</td>
                      <td style={{ wordBreak: 'break-all' }}>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={popoverSectionStyle}>
            <div style={{ ...popoverLabelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>
                Planned for this period ({items.length} {items.length === 1 ? 'item' : 'items'})
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={handleCopy}
                disabled={items.length === 0}
              >{copied ? '✓ Copied' : 'Copy'}</button>
            </div>
            {items.length === 0 ? (
              <div style={{ fontSize: 12, color: '#9ca3af' }}>No items planned for this vendor yet.</div>
            ) : (
              <textarea
                readOnly
                value={fullCopyText}
                style={{
                  width: '100%',
                  minHeight: 120,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 12,
                  padding: 8,
                  border: '1px solid #e5e7eb',
                  borderRadius: 4,
                  resize: 'vertical',
                  background: '#fafafa',
                }}
                onFocus={(e) => e.target.select()}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const vendorCellDisplayStyle = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  height: '100%',
  padding: '4px 6px',
  fontSize: 12,
  cursor: 'cell',
  userSelect: 'none',
}

const vendorNameTextStyle = {
  flex: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const vendorInfoIconStyle = {
  marginLeft: 4,
  padding: '0 4px',
  background: 'transparent',
  border: 'none',
  color: '#3b82f6',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
}

const popoverBackdropStyle = {
  position: 'fixed',
  top: 0, left: 0, right: 0, bottom: 0,
  background: 'transparent',
  zIndex: 50,
}

const popoverPanelStyle = {
  position: 'fixed',
  background: '#fff',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  boxShadow: '0 10px 25px rgba(0,0,0,0.12), 0 4px 10px rgba(0,0,0,0.08)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const popoverHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  padding: '8px 12px',
  borderBottom: '1px solid #e5e7eb',
  background: '#f9fafb',
}

const popoverBodyStyle = {
  padding: '8px 12px',
  overflowY: 'auto',
  fontSize: 12,
}

const popoverSectionStyle = {
  marginBottom: 12,
}

const popoverLabelStyle = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#6b7280',
  marginBottom: 4,
}

const popoverAddressStyle = {
  fontSize: 12,
  whiteSpace: 'pre-wrap',
}
