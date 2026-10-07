import { Navigate } from 'react-router'
import { useWorkspace } from '@/lib/auth'
import { useBarbers } from '@/lib/api'
import { BarberScheduleEditor } from '@/components/BarberScheduleEditor'
import { PageHeader, Skeleton } from '@/components/ui'

export default function MySchedule() {
  const { ws } = useWorkspace()
  const { data: barbers } = useBarbers(ws.shop_id)
  if (!ws.barber_id) return <Navigate to="/app" replace />
  const me = barbers?.find((b) => b.id === ws.barber_id)
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow="Availability" title="My schedule" subtitle="Changes apply to online booking immediately." />
      {me ? <BarberScheduleEditor barber={me} /> : <Skeleton className="h-96" />}
    </div>
  )
}
