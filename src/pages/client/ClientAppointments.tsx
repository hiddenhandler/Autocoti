import { useState } from 'react'
import { Link } from 'react-router'
import { CalendarX } from 'lucide-react'
import { dateLabel, money, relativeDay, time } from '@/lib/format'
import { Avatar, Card, EmptyState, Segmented, Skeleton, StatusBadge } from '@/components/ui'
import { isUpcoming, useMyAppointments } from './data'

export default function ClientAppointments() {
  const { data, isLoading } = useMyAppointments()
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming')
  const list = (data ?? []).filter((a) => (tab === 'upcoming' ? isUpcoming(a) : !isUpcoming(a)))
  if (tab === 'upcoming') list.sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  return (
    <div className="space-y-5">
      <h1 className="display text-[40px] leading-none">Appointments</h1>
      <Segmented value={tab} onChange={setTab} options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'History' }]} />
      {isLoading ? <Skeleton className="h-40" /> : !list.length ? (
        <Card><EmptyState icon={<CalendarX className="size-6" />} title={tab === 'upcoming' ? 'Nothing booked' : 'No history yet'} /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {list.map((a) => (
            <Link key={a.id} to={a.review_token && !a.has_review ? `/r/${a.review_token}` : `/a/${a.manage_token}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface-2">
              <Avatar name={a.barber_name} src={a.barber_photo_url} size={40} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{tab === 'upcoming' ? `${relativeDay(a.starts_at, a.timezone)} · ${time(a.starts_at, a.timezone)}` : dateLabel(a.starts_at, a.timezone, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                <div className="truncate text-sm text-muted">{a.service_name} · {a.barber_name} · {a.shop_name}</div>
              </div>
              <div className="text-right">
                <StatusBadge status={a.status} />
                <div className="mt-1 text-xs text-muted tnum">{money(a.price_cents)}</div>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  )
}
