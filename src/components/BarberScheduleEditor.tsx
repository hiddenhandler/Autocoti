import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { rpc, supabase } from '@/lib/supabase'
import { useWorkspace } from '@/lib/auth'
import { HoursEditor, validHours, type HoursRow } from './HoursEditor'
import { Badge, Button, Card, CardHeader, Field, Input, Select, Toggle, useToast } from './ui'
import { friendlyError } from '@/lib/errors'
import { dateLabel, time } from '@/lib/format'
import { todayInTz, zonedToUtc } from '@/lib/time'
import { useServices, useBarberServices } from '@/lib/api'
import type { Barber } from '@/lib/types'

/** Weekly hours + breaks, time off, booking rules and services for one barber. */
export function BarberScheduleEditor({ barber }: { barber: Barber }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: rows } = useQuery({
    queryKey: ['availability', barber.id],
    queryFn: async () => (await supabase.from('availability').select('weekday, starts_at, ends_at, kind, label').eq('barber_id', barber.id)).data as HoursRow[],
  })
  const [hours, setHours] = useState<HoursRow[] | null>(null)
  useEffect(() => {
    if (rows) setHours(rows.map((r) => ({ ...r, starts_at: r.starts_at.slice(0, 5), ends_at: r.ends_at.slice(0, 5) })))
  }, [rows])
  const [saving, setSaving] = useState(false)

  const saveHours = async () => {
    if (!hours || !validHours(hours)) return toast('An end time is before its start', 'error')
    setSaving(true)
    try {
      await rpc('set_weekly_schedule', { p_barber_id: barber.id, p_rows: hours })
      qc.invalidateQueries({ queryKey: ['availability'] })
      toast('Schedule saved — online availability updated', 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Weekly hours" subtitle="Clients can only book inside these hours. Breaks are never bookable." action={<Button size="sm" loading={saving} onClick={saveHours}>Save</Button>} />
        <div className="px-5 pb-2">{hours && <HoursEditor value={hours} onChange={setHours} />}</div>
      </Card>
      <TimeOff barber={barber} />
      <BookingRules barber={barber} />
      <MyServices barber={barber} shopId={ws.shop_id} />
    </div>
  )
}

function TimeOff({ barber }: { barber: Barber }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const tz = ws.timezone
  const { data } = useQuery({
    queryKey: ['exceptions', barber.id],
    queryFn: async () => (await supabase.from('availability_exceptions').select('*').eq('barber_id', barber.id).gte('ends_at', new Date().toISOString()).order('starts_at')).data ?? [],
  })
  const [f, setF] = useState({ kind: 'vacation', from: todayInTz(tz), to: todayInTz(tz), allDay: true, start: '09:00', end: '18:00', note: '' })
  const add = async () => {
    try {
      const s = zonedToUtc(f.from, f.allDay ? '00:00' : f.start, tz)
      const e = f.allDay ? zonedToUtc(f.to, '23:59', tz) : zonedToUtc(f.to, f.end, tz)
      if (f.kind === 'extra_hours') {
        const { error } = await supabase.from('availability_exceptions').insert({ shop_id: ws.shop_id, barber_id: barber.id, kind: 'extra_hours', starts_at: s.toISOString(), ends_at: e.toISOString(), note: f.note || null })
        if (error) throw error
        toast('Extra hours added', 'success')
      } else {
        const r = await rpc<{ affected: string[] }>('mark_barber_unavailable', { p_barber_id: barber.id, p_starts_at: s.toISOString(), p_ends_at: e.toISOString(), p_kind: f.kind, p_note: f.note || null, p_cancel_affected: false })
        toast(r.affected.length ? `Saved. ${r.affected.length} booked appointment(s) fall in this time — move them from the calendar.` : 'Time off saved', r.affected.length ? 'error' : 'success')
      }
      qc.invalidateQueries({ queryKey: ['exceptions', barber.id] })
    } catch (err) {
      toast(friendlyError(err), 'error')
    }
  }
  const remove = async (id: string) => {
    const { error } = await supabase.from('availability_exceptions').delete().eq('id', id)
    if (error) toast(friendlyError(error), 'error')
    qc.invalidateQueries({ queryKey: ['exceptions', barber.id] })
  }
  return (
    <Card>
      <CardHeader title="Time off & schedule changes" subtitle="Vacation, days off, holidays — or extra hours on a specific date." />
      <div className="space-y-2 px-5 pt-4">
        {(data ?? []).map((x: any) => (
          <div key={x.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2 text-sm">
            <Badge tone={x.kind === 'extra_hours' ? 'success' : 'warning'}>{x.kind.replace('_', ' ')}</Badge>
            <span className="flex-1">{dateLabel(x.starts_at, tz)} {time(x.starts_at, tz)} → {dateLabel(x.ends_at, tz)} {time(x.ends_at, tz)}{x.note ? ` · ${x.note}` : ''}</span>
            <button aria-label="Remove" className="text-muted hover:text-danger" onClick={() => remove(x.id)}><Trash2 className="size-4" /></button>
          </div>
        ))}
      </div>
      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Type">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="vacation">Vacation</option>
            <option value="time_off">Day off</option>
            <option value="holiday">Holiday</option>
            <option value="sick">Sick</option>
            <option value="extra_hours">Extra hours (available)</option>
          </Select>
        </Field>
        <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></Field>
        <Field label="To"><Input type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Note"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <div className="sm:col-span-2 lg:col-span-4">
          <Toggle checked={f.allDay} onChange={(v) => setF({ ...f, allDay: v })} label="All day" />
          {!f.allDay && (
            <div className="mt-3 flex gap-2">
              <Input type="time" className="w-36" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
              <Input type="time" className="w-36" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
            </div>
          )}
        </div>
        <div><Button variant="secondary" icon={<Plus className="size-4" />} onClick={add}>Add</Button></div>
      </div>
    </Card>
  )
}

function BookingRules({ barber }: { barber: Barber }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [f, setF] = useState({ buffer: barber.buffer_minutes?.toString() ?? '', max: barber.max_daily_appointments?.toString() ?? '', sameDay: barber.same_day_booking, online: barber.accepts_online_booking })
  const save = async () => {
    try {
      await rpc('update_my_barber_profile', {
        p_barber_id: barber.id, p_title: barber.title, p_bio: barber.bio, p_specialties: barber.specialties, p_photo_url: barber.photo_url, p_instagram: barber.instagram,
        p_buffer_minutes: f.buffer === '' ? null : Number(f.buffer), p_max_daily_appointments: f.max === '' ? null : Number(f.max),
        p_same_day_booking: f.sameDay, p_accepts_online_booking: f.online,
      })
      qc.invalidateQueries({ queryKey: ['barbers'] })
      toast('Booking rules saved', 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  return (
    <Card>
      <CardHeader title="Booking rules" action={<Button size="sm" variant="secondary" onClick={save}>Save</Button>} />
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Buffer between clients" hint="Empty = shop default"><Input type="number" min={0} max={120} value={f.buffer} onChange={(e) => setF({ ...f, buffer: e.target.value })} placeholder="minutes" /></Field>
        <Field label="Max appointments per day" hint="Empty = unlimited"><Input type="number" min={1} value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} /></Field>
        <Toggle checked={f.online} onChange={(v) => setF({ ...f, online: v })} label="Accept online bookings" />
        <Toggle checked={f.sameDay} onChange={(v) => setF({ ...f, sameDay: v })} label="Allow same-day online bookings" />
      </div>
    </Card>
  )
}

function MyServices({ barber, shopId }: { barber: Barber; shopId: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { data: services } = useServices(shopId)
  const { data: bs } = useBarberServices(shopId)
  const mine = new Set((bs ?? []).filter((x) => x.barber_id === barber.id && x.is_active).map((x) => x.service_id))
  const toggle = async (id: string, on: boolean) => {
    const next = new Set(mine)
    if (on) next.add(id)
    else next.delete(id)
    try {
      await rpc('set_barber_services', { p_barber_id: barber.id, p_service_ids: [...next] })
      qc.invalidateQueries({ queryKey: ['barber_services', shopId] })
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  return (
    <Card>
      <CardHeader title="Services I perform" />
      <div className="divide-y divide-line px-5 pb-2 pt-2">
        {services?.filter((s) => s.is_active).map((s) => (
          <div key={s.id} className="py-3"><Toggle checked={mine.has(s.id)} onChange={(v) => toggle(s.id, v)} label={s.name} /></div>
        ))}
      </div>
    </Card>
  )
}
