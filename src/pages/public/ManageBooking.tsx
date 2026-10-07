import { TimeGrid } from '@/components/TimeGrid'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, Check, CheckCircle2, MapPin, Scissors, Star } from 'lucide-react'
import { rpc } from '@/lib/supabase'
import { useAccent, useSlots, useAvailableDays, icsHref } from './shared'
import { Badge, Button, Card, cx, Spinner, StatusBadge, Textarea } from '@/components/ui'
import { money, relativeDay, time, dateStrLabel } from '@/lib/format'
import { addDays, todayInTz } from '@/lib/time'
import { friendlyError } from '@/lib/errors'
import { Elapsed, LivePill, liveLines } from '@/components/live'
import type { BarberLive } from '@/lib/types'

interface Booking {
  id: string
  status: string
  starts_at: string
  ends_at: string
  shop_id: string
  barber_id: string
  timezone: string
  accent_color: string
  service_ids: string[]
  service_name: string
  barber_name: string
  shop_name: string
  shop_slug: string
  shop_phone: string | null
  address: string
  price_cents: number
  currency: string
  can_cancel: boolean
  can_reschedule: boolean
  is_late: boolean
  cancellation_window_hours: number
  late_cancel_fee_cents: number
  cancellation_policy_text: string | null
  review_token: string | null
  duration_minutes: number
  actual_started_at: string | null
  actual_finished_at: string | null
  estimated_finish: string | null
  barber_photo_url: string | null
  barber_live: BarberLive | null
  rebook_weeks: number | null
}

const LIVE_STATES = ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE']

export default function ManageBooking() {
  const { token } = useParams()
  const [params] = useSearchParams()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>('view')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [currentToken, setCurrentToken] = useState(token)
  const { data: b, isLoading } = useQuery({
    queryKey: ['booking', currentToken],
    // Live while it matters: confirmed → cut in progress → completed.
    refetchInterval: (q) => {
      const d = q.state.data as Booking | null | undefined
      if (!d || !LIVE_STATES.includes(d.status)) return false
      return new Date(d.starts_at).getTime() - Date.now() < 3 * 3600e3 ? 15_000 : 120_000
    },
    refetchOnWindowFocus: true,
    queryFn: () => rpc<Booking | null>('get_booking', { p_token: currentToken }),
  })
  useAccent(b?.accent_color)

  // One-tap confirm from the reminder email.
  useEffect(() => {
    if (params.get('confirm') && b?.status === 'BOOKED') {
      rpc('confirm_booking', { p_token: currentToken }).then(() => {
        setMsg('Thanks — your appointment is confirmed.')
        qc.invalidateQueries({ queryKey: ['booking', currentToken] })
      })
    }
  }, [params, b?.status, currentToken, qc])

  if (isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (!b) return <div className="flex min-h-dvh items-center justify-center p-6 text-center text-muted">This booking link is not valid.</div>

  const cancel = async (reason: string) => {
    setBusy(true)
    try {
      const r = await rpc<{ late: boolean; fee_cents: number }>('cancel_booking', { p_token: currentToken, p_reason: reason })
      setMsg(r.late && r.fee_cents ? `Cancelled. A late-cancellation fee of ${money(r.fee_cents, { currency: b.currency })} applies per the shop's policy.` : 'Your appointment was cancelled.')
      setMode('view')
      qc.invalidateQueries({ queryKey: ['booking', currentToken] })
    } catch (e) {
      setMsg(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto min-h-dvh max-w-md px-5 py-10">
      <div className="eyebrow">{b.shop_name}</div>
      <h1 className="display mt-2 text-5xl">Your appointment</h1>
      {msg && <p className="animate-rise mt-5 flex items-center gap-2 rounded-xl bg-accent-soft px-4 py-3 text-sm"><Check className="size-4 text-accent" />{msg}</p>}
      <LiveState b={b} />
      <Card className="mt-4 p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xl font-semibold">{b.service_name}</div>
            <div className="text-muted">with {b.barber_name}</div>
          </div>
          <StatusBadge status={b.status} />
        </div>
        <div className="mt-5 text-2xl font-semibold">{relativeDay(b.starts_at, b.timezone)}, {time(b.starts_at, b.timezone)}</div>
        <div className="mt-1 text-sm text-muted">{money(b.price_cents, { currency: b.currency })}</div>
        {b.address && <div className="mt-4 flex items-center gap-1.5 text-sm text-muted"><MapPin className="size-4" />{b.address}</div>}
        {['BOOKED', 'CONFIRMED'].includes(b.status) && (
          <a className="mt-5 block" href={icsHref({ title: `${b.service_name} — ${b.shop_name}`, start: b.starts_at, end: b.ends_at, location: b.address })} download="appointment.ics">
            <Button variant="secondary" block icon={<CalendarPlus className="size-4" />}>Add to calendar</Button>
          </a>
        )}
      </Card>

      {b.review_token && (
        <Link to={`/r/${b.review_token}`}>
          <Card className="mt-4 flex items-center gap-3 p-5 transition hover:border-accent">
            <Star className="size-5 text-accent" />
            <div className="flex-1 font-semibold">How was your cut? Leave a review</div>
          </Card>
        </Link>
      )}

      {mode === 'view' && (
        <div className="mt-6 grid gap-2">
          {b.status === 'BOOKED' && b.can_cancel && (
            <Button size="lg" block onClick={async () => { await rpc('confirm_booking', { p_token: currentToken }); qc.invalidateQueries({ queryKey: ['booking', currentToken] }); setMsg('Confirmed — see you then.') }}>
              Confirm I'm coming
            </Button>
          )}
          {b.can_reschedule && <Button variant="secondary" size="lg" block onClick={() => setMode('reschedule')}>Reschedule</Button>}
          {b.can_cancel && <Button variant="ghost" size="lg" block onClick={() => setMode('cancel')}>Cancel appointment</Button>}
          {['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(b.status) && (
            <>
              {b.status === 'COMPLETED' && b.rebook_weeks && (
                <p className="mb-1 text-center text-sm text-muted">Your next cut is usually due in about <b className="text-ink">{b.rebook_weeks} week{b.rebook_weeks === 1 ? '' : 's'}</b>.</p>
              )}
              <Link to={`/shop/${b.shop_slug}/book?service=${b.service_ids?.[0] ?? ''}&barber=${b.barber_id}&rebook=${b.id}`}>
                <Button size="lg" block>BOOK AGAIN WITH {b.barber_name.split(' ')[0].toUpperCase()}</Button>
              </Link>
            </>
          )}
          {!b.can_cancel && ['BOOKED', 'CONFIRMED'].includes(b.status) && b.shop_phone && (
            <p className="text-center text-sm text-muted">Need to change it? Call <a className="font-semibold text-ink" href={`tel:${b.shop_phone}`}>{b.shop_phone}</a></p>
          )}
        </div>
      )}

      {mode === 'cancel' && <CancelBox b={b} busy={busy} onCancel={cancel} onBack={() => setMode('view')} />}
      {mode === 'reschedule' && (
        <Reschedule b={b} token={currentToken!} onDone={(newToken, startsAt) => {
          setCurrentToken(newToken)
          window.history.replaceState(null, '', `/a/${newToken}`)
          setMsg(`Moved to ${relativeDay(startsAt, b.timezone)} at ${time(startsAt, b.timezone)}.`)
          setMode('view')
        }} onBack={() => setMode('view')} />
      )}
    </div>
  )
}

function CancelBox({ b, busy, onCancel, onBack }: { b: Booking; busy: boolean; onCancel: (r: string) => void; onBack: () => void }) {
  const [reason, setReason] = useState('')
  return (
    <Card className="animate-rise mt-6 p-5">
      <div className="font-semibold">Cancel this appointment?</div>
      {b.is_late && b.late_cancel_fee_cents > 0 ? (
        <p className="mt-2 rounded-lg bg-warning/14 px-3 py-2 text-sm text-warning">
          It's less than {b.cancellation_window_hours} hours away, so a {money(b.late_cancel_fee_cents, { currency: b.currency })} late-cancellation fee applies.
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted">No charge — you're outside the {b.cancellation_window_hours}-hour window.</p>
      )}
      <Textarea className="mt-3" rows={2} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="mt-3 flex gap-2">
        <Button variant="danger" loading={busy} onClick={() => onCancel(reason)}>Yes, cancel</Button>
        <Button variant="ghost" onClick={onBack}>Keep it</Button>
      </div>
    </Card>
  )
}

function Reschedule({ b, token, onDone, onBack }: { b: Booking; token: string; onDone: (token: string, startsAt: string) => void; onBack: () => void }) {
  const today = todayInTz(b.timezone)
  const { data: days } = useAvailableDays(b.shop_id, b.service_ids ?? [], today, 21, b.barber_id)
  const [date, setDate] = useState<string | null>(null)
  const selected = date ?? days?.[0]?.day ?? null
  const { data: slots, isLoading } = useSlots(b.shop_id, b.service_ids ?? [], selected, b.barber_id)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const counts = useMemo(() => new Map((days ?? []).map((d) => [d.day, d.slots])), [days])

  const pick = async (startsAt: string) => {
    setBusy(startsAt)
    setError(null)
    try {
      const r = await rpc<{ manage_token: string; starts_at: string }>('reschedule_booking', { p_token: token, p_new_start: startsAt })
      onDone(r.manage_token, r.starts_at)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="animate-rise mt-6 p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-semibold">New time with {b.barber_name}</div>
        <button onClick={onBack} className="text-sm text-muted hover:text-ink">Cancel</button>
      </div>
      <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-2">
        {Array.from({ length: 21 }, (_, i) => addDays(today, i)).map((d) => (
          <button key={d} onClick={() => setDate(d)} disabled={!counts.get(d)}
            className={cx('w-14 shrink-0 rounded-xl border py-2 text-center', d === selected ? 'border-accent bg-accent text-accent-ink' : 'border-line', !counts.get(d) && d !== selected && 'opacity-35')}>
            <div className="text-[10px] font-semibold uppercase">{dateStrLabel(d, { weekday: 'short' })}</div>
            <div className="text-lg font-semibold">{Number(d.slice(8))}</div>
          </button>
        ))}
      </div>
      <div className="mt-4">
        <TimeGrid slots={slots} loading={isLoading} timezone={b.timezone} onPick={(s) => pick(s.starts_at)} busy={busy} dedupe
          empty={<p className="py-4 text-center text-sm text-muted">No times this day</p>} />
      </div>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <Badge className="mt-4">Your current slot is released only when the new one is confirmed</Badge>
    </Card>
  )
}

/** Big live status block: CONFIRMED · CUT IN PROGRESS (ticking) · COMPLETED. */
function LiveState({ b }: { b: Booking }) {
  const tz = b.timezone
  if (b.status === 'IN_SERVICE' && b.actual_started_at) {
    return (
      <Card className="animate-rise mt-6 border-success/40 p-6 text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-success/15 text-success"><Scissors className="size-6" /></span>
        <div className="mt-3 text-sm font-bold tracking-[0.16em] text-success">✂️ CUT IN PROGRESS</div>
        <div className="mt-3 text-5xl font-bold"><Elapsed startedAt={b.actual_started_at} /></div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div><div className="text-muted">Started</div><div className="font-semibold">{time(b.actual_started_at, tz)}</div></div>
          <div><div className="text-muted">Estimated completion</div><div className="font-semibold">{b.estimated_finish ? time(b.estimated_finish, tz) : '—'}</div></div>
        </div>
      </Card>
    )
  }
  if (b.status === 'COMPLETED') {
    return (
      <Card className="animate-rise mt-6 p-6 text-center">
        <CheckCircle2 className="mx-auto size-10 text-success" />
        <div className="mt-2 text-sm font-bold tracking-[0.16em] text-success">✅ COMPLETED</div>
        {b.actual_started_at && b.actual_finished_at && (
          <div className="mt-1 text-sm text-muted">{Math.round((new Date(b.actual_finished_at).getTime() - new Date(b.actual_started_at).getTime()) / 60000)} min with {b.barber_name}</div>
        )}
      </Card>
    )
  }
  if (!['BOOKED', 'CONFIRMED', 'CHECKED_IN'].includes(b.status)) return null
  const bl = b.barber_live
  const label = b.status === 'CHECKED_IN' ? '🟢 CHECKED IN' : b.status === 'CONFIRMED' ? '🟢 CONFIRMED' : '🟢 BOOKED'
  return (
    <Card className="mt-6 p-5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold tracking-[0.16em] text-success">{label}</div>
        <div className="text-sm text-muted">{b.duration_minutes} min</div>
      </div>
      {bl && (
        <div className="mt-3 rounded-xl bg-surface-2 px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{b.barber_name} right now</span><LivePill status={bl.status} size="sm" /></div>
          {liveLines(bl, tz).map((l) => <div key={l} className="mt-0.5 text-muted">{l}</div>)}
          {bl.status === 'CUTTING' && bl.until && new Date(bl.until) > new Date(b.starts_at) && (
            <div className="mt-1 font-medium text-warning">Running about {Math.round((new Date(bl.until).getTime() - new Date(b.starts_at).getTime()) / 60000)} min behind</div>
          )}
        </div>
      )}
    </Card>
  )
}
