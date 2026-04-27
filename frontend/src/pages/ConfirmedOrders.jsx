import { useState } from 'react'
import OrdersPage from '../components/orders/OrdersPage'

export default function ConfirmedOrders() {
  const [periodId, setPeriodId] = useState(null)
  const [mappingTab, setMappingTab] = useState('')

  return (
    <OrdersPage
      mode="projections"
      periodId={periodId}
      mappingTab={mappingTab}
      onPeriodChange={setPeriodId}
      onMappingChange={setMappingTab}
    />
  )
}
