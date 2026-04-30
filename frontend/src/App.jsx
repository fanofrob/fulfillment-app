import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom'
import SkuMapping from './pages/SkuMapping'
import PicklistSkus from './pages/PicklistSkus'
import SkuHelper from './pages/SkuHelper'
import Cogs from './pages/Cogs'
import RateCards from './pages/RateCards'
import Rules from './pages/Rules'
import PackageRules from './pages/PackageRules'
import CarrierServiceRules from './pages/CarrierServiceRules'
import Inventory from './pages/Inventory'
import Orders from './pages/Orders'
import ConfirmedOrders from './pages/ConfirmedOrders'
import ProjectionConfirmed from './pages/ProjectionConfirmed'
import DemandDashboard from './pages/DemandDashboard'
import ProjectionPeriods from './pages/ProjectionPeriods'
import HistoricalPromotions from './pages/HistoricalPromotions'
import ProjectionDashboard from './pages/ProjectionDashboard'
import Vendors from './pages/Vendors'
import PurchaseOrders from './pages/PurchaseOrders'
import PurchasePlanning from './pages/PurchasePlanning'
import StagingDashboard from './pages/StagingDashboard'
import IssueSkuDetail from './pages/IssueSkuDetail'
import InventoryCount from './pages/InventoryCount'
import './App.css'

// Routes that use the full-bleed no-padding layout
const FULL_BLEED_ROUTES = ['/orders', '/confirmed-orders']

export default function App() {
  const location = useLocation()
  const isFullBleed = FULL_BLEED_ROUTES.some(r => location.pathname.startsWith(r))

  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h2>GHF Fulfillment</h2>
        </div>
        <div className="nav-section-label">Operations</div>
        <ul>
          <li><NavLink to="/inventory">Inventory</NavLink></li>
          <li><NavLink to="/inventory-count">Inventory Count</NavLink></li>
          <li><NavLink to="/orders">Orders</NavLink></li>
          <li><NavLink to="/staging-dashboard">Staging Dashboard</NavLink></li>
          <li><NavLink to="/demand-dashboard">Demand Dashboard</NavLink></li>
        </ul>
        <div className="nav-section-label">Projections</div>
        <ul>
          <li><NavLink to="/projection-dashboard">Projection Dashboard</NavLink></li>
          <li><NavLink to="/projection-periods">Projection Periods</NavLink></li>
          <li><NavLink to="/confirmed-orders">Confirmed Orders</NavLink></li>
          <li><NavLink to="/projection-confirmed">Confirmed Demand</NavLink></li>
          <li><NavLink to="/historical-data">Historical Data</NavLink></li>
        </ul>
        <div className="nav-section-label">Procurement</div>
        <ul>
          <li><NavLink to="/vendors">Vendors</NavLink></li>
          <li><NavLink to="/purchase-planning">Purchase Planning</NavLink></li>
          <li><NavLink to="/purchase-orders">Purchase Orders</NavLink></li>
        </ul>
        <div className="nav-section-label">Reference Data</div>
        <ul>
          <li><NavLink to="/picklist-skus">Picklist SKUs</NavLink></li>
          <li><NavLink to="/sku-mapping">SKU Mapping</NavLink></li>
          <li><NavLink to="/sku-helper">SKU Helper</NavLink></li>
          <li><NavLink to="/cogs">COGS</NavLink></li>
          <li><NavLink to="/rate-cards">Rate Cards</NavLink></li>
          <li><NavLink to="/rules">Order Rules</NavLink></li>
          <li><NavLink to="/package-rules">Package Rules</NavLink></li>
          <li><NavLink to="/carrier-service-rules">Carrier Service Rules</NavLink></li>
        </ul>
      </nav>
      <main className={`main-content${isFullBleed ? ' no-padding' : ''}`}>
        <Routes>
          <Route path="/" element={<Navigate to="/inventory" replace />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/inventory-count" element={<InventoryCount />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/staging-dashboard" element={<StagingDashboard />} />
          <Route path="/staging-dashboard/issue/:pickSku" element={<IssueSkuDetail />} />
          <Route path="/demand-dashboard" element={<DemandDashboard />} />
          <Route path="/projection-dashboard" element={<ProjectionDashboard />} />
          <Route path="/projection-periods" element={<ProjectionPeriods />} />
          <Route path="/confirmed-orders" element={<ConfirmedOrders />} />
          <Route path="/projection-orders" element={<Navigate to="/confirmed-orders" replace />} />
          <Route path="/projection-confirmed" element={<ProjectionConfirmed />} />
          <Route path="/historical-data" element={<HistoricalPromotions />} />
          <Route path="/vendors" element={<Vendors />} />
          <Route path="/purchase-orders" element={<PurchaseOrders />} />
          <Route path="/purchase-planning" element={<PurchasePlanning />} />
          <Route path="/picklist-skus" element={<PicklistSkus />} />
          <Route path="/sku-mapping" element={<SkuMapping />} />
          <Route path="/sku-helper" element={<SkuHelper />} />
          <Route path="/cogs" element={<Cogs />} />
          <Route path="/rate-cards" element={<RateCards />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/package-rules" element={<PackageRules />} />
          <Route path="/carrier-service-rules" element={<CarrierServiceRules />} />
        </Routes>
      </main>
    </div>
  )
}
