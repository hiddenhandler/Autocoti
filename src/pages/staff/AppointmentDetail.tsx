import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { APPT_SELECT, useBarbers } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import type { Appointment } from '@/lib/types'
import { dateLabel, fullName, minutes, money, time } from '@/lib/format'
import { AppointmentSheet, scheduledMinutes, serviceLabel } from '@/components/appointments'
import { Badge, Button, Card, CardHeader, EmptyState, Skeleton, StatusBadge, STATUS_LABEL } from '@/components/ui'

export default function AppointmentDetail() {
  const { id } = useParams()
  const { ws, can } = useWorkspace()
  const tz = ws.timezone
  const [open, setOpen] = useState(false)
  const { data: barbers } = useBarbers(ws.shop_id, { includeArchived: true })
  const { data: a, isLoading } = useQuery({
    queryKey: ['appointment', id, 'detail'],
    queryFn: async () => (await supabase.from('appointments').select(APPT_SELECT).eq('id', id!).maybeSingle()).data as Appointment | null,
  })
  const { data: history } = useQuery({
    queryKey: ['appointment', id, 'history'],
    queryFn: async () => (await supabase.from('appointment_status_history').select('*').eq('appointment_id', id!).order('changed_at')).data ?? [],
  })
  const { data: payments } = useQuery({
    queryKey: ['appointment', id, 'payments'],
    queryFn: async () => (await supabase.from('payments').select('*, items:payment_items(*), refunds(*)').eq('appointment_id', id!).order('paid_at')).data ?? [],
  })
  const { data: audit } = useQuery({
    queryKey: ['appointment', id, 'audit'],
    enabled: can('audit.view'),
    queryFn: async () => (await supabase.from('audit_logs').select('*').eq('entity', 'appointments').eq('entity_id', id!).order('created_at')).data ?? [],
  })
  if (isLoading) return <Skeleton className="h-96" />
  if (!a) return <EmptyState title="Appointment not found" />
  const barber = barbers?.find((b) => b.id === a.barber_id)

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link to="/app/appointments" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Appointments</Link>
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="display text-4xl">{a.kind === 'appointment' ? fullName(a.client) : a.title}</h1>
            <p className="mt-1 text-muted">{serviceLabel(a)} · {barber?.display_name}</p>
            <p className="mt-3 font-semibold">{dateLabel(a.starts_at, tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · {time(a.starts_at, tz)}–{time(a.ends_at, tz)}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <StatusBadge status={a.status} />
            <Badge>{a.payment_status}</Badge>
            <Button size="sm" onClick={() => setOpen(true)}>Actions</Button>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div><div className="eyebrow">Booked</div><div className="mt-1">{minutes(scheduledMinutes(a))}</div></div>
          <div><div className="eyebrow">Actual</div><div className="mt-1">{a.actual_duration_seconds ? minutes(a.actual_duration_seconds / 60) : '—'}</div></div>
          <div><div className="eyebrow">Price</div><div className="mt-1">{money(a.expected_price_cents)}</div></div>
          <div><div className="eyebrow">Source</div><div className="mt-1 capitalize">{a.source.replace('_', ' ')}</div></div>
        </div>
        {a.client && <Link to={`/app/clients/${a.client.id}`} className="mt-5 inline-block text-sm font-semibold hover:underline">View client profile →</Link>}
      </Card>

      <Card>
        <CardHeader title="Payments" />
        <div className="p-5">
          {!payments?.length ? <p className="text-sm text-muted">No payment recorded.</p> : payments.map((p: any) => (
            <div key={p.id} className="mb-3 rounded-xl border border-line p-4 text-sm last:mb-0">
              <div className="flex justify-between"><span className="font-semibold capitalize">{p.kind.replace(/_/g, ' ')} · {p.method}</span><Badge tone={p.status === 'PAID' ? 'success' : 'warning'}>{p.status}</Badge></div>
              <div className="mt-2 space-y-1 tnum text-muted">
                {p.items.map((i: any) => <div key={i.id} className="flex justify-between"><span>{i.description}</span><span>{money(i.total_cents)}</span></div>)}
                {p.discount_cents > 0 && <div className="flex justify-between"><span>Discount</span><span>−{money(p.discount_cents)}</span></div>}
                {p.tax_cents > 0 && <div className="flex justify-between"><span>Tax</span><span>{money(p.tax_cents)}</span></div>}
                {p.tip_cents > 0 && <div className="flex justify-between"><span>Tip</span><span>{money(p.tip_cents)}</span></div>}
                <div className="flex justify-between font-semibold text-ink"><span>Total</span><span>{money(p.total_cents)}</span></div>
                {p.refunds.map((r: any) => <div key={r.id} className="flex justify-between text-danger"><span>Refund · {r.reason}</span><span>−{money(r.amount_cents)}</span></div>)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Status history" />
        <ol className="space-y-3 p-5 text-sm">
          {history?.map((h: any) => (
            <li key={h.id} className="flex justify-between gap-3"><span>{h.from_status ? `${STATUS_LABEL[h.from_status]} → ` : ''}<b>{STATUS_LABEL[h.to_status]}</b></span><span className="text-muted">{dateLabel(h.changed_at, tz)} {time(h.changed_at, tz)}</span></li>
          ))}
        </ol>
      </Card>

      {can('audit.view') && !!audit?.length && (
        <Card>
          <CardHeader title="Audit trail" subtitle="Every change, who made it and from where" />
          <ol className="space-y-3 p-5 text-sm">
            {audit.map((l: any) => (
              <li key={l.id}>
                <div className="flex justify-between"><span className="font-medium capitalize">{l.action}</span><span className="text-muted">{dateLabel(l.created_at, tz)} {time(l.created_at, tz)}</span></div>
                {l.changes && <div className="mt-1 text-xs text-muted">{Object.entries(l.changes).map(([k, v]: any) => `${k}: ${JSON.stringify(v[0])} → ${JSON.stringify(v[1])}`).join(' · ')}</div>}
              </li>
            ))}
          </ol>
        </Card>
      )}
      <AppointmentSheet appt={open ? a : null} onClose={() => setOpen(false)} />
    </div>
  )
}
