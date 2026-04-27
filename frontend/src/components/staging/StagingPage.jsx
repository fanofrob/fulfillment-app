import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ordersApi, inventoryApi, productsApi, fulfillmentApi, rulesApi, shipstationApi } from '../../api'
import InventoryDashboard from '../../pages/InventoryDashboard'
import OrderDetailPanel from '../../pages/OrderDetailPanel'

// ── CSV Export ─────────────────────────────────────────────────────────────────

function csvEscape(val) {
  if (val === null || val === undefined) return ''
  const s = String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
  return s
}

const STAGED_CSV_HEADERS = [
  'order_number', 'customer', 'priority_tier', 'order_date',
  'total_price', 'fulfillable_revenue', 'tags', 'warehouse', 'plan_issue',
]

function exportStagedCsv(orders, priorityTagSets, label) {
  const rows = orders.map(o => {
    const tier = getOrderPriorityTier(o, priorityTagSets)
    const tierLabel = tier === 1 ? 'P1' : tier === 2 ? 'P2' : tier === 3 ? 'P3' : 'Standard'
    const issueLabels = []
    if (!o.has_plan) issueLabels.push('No Plan')
    else if (o.plan_box_unmatched) issueLabels.push('No Box Rule')
    else if (o.has_plan_mismatch) issueLabels.push('Plan Mismatch')
    if (o.ss_duplicate) issueLabels.push('SS Duplicate')
    return [
      o.shopify_order_number || o.shopify_order_id,
      o.customer_name || '',
      tierLabel,
      o.created_at_shopify ? new Date(o.created_at_shopify).toLocaleDateString() : '',
      o.total_price != null ? Number(o.total_price).toFixed(2) : '',
      computeFulfillableRevenue(o).toFixed(2),
      (o.tags || '').split(',').map(t => t.trim()).filter(Boolean).join('; '),
      o.assigned_warehouse || '',
      issueLabels.join('; '),
    ].map(csvEscape).join(',')
  })
  const csv = [STAGED_CSV_HEADERS.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `staged-orders-${label}-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function PlanIssueBadges({ order }) {
  const issues = []
  if (!order.has_plan) issues.push({ label: 'No Plan', color: '#dc2626', bg: '#fef2f2' })
  else if (order.plan_box_unmatched) issues.push({ label: 'No Box Rule', color: '#d97706', bg: '#fffbeb' })
  else if (order.has_plan_mismatch) issues.push({ label: 'Plan Mismatch', color: '#7c3aed', bg: '#f5f3ff' })
  if (order.ss_duplicate) issues.push({ label: 'SS Duplicate', color: '#92400e', bg: '#fef3c7' })
  if (issues.length === 0) return null
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {issues.map(({ label, color, bg }) => (
        <span key={label} style={{ fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: bg, color, border: `1px solid ${color}33` }}>
          {label}
        </span>
      ))}
    </span>
  )
}

const WAREHOUSES = ['walnut', 'northlake']

const PRIORITY_TIERS = [
  { key: 1, label: 'Priority 1', badge: 'P1', color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
  { key: 2, label: 'Priority 2', badge: 'P2', color: '#d97706', bg: '#fffbeb', border: '#fcd34d' },
  { key: 3, label: 'Priority 3', badge: 'P3', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
  { key: 4, label: 'Standard',   badge: null, color: '#6b7280', bg: '#f3f4f6', border: '#d1d5db' },
]

function fmt(n) {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function fmtDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' })
}

function tagChipClass(tag) {
  const t = tag.toLowerCase()
  if (t === 'hold') return 'tag-chip tag-chip-hold'
  if (t === 'vip') return 'tag-chip tag-chip-vip'
  if (t === 'replacement') return 'tag-chip tag-chip-replacement'
  return 'tag-chip'
}

function getShipCategory(order) {
  const items = order.line_items || []
  const unfulfilled = items.filter(li => (li.fulfillable_quantity ?? li.quantity ?? 0) > 0)
  if (unfulfilled.length === 0) return null
  const hasShortShip = unfulfilled.some(li => li.app_line_status === 'short_ship')
  const hasInvHold = unfulfilled.some(li => li.app_line_status === 'inventory_hold')
  const hasNormal = unfulfilled.some(li => !['short_ship', 'inventory_hold'].includes(li.app_line_status))
  if (hasInvHold) return 'inv_hold'
  if (hasShortShip && hasNormal) return 'ship_partial'
  if (hasShortShip) return 'ship_none'
  return 'ship_all'
}

// ── Tab 1: Staged Orders ──────────────────────────────────────────────────────

function computeFulfillableRevenue(order) {
  const items = order.line_items || []
  const seen = new Set()
  let revenue = 0
  for (const li of items) {
    if (seen.has(li.line_item_id)) continue
    seen.add(li.line_item_id)
    if (li.app_line_status === 'short_ship' || li.app_line_status === 'inventory_hold') continue
    const fq = li.fulfillable_quantity ?? li.quantity ?? 0
    if (fq <= 0) continue
    const origQty = li.quantity || 1
    const discount = (li.total_discount || 0) * (fq / origQty)
    revenue += (li.price || 0) * fq - discount
  }
  revenue += order.total_shipping_price || 0
  return revenue
}

function getOrderPriorityTier(order, priorityTagSets) {
  const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  if (tags.some(t => priorityTagSets.priority_1.has(t))) return 1
  if (tags.some(t => priorityTagSets.priority_2.has(t))) return 2
  if (tags.some(t => priorityTagSets.priority_3.has(t))) return 3
  return 4 // no priority
}

function hasPlanIssue(order) {
  return !order.has_plan || order.plan_box_unmatched || order.has_plan_mismatch || order.ss_duplicate
}

function StagedOrdersTab() {
  const qc = useQueryClient()
  const [warehouse, setWarehouse] = useState('all')
  const [unstageResult, setUnstageResult] = useState(null)
  const [selectedOrderId, setSelectedOrderId] = useState(null)

  const { data: orders = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['orders-staged'],
    queryFn: async () => {
      const pageSize = 2000
      let skip = 0
      let all = []
      while (true) {
        const page = await ordersApi.list({ app_status: 'staged', limit: pageSize, skip })
        all = all.concat(page)
        if (page.length < pageSize) break
        skip += pageSize
      }
      return all
    },
    staleTime: 30000,
  })

  const { data: marginsMap = {} } = useQuery({
    queryKey: ['batch-margins-staged', orders.map(o => o.shopify_order_id).join(',')],
    queryFn: () => ordersApi.getBatchMargins(orders.map(o => o.shopify_order_id)),
    enabled: orders.length > 0,
    staleTime: 60000,
  })

  const unstagePlanIssuesMut = useMutation({
    mutationFn: () => ordersApi.unstagePlanIssues(),
    onSuccess: (data) => {
      setUnstageResult(`${data.orders_unstaged} order${data.orders_unstaged !== 1 ? 's' : ''} moved back to awaiting staging`)
      qc.invalidateQueries(['orders-staged'])
      setTimeout(() => setUnstageResult(null), 5000)
    },
  })

  const unstageSingleMut = useMutation({
    mutationFn: (orderId) => ordersApi.unstageBatch([orderId]),
    onSuccess: () => {
      qc.invalidateQueries(['orders-staged'])
    },
  })

  const unstageBulkMut = useMutation({
    mutationFn: (orderIds) => ordersApi.unstageBatch(orderIds),
    onSuccess: (data, variables) => {
      setSelectedOrders(new Set())
      setUnstageResult(`${variables.length} order${variables.length !== 1 ? 's' : ''} removed from staging`)
      qc.invalidateQueries(['orders-staged'])
      setTimeout(() => setUnstageResult(null), 5000)
    },
  })

  const [recomputeResult, setRecomputeResult] = useState(null)
  const recomputeMut = useMutation({
    mutationFn: () => ordersApi.recompute(),
    onSuccess: (data) => {
      const parts = []
      if (data.lines_updated > 0) parts.push(`${data.lines_updated} line${data.lines_updated !== 1 ? 's' : ''} updated`)
      const replanned = (data.orders_replanned_created || 0) + (data.orders_replanned_repaired || 0)
      if (replanned > 0) parts.push(`${replanned} replanned`)
      const unstaged = (data.orders_unstaged_plan_issues || 0) + (data.orders_unstaged_short_ship || 0) + (data.orders_unstaged_inv_hold || 0) + (data.orders_unstaged_hold || 0) + (data.orders_unstaged_dnss || 0)
      if (unstaged > 0) parts.push(`${unstaged} unstaged`)
      setRecomputeResult(parts.length === 0 ? 'No changes needed' : parts.join(', '))
      qc.invalidateQueries(['orders-staged'])
      qc.invalidateQueries(['orders'])
      qc.invalidateQueries(['staged-shortages'])
      setTimeout(() => setRecomputeResult(null), 8000)
    },
    onError: (err) => {
      setRecomputeResult(`Error: ${err?.response?.data?.detail || err?.message || 'Unknown'}`)
      setTimeout(() => setRecomputeResult(null), 8000)
    },
  })

  const { data: orderRules = [] } = useQuery({
    queryKey: ['order-rules'],
    queryFn: () => rulesApi.listOrders(),
    staleTime: 60000,
  })

  const { data: ssStatus } = useQuery({
    queryKey: ['shipstation-status'],
    queryFn: shipstationApi.status,
    staleTime: 60000,
  })

  const { data: shortages = [] } = useQuery({
    queryKey: ['staged-shortages'],
    queryFn: () => inventoryApi.stagedShortages(),
    staleTime: 30000,
  })

  // Build a map of order_id -> shortage info
  const shortageMap = useMemo(() => {
    const m = {}
    for (const s of shortages) m[s.shopify_order_id] = s
    return m
  }, [shortages])

  const priorityTagSets = useMemo(() => ({
    priority_1: new Set(orderRules.filter(r => r.action === 'priority_1' && r.is_active).map(r => r.tag.toLowerCase())),
    priority_2: new Set(orderRules.filter(r => r.action === 'priority_2' && r.is_active).map(r => r.tag.toLowerCase())),
    priority_3: new Set(orderRules.filter(r => r.action === 'priority_3' && r.is_active).map(r => r.tag.toLowerCase())),
  }), [orderRules])

  const holdTags = useMemo(() => new Set(
    orderRules.filter(r => r.action === 'hold' && r.is_active).map(r => r.tag.toLowerCase())
  ), [orderRules])

  const [selectedOrders, setSelectedOrders] = useState(new Set())
  const [collapsedTiers, setCollapsedTiers] = useState(new Set())

  // Prune stale selections when orders data changes (e.g. after push)
  useEffect(() => {
    if (orders.length === 0) return
    setSelectedOrders(prev => {
      const validIds = new Set(orders.map(o => o.shopify_order_id))
      const pruned = new Set([...prev].filter(id => validIds.has(id)))
      return pruned.size === prev.size ? prev : pruned
    })
  }, [orders])

  // Streaming bulk push state (persists job_id to localStorage)
  const [pushState, setPushState] = useState(() => {
    const saved = localStorage.getItem('pushJob')
    if (saved) {
      try {
        const { jobId } = JSON.parse(saved)
        if (jobId) return { active: true, pushed: 0, failed: 0, total: 0, done: false, error: null, jobId }
      } catch {}
    }
    return { active: false, pushed: 0, failed: 0, total: 0, done: false, error: null, jobId: null }
  })
  const pollRef = useRef(null)

  // Poll for push progress on mount (reconnect after refresh)
  useEffect(() => {
    if (!pushState.jobId || pushState.done) return
    // Already polling
    if (pollRef.current) return

    pollRef.current = setInterval(async () => {
      try {
        const status = await fulfillmentApi.getPushStatus(pushState.jobId)
        setPushState(prev => ({
          ...prev,
          active: status.status === 'running',
          pushed: status.pushed,
          failed: status.failed,
          total: status.total,
          done: status.status === 'done',
        }))
        if (status.status === 'done') {
          clearInterval(pollRef.current)
          pollRef.current = null
          localStorage.removeItem('pushJob')
          setSelectedOrders(new Set())
          qc.invalidateQueries(['orders-staged'])
        }
      } catch {
        // Job expired or not found — clean up
        clearInterval(pollRef.current)
        pollRef.current = null
        localStorage.removeItem('pushJob')
        setPushState({ active: false, pushed: 0, failed: 0, total: 0, done: false, error: null, jobId: null })
      }
    }, 2000)

    return () => { clearInterval(pollRef.current); pollRef.current = null }
  }, [pushState.jobId, pushState.done])

  const pushMut = {
    isPending: pushState.active,
    isSuccess: pushState.done && !pushState.error,
    isError: !!pushState.error,
    data: pushState.done ? { pushed: pushState.pushed, failed: pushState.failed } : null,
    error: pushState.error ? { message: pushState.error } : null,
  }

  const wlCounts = useMemo(() => {
    const c = { all: orders.length, walnut: 0, northlake: 0 }
    for (const o of orders) {
      if (o.assigned_warehouse) c[o.assigned_warehouse] = (c[o.assigned_warehouse] || 0) + 1
    }
    return c
  }, [orders])

  const issueOrders = useMemo(() => orders.filter(hasPlanIssue), [orders])

  const filtered = warehouse === 'all'
    ? orders
    : orders.filter(o => o.assigned_warehouse === warehouse)

  const sortedFiltered = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const pa = getOrderPriorityTier(a, priorityTagSets)
      const pb = getOrderPriorityTier(b, priorityTagSets)
      if (pa !== pb) return pa - pb
      const ra = computeFulfillableRevenue(a)
      const rb = computeFulfillableRevenue(b)
      if (ra !== rb) return rb - ra  // higher revenue first
      const da = a.created_at_shopify ? new Date(a.created_at_shopify).getTime() : 0
      const db2 = b.created_at_shopify ? new Date(b.created_at_shopify).getTime() : 0
      return da - db2  // older order first
    })
  }, [filtered, priorityTagSets])

  const inventoryIssueCount = useMemo(() => sortedFiltered.filter(o => shortageMap[o.shopify_order_id]?.has_shortage).length, [sortedFiltered, shortageMap])
  const inventoryOkCount = useMemo(() => sortedFiltered.filter(o => !shortageMap[o.shopify_order_id]?.has_shortage).length, [sortedFiltered, shortageMap])

  const ordersByTier = useMemo(() => {
    const groups = { 1: [], 2: [], 3: [], 4: [] }
    for (const order of sortedFiltered) {
      const tier = getOrderPriorityTier(order, priorityTagSets)
      groups[tier].push(order)
    }
    return groups
  }, [sortedFiltered, priorityTagSets])

  // Derived: selected order object + index for prev/next navigation
  const selectedOrder = useMemo(
    () => sortedFiltered.find(o => o.shopify_order_id === selectedOrderId) || null,
    [selectedOrderId, sortedFiltered]
  )
  const selectedOrderIdx = useMemo(
    () => sortedFiltered.findIndex(o => o.shopify_order_id === selectedOrderId),
    [selectedOrderId, sortedFiltered]
  )

  function toggleTier(tierKey) {
    setCollapsedTiers(prev => {
      const next = new Set(prev)
      if (next.has(tierKey)) next.delete(tierKey)
      else next.add(tierKey)
      return next
    })
  }

  function toggleSelectTier(tierOrders, select) {
    setSelectedOrders(prev => {
      const next = new Set(prev)
      for (const o of tierOrders) {
        if (select) next.add(o.shopify_order_id)
        else next.delete(o.shopify_order_id)
      }
      return next
    })
  }

  function handlePushSelected() {
    const selectedList = sortedFiltered.filter(o => selectedOrders.has(o.shopify_order_id))
    const ids = selectedList.map(o => o.shopify_order_id)
    if (ids.length === 0) return
    setPushState({ active: true, pushed: 0, failed: 0, total: ids.length, done: false, error: null, jobId: null })
    fulfillmentApi.bulkPushStream({
      order_ids: ids,
      onStart: (data) => {
        // Persist job_id so we can reconnect after page refresh
        if (data.job_id) {
          localStorage.setItem('pushJob', JSON.stringify({ jobId: data.job_id }))
          setPushState(prev => ({ ...prev, jobId: data.job_id, total: data.total }))
        }
      },
      onProgress: (data) => {
        setPushState(prev => ({ ...prev, pushed: data.pushed, failed: data.failed, total: data.total }))
        if (!data.success && data.error) {
          console.warn(`Push skip: order ${data.order_id} — ${data.error}`)
        }
      },
      onDone: (data) => {
        setPushState({ active: false, pushed: data.pushed, failed: data.failed, total: data.total, done: true, error: null, jobId: null })
        localStorage.removeItem('pushJob')
        setSelectedOrders(new Set())
        qc.invalidateQueries(['orders-staged'])
        if (data.failed > 0) {
          alert(`${data.pushed} pushed, ${data.failed} skipped/failed — check console for details`)
        }
      },
      onError: (err) => {
        setPushState(prev => ({ ...prev, error: err?.message || 'Stream disconnected — reconnecting via poller' }))
      },
    })
  }

  function toggleSelect(orderId) {
    setSelectedOrders(prev => {
      const next = new Set(prev)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedOrders.size === sortedFiltered.length) {
      setSelectedOrders(new Set())
    } else {
      setSelectedOrders(new Set(sortedFiltered.map(o => o.shopify_order_id)))
    }
  }

  return (
    <div style={{ display: 'flex', gap: 0, alignItems: 'flex-start' }}>
      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
      {/* Stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-num">{wlCounts.all}</div>
          <div className="stat-label">Total Staged</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{wlCounts.walnut}</div>
          <div className="stat-label">Walnut</div>
        </div>
        <div className="stat-card">
          <div className="stat-num">{wlCounts.northlake}</div>
          <div className="stat-label">Northlake</div>
        </div>
        <div className="stat-card" style={issueOrders.length > 0 ? { borderColor: '#fca5a5', background: '#fef2f2' } : {}}>
          <div className="stat-num" style={issueOrders.length > 0 ? { color: '#dc2626' } : {}}>{issueOrders.length}</div>
          <div className="stat-label">Plan Issues</div>
        </div>
        <div className="stat-card" style={inventoryIssueCount > 0 ? { borderColor: '#fca5a5', background: '#fef2f2' } : { borderColor: '#bbf7d0', background: '#f0fdf4' }}>
          <div className="stat-num" style={inventoryIssueCount > 0 ? { color: '#dc2626' } : { color: '#16a34a' }}>{inventoryIssueCount}</div>
          <div className="stat-label">Inv. Issues</div>
        </div>
        <div className="stat-card" style={{ borderColor: '#bbf7d0', background: '#f0fdf4' }}>
          <div className="stat-num" style={{ color: '#16a34a' }}>{inventoryOkCount}</div>
          <div className="stat-label">Inv. OK</div>
        </div>
      </div>

      {/* Recompute + Bulk Unstage Issues */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => recomputeMut.mutate()}
          disabled={recomputeMut.isPending}
          title="Re-resolve SKU mappings, re-apply short-ship/inventory-hold, replan affected orders, and unstage anything that no longer fits — without pulling from Shopify."
        >
          {recomputeMut.isPending ? 'Recomputing…' : '↻ Recompute Orders'}
        </button>
        {recomputeResult && (
          <span style={{ fontSize: 12, color: recomputeResult.startsWith('Error') ? '#dc2626' : '#16a34a', fontWeight: 500 }}>
            {recomputeResult.startsWith('Error') ? '' : '✓ '}{recomputeResult}
          </span>
        )}
        {issueOrders.length > 0 && (
          <button
            className="btn btn-sm"
            style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', fontWeight: 600 }}
            onClick={() => unstagePlanIssuesMut.mutate()}
            disabled={unstagePlanIssuesMut.isPending}
          >
            {unstagePlanIssuesMut.isPending ? 'Unstaging…' : `Unstage ${issueOrders.length} Issue Order${issueOrders.length !== 1 ? 's' : ''}`}
          </button>
        )}
        {unstageResult && (
          <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 500 }}>✓ {unstageResult}</span>
        )}
      </div>

      {/* Push to ShipStation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={handlePushSelected}
          disabled={pushMut.isPending || selectedOrders.size === 0}
        >
          {pushState.active
            ? `Pushing… ${pushState.pushed + pushState.failed} / ${pushState.total}`
            : `→ Push to ShipStation${selectedOrders.size > 0 ? ` (${selectedOrders.size})` : ''}`}
        </button>
        {selectedOrders.size > 0 && (
          <>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => {
                const ids = sortedFiltered.filter(o => selectedOrders.has(o.shopify_order_id)).map(o => o.shopify_order_id)
                if (ids.length > 0 && window.confirm(`Remove ${ids.length} order${ids.length !== 1 ? 's' : ''} from staging?`)) {
                  unstageBulkMut.mutate(ids)
                }
              }}
              disabled={unstageBulkMut.isPending}
            >
              {unstageBulkMut.isPending ? 'Removing…' : `✕ Remove from Staging (${selectedOrders.size})`}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setSelectedOrders(new Set())}>
              Clear Selection
            </button>
          </>
        )}
        {pushMut.isSuccess && (
          <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 500 }}>
            ✓ {pushMut.data?.pushed ?? 0} pushed
          </span>
        )}
        {pushMut.isError && (
          <span style={{ fontSize: 12, color: '#dc2626' }}>
            Push failed: {pushMut.error?.response?.data?.detail || pushMut.error?.message || 'Unknown error'}
          </span>
        )}
      </div>

      {/* Warehouse filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <div className="wh-tabs" style={{ marginBottom: 0 }}>
          {['all', ...WAREHOUSES].map(wh => (
            <button
              key={wh}
              onClick={() => setWarehouse(wh)}
              className={`wh-tab${warehouse === wh ? ' active' : ''}`}
            >
              {wh === 'all' ? `All (${wlCounts.all})` : `${wh.charAt(0).toUpperCase() + wh.slice(1)} (${wlCounts[wh] || 0})`}
            </button>
          ))}
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="btn btn-secondary btn-sm">
          {isFetching ? 'Refreshing…' : '↺ Refresh'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => exportStagedCsv(sortedFiltered, priorityTagSets, warehouse)}
          disabled={sortedFiltered.length === 0}
          title="Export currently visible staged orders to CSV"
        >
          ↓ Export CSV
        </button>
      </div>

      {isLoading ? (
        <div className="loading">Loading staged orders…</div>
      ) : sortedFiltered.length === 0 ? (
        <div className="empty">No staged orders{warehouse !== 'all' ? ` for ${warehouse}` : ''}</div>
      ) : (
        <div>
          {PRIORITY_TIERS.map(tier => {
            const tierOrders = ordersByTier[tier.key] || []
            if (tierOrders.length === 0) return null
            const isCollapsed = collapsedTiers.has(tier.key)
            const tierAllSelected = tierOrders.length > 0 && tierOrders.every(o => selectedOrders.has(o.shopify_order_id))
            const tierSomeSelected = !tierAllSelected && tierOrders.some(o => selectedOrders.has(o.shopify_order_id))
            return (
              <div key={tier.key} style={{ marginBottom: 12 }}>
                {/* Tier section header */}
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 12px',
                    background: tier.bg, border: `1px solid ${tier.border}`,
                    borderRadius: isCollapsed ? 6 : '6px 6px 0 0',
                    cursor: 'pointer', userSelect: 'none',
                  }}
                  onClick={() => toggleTier(tier.key)}
                >
                  <input
                    type="checkbox"
                    checked={tierAllSelected}
                    ref={el => { if (el) el.indeterminate = tierSomeSelected }}
                    onChange={e => {
                      e.stopPropagation()
                      toggleSelectTier(tierOrders, e.target.checked)
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                  <span style={{ fontSize: 10, color: tier.color }}>{isCollapsed ? '▶' : '▼'}</span>
                  {tier.badge && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: tier.color, background: '#fff', padding: '1px 7px', borderRadius: 4, border: `1px solid ${tier.border}` }}>
                      {tier.badge}
                    </span>
                  )}
                  <span style={{ fontWeight: 600, fontSize: 13, color: tier.color }}>{tier.label}</span>
                  <span style={{ fontSize: 12, color: tier.color, opacity: 0.7 }}>
                    {tierOrders.length} order{tierOrders.length !== 1 ? 's' : ''}
                  </span>
                  {tierSomeSelected && (
                    <span style={{ fontSize: 11, color: tier.color, marginLeft: 4, opacity: 0.8 }}>
                      ({tierOrders.filter(o => selectedOrders.has(o.shopify_order_id)).length} selected)
                    </span>
                  )}
                </div>

                {/* Tier table */}
                {!isCollapsed && (
                  <div className="data-table-wrap" style={{ borderTop: 'none', borderRadius: '0 0 6px 6px' }}>
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 32 }}></th>
                          <th>Order #</th>
                          <th>Revenue</th>
                          <th>GM%</th>
                          <th>Customer</th>
                          <th>Warehouse</th>
                          <th>Order Date</th>
                          <th>Tags</th>
                          <th>Ship Category</th>
                          <th>Issues</th>
                          <th>Items</th>
                          <th style={{ width: 80 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {tierOrders.map(order => {
                          const shipCat = getShipCategory(order)
                          const tags = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean)
                          const items = (order.line_items || []).filter(li =>
                            (li.fulfillable_quantity ?? li.quantity ?? 0) > 0
                          )
                          const hasIssue = hasPlanIssue(order)
                          const isSelected = selectedOrderId === order.shopify_order_id
                          return (
                            <tr
                              key={order.shopify_order_id}
                              style={{
                                ...(hasIssue ? { background: '#fffbeb' } : {}),
                                ...(isSelected ? { background: '#eff6ff', outline: '2px solid #3b82f6', outlineOffset: -2 } : {}),
                                cursor: 'pointer',
                              }}
                              onClick={() => setSelectedOrderId(isSelected ? null : order.shopify_order_id)}
                            >
                              <td onClick={e => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={selectedOrders.has(order.shopify_order_id)}
                                  onChange={() => toggleSelect(order.shopify_order_id)}
                                />
                              </td>
                              <td className="mono" style={{ fontWeight: 600 }}>{order.shopify_order_number}</td>
                              <td style={{ fontWeight: 500, color: '#374151' }}>
                                ${computeFulfillableRevenue(order).toFixed(2)}
                              </td>
                              <td>
                                {(() => {
                                  const gm = marginsMap[order.shopify_order_id]?.gm_pct
                                  if (gm == null) return <span style={{ color: '#9ca3af' }}>—</span>
                                  if (gm < 0) return <span style={{ color: '#dc2626', fontWeight: 600 }}>{gm.toFixed(1)}%</span>
                                  return <span style={{ color: '#374151' }}>{gm.toFixed(1)}%</span>
                                })()}
                              </td>
                              <td>{order.customer_name || '—'}</td>
                              <td>
                                {order.assigned_warehouse ? (
                                  <span className={`badge badge-${order.assigned_warehouse}`}>
                                    {order.assigned_warehouse}
                                  </span>
                                ) : '—'}
                              </td>
                              <td style={{ color: '#666' }}>{fmtDate(order.created_at_shopify)}</td>
                              <td>
                                {tags.map(t => (
                                  <span key={t} className={tagChipClass(t)}>{t}</span>
                                ))}
                              </td>
                              <td>
                                {shipCat === 'ship_all' && <span className="badge badge-fulfilled">Ship All</span>}
                                {shipCat === 'ship_partial' && <span className="badge badge-partial">Ship Partial</span>}
                                {shipCat === 'ship_none' && <span className="badge badge-not-processed">Ship None</span>}
                                {shipCat === 'inv_hold' && <span className="badge" style={{ background: '#f5f3ff', color: '#7c3aed', border: '1px solid #c4b5fd' }}>Inv Hold</span>}
                              </td>
                              <td>
                                <PlanIssueBadges order={order} />
                                {shortageMap[order.shopify_order_id]?.has_shortage && (
                                  <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', marginLeft: hasIssue ? 4 : 0 }}>
                                    No Inv.
                                  </span>
                                )}
                              </td>
                              <td>
                                {items.slice(0, 3).map((li, i) => (
                                  <div key={i} style={{ fontSize: 12, lineHeight: 1.6 }}>
                                    <span className="mono" style={{ color: '#4f8ef7' }}>
                                      {li.pick_sku || li.shopify_sku || '?'}
                                    </span>
                                    <span style={{ color: '#999', marginLeft: 4 }}>
                                      ×{fmt(li.fulfillable_quantity ?? li.quantity)}
                                    </span>
                                  </div>
                                ))}
                                {items.length > 3 && (
                                  <div style={{ fontSize: 11, color: '#aaa' }}>+{items.length - 3} more</div>
                                )}
                              </td>
                              <td onClick={e => e.stopPropagation()}>
                                <button
                                  className="btn btn-secondary btn-sm"
                                  style={{ fontSize: 11 }}
                                  onClick={() => unstageSingleMut.mutate(order.shopify_order_id)}
                                  disabled={unstageSingleMut.isPending}
                                >
                                  Unstage
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      </div>{/* end main content */}

      {/* Right order detail panel */}
      {selectedOrder && (
        <OrderDetailPanel
          order={selectedOrder}
          onClose={() => setSelectedOrderId(null)}
          onPrev={() => selectedOrderIdx > 0 && setSelectedOrderId(sortedFiltered[selectedOrderIdx - 1].shopify_order_id)}
          onNext={() => selectedOrderIdx < sortedFiltered.length - 1 && setSelectedOrderId(sortedFiltered[selectedOrderIdx + 1].shopify_order_id)}
          hasPrev={selectedOrderIdx > 0}
          hasNext={selectedOrderIdx < sortedFiltered.length - 1}
          holdTags={holdTags}
          ssConfigured={ssStatus?.configured}
        />
      )}
    </div>
  )
}

// ── Tab 3: Short Ship / Inventory Hold Config ───────────────────────────────

function getSkuStatus(p) {
  if (p.allow_short_ship) return 'short_ship'
  if (p.inventory_hold) return 'inv_hold'
  return 'none'
}

function getTypeStatus(pt) {
  if (pt.all_short_ship) return 'short_ship'
  if (pt.all_inventory_hold) return 'inv_hold'
  if (pt.short_ship_count > 0 && pt.inventory_hold_count > 0) return 'mixed'
  if (pt.short_ship_count > 0) return 'partial_ss'
  if (pt.inventory_hold_count > 0) return 'partial_hold'
  return 'none'
}

const STATUS_BADGE = {
  short_ship:   { label: 'Short Ship',       color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
  inv_hold:     { label: 'Inventory Hold',    color: '#7c3aed', bg: '#f5f3ff', border: '#c4b5fd' },
  partial_ss:   { label: 'Partial SS',        color: '#f59e0b', bg: '#fffbeb', border: '#fcd34d' },
  partial_hold: { label: 'Partial Hold',      color: '#8b5cf6', bg: '#f5f3ff', border: '#c4b5fd' },
  mixed:        { label: 'Mixed',             color: '#d97706', bg: '#fffbeb', border: '#fcd34d' },
}

function StatusBadge({ status, counts }) {
  const info = STATUS_BADGE[status]
  if (!info) return null
  const detail = counts ? ` (${counts})` : ''
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: info.color, background: info.bg, padding: '2px 8px', borderRadius: 4, border: `1px solid ${info.border}` }}>
      {info.label}{detail}
    </span>
  )
}

function ShortShipConfigTab() {
  const qc = useQueryClient()
  const [warehouse, setWarehouse] = useState('walnut')
  const [orderScope, setOrderScope] = useState('staged')
  const [expandedType, setExpandedType] = useState(null)
  const [syncMsg, setSyncMsg] = useState(null)
  const [pendingChanges, setPendingChanges] = useState(0)
  const [applyResult, setApplyResult] = useState(null)

  const { data: productTypes = [], isLoading: loadingTypes } = useQuery({
    queryKey: ['product-types'],
    queryFn: () => productsApi.listProductTypes(),
    staleTime: 30000,
  })

  const { data: allProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['products'],
    queryFn: () => productsApi.list(),
    staleTime: 30000,
  })

  const { data: analysis = [], isLoading: loadingAnalysis, refetch: refetchAnalysis, isFetching: isFetchingAnalysis } = useQuery({
    queryKey: ['demand-analysis', warehouse, orderScope],
    queryFn: () => inventoryApi.demandAnalysis(warehouse, orderScope),
    staleTime: 60000,
  })

  const invalidateAll = () => {
    qc.invalidateQueries(['product-types'])
    qc.invalidateQueries(['products'])
    setPendingChanges(c => c + 1)
  }

  const setShortShipByTypeMut = useMutation({
    mutationFn: ({ product_type, allow_short_ship }) =>
      productsApi.setShortShipByType({ product_type, allow_short_ship }),
    onSuccess: invalidateAll,
  })

  const setHoldByTypeMut = useMutation({
    mutationFn: ({ product_type, inventory_hold }) =>
      productsApi.setInventoryHoldByType({ product_type, inventory_hold }),
    onSuccess: invalidateAll,
  })

  const updateProductMut = useMutation({
    mutationFn: ({ id, ...data }) => productsApi.update(id, data),
    onSuccess: invalidateAll,
  })

  const applyMut = useMutation({
    mutationFn: () => productsApi.apply(),
    onSuccess: (data) => {
      setPendingChanges(0)
      setApplyResult(data)
      qc.invalidateQueries(['demand-analysis', warehouse])
      qc.invalidateQueries(['orders-staged'])
      qc.invalidateQueries(['orders'])
      setTimeout(() => setApplyResult(null), 6000)
    },
  })

  const syncMut = useMutation({
    mutationFn: () => productsApi.sync(),
    onSuccess: (data) => {
      setSyncMsg(`Synced — ${data.total_products} products`)
      qc.invalidateQueries(['product-types'])
      qc.invalidateQueries(['products'])
      setTimeout(() => setSyncMsg(null), 4000)
    },
  })

  const isMutPending = setShortShipByTypeMut.isPending || setHoldByTypeMut.isPending || updateProductMut.isPending

  // Build enriched product type data with staged demand + inventory info
  const ptData = useMemo(() => {
    const skuToPickSku = {}
    for (const item of analysis) {
      if (item.total_demand > 0) {
        for (const b of item.shopify_sku_breakdown || []) {
          skuToPickSku[b.shopify_sku] = item.pick_sku
        }
      }
    }

    const pickSkuToAnalysis = {}
    for (const item of analysis) {
      pickSkuToAnalysis[item.pick_sku] = item
    }

    const linkedPickSkus = new Set()

    const fromProductTypes = productTypes.map(pt => {
      const label = pt.product_type || '(no type)'
      const ptProducts = allProducts.filter(
        p => (p.product_type || '(no type)') === label
      )

      const pickSkuSet = new Set()
      for (const p of ptProducts) {
        const ps = skuToPickSku[p.shopify_sku]
        if (ps) pickSkuSet.add(ps)
      }

      const pickSkus = [...pickSkuSet]
      pickSkus.forEach(ps => linkedPickSkus.add(ps))
      const analysisItems = pickSkus
        .map(ps => pickSkuToAnalysis[ps])
        .filter(Boolean)

      const hasStagedDemand = analysisItems.some(a => a.total_demand > 0)
      const multiPickSku = pickSkus.length > 1

      const hasNegativeEnding = analysisItems.some(a => a.on_hand_qty - a.total_demand < 0)
      const hasPositiveEnding = analysisItems.length > 0 && analysisItems.every(a => a.on_hand_qty - a.total_demand >= 0)

      return {
        ...pt,
        label,
        ptProducts,
        pickSkus,
        analysisItems,
        hasStagedDemand,
        multiPickSku,
        hasNegativeEnding,
        hasPositiveEnding,
        _unsynced: false,
      }
    })

    const unlinked = []
    for (const item of analysis) {
      if (item.total_demand > 0 && !linkedPickSkus.has(item.pick_sku)) {
        const ending = item.on_hand_qty - item.total_demand
        if (ending >= 0) continue
        const firstTitle = item.shopify_sku_breakdown?.[0]?.product_title
        const label = firstTitle || item.pick_sku
        unlinked.push({
          product_type: null,
          label,
          ptProducts: [],
          pickSkus: [item.pick_sku],
          analysisItems: [item],
          hasStagedDemand: true,
          multiPickSku: false,
          hasNegativeEnding: true,
          hasPositiveEnding: false,
          all_short_ship: false,
          short_ship_count: 0,
          all_inventory_hold: false,
          inventory_hold_count: 0,
          sku_count: 0,
          _unsynced: true,
        })
      }
    }

    return [...fromProductTypes, ...unlinked]
  }, [analysis, allProducts, productTypes])

  // Check for mutual exclusivity conflicts
  const conflicts = ptData.filter(pt => pt.short_ship_count > 0 && pt.inventory_hold_count > 0)

  // Filter A: single pick_sku, staged demand, ending balance < 0, not short shipped, not on hold
  const filterA = ptData.filter(pt =>
    pt.hasStagedDemand && !pt.multiPickSku && pt.hasNegativeEnding && !pt.all_short_ship && !pt.all_inventory_hold
  )

  // Filter B: single pick_sku, staged demand, ending balance >= 0 (enough stock), short ship IS selected (possible mistake)
  const filterB = ptData.filter(pt =>
    pt.hasStagedDemand && !pt.multiPickSku && pt.hasPositiveEnding && (pt.all_short_ship || pt.all_inventory_hold)
  )

  // Filter C: multiple pick_skus
  const filterCA = ptData.filter(pt =>
    pt.hasStagedDemand && pt.multiPickSku &&
    pt.analysisItems.some(a => a.on_hand_qty - a.total_demand < 0) && !pt.all_short_ship && !pt.all_inventory_hold
  )
  const filterCB = ptData.filter(pt =>
    pt.hasStagedDemand && pt.multiPickSku &&
    pt.analysisItems.every(a => a.on_hand_qty - a.total_demand >= 0) && (pt.all_short_ship || pt.all_inventory_hold)
  )

  const isLoading = loadingTypes || loadingProducts

  return (
    <div>
      {/* Warehouse selector and order scope toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div className="wh-tabs" style={{ marginBottom: 0 }}>
          {WAREHOUSES.map(wh => (
            <button
              key={wh}
              onClick={() => setWarehouse(wh)}
              className={`wh-tab${warehouse === wh ? ' active' : ''}`}
            >
              {wh.charAt(0).toUpperCase() + wh.slice(1)}
            </button>
          ))}
        </div>
        <div className="wh-tabs" style={{ marginBottom: 0 }}>
          <button
            onClick={() => setOrderScope('staged')}
            className={`wh-tab${orderScope === 'staged' ? ' active' : ''}`}
          >
            Staged Orders
          </button>
          <button
            onClick={() => setOrderScope('all')}
            className={`wh-tab${orderScope === 'all' ? ' active' : ''}`}
          >
            All Orders
          </button>
        </div>
        <button
          onClick={() => refetchAnalysis()}
          disabled={isFetchingAnalysis}
          className="btn btn-secondary btn-sm"
        >
          {isFetchingAnalysis ? 'Refreshing…' : '↺ Refresh'}
        </button>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>
          {orderScope === 'staged' ? 'Staged' : 'All open'} orders · {warehouse}
        </span>
      </div>

      {/* Unsaved changes banner */}
      {pendingChanges > 0 && (
        <div className="staging-apply-banner">
          <span>
            ⚠ {pendingChanges} unsaved change{pendingChanges !== 1 ? 's' : ''} — config saved but not yet applied to orders
          </span>
        </div>
      )}

      {/* Apply to Orders button — always visible */}
      <div style={{ marginBottom: 16 }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => applyMut.mutate()}
          disabled={applyMut.isPending}
        >
          {applyMut.isPending ? 'Applying…' : '▶ Apply to Orders'}
        </button>
        {pendingChanges > 0 && (
          <span style={{ marginLeft: 8, fontSize: 12, color: '#f59e0b' }}>
            {pendingChanges} pending change{pendingChanges !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Apply result */}
      {applyResult && pendingChanges === 0 && (
        <div className="success-banner" style={{ marginBottom: 16 }}>
          ✓ Applied
          {(applyResult.orders_unstaged ?? 0) > 0 && ` — ${applyResult.orders_unstaged} order${applyResult.orders_unstaged !== 1 ? 's' : ''} unstaged (short ship)`}
          {(applyResult.orders_unstaged_hold ?? 0) > 0 && ` — ${applyResult.orders_unstaged_hold} order${applyResult.orders_unstaged_hold !== 1 ? 's' : ''} unstaged (inventory hold)`}
          {applyResult.lines_marked > 0 && `, ${applyResult.lines_marked} line item${applyResult.lines_marked !== 1 ? 's' : ''} marked short ship`}
          {applyResult.hold_lines_marked > 0 && `, ${applyResult.hold_lines_marked} marked inventory hold`}
          {applyResult.lines_cleared > 0 && `, ${applyResult.lines_cleared} SS cleared`}
          {applyResult.hold_lines_cleared > 0 && `, ${applyResult.hold_lines_cleared} hold cleared`}
        </div>
      )}

      {/* Conflict warning */}
      {conflicts.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
          <strong>Conflict:</strong> {conflicts.length} product type{conflicts.length !== 1 ? 's have' : ' has'} SKUs with both Short Ship and Inventory Hold set.
          A SKU should only have one. Affected types: {conflicts.map(c => c.label).join(', ')}
        </div>
      )}

      {isLoading || loadingAnalysis ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          {/* ── Currently Active ── */}
          <CurrentStatusPanel
            ptData={ptData}
            onSetShortShip={pt => setShortShipByTypeMut.mutate({ product_type: pt.product_type, allow_short_ship: true })}
            onSetHold={pt => setHoldByTypeMut.mutate({ product_type: pt.product_type, inventory_hold: true })}
            onClearShortShip={pt => setShortShipByTypeMut.mutate({ product_type: pt.product_type, allow_short_ship: false })}
            onClearHold={pt => setHoldByTypeMut.mutate({ product_type: pt.product_type, inventory_hold: false })}
            isPending={isMutPending}
          />

          {/* ── Filter A ── */}
          <FilterSection
            title="A — Needs Action"
            description="Ending balance < 0 if pushed · no status set · single pick SKU"
            rows={filterA}
            emptyMsg="No product types need configuration"
            emptyIsGood
            onShortShip={pt => setShortShipByTypeMut.mutate({ product_type: pt.product_type, allow_short_ship: true })}
            onHold={pt => setHoldByTypeMut.mutate({ product_type: pt.product_type, inventory_hold: true })}
            isPending={isMutPending}
          />

          {/* ── Filter B ── */}
          <FilterSection
            title="B — Possible Mistake"
            description="Ending balance >= 0 (enough stock) · short ship or hold selected · single pick SKU"
            rows={filterB}
            emptyMsg="No misconfigurations found"
            emptyIsGood
            onClear={pt => {
              if (pt.all_short_ship) setShortShipByTypeMut.mutate({ product_type: pt.product_type, allow_short_ship: false })
              else if (pt.all_inventory_hold) setHoldByTypeMut.mutate({ product_type: pt.product_type, inventory_hold: false })
            }}
            isPending={isMutPending}
          />

          {/* ── Filter C ── */}
          <FilterCSection
            filterCA={filterCA}
            filterCB={filterCB}
            onShortShip={pt => setShortShipByTypeMut.mutate({ product_type: pt.product_type, allow_short_ship: true })}
            onHold={pt => setHoldByTypeMut.mutate({ product_type: pt.product_type, inventory_hold: true })}
            onClear={pt => {
              if (pt.all_short_ship) setShortShipByTypeMut.mutate({ product_type: pt.product_type, allow_short_ship: false })
              else if (pt.all_inventory_hold) setHoldByTypeMut.mutate({ product_type: pt.product_type, inventory_hold: false })
            }}
            isPending={isMutPending}
          />

          {/* ── Full Config Table ── */}
          <div className="inv-dash-panel" style={{ marginTop: 24 }}>
            <div className="inv-dash-panel-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span>All Product Types</span>
              <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>
                Configure short ship / inventory hold · demand from {orderScope === 'staged' ? 'staged' : 'all open'} orders
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                {syncMsg && <span style={{ fontSize: 12, color: '#16a34a' }}>{syncMsg}</span>}
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: 12, padding: '3px 10px' }}
                  onClick={() => syncMut.mutate()}
                  disabled={syncMut.isPending}
                >
                  {syncMut.isPending ? 'Syncing…' : '↺ Sync Products'}
                </button>
              </div>
            </div>

            {productTypes.length === 0 ? (
              <div style={{ padding: '12px 16px', color: '#9ca3af', fontSize: 13 }}>
                No products synced. Click "↺ Sync Products" to pull from Shopify.
              </div>
            ) : (
              <table className="inv-dash-table">
                <thead>
                  <tr>
                    <th>Product Type</th>
                    <th style={{ textAlign: 'right', width: 60 }}>SKUs</th>
                    <th style={{ textAlign: 'right', width: 80 }}>Staged Demand</th>
                    <th style={{ textAlign: 'right', width: 90 }}>On Hand</th>
                    <th style={{ textAlign: 'center', width: 180 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {ptData.map(pt => {
                    const isExpanded = expandedType === pt.label
                    const typeStatus = getTypeStatus(pt)
                    const stagedDemand = pt.analysisItems.reduce((s, a) => s + (a.total_demand || 0), 0)
                    const availableQty = pt.analysisItems.length > 0
                      ? Math.min(...pt.analysisItems.map(a => a.on_hand_qty))
                      : null

                    return [
                      <tr key={pt.label}>
                        <td>
                          <button
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13, color: '#374151', display: 'flex', alignItems: 'center', gap: 4 }}
                            onClick={() => setExpandedType(isExpanded ? null : pt.label)}
                          >
                            <span style={{ fontSize: 10 }}>{isExpanded ? '▼' : '▶'}</span>
                            {pt.label}
                          </button>
                        </td>
                        <td style={{ textAlign: 'right', color: '#6b7280' }}>{pt.sku_count}</td>
                        <td style={{ textAlign: 'right', color: stagedDemand > 0 ? '#92400e' : '#9ca3af' }}>
                          {stagedDemand > 0 ? fmt(stagedDemand) : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: availableQty != null && availableQty <= 0 ? '#dc2626' : '#374151', fontWeight: availableQty != null && availableQty <= 0 ? 600 : 400 }}>
                          {availableQty != null ? fmt(availableQty) : '—'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <TypeStatusControl
                            pt={pt}
                            typeStatus={typeStatus}
                            onSetShortShip={() => setShortShipByTypeMut.mutate({ product_type: pt.product_type, allow_short_ship: true })}
                            onSetHold={() => setHoldByTypeMut.mutate({ product_type: pt.product_type, inventory_hold: true })}
                            onClear={() => {
                              if (pt.short_ship_count > 0) setShortShipByTypeMut.mutate({ product_type: pt.product_type, allow_short_ship: false })
                              if (pt.inventory_hold_count > 0) setHoldByTypeMut.mutate({ product_type: pt.product_type, inventory_hold: false })
                            }}
                            disabled={isMutPending}
                          />
                        </td>
                      </tr>,
                      isExpanded && pt.ptProducts.map(p => {
                        const skuSt = getSkuStatus(p)
                        return (
                          <tr key={p.id} style={{ background: '#fafafa' }}>
                            <td style={{ paddingLeft: 28, fontSize: 12, color: '#6b7280' }}>
                              <span className="mono">{p.shopify_sku}</span>
                              <span style={{ marginLeft: 8, color: '#9ca3af' }}>{p.title}</span>
                            </td>
                            <td />
                            <td />
                            <td />
                            <td style={{ textAlign: 'center' }}>
                              <SkuStatusControl
                                skuStatus={skuSt}
                                onSet={(status) => {
                                  if (status === 'short_ship') updateProductMut.mutate({ id: p.id, allow_short_ship: true })
                                  else if (status === 'inv_hold') updateProductMut.mutate({ id: p.id, inventory_hold: true })
                                  else {
                                    // Clear both
                                    updateProductMut.mutate({ id: p.id, allow_short_ship: false, inventory_hold: false })
                                  }
                                }}
                                disabled={updateProductMut.isPending}
                              />
                            </td>
                          </tr>
                        )
                      }),
                    ]
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Type-level status control (3-way: None / Short Ship / Inv Hold) ──────────

function TypeStatusControl({ pt, typeStatus, onSetShortShip, onSetHold, onClear, disabled }) {
  const isNone = typeStatus === 'none'
  const isSS = typeStatus === 'short_ship' || typeStatus === 'partial_ss'
  const isHold = typeStatus === 'inv_hold' || typeStatus === 'partial_hold'
  return (
    <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <button
        style={{
          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
          background: isNone ? '#f0fdf4' : '#f9fafb',
          color: isNone ? '#16a34a' : '#9ca3af',
          border: isNone ? '1px solid #86efac' : '1px solid #e5e7eb',
        }}
        onClick={onClear}
        disabled={disabled || isNone}
        title="Clear all statuses (set to None)"
      >
        None
      </button>
      <button
        style={{
          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
          background: isSS ? '#fef2f2' : '#f9fafb',
          color: isSS ? '#dc2626' : '#9ca3af',
          border: isSS ? '1px solid #fca5a5' : '1px solid #e5e7eb',
        }}
        onClick={onSetShortShip}
        disabled={disabled || isSS}
        title="Set all SKUs to Short Ship"
      >
        SS
      </button>
      <button
        style={{
          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
          background: isHold ? '#f5f3ff' : '#f9fafb',
          color: isHold ? '#7c3aed' : '#9ca3af',
          border: isHold ? '1px solid #c4b5fd' : '1px solid #e5e7eb',
        }}
        onClick={onSetHold}
        disabled={disabled || isHold}
        title="Set all SKUs to Inventory Hold"
      >
        Hold
      </button>
    </div>
  )
}

// ── SKU-level status control (3-way radio) ──────────────────────────────────

function SkuStatusControl({ skuStatus, onSet, disabled }) {
  return (
    <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer', color: '#6b7280' }}>
        <input type="radio" name="sku-status" checked={skuStatus === 'none'} onChange={() => onSet('none')} disabled={disabled} style={{ margin: 0 }} />
        None
      </label>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer', color: '#dc2626' }}>
        <input type="radio" name="sku-status" checked={skuStatus === 'short_ship'} onChange={() => onSet('short_ship')} disabled={disabled} style={{ margin: 0 }} />
        SS
      </label>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer', color: '#7c3aed' }}>
        <input type="radio" name="sku-status" checked={skuStatus === 'inv_hold'} onChange={() => onSet('inv_hold')} disabled={disabled} style={{ margin: 0 }} />
        Hold
      </label>
    </div>
  )
}

// ── Currently Active Panel ──────────────────────────────────────────────────

function CurrentStatusPanel({ ptData, onSetShortShip, onSetHold, onClearShortShip, onClearHold, isPending }) {
  const activeShortShip = ptData.filter(pt => pt.all_short_ship || pt.short_ship_count > 0)
  const activeHold = ptData.filter(pt => pt.all_inventory_hold || pt.inventory_hold_count > 0)
  const hasAny = activeShortShip.length > 0 || activeHold.length > 0

  if (!hasAny) {
    return (
      <div className="inv-dash-panel" style={{ marginBottom: 16 }}>
        <div className="inv-dash-panel-header">Currently Active</div>
        <div style={{ padding: '10px 16px', color: '#16a34a', fontSize: 13 }}>✓ No product types have short ship or inventory hold enabled</div>
      </div>
    )
  }

  return (
    <div className="inv-dash-panel" style={{ marginBottom: 16 }}>
      <div className="inv-dash-panel-header">
        <span>Currently Active</span>
        <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 8 }}>
          Product types with short ship or inventory hold enabled
        </span>
      </div>
      <table className="inv-dash-table">
        <thead>
          <tr>
            <th>Product Type</th>
            <th style={{ textAlign: 'right', width: 60 }}>SKUs</th>
            <th style={{ textAlign: 'right', width: 80 }}>SS SKUs</th>
            <th style={{ textAlign: 'right', width: 80 }}>Hold SKUs</th>
            <th style={{ textAlign: 'center', width: 120 }}>Status</th>
            <th style={{ textAlign: 'center', width: 140 }}>Change</th>
          </tr>
        </thead>
        <tbody>
          {[...activeShortShip, ...activeHold.filter(pt => !activeShortShip.includes(pt))].map(pt => {
            const status = getTypeStatus(pt)
            const counts = status === 'partial_ss' ? `${pt.short_ship_count}/${pt.sku_count}`
              : status === 'partial_hold' ? `${pt.inventory_hold_count}/${pt.sku_count}`
              : status === 'mixed' ? `SS:${pt.short_ship_count} H:${pt.inventory_hold_count}`
              : null
            return (
              <tr key={pt.label}>
                <td style={{ fontWeight: 500 }}>{pt.label}</td>
                <td style={{ textAlign: 'right', color: '#6b7280' }}>{pt.sku_count}</td>
                <td style={{ textAlign: 'right', color: pt.short_ship_count > 0 ? '#dc2626' : '#9ca3af', fontWeight: pt.short_ship_count > 0 ? 600 : 400 }}>{pt.short_ship_count}</td>
                <td style={{ textAlign: 'right', color: pt.inventory_hold_count > 0 ? '#7c3aed' : '#9ca3af', fontWeight: pt.inventory_hold_count > 0 ? 600 : 400 }}>{pt.inventory_hold_count}</td>
                <td style={{ textAlign: 'center' }}>
                  <StatusBadge status={status} counts={counts} />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <TypeStatusControl
                    pt={pt}
                    typeStatus={status}
                    onSetShortShip={() => onSetShortShip(pt)}
                    onSetHold={() => onSetHold(pt)}
                    onClear={() => {
                      if (status === 'short_ship' || status === 'partial_ss') onClearShortShip(pt)
                      else if (status === 'inv_hold' || status === 'partial_hold') onClearHold(pt)
                      else { onClearShortShip(pt); onClearHold(pt) }
                    }}
                    disabled={isPending}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Filter Section (A and B) ──────────────────────────────────────────────────

function FilterSection({ title, description, rows, emptyMsg, emptyIsGood, onShortShip, onHold, onClear, isPending }) {
  const isFilterB = !!onClear
  return (
    <div className="staging-filter-section">
      <div className="staging-filter-header">
        <span className="staging-filter-title">{title}</span>
        <span className="staging-filter-desc">{description}</span>
        {rows.length > 0 && (
          <span className="staging-filter-count">{rows.length}</span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className={`staging-filter-empty${emptyIsGood ? ' good' : ''}`}>
          {emptyIsGood ? '✓ ' : ''}{emptyMsg}
        </div>
      ) : (
        <table className="inv-dash-table">
          <thead>
            <tr>
              <th>Product Type</th>
              <th>Pick SKU</th>
              <th style={{ textAlign: 'right' }}>On Hand</th>
              <th style={{ textAlign: 'right' }}>Staged Demand</th>
              <th style={{ textAlign: 'right' }}>Ending Balance</th>
              <th style={{ textAlign: 'center' }}>Current</th>
              <th style={{ textAlign: 'center', width: 180 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(pt => {
              const a = pt.analysisItems[0]
              const ending = a ? a.on_hand_qty - a.total_demand : null
              const status = getTypeStatus(pt)
              return (
                <tr key={pt.label} className={a && ending != null && ending < 0 ? 'row-neg' : 'row-pos'}>
                  <td style={{ fontWeight: 500 }}>{pt.label}</td>
                  <td className="mono" style={{ color: '#4f8ef7' }}>{pt.pickSkus[0] || '—'}</td>
                  <td style={{ textAlign: 'right', color: a && ending != null && ending < 0 ? '#dc2626' : '#374151', fontWeight: a && ending != null && ending < 0 ? 600 : 400 }}>
                    {a ? fmt(a.on_hand_qty) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: '#92400e' }}>
                    {a ? fmt(a.total_demand) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: ending != null && ending < 0 ? '#dc2626' : '#374151', fontWeight: ending != null && ending < 0 ? 600 : 400 }}>
                    {ending != null ? fmt(ending) : '—'}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {status !== 'none' && <StatusBadge status={status} />}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {pt._unsynced ? (
                      <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 500 }}
                        title="This product is not in your product catalog. Click ↺ Sync Products to import it.">
                        ⚠ Sync Products first
                      </span>
                    ) : isFilterB ? (
                      <button
                        style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                        onClick={() => onClear(pt)}
                        disabled={isPending}
                      >
                        Clear
                      </button>
                    ) : (
                      <div style={{ display: 'inline-flex', gap: 4 }}>
                        <button
                          style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                          onClick={() => onShortShip(pt)}
                          disabled={isPending}
                        >
                          Short Ship
                        </button>
                        <button
                          style={{ background: '#f5f3ff', color: '#7c3aed', border: '1px solid #c4b5fd', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                          onClick={() => onHold(pt)}
                          disabled={isPending}
                        >
                          Inv Hold
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Filter C Section (multi pick SKU) ────────────────────────────────────────

function FilterCSection({ filterCA, filterCB, onShortShip, onHold, onClear, isPending }) {
  const allRows = [
    ...filterCA.map(pt => ({ ...pt, issue: 'A' })),
    ...filterCB.map(pt => ({ ...pt, issue: 'B' })),
  ]

  return (
    <div className="staging-filter-section">
      <div className="staging-filter-header">
        <span className="staging-filter-title">C — Multiple Pick SKUs</span>
        <span className="staging-filter-desc">Staged product types with multiple pick SKUs (same A/B conditions)</span>
        {allRows.length > 0 && (
          <span className="staging-filter-count">{allRows.length}</span>
        )}
      </div>

      {allRows.length === 0 ? (
        <div className="staging-filter-empty good">✓ No multi-pick-SKU issues found</div>
      ) : (
        <table className="inv-dash-table">
          <thead>
            <tr>
              <th>Product Type</th>
              <th>Issue</th>
              <th>Pick SKU</th>
              <th style={{ textAlign: 'right' }}>On Hand</th>
              <th style={{ textAlign: 'right' }}>Staged Demand</th>
              <th style={{ textAlign: 'right' }}>Ending Balance</th>
              <th style={{ textAlign: 'center', width: 180 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {allRows.map(pt => {
              const isA = pt.issue === 'A'
              return [
                <tr key={`${pt.label}-hdr`} className="row-group-header">
                  <td colSpan={2} style={{ fontWeight: 600 }}>
                    {pt.label}
                    <span style={{
                      marginLeft: 8, fontSize: 11, padding: '1px 6px', borderRadius: 4,
                      background: isA ? '#fef2f2' : '#eff6ff',
                      color: isA ? '#dc2626' : '#1d4ed8',
                    }}>
                      {isA ? 'A — No Inventory, No Status' : 'B — Has Inventory, Status Set'}
                    </span>
                  </td>
                  <td />
                  <td />
                  <td />
                  <td />
                  <td style={{ textAlign: 'center' }}>
                    {isA ? (
                      <div style={{ display: 'inline-flex', gap: 4 }}>
                        <button
                          style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                          onClick={() => onShortShip(pt)}
                          disabled={isPending}
                        >
                          Short Ship
                        </button>
                        <button
                          style={{ background: '#f5f3ff', color: '#7c3aed', border: '1px solid #c4b5fd', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                          onClick={() => onHold(pt)}
                          disabled={isPending}
                        >
                          Inv Hold
                        </button>
                      </div>
                    ) : (
                      <button
                        style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                        onClick={() => onClear(pt)}
                        disabled={isPending}
                      >
                        Clear
                      </button>
                    )}
                  </td>
                </tr>,
                ...pt.analysisItems.map(a => {
                  const ending = a.on_hand_qty - a.total_demand
                  return (
                    <tr key={`${pt.label}-${a.pick_sku}`} className={ending < 0 ? 'row-neg' : 'row-pos'}>
                      <td />
                      <td />
                      <td className="mono" style={{ color: '#4f8ef7', paddingLeft: 16 }}>{a.pick_sku}</td>
                      <td style={{ textAlign: 'right', color: ending < 0 ? '#dc2626' : '#374151', fontWeight: ending < 0 ? 600 : 400 }}>
                        {fmt(a.on_hand_qty)}
                      </td>
                      <td style={{ textAlign: 'right', color: '#92400e' }}>{fmt(a.total_demand)}</td>
                      <td style={{ textAlign: 'right', color: ending < 0 ? '#dc2626' : '#374151', fontWeight: ending < 0 ? 600 : 400 }}>
                        {fmt(ending)}
                      </td>
                      <td />
                    </tr>
                  )
                }),
              ]
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Tab: Inventory Hold Orders ───────────────────────────────────────────────

function InventoryHoldTab() {
  const [warehouse, setWarehouse] = useState('walnut')

  const { data: allOrders = [], isLoading } = useQuery({
    queryKey: ['orders', { app_status: 'not_processed' }],
    queryFn: () => ordersApi.list({ app_status: 'not_processed' }),
    staleTime: 30000,
  })

  // Filter to orders that have at least one inventory_hold line item
  const holdOrders = useMemo(() => {
    return allOrders.filter(order => {
      if (warehouse && order.assigned_warehouse !== warehouse) return false
      const items = order.line_items || []
      return items.some(li =>
        li.app_line_status === 'inventory_hold' && (li.fulfillable_quantity ?? li.quantity ?? 0) > 0
      )
    })
  }, [allOrders, warehouse])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div className="wh-tabs" style={{ marginBottom: 0 }}>
          {WAREHOUSES.map(wh => (
            <button
              key={wh}
              onClick={() => setWarehouse(wh)}
              className={`wh-tab${warehouse === wh ? ' active' : ''}`}
            >
              {wh.charAt(0).toUpperCase() + wh.slice(1)}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 13, color: '#6b7280' }}>
          {holdOrders.length} order{holdOrders.length !== 1 ? 's' : ''} on inventory hold
        </span>
      </div>

      {isLoading ? (
        <div className="loading">Loading…</div>
      ) : holdOrders.length === 0 ? (
        <div className="inv-dash-panel">
          <div style={{ padding: '16px', color: '#16a34a', fontSize: 13 }}>✓ No orders are currently on inventory hold</div>
        </div>
      ) : (
        <div className="inv-dash-panel">
          <table className="inv-dash-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th style={{ textAlign: 'right' }}>Revenue</th>
                <th>Warehouse</th>
                <th>Order Date</th>
                <th>Tags</th>
                <th>Items</th>
                <th>Hold Items</th>
              </tr>
            </thead>
            <tbody>
              {holdOrders.map(order => {
                const tags = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean)
                const items = (order.line_items || []).filter(li =>
                  (li.fulfillable_quantity ?? li.quantity ?? 0) > 0
                )
                const holdItems = items.filter(li => li.app_line_status === 'inventory_hold')
                const normalItems = items.filter(li => li.app_line_status !== 'inventory_hold' && li.app_line_status !== 'short_ship' && li.app_line_status !== 'removed')
                return (
                  <tr key={order.shopify_order_id}>
                    <td style={{ fontWeight: 600 }}>
                      {order.shopify_order_number || order.shopify_order_id}
                    </td>
                    <td>{order.customer_name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {order.total_price != null ? `$${Number(order.total_price).toFixed(2)}` : '—'}
                    </td>
                    <td>{order.assigned_warehouse || '—'}</td>
                    <td>{fmtDate(order.created_at_shopify)}</td>
                    <td>
                      {tags.length > 0 ? (
                        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                          {tags.map(tag => (
                            <span key={tag} className={tagChipClass(tag)}>{tag}</span>
                          ))}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {normalItems.length > 0 && (
                        <span style={{ color: '#374151' }}>{normalItems.length} ready</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {holdItems.map((li, i) => (
                          <span key={i} style={{ fontSize: 11, background: '#f5f3ff', color: '#7c3aed', padding: '1px 6px', borderRadius: 4, border: '1px solid #c4b5fd', display: 'inline-block' }}>
                            {li.shopify_sku || li.product_title} x{li.fulfillable_quantity ?? li.quantity}
                          </span>
                        ))}
                      </div>
                    </td>
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

// ── Tab 4: Catalog Errors Dashboard ──────────────────────────────────────────

function CatalogErrorsTab() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['catalog-errors'],
    queryFn: () => productsApi.catalogErrors(),
    staleTime: 30000,
  })

  const noType       = data?.no_product_type     ?? []
  const noProduct    = data?.no_shopify_product   ?? []
  const noSkuOnLine  = data?.no_sku_on_line_item  ?? []

  const totalIssues = noType.length + noProduct.length + noSkuOnLine.length

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Catalog Errors</h2>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? 'Refreshing…' : '↺ Refresh'}
        </button>
        {!isLoading && (
          <span style={{ fontSize: 13, color: totalIssues > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
            {totalIssues === 0 ? '✓ No issues found' : `${totalIssues} issue${totalIssues !== 1 ? 's' : ''} found`}
          </span>
        )}
      </div>

      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
        Surfaces SKU and product-type data quality issues that cause items to be invisible in the Short Ship Config or miscategorised.
        Run <strong>↺ Sync Products</strong> on the Short Ship Config tab to attempt automatic fixes, then refresh here.
      </div>

      {isLoading ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          {/* ── Section 1: No Product Type ──────────────────────────────────── */}
          <div className="inv-dash-panel" style={{ marginBottom: 20 }}>
            <div className="inv-dash-panel-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>No Product Type</span>
              {noType.length > 0 && (
                <span style={{ fontSize: 12, background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 4, padding: '1px 7px', fontWeight: 700 }}>
                  {noType.length}
                </span>
              )}
              <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 4 }}>
                SKUs in your catalog with no Shopify product type set — they fall into "(no type)" and won't appear as a named group in Short Ship Config
              </span>
            </div>
            {noType.length === 0 ? (
              <div style={{ padding: '10px 16px', color: '#16a34a', fontSize: 13 }}>✓ All catalog products have a product type</div>
            ) : (
              <table className="inv-dash-table">
                <thead>
                  <tr>
                    <th>Shopify SKU</th>
                    <th>Title</th>
                    <th style={{ textAlign: 'center', width: 120 }}>Short Ship?</th>
                    <th style={{ textAlign: 'center', width: 110 }}>Source</th>
                    <th>Last Synced</th>
                  </tr>
                </thead>
                <tbody>
                  {noType.map(p => (
                    <tr key={p.id} style={{ background: p.allow_short_ship ? '#fff7ed' : undefined }}>
                      <td className="mono" style={{ color: '#4f8ef7' }}>{p.shopify_sku}</td>
                      <td style={{ color: '#374151' }}>{p.title || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                      <td style={{ textAlign: 'center' }}>
                        {p.allow_short_ship ? (
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', background: '#fef2f2', padding: '2px 8px', borderRadius: 4, border: '1px solid #fca5a5' }}>
                            Yes
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>No</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {p.source === 'shopify' ? (
                          <span style={{ fontSize: 11, color: '#1d4ed8', background: '#eff6ff', padding: '2px 8px', borderRadius: 4, border: '1px solid #bfdbfe' }}>
                            Shopify
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: '#d97706', background: '#fffbeb', padding: '2px 8px', borderRadius: 4, border: '1px solid #fcd34d' }}>
                            Placeholder
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: '#6b7280' }}>
                        {p.synced_at ? new Date(p.synced_at).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Section 2: SKUs on orders with no catalog record ────────────── */}
          <div className="inv-dash-panel" style={{ marginBottom: 20 }}>
            <div className="inv-dash-panel-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>SKU Not in Catalog</span>
              {noProduct.length > 0 && (
                <span style={{ fontSize: 12, background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 4, padding: '1px 7px', fontWeight: 700 }}>
                  {noProduct.length}
                </span>
              )}
              <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 4 }}>
                Shopify SKUs on open orders that have no matching row in your product catalog — short ship cannot be configured for these
              </span>
            </div>
            {noProduct.length === 0 ? (
              <div style={{ padding: '10px 16px', color: '#16a34a', fontSize: 13 }}>✓ All open order SKUs are in the catalog</div>
            ) : (
              <table className="inv-dash-table">
                <thead>
                  <tr>
                    <th>Shopify SKU</th>
                    <th>Product Title</th>
                    <th style={{ textAlign: 'right', width: 90 }}>Open Orders</th>
                    <th>Order Numbers</th>
                  </tr>
                </thead>
                <tbody>
                  {noProduct.map(p => (
                    <tr key={p.shopify_sku}>
                      <td className="mono" style={{ color: '#dc2626' }}>{p.shopify_sku}</td>
                      <td>{p.product_title || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: '#dc2626' }}>{p.order_count}</td>
                      <td style={{ fontSize: 12, color: '#6b7280' }}>{p.order_numbers.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Section 3: Line items with no SKU at all ────────────────────── */}
          <div className="inv-dash-panel">
            <div className="inv-dash-panel-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Line Items with No SKU</span>
              {noSkuOnLine.length > 0 && (
                <span style={{ fontSize: 12, background: '#fffbeb', color: '#d97706', border: '1px solid #fcd34d', borderRadius: 4, padding: '1px 7px', fontWeight: 700 }}>
                  {noSkuOnLine.length}
                </span>
              )}
              <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400, marginLeft: 4 }}>
                Open order line items with a blank SKU in Shopify — these can't be mapped or short-shipped
              </span>
            </div>
            {noSkuOnLine.length === 0 ? (
              <div style={{ padding: '10px 16px', color: '#16a34a', fontSize: 13 }}>✓ No blank-SKU line items on open orders</div>
            ) : (
              <table className="inv-dash-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Product Title</th>
                    <th>Variant</th>
                  </tr>
                </thead>
                <tbody>
                  {noSkuOnLine.map((r, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ color: '#4f8ef7' }}>{r.order_number || r.shopify_order_id}</td>
                      <td>{r.product_title || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                      <td style={{ color: '#6b7280' }}>{r.variant_title || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'staged-orders', label: 'Staged Orders' },
  { key: 'inventory-hold', label: 'Inventory Hold' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'short-ship', label: 'Short Ship / Hold Config' },
  { key: 'catalog-errors', label: '⚠ Catalog Errors' },
]

export default function StagingPage({ mode = 'operations' }) {
  const [activeTab, setActiveTab] = useState('staged-orders')

  return (
    <div>
      <div className="page-header">
        <h1>Staging Dashboard</h1>
        <p>View staged orders, inventory status, short ship and inventory hold configuration.</p>
      </div>

      {/* Top-level tabs */}
      <div className="staging-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`staging-tab${activeTab === tab.key ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ marginTop: 24 }}>
        {activeTab === 'staged-orders' && <StagedOrdersTab />}
        {activeTab === 'inventory-hold' && <InventoryHoldTab />}
        {activeTab === 'inventory' && <InventoryDashboard />}
        {activeTab === 'short-ship' && <ShortShipConfigTab />}
        {activeTab === 'catalog-errors' && <CatalogErrorsTab />}
      </div>
    </div>
  )
}
