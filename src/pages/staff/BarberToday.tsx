import { useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Ban, Clock, DoorOpen, Play, Plus, Square, UserPlus } from 'lucide-react'
import { useWorkspace, useAuth } from '@/lib/auth'
import { useAnalytics, useAppointments } from '@/lib/api'
import { rpc } from '@/lib/supabase'
import { addDays, todayInTz, zonedToUtc } from '@/lib/time'
import { fullName, greeting, minutes, money, time } from '@/lib/format'
import type { Appointment } from '@/lib/types'
import {
  AppointmentSheet, BlockTimeSheet, CheckoutSheet, CutTimer, NewAppointmentSheet, RebookSheet, scheduledMinutes, serviceLabel, useInvalidateCalendar,
} from '@/components/appointments'
import { Avatar, Badge, Button, Card, cx, EmptyState, Skeleton, StatusBadge, StatusDot, useToast } from '@/components/ui'
import { friendlyError } from '@/lib/errors'

export default function BarberToday() {
  const { ws } = useWorkspace()
  if (!ws.barber_id) return <Navigate to="/app/calendar" replace />
  return <Today barberId={ws.barber_id} />
}

function Today({ barberId }: { barberId: string }) {
  const { ws, hasFeature } = useWorkspace()
  const { user } = useAuth()
  const toast = useToast()
  const invalidate = useInvalidateCalendar()
  const tz = ws.timezone
  const today = todayInTz(tz)
  const from = zonedToUtc(today, '00:00', tz).toISOString()
  const to = zonedToUtc(addDays(today, 1), '00:00', tz).toISOString()
  const { data: appts, isLoading } = useAppointments(ws.shop_id, from, to, { barberId, includeCancelled: false })
  const { data: stats } = useAnalytics(ws.shop_id, today, today, barberId)
  const { data: queue } = useQuery({
    queryKey: ['walk_ins', ws.shop_id, 'queue'],
    enabled: hasFeature('walk_ins'),
    refetchInterval: 30_000,
    queryFn: () => rpc<{ id: string; name: string; preferred_barber_id: string | null; likely_barber_id: string | null; service_name: string | null; estimated_wait_minutes: number | null; status: string }[]>('walk_in_queue', { p_shop_id: ws.shop_id }),
  })
  const [selected, setSelected] = useState<Appointment | null>(null)
  const [checkout, setCheckout] = useState<Appointment | null>(null)
  const [rebook, setRebook] = useState<Appointment | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [blockOpen, setBlockOpen] = useState(false)

  const list = useMemo(() => (appts ?? []).filter((a) => a.status !== 'NO_SHOW' || true), [appts])
  const clientAppts = list.filter((a) => a.kind === 'appointment')
  const inChair = clientAppts.find((a) => a.status === 'IN_SERVICE')
  const upcoming = clientAppts.filter((a) => ['BOOKED', 'CONFIRMED', 'CHECKED_IN'].includes(a.status)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const next = upcoming[0]
  const unpaid = clientAppts.filter((a) => a.status === 'COMPLETED' && a.payment_status === 'UNPAID')
  const myQueue = (queue ?? []).filter((w) => w.status === 'waiting' && (!w.preferred_barber_id || w.preferred_barber_id === barberId))
  const me = stats?.barbers.find((b) => b.barber_id === barberId)

  const run = async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key)
    try {
      await fn()
      invalidate()
      after?.()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="eyebrow">{new Date().toLocaleDateString(undefined, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <h1 className="display mt-1 text-[40px] leading-none">{greeting(tz)}{user?.user_metadata?.full_name ? `, ${user.user_metadata.full_name.split(' ')[0]}` : ''}.</h1>
        </div>
      </div>

      {/* NOW / NEXT */}
      {isLoading ? (
        <Skeleton className="h-64" />
      ) : inChair ? (
        <Card className="animate-rise overflow-hidden border-success/40 p-6 text-center">
          <Badge tone="success">In chair</Badge>
          <div className="mt-3 text-2xl font-semibold">{fullName(inChair.client)}</div>
          <div className="text-muted">{serviceLabel(inChair)}</div>
          <div className="my-6"><CutTimer startedAt={inChair.actual_started_at!} scheduledMinutes={scheduledMinutes(inChair)} /></div>
          <Button size="xl" block icon={<Square className="size-5" />} loading={busy === 'finish'}
            onClick={() => run('finish', () => rpc('finish_cut', { p_appointment_id: inChair.id }), () => setCheckout(inChair))}>
            FINISH CUT
          </Button>
        </Card>
      ) : next ? (
        <Card className="animate-rise p-6">
          <div className="flex items-center justify-between">
            <div className="eyebrow">Next client</div>
            <NextIn startsAt={next.starts_at} />
          </div>
          <button className="mt-4 flex w-full items-center gap-4 text-left" onClick={() => setSelected(next)}>
            <Avatar name={fullName(next.client)} size={56} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-2xl font-semibold">{fullName(next.client)}</div>
              <div className="text-muted">{serviceLabel(next)} · {minutes(scheduledMinutes(next))} · {money(next.expected_price_cents)}</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-semibold tnum">{time(next.starts_at, tz)}</div>
              <StatusBadge status={next.status} />
            </div>
          </button>
          {(next.notes || next.client_message) && <p className="mt-4 rounded-xl bg-surface-2 p-3 text-sm">{next.client_message ?? next.notes}</p>}
          <div className="mt-6 grid gap-2">
            <Button size="xl" block icon={<Play className="size-5" />} loading={busy === 'start'} onClick={() => run('start', () => rpc('start_cut', { p_appointment_id: next.id }))}>
              START CUT
            </Button>
            <div className="grid grid-cols-2 gap-2">
              {next.status !== 'CHECKED_IN' && <Button variant="secondary" loading={busy === 'checkin'} onClick={() => run('checkin', () => rpc('set_appointment_status', { p_appointment_id: next.id, p_status: 'CHECKED_IN' }))}>Check in</Button>}
              <Button variant="ghost" className={next.status === 'CHECKED_IN' ? 'col-span-2' : ''} onClick={() => setSelected(next)}>More</Button>
            </div>
          </div>
        </Card>
      ) : (
        <Card className="p-2">
          <EmptyState icon={<Clock className="size-6" />} title="No more clients booked today" body={myQueue.length ? 'There are walk-ins waiting.' : 'Enjoy the breather — or take a walk-in.'} />
        </Card>
      )}

      {/* Walk-in queue */}
      {myQueue.length > 0 && !inChair && (
        <Card className="mt-4 flex items-center gap-4 p-4">
          <span className="flex size-10 items-center justify-center rounded-full bg-info/15 text-info"><DoorOpen className="size-5" /></span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{myQueue.length} walk-in{myQueue.length > 1 ? 's' : ''} waiting</div>
            <div className="truncate text-sm text-muted">Next: {myQueue[0].name}{myQueue[0].service_name ? ` · ${myQueue[0].service_name}` : ''}</div>
          </div>
          <Button loading={busy === 'walkin'} onClick={() => run('walkin', () => rpc('call_next_walk_in', { p_barber_id: barberId }), () => toast(`${myQueue[0].name} is in your chair`, 'success'))}>NEXT CLIENT</Button>
        </Card>
      )}

      {unpaid.length > 0 && (
        <Card className="mt-4 border-warning/40 p-4">
          <div className="text-sm font-semibold text-warning">{unpaid.length} finished cut{unpaid.length > 1 ? 's' : ''} without payment</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {unpaid.map((a) => <Button key={a.id} size="sm" variant="secondary" onClick={() => setCheckout(a)}>{fullName(a.client)} · {time(a.starts_at, tz)}</Button>)}
          </div>
        </Card>
      )}

      {/* Today stats */}
      <div className="mt-6 grid grid-cols-4 gap-2">
        <MiniStat label="Cuts" value={me?.cuts ?? 0} />
        <MiniStat label="Revenue" value={money(me?.net_revenue_cents ?? 0, { cents: false })} />
        <MiniStat label="Tips" value={money(me?.tips_cents ?? 0, { cents: false })} />
        <MiniStat label="Avg cut" value={me?.avg_cut_minutes ? `${Math.round(me.avg_cut_minutes)}m` : '—'} />
      </div>

      {/* Day timeline */}
      <div className="mb-3 mt-8 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Today</h2>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" icon={<Ban className="size-4" />} onClick={() => setBlockOpen(true)}>Block</Button>
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)}>Add</Button>
        </div>
      </div>
      {list.length === 0 && !isLoading ? (
        <Card><EmptyState icon={<UserPlus className="size-6" />} title="Nothing on the books today" body="New online bookings show up here instantly." /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {list.map((a) => {
            const done = ['COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(a.status)
            return (
              <button key={a.id} onClick={() => setSelected(a)} className={cx('flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2', done && 'opacity-55')}>
                <div className="w-16 shrink-0 text-sm font-semibold tnum">{time(a.starts_at, tz)}</div>
                <StatusDot status={a.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.kind === 'appointment' ? fullName(a.client) : serviceLabel(a)}</div>
                  <div className="truncate text-xs text-muted">{a.kind === 'appointment' ? `${serviceLabel(a)} · ${minutes(scheduledMinutes(a))}` : `${minutes(scheduledMinutes(a))}`}</div>
                </div>
                {a.kind === 'appointment' && (
                  <div className="text-right text-sm">
                    <div className="font-semibold tnum">{money(a.expected_price_cents)}</div>
                    {a.status === 'COMPLETED' && <div className={cx('text-[11px] font-semibold', a.payment_status === 'PAID' ? 'text-success' : 'text-warning')}>{a.payment_status}</div>}
                    {a.status === 'IN_SERVICE' && a.actual_started_at && <CutTimer size="sm" startedAt={a.actual_started_at} scheduledMinutes={scheduledMinutes(a)} />}
                  </div>
                )}
              </button>
            )
          })}
        </Card>
      )}
      <div className="mt-4 text-center">
        <Link to="/app/calendar" className="text-sm text-muted hover:text-ink">Open full calendar →</Link>
      </div>

      <AppointmentSheet appt={selected} onClose={() => setSelected(null)} />
      {checkout && <CheckoutSheet appt={checkout} onClose={() => setCheckout(null)} onPaid={() => { const a = checkout; setCheckout(null); if (a.client_id) setRebook(a) }} />}
      {rebook && <RebookSheet appt={rebook} onClose={() => setRebook(null)} />}
      <NewAppointmentSheet open={newOpen} onClose={() => setNewOpen(false)} defaults={{ barberId }} />
      <BlockTimeSheet open={blockOpen} onClose={() => setBlockOpen(false)} defaults={{ barberId }} />
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card className="px-3 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tnum">{value}</div>
    </Card>
  )
}

function NextIn({ startsAt }: { startsAt: string }) {
  const mins = Math.round((new Date(startsAt).getTime() - Date.now()) / 60000)
  if (mins <= 0) return <Badge tone={mins < -10 ? 'danger' : 'warning'}>{mins < -1 ? `${-mins} min late` : 'Now'}</Badge>
  return <Badge tone="accent">in {mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`}</Badge>
}
