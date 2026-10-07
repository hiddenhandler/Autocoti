import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, Mail } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useShop } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { money, parseMoney } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import type { Shop } from '@/lib/types'
import { HoursEditor, validHours, type HoursRow } from '@/components/HoursEditor'
import { Badge, Button, Card, CardHeader, cx, Field, Input, PageHeader, Select, Skeleton, Textarea, Toggle, useToast } from '@/components/ui'

const SECTIONS = [
  { key: 'shop', label: 'Shop & branding' },
  { key: 'hours', label: 'Business hours' },
  { key: 'booking', label: 'Booking & policies' },
  { key: 'payments', label: 'Payments, tax & tips' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'team', label: 'Team & roles' },
  { key: 'locations', label: 'Locations' },
  { key: 'billing', label: 'Plan & billing' },
]

export default function Settings() {
  const { section = 'shop' } = useParams()
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
          {SECTIONS.map((s) => (
            <NavLink key={s.key} to={`/app/settings/${s.key}`} className={({ isActive }) => cx('whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium', isActive ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink')}>{s.label}</NavLink>
          ))}
        </nav>
        <div className="min-w-0 max-w-3xl">
          {section === 'shop' && <ShopSection />}
          {section === 'hours' && <HoursSection />}
          {section === 'booking' && <BookingSection />}
          {section === 'payments' && <PaymentsSection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'team' && <TeamSection />}
          {section === 'locations' && <LocationsSection />}
          {section === 'billing' && <BillingSection />}
        </div>
      </div>
    </div>
  )
}

function SaveBar({ busy, onSave, children }: { busy?: boolean; onSave: () => void; children?: ReactNode }) {
  return <div className="mt-5 flex items-center gap-3"><Button loading={busy} onClick={onSave}>Save changes</Button>{children}</div>
}

function useSaver() {
  const toast = useToast()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => PromiseLike<{ error: unknown } | void>, invalidate: string[][] = []) => {
    setBusy(true)
    try {
      const r = await fn()
      if (r && r.error) throw r.error
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }))
      toast('Saved', 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

function ShopSection() {
  const { ws, hasFeature } = useWorkspace()
  const { data: shop } = useShop(ws.shop_id)
  const [f, setF] = useState<Partial<Shop>>({})
  const { busy, run } = useSaver()
  const toast = useToast()
  useEffect(() => { if (shop) setF(shop) }, [shop])
  if (!shop) return <Skeleton className="h-96" />
  const set = (k: keyof Shop) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  const link = `${window.location.origin}/s/${shop.slug}`
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">Booking page</div>
            <a href={link} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">{link} <ExternalLink className="size-3.5" /></a>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="secondary" icon={<Copy className="size-4" />} onClick={() => { navigator.clipboard?.writeText(link); toast('Link copied', 'success') }}>Copy</Button>
            <Toggle checked={!!f.is_published} onChange={(v) => { setF({ ...f, is_published: v }); run(() => supabase.from('shops').update({ is_published: v }).eq('id', shop.id), [['shop', ws.shop_id], ['workspaces']]) }} label={f.is_published ? 'Live' : 'Hidden'} />
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Profile" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Shop name"><Input value={f.name ?? ''} onChange={set('name')} /></Field>
          <Field label="Tagline"><Input value={f.tagline ?? ''} onChange={set('tagline')} placeholder="Precision cuts since 2015" /></Field>
          <Field label="About" className="sm:col-span-2"><Textarea rows={3} value={f.description ?? ''} onChange={set('description')} /></Field>
          <Field label="Phone"><Input type="tel" value={f.phone ?? ''} onChange={set('phone')} /></Field>
          <Field label="Email"><Input type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
          <Field label="Address" className="sm:col-span-2"><Input value={f.address_line1 ?? ''} onChange={set('address_line1')} /></Field>
          <Field label="City"><Input value={f.city ?? ''} onChange={set('city')} /></Field>
          <Field label="State / region"><Input value={f.region ?? ''} onChange={set('region')} /></Field>
          <Field label="Postal code"><Input value={f.postal_code ?? ''} onChange={set('postal_code')} /></Field>
          <Field label="Country"><Input value={f.country ?? ''} onChange={set('country')} /></Field>
          <Field label="Instagram"><Input value={f.instagram ?? ''} onChange={set('instagram')} placeholder="@yourshop" /></Field>
          <Field label="Website"><Input value={f.website ?? ''} onChange={set('website')} /></Field>
          <Field label="Timezone" hint="Changing this shifts how hours are interpreted"><Input value={f.timezone ?? ''} onChange={set('timezone')} /></Field>
        </div>
      </Card>
      <Card>
        <CardHeader title="Branding" subtitle={hasFeature('custom_branding') ? undefined : 'Logo and accent colour are on every plan; custom domain is Pro.'} />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Logo URL"><Input type="url" value={f.logo_url ?? ''} onChange={set('logo_url')} /></Field>
          <Field label="Cover photo URL"><Input type="url" value={f.cover_url ?? ''} onChange={set('cover_url')} /></Field>
          <Field label="Accent colour">
            <div className="flex items-center gap-2">
              <input type="color" aria-label="Accent colour" value={f.accent_color ?? '#1683FF'} onChange={set('accent_color')} className="h-11 w-14 cursor-pointer rounded-xl border border-line bg-surface p-1" />
              <Input value={f.accent_color ?? ''} onChange={set('accent_color')} />
            </div>
          </Field>
          <Field label="Custom domain" hint="Point a CNAME to your BarberNGo domain"><Input disabled={!hasFeature('custom_branding')} value={f.custom_domain ?? ''} onChange={set('custom_domain')} placeholder="book.yourshop.com" /></Field>
          <Field label="Gallery photo URLs" hint="One per line" className="sm:col-span-2">
            <Textarea rows={3} value={(f.gallery_urls ?? []).join('\n')} onChange={(e) => setF({ ...f, gallery_urls: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
          </Field>
        </div>
      </Card>
      <SaveBar busy={busy} onSave={() => run(() => supabase.from('shops').update({
        name: f.name, tagline: f.tagline || null, description: f.description || null, phone: f.phone || null, email: f.email || null,
        address_line1: f.address_line1 || null, city: f.city || null, region: f.region || null, postal_code: f.postal_code || null, country: f.country || null,
        instagram: f.instagram || null, website: f.website || null, timezone: f.timezone, logo_url: f.logo_url || null, cover_url: f.cover_url || null,
        accent_color: f.accent_color, custom_domain: f.custom_domain || null, gallery_urls: f.gallery_urls ?? [],
      }).eq('id', shop.id), [['shop', ws.shop_id], ['workspaces']])} />
    </div>
  )
}

function HoursSection() {
  const { ws } = useWorkspace()
  const { data } = useQuery({ queryKey: ['business_hours', ws.shop_id], queryFn: async () => (await supabase.from('business_hours').select('*').eq('shop_id', ws.shop_id)).data ?? [] })
  const [rows, setRows] = useState<HoursRow[] | null>(null)
  const { busy, run } = useSaver()
  useEffect(() => { if (data) setRows(data.map((h: any) => ({ weekday: h.weekday, starts_at: h.opens_at.slice(0, 5), ends_at: h.closes_at.slice(0, 5), kind: 'work' as const }))) }, [data])
  const [closing, setClosing] = useState({ date: '', note: '' })
  const toast = useToast()
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Business hours" subtitle="Shown on your booking page. Barbers without their own schedule use these." />
        <div className="px-5">{rows && <HoursEditor value={rows} onChange={setRows} allowBreaks={false} />}</div>
        <div className="p-5 pt-0">
          <SaveBar busy={busy} onSave={() => run(async () => {
            if (!rows || !validHours(rows)) throw new Error('Check the hours')
            const del = await supabase.from('business_hours').delete().eq('shop_id', ws.shop_id)
            if (del.error) return del
            return supabase.from('business_hours').insert(rows.map((r) => ({ shop_id: ws.shop_id, weekday: r.weekday, opens_at: r.starts_at, closes_at: r.ends_at })))
          }, [['business_hours', ws.shop_id], ['availability']])} />
        </div>
      </Card>
      <Card className="p-5">
        <div className="font-semibold">Close the shop for a day</div>
        <p className="mt-1 text-sm text-muted">Holidays, weather, emergencies. Online booking stops for that day; already-booked clients are listed so you can contact or move them.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input type="date" className="w-44" value={closing.date} onChange={(e) => setClosing({ ...closing, date: e.target.value })} />
          <Input className="w-56" placeholder="Reason" value={closing.note} onChange={(e) => setClosing({ ...closing, note: e.target.value })} />
          <Button variant="secondary" disabled={!closing.date} onClick={async () => {
            try {
              const { zonedToUtc, addDays } = await import('@/lib/time')
              const r = await rpc<{ affected: string[] }>('close_shop', { p_shop_id: ws.shop_id, p_starts_at: zonedToUtc(closing.date, '00:00', ws.timezone).toISOString(), p_ends_at: zonedToUtc(addDays(closing.date, 1), '00:00', ws.timezone).toISOString(), p_note: closing.note || 'Closed' })
              toast(r.affected.length ? `Closed. ${r.affected.length} appointment(s) need attention — see Calendar.` : 'Closed for the day', r.affected.length ? 'error' : 'success')
            } catch (e) { toast(friendlyError(e), 'error') }
          }}>Close day</Button>
        </div>
      </Card>
    </div>
  )
}

function BookingSection() {
  const { ws } = useWorkspace()
  const { data } = useQuery({ queryKey: ['booking_settings', ws.shop_id], queryFn: async () => (await supabase.from('booking_settings').select('*').eq('shop_id', ws.shop_id).single()).data })
  const [f, setF] = useState<any>(null)
  const { busy, run } = useSaver()
  useEffect(() => { if (data) setF(data) }, [data])
  if (!f) return <Skeleton className="h-96" />
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: Number(e.target.value) })
  const cents = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: parseMoney(e.target.value) ?? 0 })
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Online booking" />
        <div className="space-y-4 p-5">
          <Toggle checked={f.online_booking_enabled} onChange={(v) => setF({ ...f, online_booking_enabled: v })} label="Accept online bookings" />
          <Toggle checked={f.allow_any_barber} onChange={(v) => setF({ ...f, allow_any_barber: v })} label="Allow “Any barber”" />
          <Toggle checked={f.require_phone} onChange={(v) => setF({ ...f, require_phone: v })} label="Require phone number" />
          <Toggle checked={f.require_email} onChange={(v) => setF({ ...f, require_email: v })} label="Require email" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Minimum notice" hint="How soon before a slot it can be booked"><Select value={f.min_notice_minutes} onChange={num('min_notice_minutes')}>{[0, 15, 30, 60, 120, 240, 720, 1440].map((m) => <option key={m} value={m}>{m === 0 ? 'None' : m < 60 ? `${m} min` : `${m / 60} h`}</option>)}</Select></Field>
            <Field label="Book up to"><Select value={f.max_advance_days} onChange={num('max_advance_days')}>{[7, 14, 21, 30, 45, 60, 90, 180].map((d) => <option key={d} value={d}>{d} days ahead</option>)}</Select></Field>
            <Field label="Buffer between appointments"><Select value={f.buffer_minutes} onChange={num('buffer_minutes')}>{[0, 5, 10, 15, 20, 30].map((d) => <option key={d} value={d}>{d} min</option>)}</Select></Field>
            <Field label="Time grid" hint="Start times also snap right after other bookings"><Select value={f.slot_interval_minutes} onChange={num('slot_interval_minutes')}>{[5, 10, 15, 20, 30, 60].map((d) => <option key={d} value={d}>Every {d} min</option>)}</Select></Field>
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Cancellations & no-shows" />
        <div className="space-y-4 p-5">
          <Toggle checked={f.allow_client_cancel} onChange={(v) => setF({ ...f, allow_client_cancel: v })} label="Clients can cancel online" />
          <Toggle checked={f.allow_client_reschedule} onChange={(v) => setF({ ...f, allow_client_reschedule: v })} label="Clients can reschedule online" />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Free cancellation until"><Select value={f.cancellation_window_hours} onChange={num('cancellation_window_hours')}>{[0, 1, 2, 4, 6, 12, 24, 48].map((h) => <option key={h} value={h}>{h} h before</option>)}</Select></Field>
            <Field label="Late-cancel fee"><Input leading="$" defaultValue={f.late_cancel_fee_cents / 100} onChange={cents('late_cancel_fee_cents')} /></Field>
            <Field label="No-show fee"><Input leading="$" defaultValue={f.no_show_fee_cents / 100} onChange={cents('no_show_fee_cents')} /></Field>
          </div>
          <Toggle checked={f.deposit_required} onChange={(v) => setF({ ...f, deposit_required: v })} label="Require a deposit" description="Shown on the booking page; collect it at booking once a payment provider is connected." />
          {f.deposit_required && <Field label="Deposit"><Input leading="$" defaultValue={f.deposit_cents / 100} onChange={cents('deposit_cents')} /></Field>}
          <Toggle checked={f.card_required} onChange={(v) => setF({ ...f, card_required: v })} label="Require card on file" description="Takes effect when a payment provider is connected." />
          <Field label="Policy text (optional)" hint="Shown to clients before they confirm"><Textarea rows={3} value={f.cancellation_policy_text ?? ''} onChange={(e) => setF({ ...f, cancellation_policy_text: e.target.value || null })} /></Field>
          <Field label="Waitlist claim window"><Select value={f.waitlist_claim_minutes} onChange={num('waitlist_claim_minutes')}>{[10, 15, 30, 60, 120].map((m) => <option key={m} value={m}>{m} min</option>)}</Select></Field>
        </div>
      </Card>
      <SaveBar busy={busy} onSave={() => run(() => {
        const { shop_id, updated_at, ...rest } = f
        void updated_at
        return supabase.from('booking_settings').update(rest).eq('shop_id', shop_id)
      }, [['booking_settings', ws.shop_id]])} />
    </div>
  )
}

function useShopSettings() {
  const { ws } = useWorkspace()
  return useQuery({ queryKey: ['shop_settings', ws.shop_id], queryFn: async () => (await supabase.from('shop_settings').select('*').eq('shop_id', ws.shop_id).single()).data })
}

function PaymentsSection() {
  const { ws } = useWorkspace()
  const { data } = useShopSettings()
  const [f, setF] = useState<any>(null)
  const { busy, run } = useSaver()
  useEffect(() => { if (data) setF(data) }, [data])
  if (!f) return <Skeleton className="h-64" />
  return (
    <Card>
      <CardHeader title="Payments, tax & tips" subtitle="Payments are recorded manually today; the data model is ready for Stripe or any other provider." />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Currency"><Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{['USD', 'CAD', 'EUR', 'GBP', 'MXN', 'AUD', 'BRL', 'COP', 'DOP'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Tax rate %"><Input type="number" step="0.01" value={f.tax_rate_bps / 100} onChange={(e) => setF({ ...f, tax_rate_bps: Math.round(Number(e.target.value) * 100) })} /></Field>
          <Field label="Prices include tax"><Select value={String(f.prices_include_tax)} onChange={(e) => setF({ ...f, prices_include_tax: e.target.value === 'true' })}><option value="false">No — add on top</option><option value="true">Yes</option></Select></Field>
        </div>
        <Toggle checked={f.tips_enabled} onChange={(v) => setF({ ...f, tips_enabled: v })} label="Tips" />
        <Field label="Tip suggestions %"><Input value={f.tip_presets_pct.join(', ')} onChange={(e) => setF({ ...f, tip_presets_pct: e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => n > 0 && n < 100) })} /></Field>
        <Field label="Chair utilization target %"><Input type="number" value={f.utilization_target_pct} onChange={(e) => setF({ ...f, utilization_target_pct: Number(e.target.value) })} /></Field>
        <SaveBar busy={busy} onSave={() => run(() => supabase.from('shop_settings').update({ currency: f.currency, tax_rate_bps: f.tax_rate_bps, prices_include_tax: f.prices_include_tax, tips_enabled: f.tips_enabled, tip_presets_pct: f.tip_presets_pct, utilization_target_pct: f.utilization_target_pct }).eq('shop_id', ws.shop_id), [['shop_settings', ws.shop_id]])} />
      </div>
    </Card>
  )
}

const EVENTS = [
  ['appointment.created', 'Booking confirmation'], ['appointment.reminder', 'Reminder'], ['appointment.rescheduled', 'Rescheduled'],
  ['appointment.cancelled', 'Cancelled'], ['appointment.no_show', 'No-show'], ['waitlist.slot_available', 'Waitlist slot open'],
  ['review.request', 'Review request'], ['rebooking.reminder', 'Rebooking reminder'], ['payment.recorded', 'Receipt'], ['barber.running_late', 'Running late'],
]

function NotificationsSection() {
  const { ws } = useWorkspace()
  const { data } = useShopSettings()
  const [f, setF] = useState<any>(null)
  const { busy, run } = useSaver()
  const [event, setEvent] = useState(EVENTS[0][0])
  const { data: tpl, refetch } = useQuery({
    queryKey: ['template', ws.shop_id, event],
    queryFn: async () => (await supabase.from('notification_templates').select('*').eq('event', event).eq('channel', 'email').or(`shop_id.eq.${ws.shop_id},shop_id.is.null`)).data ?? [],
  })
  const own = tpl?.find((t: any) => t.shop_id === ws.shop_id)
  const base = own ?? tpl?.find((t: any) => t.shop_id === null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  useEffect(() => { if (data) setF(data) }, [data])
  useEffect(() => { setSubject(base?.subject ?? ''); setBody(base?.body ?? '') }, [base?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!f) return <Skeleton className="h-64" />
  const offsets: number[] = f.reminder_offsets_minutes
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Automations" subtitle="Email today; SMS, WhatsApp and push plug into the same outbox." />
        <div className="space-y-4 p-5">
          <div>
            <div className="mb-2 text-[13px] font-medium">Appointment reminders</div>
            <div className="flex flex-wrap gap-2">
              {[[2880, '48 h'], [1440, '24 h'], [240, '4 h'], [120, '2 h'], [60, '1 h']].map(([m, l]) => (
                <button key={m} onClick={() => setF({ ...f, reminder_offsets_minutes: offsets.includes(m as number) ? offsets.filter((x) => x !== m) : [...offsets, m as number].sort((a, b) => b - a) })}
                  className={cx('inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium', offsets.includes(m as number) ? 'border-accent bg-accent-soft' : 'border-line text-muted')}>
                  {offsets.includes(m as number) && <Check className="size-3.5 text-accent" />}{l} before
                </button>
              ))}
            </div>
          </div>
          <Toggle checked={f.review_requests_enabled} onChange={(v) => setF({ ...f, review_requests_enabled: v })} label="Ask for a review after each cut" />
          {f.review_requests_enabled && <Field label="Send review request"><Select value={f.review_request_delay_minutes} onChange={(e) => setF({ ...f, review_request_delay_minutes: Number(e.target.value) })}>{[30, 60, 120, 240, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`} after</option>)}</Select></Field>}
          <Toggle checked={f.rebooking_reminders_enabled} onChange={(v) => setF({ ...f, rebooking_reminders_enabled: v })} label="Remind clients when they're due" description="Only clients who opted in to reminders." />
          <Toggle checked={f.notify_staff_on_booking} onChange={(v) => setF({ ...f, notify_staff_on_booking: v })} label="Notify staff about new bookings & cancellations" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default rebook interval"><Select value={f.default_rebook_weeks} onChange={(e) => setF({ ...f, default_rebook_weeks: Number(e.target.value) })}>{[2, 3, 4, 5, 6, 8].map((w) => <option key={w} value={w}>{w} weeks</option>)}</Select></Field>
            <Field label="Expected visit rhythm (new clients)"><Select value={f.default_visit_cadence_days} onChange={(e) => setF({ ...f, default_visit_cadence_days: Number(e.target.value) })}>{[14, 21, 28, 35, 42, 56].map((d) => <option key={d} value={d}>{d} days</option>)}</Select></Field>
          </div>
          <SaveBar busy={busy} onSave={() => run(() => supabase.from('shop_settings').update({
            reminder_offsets_minutes: f.reminder_offsets_minutes, review_requests_enabled: f.review_requests_enabled, review_request_delay_minutes: f.review_request_delay_minutes,
            rebooking_reminders_enabled: f.rebooking_reminders_enabled, notify_staff_on_booking: f.notify_staff_on_booking, default_rebook_weeks: f.default_rebook_weeks, default_visit_cadence_days: f.default_visit_cadence_days,
          }).eq('shop_id', ws.shop_id), [['shop_settings', ws.shop_id]])} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Message templates" subtitle="Variables: {{client_first_name}} {{barber_name}} {{service_name}} {{when}} {{time}} {{manage_url}} {{shop_name}}" />
        <div className="space-y-3 p-5">
          <Select value={event} onChange={(e) => setEvent(e.target.value)}>{EVENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <Field label="Body"><Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => run(async () => {
              const r = own ? await supabase.from('notification_templates').update({ subject, body }).eq('id', own.id) : await supabase.from('notification_templates').insert({ shop_id: ws.shop_id, event, channel: 'email', subject, body })
              refetch()
              return r
            })}>Save template</Button>
            {own ? <Badge tone="accent">Customised</Badge> : <Badge>Default</Badge>}
          </div>
        </div>
      </Card>
    </div>
  )
}

function TeamSection() {
  const { ws, isOwner } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: team } = useQuery({ queryKey: ['team', ws.shop_id], queryFn: () => rpc<any[]>('list_team', { p_shop_id: ws.shop_id }) })
  const { data: invites } = useQuery({ queryKey: ['invites', ws.shop_id], queryFn: async () => (await supabase.from('invitations').select('*').eq('shop_id', ws.shop_id).is('accepted_at', null).is('revoked_at', null)).data ?? [] })
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('receptionist')
  const invite = async () => {
    try {
      const token = await rpc<string>('invite_staff', { p_shop_id: ws.shop_id, p_email: email, p_role: role })
      await navigator.clipboard?.writeText(`${window.location.origin}/invite/${token}`).catch(() => {})
      toast('Invitation sent — link copied', 'success')
      setEmail('')
      qc.invalidateQueries({ queryKey: ['invites', ws.shop_id] })
    } catch (e) { toast(friendlyError(e), 'error') }
  }
  const update = async (id: string, patch: Record<string, unknown>) => {
    try { await rpc('update_membership', { p_membership_id: id, ...patch }); qc.invalidateQueries({ queryKey: ['team', ws.shop_id] }); toast('Updated', 'success') } catch (e) { toast(friendlyError(e), 'error') }
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Team" subtitle="Roles are enforced in the database, not just hidden in the app." />
        <div className="mt-3 divide-y divide-line">
          {team?.map((m) => (
            <div key={m.membership_id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1"><div className="font-medium">{m.full_name ?? m.email}</div><div className="text-xs text-muted">{m.email}{m.scope === 'organization' ? ' · all locations' : ''}</div></div>
              {m.role === 'owner' ? <Badge tone="accent">Owner</Badge> : (
                <>
                  <Select className="h-9 w-36" value={m.role} disabled={!isOwner && m.role === 'manager'} onChange={(e) => update(m.membership_id, { p_role: e.target.value })}>
                    <option value="manager" disabled={!isOwner}>Manager</option><option value="receptionist">Receptionist</option><option value="barber">Barber</option>
                  </Select>
                  {isOwner && m.role === 'manager' && (
                    <Toggle checked={!!m.permissions?.['financials.all_barbers']} onChange={(v) => update(m.membership_id, { p_permissions: { ...m.permissions, 'financials.all_barbers': v } })} label={<span className="text-xs">See barber earnings</span>} />
                  )}
                  <Button size="sm" variant={m.is_active ? 'ghost' : 'secondary'} onClick={() => update(m.membership_id, { p_is_active: !m.is_active })}>{m.is_active ? 'Remove access' : 'Restore'}</Button>
                </>
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card className="p-5">
        <div className="font-semibold">Invite someone</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input type="email" className="min-w-56 flex-1" placeholder="name@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Select className="w-40" value={role} onChange={(e) => setRole(e.target.value)}>
            {isOwner && <option value="manager">Manager</option>}<option value="receptionist">Receptionist</option><option value="barber">Barber</option>
          </Select>
          <Button icon={<Mail className="size-4" />} disabled={!email} onClick={invite}>Invite</Button>
        </div>
        <dl className="mt-4 grid gap-2 text-xs text-muted sm:grid-cols-3">
          <div><b className="text-ink">Manager</b> — runs the shop: calendar, staff, services, reports. Barber earnings only if you allow it.</div>
          <div><b className="text-ink">Receptionist</b> — bookings, clients, walk-ins, checkout. No reports or settings.</div>
          <div><b className="text-ink">Barber</b> — own chair: schedule, clients, timer, own earnings.</div>
        </dl>
        {!!invites?.length && (
          <div className="mt-4 space-y-1 text-sm">{invites.map((i: any) => <div key={i.id} className="flex justify-between text-muted"><span>{i.email} · {i.role}</span><span>pending</span></div>)}</div>
        )}
      </Card>
    </div>
  )
}

function LocationsSection() {
  const { ws, all, switchTo, isOwner } = useWorkspace()
  const mine = all.filter((w) => w.organization_id === ws.organization_id)
  return (
    <Card>
      <CardHeader title="Locations" subtitle="Each location has its own calendar, barbers, revenue and settings." action={isOwner ? <Link to="/onboarding?location=1"><Button size="sm">Add location</Button></Link> : null} />
      <div className="mt-3 divide-y divide-line">
        {mine.map((w) => (
          <div key={w.shop_id} className="flex items-center justify-between px-5 py-3 text-sm">
            <div><div className="font-medium">{w.shop_name}</div><div className="text-xs text-muted">/s/{w.shop_slug} · {w.timezone}</div></div>
            {w.shop_id === ws.shop_id ? <Badge tone="accent">Current</Badge> : <Button size="sm" variant="secondary" onClick={() => switchTo(w.shop_id)}>Switch</Button>}
          </div>
        ))}
      </div>
    </Card>
  )
}

function BillingSection() {
  const { ws, features } = useWorkspace()
  const { data } = useQuery({
    queryKey: ['subscription', ws.organization_id],
    queryFn: async () => (await supabase.from('subscriptions').select('*, plan:subscription_plans(*)').eq('organization_id', ws.organization_id).maybeSingle()).data,
  })
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: async () => (await supabase.from('subscription_plans').select('*').order('sort_order')).data ?? [] })
  const FEATURE_LABELS: Record<string, string> = { analytics_advanced: 'Advanced analytics', waitlist: 'Waitlist', walk_ins: 'Walk-in queue', commissions: 'Commissions', automations: 'Automations', ai_insights: 'AI assistant', marketing: 'Marketing', custom_branding: 'Custom domain', exports: 'Exports', api: 'API' }
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="eyebrow">Current plan</div>
            <div className="mt-1 text-2xl font-semibold">{data?.plan?.name ?? '—'}</div>
            <div className="text-sm text-muted">{data?.status === 'trialing' && data.trial_ends_at ? `Trial ends ${new Date(data.trial_ends_at).toLocaleDateString()}` : data?.status}</div>
          </div>
          <Badge tone={data?.status === 'active' || data?.status === 'trialing' ? 'success' : 'warning'}>{data?.status}</Badge>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {Object.entries(FEATURE_LABELS).map(([k, l]) => <Badge key={k} tone={features[k] ? 'success' : 'neutral'} className="normal-case">{features[k] ? '✓' : '—'} {l}</Badge>)}
        </div>
      </Card>
      <div className="grid gap-3 sm:grid-cols-3">
        {plans?.map((p: any) => (
          <Card key={p.id} className={cx('p-5', data?.plan_id === p.id && 'border-accent')}>
            <div className="font-semibold">{p.name}</div>
            <div className="mt-1 text-2xl font-semibold">{money(p.price_cents, { currency: p.currency })}<span className="text-sm font-normal text-muted">/mo</span></div>
            <p className="mt-2 text-sm text-muted">{p.description}</p>
            <div className="mt-3 text-xs text-muted">{p.features.max_barbers ? `${p.features.max_barbers} barber` : 'Unlimited barbers'} · {p.features.max_locations ? `${p.features.max_locations} location` : 'Multi-location'}</div>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted">Plan changes are processed by the billing provider (Stripe, via the subscriptions table's provider fields). Contact support to change plans until checkout is connected.</p>
    </div>
  )
}
