import { Link } from 'react-router'
import { CalendarCheck, Heart, RotateCcw, CalendarPlus, Star } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { relativeDay, time, money } from '@/lib/format'
import { useFirstAvailable } from '../public/shared'
import { Avatar, Badge, Button, Card, EmptyState, Skeleton } from '@/components/ui'
import { isUpcoming, useMyAppointments, useMyFavorites, type MyAppointment } from './data'

export default function ClientHome() {
  const { user } = useAuth()
  const { data: appts, isLoading } = useMyAppointments()
  const { data: favs } = useMyFavorites()
  const next = appts?.filter(isUpcoming).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0]
  const last = appts?.find((a) => a.status === 'COMPLETED')
  const toReview = appts?.find((a) => a.status === 'COMPLETED' && !a.has_review && a.review_token)
  const name = user?.user_metadata?.full_name?.split(' ')[0]

  return (
    <div className="space-y-5">
      <h1 className="display text-[40px] leading-none">Hey{name ? ` ${name}` : ''} 👋</h1>
      {isLoading ? <Skeleton className="h-40" /> : next ? (
        <Card className="animate-rise overflow-hidden">
          <div className="h-1.5" style={{ background: next.accent_color }} />
          <div className="p-5">
            <div className="eyebrow">Next appointment</div>
            <div className="mt-3 flex items-center gap-4">
              <Avatar name={next.barber_name} src={next.barber_photo_url} size={52} />
              <div className="min-w-0 flex-1">
                <div className="text-xl font-semibold">{relativeDay(next.starts_at, next.timezone)} · {time(next.starts_at, next.timezone)}</div>
                <div className="text-sm text-muted">{next.service_name} with {next.barber_name} · {next.shop_name}</div>
              </div>
            </div>
            <Link to={`/a/${next.manage_token}`}><Button variant="secondary" block className="mt-5">Manage</Button></Link>
          </div>
        </Card>
      ) : last ? (
        <BookAgain a={last} />
      ) : (
        <Card><EmptyState icon={<CalendarPlus className="size-6" />} title="No appointments yet" body="Book from your barbershop's page — it'll show up here." /></Card>
      )}

      {next && last && <BookAgain a={last} compact />}

      {toReview && (
        <Link to={`/r/${toReview.review_token}`}>
          <Card className="flex items-center gap-3 p-4 transition hover:border-accent">
            <Star className="size-5 text-accent" />
            <div className="flex-1 text-sm"><b>How was your cut with {toReview.barber_name}?</b><div className="text-muted">Tap to leave a quick review</div></div>
          </Card>
        </Link>
      )}

      {!!favs?.length && (
        <section>
          <div className="eyebrow mb-3 flex items-center gap-1.5"><Heart className="size-3.5" /> Favorite barbers</div>
          <div className="space-y-2">{favs.map((f) => <FavoriteCard key={f.barber_id} f={f} />)}</div>
        </section>
      )}
      <Link to="/me/appointments" className="flex items-center justify-center gap-2 text-sm text-muted hover:text-ink"><CalendarCheck className="size-4" /> All appointments</Link>
    </div>
  )
}

function BookAgain({ a, compact }: { a: MyAppointment; compact?: boolean }) {
  const href = `/s/${a.shop_slug}/book?service=${a.service_ids[0] ?? ''}&barber=${a.barber_id}&rebook=${a.id}`
  if (compact)
    return (
      <Link to={href}>
        <Card className="flex items-center gap-3 p-4 transition hover:border-accent">
          <RotateCcw className="size-5 text-accent" />
          <div className="flex-1 text-sm"><b>Book again</b> · {a.service_name} with {a.barber_name}</div>
        </Card>
      </Link>
    )
  return (
    <Card className="p-5">
      <div className="eyebrow">Your usual</div>
      <div className="mt-3 flex items-center gap-4">
        <Avatar name={a.barber_name} src={a.barber_photo_url} size={52} />
        <div className="flex-1">
          <div className="text-lg font-semibold">{a.service_name}</div>
          <div className="text-sm text-muted">with {a.barber_name} · {a.shop_name} · {money(a.price_cents)}</div>
        </div>
      </div>
      <Link to={href}><Button size="xl" block className="mt-5" icon={<RotateCcw className="size-5" />}>BOOK AGAIN</Button></Link>
    </Card>
  )
}

function FavoriteCard({ f }: { f: { barber_id: string; barber_name: string; photo_url: string | null; title: string | null; shop_id: string; shop_name: string; shop_slug: string; barber_slug: string; timezone: string } }) {
  const { data: appts } = useMyAppointments()
  const svc = appts?.find((a) => a.barber_id === f.barber_id)?.service_ids[0]
  const { data: first } = useFirstAvailable(f.shop_id, svc ? [svc] : [])
  const next = first?.find((s) => s.barber_id === f.barber_id)
  return (
    <Link to={`/s/${f.shop_slug}/book?barber=${f.barber_id}${svc ? `&service=${svc}` : ''}`}>
      <Card className="flex items-center gap-3 p-4 transition hover:border-accent">
        <Avatar name={f.barber_name} src={f.photo_url} size={40} />
        <div className="min-w-0 flex-1"><div className="font-semibold">{f.barber_name}</div><div className="truncate text-xs text-muted">{f.shop_name}</div></div>
        {next ? <Badge tone="accent">{relativeDay(next.starts_at, f.timezone)} {time(next.starts_at, f.timezone)}</Badge> : <Badge>Book</Badge>}
      </Card>
    </Link>
  )
}
