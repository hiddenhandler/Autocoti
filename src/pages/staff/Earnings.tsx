import { Navigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Wallet } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useAnalytics } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { money, minutes, pct, dateStrLabel, relativeDay, time } from '@/lib/format'
import { zonedToUtc, addDays } from '@/lib/time'
import { RangePicker, useRange } from '@/components/RangePicker'
import { AreaChart, BarList } from '@/components/charts'
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton, Stat } from '@/components/ui'

export default function Earnings() {
  const { ws } = useWorkspace()
  if (!ws.barber_id) return <Navigate to="/app" replace />
  return <BarberEarnings barberId={ws.barber_id} />
}

function describeCommission(c: any): string {
  if (!c) return 'No commission plan set — ask the owner'
  switch (c.type) {
    case 'percentage': return `${c.percent_bps / 100}% of service revenue`
    case 'fixed': return `${money(c.fixed_cents)} per service`
    case 'tiered': return `Tiered: ${(c.tiers as any[]).map((t) => `${t.percent_bps / 100}%${t.up_to_cents ? ` up to ${money(t.up_to_cents, { cents: false })}` : ' above'}`).join(', ')} (monthly)`
    case 'booth_rental': return `Booth rental · ${money(c.rent_cents)}/${c.rent_period} · you keep 100%`
    case 'hybrid': return `${c.percent_bps / 100}% + ${money(c.rent_cents)}/${c.rent_period} rent`
  }
  return c.type
}

export function BarberEarnings({ barberId, embedded }: { barberId: string; embedded?: boolean }) {
  const { ws } = useWorkspace()
  const { key, setKey, range, custom, setCustom } = useRange(ws.timezone, 'today')
  const { data: a, isLoading } = useAnalytics(ws.shop_id, range.from, range.to, barberId)
  const me = a?.barbers.find((b) => b.barber_id === barberId)
  const { data: plan } = useQuery({
    queryKey: ['commission', barberId],
    queryFn: async () => (await supabase.from('commissions').select('*').eq('barber_id', barberId).is('effective_to', null).maybeSingle()).data,
  })
  const { data: payments } = useQuery({
    queryKey: ['my-payments', barberId, range.from, range.to],
    queryFn: async () =>
      (await supabase.from('payments').select('id, paid_at, subtotal_cents, discount_cents, tip_cents, total_cents, method, status, client:clients(first_name, last_name)')
        .eq('barber_id', barberId).gte('paid_at', zonedToUtc(range.from, '00:00', ws.timezone).toISOString())
        .lt('paid_at', zonedToUtc(addDays(range.to, 1), '00:00', ws.timezone).toISOString()).order('paid_at', { ascending: false }).limit(100)).data ?? [],
  })
  const takeHome = me ? (me.commission_cents ?? 0) + (me.tips_cents ?? 0) : 0

  return (
    <div>
      {!embedded && <PageHeader eyebrow="Your money" title="Earnings" actions={<RangePicker value={key} onChange={setKey} custom={custom} onCustom={setCustom} keys={['today', '7d', '30d', 'mtd', 'custom']} />} />}
      {embedded && <div className="mb-4"><RangePicker value={key} onChange={setKey} custom={custom} onCustom={setCustom} keys={['today', '7d', '30d', 'mtd', 'custom']} /></div>}
      {isLoading ? <Skeleton className="h-64" /> : !me ? (
        <Card><EmptyState icon={<Wallet className="size-6" />} title="No earnings data" /></Card>
      ) : (
        <div className="space-y-4">
          <Card className="p-6">
            <div className="eyebrow">Estimated take-home</div>
            <div className="mt-2 text-[44px] font-semibold leading-none tnum">{money(takeHome)}</div>
            <div className="mt-2 text-sm text-muted">{money(me.commission_cents)} commission + {money(me.tips_cents)} tips · {describeCommission(plan)}</div>
          </Card>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Card className="p-5"><Stat label="Cuts" value={me.cuts} sub={`${me.bookings} booked`} /></Card>
            <Card className="p-5"><Stat label="Revenue generated" value={money(me.net_revenue_cents)} /></Card>
            <Card className="p-5"><Stat label="Tips" value={money(me.tips_cents)} /></Card>
            <Card className="p-5"><Stat label="Average ticket" value={money(me.avg_ticket_cents)} /></Card>
            <Card className="p-5"><Stat label="Average cut" value={me.avg_cut_minutes ? minutes(me.avg_cut_minutes) : '—'} sub={me.avg_scheduled_minutes ? `booked ${minutes(me.avg_scheduled_minutes)}` : 'Use START/COMPLETE CUT'} /></Card>
            <Card className="p-5"><Stat label="Rebooking" value={pct(me.rebooking_rate)} sub={`${me.clients_served} clients · ${me.new_clients} new`} /></Card>
          </div>
          {a!.series.length > 1 && (
            <Card>
              <CardHeader title="Revenue by day" subtitle="Net service revenue you generated" />
              <div className="p-4"><AreaChart ariaLabel="Revenue by day" data={a!.series.map((s) => ({ label: dateStrLabel(s.date, { month: 'short', day: 'numeric' }), value: s.revenue_cents }))} format={(v) => money(v, { compact: true })} /></div>
            </Card>
          )}
          {me.service_mix.length > 0 && (
            <Card className="p-5">
              <h3 className="mb-4 text-[15px] font-semibold">Service mix</h3>
              <BarList items={me.service_mix.map((s) => ({ key: s.name, label: s.name, value: s.count }))} format={(v) => `${v}`} />
            </Card>
          )}
          <Card>
            <CardHeader title="Payments" />
            {!payments?.length ? <EmptyState title="No payments in this period" /> : (
              <div className="mt-3 divide-y divide-line">
                {payments.map((p: any) => (
                  <div key={p.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <div>
                      <div className="font-medium">{p.client ? `${p.client.first_name} ${p.client.last_name ?? ''}` : 'Walk-in'}</div>
                      <div className="text-xs text-muted">{relativeDay(p.paid_at, ws.timezone)} {time(p.paid_at, ws.timezone)} · {p.method}</div>
                    </div>
                    <div className="text-right tnum">
                      <div className="font-semibold">{money(p.subtotal_cents - p.discount_cents)}</div>
                      {p.tip_cents > 0 && <div className="text-xs text-success">+{money(p.tip_cents)} tip</div>}
                      {p.status !== 'PAID' && <Badge tone="warning">{p.status}</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
