import { useState, useEffect, useRef, useMemo } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
} from '@tanstack/react-table'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { picklistSkusApi, productsApi } from '../api'

// ── Constants ─────────────────────────────────────────────────────────────────

const PICKLIST_CATEGORIES = ['Basic', 'Tropical', 'Exotic']
const PT_DATALIST_ID = 'pt-list-picklist-skus'

// All selectable/editable grid columns (pick_sku is a frozen key col, not here).
// editable:false means the cell is in the selection grid (copyable) but opens no editor.
const GRID_COLS = [
  { key: 'type',                label: 'Pick Type',       type: 'productType', width: 160, editable: true  },
  { key: 'weight_lb',          label: 'Weight (lb)',     type: 'number',      width: 90,  editable: true  },
  { key: 'cost_per_lb',        label: 'Cost/lb ($)',     type: 'number',      width: 95,  editable: true  },
  { key: 'cost_per_case',      label: 'Cost/case ($)',   type: 'number',      width: 95,  editable: true  },
  { key: 'case_weight_lb',     label: 'Case wt (lb)',    type: 'number',      width: 95,  editable: true  },
  { key: 'pactor_multiplier',  label: 'Pactor Mult.',    type: 'number',      width: 95,  editable: true  },
  { key: 'pactor',             label: 'Pactor',          type: 'number',      width: 80,  editable: false }, // computed
  { key: 'temperature',        label: 'Temperature',     type: 'text',        width: 130, editable: true  },
  { key: 'category',           label: 'Category',        type: 'select',      width: 110, options: PICKLIST_CATEGORIES, editable: true },
  { key: 'status',             label: 'Status',          type: 'text',        width: 100, editable: true  },
  { key: 'cc_item_id',         label: 'CC Item ID',      type: 'text',        width: 100, editable: true  },
  { key: 'days_til_expiration',label: 'Days til Expiry', type: 'number',      width: 110, editable: true  },
  { key: 'notes',              label: 'Notes',           type: 'text',        width: 200, editable: true  },
]

const MISSING_COGS_COLS = GRID_COLS.filter(c =>
  ['type', 'weight_lb', 'cost_per_lb', 'cost_per_case', 'case_weight_lb'].includes(c.key)
)

// ── Helpers ───────────────────────────────────────────────────────────────────

function selectionBox(sel) {
  if (!sel.anchor || !sel.focus) return null
  return {
    rs: Math.min(sel.anchor.rowIdx, sel.focus.rowIdx),
    re: Math.max(sel.anchor.rowIdx, sel.focus.rowIdx),
    cs: Math.min(sel.anchor.colIdx, sel.focus.colIdx),
    ce: Math.max(sel.anchor.colIdx, sel.focus.colIdx),
  }
}

function cellsEqual(a, b) {
  if (!a || !b) return false
  return a.rowIdx === b.rowIdx && a.colIdx === b.colIdx
}

function parseTSV(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => l.split('\t'))
}

function buildTSV(rows) {
  return rows.map((cells) => cells.join('\t')).join('\n')
}

function fmtPactor(val) {
  const n = Number(val)
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// Custom TanStack filter that coerces null/numbers to string.
const anyIncludes = (row, colId, filterValue) => {
  const val = row.getValue(colId)
  const str = val == null ? '' : String(val)
  return str.toLowerCase().includes(String(filterValue).toLowerCase())
}
anyIncludes.autoRemove = (val) => !val

// ── Column filter input ───────────────────────────────────────────────────────

function ColumnFilter({ column }) {
  const value = column.getFilterValue() ?? ''
  return (
    <input
      type="text"
      value={value}
      onChange={e => column.setFilterValue(e.target.value || undefined)}
      placeholder="filter…"
      onClick={e => e.stopPropagation()}
      style={{
        width: '100%', fontSize: 11, padding: '2px 4px', marginTop: 4,
        border: '1px solid #e5e7eb', borderRadius: 3, background: '#fff',
        fontWeight: 400, boxSizing: 'border-box', display: 'block',
      }}
    />
  )
}

// ── Cell editor ───────────────────────────────────────────────────────────────

const editorBaseStyle = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  border: 'none',
  outline: 'none',
  padding: '4px 6px',
  fontSize: 12,
  background: '#eff6ff',
  font: 'inherit',
  boxSizing: 'border-box',
  zIndex: 5,
}

function CellEditor({ col, initialValue, onCommit, onCancel }) {
  const [draft, setDraft] = useState(initialValue ?? '')
  const draftRef = useRef(draft)
  draftRef.current = draft
  const inputRef = useRef(null)
  const doneRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (typeof el.select === 'function') el.select()
  }, [])

  function commit(dir) {
    if (doneRef.current) return
    doneRef.current = true
    onCommit(draftRef.current, dir)
  }
  function cancel() {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(e.shiftKey ? 'up' : 'down') }
    else if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? 'left' : 'right') }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  }

  if (col.type === 'select') {
    return (
      <select
        ref={inputRef}
        value={draft ?? ''}
        onChange={e => { draftRef.current = e.target.value; setTimeout(() => commit('down'), 0) }}
        onBlur={() => commit(null)}
        onKeyDown={onKey}
        style={editorBaseStyle}
      >
        <option value="">—</option>
        {col.options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }

  if (col.type === 'productType') {
    return (
      <input
        ref={inputRef}
        type="text"
        list={PT_DATALIST_ID}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => commit(null)}
        onKeyDown={onKey}
        style={editorBaseStyle}
      />
    )
  }

  return (
    <input
      ref={inputRef}
      type={col.type === 'number' ? 'number' : 'text'}
      step={col.type === 'number' ? 'any' : undefined}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => commit(null)}
      onKeyDown={onKey}
      style={editorBaseStyle}
    />
  )
}

// ── Cell display ──────────────────────────────────────────────────────────────

const cellDisplayStyle = {
  display: 'block',
  width: '100%',
  padding: '4px 6px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  userSelect: 'none',
  lineHeight: '22px',
  minHeight: 30,
}

function fmtCell(col, item) {
  const val = item[col.key]
  if (col.key === 'cost_per_lb') {
    if (val != null)
      return <span style={{ color: '#16a34a', fontWeight: 500 }}>${Number(val).toFixed(4)}</span>
    const cpc = item.cost_per_case
    const cwl = item.case_weight_lb
    if (cpc != null && cwl)
      return <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>${(cpc / cwl).toFixed(4)} <span style={{ fontSize: 10 }}>(calc)</span></span>
    return <span style={{ color: '#e5e7eb' }}>—</span>
  }
  if (col.key === 'pactor' && val != null)
    return <span className="pactor-chip pactor-line">{fmtPactor(val)}</span>
  if (val == null || val === '')
    return <span style={{ color: '#e5e7eb' }}>—</span>
  return val
}

// ── Overlay ───────────────────────────────────────────────────────────────────

function Overlay({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {children}
    </div>
  )
}

// ── parseCommit: parse a raw string from the editor into a typed value ────────

function parseValue(col, raw) {
  if (col.type === 'number') {
    const s = String(raw ?? '').trim()
    const n = s === '' ? null : Number(s)
    return Number.isNaN(n) ? null : n
  }
  const s = String(raw ?? '').trim()
  return s === '' ? null : s
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PicklistSkus() {
  const qc = useQueryClient()
  const [urlParams, setUrlParams] = useSearchParams()
  const filter = urlParams.get('filter') || ''
  const isMissingCogs = filter === 'missing-cogs'
  const [search, setSearch] = useState(urlParams.get('search') || '')
  const [categoryFilter, setCategoryFilter] = useState(urlParams.get('category') || '')
  const [page, setPage] = useState(0)
  const limit = 200
  const [syncResult, setSyncResult] = useState(null)

  // ── Spreadsheet state ──────────────────────────────────────────────────────
  // editing: which cell is open in the editor
  const [editing, setEditing] = useState(null)  // { rowIdx, colIdx, initialValue }
  // selection: the highlighted range
  const [selection, setSelection] = useState({ anchor: null, focus: null })
  const draggingRef = useRef(false)
  // kept current so the keyboard handler (useEffect closure) always sees fresh rows
  const dataRowsRef = useRef([])
  const activeColsRef = useRef([])
  // Optimistic bag of pending paste/clear patches, applied before the next render.
  // Without this, two synchronous applyPatchToDirty calls (one per cell pasted)
  // would each functional-update from the same prior dirtyRows state, and the
  // second would overwrite the first inside React's batch.
  const pendingDirtyRef = useRef(null)
  const [clipboardMsg, setClipboardMsg] = useState(null)

  // ── Dirty state ────────────────────────────────────────────────────────────
  const [dirtyRows, setDirtyRows] = useState({})

  // ── Table sort/filter state ────────────────────────────────────────────────
  const [sorting, setSorting] = useState([])
  const [columnFilters, setColumnFilters] = useState([])

  // ── UI state ───────────────────────────────────────────────────────────────
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newSkuDraft, setNewSkuDraft] = useState('')
  const [createError, setCreateError] = useState(null)
  const [saveMsg, setSaveMsg] = useState(null)
  const [saveMsgIsErr, setSaveMsgIsErr] = useState(false)

  const hasDirty = Object.keys(dirtyRows).length > 0
  const dirtyCount = Object.keys(dirtyRows).length
  const activeCols = isMissingCogs ? MISSING_COGS_COLS : GRID_COLS
  activeColsRef.current = activeCols

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: productTypes = [] } = useQuery({
    queryKey: ['product-types'],
    queryFn: productsApi.listProductTypes,
    staleTime: 60_000,
  })

  const { data = { total: 0, items: [] }, isLoading } = useQuery({
    queryKey: ['picklist-skus', search, categoryFilter, page],
    queryFn: () => picklistSkusApi.list({
      search: search || undefined,
      category: categoryFilter || undefined,
      skip: page * limit,
      limit,
    }),
    enabled: !isMissingCogs,
  })

  const { data: missingCogsData = [], isLoading: missingLoading } = useQuery({
    queryKey: ['picklist-skus-missing-cogs'],
    queryFn: picklistSkusApi.missingCogs,
    enabled: isMissingCogs,
  })

  // ── Effective items: server data merged with dirty edits + computed fields ─
  const serverItems = data.items
  const effectiveItems = useMemo(() =>
    serverItems.map(item => {
      const dirty = dirtyRows[item.id] || {}
      const merged = { ...item, ...dirty }
      // Pactor is always the product of pactor_multiplier × weight_lb
      if (merged.pactor_multiplier != null && merged.weight_lb != null) {
        merged.pactor = merged.pactor_multiplier * merged.weight_lb
      }
      return merged
    }),
    [serverItems, dirtyRows]
  )

  // ── TanStack Table (main view only) ───────────────────────────────────────
  const tableColumns = useMemo(() => [
    {
      id: 'pick_sku',
      header: 'Pick SKU',
      accessorKey: 'pick_sku',
      enableSorting: true,
      enableColumnFilter: false,  // handled by toolbar search
    },
    ...GRID_COLS.map(col => ({
      id: col.key,
      header: col.label,
      accessorKey: col.key,
      enableSorting: true,
      enableColumnFilter: true,
      filterFn: anyIncludes,
    })),
  ], [])

  const table = useReactTable({
    data: effectiveItems,
    columns: tableColumns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  // dataRows is the sorted+filtered visible rows for the main view
  const dataRows = isMissingCogs ? [] : table.getRowModel().rows
  dataRowsRef.current = dataRows

  // ── Navigation guards ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasDirty) return
    function onBeforeUnload(e) { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasDirty])

  useEffect(() => {
    if (!hasDirty) return
    function onNavClick(e) {
      const link = e.target.closest('a[href]')
      if (!link) return
      const href = link.getAttribute('href')
      if (!href || href.startsWith('http') || href.startsWith('#')) return
      if (!window.confirm('You have unsaved changes. Leave without saving?')) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('click', onNavClick, true)
    return () => document.removeEventListener('click', onNavClick, true)
  }, [hasDirty])

  // ── Clear selection when view changes ──────────────────────────────────────
  useEffect(() => {
    setSelection({ anchor: null, focus: null })
    setEditing(null)
  }, [sorting, columnFilters, search, categoryFilter, page, isMissingCogs])

  // ── Mouse drag: end on window mouseup ─────────────────────────────────────
  useEffect(() => {
    function onMouseUp() { draggingRef.current = false }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [])

  // ── Keyboard + clipboard handlers ──────────────────────────────────────────
  // Structured to mirror PurchasePlanning: cmd-shortcut handlers run AFTER the
  // active-cell navigation block, both branches use refs so the effect doesn't
  // need to re-bind on every render.
  useEffect(() => {
    function isInputEl(el) {
      if (!el) return false
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' || el.isContentEditable
    }

    function onCopy(e) {
      if (isInputEl(document.activeElement)) return
      const box = selectionBox(selection)
      if (!box) return
      const tsv = selectionToTSVFromBox(box)
      if (!tsv) return
      e.clipboardData.setData('text/plain', tsv)
      e.preventDefault()
      flashClipboardMsg(`Copied ${(box.re - box.rs + 1)} × ${(box.ce - box.cs + 1)} cells`)
    }

    function onPaste(e) {
      if (!selection.anchor) return
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      const matrix = parseTSV(text)
      const isMulti = matrix.length > 1 || (matrix[0]?.length ?? 0) > 1
      if (!isMulti && isInputEl(document.activeElement)) return
      e.preventDefault()
      const n = distributeToCells(matrix, selection.anchor)
      flashClipboardMsg(`Pasted ${n} row${n === 1 ? '' : 's'}`)
    }

    async function onKeyDown(e) {
      const rows = dataRowsRef.current
      const cols = activeColsRef.current

      if (isInputEl(document.activeElement)) return

      if (e.key === 'Escape') {
        if (editing) { setEditing(null); return }
        setSelection({ anchor: null, focus: null })
        return
      }

      const cmd = e.metaKey || e.ctrlKey
      const anc = selection.anchor

      // Active-cell navigation when we have an anchor and are not editing.
      if (!editing && anc) {
        const arrowDir = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right' }[e.key]
        if (arrowDir) {
          e.preventDefault()
          if (e.shiftKey) {
            setSelection(prev => {
              const foc = prev.focus || prev.anchor
              if (!foc) return prev
              let nr = foc.rowIdx, nc = foc.colIdx
              if (arrowDir === 'up')    nr = Math.max(0, nr - 1)
              if (arrowDir === 'down')  nr = Math.min(rows.length - 1, nr + 1)
              if (arrowDir === 'left')  nc = Math.max(0, nc - 1)
              if (arrowDir === 'right') nc = Math.min(cols.length - 1, nc + 1)
              return { anchor: prev.anchor, focus: { rowIdx: nr, colIdx: nc } }
            })
          } else {
            let nr = anc.rowIdx, nc = anc.colIdx
            if (arrowDir === 'up')    nr = Math.max(0, nr - 1)
            if (arrowDir === 'down')  nr = Math.min(rows.length - 1, nr + 1)
            if (arrowDir === 'left')  nc = Math.max(0, nc - 1)
            if (arrowDir === 'right') nc = Math.min(cols.length - 1, nc + 1)
            setSelection({ anchor: { rowIdx: nr, colIdx: nc }, focus: { rowIdx: nr, colIdx: nc } })
          }
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          let nc = e.shiftKey ? Math.max(0, anc.colIdx - 1) : Math.min(cols.length - 1, anc.colIdx + 1)
          setSelection({ anchor: { rowIdx: anc.rowIdx, colIdx: nc }, focus: { rowIdx: anc.rowIdx, colIdx: nc } })
          return
        }
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault()
          const col = cols[anc.colIdx]
          const item = rows[anc.rowIdx]?.original
          if (col?.editable && item) {
            setEditing({ rowIdx: anc.rowIdx, colIdx: anc.colIdx, initialValue: String(item[col.key] ?? '') })
          }
          return
        }
        if (!cmd && (e.key === 'Backspace' || e.key === 'Delete')) {
          e.preventDefault()
          const n = clearSelectionCellsForBox(selectionBox(selection))
          if (n) flashClipboardMsg(`Cleared ${n} row${n === 1 ? '' : 's'}`)
          return
        }
        if (!cmd && e.key.length === 1) {
          const col = cols[anc.colIdx]
          if (col?.editable) {
            e.preventDefault()
            setEditing({ rowIdx: anc.rowIdx, colIdx: anc.colIdx, initialValue: e.key })
          }
          return
        }
      }

      // Cmd-shortcut handlers — run regardless of whether we have an anchor
      // (paste needs an anchor; copy/cut need a selection).
      if (!cmd) return
      const k = e.key.toLowerCase()
      if (k === 'c') {
        const box = selectionBox(selection)
        if (!box) return
        e.preventDefault()
        const tsv = selectionToTSVFromBox(box)
        if (tsv) {
          try { await navigator.clipboard.writeText(tsv) } catch {}
          flashClipboardMsg(`Copied ${(box.re - box.rs + 1)} × ${(box.ce - box.cs + 1)} cells`)
        }
        return
      }
      if (k === 'v' && selection.anchor) {
        e.preventDefault()
        try {
          const text = await navigator.clipboard.readText()
          const matrix = parseTSV(text)
          if (matrix.length) {
            const n = distributeToCells(matrix, selection.anchor)
            flashClipboardMsg(`Pasted ${n} row${n === 1 ? '' : 's'}`)
          }
        } catch {}
        return
      }
      if (k === 'x') {
        const box = selectionBox(selection)
        if (!box) return
        e.preventDefault()
        const tsv = selectionToTSVFromBox(box)
        if (tsv) { try { await navigator.clipboard.writeText(tsv) } catch {} }
        const n = clearSelectionCellsForBox(box)
        flashClipboardMsg(`Cut ${n} row${n === 1 ? '' : 's'}`)
        return
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
  }, [selection, editing])

  // ── Mutations ──────────────────────────────────────────────────────────────
  const syncMut = useMutation({
    mutationFn: picklistSkusApi.sync,
    onSuccess: (res) => {
      setSyncResult(res)
      qc.invalidateQueries(['picklist-skus'])
      qc.invalidateQueries(['picklist-skus-missing-cogs'])
      qc.invalidateQueries(['pactor-map'])
    },
  })

  const saveMut = useMutation({
    mutationFn: async () => {
      const count = Object.keys(dirtyRows).length
      await Promise.all(
        Object.entries(dirtyRows).map(([id, changes]) =>
          picklistSkusApi.update(parseInt(id), changes)
        )
      )
      return count
    },
    onSuccess: (count) => {
      setDirtyRows({})
      setSaveMsg(`Saved ${count} row${count === 1 ? '' : 's'}`)
      setSaveMsgIsErr(false)
      setTimeout(() => setSaveMsg(null), 3000)
      qc.invalidateQueries(['picklist-skus'])
      qc.invalidateQueries(['picklist-skus-missing-cogs'])
    },
    onError: (err) => {
      setSaveMsg(`Save failed: ${err?.response?.data?.detail || err.message}`)
      setSaveMsgIsErr(true)
    },
  })

  const createMut = useMutation({
    mutationFn: (payload) => picklistSkusApi.create(payload),
    onSuccess: () => {
      setShowCreateModal(false)
      setNewSkuDraft('')
      setCreateError(null)
      qc.invalidateQueries(['picklist-skus'])
    },
    onError: (err) => setCreateError(err?.response?.data?.detail || err.message),
  })

  // ── commitEdit ─────────────────────────────────────────────────────────────
  // Called by CellEditor when user presses Enter/Tab/blur. rawValue is the
  // string from the input; this function parses it, checks if the value
  // actually changed vs the server, and auto-computes derived fields.
  function commitEdit(rowIdx, colIdx, rawValue, dir, overrideItems, overrideRows) {
    const cols = activeCols
    const col = cols[colIdx]
    if (!col || !col.editable) { setEditing(null); return }

    const value = parseValue(col, rawValue)

    // Use passed-in items/rows for the missing-COGS view, else use component state
    const rows = overrideRows ?? dataRowsRef.current
    const srcItems = overrideItems ?? serverItems

    const effectiveItem = rows[rowIdx]?.original ?? (overrideRows ? overrideRows[rowIdx] : null)
    if (!effectiveItem) { setEditing(null); return }

    const serverItem = srcItems.find(r => r.id === effectiveItem.id)
    const updates = {}

    // Only mark dirty if the value actually changed from server
    const serverValue = serverItem?.[col.key] ?? null
    if (value !== serverValue) {
      updates[col.key] = value
    }

    // Auto-compute pactor = pactor_multiplier × weight_lb
    if (col.key === 'pactor_multiplier' || col.key === 'weight_lb') {
      const mult = col.key === 'pactor_multiplier' ? value : (effectiveItem.pactor_multiplier ?? null)
      const wt   = col.key === 'weight_lb'          ? value : (effectiveItem.weight_lb ?? null)
      if (mult != null && wt != null) {
        const computed = mult * wt
        if (computed !== (serverItem?.pactor ?? null)) updates.pactor = computed
      }
    }

    // Auto-compute cost_per_lb = cost_per_case / case_weight_lb
    // (only fills cost_per_lb when it isn't already explicitly set)
    if (col.key === 'cost_per_case' || col.key === 'case_weight_lb') {
      const cpc = col.key === 'cost_per_case'  ? value : (effectiveItem.cost_per_case ?? null)
      const cwl = col.key === 'case_weight_lb' ? value : (effectiveItem.case_weight_lb ?? null)
      const existingCpl = dirtyRows[effectiveItem.id]?.cost_per_lb ?? (serverItem?.cost_per_lb ?? null)
      if (cpc != null && cwl != null && cwl !== 0 && existingCpl == null) {
        updates.cost_per_lb = cpc / cwl
      }
    }

    if (Object.keys(updates).length > 0) {
      setDirtyRows(prev => ({
        ...prev,
        [effectiveItem.id]: { ...(prev[effectiveItem.id] || {}), ...updates },
      }))
    }

    setEditing(null)

    // Navigate anchor to next cell after commit
    if (dir) {
      const numRows = rows.length
      const numCols = cols.length
      let nr = rowIdx, nc = colIdx
      if (dir === 'down')  nr = Math.min(numRows - 1, nr + 1)
      if (dir === 'up')    nr = Math.max(0, nr - 1)
      if (dir === 'right') nc = Math.min(numCols - 1, nc + 1)
      if (dir === 'left')  nc = Math.max(0, nc - 1)
      setSelection({ anchor: { rowIdx: nr, colIdx: nc }, focus: { rowIdx: nr, colIdx: nc } })
    }
  }

  // ── Apply a typed patch (key→value map) into dirtyRows for one item ────────
  // Routes through pendingDirtyRef so a synchronous batch (paste of N cells)
  // accumulates before React renders, instead of each setState clobbering the
  // last. Also handles auto-compute and server-comparison.
  function applyPatchToDirty(itemId, rawPatch) {
    setDirtyRows(prev => {
      const base = pendingDirtyRef.current ?? prev
      const serverItem = serverItems.find(r => r.id === itemId)
      const existing = base[itemId] || {}
      const merged = { ...existing }
      for (const [k, v] of Object.entries(rawPatch)) {
        const serverVal = serverItem?.[k] ?? null
        if (v === serverVal) delete merged[k]
        else merged[k] = v
      }
      if ('pactor_multiplier' in rawPatch || 'weight_lb' in rawPatch) {
        const mult = ('pactor_multiplier' in merged) ? merged.pactor_multiplier
                   : (serverItem?.pactor_multiplier ?? null)
        const wt = ('weight_lb' in merged) ? merged.weight_lb
                : (serverItem?.weight_lb ?? null)
        if (mult != null && wt != null) {
          const computed = mult * wt
          if (computed !== (serverItem?.pactor ?? null)) merged.pactor = computed
          else delete merged.pactor
        }
      }
      if (!('cost_per_lb' in rawPatch) &&
          ('cost_per_case' in rawPatch || 'case_weight_lb' in rawPatch)) {
        const cpc = ('cost_per_case' in merged) ? merged.cost_per_case
                  : (serverItem?.cost_per_case ?? null)
        const cwl = ('case_weight_lb' in merged) ? merged.case_weight_lb
                  : (serverItem?.case_weight_lb ?? null)
        const existingCpl = ('cost_per_lb' in merged) ? merged.cost_per_lb
                          : (serverItem?.cost_per_lb ?? null)
        if (cpc != null && cwl != null && cwl !== 0 && existingCpl == null) {
          merged.cost_per_lb = cpc / cwl
        }
      }
      const next = { ...base }
      if (Object.keys(merged).length === 0) delete next[itemId]
      else next[itemId] = merged
      pendingDirtyRef.current = next
      // Schedule the bag clear after React commits.
      queueMicrotask(() => { pendingDirtyRef.current = null })
      return next
    })
  }

  // ── Clipboard: selection → TSV, TSV → distribute, clear range ──────────────
  function flashClipboardMsg(text) {
    setClipboardMsg(text)
    setTimeout(() => setClipboardMsg(null), 2000)
  }

  function selectionToTSVFromBox(box) {
    if (!box) return ''
    const rows = dataRowsRef.current
    const cols = activeColsRef.current
    const out = []
    for (let r = box.rs; r <= box.re; r++) {
      if (r >= rows.length) continue
      const item = rows[r]?.original
      if (!item) continue
      const cells = []
      for (let c = box.cs; c <= box.ce; c++) {
        if (c >= cols.length) continue
        const v = item[cols[c].key]
        cells.push(v == null ? '' : String(v))
      }
      out.push(cells)
    }
    return buildTSV(out)
  }

  function distributeToCells(matrix, pasteAnchor) {
    if (!matrix.length) return 0
    const rows = dataRowsRef.current
    const cols = activeColsRef.current
    const matH = matrix.length
    const matW = matrix.reduce((m, r) => Math.max(m, r.length), 0)
    if (matW === 0) return 0

    // Excel-like fill: when there's a multi-cell selection box larger than the
    // clipboard, tile the matrix to fill the box (1×1 → fill all selected; an
    // N×M block tiles when its dims evenly divide the selection's dims).
    const box = selectionBox(selection)
    let startRow = pasteAnchor.rowIdx
    let startCol = pasteAnchor.colIdx
    let targetRows = matH
    let targetCols = matW
    if (box) {
      const selH = box.re - box.rs + 1
      const selW = box.ce - box.cs + 1
      const fitsRows = selH >= matH && selH % matH === 0
      const fitsCols = selW >= matW && selW % matW === 0
      if (fitsRows && fitsCols && (selH > matH || selW > matW)) {
        startRow = box.rs
        startCol = box.cs
        targetRows = selH
        targetCols = selW
      }
    }

    const patchesByRow = new Map()
    for (let i = 0; i < targetRows; i++) {
      const r = startRow + i
      if (r >= rows.length) break
      const item = rows[r]?.original
      if (!item) continue
      const patch = patchesByRow.get(item.id) || {}
      const srcRow = matrix[i % matH]
      for (let j = 0; j < targetCols; j++) {
        const c = startCol + j
        if (c >= cols.length) break
        const col = cols[c]
        if (!col.editable) continue
        patch[col.key] = parseValue(col, srcRow[j % matW])
      }
      if (Object.keys(patch).length) patchesByRow.set(item.id, patch)
    }
    for (const [id, patch] of patchesByRow) applyPatchToDirty(id, patch)
    const lastRow = Math.min(startRow + targetRows - 1, rows.length - 1)
    const lastCol = Math.min(startCol + targetCols - 1, cols.length - 1)
    setSelection({ anchor: { rowIdx: startRow, colIdx: startCol }, focus: { rowIdx: lastRow, colIdx: lastCol } })
    return patchesByRow.size
  }

  function clearSelectionCellsForBox(box) {
    if (!box) return 0
    const rows = dataRowsRef.current
    const cols = activeColsRef.current
    let touched = 0
    for (let r = box.rs; r <= box.re; r++) {
      const item = rows[r]?.original
      if (!item) continue
      const patch = {}
      for (let c = box.cs; c <= box.ce; c++) {
        const col = cols[c]
        if (!col?.editable) continue
        patch[col.key] = null
      }
      if (Object.keys(patch).length) {
        applyPatchToDirty(item.id, patch)
        touched++
      }
    }
    return touched
  }

  // ── Cell mouse handlers ────────────────────────────────────────────────────
  function handleCellMouseDown(e, rIdx, colIdx) {
    // If clicking the active editor cell, let native events through
    if (editing?.rowIdx === rIdx && editing?.colIdx === colIdx) return
    e.preventDefault()
    if (e.shiftKey) {
      setSelection(s => ({
        anchor: s.anchor || { rowIdx: rIdx, colIdx },
        focus: { rowIdx: rIdx, colIdx },
      }))
    } else {
      setSelection({ anchor: { rowIdx: rIdx, colIdx }, focus: { rowIdx: rIdx, colIdx } })
      draggingRef.current = true
    }
    // Close any editor that was open on a different cell
    if (editing && (editing.rowIdx !== rIdx || editing.colIdx !== colIdx)) {
      setEditing(null)
    }
  }

  function handleCellMouseEnter(rIdx, colIdx) {
    if (!draggingRef.current) return
    setSelection(s => ({
      anchor: s.anchor || { rowIdx: rIdx, colIdx },
      focus: { rowIdx: rIdx, colIdx },
    }))
  }

  function handleCellDoubleClick(rIdx, colIdx, itemsSource, rowsSource) {
    const col = activeCols[colIdx]
    if (!col?.editable) return
    const rows = rowsSource ?? dataRowsRef.current
    const item = rows[rIdx]?.original ?? (rowsSource ? rowsSource[rIdx] : null)
    if (!item) return
    setEditing({ rowIdx: rIdx, colIdx, initialValue: String(item[col.key] ?? '') })
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const { total } = isMissingCogs ? { total: missingCogsData.length } : data
  const totalPages = isMissingCogs ? 1 : Math.ceil((total || 0) / limit)
  const selBox = selectionBox(selection)
  const headerGroups = table.getHeaderGroups()
  const isFiltered = columnFilters.length > 0 || sorting.length > 0

  function clearFilter() {
    const next = new URLSearchParams(urlParams)
    next.delete('filter')
    setUrlParams(next, { replace: true })
  }

  // ── Missing-COGS effective items (no TanStack — special view) ──────────────
  const missingEffective = useMemo(() =>
    missingCogsData.map(item => ({
      ...item, ...(dirtyRows[item.id] || {})
    })),
    [missingCogsData, dirtyRows]
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Create SKU modal */}
      {showCreateModal && (
        <Overlay>
          <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Create New SKU</h3>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                Pick SKU <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input
                autoFocus
                value={newSkuDraft}
                onChange={e => { setNewSkuDraft(e.target.value); setCreateError(null) }}
                onKeyDown={e => { if (e.key === 'Enter' && newSkuDraft.trim()) createMut.mutate({ pick_sku: newSkuDraft.trim() }) }}
                style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}
                placeholder="e.g. apple_honeycrisp-01x02"
              />
            </div>
            {createError && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 12 }}>{createError}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => { setShowCreateModal(false); setNewSkuDraft(''); setCreateError(null) }}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={() => newSkuDraft.trim() && createMut.mutate({ pick_sku: newSkuDraft.trim() })}
                disabled={!newSkuDraft.trim() || createMut.isPending}
              >
                {createMut.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </Overlay>
      )}

      <div className="page-header">
        <h1>Picklist SKUs</h1>
        <p>App is source of truth. Sync pulls from Google Sheets; edits here override sheet values.</p>
        <p style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
          Click to select · Drag or shift-click for range · Shift+arrow to extend · Double-click / Enter / F2 to edit
        </p>
      </div>

      {isMissingCogs && (
        <div className="warning-banner" style={{ justifyContent: 'space-between' }}>
          <span>
            <strong>Filter: SKUs missing COGS</strong> — {missingCogsData.length} SKU{missingCogsData.length === 1 ? '' : 's'} need cost data.
            Set <code>cost_per_lb</code> or <code>cost_per_case</code> + <code>case_weight_lb</code>.
          </span>
          <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={clearFilter}>Clear filter</button>
        </div>
      )}

      {/* Toolbar */}
      <div className="toolbar">
        {!isMissingCogs && (
          <>
            <input
              placeholder="Search SKU or description…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(0) }}
              style={{ minWidth: 240 }}
            />
            <select
              value={categoryFilter}
              onChange={e => { setCategoryFilter(e.target.value); setPage(0) }}
              style={{ fontSize: 13, padding: '4px 6px' }}
            >
              <option value="">All categories</option>
              {PICKLIST_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="uncategorized">Uncategorized</option>
            </select>
          </>
        )}

        <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>+ New SKU</button>

        {hasDirty && (
          <>
            <button
              className="btn btn-primary"
              style={{ background: '#16a34a', borderColor: '#16a34a' }}
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
            >
              {saveMut.isPending ? 'Saving…' : `Save (${dirtyCount} row${dirtyCount === 1 ? '' : 's'})`}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => { setDirtyRows({}); setEditing(null) }}
              disabled={saveMut.isPending}
            >
              Discard
            </button>
          </>
        )}

        {isFiltered && !isMissingCogs && (
          <button className="btn btn-secondary" onClick={() => { setColumnFilters([]); setSorting([]) }}>
            Clear filters &amp; sort
          </button>
        )}

        <button
          className="btn btn-primary"
          onClick={() => { setSyncResult(null); syncMut.mutate() }}
          disabled={syncMut.isPending}
        >
          {syncMut.isPending ? 'Syncing…' : '↓ Sync from Sheets'}
        </button>

        {saveMsg && <span style={{ fontSize: 12, color: saveMsgIsErr ? '#dc2626' : '#16a34a' }}>{saveMsg}</span>}
        {clipboardMsg && <span style={{ fontSize: 12, color: '#2563eb', fontWeight: 500 }}>{clipboardMsg}</span>}
        {syncResult && !syncMut.isPending && (
          <span style={{ fontSize: 12, color: '#16a34a' }}>
            Synced: {syncResult.created} created, {syncResult.updated} updated ({syncResult.total} total)
          </span>
        )}
        {syncMut.isError && (
          <span style={{ fontSize: 12, color: '#dc2626' }}>
            Sync failed: {syncMut.error?.response?.data?.detail || syncMut.error?.message}
          </span>
        )}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {total} SKU{total === 1 ? '' : 's'}
        </span>
      </div>

      {/* Datalist for Pick Type autocomplete */}
      <datalist id={PT_DATALIST_ID}>
        {productTypes
          .map(pt => typeof pt === 'string' ? pt : pt?.product_type)
          .filter(Boolean)
          .map(pt => <option key={pt} value={pt} />)}
      </datalist>

      {/* Empty state */}
      {!isMissingCogs && !isLoading && effectiveItems.length === 0 && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#9ca3af' }}>
          No picklist SKUs. Click <strong>Sync from Sheets</strong> to pull data.
        </div>
      )}
      {isMissingCogs && !missingLoading && missingCogsData.length === 0 && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#9ca3af' }}>No SKUs missing COGS. All set!</div>
      )}

      {/* ── Main view table with TanStack sort/filter + selection grid ─────── */}
      {!isMissingCogs && (dataRows.length > 0 || isLoading) && (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 280px)' }}>
          <table className="data-table" style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 4, background: '#f9fafb' }}>
              {headerGroups.map(hg => (
                <tr key={hg.id}>
                  {/* Frozen Pick SKU header */}
                  {(() => {
                    const h = hg.headers.find(x => x.column.id === 'pick_sku')
                    if (!h) return null
                    const sortDir = h.column.getIsSorted()
                    return (
                      <th key={h.id} style={{
                        position: 'sticky', left: 0, zIndex: 5,
                        background: '#f9fafb', minWidth: 170,
                        borderRight: '2px solid #e5e7eb', verticalAlign: 'top',
                      }}>
                        <span
                          onClick={h.column.getToggleSortingHandler()}
                          style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                        >
                          Pick SKU {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : <span style={{ color: '#d1d5db' }}>↕</span>}
                        </span>
                      </th>
                    )
                  })()}
                  {/* Editable column headers */}
                  {hg.headers
                    .filter(h => h.column.id !== 'pick_sku')
                    .map(h => {
                      const sortDir = h.column.getIsSorted()
                      const colMeta = GRID_COLS.find(c => c.key === h.column.id)
                      return (
                        <th key={h.id} style={{ minWidth: colMeta?.width ?? 100, verticalAlign: 'top' }}>
                          <span
                            onClick={h.column.getToggleSortingHandler()}
                            style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', display: 'block' }}
                          >
                            {colMeta?.label ?? h.column.id}
                            {' '}
                            {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : <span style={{ color: '#d1d5db' }}>↕</span>}
                          </span>
                          {h.column.getCanFilter() && <ColumnFilter column={h.column} />}
                        </th>
                      )
                    })}
                </tr>
              ))}
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={tableColumns.length} style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Loading…</td></tr>
              )}
              {dataRows.map((row, rIdx) => {
                const item = row.original
                const rowDirty = dirtyRows[item.id]
                return (
                  <tr key={item.id} style={{ background: rowDirty ? '#fffef7' : undefined }}>
                    {/* Frozen Pick SKU cell */}
                    <td style={{
                      position: 'sticky', left: 0, zIndex: 1,
                      background: rowDirty ? '#fffef7' : '#fff',
                      borderRight: '2px solid #e5e7eb',
                      padding: '4px 8px', fontSize: 12, whiteSpace: 'nowrap',
                      color: '#16a34a', fontWeight: 500, fontFamily: 'monospace',
                    }}>
                      {item.pick_sku}
                    </td>

                    {/* Editable / selectable grid cells */}
                    {activeCols.map((col, colIdx) => {
                      const isEditingCell = editing?.rowIdx === rIdx && editing?.colIdx === colIdx
                      const isAnchor = selection.anchor?.rowIdx === rIdx && selection.anchor?.colIdx === colIdx
                      const isInRange = selBox != null
                        && rIdx >= selBox.rs && rIdx <= selBox.re
                        && colIdx >= selBox.cs && colIdx <= selBox.ce
                      const isDirty = rowDirty != null && col.key in rowDirty
                      return (
                        <td
                          key={col.key}
                          style={{
                            position: 'relative', padding: 0, minWidth: col.width,
                            background: isEditingCell ? '#dbeafe'
                              : isInRange     ? '#eff6ff'
                              : isDirty       ? '#fef9c3'
                              : undefined,
                            outline: isAnchor ? '2px solid #3b82f6' : undefined,
                            outlineOffset: -1,
                            cursor: col.editable ? 'cell' : 'default',
                          }}
                          onMouseDown={e => handleCellMouseDown(e, rIdx, colIdx)}
                          onMouseEnter={() => handleCellMouseEnter(rIdx, colIdx)}
                          onDoubleClick={() => handleCellDoubleClick(rIdx, colIdx)}
                        >
                          {isEditingCell ? (
                            <CellEditor
                              col={col}
                              initialValue={editing.initialValue}
                              onCommit={(raw, dir) => commitEdit(rIdx, colIdx, raw, dir)}
                              onCancel={() => setEditing(null)}
                            />
                          ) : (
                            <span style={cellDisplayStyle}>{fmtCell(col, item)}</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Missing COGS view (simpler table, no TanStack) ─────────────────── */}
      {isMissingCogs && missingEffective.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ minWidth: 170 }}>Pick SKU</th>
                <th style={{ minWidth: 90 }} title="Active orders blocked">Orders blocked</th>
                <th style={{ minWidth: 110 }} title="Total revenue of blocked orders">Revenue at risk</th>
                {MISSING_COGS_COLS.map(col => (
                  <th key={col.key} style={{ minWidth: col.width }}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {missingEffective.map((item, rIdx) => {
                const rowDirty = dirtyRows[item.id]
                return (
                  <tr key={item.id}>
                    <td style={{ fontSize: 12, color: '#16a34a', fontWeight: 500, fontFamily: 'monospace', padding: '4px 8px', whiteSpace: 'nowrap' }}>
                      {item.pick_sku}
                    </td>
                    <td style={{ fontSize: 13, fontWeight: 600, color: '#dc2626' }}>{item.affected_order_count ?? 0}</td>
                    <td style={{ fontSize: 13 }}>${(item.revenue_at_risk ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    {MISSING_COGS_COLS.map((col, colIdx) => {
                      const isEditingCell = editing?.rowIdx === rIdx && editing?.colIdx === colIdx
                      const isDirty = rowDirty != null && col.key in rowDirty
                      return (
                        <td
                          key={col.key}
                          style={{
                            position: 'relative', padding: 0, minWidth: col.width,
                            background: isEditingCell ? '#dbeafe' : isDirty ? '#fef9c3' : undefined,
                            outline: isEditingCell ? '2px solid #3b82f6' : undefined,
                            cursor: col.editable ? 'cell' : 'default',
                          }}
                          onMouseDown={e => {
                            e.preventDefault()
                            setSelection({ anchor: { rowIdx: rIdx, colIdx }, focus: { rowIdx: rIdx, colIdx } })
                            if (editing && (editing.rowIdx !== rIdx || editing.colIdx !== colIdx)) setEditing(null)
                          }}
                          onDoubleClick={() => {
                            if (!col.editable) return
                            setEditing({ rowIdx: rIdx, colIdx, initialValue: String(item[col.key] ?? '') })
                          }}
                        >
                          {isEditingCell ? (
                            <CellEditor
                              col={col}
                              initialValue={editing.initialValue}
                              onCommit={(raw, dir) =>
                                commitEdit(rIdx, colIdx, raw, dir, missingCogsData, missingEffective.map(x => ({ original: x })))
                              }
                              onCancel={() => setEditing(null)}
                            />
                          ) : (
                            <span style={cellDisplayStyle}>{fmtCell(col, item)}</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, fontSize: 13 }}>
          <button className="btn btn-secondary" onClick={() => setPage(p => p - 1)} disabled={page === 0}>← Prev</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button className="btn btn-secondary" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1}>Next →</button>
        </div>
      )}
    </div>
  )
}
