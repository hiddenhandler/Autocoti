import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Download, Plus } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { APPT_SELECT, useBarbers } from '@/lib/api'
import { must, supabase } from '@/lib/supabase'
import { addDays, todayInTz, zonedToUtc } from '@/lib/time'
import { dateLabel, fullName, money, time } from '@/lib/format'
import type { Appointment } from '@/lib/types'
import { downloadCsv } from '@/lib/csv'
import { AppointmentSheet, NewAppointmentSheet, serviceLabel } from '@/components/appointments'
import { Badge, Button, Card, Chip, EmptyState, Input, PageHeader, Select, Skeleton, StatusBadge } from '@/components/ui'

const FILTERS: Record<string, { label: string; status?: string[] }> = {
  upcoming: { label: 'Upcoming' },
  today: { label: 'Today' },
  past: { label: 'Past 30 days' },
  stale: { label: 'Needs closing' },
  unpaid: { label: 'Unpaid' },
  fees: { label: 'Fees' },
  cancelled: { label: 'Cancelled' },
}

export default function Appointments() {
  const { ws } = useWorkspace()
  const tz = ws.timezone
  const [params, setParams] = useSearchParams()
  const filter = params.get('filter') ?? 'upcoming'
  const [barberId, setBarberId] = useState('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Appointment | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const { data: barbers } = useBarbers(ws.shop_id)

  const { data, isLoading } = useQuery({
    queryKey: ['appointments', ws.shop_id, 'list', filter, barberId],
    queryFn: async () => {
      const today = todayInTz(tz)
      const now = new Date().toISOString()
      let query = supabase.from('appointments').select(APPT_SELECT).eq('shop_id', ws.shop_id).is('deleted_at', null).eq('kind', 'appointment').neq('status', 'RESCHEDULED')
      if (barberId) query = query.eq('barber_id', barberId)
      switch (filter) {
        case 'upcoming': query = query.gte('starts_at', now).in('status', ['BOOKED', 'CONFIRMED', 'CHECKED_IN']).order('starts_at').limit(300); break
        case 'today': query = query.gte('starts_at', zonedToUtc(today, '00:00', tz).toISOString()).lt('starts_at', zonedToUtc(addDays(today, 1), '00:00', tz).toISOString()).order('starts_at'); break
        case 'past': query = query.gte('starts_at', zonedToUtc(addDays(today, -30), '00:00', tz).toISOString()).lt('starts_at', now).order('starts_at', { ascending: false }).limit(500); break
        case 'stale': query = query.lt('ends_at', new Date(Date.now() - 3600e3).toISOString()).in('status', ['BOOKED', 'CONFIRMED', 'CHECKED_IN']).gte('starts_at', zonedToUtc(addDays(today, -14), '00:00', tz).toISOString()).order('starts_at'); break
        case 'unpaid': query = query.eq('status', 'COMPLETED').eq('payment_status', 'UNPAID').order('starts_at', { ascending: false }).limit(300); break
        case 'fees': query = query.gt('fee_cents', 0).order('starts_at', { ascending: false }).limit(300); break
        case 'cancelled': query = query.in('status', ['CANCELLED', 'NO_SHOW']).gte('starts_at', zonedToUtc(addDays(today, -60), '00:00', tz).toISOString()).order('starts_at', { ascending: false }).limit(300); break
      }
      return must(await query) as Appointment[]
    },
  })
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (data ?? []).filter((a) => !needle || fullName(a.client).toLowerCase().includes(needle) || (a.client?.phone ?? '').includes(needle))
  }, [data, q])
  const barberName = (id: string) => barbers?.find((b) => b.id === id)?.display_name ?? ''

  return (
    <div>
      <PageHeader title="Appointments" actions={
        <>
          <Button variant="secondary" icon={<Download className="size-4" />} disabled={!rows.length} onClick={() => downloadCsv(`appointments-${filter}.csv`, rows.map((a) => ({
            date: dateLabel(a.starts_at, tz, { year: 'numeric', month: '2-digit', day: '2-digit' }), time: time(a.starts_at, tz), client: fullName(a.client), phone: a.client?.phone ?? '',
            barber: barberName(a.barber_id), service: serviceLabel(a), status: a.status, source: a.source, price: (a.expected_price_cents / 100).toFixed(2), payment: a.payment_status,
            actual_minutes: a.actual_duration_seconds ? Math.round(a.actual_duration_seconds / 60) : '',
          })))}>CSV</Button>
          <Button icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)}>New</Button>
        </>
      } />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {Object.entries(FILTERS).map(([k, f]) => <Chip key={k} active={filter === k} onClick={() => setParams({ filter: k })}>{f.label}</Chip>)}
        </div>
        <div className="ml-auto flex gap-2">
          <Input className="h-9 w-48" placeholder="Search client…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select className="h-9 w-40" value={barberId} onChange={(e) => setBarberId(e.target.value)}>
            <option value="">All barbers</option>
            {barbers?.map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}
          </Select>
        </div>
      </div>
      {isLoading ? <Skeleton className="h-96" /> : rows.length === 0 ? (
        <Card><EmptyState title="Nothing here" body={filter === 'stale' ? 'Every past appointment has been closed out.' : filter === 'unpaid' ? 'Every completed cut has a payment recorded.' : 'No appointments match.'} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
                <tr><th className="px-5 py-3 font-semibold">When</th><th className="px-3 py-3 font-semibold">Client</th><th className="px-3 py-3 font-semibold">Service</th><th className="px-3 py-3 font-semibold">Barber</th><th className="px-3 py-3 font-semibold">Status</th><th className="px-5 py-3 text-right font-semibold">Price</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((a) => (
                  <tr key={a.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setSel(a)}>
                    <td className="whitespace-nowrap px-5 py-3"><div className="font-medium">{dateLabel(a.starts_at, tz)}</div><div className="text-xs text-muted tnum">{time(a.starts_at, tz)}</div></td>
                    <td className="px-3 py-3"><div className="font-medium">{fullName(a.client)}</div><div className="text-xs text-muted">{a.client?.phone}</div></td>
                    <td className="px-3 py-3">{serviceLabel(a)}{a.source === 'walk_in' && <Badge tone="info" className="ml-2">Walk-in</Badge>}</td>
                    <td className="px-3 py-3">{barberName(a.barber_id)}</td>
                    <td className="px-3 py-3"><StatusBadge status={a.status} />{a.fee_cents > 0 && <Badge tone="danger" className="ml-1">Fee {money(a.fee_cents)}</Badge>}</td>
                    <td className="px-5 py-3 text-right tnum"><div className="font-semibold">{money(a.expected_price_cents)}</div><div className="text-xs text-muted">{a.status === 'COMPLETED' ? a.payment_status : ''}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <AppointmentSheet appt={sel} onClose={() => setSel(null)} />
      <NewAppointmentSheet open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  )
}
