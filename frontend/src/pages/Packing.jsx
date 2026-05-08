import { useSearchParams } from 'react-router-dom'
import Inventory from './Inventory'
import PurchaseOrders from './PurchaseOrders'
import PickupRuns from './PickupRuns'

const TABS = [
  { key: 'inventory', label: 'Inventory' },
  { key: 'purchase-orders', label: 'Purchase Orders' },
  { key: 'pickup-runs', label: 'Pickup Runs' },
]

export default function Packing() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab = TABS.some(t => t.key === raw) ? raw : 'inventory'

  function setTab(key) {
    setParams({ tab: key }, { replace: true })
  }

  return (
    <div className="packing-shell">
      <header className="packing-tabs" role="tablist">
        <span className="packing-brand">GHF Packing</span>
        <div className="packing-tabs-list">
          {TABS.map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`packing-tab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <main className="packing-body">
        {tab === 'inventory' && <Inventory />}
        {tab === 'purchase-orders' && <PurchaseOrders />}
        {tab === 'pickup-runs' && <PickupRuns />}
      </main>
    </div>
  )
}
