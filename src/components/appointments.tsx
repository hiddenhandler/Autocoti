import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Check, CircleSlash, MessageSquare, Phone, Play, Plus, RotateCcw, Square, Trash2, UserCheck, X } from 'lucide-react'
import { rpc, supabase } from '@/lib/supabase'
import { useWorkspace } from '@/lib/auth'
import { useBarbers, useServices, useBarberServices } from '@/lib/api'
import type { Appointment, ClientRow, PaymentMethod, Slot } from '@/lib/types'
import { clock, dateStrLabel, fullName, minutes, money, parseMoney, relativeDay, time } from '@/lib/format'
import { addDays, dateInTz, todayInTz, zonedToUtc } from '@/lib/time'
import { friendlyError } from '@/lib/errors'
import {
  Avatar, Badge, Button, Chip, cx, Field, Input, Segmented, Select, Sheet, Skeleton, StatusBadge, Textarea, useToast,
} from './ui'

export function useInvalidateCalendar() {
  const qc = useQueryClient()
  const { ws } = useWorkspace()
  return () => {
    qc.invalidateQueries({ queryKey: ['appointments', ws.shop_id] })
    qc.invalidateQueries({ queryKey: ['analytics', ws.shop_id] })
    qc.invalidateQueries({ queryKey: ['owner_actions', ws.shop_id] })
    qc.invalidateQueries({ queryKey: ['walk_ins', ws.shop_id] })
    qc.invalidateQueries({ queryKey: ['appointment'] })
  }
}

/** Live haircut timer. */
export function CutTimer({ startedAt, scheduledMinutes, size = 'lg' }: { startedAt: string; scheduledMinutes: number; size?: 'sm' | 'lg' }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = (now - new Date(startedAt).getTime()) / 1000
  const pct = Math.min(100, (elapsed / (scheduledMinutes * 60)) * 100)
  const over = elapsed > scheduledMinutes * 60
  if (size === 'sm') return <span className={cx('font-semibold tnum', over ? 'text-warning' : 'text-success')}>{clock(elapsed)}</span>
  const r = 68
  const c = 2 * Math.PI * r
  return (
    <div className="relative mx-auto size-44">
      <svg viewBox="0 0 160 160" className="size-full -rotate-90">
        <circle cx="80" cy="80" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="8" />
        <circle cx="80" cy="80" r={r} fill="none" stroke={over ? 'var(--warning)' : 'var(--accent)'} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`} style={{ transition: 'stroke-dasharray 1s linear' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[38px] font-semibold leading-none tnum">{clock(elapsed)}</div>
        <div className={cx('mt-1.5 text-xs font-medium', over ? 'text-warning' : 'text-muted')}>
          {over ? `${Math.round(elapsed / 60 - scheduledMinutes)} min over` : `of ${scheduledMinutes} min`}
        </div>
      </div>
    </div>
  )
}

export function serviceLabel(a: Appointment) {
  if (a.kind !== 'appointment') return a.title ?? a.kind
  return (a.services ?? []).sort((x, y) => x.position - y.position).map((s) => s.name).join(' + ') || 'Appointment'
}

export function scheduledMinutes(a: Appointment) {
  return Math.round((new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60000)
}

// ---------------------------------------------------------------------------
// Appointment detail sheet with all status actions
// ---------------------------------------------------------------------------
export function AppointmentSheet({ appt, onClose }: { appt: Appointment | null; onClose: () => void }) {
  const { ws, can } = useWorkspace()
  const toast = useToast()
  const invalidate = useInvalidateCalendar()
  const { data: barbers } = useBarbers(ws.shop_id)
  const [busy, setBusy] = useState<string | null>(null)
  const [checkout, setCheckout] = useState(false)
  const [rebook, setRebook] = useState(false)
  const [move, setMove] = useState(false)
  const [notes, setNotes] = useState<string | null>(null)
  const { data: fresh } = useQuery({
    queryKey: ['appointment', appt?.id],
    enabled: !!appt,
    initialData: appt ?? undefined,
    queryFn: async () => (await supabase.from('appointments').select('*, client:clients(id, first_name, last_name, phone, email), services:appointment_services(*)').eq('id', appt!.id).single()).data as Appointment,
  })
  const a = fresh ?? appt
  useEffect(() => setNotes(null), [appt?.id])
  if (!a) return null
  const tz = ws.timezone
  const barber = barbers?.find((b) => b.id === a.barber_id)

  const act = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key)
    try {
      await fn()
      invalidate()
      if (success) toast(success, 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const live = ['BOOKED', 'CONFIRMED', 'CHECKED_IN'].includes(a.status)
  const past = new Date(a.starts_at).getTime() <= Date.now()

  return (
    <>
      <Sheet open={!!appt && !checkout && !rebook && !move} onClose={onClose} title={a.kind === 'appointment' ? fullName(a.client) || 'Appointment' : serviceLabel(a)}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={a.status} />
            {a.kind === 'appointment' && <Badge tone={a.payment_status === 'PAID' ? 'success' : a.payment_status === 'UNPAID' ? 'neutral' : 'warning'}>{a.payment_status}</Badge>}
            {a.source === 'walk_in' && <Badge tone="info">Walk-in</Badge>}
            {a.source === 'online' && <Badge>Online</Badge>}
            {a.is_late_cancellation && <Badge tone="danger">Late cancel</Badge>}
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="eyebrow">When</div>
              <div className="mt-1 font-semibold">{relativeDay(a.starts_at, tz)}</div>
              <div className="text-muted tnum">{time(a.starts_at, tz)} – {time(a.ends_at, tz)}</div>
            </div>
            <div>
              <div className="eyebrow">Barber</div>
              <div className="mt-1 flex items-center gap-2 font-semibold"><Avatar name={barber?.display_name} src={barber?.photo_url} size={22} />{barber?.display_name}</div>
            </div>
            {a.kind === 'appointment' && (
              <>
                <div>
                  <div className="eyebrow">Service</div>
                  <div className="mt-1 font-semibold">{serviceLabel(a)}</div>
                  <div className="text-muted">{minutes(scheduledMinutes(a))}</div>
                </div>
                <div>
                  <div className="eyebrow">Price</div>
                  <div className="mt-1 font-semibold tnum">{money(a.expected_price_cents)}</div>
                  {a.fee_cents > 0 && <div className="text-xs text-danger">Fee {money(a.fee_cents)}</div>}
                </div>
              </>
            )}
          </div>

          {a.client && (
            <div className="flex items-center gap-2 rounded-xl bg-surface-2 p-3">
              <Avatar name={fullName(a.client)} size={36} />
              <div className="min-w-0 flex-1">
                <Link to={`/app/clients/${a.client.id}`} className="block truncate font-semibold hover:underline" onClick={onClose}>{fullName(a.client)}</Link>
                <div className="truncate text-xs text-muted">{a.client.phone ?? a.client.email ?? 'No contact'}</div>
              </div>
              {a.client.phone && <a href={`tel:${a.client.phone}`} aria-label="Call" className="rounded-lg p-2 text-muted hover:bg-surface hover:text-ink"><Phone className="size-4" /></a>}
              {a.client.phone && <a href={`sms:${a.client.phone}`} aria-label="Text" className="rounded-lg p-2 text-muted hover:bg-surface hover:text-ink"><MessageSquare className="size-4" /></a>}
            </div>
          )}
          {a.client_message && <p className="rounded-xl border border-line p-3 text-sm"><span className="text-muted">Client: </span>{a.client_message}</p>}

          {a.status === 'IN_SERVICE' && a.actual_started_at && <CutTimer startedAt={a.actual_started_at} scheduledMinutes={scheduledMinutes(a)} />}
          {a.status === 'COMPLETED' && a.actual_duration_seconds !== null && (
            <div className="rounded-xl bg-surface-2 p-3 text-sm">
              Actual cut time <b className="tnum">{Math.round(a.actual_duration_seconds / 60)} min</b> vs {scheduledMinutes(a)} booked
              <span className={cx('ml-2 font-semibold', a.actual_duration_seconds / 60 <= scheduledMinutes(a) ? 'text-success' : 'text-warning')}>
                ({a.actual_duration_seconds / 60 <= scheduledMinutes(a) ? '−' : '+'}{Math.abs(Math.round(a.actual_duration_seconds / 60 - scheduledMinutes(a)))} min)
              </span>
            </div>
          )}

          {/* Primary actions */}
          {a.kind === 'appointment' && (
            <div className="grid gap-2">
              {live && (
                <Button size="xl" block icon={<Play className="size-5" />} loading={busy === 'start'} onClick={() => act('start', () => rpc('start_cut', { p_appointment_id: a.id }), 'Timer started')}>
                  START CUT
                </Button>
              )}
              {a.status === 'IN_SERVICE' && (
                <Button size="xl" block icon={<Square className="size-5" />} loading={busy === 'finish'}
                  onClick={() => act('finish', async () => { await rpc('finish_cut', { p_appointment_id: a.id }); setCheckout(true) })}>
                  COMPLETE CUT
                </Button>
              )}
              {a.status === 'COMPLETED' && a.payment_status === 'UNPAID' && (can('payments.record') || ws.barber_id === a.barber_id) && (
                <Button size="xl" block onClick={() => setCheckout(true)}>Record payment</Button>
              )}
              {a.status === 'COMPLETED' && a.client_id && (
                <Button variant="secondary" size="lg" block icon={<RotateCcw className="size-4" />} onClick={() => setRebook(true)}>Book next cut</Button>
              )}
              <div className="grid grid-cols-2 gap-2">
                {a.status === 'BOOKED' && <Button variant="secondary" icon={<Check className="size-4" />} loading={busy === 'confirm'} onClick={() => act('confirm', () => rpc('set_appointment_status', { p_appointment_id: a.id, p_status: 'CONFIRMED' }))}>Confirm</Button>}
                {['BOOKED', 'CONFIRMED'].includes(a.status) && <Button variant="secondary" icon={<UserCheck className="size-4" />} loading={busy === 'checkin'} onClick={() => act('checkin', () => rpc('set_appointment_status', { p_appointment_id: a.id, p_status: 'CHECKED_IN' }), 'Checked in')}>Check in</Button>}
                {a.status === 'IN_SERVICE' && <Button variant="ghost" loading={busy === 'undo'} onClick={() => act('undo', () => rpc('undo_start_cut', { p_appointment_id: a.id }))}>Undo start</Button>}
                {['BOOKED', 'CONFIRMED', 'CHECKED_IN'].includes(a.status) && <Button variant="secondary" icon={<CalendarClock className="size-4" />} onClick={() => setMove(true)}>Move</Button>}
                {live && past && <Button variant="danger" icon={<CircleSlash className="size-4" />} loading={busy === 'noshow'} onClick={() => act('noshow', () => rpc('set_appointment_status', { p_appointment_id: a.id, p_status: 'NO_SHOW' }), 'Marked as no-show')}>No-show</Button>}
                {live && <Button variant="danger" icon={<X className="size-4" />} loading={busy === 'cancel'} onClick={() => confirm('Cancel this appointment? The client will be notified.') && act('cancel', () => rpc('set_appointment_status', { p_appointment_id: a.id, p_status: 'CANCELLED', p_reason: 'Cancelled by shop' }), 'Cancelled')}>Cancel</Button>}
                {['CANCELLED', 'NO_SHOW'].includes(a.status) && <Button variant="secondary" loading={busy === 'restore'} onClick={() => act('restore', () => rpc('set_appointment_status', { p_appointment_id: a.id, p_status: 'BOOKED' }), 'Restored')}>Restore</Button>}
                {a.fee_cents > 0 && can('payments.record') && <Button variant="secondary" loading={busy === 'fee'} onClick={() => act('fee', () => rpc('charge_policy_fee', { p_appointment_id: a.id, p_method: 'card' }), 'Fee recorded')}>Charge {money(a.fee_cents)}</Button>}
              </div>
            </div>
          )}
          {a.kind !== 'appointment' && a.status !== 'CANCELLED' && (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" icon={<CalendarClock className="size-4" />} onClick={() => setMove(true)}>Move</Button>
              <Button variant="danger" icon={<Trash2 className="size-4" />} loading={busy === 'remove'} onClick={() => act('remove', async () => { await rpc('set_appointment_status', { p_appointment_id: a.id, p_status: 'CANCELLED' }); onClose() }, 'Removed')}>Remove</Button>
            </div>
          )}

          <Field label="Notes">
            <Textarea rows={2} value={notes ?? a.notes ?? ''} onChange={(e) => setNotes(e.target.value)} placeholder="Visible to staff only"
              onBlur={() => notes !== null && notes !== (a.notes ?? '') && act('notes', () => rpc('update_appointment_notes', { p_appointment_id: a.id, p_notes: notes }), 'Notes saved')} />
          </Field>
          <Link to={`/app/appointments/${a.id}`} onClick={onClose} className="block text-center text-xs text-muted hover:text-ink">Full history →</Link>
        </div>
      </Sheet>
      {checkout && <CheckoutSheet appt={a} onClose={() => setCheckout(false)} onPaid={() => { setCheckout(false); a.client_id && setRebook(true) }} />}
      {rebook && <RebookSheet appt={a} onClose={() => { setRebook(false); onClose() }} />}
      {move && <MoveSheet appt={a} onClose={() => setMove(false)} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Checkout: what was charged → the financial source of truth
// ---------------------------------------------------------------------------
const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'other', label: 'Other' },
]

export function CheckoutSheet({ appt, onClose, onPaid }: { appt: Appointment; onClose: () => void; onPaid?: () => void }) {
  const { ws } = useWorkspace()
  const toast = useToast()
  const invalidate = useInvalidateCalendar()
  const { data: services } = useServices(ws.shop_id)
  const { data: settings } = useQuery({
    queryKey: ['shop_settings', ws.shop_id],
    queryFn: async () => (await supabase.from('shop_settings').select('*').eq('shop_id', ws.shop_id).single()).data,
  })
  const [items, setItems] = useState(() =>
    (appt.services ?? []).length
      ? appt.services!.map((s) => ({ service_id: s.service_id, description: s.name, price: (s.price_cents / 100).toString() }))
      : [{ service_id: null as string | null, description: 'Service', price: (appt.expected_price_cents / 100).toString() }],
  )
  const [tipMode, setTipMode] = useState<number | 'custom' | 0>(0)
  const [tipCustom, setTipCustom] = useState('')
  const [discount, setDiscount] = useState('')
  const [promo, setPromo] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('card')
  const [partial, setPartial] = useState(false)
  const [paid, setPaid] = useState('')
  const [busy, setBusy] = useState(false)

  const subtotal = items.reduce((t, i) => t + (parseMoney(i.price) ?? 0), 0)
  const disc = Math.min(subtotal, parseMoney(discount) ?? 0)
  const tip = tipMode === 'custom' ? parseMoney(tipCustom) ?? 0 : tipMode ? Math.round(((subtotal - disc) * tipMode) / 100) : 0
  const taxRate = settings?.prices_include_tax ? 0 : (settings?.tax_rate_bps ?? 0) / 10000
  const tax = Math.round((subtotal - disc) * taxRate)
  const total = subtotal - disc + tax + tip

  async function submit() {
    setBusy(true)
    try {
      const res = await rpc<{ total_cents: number; status: string; discount_cents: number }>('record_payment', {
        p_appointment_id: appt.id,
        p_items: items.map((i) => ({ service_id: i.service_id, description: i.description, price_cents: parseMoney(i.price) ?? 0 })),
        p_tip_cents: tip,
        p_discount_cents: disc,
        p_method: method,
        p_amount_paid_cents: partial ? parseMoney(paid) ?? 0 : null,
        p_promo_code: promo || null,
      })
      invalidate()
      toast(`Paid ${money(res.total_cents)}${res.status === 'PARTIAL' ? ' (partial)' : ''}`, 'success')
      onPaid ? onPaid() : onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open onClose={onClose} title="Complete appointment" footer={
      <Button size="xl" block loading={busy} onClick={submit} disabled={subtotal <= 0 && tip <= 0}>Charge {money(total)}</Button>
    }>
      <div className="space-y-5">
        <div className="space-y-2">
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select aria-label="Service" className="flex-1" value={it.service_id ?? ''} onChange={(e) => {
                const s = services?.find((x) => x.id === e.target.value)
                setItems(items.map((x, j) => (j === i ? { service_id: s?.id ?? null, description: s?.name ?? 'Service', price: s ? (s.price_cents / 100).toString() : x.price } : x)))
              }}>
                {!it.service_id && <option value="">{it.description}</option>}
                {services?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
              <Input aria-label="Price" className="w-28 text-right" inputMode="decimal" leading="$" value={it.price} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
              {items.length > 1 && <button aria-label="Remove line" className="p-1 text-muted hover:text-danger" onClick={() => setItems(items.filter((_, j) => j !== i))}><X className="size-4" /></button>}
            </div>
          ))}
          <button className="inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-ink" onClick={() => setItems([...items, { service_id: null, description: 'Extra', price: '' }])}>
            <Plus className="size-4" /> Add item
          </button>
        </div>

        {settings?.tips_enabled !== false && (
          <div>
            <div className="mb-2 text-[13px] font-medium">Tip</div>
            <div className="flex flex-wrap gap-2">
              <Chip active={tipMode === 0} onClick={() => setTipMode(0)}>No tip</Chip>
              {(settings?.tip_presets_pct ?? [15, 20, 25]).map((p: number) => (
                <Chip key={p} active={tipMode === p} onClick={() => setTipMode(p)}>{p}% · {money(Math.round(((subtotal - disc) * p) / 100))}</Chip>
              ))}
              <Chip active={tipMode === 'custom'} onClick={() => setTipMode('custom')}>Custom</Chip>
            </div>
            {tipMode === 'custom' && <Input className="mt-2" inputMode="decimal" leading="$" placeholder="0" value={tipCustom} onChange={(e) => setTipCustom(e.target.value)} autoFocus />}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Discount"><Input inputMode="decimal" leading="$" placeholder="0" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
          <Field label="Promo code"><Input value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="Optional" /></Field>
        </div>

        <div>
          <div className="mb-2 text-[13px] font-medium">Payment method</div>
          <div className="grid grid-cols-5 gap-1.5">
            {METHODS.map((m) => (
              <button key={m.value} onClick={() => setMethod(m.value)}
                className={cx('h-11 rounded-xl border text-[13px] font-semibold transition', method === m.value ? 'border-accent bg-accent-soft' : 'border-line')}>
                {m.label}
              </button>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} className="accent-[var(--accent)]" /> Partially paid
          </label>
          {partial && <Input className="mt-2" inputMode="decimal" leading="$" placeholder="Amount received" value={paid} onChange={(e) => setPaid(e.target.value)} />}
        </div>

        <dl className="space-y-1.5 rounded-xl bg-surface-2 p-4 text-sm tnum">
          <Row k="Services" v={money(subtotal)} />
          {disc > 0 && <Row k="Discount" v={`−${money(disc)}`} />}
          {promo && <Row k="Promo" v="applied at checkout" muted />}
          {tax > 0 && <Row k="Tax" v={money(tax)} />}
          {tip > 0 && <Row k="Tip" v={money(tip)} />}
          <div className="!mt-3 flex justify-between border-t border-line pt-3 text-base font-semibold"><dt>Total</dt><dd>{money(total)}</dd></div>
        </dl>
      </div>
    </Sheet>
  )
}

function Row({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return <div className={cx('flex justify-between', muted && 'text-muted')}><dt className="text-muted">{k}</dt><dd>{v}</dd></div>
}

// ---------------------------------------------------------------------------
// Rebook: "Book your next cut" right after checkout
// ---------------------------------------------------------------------------
export function RebookSheet({ appt, onClose }: { appt: Appointment; onClose: () => void }) {
  const { ws } = useWorkspace()
  const toast = useToast()
  const invalidate = useInvalidateCalendar()
  const { data: prefs } = useQuery({
    queryKey: ['rebook-weeks', appt.client_id],
    queryFn: async () => {
      const [{ data: cp }, { data: ss }] = await Promise.all([
        supabase.from('client_preferences').select('rebook_interval_days').eq('client_id', appt.client_id!).maybeSingle(),
        supabase.from('shop_settings').select('default_rebook_weeks').eq('shop_id', ws.shop_id).single(),
      ])
      return cp?.rebook_interval_days ? Math.max(1, Math.round(cp.rebook_interval_days / 7)) : ss?.default_rebook_weeks ?? 3
    },
  })
  const [weeks, setWeeks] = useState<number | null>(null)
  const w = weeks ?? prefs ?? 3
  const base = dateInTz(appt.starts_at, ws.timezone)
  const [date, setDate] = useState<string | null>(null)
  const target = date ?? addDays(base, w * 7)
  const serviceIds = (appt.services ?? []).map((s) => s.service_id).filter(Boolean) as string[]
  const { data: slots, isLoading } = useQuery({
    queryKey: ['slots-staff', serviceIds.join(), appt.barber_id, target],
    enabled: serviceIds.length > 0,
    queryFn: () => rpc<Slot[]>('get_available_slots', { p_shop_id: ws.shop_id, p_service_ids: serviceIds, p_date: target, p_days: 1, p_barber_id: appt.barber_id }),
  })
  const [busy, setBusy] = useState<string | null>(null)
  const book = async (s: Slot) => {
    setBusy(s.starts_at)
    try {
      await rpc('staff_create_appointment', {
        p_shop_id: ws.shop_id, p_barber_id: appt.barber_id, p_service_ids: serviceIds, p_starts_at: s.starts_at,
        p_client_id: appt.client_id, p_source: 'staff', p_rebooked_from: appt.id,
      })
      invalidate()
      toast(`Next cut booked · ${relativeDay(s.starts_at, ws.timezone)} ${time(s.starts_at, ws.timezone)}`, 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <Sheet open onClose={onClose} title="Book the next cut">
      <p className="text-sm text-muted">Same barber, same service. Recommended in {w} weeks.</p>
      <div className="mt-4">
        <Segmented value={String(w)} onChange={(v) => { setWeeks(Number(v)); setDate(null) }}
          options={[2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} wk` }))} />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <button className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-2" onClick={() => setDate(addDays(target, -1))}>←</button>
        <div className="font-semibold">{dateStrLabel(target, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
        <button className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-2" onClick={() => setDate(addDays(target, 1))}>→</button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {isLoading ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-11" />) :
          (slots ?? []).length === 0 ? <p className="col-span-3 py-6 text-center text-sm text-muted">No openings this day — try another.</p> :
          slots!.map((s) => <Button key={s.starts_at} variant="outline" loading={busy === s.starts_at} disabled={!!busy} onClick={() => book(s)}>{time(s.starts_at, ws.timezone)}</Button>)}
      </div>
      <Button variant="ghost" block className="mt-5" onClick={onClose}>Not now</Button>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Move / reschedule
// ---------------------------------------------------------------------------
function MoveSheet({ appt, onClose }: { appt: Appointment; onClose: () => void }) {
  const { ws, can } = useWorkspace()
  const toast = useToast()
  const invalidate = useInvalidateCalendar()
  const { data: barbers } = useBarbers(ws.shop_id)
  const [date, setDate] = useState(dateInTz(appt.starts_at, ws.timezone))
  const [barberId, setBarberId] = useState(appt.barber_id)
  const [custom, setCustom] = useState('')
  const serviceIds = (appt.services ?? []).map((s) => s.service_id).filter(Boolean) as string[]
  const { data: slots, isLoading } = useQuery({
    queryKey: ['slots-staff', serviceIds.join(), barberId, date],
    enabled: appt.kind === 'appointment' && serviceIds.length > 0,
    queryFn: () => rpc<Slot[]>('get_available_slots', { p_shop_id: ws.shop_id, p_service_ids: serviceIds, p_date: date, p_days: 1, p_barber_id: barberId }),
  })
  const move = async (startsAt: string, force = false) => {
    try {
      await rpc('move_appointment', { p_appointment_id: appt.id, p_new_start: startsAt, p_new_barber_id: barberId, p_force: force })
      invalidate()
      toast('Moved', 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  return (
    <Sheet open onClose={onClose} title="Move appointment">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Barber">
            <Select value={barberId} onChange={(e) => setBarberId(e.target.value)} disabled={!can('calendar.all')}>
              {barbers?.map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}
            </Select>
          </Field>
        </div>
        {appt.kind === 'appointment' && (
          <div className="grid grid-cols-3 gap-2">
            {isLoading ? <Skeleton className="col-span-3 h-11" /> : (slots ?? []).length === 0 ? <p className="col-span-3 text-center text-sm text-muted">No open slots</p> :
              slots!.map((s) => <Button key={s.starts_at} variant="outline" onClick={() => move(s.starts_at)}>{time(s.starts_at, ws.timezone)}</Button>)}
          </div>
        )}
        <div className="rounded-xl border border-line p-3">
          <div className="text-[13px] font-medium">Exact time {appt.kind === 'appointment' && <span className="font-normal text-muted">(override — outside normal availability)</span>}</div>
          <div className="mt-2 flex gap-2">
            <Input type="time" step={300} value={custom} onChange={(e) => setCustom(e.target.value)} />
            <Button variant="secondary" disabled={!custom} onClick={() => move(zonedToUtc(date, custom, ws.timezone).toISOString(), true)}>Move</Button>
          </div>
        </div>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// New appointment (staff)
// ---------------------------------------------------------------------------
export function NewAppointmentSheet({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults?: { barberId?: string; date?: string; time?: string } }) {
  const { ws, can } = useWorkspace()
  const toast = useToast()
  const invalidate = useInvalidateCalendar()
  const { data: barbers } = useBarbers(ws.shop_id)
  const { data: services } = useServices(ws.shop_id)
  const { data: bsAll } = useBarberServices(ws.shop_id)
  const [barberId, setBarberId] = useState(defaults?.barberId ?? ws.barber_id ?? '')
  const [serviceId, setServiceId] = useState('')
  const [date, setDate] = useState(defaults?.date ?? todayInTz(ws.timezone))
  const [exact, setExact] = useState(defaults?.time ?? '')
  const [client, setClient] = useState<{ id?: string; first_name: string; last_name?: string; phone?: string; email?: string } | null>(null)
  const [search, setSearch] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setBarberId(defaults?.barberId ?? ws.barber_id ?? barbers?.[0]?.id ?? '')
      setDate(defaults?.date ?? todayInTz(ws.timezone))
      setExact(defaults?.time ?? '')
      setClient(null)
      setSearch('')
      setNotes('')
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!barberId && barbers?.length) setBarberId(barbers[0].id)
  }, [barbers, barberId])

  const offered = useMemo(() => services?.filter((s) => s.is_active && bsAll?.some((b) => b.barber_id === barberId && b.service_id === s.id && b.is_active)) ?? [], [services, bsAll, barberId])
  useEffect(() => {
    if (!offered.find((s) => s.id === serviceId)) setServiceId(offered[0]?.id ?? '')
  }, [offered, serviceId])

  const { data: matches } = useQuery({
    queryKey: ['client-search', ws.shop_id, search],
    enabled: search.trim().length >= 2 && !client,
    queryFn: () => rpc<ClientRow[]>('list_clients', { p_shop_id: ws.shop_id, p_search: search, p_limit: 6 }),
  })
  const { data: slots } = useQuery({
    queryKey: ['slots-staff', serviceId, barberId, date],
    enabled: open && !!serviceId && !!barberId,
    queryFn: () => rpc<Slot[]>('get_available_slots', { p_shop_id: ws.shop_id, p_service_ids: [serviceId], p_date: date, p_days: 1, p_barber_id: barberId }),
  })

  const submit = async (startsAt: string, force: boolean) => {
    if (!client) return toast('Choose or add a client', 'error')
    setBusy(true)
    try {
      await rpc('staff_create_appointment', {
        p_shop_id: ws.shop_id, p_barber_id: barberId, p_service_ids: [serviceId], p_starts_at: startsAt,
        p_client_id: client.id ?? null, p_client: client.id ? null : client, p_notes: notes || null, p_force: force,
      })
      invalidate()
      toast('Appointment booked', 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const exactIso = exact ? zonedToUtc(date, exact, ws.timezone).toISOString() : null
  const exactIsOffered = exactIso && slots?.some((s) => new Date(s.starts_at).getTime() === new Date(exactIso).getTime())

  return (
    <Sheet open={open} onClose={onClose} title="New appointment" wide>
      <div className="space-y-4">
        {/* Client */}
        <div>
          <div className="mb-1.5 text-[13px] font-medium">Client</div>
          {client ? (
            <div className="flex items-center gap-3 rounded-xl border border-accent bg-accent-soft p-3">
              <Avatar name={`${client.first_name} ${client.last_name ?? ''}`} size={32} />
              <div className="flex-1 text-sm"><div className="font-semibold">{client.first_name} {client.last_name}</div><div className="text-muted">{client.phone ?? client.email ?? 'New client'}</div></div>
              <button className="text-sm text-muted hover:text-ink" onClick={() => setClient(null)}>Change</button>
            </div>
          ) : (
            <>
              <Input placeholder="Search name or phone…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
              {!!matches?.length && (
                <div className="mt-1 divide-y divide-line rounded-xl border border-line">
                  {matches.map((m) => (
                    <button key={m.id} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => setClient({ id: m.id, first_name: m.first_name, last_name: m.last_name ?? '', phone: m.phone ?? undefined })}>
                      <Avatar name={`${m.first_name} ${m.last_name ?? ''}`} size={28} />
                      <span className="flex-1">{m.first_name} {m.last_name}</span>
                      <span className="text-muted">{m.phone}</span>
                    </button>
                  ))}
                </div>
              )}
              {search.trim().length >= 2 && <NewClientInline initial={search} onCreate={setClient} />}
            </>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Barber">
            <Select value={barberId} onChange={(e) => setBarberId(e.target.value)} disabled={!can('calendar.all')}>
              {barbers?.map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}
            </Select>
          </Field>
          <Field label="Service">
            <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {offered.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-medium">Open times</div>
          <div className="grid max-h-44 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6">
            {(slots ?? []).length === 0 && <p className="col-span-full text-sm text-muted">No open times. Use an exact time below to override.</p>}
            {slots?.map((s) => (
              <Button key={s.starts_at} size="sm" variant="outline" disabled={busy} onClick={() => submit(s.starts_at, false)}>{time(s.starts_at, ws.timezone)}</Button>
            ))}
          </div>
        </div>
        <div className="flex items-end gap-2">
          <Field label="Or exact time" className="flex-1"><Input type="time" step={300} value={exact} onChange={(e) => setExact(e.target.value)} /></Field>
          <Button disabled={!exact || busy} loading={busy} onClick={() => exactIso && submit(exactIso, !exactIsOffered)}>{exactIsOffered ? 'Book' : 'Book (override)'}</Button>
        </div>
        <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Sheet>
  )
}

function NewClientInline({ initial, onCreate }: { initial: string; onCreate: (c: { first_name: string; last_name?: string; phone?: string; email?: string }) => void }) {
  const isPhone = /^[\d\s()+-]+$/.test(initial)
  const [f, setF] = useState({ first_name: isPhone ? '' : initial.split(' ')[0], last_name: isPhone ? '' : initial.split(' ').slice(1).join(' '), phone: isPhone ? initial : '', email: '' })
  return (
    <div className="mt-2 rounded-xl border border-dashed border-line-strong p-3">
      <div className="mb-2 text-xs font-semibold text-muted">NEW CLIENT</div>
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder="First name" value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} />
        <Input placeholder="Last name" value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} />
        <Input placeholder="Phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <Input placeholder="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      </div>
      <Button size="sm" variant="secondary" className="mt-2" disabled={!f.first_name.trim()} onClick={() => onCreate(f)}>Use this client</Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Block time / break / personal / emergency
// ---------------------------------------------------------------------------
export function BlockTimeSheet({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults?: { barberId?: string; date?: string; time?: string } }) {
  const { ws, can } = useWorkspace()
  const toast = useToast()
  const invalidate = useInvalidateCalendar()
  const { data: barbers } = useBarbers(ws.shop_id)
  const [kind, setKind] = useState<'block' | 'break' | 'personal' | 'emergency'>('break')
  const [barberId, setBarberId] = useState(defaults?.barberId ?? ws.barber_id ?? '')
  const [date, setDate] = useState(defaults?.date ?? todayInTz(ws.timezone))
  const [from, setFrom] = useState(defaults?.time ?? '13:00')
  const [to, setTo] = useState('14:00')
  const [title, setTitle] = useState('')
  const [cancelAffected, setCancelAffected] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!barberId && barbers?.length) setBarberId(ws.barber_id ?? barbers[0].id)
  }, [barbers, barberId, ws.barber_id])

  const submit = async () => {
    setBusy(true)
    try {
      const s = zonedToUtc(date, from, ws.timezone).toISOString()
      const e = zonedToUtc(date, to, ws.timezone).toISOString()
      if (kind === 'emergency') {
        const r = await rpc<{ affected: string[] }>('mark_barber_unavailable', { p_barber_id: barberId, p_starts_at: s, p_ends_at: e, p_kind: 'emergency', p_note: title || null, p_cancel_affected: cancelAffected })
        toast(r.affected.length ? `${r.affected.length} appointment(s) affected${cancelAffected ? ' — cancelled & clients notified' : ' — reschedule them from the calendar'}` : 'Marked unavailable', 'success')
      } else {
        await rpc('create_calendar_block', { p_barber_id: barberId, p_kind: kind, p_starts_at: s, p_ends_at: e, p_title: title || null })
        toast('Time blocked', 'success')
      }
      invalidate()
      onClose()
    } catch (err) {
      toast(friendlyError(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Block time" footer={<Button size="lg" block loading={busy} onClick={submit} disabled={to <= from}>Save</Button>}>
      <div className="space-y-4">
        <Segmented value={kind} onChange={setKind} options={[{ value: 'break', label: 'Break' }, { value: 'block', label: 'Block' }, { value: 'personal', label: 'Personal' }, { value: 'emergency', label: 'Emergency' }]} />
        {can('calendar.all') && (
          <Field label="Barber"><Select value={barberId} onChange={(e) => setBarberId(e.target.value)}>{barbers?.map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}</Select></Field>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="From"><Input type="time" step={300} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="time" step={300} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Field label="Label (optional)"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'emergency' ? 'e.g. family emergency' : 'e.g. lunch'} /></Field>
        {kind === 'emergency' && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={cancelAffected} onChange={(e) => setCancelAffected(e.target.checked)} />
            <span>Cancel booked appointments in this window and notify clients (they'll be offered to the waitlist too)</span>
          </label>
        )}
      </div>
    </Sheet>
  )
}
