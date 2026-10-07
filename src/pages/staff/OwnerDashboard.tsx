import { useMemo } from 'react'
import { Link, Navigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, CalendarClock, Check, Circle, Copy, CreditCard, DoorOpen, ListOrdered, Sparkles, UserMinus, Users } from 'lucide-react'
import { useAuth, useWorkspace } from '@/lib/auth'
import { useAnalytics, useAppointments, useBarbers, useLiveBoard, useOperations, useServices } from '@/lib/api'
import { LivePill, liveLines } from '@/components/live'
import { rpc } from '@/lib/supabase'
import { addDays, minutesOfDay, todayInTz, zonedToUtc } from '@/lib/time'
import { delta, fullName, greeting, minutes, money, pct, time } from '@/lib/format'
import { generateInsights } from '@/lib/insights'
import type { Appointment, Barber } from '@/lib/types'
import { AreaChart } from '@/components/charts'
import { Avatar, Button, Card, CardHeader, cx, Delta, Progress, Skeleton, Stat, useToast } from '@/components/ui'
import { AppointmentSheet, serviceLabel } from '@/components/appointments'
import { useState } from 'react'

export default function OwnerDashboard() {
  const { ws, can } = useWorkspace()
  const { user } = useAuth()
  if (!can('reports.shop')) return <Navigate to="/app" replace />
  const tz = ws.timezone
  const today = todayInTz(tz)
  const { data: t, isLoading } = useAnalytics(ws.shop_id, today, today)
  const { data: m } = useAnalytics(ws.shop_id, addDays(today, -29), today)
  const { data: ops } = useOperations(ws.shop_id, today, today)
  const { data: actions } = useQuery({ queryKey: ['owner_actions', ws.shop_id], refetchInterval: 60_000, queryFn: () => rpc<Record<string, any>>('owner_actions', { p_shop_id: ws.shop_id }) })
  const insights = useMemo(() => (m ? generateInsights(m).slice(0, 3) : []), [m])
  const firstName = (user?.user_metadata?.full_name ?? '').split(' ')[0]

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">{new Date().toLocaleDateString(undefined, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <h1 className="display mt-2 text-[44px] leading-none sm:text-[56px]">{greeting(tz)}{firstName ? `, ${firstName}` : ''}.</h1>
          {t && <p className="mt-3 text-muted">{todayLine(t.bookings.total, t.bookings.upcoming)}</p>}
        </div>
        <Link to="/app/calendar"><Button variant="secondary" icon={<CalendarClock className="size-4" />}>Open calendar</Button></Link>
      </div>

      <SetupChecklist />

      {/* TODAY */}
      <section>
        <div className="eyebrow mb-3">Today</div>
        {isLoading || !t ? <Skeleton className="h-36" /> : (
          <Card className="grid grid-cols-2 gap-x-6 gap-y-7 p-6 sm:grid-cols-4 xl:grid-cols-7">
            <Stat big label="Revenue" value={money(t.summary.net_revenue_cents, { cents: false })} sub={t.revenue.tips_cents ? `+ ${money(t.revenue.tips_cents, { cents: false })} tips` : 'service revenue'} />
            <Stat big label="Appointments" value={t.bookings.total} sub={`${t.bookings.upcoming} still to come`} />
            <Stat big label="Walk-ins" value={ops?.walk_ins ?? '—'} sub={ops?.walk_ins_left ? `${ops.walk_ins_left} left without a cut` : 'from the queue'} />
            <Stat big label="Completed" value={t.bookings.completed} sub={t.bookings.no_shows ? `${t.bookings.no_shows} no-show${t.bookings.no_shows > 1 ? 's' : ''}` : 'no no-shows'} />
            <Stat big label="Average ticket" value={money(t.summary.avg_ticket_cents, { cents: false })} sub={`${t.summary.tickets} paid`} />
            <Stat big label="Average wait" value={ops?.avg_wait_minutes !== null && ops?.avg_wait_minutes !== undefined ? `${Math.round(ops.avg_wait_minutes)} min` : '—'} sub="booked + walk-in" />
            <Stat big label="On-time" value={pct(ops?.on_time_pct)} sub={t.cut_time.avg_actual_minutes ? `avg cut ${minutes(t.cut_time.avg_actual_minutes)}` : 'started within 5 min'} />
          </Card>
        )}
      </section>

      <ShopStatus />

      <div className="mt-8 grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <ShopTimeline />
          <BusinessHealth />
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Actions" subtitle="What needs you right now" />
            <div className="p-3">
              {!actions ? <Skeleton className="m-2 h-24" /> : <ActionList a={actions} />}
            </div>
          </Card>
          <Card>
            <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-accent" /> Insights</span>} subtitle="Last 30 days" action={<Link to="/app/insights" className="text-sm text-muted hover:text-ink">All</Link>} />
            <div className="space-y-3 p-5">
              {insights.length === 0 ? (
                <p className="text-sm text-muted">Insights appear once there's enough history — typically after a couple of weeks of bookings and timed cuts.</p>
              ) : insights.map((i) => (
                <div key={i.id} className="rounded-xl bg-surface-2 p-4">
                  <div className="text-sm font-semibold leading-snug">{i.title}</div>
                  {i.recommendation && <div className="mt-1.5 text-[13px] text-muted">{i.recommendation}</div>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

/** CURRENT SHOP STATUS — live, per chair. */
function ShopStatus() {
  const { ws } = useWorkspace()
  const { data: board } = useLiveBoard(ws.shop_id)
  if (!board) return <Skeleton className="mt-6 h-40" />
  const people = board.chairs.length ? board.chairs.filter((c) => c.barber).map((c) => ({ chair: c.label, b: c.barber! })) : board.barbers.map((b) => ({ chair: null, b }))
  return (
    <section className="mt-6">
      <Card>
        <CardHeader title="Current shop status" subtitle={`${board.counts.working} barbers working · ${board.counts.available} available · ${board.counts.cutting} cutting · ${board.counts.on_break} on break`}
          action={<Link to="/app/chairs" className="text-sm text-muted hover:text-ink">Chairs</Link>} />
        <div className="grid gap-px p-5 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          {people.map(({ chair, b }) => (
            <div key={b.barber_id} className="flex items-start gap-3 rounded-xl p-2">
              <Avatar name={b.name} src={b.photo_url} size={36} />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{b.name}{chair && <span className="font-normal text-muted"> · {chair}</span>}</div>
                <LivePill status={b.status} size="sm" />
                {liveLines(b, ws.timezone)[0] && <div className="truncate text-xs text-muted">{liveLines(b, ws.timezone)[0]}</div>}
              </div>
            </div>
          ))}
          {people.length === 0 && <p className="text-sm text-muted">No barbers yet.</p>}
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
          <span>Current queue: <b>{board.walk_ins.waiting}</b> customer{board.walk_ins.waiting === 1 ? '' : 's'}{board.walk_ins.estimated_wait_minutes ? ` · ~${board.walk_ins.estimated_wait_minutes} min wait` : ''}</span>
          <Link to="/app/walk-ins" className="text-muted hover:text-ink">Queue →</Link>
        </div>
      </Card>
    </section>
  )
}

function ActionList({ a }: { a: Record<string, any> }) {
  const items = [
    a.unpaid_completed > 0 && { icon: CreditCard, tone: 'warning', text: `${a.unpaid_completed} finished cut${a.unpaid_completed > 1 ? 's' : ''} with no payment recorded`, to: '/app/payments?filter=unpaid' },
    a.stale_open_appointments > 0 && { icon: AlertTriangle, tone: 'warning', text: `${a.stale_open_appointments} past appointment${a.stale_open_appointments > 1 ? 's' : ''} still open — complete or mark no-show`, to: '/app/appointments?filter=stale' },
    a.walk_ins_waiting > 0 && { icon: DoorOpen, tone: 'info', text: `${a.walk_ins_waiting} walk-in${a.walk_ins_waiting > 1 ? 's' : ''} waiting`, to: '/app/walk-ins' },
    a.follow_up_clients > 0 && { icon: Users, tone: 'accent', text: `${a.follow_up_clients} client${a.follow_up_clients > 1 ? 's need' : ' needs'} follow-up`, to: '/app/clients?health=DUE' },
    a.waitlist_bookable > 0 && { icon: ListOrdered, tone: 'accent', text: `${a.waitlist_bookable} waitlist client${a.waitlist_bookable > 1 ? 's' : ''} can be booked`, to: '/app/waitlist' },
    ...(a.under_capacity_barbers ?? []).map((b: any) => ({ icon: UserMinus, tone: 'neutral', text: `${b.name} is under capacity today (${pct(b.utilization)} booked of ${b.free_hours}h)`, to: '/app/calendar' })),
    a.pending_fees > 0 && { icon: CreditCard, tone: 'neutral', text: `${a.pending_fees} policy fee${a.pending_fees > 1 ? 's' : ''} to charge or waive`, to: '/app/appointments?filter=fees' },
  ].filter(Boolean) as { icon: any; tone: string; text: string; to: string }[]
  if (!items.length) return <div className="flex items-center gap-2 p-3 text-sm text-muted"><Check className="size-4 text-success" /> All clear. Nothing needs you right now.</div>
  return (
    <ul>
      {items.map((i, k) => (
        <li key={k}>
          <Link to={i.to} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2">
            <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', { warning: 'bg-warning/14 text-warning', info: 'bg-info/12 text-info', accent: 'bg-accent-soft text-accent', neutral: 'bg-surface-2 text-muted' }[i.tone])}>
              <i.icon className="size-4" />
            </span>
            <span className="flex-1 text-sm">{i.text}</span>
            <ArrowRight className="size-4 text-faint transition group-hover:translate-x-0.5 group-hover:text-ink" />
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Today's shop: one row per barber, appointments laid out on a time axis. */
function ShopTimeline() {
  const { ws } = useWorkspace()
  const tz = ws.timezone
  const today = todayInTz(tz)
  const { data: barbers } = useBarbers(ws.shop_id)
  const { data: appts } = useAppointments(ws.shop_id, zonedToUtc(today, '00:00', tz).toISOString(), zonedToUtc(addDays(today, 1), '00:00', tz).toISOString())
  const [sel, setSel] = useState<Appointment | null>(null)
  const active = (barbers ?? []).filter((b) => b.status === 'active')
  const list = (appts ?? []).filter((a) => a.status !== 'CANCELLED')
  const mins = list.flatMap((a) => [minutesOfDay(a.starts_at, tz), minutesOfDay(a.ends_at, tz)])
  const start = Math.min(9 * 60, ...mins)
  const end = Math.max(19 * 60, ...mins)
  const span = end - start
  const nowMin = minutesOfDay(new Date(), tz)
  const hours: number[] = []
  for (let h = Math.ceil(start / 60); h * 60 <= end; h++) hours.push(h)

  return (
    <Card>
      <CardHeader title="Today's shop" subtitle={`${list.filter((a) => a.kind === 'appointment').length} appointments across ${active.length} chair${active.length === 1 ? '' : 's'}`} action={<Link to="/app/calendar" className="text-sm text-muted hover:text-ink">Calendar</Link>} />
      <div className="overflow-x-auto px-5 pb-5 pt-4">
        <div className="min-w-[640px]">
          <div className="relative ml-28 h-5 text-[10px] text-faint">
            {hours.map((h) => (
              <span key={h} className="absolute -translate-x-1/2 tnum" style={{ left: `${((h * 60 - start) / span) * 100}%` }}>
                {new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}
              </span>
            ))}
          </div>
          {active.length === 0 && <p className="py-6 text-center text-sm text-muted">Add barbers to see the shop's day.</p>}
          {active.map((b: Barber) => {
            const mine = list.filter((a) => a.barber_id === b.id)
            const inChair = mine.find((a) => a.status === 'IN_SERVICE')
            return (
              <div key={b.id} className="flex items-center gap-3 py-2">
                <div className="flex w-25 shrink-0 items-center gap-2">
                  <Avatar name={b.display_name} src={b.photo_url} size={26} />
                  <span className="truncate text-sm font-medium">{b.display_name}</span>
                </div>
                <div className="relative h-9 flex-1 rounded-lg bg-surface-2">
                  {mine.map((a) => {
                    const s = minutesOfDay(a.starts_at, tz)
                    const e = minutesOfDay(a.ends_at, tz) || 24 * 60
                    return (
                      <button key={a.id} onClick={() => setSel(a)}
                        title={`${time(a.starts_at, tz)} ${a.kind === 'appointment' ? fullName(a.client) + ' · ' + serviceLabel(a) : a.title}`}
                        className={cx('absolute inset-y-1 rounded-md border-2 border-surface-2 transition hover:brightness-110',
                          a.kind !== 'appointment' ? 'bg-surface-3' :
                          { IN_SERVICE: 'bg-success', COMPLETED: 'bg-muted/50', NO_SHOW: 'bg-danger/60', CHECKED_IN: 'bg-warning', CONFIRMED: 'bg-accent', BOOKED: 'bg-info/80' }[a.status as 'BOOKED'] ?? 'bg-info')}
                        style={{ left: `${((s - start) / span) * 100}%`, width: `${((e - s) / span) * 100}%` }} />
                    )
                  })}
                  {nowMin > start && nowMin < end && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-danger" style={{ left: `${((nowMin - start) / span) * 100}%` }} />}
                </div>
                <div className="w-16 shrink-0 text-right text-xs">
                  {inChair ? <span className="font-semibold text-success">In chair</span> : <span className="text-muted">{mine.filter((a) => a.kind === 'appointment').length} appts</span>}
                </div>
              </div>
            )
          })}
          <div className="ml-28 mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
            {[['bg-info/80', 'Booked'], ['bg-accent', 'Confirmed'], ['bg-warning', 'Checked in'], ['bg-success', 'In chair'], ['bg-muted/50', 'Done'], ['bg-danger/60', 'No-show'], ['bg-surface-3', 'Blocked']].map(([c, l]) => (
              <span key={l} className="inline-flex items-center gap-1.5"><span className={cx('size-2.5 rounded-sm', c)} />{l}</span>
            ))}
          </div>
        </div>
      </div>
      <AppointmentSheet appt={sel} onClose={() => setSel(null)} />
    </Card>
  )
}

function BusinessHealth() {
  const { ws } = useWorkspace()
  const today = todayInTz(ws.timezone)
  const { data: a } = useAnalytics(ws.shop_id, addDays(today, -29), today)
  if (!a) return <Skeleton className="h-72" />
  const s = a.summary
  const p = a.previous
  const ppDelta = (cur: number | null, prev: number | null) => (cur === null || prev === null ? null : cur - prev)
  const rows = [
    { label: 'Revenue', value: money(s.net_revenue_cents, { cents: false }), d: delta(s.net_revenue_cents, p.net_revenue_cents) },
    { label: 'Bookings', value: s.bookings, d: delta(s.bookings, p.bookings) },
    { label: 'Avg ticket', value: money(s.avg_ticket_cents, { cents: false }), d: delta(s.avg_ticket_cents, p.avg_ticket_cents) },
    { label: 'Rebooking', value: pct(s.rebooking_rate), pp: ppDelta(s.rebooking_rate, p.rebooking_rate) },
    { label: 'No-shows', value: pct(s.no_show_rate, 1), pp: ppDelta(s.no_show_rate, p.no_show_rate), inverse: true },
    { label: 'Utilization', value: pct(s.utilization), pp: ppDelta(s.utilization, p.utilization) },
  ]
  return (
    <Card>
      <CardHeader title="Business health" subtitle="Last 30 days vs the 30 before" action={<Link to="/app/reports" className="text-sm text-muted hover:text-ink">Reports</Link>} />
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 px-5 pt-5 sm:grid-cols-3">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="eyebrow">{r.label}</div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-xl font-semibold tnum">{r.value}</span>
              {'d' in r ? <Delta value={r.d} /> : r.pp !== null && r.pp !== undefined ? (
                <span className={cx('text-xs font-semibold tnum', (r.inverse ? r.pp <= 0 : r.pp >= 0) ? 'text-success' : 'text-danger')}>{r.pp >= 0 ? '↑' : '↓'} {Math.abs(r.pp).toFixed(1)} pts</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className="px-3 pb-4 pt-4">
        {a.series.some((x) => x.revenue_cents > 0) ? (
          <AreaChart ariaLabel="Daily revenue, last 30 days" height={160} data={a.series.map((x) => ({ label: x.date.slice(5).replace('-', '/'), value: x.revenue_cents }))} format={(v) => money(v, { compact: true })} />
        ) : (
          <p className="px-2 py-6 text-center text-sm text-muted">Once your first payment is recorded, daily revenue appears here.</p>
        )}
      </div>
      <div className="border-t border-line px-5 py-4">
        <div className="mb-2 flex justify-between text-sm"><span className="font-medium">Chair utilization</span><span className="tnum">{pct(a.utilization.utilization)} <span className="text-muted">/ {a.utilization.target}% target</span></span></div>
        <Progress value={a.utilization.utilization} target={a.utilization.target} />
      </div>
    </Card>
  )
}

function SetupChecklist() {
  const { ws, can } = useWorkspace()
  const toast = useToast()
  const { data: barbers } = useBarbers(ws.shop_id)
  const { data: services } = useServices(ws.shop_id)
  if (!can('shop.settings') || !barbers || !services) return null
  const steps = [
    { done: services.length > 0, label: 'Create your services', to: '/app/services' },
    { done: barbers.length > 0, label: 'Add your barbers', to: '/app/barbers' },
    { done: ws.is_published, label: 'Publish your booking page', to: '/app/settings/shop' },
  ]
  if (steps.every((s) => s.done)) return null
  const link = `${window.location.origin}/shop/${ws.shop_slug}`
  return (
    <Card className="mb-8 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-semibold">Finish setting up</div>
        <Button size="sm" variant="secondary" icon={<Copy className="size-4" />} onClick={() => { navigator.clipboard?.writeText(link); toast('Booking link copied', 'success') }}>Copy booking link</Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {steps.map((s) => (
          <Link key={s.label} to={s.to} className={cx('inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm', s.done ? 'border-success/30 text-muted line-through' : 'border-line hover:border-accent')}>
            {s.done ? <Check className="size-4 text-success" /> : <Circle className="size-4 text-faint" />} {s.label}
          </Link>
        ))}
      </div>
    </Card>
  )
}

/** Factual one-liner under the greeting — derived from today's real bookings. */
function todayLine(total: number, upcoming: number) {
  if (!total) return 'No appointments on the books yet today.'
  if (upcoming) return `${upcoming} of ${total} appointment${total > 1 ? 's' : ''} still to come today.`
  return `All ${total} of today’s appointment${total > 1 ? 's are' : ' is'} done.`
}
