import { useState } from 'react'
import { Link, Navigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowUpRight, Download, Package, Plus, Receipt, Trash2, Wallet } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useExpenses, useFinance, useRentLedger } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { dateStrLabel, money, parseMoney } from '@/lib/format'
import { todayInTz } from '@/lib/time'
import { friendlyError } from '@/lib/errors'
import { downloadCsv } from '@/lib/csv'
import { EXPENSE_CATEGORIES, type ExpenseCategory, type FinanceSummary, type PaymentMethod, type RentCharge } from '@/lib/types'
import { RangePicker, useRange } from '@/components/RangePicker'
import { ColumnChart } from '@/components/charts'
import { Badge, Button, Card, CardHeader, cx, EmptyState, Field, Input, PageHeader, Segmented, Select, Sheet, Skeleton, Textarea, useToast } from '@/components/ui'

type Scope = 'shop' | 'me'
type Tab = 'overview' | 'rent' | 'payouts' | 'expenses'

const IN_LABEL: Record<string, string> = {
  services_cents: 'Services',
  products_cents: 'Product sales',
  rent_cents: 'Chair rent collected',
  fees_cents: 'No-show & late fees',
  tips_kept_cents: 'Tips kept by shop',
  tips_cents: 'Tips',
  product_commissions_cents: 'Product commissions',
}
const OUT_LABEL: Record<string, string> = {
  commissions_cents: 'Barber commissions',
  product_commissions_cents: 'Product commissions paid',
  inventory_cents: 'Inventory purchases',
  expenses_cents: 'Expenses',
  rent_cents: 'Chair rent paid',
}
const RENT_TONE = { due: 'info', partial: 'warning', paid: 'success', overdue: 'danger', waived: 'neutral' } as const

/** Money in, money out, what's left — for the shop, or for a barber's own business. */
export default function Finance() {
  const { ws, can } = useWorkspace()
  const shopFinance = can('finance.manage')
  const [scope, setScope] = useState<Scope>(shopFinance ? 'shop' : 'me')
  if (!shopFinance && !ws.barber_id) return <Navigate to="/app" replace />
  const barberScope = scope === 'me'
  const isChairOwner = ws.barber_type === 'chair_owner'

  return (
    <div>
      <PageHeader eyebrow={barberScope ? (isChairOwner ? 'Your business' : 'Your money') : 'Shop'} title={barberScope ? (isChairOwner ? 'My business' : 'Earnings') : 'Finance'}
        subtitle={barberScope ? (isChairOwner ? 'Services, tips, product sales, rent and expenses — your take-home.' : 'Commission, tips and product commissions.') : 'Profit, chair rent, barber payouts and expenses.'} />
      {shopFinance && ws.barber_id && (
        <Segmented className="mb-5" value={scope} onChange={setScope} options={[{ value: 'shop', label: 'Shop' }, { value: 'me', label: 'My chair' }]} />
      )}
      {barberScope ? <BarberFinance barberId={ws.barber_id!} chairOwner={isChairOwner} /> : <ShopFinance />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------
function ShopFinance() {
  const { ws } = useWorkspace()
  const [tab, setTab] = useState<Tab>('overview')
  const r = useRange(ws.timezone, 'mtd')
  const { data: f, isLoading } = useFinance(ws.shop_id, r.range.from, r.range.to)
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'rent', label: 'Rent' }, { value: 'payouts', label: 'Payouts' }, { value: 'expenses', label: 'Expenses' }]} />
        {tab !== 'rent' && <RangePicker value={r.key} onChange={r.setKey} custom={r.custom} onCustom={r.setCustom} keys={['today', '7d', 'mtd', '30d', '90d', 'custom']} />}
      </div>
      {tab === 'overview' && (isLoading || !f ? <Skeleton className="h-80" /> : <Overview f={f} />)}
      {tab === 'rent' && <RentLedger barberId={null} manage />}
      {tab === 'payouts' && (isLoading || !f ? <Skeleton className="h-64" /> : <Payouts f={f} />)}
      {tab === 'expenses' && <Expenses barberId={null} from={r.range.from} to={r.range.to} />}
    </>
  )
}

function Overview({ f, footer }: { f: FinanceSummary; footer?: React.ReactNode }) {
  const shop = f.scope === 'shop'
  const ins = Object.entries(f.money_in).filter(([k]) => k !== 'gross_services_cents')
  const outs = Object.entries(f.money_out)
  return (
    <div className="space-y-4">
      <Card className="grid gap-6 p-6 sm:grid-cols-3">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><ArrowDownLeft className="size-3.5 text-success" />Money in</div>
          <div className="mt-2 text-3xl font-bold tnum">{money(f.total_in_cents, { cents: false })}</div>
        </div>
        <div>
          <div className="eyebrow flex items-center gap-1.5"><ArrowUpRight className="size-3.5 text-danger" />Money out</div>
          <div className="mt-2 text-3xl font-bold tnum">{money(f.total_out_cents, { cents: false })}</div>
        </div>
        <div>
          <div className="eyebrow">{shop ? 'Profit' : 'Take-home'}</div>
          <div className={cx('mt-2 text-[40px] font-bold leading-none tnum', f.net_cents < 0 ? 'text-danger' : 'text-success')}>{money(f.net_cents, { cents: false })}</div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Money in" />
          <Lines rows={ins.map(([k, v]) => ({ label: IN_LABEL[k] ?? k, value: v }))} />
        </Card>
        <Card>
          <CardHeader title="Money out" />
          <Lines rows={outs.map(([k, v]) => ({ label: OUT_LABEL[k] ?? k, value: v }))} negative />
          {f.expenses_by_category.length > 0 && (
            <div className="border-t border-line px-5 py-3 text-xs text-muted">
              Expenses: {f.expenses_by_category.map((c) => `${cap(c.category)} ${money(c.cents, { cents: false })}`).join(' · ')}
            </div>
          )}
        </Card>
      </div>

      {f.series.length > 1 && (
        <Card>
          <CardHeader title="Money in per day" />
          <div className="px-3 pb-4 pt-2">
            <ColumnChart ariaLabel="Money in per day" data={f.series.map((d) => ({ label: dateStrLabel(d.date, { month: 'short', day: 'numeric' }), value: d.in_cents / 100 }))}
              format={(v) => money(v * 100, { compact: true })} />
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="eyebrow">Rent outstanding</div>
          <div className={cx('mt-2 text-2xl font-bold tnum', f.rent.outstanding_cents > 0 && 'text-warning')}>{money(f.rent.outstanding_cents, { cents: false })}</div>
          <div className="mt-1 text-xs text-muted">
            {shop ? (f.rent.overdue_count ? `${f.rent.overdue_count} overdue` : 'nothing overdue') : f.rent.next_due ? `next due ${dateStrLabel(f.rent.next_due.due_date)}` : 'all paid'}
          </div>
        </Card>
        {f.inventory ? (
          <Card className="p-5">
            <div className="eyebrow">Inventory on hand</div>
            <div className="mt-2 text-2xl font-bold tnum">{money(f.inventory.value_cents, { cents: false })}</div>
            <div className="mt-1 text-xs text-muted">{f.inventory.low_stock ? <Link to="/app/inventory" className="text-danger">{f.inventory.low_stock} low on stock</Link> : 'stock levels fine'} · cost of goods sold {money(f.inventory.cogs_cents, { cents: false })}</div>
          </Card>
        ) : <div />}
        {shop && f.pass_through ? (
          <Card className="p-5">
            <div className="eyebrow">Passed through to barbers</div>
            <div className="mt-2 text-2xl font-bold tnum">{money(f.pass_through.chair_owner_services_cents + f.pass_through.tips_to_barbers_cents, { cents: false })}</div>
            <div className="mt-1 text-xs text-muted">{money(f.pass_through.chair_owner_services_cents, { cents: false })} chair-owner services · {money(f.pass_through.tips_to_barbers_cents, { cents: false })} tips</div>
          </Card>
        ) : f.cuts !== undefined ? (
          <Card className="p-5">
            <div className="eyebrow">Cuts</div>
            <div className="mt-2 text-2xl font-bold tnum">{f.cuts}</div>
            <div className="mt-1 text-xs text-muted">{f.cuts ? `${money(Math.round(f.net_cents / f.cuts), { cents: false })} take-home per cut` : 'no completed cuts'}</div>
          </Card>
        ) : null}
      </div>

      {shop && f.collected_by_method && Object.keys(f.collected_by_method).length > 0 && (
        <Card className="p-5">
          <div className="eyebrow mb-3">Collected by method</div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {Object.entries(f.collected_by_method).map(([m, v]) => <span key={m}><span className="capitalize text-muted">{m}</span> <b className="tnum">{money(v, { cents: false })}</b></span>)}
          </div>
        </Card>
      )}
      {footer}
    </div>
  )
}

function Lines({ rows, negative }: { rows: { label: string; value: number }[]; negative?: boolean }) {
  return (
    <div className="divide-y divide-line px-5 pb-2 pt-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between py-2.5 text-sm">
          <span className="text-muted">{r.label}</span>
          <span className={cx('font-semibold tnum', r.value === 0 && 'text-faint')}>{negative && r.value ? '−' : ''}{money(Math.abs(r.value))}</span>
        </div>
      ))}
    </div>
  )
}

function Payouts({ f }: { f: FinanceSummary }) {
  const rows = f.barbers ?? []
  return (
    <Card>
      <CardHeader title="Barber payouts" subtitle="Employees: commission + tips + product commission. Chair owners keep their own revenue and pay rent."
        action={<Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadCsv(`payouts-${f.period.from}-${f.period.to}.csv`, rows.map((b) => ({
          barber: b.name, type: b.barber_type, services: b.services_cents / 100, commission: b.commission_cents / 100, tips: b.tips_cents / 100,
          product_commission: b.product_commission_cents / 100, payout: b.payout_cents === null ? '' : b.payout_cents / 100,
          rent_paid: b.rent_paid_cents / 100, rent_balance: b.rent_balance_cents / 100,
        })))}>CSV</Button>} />
      <div className="overflow-x-auto p-2">
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wider text-muted">
            <th className="px-3 py-2">Barber</th><th className="px-3 py-2 text-right">Services</th><th className="px-3 py-2 text-right">Commission</th>
            <th className="px-3 py-2 text-right">Tips</th><th className="px-3 py-2 text-right">Products</th><th className="px-3 py-2 text-right">Pay out</th><th className="px-3 py-2 text-right">Rent</th>
          </tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((b) => (
              <tr key={b.barber_id}>
                <td className="px-3 py-3"><div className="font-medium">{b.name}</div><div className="text-xs text-muted">{b.barber_type === 'chair_owner' ? 'Chair owner' : 'Employee'}</div></td>
                <td className="px-3 py-3 text-right tnum">{money(b.services_cents)}</td>
                <td className="px-3 py-3 text-right tnum">{b.barber_type === 'chair_owner' ? '—' : money(b.commission_cents)}</td>
                <td className="px-3 py-3 text-right tnum">{money(b.tips_cents)}</td>
                <td className="px-3 py-3 text-right tnum">{money(b.product_commission_cents)}</td>
                <td className="px-3 py-3 text-right font-semibold tnum">{b.payout_cents === null ? '—' : money(b.payout_cents)}</td>
                <td className="px-3 py-3 text-right tnum">{b.barber_type === 'chair_owner' || b.rent_paid_cents || b.rent_balance_cents
                  ? <span>{money(b.rent_paid_cents)}{b.rent_balance_cents > 0 && <span className="block text-xs text-warning">{money(b.rent_balance_cents)} owed</span>}</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Rent
// ---------------------------------------------------------------------------
function RentLedger({ barberId, manage }: { barberId: string | null; manage?: boolean }) {
  const { ws } = useWorkspace()
  const { data: rows, isLoading } = useRentLedger(ws.shop_id, barberId)
  const [pay, setPay] = useState<RentCharge | null>(null)
  if (isLoading) return <Skeleton className="h-48" />
  if (!rows?.length) {
    return <Card><EmptyState icon={<Receipt className="size-6" />} title="No chair rent yet"
      body={manage ? 'Make a barber a chair owner (Chairs → tap a chair) and set their rent. Charges appear here every week or month.' : 'No rent charges.'} /></Card>
  }
  const owed = rows.reduce((n, r) => n + r.balance_cents, 0)
  return (
    <>
      <Card className="mb-4 flex items-center justify-between p-5">
        <div><div className="eyebrow">Outstanding</div><div className={cx('mt-1 text-2xl font-bold tnum', owed > 0 && 'text-warning')}>{money(owed)}</div></div>
        <div className="text-right text-sm text-muted">{rows.filter((r) => r.status === 'overdue').length} overdue</div>
      </Card>
      <Card className="divide-y divide-line">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{manage ? r.barber_name : `${r.period === 'week' ? 'Week' : 'Month'} of ${dateStrLabel(r.period_start)}`}{r.chair_label && <span className="text-muted"> · {r.chair_label}</span>}</div>
              <div className="text-xs text-muted">{manage && `${dateStrLabel(r.period_start)} – ${dateStrLabel(r.period_end)} · `}due {dateStrLabel(r.due_date)}</div>
            </div>
            <div className="text-right">
              <div className="font-semibold tnum">{money(r.amount_cents)}</div>
              {r.paid_cents > 0 && r.balance_cents > 0 && <div className="text-xs text-muted">{money(r.paid_cents)} paid</div>}
            </div>
            <Badge tone={RENT_TONE[r.status]}>{r.status}</Badge>
            {manage && r.balance_cents > 0 && <Button size="sm" onClick={() => setPay(r)}>Record</Button>}
          </div>
        ))}
      </Card>
      {pay && <RentPaymentSheet charge={pay} onClose={() => setPay(null)} />}
    </>
  )
}

function RentPaymentSheet({ charge, onClose }: { charge: RentCharge; onClose: () => void }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [amount, setAmount] = useState(String(charge.balance_cents / 100))
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [busy, setBusy] = useState(false)
  const done = () => qc.invalidateQueries({ queryKey: ['finance', ws.shop_id] })
  const save = async () => {
    setBusy(true)
    try {
      await rpc('record_rent_payment', { p_charge_id: charge.id, p_amount_cents: parseMoney(amount), p_method: method })
      done()
      toast('Rent payment recorded', 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const waive = async () => {
    if (!confirm('Waive the rest of this charge?')) return
    await rpc('set_rent_charge', { p_charge_id: charge.id, p_waived: true }).then(done, (e) => toast(friendlyError(e), 'error'))
    onClose()
  }
  return (
    <Sheet open onClose={onClose} title={`Rent · ${charge.barber_name}`}
      footer={<div className="flex gap-2"><Button variant="ghost" onClick={waive}>Waive</Button><Button className="flex-1" loading={busy} onClick={save}>Record payment</Button></div>}>
      <div className="space-y-4">
        <p className="text-sm text-muted">{charge.period === 'week' ? 'Week' : 'Month'} of {dateStrLabel(charge.period_start)} · {money(charge.amount_cents)} · {money(charge.balance_cents)} left</p>
        <Field label="Amount received"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            <option value="cash">Cash</option><option value="transfer">Transfer</option><option value="card">Card</option><option value="mobile">Mobile</option>
          </Select>
        </Field>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
function Expenses({ barberId, from, to }: { barberId: string | null; from: string; to: string }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: rows, isLoading } = useExpenses(ws.shop_id, from, to, barberId)
  const [adding, setAdding] = useState(false)
  const total = (rows ?? []).reduce((n, e) => n + Number(e.amount_cents), 0)
  const remove = async (id: string) => {
    if (!confirm('Delete this expense?')) return
    const { error } = await supabase.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) toast(friendlyError(error), 'error')
    qc.invalidateQueries({ queryKey: ['finance', ws.shop_id] })
  }
  return (
    <>
      <Card className="mb-4 flex items-center justify-between p-5">
        <div><div className="eyebrow">Expenses this period</div><div className="mt-1 text-2xl font-bold tnum">{money(total)}</div></div>
        <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Expense</Button>
      </Card>
      {isLoading ? <Skeleton className="h-40" /> : !rows?.length ? (
        <Card><EmptyState icon={<Wallet className="size-6" />} title="No expenses in this period" body={barberId ? 'Log supplies, education, transport — only you see these.' : 'Log utilities, supplies, payroll, marketing… to see real profit.'} /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((e) => (
            <div key={e.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{e.vendor || cap(e.category)}</div>
                <div className="text-xs text-muted">{cap(e.category)} · {dateStrLabel(e.spent_on)} · {e.method}{e.note ? ` · ${e.note}` : ''}</div>
              </div>
              <div className="font-semibold tnum">{money(e.amount_cents)}</div>
              <button className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label="Delete" onClick={() => remove(e.id)}><Trash2 className="size-4" /></button>
            </div>
          ))}
        </Card>
      )}
      {adding && <ExpenseSheet barberId={barberId} onClose={() => setAdding(false)} />}
    </>
  )
}

function ExpenseSheet({ barberId, onClose }: { barberId: string | null; onClose: () => void }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [f, setF] = useState({ category: 'supplies' as ExpenseCategory, amount: '', spent_on: todayInTz(ws.timezone), vendor: '', note: '', method: 'cash' as PaymentMethod })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('expenses').insert({
      shop_id: ws.shop_id, barber_id: barberId, category: f.category, amount_cents: parseMoney(f.amount), spent_on: f.spent_on,
      vendor: f.vendor || null, note: f.note || null, method: f.method, created_by: u.user?.id,
    })
    setBusy(false)
    if (error) return toast(friendlyError(error), 'error')
    qc.invalidateQueries({ queryKey: ['finance', ws.shop_id] })
    toast('Expense added', 'success')
    onClose()
  }
  return (
    <Sheet open onClose={onClose} title="New expense" footer={<Button block loading={busy} disabled={!parseMoney(f.amount)} onClick={save}>Save expense</Button>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount"><Input autoFocus inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Date"><Input type="date" value={f.spent_on} onChange={(e) => setF({ ...f, spent_on: e.target.value })} /></Field>
        </div>
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as ExpenseCategory })}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
          </Select>
        </Field>
        <Field label="Paid to"><Input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} placeholder="Supplier, landlord, …" /></Field>
        <Field label="Method">
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as PaymentMethod })}>
            <option value="cash">Cash</option><option value="card">Card</option><option value="transfer">Transfer</option><option value="mobile">Mobile</option>
          </Select>
        </Field>
        <Field label="Note"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <p className="text-xs text-muted">Buying stock for resale? Use Inventory → Received instead, so stock and cost stay in sync.</p>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// One barber's business
// ---------------------------------------------------------------------------
function BarberFinance({ barberId, chairOwner }: { barberId: string; chairOwner: boolean }) {
  const { ws } = useWorkspace()
  const [tab, setTab] = useState<Tab>('overview')
  const r = useRange(ws.timezone, 'mtd')
  const { data: f, isLoading } = useFinance(ws.shop_id, r.range.from, r.range.to, barberId)
  const hasRent = chairOwner || !!f?.rent.plan?.rent_cents
  const tabs = [{ value: 'overview' as Tab, label: 'Overview' }, ...(hasRent ? [{ value: 'rent' as Tab, label: 'Rent' }] : []), ...(chairOwner ? [{ value: 'expenses' as Tab, label: 'Expenses' }] : [])]
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        {tabs.length > 1 ? <Segmented value={tab} onChange={setTab} options={tabs} /> : <span />}
        {tab !== 'rent' && <RangePicker value={r.key} onChange={r.setKey} custom={r.custom} onCustom={r.setCustom} keys={['today', '7d', 'mtd', '30d', 'custom']} />}
      </div>
      {tab === 'overview' && (isLoading || !f ? <Skeleton className="h-80" /> : (
        <Overview f={f} footer={
          <div className="flex flex-wrap gap-2">
            <Link to="/app/earnings"><Button variant="secondary" icon={<Wallet className="size-4" />}>Earnings detail</Button></Link>
            {chairOwner && <Link to="/app/inventory"><Button variant="secondary" icon={<Package className="size-4" />}>My inventory</Button></Link>}
          </div>
        } />
      ))}
      {tab === 'rent' && <RentLedger barberId={barberId} />}
      {tab === 'expenses' && <Expenses barberId={barberId} from={r.range.from} to={r.range.to} />}
    </>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
