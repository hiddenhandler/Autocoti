import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Building2, Check, Copy, ExternalLink, Gift, LogOut, MessageCircle, Plus, Search, ShieldCheck, Trash2, Users, Wallet,
} from 'lucide-react'
import { rpc } from '@/lib/supabase'
import { useAuth } from '@/lib/auth'
import { friendlyError } from '@/lib/errors'
import { ago, money, num, parseMoney } from '@/lib/format'
import { BarberChairIcon } from '@/components/BarberChair'
import { BarList, ColumnChart } from '@/components/charts'
import {
  Badge, Button, Card, CardHeader, cx, EmptyState, Field, Input, Logo, Segmented, Select, Sheet, Skeleton, Spinner, Stat, Textarea, useToast,
} from '@/components/ui'

// ---------------------------------------------------------------------------
// Types (shape of the admin_* RPCs)
// ---------------------------------------------------------------------------
type SubStatus = 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled'
interface Overview {
  counts: { accounts: number; shops: number; shop_owners: number; chair_owners: number; barbers: number; clients: number; pending_invites: number }
  subscriptions: {
    mrr_cents: number; active: number; comped: number; trialing: number; past_due: number; cancelled: number; trials_ending_7d: number
    by_plan: { code: string; name: string; accounts: number; paying: number; mrr_cents: number }[]
  }
  cashflow: { month: string; platform_in_cents: number; platform_refunds_cents: number; gifted_months: number; gmv_cents: number; tips_cents: number; new_accounts: number; new_clients: number }[]
}
interface Account {
  id: string; name: string; created_at: string; kind: 'shop_owner' | 'chair_owner'
  owner: { id: string; email: string; full_name: string | null; last_sign_in_at: string | null }
  plan: { code: string; name: string; price_cents: number; interval: string } | null
  subscription: { status: SubStatus | null; is_comp: boolean; trial_ends_at: string | null; current_period_end: string | null }
  shops: { id: string; name: string; slug: string; is_published: boolean }[]
  barbers: number; chair_owners: number; clients: number; gmv_30d_cents: number; paid_total_cents: number
}
interface Invite {
  id: string; token: string; email: string; full_name: string | null; kind: string; shop_name: string; plan_code: string
  comp_months: number; created_at: string; expires_at: string; status: 'pending' | 'claimed' | 'revoked' | 'expired'
}
interface Person { id: string; email: string; full_name: string | null; created_at: string; last_sign_in_at: string | null; roles: string[]; shops: string[] }
interface Entry {
  id: string; organization_id: string | null; account: string | null; kind: 'payment' | 'refund' | 'gift' | 'adjustment'
  amount_cents: number; months: number | null; plan_code: string | null; method: string | null; note: string | null; occurred_at: string; by: string | null
}

const PLANS = [
  { code: 'starter', name: 'Starter' },
  { code: 'shop', name: 'Shop' },
  { code: 'pro', name: 'Pro' },
]
const ROLE_LABEL: Record<string, string> = {
  system_owner: 'System owner', shop_owner: 'Shop owner', chair_owner: 'Chair owner', barber: 'Barber', staff: 'Staff', client: 'Client',
}
const ROLE_TONE: Record<string, 'accent' | 'success' | 'warning' | 'info' | 'neutral'> = {
  system_owner: 'warning', shop_owner: 'accent', chair_owner: 'info', barber: 'success', staff: 'neutral', client: 'neutral',
}
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
const usd = (c: number) => money(c, { cents: false })
const appUrl = (path: string) => `${window.location.origin}${path}`

type Tab = 'overview' | 'accounts' | 'people' | 'ledger'

export default function Admin() {
  const { user, loading, signOut } = useAuth()
  const { data: isAdmin, isLoading } = useQuery({ queryKey: ['am_platform_admin', user?.id], enabled: !!user, queryFn: () => rpc<boolean>('am_platform_admin') })
  const [tab, setTab] = useState<Tab>('overview')

  if (loading || (user && isLoading)) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (!user) return <EmptyState className="min-h-dvh" title="Sign in required" action={<Link to="/login?next=/admin"><Button>Sign in</Button></Link>} />
  if (!isAdmin)
    return <EmptyState className="min-h-dvh" icon={<ShieldCheck className="size-6" />} title="System owners only"
      body="This console is for the BarberNGo system owner." action={<Link to="/app"><Button variant="secondary">Back to the app</Button></Link>} />

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-5">
          <Logo />
          <Badge tone="warning" className="hidden sm:inline-flex"><ShieldCheck className="size-3" /> System owner</Badge>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/app" className="hidden text-sm text-muted hover:text-ink sm:inline-flex sm:items-center sm:gap-1"><ArrowLeft className="size-4" /> My shop</Link>
            <span className="hidden max-w-[200px] truncate text-sm text-muted md:inline">{user.email}</span>
            <Button variant="ghost" size="sm" icon={<LogOut className="size-4" />} onClick={() => signOut()}>Sign out</Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow mb-2">BarberNGo platform</div>
            <h1 className="display text-[40px] leading-none">Command center</h1>
          </div>
          <Segmented<Tab> value={tab} onChange={setTab} options={[
            { value: 'overview', label: 'Overview' }, { value: 'accounts', label: 'Accounts' },
            { value: 'people', label: 'People' }, { value: 'ledger', label: 'Cash ledger' },
          ]} />
        </div>
        {tab === 'overview' && <OverviewTab />}
        {tab === 'accounts' && <AccountsTab />}
        {tab === 'people' && <PeopleTab />}
        {tab === 'ledger' && <LedgerTab />}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overview: KPIs + cash flow
// ---------------------------------------------------------------------------
function OverviewTab() {
  const { data: o, isLoading } = useQuery({ queryKey: ['admin_overview'], queryFn: () => rpc<Overview>('admin_overview', { p_months: 12 }) })
  if (isLoading || !o) return <Skeleton className="h-96" />
  const cf = o.cashflow
  const monthLabel = (m: string) => new Date(`${m}-15`).toLocaleDateString(undefined, { month: 'short' })
  const last = cf[cf.length - 1]
  const totals = cf.reduce((a, m) => ({ in: a.in + m.platform_in_cents - m.platform_refunds_cents, gmv: a.gmv + m.gmv_cents }), { in: 0, gmv: 0 })
  return (
    <div className="space-y-6">
      <Card className="grid grid-cols-2 gap-x-6 gap-y-7 p-6 sm:grid-cols-4">
        <Stat big label="MRR" value={usd(o.subscriptions.mrr_cents)} sub={`${o.subscriptions.active} paying accounts`} />
        <Stat big label="Accounts" value={num(o.counts.accounts)} sub={`${o.counts.shops} shops · ${o.counts.pending_invites} pending invites`} />
        <Stat big label="Chair owners" value={num(o.counts.chair_owners)} sub={`${num(o.counts.barbers)} barbers total`} />
        <Stat big label="Clients" value={num(o.counts.clients)} sub={last ? `+${num(last.new_clients)} this month` : undefined} />
        <Stat label="Trialing" value={num(o.subscriptions.trialing)} sub={o.subscriptions.trials_ending_7d ? `${o.subscriptions.trials_ending_7d} end within 7 days` : 'none ending soon'} />
        <Stat label="Gifted (comped)" value={num(o.subscriptions.comped)} sub="active, free" />
        <Stat label="Past due" value={num(o.subscriptions.past_due)} sub={`${o.subscriptions.cancelled} cancelled/paused`} />
        <Stat label="Account owners" value={num(o.counts.shop_owners)} sub="shop + chair owner logins" />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="BarberNGo revenue" subtitle={`Payments recorded in the ledger · ${usd(totals.in)} in 12 months (net of refunds)`} />
          <div className="p-5">
            {totals.in === 0 ? <p className="py-10 text-center text-sm text-muted">No payments recorded yet. Record them from an account or the cash ledger.</p> :
              <ColumnChart ariaLabel="Platform revenue by month" format={usd} data={cf.map((m) => ({ label: monthLabel(m.month), value: m.platform_in_cents - m.platform_refunds_cents }))} />}
          </div>
        </Card>
        <Card>
          <CardHeader title="Money through shops" subtitle={`What clients paid every shop (GMV) · ${usd(totals.gmv)} in 12 months`} />
          <div className="p-5">
            {totals.gmv === 0 ? <p className="py-10 text-center text-sm text-muted">No client payments yet.</p> :
              <ColumnChart ariaLabel="GMV by month" format={usd} color="var(--glow)" data={cf.map((m) => ({ label: monthLabel(m.month), value: m.gmv_cents }))} />}
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader title="Plans" subtitle="Accounts and MRR per plan" />
          <div className="p-5">
            <BarList format={(v) => `${v} account${v === 1 ? '' : 's'}`} items={o.subscriptions.by_plan.map((p) => ({
              key: p.code, label: p.name, value: p.accounts, sub: `${p.paying} paying · ${usd(p.mrr_cents)}/mo`,
            }))} />
          </div>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Cash flow by month" subtitle="Platform money in, gifts, and activity across all shops" />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2 font-semibold">Month</th><th className="px-3 py-2 text-right font-semibold">Platform in</th>
                  <th className="px-3 py-2 text-right font-semibold">Refunds</th><th className="px-3 py-2 text-right font-semibold">Gifted</th>
                  <th className="px-3 py-2 text-right font-semibold">Shops GMV</th><th className="px-3 py-2 text-right font-semibold">Tips</th>
                  <th className="px-3 py-2 text-right font-semibold">New accts</th><th className="px-5 py-2 text-right font-semibold">New clients</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {[...cf].reverse().map((m) => (
                  <tr key={m.month} className="border-b border-line/60 last:border-0">
                    <td className="whitespace-nowrap px-5 py-2.5 font-medium">{new Date(`${m.month}-15`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</td>
                    <td className="px-3 py-2.5 text-right">{usd(m.platform_in_cents)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{m.platform_refunds_cents ? `−${usd(m.platform_refunds_cents)}` : '—'}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{m.gifted_months ? `${m.gifted_months} mo` : '—'}</td>
                    <td className="px-3 py-2.5 text-right">{usd(m.gmv_cents)}</td>
                    <td className="px-3 py-2.5 text-right text-muted">{usd(m.tips_cents)}</td>
                    <td className="px-3 py-2.5 text-right">{m.new_accounts}</td>
                    <td className="px-5 py-2.5 text-right">{m.new_clients}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Accounts: create (invite link), list, manage membership
// ---------------------------------------------------------------------------
function subLine(a: Account) {
  const s = a.subscription
  if (!s.status) return { tone: 'neutral' as const, text: 'No plan' }
  if (s.status === 'active' && s.is_comp) return { tone: 'warning' as const, text: `Gifted until ${date(s.current_period_end)}` }
  if (s.status === 'active') return { tone: 'success' as const, text: `Active until ${date(s.current_period_end)}` }
  if (s.status === 'trialing') return { tone: 'info' as const, text: `Trial ends ${date(s.trial_ends_at)}` }
  if (s.status === 'past_due') return { tone: 'danger' as const, text: 'Past due' }
  return { tone: 'neutral' as const, text: s.status === 'paused' ? 'Paused' : 'Cancelled' }
}

function AccountsTab() {
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<Account | null>(null)
  const { data: accounts, isLoading } = useQuery({ queryKey: ['admin_accounts', q], queryFn: () => rpc<Account[]>('admin_accounts', { p_search: q || null }) })
  const { data: invites } = useQuery({ queryKey: ['admin_invites'], queryFn: () => rpc<Invite[]>('admin_invites') })
  const pending = (invites ?? []).filter((i) => i.status === 'pending')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Input className="w-full sm:w-80" leading={<Search className="size-4" />} placeholder="Search account, email or shop…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Create account</Button>
      </div>

      {pending.length > 0 && (
        <Card>
          <CardHeader title="Waiting to be activated" subtitle="Share the link — they sign in with that email and their shop is created" />
          <div className="divide-y divide-line px-5 pb-2 pt-2">
            {pending.map((i) => <InviteRow key={i.id} inv={i} />)}
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        {isLoading ? <Skeleton className="m-5 h-48" /> : (accounts ?? []).length === 0 ? (
          <EmptyState icon={<Building2 className="size-6" />} title={q ? 'No matches' : 'No accounts yet'} body="Create the first barbershop or chair owner account."
            action={!q && <Button onClick={() => setCreating(true)}>Create account</Button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-3 font-semibold">Account</th><th className="px-3 py-3 font-semibold">Plan</th>
                  <th className="px-3 py-3 text-right font-semibold">Barbers</th><th className="px-3 py-3 text-right font-semibold">Clients</th>
                  <th className="px-3 py-3 text-right font-semibold">GMV 30d</th><th className="px-5 py-3 text-right font-semibold">Paid to us</th>
                </tr>
              </thead>
              <tbody>
                {accounts!.map((a) => {
                  const s = subLine(a)
                  return (
                    <tr key={a.id} className="cursor-pointer border-b border-line/60 transition last:border-0 hover:bg-surface-2" onClick={() => setOpen(a)}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-xl', a.kind === 'chair_owner' ? 'bg-info/12 text-info' : 'bg-accent-soft text-accent')}>
                            {a.kind === 'chair_owner' ? <BarberChairIcon className="size-4" /> : <Building2 className="size-4" />}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-semibold">{a.name}</div>
                            <div className="truncate text-xs text-muted">{a.owner.full_name ? `${a.owner.full_name} · ` : ''}{a.owner.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium">{a.plan?.name ?? '—'}</div>
                        <Badge tone={s.tone} className="mt-1 normal-case tracking-normal">{s.text}</Badge>
                      </td>
                      <td className="px-3 py-3 text-right tnum">{a.barbers}{a.chair_owners ? <span className="text-muted"> ({a.chair_owners} CO)</span> : null}</td>
                      <td className="px-3 py-3 text-right tnum">{num(a.clients)}</td>
                      <td className="px-3 py-3 text-right tnum">{usd(a.gmv_30d_cents)}</td>
                      <td className="px-5 py-3 text-right font-semibold tnum">{usd(a.paid_total_cents)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && <CreateAccountSheet onClose={() => setCreating(false)} />}
      {open && <AccountSheet account={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function ShareLink({ path, email, name }: { path: string; email: string; name?: string | null }) {
  const toast = useToast()
  const url = appUrl(path)
  const msg = `Hi${name ? ` ${name.split(' ')[0]}` : ''}! Your BarberNGo account is ready. Activate it here (sign in with ${email}): ${url}`
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" icon={<Copy className="size-3.5" />} onClick={() => { navigator.clipboard?.writeText(url); toast('Link copied', 'success') }}>Copy link</Button>
      <a href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"><Button size="sm" variant="secondary" icon={<MessageCircle className="size-3.5" />}>WhatsApp</Button></a>
      <a href={`mailto:${email}?subject=${encodeURIComponent('Your BarberNGo account')}&body=${encodeURIComponent(msg)}`}><Button size="sm" variant="secondary">Email</Button></a>
    </div>
  )
}

function InviteRow({ inv }: { inv: Invite }) {
  const qc = useQueryClient()
  const revoke = useMutation({
    mutationFn: () => rpc('admin_revoke_invite', { p_id: inv.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin_invites'] }),
  })
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{inv.shop_name} <span className="font-normal text-muted">· {inv.kind === 'chair_owner' ? 'Chair owner' : 'Shop owner'}</span></div>
        <div className="truncate text-xs text-muted">{inv.email} · {PLANS.find((p) => p.code === inv.plan_code)?.name ?? inv.plan_code}{inv.comp_months ? ` · ${inv.comp_months} mo gifted` : ' · 14-day trial'} · expires {date(inv.expires_at)}</div>
      </div>
      <ShareLink path={`/claim/${inv.token}`} email={inv.email} name={inv.full_name} />
      <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} loading={revoke.isPending} onClick={() => revoke.mutate()}>Revoke</Button>
    </div>
  )
}

function CreateAccountSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    kind: 'shop_owner' as 'shop_owner' | 'chair_owner', full_name: '', email: '', shop_name: '', plan_code: 'shop', comp_months: '0',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York', note: '',
  })
  const [done, setDone] = useState<{ claim_url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () => rpc<{ claim_url: string }>('admin_create_account', {
      p_email: f.email, p_full_name: f.full_name, p_kind: f.kind, p_shop_name: f.shop_name, p_plan_code: f.plan_code,
      p_comp_months: Number(f.comp_months), p_timezone: f.timezone, p_note: f.note || null,
    }),
    onSuccess: (r) => { setDone(r); qc.invalidateQueries({ queryKey: ['admin_invites'] }); qc.invalidateQueries({ queryKey: ['admin_overview'] }) },
    onError: (e) => setError(friendlyError(e)),
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })

  return (
    <Sheet open onClose={onClose} title={done ? 'Account ready to activate' : 'Create account'}>
      {done ? (
        <div className="space-y-5">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-success/12 text-success"><Check className="size-6" /></div>
          <p className="text-sm text-muted">Send this link to <b className="text-ink">{f.email}</b>. When they sign in with that email (password, Google or email link) and tap <b className="text-ink">Activate</b>, <b className="text-ink">{f.shop_name}</b> is created with the {PLANS.find((p) => p.code === f.plan_code)?.name} plan{Number(f.comp_months) ? ` and ${f.comp_months} free months` : ' on a 14-day trial'}.</p>
          <div className="break-all rounded-xl border border-line bg-surface-2 px-3 py-2.5 font-mono text-xs">{appUrl(done.claim_url)}</div>
          <ShareLink path={done.claim_url} email={f.email} name={f.full_name} />
          <Button block variant="ghost" onClick={onClose}>Done</Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setError(null); create.mutate() }}>
          <Segmented value={f.kind} onChange={(kind) => setF({ ...f, kind, plan_code: kind === 'chair_owner' ? 'starter' : f.plan_code })} className="w-full"
            options={[{ value: 'shop_owner', label: 'Barbershop owner' }, { value: 'chair_owner', label: 'Chair owner' }]} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name"><Input value={f.full_name} onChange={set('full_name')} placeholder="Carlos Rivera" /></Field>
            <Field label="Email (their login)"><Input type="email" required value={f.email} onChange={set('email')} placeholder="carlos@email.com" /></Field>
          </div>
          <Field label={f.kind === 'chair_owner' ? 'Business name' : 'Barbershop name'}><Input required value={f.shop_name} onChange={set('shop_name')} placeholder={f.kind === 'chair_owner' ? 'Carlos Cuts' : 'Fade Factory'} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan"><Select value={f.plan_code} onChange={set('plan_code')}>{PLANS.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
            <Field label="Gift" hint="Free months instead of a trial">
              <Select value={f.comp_months} onChange={set('comp_months')}>
                <option value="0">No gift — 14-day trial</option>
                {[1, 2, 3, 6, 12].map((m) => <option key={m} value={m}>{m} month{m > 1 ? 's' : ''} free</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Timezone"><Input value={f.timezone} onChange={set('timezone')} placeholder="America/Santo_Domingo" /></Field>
          <Field label="Internal note"><Textarea rows={2} value={f.note} onChange={set('note')} placeholder="Referred by…" /></Field>
          {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
          <Button type="submit" block size="lg" loading={create.isPending}>Create & get link</Button>
        </form>
      )}
    </Sheet>
  )
}

function AccountSheet({ account: a, onClose }: { account: Account; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [plan, setPlan] = useState(a.plan?.code ?? 'shop')
  const [status, setStatus] = useState<SubStatus>(a.subscription.status ?? 'active')
  const [mode, setMode] = useState<'gift' | 'paid'>('gift')
  const [months, setMonths] = useState('1')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('transfer')
  const [note, setNote] = useState('')
  const { data: ledger } = useQuery({ queryKey: ['admin_ledger', a.id], queryFn: () => rpc<Entry[]>('admin_ledger', { p_org: a.id, p_limit: 50 }) })
  const refresh = () => ['admin_accounts', 'admin_overview', 'admin_ledger'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }))
  const s = subLine(a)

  const save = useMutation({
    mutationFn: () => rpc('admin_update_subscription', { p_org: a.id, p_plan_code: plan, p_status: status, p_note: null }),
    onSuccess: () => { toast('Membership updated', 'success'); refresh() },
    onError: (e) => toast(friendlyError(e), 'error'),
  })
  const grant = useMutation({
    mutationFn: () => rpc<{ current_period_end: string }>('admin_grant_months', {
      p_org: a.id, p_plan_code: plan, p_months: Number(months), p_gift: mode === 'gift',
      p_amount_cents: mode === 'paid' ? parseMoney(amount) ?? 0 : 0, p_method: mode === 'paid' ? method : null, p_note: note || null,
    }),
    onSuccess: (r) => { toast(`${mode === 'gift' ? 'Gifted' : 'Paid'} — active until ${date(r.current_period_end)}`, 'success'); setAmount(''); setNote(''); refresh(); onClose() },
    onError: (e) => toast(friendlyError(e), 'error'),
  })

  return (
    <Sheet open onClose={onClose} title={a.name} wide>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={a.kind === 'chair_owner' ? 'info' : 'accent'}>{a.kind === 'chair_owner' ? 'Chair owner' : 'Barbershop owner'}</Badge>
          <Badge tone={s.tone} className="normal-case tracking-normal">{a.plan?.name} · {s.text}</Badge>
          <span className="text-muted">{a.owner.full_name ?? ''} {a.owner.email} · joined {date(a.created_at)} · last sign-in {a.owner.last_sign_in_at ? ago(a.owner.last_sign_in_at) : 'never'}</span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[['Barbers', String(a.barbers)], ['Clients', num(a.clients)], ['GMV 30d', usd(a.gmv_30d_cents)], ['Paid to us', usd(a.paid_total_cents)]].map(([l, v]) => (
            <div key={l} className="rounded-xl bg-surface-2 p-3"><div className="eyebrow text-[10px]">{l}</div><div className="mt-1 text-lg font-semibold tnum">{v}</div></div>
          ))}
        </div>

        {a.shops.length > 0 && (
          <div>
            <div className="eyebrow mb-2">Shops</div>
            <div className="flex flex-wrap gap-2">
              {a.shops.map((sh) => (
                <a key={sh.id} href={`/shop/${sh.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent">
                  {sh.name} <ExternalLink className="size-3.5 text-muted" />{!sh.is_published && <span className="text-xs text-muted">(unpublished)</span>}
                </a>
              ))}
            </div>
          </div>
        )}

        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2 font-semibold"><Gift className="size-4 text-accent" /> Add months</div>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'gift', label: 'Gift (free)' }, { value: 'paid', label: 'Paid' }]} />
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Plan"><Select value={plan} onChange={(e) => setPlan(e.target.value)}>{PLANS.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
            <Field label="Months"><Select value={months} onChange={(e) => setMonths(e.target.value)}>{[1, 2, 3, 6, 12, 24].map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
            {mode === 'paid' ? (
              <Field label="Amount received"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="79.00" /></Field>
            ) : <div />}
          </div>
          {mode === 'paid' && (
            <Field label="Method" className="mt-3">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>{['transfer', 'card', 'cash', 'stripe', 'paypal', 'other'].map((m) => <option key={m} value={m}>{m}</option>)}</Select>
            </Field>
          )}
          <Field label="Note" className="mt-3"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'gift' ? 'Launch promo, referral…' : 'Invoice #, reference…'} /></Field>
          <Button className="mt-4" block loading={grant.isPending} disabled={mode === 'paid' && !parseMoney(amount)} onClick={() => grant.mutate()}>
            {mode === 'gift' ? `Gift ${months} month${months === '1' ? '' : 's'}` : `Record payment & add ${months} month${months === '1' ? '' : 's'}`}
          </Button>
        </Card>

        <Card className="p-4">
          <div className="mb-3 font-semibold">Plan & status</div>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Plan"><Select value={plan} onChange={(e) => setPlan(e.target.value)}>{PLANS.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value as SubStatus)}>
                {(['active', 'trialing', 'past_due', 'paused', 'cancelled'] as SubStatus[]).map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
              </Select>
            </Field>
            <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
          </div>
          <p className="mt-2 text-xs text-muted">Paused or cancelled accounts lose access to paid features immediately.</p>
        </Card>

        <div>
          <div className="eyebrow mb-2">History</div>
          {!ledger ? <Skeleton className="h-16" /> : ledger.length === 0 ? <p className="text-sm text-muted">Nothing recorded yet.</p> : (
            <div className="divide-y divide-line rounded-xl border border-line">{ledger.map((e) => <EntryRow key={e.id} e={e} />)}</div>
          )}
        </div>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
function PeopleTab() {
  const qc = useQueryClient()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [role, setRole] = useState<string | null>(null)
  const { data: people, isLoading } = useQuery({ queryKey: ['admin_people', q, role], queryFn: () => rpc<Person[]>('admin_people', { p_search: q || null, p_role: role }) })
  const toggleAdmin = useMutation({
    mutationFn: (p: Person) => rpc('admin_set_platform_admin', { p_email: p.email, p_on: !p.roles.includes('system_owner') }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin_people'] }); toast('Access updated', 'success') },
    onError: (e) => toast(friendlyError(e), 'error'),
  })
  const counts = useMemo(() => people?.length ?? 0, [people])
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-full sm:w-72" leading={<Search className="size-4" />} placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} />
        {[null, 'shop_owner', 'chair_owner', 'barber', 'client', 'system_owner'].map((r) => (
          <button key={r ?? 'all'} onClick={() => setRole(r)}
            className={cx('h-9 rounded-full border px-3.5 text-[13px] font-medium transition', role === r ? 'border-accent bg-accent-soft text-ink' : 'border-line text-muted hover:text-ink')}>
            {r ? ROLE_LABEL[r] : 'Everyone'}
          </button>
        ))}
        <span className="ml-auto text-sm text-muted">{counts} people</span>
      </div>
      <Card className="overflow-hidden">
        {isLoading ? <Skeleton className="m-5 h-40" /> : (people ?? []).length === 0 ? <EmptyState icon={<Users className="size-6" />} title="Nobody here" /> : (
          <div className="divide-y divide-line">
            {people!.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{p.full_name || p.email}</div>
                  <div className="truncate text-xs text-muted">{p.email}{p.shops.length ? ` · ${p.shops.join(', ')}` : ''} · joined {date(p.created_at)}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {p.roles.length ? p.roles.map((r) => <Badge key={r} tone={ROLE_TONE[r]}>{ROLE_LABEL[r] ?? r}</Badge>) : <Badge>No role yet</Badge>}
                </div>
                <Button size="sm" variant="ghost" onClick={() => toggleAdmin.mutate(p)} disabled={toggleAdmin.isPending}>
                  {p.roles.includes('system_owner') ? 'Remove system owner' : 'Make system owner'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------
function EntryRow({ e, showAccount }: { e: Entry; showAccount?: boolean }) {
  const tone = { payment: 'success', refund: 'danger', gift: 'warning', adjustment: 'neutral' } as const
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <Badge tone={tone[e.kind]}>{e.kind}</Badge>
      <div className="min-w-0 flex-1">
        <div className="truncate">
          {showAccount && <b>{e.account ?? 'No account'} · </b>}
          {e.kind === 'gift' ? `${e.months} month${e.months === 1 ? '' : 's'} of ${e.plan_code}` : e.kind === 'adjustment' ? e.note : `${e.months ? `${e.months} mo ${e.plan_code} · ` : ''}${e.method ?? ''}`}
        </div>
        <div className="truncate text-xs text-muted">{date(e.occurred_at)}{e.by ? ` · by ${e.by}` : ''}{e.note && e.kind !== 'adjustment' ? ` · ${e.note}` : ''}</div>
      </div>
      <div className={cx('font-semibold tnum', e.kind === 'refund' && 'text-danger')}>
        {e.kind === 'payment' ? usd(e.amount_cents) : e.kind === 'refund' ? `−${usd(e.amount_cents)}` : '—'}
      </div>
    </div>
  )
}

function LedgerTab() {
  const qc = useQueryClient()
  const toast = useToast()
  const { data: ledger, isLoading } = useQuery({ queryKey: ['admin_ledger', 'all'], queryFn: () => rpc<Entry[]>('admin_ledger', { p_org: null, p_limit: 500 }) })
  const { data: accounts } = useQuery({ queryKey: ['admin_accounts', ''], queryFn: () => rpc<Account[]>('admin_accounts', { p_search: null }) })
  const [f, setF] = useState({ org: '', kind: 'payment', amount: '', method: 'transfer', note: '' })
  const add = useMutation({
    mutationFn: () => rpc('admin_record_entry', { p_org: f.org || null, p_kind: f.kind, p_amount_cents: parseMoney(f.amount) ?? 0, p_method: f.method, p_note: f.note || null }),
    onSuccess: () => { setF({ ...f, amount: '', note: '' }); ['admin_ledger', 'admin_overview', 'admin_accounts'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('Recorded', 'success') },
    onError: (e) => toast(friendlyError(e), 'error'),
  })
  const net = (ledger ?? []).reduce((t, e) => t + (e.kind === 'payment' ? e.amount_cents : e.kind === 'refund' ? -e.amount_cents : 0), 0)
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card className="overflow-hidden">
        <CardHeader title="Cash ledger" subtitle={`Everything BarberNGo received, refunded or gifted · net ${usd(net)}`} />
        <div className="mt-3">
          {isLoading ? <Skeleton className="m-5 h-40" /> : (ledger ?? []).length === 0 ? (
            <EmptyState icon={<Wallet className="size-6" />} title="No entries yet" body="Payments you record and months you gift appear here." />
          ) : <div className="divide-y divide-line border-t border-line">{ledger!.map((e) => <EntryRow key={e.id} e={e} showAccount />)}</div>}
        </div>
      </Card>
      <Card className="h-fit p-5">
        <div className="mb-4 font-semibold">Record an entry</div>
        <div className="space-y-3">
          <Field label="Account">
            <Select value={f.org} onChange={(e) => setF({ ...f, org: e.target.value })}>
              <option value="">— No account —</option>
              {(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Type">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="payment">Payment received</option><option value="refund">Refund</option><option value="adjustment">Adjustment (note only)</option>
            </Select>
          </Field>
          {f.kind !== 'adjustment' && <Field label="Amount"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="79.00" /></Field>}
          <Field label="Method"><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{['transfer', 'card', 'cash', 'stripe', 'paypal', 'other'].map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
          <Field label="Note"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <Button block loading={add.isPending} disabled={f.kind !== 'adjustment' && !parseMoney(f.amount)} onClick={() => add.mutate()}>Record</Button>
          <p className="text-xs text-muted">To sell or gift plan months, open the account in <b>Accounts</b> — that also extends their membership.</p>
        </div>
      </Card>
    </div>
  )
}
