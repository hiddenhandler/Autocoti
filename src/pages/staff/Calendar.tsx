import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Ban, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useAppointments, useBarbers } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { addDays, dateInTz, minutesOfDay, minutesToTime, startOfWeek, todayInTz, weekdayOf, zonedToUtc, type DateStr } from '@/lib/time'
import { dateStrLabel, fullName, minutes, money, relativeDateStr, time } from '@/lib/format'
import type { Appointment, Barber } from '@/lib/types'
import { AppointmentSheet, BlockTimeSheet, NewAppointmentSheet, scheduledMinutes, serviceLabel, useInvalidateCalendar } from '@/components/appointments'
import { Avatar, Button, Chip, cx, EmptyState, IconButton, Segmented, Skeleton, StatusDot, STATUS_LABEL, useToast } from '@/components/ui'
import { errorCode, friendlyError } from '@/lib/errors'

const PX_PER_MIN = 1.6
const SNAP = 5

interface Column {
  key: string
  date: DateStr
  barber: Barber
  label: string
  sub?: string
}

export default function Calendar() {
  const { ws, can } = useWorkspace()
  const tz = ws.timezone
  const [params, setParams] = useSearchParams()
  const date = (params.get('date') as DateStr) ?? todayInTz(tz)
  const allCalendar = can('calendar.all')
  const { data: barbersAll } = useBarbers(ws.shop_id)
  const barbers = useMemo(() => (barbersAll ?? []).filter((b) => b.status === 'active' && (allCalendar || b.id === ws.barber_id)), [barbersAll, allCalendar, ws.barber_id])
  const [view, setView] = useState<'day' | 'week'>(() => (allCalendar ? 'day' : 'week'))
  const [focusBarber, setFocusBarber] = useState<string | null>(allCalendar ? null : ws.barber_id)
  const [selected, setSelected] = useState<Appointment | null>(null)
  const [newAt, setNewAt] = useState<{ barberId?: string; date?: string; time?: string } | null>(params.get('new') ? {} : null)
  const [blockAt, setBlockAt] = useState<{ barberId?: string; date?: string; time?: string } | null>(null)

  const effectiveView = view === 'week' && (focusBarber || barbers.length === 1) ? 'week' : 'day'
  const weekStart = startOfWeek(date)
  const rangeFrom = effectiveView === 'week' ? weekStart : date
  const rangeTo = effectiveView === 'week' ? addDays(weekStart, 7) : addDays(date, 1)
  const fromIso = zonedToUtc(rangeFrom, '00:00', tz).toISOString()
  const toIso = zonedToUtc(rangeTo, '00:00', tz).toISOString()
  const { data: appts, isLoading } = useAppointments(ws.shop_id, fromIso, toIso, { barberId: allCalendar ? null : ws.barber_id })

  const shown = focusBarber ? barbers.filter((b) => b.id === focusBarber) : barbers
  const columns: Column[] = effectiveView === 'week'
    ? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).map((d) => ({ key: d, date: d, barber: shown[0], label: dateStrLabel(d, { weekday: 'short' }), sub: String(Number(d.slice(8))) }))
    : shown.map((b) => ({ key: b.id, date, barber: b, label: b.display_name }))

  // Availability to shade non-working time.
  const barberIds = shown.map((b) => b.id)
  const { data: avail } = useQuery({
    queryKey: ['availability', ws.shop_id, barberIds.join(), fromIso],
    enabled: barberIds.length > 0,
    queryFn: async () => {
      const [{ data: rows }, { data: exc }, { data: hours }] = await Promise.all([
        supabase.from('availability').select('*').in('barber_id', barberIds),
        supabase.from('availability_exceptions').select('*').eq('shop_id', ws.shop_id).lt('starts_at', toIso).gt('ends_at', fromIso),
        supabase.from('business_hours').select('*').eq('shop_id', ws.shop_id),
      ])
      return { rows: rows ?? [], exc: exc ?? [], hours: hours ?? [] }
    },
  })
  const [startMin, endMin] = useMemo(() => {
    const times = [...(avail?.rows ?? []).map((r) => [r.starts_at, r.ends_at]), ...(avail?.hours ?? []).map((h) => [h.opens_at, h.closes_at])].flat() as string[]
    const mins = times.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)))
    const apptMins = (appts ?? []).flatMap((a) => [minutesOfDay(a.starts_at, tz), minutesOfDay(a.ends_at, tz) || 24 * 60])
    const lo = Math.min(9 * 60, ...mins, ...apptMins)
    const hi = Math.max(19 * 60, ...mins, ...apptMins)
    return [Math.max(0, Math.floor(lo / 60) * 60 - 60), Math.min(24 * 60, Math.ceil(hi / 60) * 60 + 30)]
  }, [avail, appts, tz])

  const go = (d: DateStr) => {
    const next = new URLSearchParams(params)
    next.set('date', d)
    next.delete('new')
    setParams(next, { replace: true })
  }
  const step = effectiveView === 'week' ? 7 : 1

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="display mr-2 text-[34px] leading-none">{effectiveView === 'week' ? `Week of ${dateStrLabel(weekStart, { month: 'short', day: 'numeric' })}` : relativeDateStr(date, tz)}</h1>
        <div className="flex items-center gap-1">
          <IconButton label="Previous" onClick={() => go(addDays(date, -step))}><ChevronLeft className="size-5" /></IconButton>
          <Button size="sm" variant="secondary" onClick={() => go(todayInTz(tz))}>Today</Button>
          <IconButton label="Next" onClick={() => go(addDays(date, step))}><ChevronRight className="size-5" /></IconButton>
          <input type="date" aria-label="Pick date" value={date} onChange={(e) => e.target.value && go(e.target.value)} className="ml-1 h-8 rounded-lg border border-line bg-surface px-2 text-sm" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} />
          <Button size="sm" variant="secondary" icon={<Ban className="size-4" />} onClick={() => setBlockAt({ barberId: focusBarber ?? undefined, date })}>Block</Button>
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setNewAt({ barberId: focusBarber ?? undefined, date })}>New</Button>
        </div>
      </div>

      {allCalendar && barbers.length > 1 && (
        <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4">
          <Chip active={!focusBarber} onClick={() => setFocusBarber(null)}>All barbers</Chip>
          {barbers.map((b) => (
            <Chip key={b.id} active={focusBarber === b.id} onClick={() => setFocusBarber(focusBarber === b.id ? null : b.id)}>{b.display_name}</Chip>
          ))}
        </div>
      )}
      {view === 'week' && effectiveView === 'day' && <p className="mb-3 text-xs text-muted">Pick one barber to see their week.</p>}

      {isLoading ? <Skeleton className="h-[60vh]" /> : columns.length === 0 ? (
        <EmptyState title="No active barbers" body="Add a barber to start taking bookings." />
      ) : (
        <>
          <div className="hidden lg:block">
            <Grid columns={columns} appts={appts ?? []} startMin={startMin} endMin={endMin} avail={avail} tz={tz} week={effectiveView === 'week'}
              onSelect={setSelected} onEmpty={(c, t) => setNewAt({ barberId: c.barber.id, date: c.date, time: t })} />
          </div>
          <div className="lg:hidden">
            <Agenda columns={columns} appts={appts ?? []} tz={tz} onSelect={setSelected} week={effectiveView === 'week'} />
          </div>
        </>
      )}

      <AppointmentSheet appt={selected} onClose={() => setSelected(null)} />
      <NewAppointmentSheet open={!!newAt} onClose={() => setNewAt(null)} defaults={newAt ?? undefined} />
      <BlockTimeSheet open={!!blockAt} onClose={() => setBlockAt(null)} defaults={blockAt ?? undefined} />
    </div>
  )
}

type Avail = { rows: { barber_id: string; weekday: number; starts_at: string; ends_at: string; kind: string }[]; exc: { barber_id: string | null; kind: string; starts_at: string; ends_at: string; note: string | null }[]; hours: { weekday: number; opens_at: string; closes_at: string }[] }

function openWindows(avail: Avail | undefined, barberId: string, date: DateStr): { work: [number, number][]; breaks: [number, number][] } {
  if (!avail) return { work: [], breaks: [] }
  const wd = weekdayOf(date)
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const own = avail.rows.filter((r) => r.barber_id === barberId)
  const work = own.some((r) => r.kind === 'work')
    ? own.filter((r) => r.kind === 'work' && r.weekday === wd).map((r) => [toMin(r.starts_at), toMin(r.ends_at)] as [number, number])
    : avail.hours.filter((h) => h.weekday === wd).map((h) => [toMin(h.opens_at), toMin(h.closes_at)] as [number, number])
  const breaks = own.filter((r) => r.kind === 'break' && r.weekday === wd).map((r) => [toMin(r.starts_at), toMin(r.ends_at)] as [number, number])
  return { work, breaks }
}

function Grid({ columns, appts, startMin, endMin, avail, tz, week, onSelect, onEmpty }: {
  columns: Column[]; appts: Appointment[]; startMin: number; endMin: number; avail: Avail | undefined; tz: string; week: boolean
  onSelect: (a: Appointment) => void; onEmpty: (c: Column, time: string) => void
}) {
  const { can } = useWorkspace()
  const toast = useToast()
  const invalidate = useInvalidateCalendar()
  const height = (endMin - startMin) * PX_PER_MIN
  const scroller = useRef<HTMLDivElement>(null)
  const colRefs = useRef<(HTMLDivElement | null)[]>([])
  const [drag, setDrag] = useState<null | { appt: Appointment; dy: number; col: number; origCol: number; moved: boolean }>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    const nowMin = minutesOfDay(new Date(), tz)
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (nowMin - startMin - 90) * PX_PER_MIN)
  }, [startMin, tz])

  const colFor = (a: Appointment) => columns.findIndex((c) => c.barber.id === a.barber_id && c.date === dateInTz(a.starts_at, tz))

  const onPointerDown = (e: React.PointerEvent, a: Appointment) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    if (!['BOOKED', 'CONFIRMED', 'CHECKED_IN'].includes(a.status)) return onSelect(a)
    const startY = e.clientY
    const origCol = colFor(a)
    let state = { appt: a, dy: 0, col: origCol, origCol, moved: false }
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      const col = colRefs.current.findIndex((el) => { if (!el) return false; const r = el.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX < r.right })
      state = { ...state, dy, col: col === -1 ? state.col : col, moved: state.moved || Math.abs(dy) > 4 || col !== origCol }
      setDrag(state)
    }
    const up = async () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (!state.moved) return onSelect(a)
      const deltaMin = Math.round(state.dy / PX_PER_MIN / SNAP) * SNAP
      const target = columns[state.col]
      const startMinLocal = minutesOfDay(a.starts_at, tz) + deltaMin
      if (startMinLocal < 0 || startMinLocal >= 24 * 60) return
      const newStart = zonedToUtc(target.date, minutesToTime(startMinLocal), tz).toISOString()
      const args = { p_appointment_id: a.id, p_new_start: newStart, p_new_barber_id: target.barber.id, p_force: false }
      try {
        await rpc('move_appointment', args)
        toast(`Moved to ${time(newStart, tz)}`, 'success')
      } catch (err) {
        if (errorCode(err) === 'SLOT_TAKEN' && can('schedule.manage_all') && confirm('That time is outside normal availability or too tight. Move it anyway?')) {
          try {
            await rpc('move_appointment', { ...args, p_force: true })
            toast(`Moved to ${time(newStart, tz)}`, 'success')
          } catch (err2) {
            toast(friendlyError(err2), 'error')
          }
        } else toast(friendlyError(err), 'error')
      }
      invalidate()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const hours: number[] = []
  for (let m = Math.ceil(startMin / 60) * 60; m < endMin; m += 60) hours.push(m)
  const today = todayInTz(tz)
  const nowMin = minutesOfDay(new Date(now), tz)

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="grid border-b border-line" style={{ gridTemplateColumns: `64px repeat(${columns.length}, minmax(140px, 1fr))` }}>
        <div />
        {columns.map((c) => (
          <div key={c.key} className={cx('flex items-center gap-2 border-l border-line px-3 py-3', week && c.date === today && 'bg-accent-soft')}>
            {week ? (
              <div className="text-sm"><span className="text-muted">{c.label}</span> <span className="font-semibold">{c.sub}</span></div>
            ) : (
              <>
                <Avatar name={c.barber.display_name} src={c.barber.photo_url} size={28} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{c.label}</div>
                  <div className="text-[11px] text-muted">{appts.filter((a) => a.barber_id === c.barber.id && a.kind === 'appointment' && a.status !== 'CANCELLED').length} appts</div>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div ref={scroller} className="max-h-[calc(100dvh-240px)] overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: `64px repeat(${columns.length}, minmax(140px, 1fr))`, height }}>
          <div className="relative">
            {hours.map((m) => (
              <div key={m} className="absolute right-2 -translate-y-1/2 text-[11px] text-faint tnum" style={{ top: (m - startMin) * PX_PER_MIN }}>
                {new Date(2000, 0, 1, m / 60).toLocaleTimeString(undefined, { hour: 'numeric' })}
              </div>
            ))}
          </div>
          {columns.map((c, ci) => {
            const { work, breaks } = openWindows(avail, c.barber.id, c.date)
            const dayStart = zonedToUtc(c.date, '00:00', tz).getTime()
            const exc = (avail?.exc ?? []).filter((e) => (e.barber_id === null || e.barber_id === c.barber.id) && e.kind !== 'extra_hours')
            const colAppts = appts.filter((a) => a.barber_id === c.barber.id && dateInTz(a.starts_at, tz) === c.date)
            return (
              <div key={c.key} ref={(el) => { colRefs.current[ci] = el }} className="relative border-l border-line"
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return
                  const y = e.nativeEvent.offsetY
                  const m = Math.floor((startMin + y / PX_PER_MIN) / 15) * 15
                  onEmpty(c, minutesToTime(m))
                }}>
                {/* closed time shading */}
                <div className="pointer-events-none absolute inset-0" style={{ background: 'repeating-linear-gradient(135deg, transparent 0 7px, color-mix(in oklab, var(--text) 4%, transparent) 7px 8px)' }} />
                {work.map(([s, e], i) => (
                  <div key={i} className="pointer-events-none absolute inset-x-0 bg-surface" style={{ top: (s - startMin) * PX_PER_MIN, height: (e - s) * PX_PER_MIN }} />
                ))}
                {[...breaks.map(([s, e]) => ({ s, e, label: 'Break' })),
                  ...exc.map((x) => ({ s: Math.max(0, (new Date(x.starts_at).getTime() - dayStart) / 60000), e: Math.min(24 * 60, (new Date(x.ends_at).getTime() - dayStart) / 60000), label: x.note ?? x.kind.replace('_', ' ') }))]
                  .filter((b) => b.e > b.s)
                  .map((b, i) => (
                    <div key={`b${i}`} className="pointer-events-none absolute inset-x-0 flex items-start justify-center pt-1 text-[10px] font-semibold uppercase tracking-wider text-faint"
                      style={{ top: (b.s - startMin) * PX_PER_MIN, height: (b.e - b.s) * PX_PER_MIN, background: 'repeating-linear-gradient(135deg, var(--surface-2) 0 6px, var(--surface) 6px 12px)' }}>
                      {b.label}
                    </div>
                  ))}
                {hours.map((m) => <div key={m} className="pointer-events-none absolute inset-x-0 border-t border-line/70" style={{ top: (m - startMin) * PX_PER_MIN }} />)}
                {colAppts.map((a) => {
                  const top = (minutesOfDay(a.starts_at, tz) - startMin) * PX_PER_MIN
                  const h = Math.max(22, scheduledMinutes(a) * PX_PER_MIN - 2)
                  const dragging = drag?.appt.id === a.id
                  return (
                    <AppointmentBlock key={a.id} appt={a} tz={tz} top={top} height={h}
                      style={dragging ? { transform: `translateY(${drag.dy}px)`, opacity: 0.85, zIndex: 20, left: drag.col !== ci ? `${(drag.col - ci) * 100}%` : undefined } : undefined}
                      onPointerDown={(e) => onPointerDown(e, a)} onKey={() => onSelect(a)} />
                  )
                })}
                {c.date === today && nowMin >= startMin && nowMin <= endMin && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: (nowMin - startMin) * PX_PER_MIN }}>
                    <span className="-ml-1 size-2 rounded-full bg-danger" />
                    <span className="h-px flex-1 bg-danger" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const BLOCK_STYLE: Record<string, string> = {
  BOOKED: 'border-l-info bg-info/10',
  CONFIRMED: 'border-l-accent bg-accent-soft',
  CHECKED_IN: 'border-l-warning bg-warning/12',
  IN_SERVICE: 'border-l-success bg-success/14',
  COMPLETED: 'border-l-faint bg-surface-2 opacity-75',
  NO_SHOW: 'border-l-danger bg-danger/8 opacity-70 line-through',
  CANCELLED: 'border-l-danger bg-danger/5 opacity-50',
}

function AppointmentBlock({ appt: a, tz, top, height, style, onPointerDown, onKey }: {
  appt: Appointment; tz: string; top: number; height: number; style?: React.CSSProperties
  onPointerDown: (e: React.PointerEvent) => void; onKey: () => void
}) {
  const isBlock = a.kind !== 'appointment'
  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => e.key === 'Enter' && onKey()}
      onClick={(e) => { if ((e.nativeEvent as PointerEvent).pointerType !== 'mouse') onKey() }}
      className={cx(
        'absolute inset-x-1 cursor-pointer select-none overflow-hidden rounded-lg border-l-[3px] px-2 py-1 text-left shadow-sm transition-shadow hover:shadow-md',
        isBlock ? 'border-l-faint bg-surface-3 text-muted' : BLOCK_STYLE[a.status] ?? 'bg-surface-2',
      )}
      style={{ top, height, ...style }}
      title={`${a.kind === 'appointment' ? fullName(a.client) : a.title} · ${STATUS_LABEL[a.status]}`}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-semibold leading-tight">
        {!isBlock && <StatusDot status={a.status} />}
        <span className="truncate">{isBlock ? a.title ?? a.kind : fullName(a.client)}</span>
      </div>
      {height > 36 && (
        <div className="truncate text-[11px] text-muted">
          {time(a.starts_at, tz)} · {isBlock ? minutes(scheduledMinutes(a)) : serviceLabel(a)}
        </div>
      )}
      {height > 56 && !isBlock && <div className="text-[11px] font-semibold text-muted tnum">{money(a.expected_price_cents)}{a.payment_status === 'PAID' ? ' · paid' : ''}</div>}
    </div>
  )
}

function Agenda({ columns, appts, tz, onSelect, week }: { columns: Column[]; appts: Appointment[]; tz: string; onSelect: (a: Appointment) => void; week: boolean }) {
  const barberIds = new Set(columns.map((c) => c.barber.id))
  const days = [...new Set(columns.map((c) => c.date))]
  return (
    <div className="space-y-6">
      {days.map((d) => {
        const list = appts.filter((a) => barberIds.has(a.barber_id) && dateInTz(a.starts_at, tz) === d).sort((x, y) => x.starts_at.localeCompare(y.starts_at))
        return (
          <section key={d}>
            {week && <div className="eyebrow mb-2">{relativeDateStr(d, tz)}</div>}
            {list.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Nothing booked</p>
            ) : (
              <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                {list.map((a) => {
                  const barber = columns.find((c) => c.barber.id === a.barber_id)?.barber
                  return (
                    <button key={a.id} onClick={() => onSelect(a)} className={cx('flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2', ['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(a.status) && 'opacity-55')}>
                      <div className="w-14 shrink-0">
                        <div className="text-sm font-semibold tnum">{time(a.starts_at, tz)}</div>
                        <div className="text-[11px] text-muted">{minutes(scheduledMinutes(a))}</div>
                      </div>
                      <StatusDot status={a.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{a.kind === 'appointment' ? fullName(a.client) : a.title}</div>
                        <div className="truncate text-xs text-muted">{a.kind === 'appointment' ? serviceLabel(a) : a.kind}{columns.length > 1 && !week ? ` · ${barber?.display_name}` : ''}</div>
                      </div>
                      {a.kind === 'appointment' && <div className="text-sm font-semibold tnum">{money(a.expected_price_cents)}</div>}
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
