import { useState } from 'react'
import { useSearchParams, Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CreditCard, Download } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useAnalytics, useBarbers } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { addDays, zonedToUtc } from '@/lib/time'
import { dateLabel, money, parseMoney, time } from '@/lib/format'
import { downloadCsv } from '@/lib/csv'
import { friendlyError } from '@/lib/errors'
import { RangePicker, useRange } from '@/components/RangePicker'
import { Badge, Button, Card, Chip, EmptyState, Field, Input, PageHeader, Sheet, Skeleton, Stat, useToast } from '@/components/ui'

export default function Payments() {
  const { ws, can } = useWorkspace()
  const tz = ws.timezone
  const [params, setParams] = useSearchParams()
  const filter = params.get('filter') ?? 'all'
  const { key, setKey, range, custom, setCustom } = useRange(tz, '7d')
  const { data: barbers } = useBarbers(ws.shop_id, { includeArchived: true })
  const { data: a } = useAnalytics(ws.shop_id, range.from, range.to, null, can('reports.shop'))
  const [sel, setSel] = useState<any>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['payments', ws.shop_id, range.from, range.to, filter],
    queryFn: async () => {
      if (filter === 'unpaid') {
        return { unpaid: (await supabase.from('appointments').select('id, starts_at, barber_id, expected_price_cents, client:clients(first_name, last_name)').eq('shop_id', ws.shop_id)
          .eq('status', 'COMPLETED').eq('payment_status', 'UNPAID').order('starts_at', { ascending: false }).limit(200)).data ?? [], payments: [] }
      }
      let q = supabase.from('payments').select('*, client:clients(first_name, last_name), items:payment_items(description)').eq('shop_id', ws.shop_id)
        .gte('paid_at', zonedToUtc(range.from, '00:00', tz).toISOString()).lt('paid_at', zonedToUtc(addDays(range.to, 1), '00:00', tz).toISOString()).order('paid_at', { ascending: false }).limit(500)
      if (filter === 'refunds') q = q.gt('refunded_cents', 0)
      if (filter === 'partial') q = q.in('status', ['PARTIAL', 'UNPAID'])
      return { payments: (await q).data ?? [], unpaid: [] }
    },
  })
  const bname = (id: string) => barbers?.find((b) => b.id === id)?.display_name ?? '—'

  return (
    <div>
      <PageHeader title="Payments" actions={
        <>
          <RangePicker value={key} onChange={setKey} custom={custom} onCustom={setCustom} />
          <Button variant="secondary" icon={<Download className="size-4" />} disabled={!data?.payments.length} onClick={() => downloadCsv(`payments-${range.from}-${range.to}.csv`, data!.payments.map((p: any) => ({
            date: dateLabel(p.paid_at, tz, { year: 'numeric', month: '2-digit', day: '2-digit' }), time: time(p.paid_at, tz), kind: p.kind,
            client: p.client ? `${p.client.first_name} ${p.client.last_name ?? ''}` : '', barber: p.barber_id ? bname(p.barber_id) : '', items: p.items.map((i: any) => i.description).join(' + '),
            subtotal: (p.subtotal_cents / 100).toFixed(2), discount: (p.discount_cents / 100).toFixed(2), tax: (p.tax_cents / 100).toFixed(2), tip: (p.tip_cents / 100).toFixed(2),
            total: (p.total_cents / 100).toFixed(2), paid: (p.amount_paid_cents / 100).toFixed(2), refunded: (p.refunded_cents / 100).toFixed(2), method: p.method, status: p.status,
          })))}>CSV</Button>
        </>
      } />
      {a && (
        <Card className="mb-6 grid grid-cols-2 gap-6 p-6 md:grid-cols-5">
          <Stat label="Service revenue" value={money(a.revenue.net_service_cents)} />
          <Stat label="Tips" value={money(a.revenue.tips_cents)} />
          <Stat label="Total collected" value={money(a.revenue.collected_cents)} />
          <Stat label="Refunds" value={money(a.revenue.refunds_cents)} />
          <Stat label="Commission owed" value={money(a.revenue.commission_cents)} />
        </Card>
      )}
      {a && Object.keys(a.revenue.by_method).length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2 text-sm">
          {Object.entries(a.revenue.by_method).map(([m, c]) => <Badge key={m} className="normal-case">{m} · {money(c)}</Badge>)}
        </div>
      )}
      <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4">
        {[['all', 'All'], ['unpaid', 'Missing payment'], ['partial', 'Partial'], ['refunds', 'Refunds']].map(([k, l]) => <Chip key={k} active={filter === k} onClick={() => setParams({ filter: k })}>{l}</Chip>)}
      </div>
      {isLoading ? <Skeleton className="h-64" /> : filter === 'unpaid' ? (
        !data?.unpaid.length ? <Card><EmptyState title="Nothing missing" body="Every completed appointment has a payment." /></Card> : (
          <Card className="divide-y divide-line">
            {data.unpaid.map((u: any) => (
              <Link key={u.id} to={`/app/appointments/${u.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-surface-2">
                <span>{u.client?.first_name} {u.client?.last_name} · {bname(u.barber_id)}</span>
                <span className="text-muted">{dateLabel(u.starts_at, tz)} {time(u.starts_at, tz)} · {money(u.expected_price_cents)}</span>
              </Link>
            ))}
          </Card>
        )
      ) : !data?.payments.length ? (
        <Card><EmptyState icon={<CreditCard className="size-6" />} title="No payments in this period" body="Payments appear as barbers complete appointments." /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
              <tr><th className="px-5 py-3">When</th><th className="px-3 py-3">Client</th><th className="px-3 py-3">Barber</th><th className="px-3 py-3">Method</th><th className="px-3 py-3 text-right">Service</th><th className="px-3 py-3 text-right">Tip</th><th className="px-5 py-3 text-right">Total</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.payments.map((p: any) => (
                <tr key={p.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setSel(p)}>
                  <td className="whitespace-nowrap px-5 py-3">{dateLabel(p.paid_at, tz)} <span className="text-muted">{time(p.paid_at, tz)}</span></td>
                  <td className="px-3 py-3">{p.client ? `${p.client.first_name} ${p.client.last_name ?? ''}` : <span className="capitalize text-muted">{p.kind.replace('_', ' ')}</span>}</td>
                  <td className="px-3 py-3">{p.barber_id ? bname(p.barber_id) : '—'}</td>
                  <td className="px-3 py-3 capitalize">{p.method}</td>
                  <td className="px-3 py-3 text-right tnum">{money(p.subtotal_cents - p.discount_cents)}</td>
                  <td className="px-3 py-3 text-right tnum">{p.tip_cents ? money(p.tip_cents) : ''}</td>
                  <td className="px-5 py-3 text-right tnum font-semibold">{money(p.total_cents)} {p.status !== 'PAID' && <Badge tone={p.status === 'VOID' || p.status === 'REFUNDED' ? 'danger' : 'warning'}>{p.status}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {sel && <PaymentSheet p={sel} onClose={() => setSel(null)} />}
    </div>
  )
}

function PaymentSheet({ p, onClose }: { p: any; onClose: () => void }) {
  const { ws, can } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [refund, setRefund] = useState('')
  const [reason, setReason] = useState('')
  const [tip, setTip] = useState('')
  const [settle, setSettle] = useState('')
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      qc.invalidateQueries({ queryKey: ['payments', ws.shop_id] })
      qc.invalidateQueries({ queryKey: ['analytics', ws.shop_id] })
      toast(ok, 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  return (
    <Sheet open onClose={onClose} title={`Payment · ${money(p.total_cents)}`}>
      <div className="space-y-5 text-sm">
        <div className="flex gap-2"><Badge>{p.status}</Badge><Badge className="normal-case">{p.method}</Badge><Badge className="normal-case">{p.provider ?? 'manual'}</Badge></div>
        {p.appointment_id && <Link to={`/app/appointments/${p.appointment_id}`} className="block font-semibold hover:underline" onClick={onClose}>View appointment →</Link>}
        {['PARTIAL', 'UNPAID'].includes(p.status) && (
          <div className="flex items-end gap-2">
            <Field label={`Collect remaining (${money(p.total_cents - p.amount_paid_cents)})`} className="flex-1"><Input leading="$" value={settle} onChange={(e) => setSettle(e.target.value)} /></Field>
            <Button onClick={() => run(() => rpc('settle_payment', { p_payment_id: p.id, p_amount_cents: parseMoney(settle) }), 'Payment updated')}>Collect</Button>
          </div>
        )}
        {!['VOID', 'REFUNDED'].includes(p.status) && (
          <div className="flex items-end gap-2">
            <Field label="Add tip" className="flex-1"><Input leading="$" value={tip} onChange={(e) => setTip(e.target.value)} /></Field>
            <Button variant="secondary" onClick={() => run(() => rpc('add_tip', { p_payment_id: p.id, p_amount_cents: parseMoney(tip), p_method: 'card' }), 'Tip added')}>Add</Button>
          </div>
        )}
        {can('payments.refund') && !['VOID', 'REFUNDED'].includes(p.status) && (
          <div className="rounded-xl border border-line p-4">
            <div className="font-semibold">Refund</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Input leading="$" placeholder={(p.amount_paid_cents - p.refunded_cents) / 100 + ''} value={refund} onChange={(e) => setRefund(e.target.value)} />
              <Input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="mt-2 flex gap-2">
              <Button variant="danger" onClick={() => run(() => rpc('refund_payment', { p_payment_id: p.id, p_amount_cents: parseMoney(refund) ?? p.amount_paid_cents - p.refunded_cents, p_reason: reason || null }), 'Refunded')}>Refund</Button>
              {p.refunded_cents === 0 && <Button variant="ghost" onClick={() => confirm('Void this payment? Use for mistakes only.') && run(() => rpc('void_payment', { p_payment_id: p.id, p_reason: reason || 'Entered by mistake' }), 'Voided')}>Void</Button>}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  )
}
