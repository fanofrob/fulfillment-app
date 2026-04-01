import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table'
import { inventoryApi } from '../api'

const WAREHOUSES = ['walnut', 'northlake']

function ShortfallBar({ demand, available }) {
  if (!demand) return null
  const pct = Math.min(100, (available / demand) * 100)
  const fillClass = pct <= 0 ? 'bad' : pct < 50 ? 'warn' : 'good'
  return (
    <div className="coverage-bar-wrap">
      <div className="coverage-bar-track">
        <div
          className={`coverage-bar-fill ${fillClass}`}
          style={{ width: `${Math.max(0, pct)}%` }}
        />
      </div>
      <span className="coverage-bar-pct">{pct.toFixed(0)}%</span>
    </div>
  )
}

function SkuBreakdownRow({ breakdown }) {
  if (!breakdown?.length) {
    return <p style={{ fontSize: 12, color: '#aaa', fontStyle: 'italic' }}>No Shopify SKU breakdown available.</p>
  }
  return (
    <table className="line-items-table">
      <thead>
        <tr>
          <th>Shopify SKU</th>
          <th>Product</th>
          <th style={{ textAlign: 'right' }}>Mix Qty</th>
          <th style={{ textAlign: 'right' }}>Units Demanded</th>
        </tr>
      </thead>
      <tbody>
        {breakdown.map((b, i) => (
          <tr key={i}>
            <td className="mono" style={{ color: '#4f8ef7' }}>{b.shopify_sku}</td>
            <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.product_title}>{b.product_title || '—'}</td>
            <td style={{ textAlign: 'right', color: '#888' }}>×{(b.mix_quantity || 1).toFixed(1)}</td>
            <td style={{ textAlign: 'right', fontWeight: 600 }}>{b.units_demanded.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function DemandDashboard() {
  const [warehouse, setWarehouse] = useState('walnut')
  const [expandedRows, setExpandedRows] = useState(new Set())
  const [sorting, setSorting] = useState([{ id: 'shortfall', desc: true }])

  const { data: analysis = [], isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['demand-analysis', warehouse],
    queryFn: () => inventoryApi.demandAnalysis(warehouse),
    staleTime: 60000,
  })

  const toggleRow = (pickSku) => {
    setExpandedRows(s => {
      const n = new Set(s)
      if (n.has(pickSku)) n.delete(pickSku)
      else n.add(pickSku)
      return n
    })
  }

  const columns = useMemo(() => [
    {
      id: 'expand',
      header: '',
      cell: ({ row }) => (
        <button onClick={() => toggleRow(row.original.pick_sku)} className="btn-link" style={{ width: 16 }}>
          {expandedRows.has(row.original.pick_sku) ? '▼' : '▶'}
        </button>
      ),
      enableSorting: false,
      size: 30,
    },
    {
      accessorKey: 'pick_sku',
      header: 'Pick SKU',
      cell: ({ getValue }) => <span className="mono" style={{ fontWeight: 600 }}>{getValue()}</span>,
    },
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ getValue }) => <span>{getValue() || '—'}</span>,
    },
    {
      accessorKey: 'available_qty',
      header: 'Available',
      cell: ({ getValue, row }) => {
        const v = getValue()
        const cls = v <= 0 ? 'qty-zero' : v < row.original.total_demand * 0.2 ? 'qty-low' : 'qty-ok'
        return <span className={cls}>{v.toFixed(1)}</span>
      },
    },
    {
      accessorKey: 'total_demand',
      header: 'Total Demand',
      cell: ({ getValue }) => <span style={{ fontWeight: 500 }}>{getValue().toFixed(1)}</span>,
    },
    {
      accessorKey: 'shortfall',
      header: 'Shortfall',
      cell: ({ getValue }) => {
        const v = getValue()
        return v > 0
          ? <span className="qty-zero">−{v.toFixed(1)}</span>
          : <span className="qty-ok">✓ Sufficient</span>
      },
    },
    {
      id: 'coverage',
      header: 'Coverage',
      cell: ({ row }) => (
        <ShortfallBar demand={row.original.total_demand} available={row.original.available_qty} />
      ),
      enableSorting: false,
    },
    {
      accessorKey: 'affected_order_count',
      header: 'Orders',
      cell: ({ getValue }) => <span>{getValue()}</span>,
    },
    {
      accessorKey: 'on_hand_qty',
      header: 'On Hand',
      cell: ({ getValue }) => <span style={{ color: '#aaa' }}>{getValue().toFixed(1)}</span>,
    },
    {
      accessorKey: 'committed_qty',
      header: 'Committed',
      cell: ({ getValue }) => <span style={{ color: '#aaa' }}>{getValue().toFixed(1)}</span>,
    },
  ], [expandedRows])

  const table = useReactTable({
    data: analysis,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const withShortfall = analysis.filter(a => a.shortfall > 0).length
  const totalUnitsShort = analysis.reduce((s, a) => s + a.shortfall, 0)

  return (
    <div>
      {/* Header */}
      <div className="page-header-row">
        <div className="page-header">
          <h1>Demand Dashboard</h1>
          <p>
            Shows pick SKU shortfalls using <strong>live SKU mappings from Google Sheets</strong>.
            Expand a row to see which Shopify SKUs map to it — change mappings in Sheets to redistribute demand.
          </p>
        </div>
        <div className="page-header-actions">
          {dataUpdatedAt > 0 && (
            <span style={{ fontSize: 12, color: '#aaa' }}>
              Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
            </span>
          )}
          <button onClick={() => refetch()} disabled={isFetching} className="btn btn-secondary">
            {isFetching ? 'Refreshing…' : '↺ Refresh Analysis'}
          </button>
        </div>
      </div>

      {/* Warehouse tabs */}
      <div className="wh-tabs">
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

      {/* Stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-num">{analysis.length}</div>
          <div className="stat-label">Pick SKUs with Demand</div>
        </div>
        <div className="stat-card">
          <div className={`stat-num ${withShortfall > 0 ? 'qty-zero' : 'qty-ok'}`} style={{ fontSize: 24 }}>{withShortfall}</div>
          <div className="stat-label">SKUs with Shortfall</div>
        </div>
        <div className="stat-card">
          <div className={`stat-num ${totalUnitsShort > 0 ? 'qty-zero' : 'qty-ok'}`} style={{ fontSize: 24 }}>{totalUnitsShort.toFixed(1)}</div>
          <div className="stat-label">Total Units Short</div>
        </div>
      </div>

      {/* No shortfalls banner */}
      {!isLoading && analysis.length > 0 && withShortfall === 0 && (
        <div className="success-banner">
          ✓ No shortfalls — current inventory covers all open order demand.
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="loading">Running demand analysis…</div>
      ) : error ? (
        <div className="error-msg">{error?.response?.data?.detail || 'Error loading demand analysis'}</div>
      ) : analysis.length === 0 ? (
        <div className="empty">No open orders found for {warehouse} warehouse.</div>
      ) : (
        <div className="data-table-wrap">
          <table>
            <thead>
              {table.getHeaderGroups().map(hg => (
                <tr key={hg.id}>
                  {hg.headers.map(header => (
                    <th key={header.id}>
                      <div
                        style={header.column.getCanSort() ? { cursor: 'pointer', userSelect: 'none' } : {}}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() === 'asc' && ' ↑'}
                        {header.column.getIsSorted() === 'desc' && ' ↓'}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map(row => {
                const isExpanded = expandedRows.has(row.original.pick_sku)
                const hasShortfall = row.original.shortfall > 0
                return (
                  <>
                    <tr
                      key={row.id}
                      className={hasShortfall ? 'row-shortfall' : ''}
                      style={{ cursor: 'pointer' }}
                      onClick={() => toggleRow(row.original.pick_sku)}
                    >
                      {row.getVisibleCells().map(cell => (
                        <td
                          key={cell.id}
                          onClick={cell.column.id === 'expand' ? undefined : e => e.stopPropagation()}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {isExpanded && (
                      <tr key={`${row.id}-expanded`} className="demand-expanded">
                        <td colSpan={columns.length}>
                          <p style={{ fontSize: 11, fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                            Shopify SKUs mapped to <span className="mono" style={{ color: '#4f8ef7' }}>{row.original.pick_sku}</span>
                            {' '}— change in Google Sheets to redistribute demand
                          </p>
                          <SkuBreakdownRow breakdown={row.original.shopify_sku_breakdown} />
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
