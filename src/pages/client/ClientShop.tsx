import { Navigate } from 'react-router'
import { QrCode } from 'lucide-react'
import { Card, EmptyState, Spinner } from '@/components/ui'
import { useMyAppointments } from './data'

/** "Shop" tab: straight to the customer's barbershop (the one they visit). Never a directory of shops. */
export default function ClientShop() {
  const { data: appts, isLoading } = useMyAppointments()
  if (isLoading) return <div className="flex justify-center py-16"><Spinner /></div>
  const last = [...(appts ?? [])].sort((a, b) => b.starts_at.localeCompare(a.starts_at))[0]
  if (last) return <Navigate to={`/shop/${last.shop_slug}`} replace />
  return (
    <Card>
      <EmptyState icon={<QrCode className="size-6" />} title="Scan your barbershop's QR code"
        body="Your shop's page opens with its barbers, live availability and booking. After your first visit it lives right here." />
    </Card>
  )
}
