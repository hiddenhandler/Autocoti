import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CalendarPlus, Check, ChevronRight, Clock, Sparkles, Users, Zap } from 'lucide-react'
import {
  usePublicShop, useSlots, useAvailableDays, useFirstAvailable, ShopNotFound, track, icsHref, loadSavedClient, saveClient,
} from './shared'
import { Avatar, Badge, Button, Card, cx, Field, Input, Skeleton, Spinner, Textarea } from '@/components/ui'
import { money, minutes, relativeDay, time, dateStrLabel, relativeDateStr } from '@/lib/format'
import { addDays, dateInTz, todayInTz, zonedParts } from '@/lib/time'
import { rpc } from '@/lib/supabase'
import { errorCode, friendlyError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import type { PublicShop, Slot } from '@/lib/types'

type Step = 'service' | 'barber' | 'time' | 'details'

export default function BookingFlow() {
  const { slug } = useParams()
  const { data: shop, isLoading } = usePublicShop(slug)
  if (isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (!shop) return <ShopNotFound />
  if (!shop.booking.enabled) return <ShopNotFound>{shop.name} isn't taking online bookings right now.{shop.phone ? ` Call ${shop.phone}.` : ''}</ShopNotFound>
  return <Flow shop={shop} />
}

function Flow({ shop }: { shop: PublicShop }) {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const serviceId = params.get('service')
  const barberParam = params.get('barber') // 'any' | 'first' | uuid
  const timeParam = params.get('time')
  const rebookFrom = params.get('rebook')
  const [done, setDone] = useState<null | { manage_token: string; starts_at: string; barber_id: string; appointment_id: string }>(null)

  const service = shop.services.find((s) => s.id === serviceId)
  const barber = shop.barbers.find((b) => b.id === barberParam) ?? null
  const step: Step = !service ? 'service' : !barberParam ? 'barber' : !timeParam || barberParam === 'first' ? 'time' : 'details'

  useEffect(() => {
    track(shop.id, step === 'service' ? 'service' : step)
  }, [shop.id, step])

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v))
    setParams(next)
    window.scrollTo({ top: 0 })
  }

  const back = () => {
    if (step === 'details') update({ time: null })
    else if (step === 'time') update({ barber: null, time: null, date: null })
    else if (step === 'barber') update({ service: null })
    else nav(`/shop/${shop.slug}`)
  }

  if (done) return <Success shop={shop} result={done} serviceName={service?.name ?? ''} />

  const stepIndex = { service: 0, barber: 1, time: 2, details: 3 }[step]

  return (
    <div className="min-h-dvh pb-24">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-3 px-4">
          <button onClick={back} aria-label="Back" className="-ml-2 rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-ink">
            <ArrowLeft className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{shop.name}</div>
            <div className="text-xs text-muted">Step {stepIndex + 1} of 4</div>
          </div>
        </div>
        <div className="h-0.5 bg-line">
          <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${((stepIndex + 1) / 4) * 100}%` }} />
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-4 pt-6">
        {shop.is_preview && <p className="mb-4 rounded-xl bg-warning/15 px-3 py-2 text-xs font-semibold text-warning">Preview mode — bookings you make here are real.</p>}
        {rebookFrom && step !== 'details' && <p className="mb-4 rounded-xl bg-accent-soft px-3 py-2 text-sm">Booking your next cut ✂️</p>}

        {step === 'service' && (
          <div className="animate-rise">
            <h1 className="display mb-6 text-[40px] leading-none">Choose a service</h1>
            <div className="space-y-3">
              {shop.services.map((s) => (
                <button key={s.id} onClick={() => update({ service: s.id, barber: barberParam && shop.barbers.some((b) => b.id === barberParam) ? barberParam : null })}
                  className="flex w-full items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-5 text-left transition hover:border-accent active:scale-[0.99]">
                  <div className="min-w-0">
                    <div className="text-[17px] font-semibold">{s.name}</div>
                    <div className="mt-1 flex items-center gap-1.5 text-sm text-muted"><Clock className="size-3.5" />{minutes(s.duration_minutes)}{s.description ? ` · ${s.description}` : ''}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[17px] font-semibold tnum">{priceRange(s)}</span>
                    <ChevronRight className="size-5 text-faint" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 'barber' && service && <BarberStep shop={shop} serviceId={service.id} onPick={(b) => update({ barber: b })} />}

        {step === 'time' && service && (
          barberParam === 'first'
            ? <FirstAvailableStep shop={shop} serviceId={service.id} onPick={(s) => update({ barber: s.barber_id, time: s.starts_at, date: dateInTz(s.starts_at, shop.timezone) })} />
            : <TimeStep shop={shop} serviceId={service.id} barberId={barber?.id ?? null} date={params.get('date')}
                onDate={(d) => update({ date: d })} onPick={(s) => update({ time: s.starts_at, date: dateInTz(s.starts_at, shop.timezone) })} />
        )}

        {step === 'details' && service && timeParam && (
          <DetailsStep shop={shop} serviceId={service.id} serviceName={service.name} barber={barber} startsAt={timeParam} rebookFrom={rebookFrom}
            onTaken={() => update({ time: null })} onDone={setDone} />
        )}
      </div>
    </div>
  )
}

function priceRange(s: PublicShop['services'][number]) {
  const lo = s.min_price_cents ?? s.price_cents
  const hi = s.max_price_cents ?? s.price_cents
  return lo !== hi ? `${money(lo)}+` : money(lo)
}

function BarberStep({ shop, serviceId, onPick }: { shop: PublicShop; serviceId: string; onPick: (b: string) => void }) {
  const barbers = shop.barbers.filter((b) => b.services.some((s) => s.service_id === serviceId))
  const { data: first, isLoading } = useFirstAvailable(shop.id, [serviceId])
  const earliest = first?.slice().sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0]
  return (
    <div className="animate-rise">
      <h1 className="display mb-6 text-[40px] leading-none">Who's cutting?</h1>
      <div className="space-y-3">
        <button onClick={() => onPick('first')} className="flex w-full items-center gap-4 rounded-2xl border-2 border-accent bg-accent-soft p-5 text-left transition active:scale-[0.99]">
          <span className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-ink"><Zap className="size-6" /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-semibold">First available</div>
            <div className="text-sm text-muted">
              {isLoading ? 'Checking…' : earliest ? <>Earliest: <b className="text-ink">{relativeDay(earliest.starts_at, shop.timezone)} {time(earliest.starts_at, shop.timezone)}</b></> : 'No openings soon'}
            </div>
          </div>
          <ChevronRight className="size-5 text-faint" />
        </button>
        {shop.booking.allow_any_barber && barbers.length > 1 && (
          <button onClick={() => onPick('any')} className="flex w-full items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left transition hover:border-accent active:scale-[0.99]">
            <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted"><Users className="size-6" /></span>
            <div className="flex-1">
              <div className="text-[17px] font-semibold">Any barber</div>
              <div className="text-sm text-muted">Pick a time, we'll match you</div>
            </div>
            <ChevronRight className="size-5 text-faint" />
          </button>
        )}
        {barbers.map((b) => {
          const bs = b.services.find((s) => s.service_id === serviceId)!
          const next = first?.find((f) => f.barber_id === b.id)
          return (
            <button key={b.id} onClick={() => onPick(b.id)} className="flex w-full items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left transition hover:border-accent active:scale-[0.99]">
              <Avatar name={b.name} src={b.photo_url} size={48} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[17px] font-semibold">
                  {b.name}
                  {b.review_count > 0 && <span className="text-sm font-normal text-muted">★ {Number(b.rating).toFixed(1)}</span>}
                </div>
                <div className="truncate text-sm text-muted">
                  {money(bs.price_cents)} · {minutes(bs.duration_minutes)}
                  {next ? ` · next ${relativeDay(next.starts_at, shop.timezone).toLowerCase()} ${time(next.starts_at, shop.timezone)}` : ' · fully booked'}
                </div>
              </div>
              <ChevronRight className="size-5 text-faint" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FirstAvailableStep({ shop, serviceId, onPick }: { shop: PublicShop; serviceId: string; onPick: (s: Slot) => void }) {
  const { data, isLoading } = useFirstAvailable(shop.id, [serviceId])
  const rows = (data ?? []).slice().sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  return (
    <div className="animate-rise">
      <div className="eyebrow mb-2">First available</div>
      <h1 className="display mb-6 text-[40px] leading-none">Earliest times</h1>
      {isLoading ? <Skeleton className="h-40" /> : rows.length === 0 ? (
        <Card className="p-6 text-center text-muted">No openings in the next two weeks.</Card>
      ) : (
        <div className="space-y-3">
          {rows.map((s, i) => {
            const b = shop.barbers.find((x) => x.id === s.barber_id)!
            return (
              <button key={s.barber_id} onClick={() => onPick(s)}
                className={cx('flex w-full items-center gap-4 rounded-2xl border bg-surface p-5 text-left transition hover:border-accent active:scale-[0.99]', i === 0 ? 'border-accent' : 'border-line')}>
                <Avatar name={b.name} src={b.photo_url} size={44} />
                <div className="flex-1">
                  <div className="font-semibold">{b.name}</div>
                  <div className="text-sm text-muted">{money(s.price_cents)} · {minutes(s.duration_minutes)}</div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold tnum">{time(s.starts_at, shop.timezone)}</div>
                  <div className="text-xs text-muted">{relativeDay(s.starts_at, shop.timezone)}</div>
                </div>
                {i === 0 && <Badge tone="accent" className="hidden sm:inline-flex">Soonest</Badge>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TimeStep({ shop, serviceId, barberId, date, onDate, onPick }: {
  shop: PublicShop; serviceId: string; barberId: string | null; date: string | null; onDate: (d: string) => void; onPick: (s: Slot) => void
}) {
  const today = todayInTz(shop.timezone)
  const horizon = Math.min(shop.booking.max_advance_days, 28)
  const { data: days, isLoading: daysLoading } = useAvailableDays(shop.id, [serviceId], today, horizon, barberId)
  const firstDay = days?.[0]?.day ?? today
  const selected = date ?? (daysLoading ? null : firstDay)
  const { data: slots, isLoading, isFetching } = useSlots(shop.id, [serviceId], selected, barberId)
  const [waitlist, setWaitlist] = useState(false)
  const counts = new Map((days ?? []).map((d) => [d.day, d.slots]))
  const barber = shop.barbers.find((b) => b.id === barberId)

  // "Any barber": one button per distinct time (the server assigns a barber).
  const times = useMemo(() => {
    const m = new Map<string, Slot>()
    for (const s of slots ?? []) if (!m.has(s.starts_at)) m.set(s.starts_at, s)
    return [...m.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  }, [slots])
  const groups = [
    { label: 'Morning', items: times.filter((t) => zonedParts(t.starts_at, shop.timezone).hour < 12) },
    { label: 'Afternoon', items: times.filter((t) => { const h = zonedParts(t.starts_at, shop.timezone).hour; return h >= 12 && h < 17 }) },
    { label: 'Evening', items: times.filter((t) => zonedParts(t.starts_at, shop.timezone).hour >= 17) },
  ].filter((g) => g.items.length)

  return (
    <div className="animate-rise">
      <h1 className="display mb-1 text-[40px] leading-none">Pick a time</h1>
      <p className="mb-6 text-sm text-muted">{barber ? `with ${barber.name}` : 'with any available barber'}</p>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-2">
        {Array.from({ length: horizon }, (_, i) => addDays(today, i)).map((d) => {
          const n = counts.get(d) ?? 0
          const active = d === selected
          return (
            <button key={d} onClick={() => onDate(d)} disabled={!daysLoading && n === 0}
              className={cx('flex w-[62px] shrink-0 flex-col items-center rounded-2xl border py-2.5 transition', active ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface', !daysLoading && n === 0 && !active && 'opacity-35')}>
              <span className="text-[11px] font-semibold uppercase">{d === today ? 'Today' : dateStrLabel(d, { weekday: 'short' })}</span>
              <span className="text-xl font-semibold tnum">{Number(d.slice(8))}</span>
              <span className={cx('mt-0.5 size-1.5 rounded-full', n > 0 ? (active ? 'bg-accent-ink' : 'bg-accent') : 'bg-transparent')} />
            </button>
          )
        })}
      </div>

      <div className="mt-6 min-h-[200px]">
        {isLoading || !selected ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : times.length === 0 ? (
          <Card className="p-6 text-center">
            <div className="font-semibold">Nothing open {relativeDateStr(selected, shop.timezone).toLowerCase()}</div>
            {days && days.length > 0 && (
              <Button variant="secondary" className="mt-4" onClick={() => onDate(days[0].day)}>Next available: {relativeDateStr(days[0].day, shop.timezone)}</Button>
            )}
            {shop.booking.waitlist_enabled && (
              <div className="mt-4">
                <Button variant="ghost" onClick={() => setWaitlist(true)}>Join the waitlist for {relativeDateStr(selected, shop.timezone).toLowerCase()}</Button>
              </div>
            )}
          </Card>
        ) : (
          <div className={cx('space-y-6 transition-opacity', isFetching && 'opacity-70')}>
            {groups.map((g) => (
              <div key={g.label}>
                <div className="eyebrow mb-2.5">{g.label}</div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {g.items.map((s) => (
                    <button key={s.starts_at} onClick={() => onPick(s)}
                      className="h-12 rounded-xl border border-line bg-surface text-[15px] font-semibold tnum transition hover:border-accent hover:bg-accent-soft active:scale-95">
                      {time(s.starts_at, shop.timezone)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {shop.booking.waitlist_enabled && (
              <button onClick={() => setWaitlist(true)} className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">Don't see a time that works? Join the waitlist</button>
            )}
          </div>
        )}
      </div>
      {waitlist && selected && <WaitlistForm shop={shop} serviceId={serviceId} barberId={barberId} date={selected} onClose={() => setWaitlist(false)} />}
    </div>
  )
}

function WaitlistForm({ shop, serviceId, barberId, date, onClose }: { shop: PublicShop; serviceId: string; barberId: string | null; date: string; onClose: () => void }) {
  const saved = loadSavedClient()
  const [form, setForm] = useState({ first_name: saved?.first_name ?? '', phone: saved?.phone ?? '', email: saved?.email ?? '', from: '09:00', to: '20:00' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await rpc<{ token: string }>('join_waitlist', {
        p_shop_id: shop.id, p_service_id: serviceId, p_date: date, p_barber_id: barberId,
        p_time_from: form.from, p_time_to: form.to,
        p_client: { first_name: form.first_name, phone: form.phone, email: form.email },
      })
      setToken(r.token)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="animate-rise mt-6 p-5">
      {token ? (
        <div>
          <div className="flex items-center gap-2 font-semibold"><Check className="size-5 text-success" /> You're on the waitlist</div>
          <p className="mt-2 text-sm text-muted">If a spot opens on {dateStrLabel(date)} between {form.from} and {form.to}, we'll email you a link. First to claim it gets it.</p>
          <Link to={`/w/${token}`} className="mt-3 inline-block text-sm font-semibold underline-offset-4 hover:underline">View my waitlist spot</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div className="font-semibold">Join the waitlist · {dateStrLabel(date)}</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Earliest"><Input type="time" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></Field>
            <Field label="Latest"><Input type="time" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></Field>
          </div>
          <Field label="Name"><Input required value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone"><Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Email"><Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>Join waitlist</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      )}
    </Card>
  )
}

function DetailsStep({ shop, serviceId, serviceName, barber, startsAt, rebookFrom, onTaken, onDone }: {
  shop: PublicShop; serviceId: string; serviceName: string; barber: PublicShop['barbers'][number] | null; startsAt: string; rebookFrom: string | null
  onTaken: () => void; onDone: (r: { manage_token: string; starts_at: string; barber_id: string; appointment_id: string }) => void
}) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const saved = loadSavedClient()
  const [form, setForm] = useState({
    first_name: saved?.first_name ?? (user?.user_metadata?.full_name?.split(' ')[0] ?? ''),
    last_name: saved?.last_name ?? (user?.user_metadata?.full_name?.split(' ').slice(1).join(' ') ?? ''),
    phone: saved?.phone ?? '',
    email: saved?.email ?? user?.email ?? '',
    message: '',
    marketing_opt_in: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bs = barber?.services.find((s) => s.service_id === serviceId)
  const svc = shop.services.find((s) => s.id === serviceId)!
  const price = bs?.price_cents ?? svc.min_price_cents ?? svc.price_cents
  const duration = bs?.duration_minutes ?? svc.duration_minutes

  useEffect(() => track(shop.id, 'details'), [shop.id])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await rpc<{ manage_token: string; starts_at: string; barber_id: string; appointment_id: string }>('book_appointment', {
        p_shop_id: shop.id,
        p_service_ids: [serviceId],
        p_starts_at: startsAt,
        p_barber_id: barber?.id ?? null,
        p_client: { first_name: form.first_name, last_name: form.last_name, phone: form.phone, email: form.email, marketing_opt_in: form.marketing_opt_in },
        p_message: form.message || null,
        p_rebooked_from: rebookFrom,
      })
      saveClient({ first_name: form.first_name, last_name: form.last_name, phone: form.phone, email: form.email })
      track(shop.id, 'booked')
      qc.invalidateQueries({ queryKey: ['slots'] })
      onDone(r)
    } catch (err) {
      if (errorCode(err) === 'SLOT_TAKEN') {
        qc.invalidateQueries({ queryKey: ['slots'] })
        qc.invalidateQueries({ queryKey: ['days'] })
        setError(friendlyError(err))
        setTimeout(onTaken, 1400)
      } else setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="animate-rise">
      <h1 className="display mb-6 text-[40px] leading-none">Almost done</h1>
      <Card className="mb-6 p-5">
        <div className="flex items-start gap-4">
          {barber ? <Avatar name={barber.name} src={barber.photo_url} size={48} /> : <span className="flex size-12 items-center justify-center rounded-full bg-surface-2"><Users className="size-5 text-muted" /></span>}
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-semibold">{serviceName}</div>
            <div className="text-sm text-muted">{barber ? `with ${barber.name}` : 'Any available barber'}</div>
            <div className="mt-2 text-[15px] font-semibold">{relativeDay(startsAt, shop.timezone)}, {time(startsAt, shop.timezone)}</div>
            <div className="text-sm text-muted">{minutes(duration)}</div>
          </div>
          <div className="text-xl font-semibold tnum">{money(price)}</div>
        </div>
      </Card>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name"><Input required autoComplete="given-name" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></Field>
          <Field label="Last name"><Input autoComplete="family-name" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></Field>
        </div>
        <Field label={`Phone${shop.booking.require_phone ? '' : ' (optional)'}`}>
          <Input type="tel" required={shop.booking.require_phone} autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label={`Email${shop.booking.require_email ? '' : ' (for confirmation & reminders)'}`}>
          <Input type="email" required={shop.booking.require_email} autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Anything your barber should know? (optional)">
          <Textarea rows={2} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="e.g. skin fade, keep length on top" />
        </Field>
        <label className="flex items-start gap-3 text-sm text-muted">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={form.marketing_opt_in} onChange={(e) => setForm({ ...form, marketing_opt_in: e.target.checked })} />
          Remind me when I'm due for my next cut and send occasional offers.
        </label>
      </div>

      {(shop.booking.cancellation_policy_text || shop.booking.late_cancel_fee_cents > 0 || shop.booking.no_show_fee_cents > 0) && (
        <div className="mt-6 rounded-xl bg-surface-2 p-4 text-[13px] text-muted">
          <div className="mb-1 font-semibold text-ink">Cancellation policy</div>
          {shop.booking.cancellation_policy_text ??
            `Free cancellation up to ${shop.booking.cancellation_window_hours} hours before.${shop.booking.late_cancel_fee_cents ? ` Later cancellations: ${money(shop.booking.late_cancel_fee_cents)}.` : ''}${shop.booking.no_show_fee_cents ? ` No-shows: ${money(shop.booking.no_show_fee_cents)}.` : ''}`}
        </div>
      )}

      {error && <p className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger" role="alert">{error}</p>}

      <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-line bg-surface/95 p-3 backdrop-blur-md sm:static sm:mt-8 sm:border-0 sm:bg-transparent sm:p-0">
        <div className="mx-auto max-w-2xl">
          <Button type="submit" size="xl" block loading={busy}>Confirm booking · {money(price)}</Button>
        </div>
      </div>
    </form>
  )
}

function Success({ shop, result, serviceName }: { shop: PublicShop; result: { manage_token: string; starts_at: string; barber_id: string }; serviceName: string }) {
  const { user } = useAuth()
  const barber = shop.barbers.find((b) => b.id === result.barber_id)
  const svc = shop.services.find((s) => s.name === serviceName)
  const end = new Date(new Date(result.starts_at).getTime() + (svc?.duration_minutes ?? 30) * 60000).toISOString()
  const addr = [shop.address.line1, shop.address.city].filter(Boolean).join(', ')
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-12 text-center">
      <div className="animate-rise mx-auto flex size-20 items-center justify-center rounded-full bg-accent text-accent-ink"><Check className="size-10" strokeWidth={2.5} /></div>
      <h1 className="display animate-rise mt-8 text-5xl">You're booked.</h1>
      <p className="mt-3 text-muted">
        {serviceName} with <b className="text-ink">{barber?.name}</b><br />
        {relativeDay(result.starts_at, shop.timezone)} at {time(result.starts_at, shop.timezone)}
      </p>
      {addr && <p className="mt-1 text-sm text-muted">{shop.name} · {addr}</p>}
      <div className="mt-8 grid gap-2">
        <a href={icsHref({ title: `${serviceName} — ${shop.name}`, start: result.starts_at, end, location: addr })} download="appointment.ics">
          <Button variant="secondary" size="lg" block icon={<CalendarPlus className="size-4" />}>Add to calendar</Button>
        </a>
        <Link to={`/a/${result.manage_token}`}><Button variant="ghost" block>Reschedule or cancel</Button></Link>
      </div>
      {!user && (
        <Card className="mt-8 p-5 text-left">
          <div className="flex items-center gap-2 font-semibold"><Sparkles className="size-4 text-accent" /> Rebook in one tap next time</div>
          <p className="mt-1 text-sm text-muted">Create a free account to see your cuts, save your barber and book again instantly.</p>
          <Link to="/signup?intent=client&next=/me"><Button size="sm" className="mt-3">Create account</Button></Link>
        </Card>
      )}
    </div>
  )
}
