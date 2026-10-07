import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Gift, Megaphone, MessageCircle, Plus, Star, Ticket, Users } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { rpc, supabase } from '@/lib/supabase'
import { ago, dateLabel, money, parseMoney } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import { Badge, Button, Card, CardHeader, cx, EmptyState, Field, Input, PageHeader, Segmented, Select, Sheet, Textarea, Toggle, useToast } from '@/components/ui'

type Tab = 'winback' | 'promos' | 'gift' | 'memberships' | 'reviews'

export default function Marketing() {
  const { hasFeature } = useWorkspace()
  const [tab, setTab] = useState<Tab>('winback')
  return (
    <div>
      <PageHeader eyebrow="Growth" title="Marketing" subtitle="Bring clients back, fill quiet hours, reward loyalty." />
      <div className="no-scrollbar -mx-4 mb-6 overflow-x-auto px-4">
        <Segmented value={tab} onChange={setTab} options={[
          { value: 'winback', label: 'Campaigns' }, { value: 'promos', label: 'Promo codes' }, { value: 'gift', label: 'Gift cards' },
          { value: 'memberships', label: 'Memberships' }, { value: 'reviews', label: 'Reviews' }]} />
      </div>
      {!hasFeature('marketing') && tab !== 'reviews' && tab !== 'promos' ? (
        <Card><EmptyState icon={<Megaphone className="size-6" />} title="Campaigns, gift cards and memberships are on the Pro plan" body="Promo codes and review management are available on every plan." /></Card>
      ) : tab === 'winback' ? <Campaigns /> : tab === 'promos' ? <Promos /> : tab === 'gift' ? <GiftCards /> : tab === 'memberships' ? <Memberships /> : <Reviews />}
    </div>
  )
}

const TEMPLATES = {
  reactivation: { name: 'Win back lapsed clients', subject: 'We miss you at {{shop_name}}', body: "Hey {{client_first_name}}, it's been {{days}} days since your last cut. {{barber_name}} has openings this week — book here: {{book_url}}", audience: { health: ['AT_RISK', 'LOST'] } },
  book_again: { name: 'Due for a cut', subject: 'Time for a fresh cut?', body: "Hey {{client_first_name}}, you're about due! Grab your usual spot: {{book_url}}", audience: { due: true } },
  birthday: { name: 'Birthday offer', subject: 'Happy birthday from {{shop_name}} 🎉', body: 'Happy birthday {{client_first_name}}! Use code {{promo_code}} this month for a treat on us: {{book_url}}', audience: { birthday_month: true } },
  promo: { name: 'Quiet-hours offer', subject: 'This week only at {{shop_name}}', body: 'Hey {{client_first_name}}, use code {{promo_code}} for weekday afternoons this week: {{book_url}}', audience: { all: true } },
} as const

function Campaigns() {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: campaigns } = useQuery({ queryKey: ['campaigns', ws.shop_id], queryFn: async () => (await supabase.from('campaigns').select('*').eq('shop_id', ws.shop_id).order('created_at', { ascending: false })).data ?? [] })
  const [draft, setDraft] = useState<null | { type: keyof typeof TEMPLATES; name: string; subject: string; body: string; audience: object; promo_code_id: string }>(null)
  const { data: count } = useQuery({ queryKey: ['audience', ws.shop_id, JSON.stringify(draft?.audience)], enabled: !!draft, queryFn: () => rpc<number>('preview_campaign_audience', { p_shop_id: ws.shop_id, p_audience: draft!.audience }) })
  const { data: promos } = useQuery({ queryKey: ['promos', ws.shop_id], queryFn: async () => (await supabase.from('promo_codes').select('id, code').eq('shop_id', ws.shop_id).eq('is_active', true)).data ?? [] })

  const send = async () => {
    if (!draft) return
    try {
      const { data, error } = await supabase.from('campaigns').insert({ shop_id: ws.shop_id, name: draft.name, type: draft.type === 'promo' ? 'promo' : draft.type === 'book_again' ? 'book_again' : draft.type === 'birthday' ? 'birthday' : 'reactivation', subject: draft.subject, body: draft.body, audience: draft.audience, promo_code_id: draft.promo_code_id || null }).select().single()
      if (error) throw error
      const n = await rpc<number>('send_campaign', { p_campaign_id: data.id })
      toast(`Queued for ${n} client${n === 1 ? '' : 's'}`, 'success')
      setDraft(null)
      qc.invalidateQueries({ queryKey: ['campaigns', ws.shop_id] })
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]).map((k) => (
          <button key={k} onClick={() => setDraft({ type: k, ...TEMPLATES[k], promo_code_id: '' })} className="rounded-2xl border border-line bg-surface p-5 text-left transition hover:border-accent">
            <Megaphone className="size-5 text-accent" />
            <div className="mt-3 font-semibold">{TEMPLATES[k].name}</div>
            <div className="mt-1 text-xs text-muted">{TEMPLATES[k].subject.replace('{{shop_name}}', ws.shop_name)}</div>
          </button>
        ))}
      </div>
      <Card>
        <CardHeader title="Sent campaigns" />
        {!campaigns?.length ? <EmptyState title="No campaigns yet" body="Only clients who opted in to marketing receive campaigns." /> : (
          <div className="mt-3 divide-y divide-line">
            {campaigns.map((c: any) => <div key={c.id} className="flex justify-between px-5 py-3 text-sm"><span className="font-medium">{c.name}</span><span className="text-muted">{c.sent_count} sent · {ago(c.created_at)}</span></div>)}
          </div>
        )}
      </Card>
      {draft && (
        <Sheet open onClose={() => setDraft(null)} title={draft.name} wide footer={<Button size="lg" block disabled={!count} onClick={send}>Send to {count ?? '…'} client{count === 1 ? '' : 's'}</Button>}>
          <div className="space-y-4">
            <Field label="Subject"><Input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></Field>
            <Field label="Message" hint="Variables: {{client_first_name}} {{days}} {{barber_name}} {{book_url}} {{promo_code}} {{shop_name}}"><Textarea rows={5} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></Field>
            <Field label="Attach promo code"><Select value={draft.promo_code_id} onChange={(e) => setDraft({ ...draft, promo_code_id: e.target.value })}><option value="">None</option>{promos?.map((p: any) => <option key={p.id} value={p.id}>{p.code}</option>)}</Select></Field>
            <p className="rounded-xl bg-surface-2 p-3 text-sm text-muted"><Users className="mr-1.5 inline size-4" />{count ?? '…'} opted-in clients match this audience.</p>
          </div>
        </Sheet>
      )}
    </div>
  )
}

function Promos() {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data } = useQuery({ queryKey: ['promos-all', ws.shop_id], queryFn: async () => (await supabase.from('promo_codes').select('*').eq('shop_id', ws.shop_id).order('created_at', { ascending: false })).data ?? [] })
  const [f, setF] = useState({ code: '', type: 'percent', value: '10', max: '', first: false, ends: '' })
  const create = async () => {
    const value = f.type === 'percent' ? Math.round(Number(f.value) * 100) : parseMoney(f.value)
    const { error } = await supabase.from('promo_codes').insert({ shop_id: ws.shop_id, code: f.code, discount_type: f.type, discount_value: value, max_redemptions: f.max ? Number(f.max) : null, first_visit_only: f.first, ends_at: f.ends || null })
    if (error) return toast(error.code === '23505' ? 'That code already exists' : friendlyError(error), 'error')
    setF({ code: '', type: 'percent', value: '10', max: '', first: false, ends: '' })
    qc.invalidateQueries({ queryKey: ['promos-all', ws.shop_id] })
  }
  const toggle = async (id: string, is_active: boolean) => {
    await supabase.from('promo_codes').update({ is_active }).eq('id', id)
    qc.invalidateQueries({ queryKey: ['promos-all', ws.shop_id] })
  }
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader title="Promo codes" subtitle="Applied at checkout; redemptions are tracked." />
        {!data?.length ? <EmptyState icon={<Ticket className="size-6" />} title="No promo codes" /> : (
          <div className="mt-3 divide-y divide-line">
            {data.map((p: any) => (
              <div key={p.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className="font-mono font-semibold">{p.code}</span>
                <span className="text-muted">{p.discount_type === 'percent' ? `${p.discount_value / 100}% off` : `${money(p.discount_value)} off`}{p.first_visit_only ? ' · first visit' : ''}</span>
                <span className="ml-auto text-muted tnum">{p.redemptions}{p.max_redemptions ? `/${p.max_redemptions}` : ''} used</span>
                <Toggle checked={p.is_active} onChange={(v) => toggle(p.id, v)} />
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card className="space-y-3 p-5">
        <div className="font-semibold">New code</div>
        <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/\s/g, '') })} placeholder="WELCOME10" /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="percent">% off</option><option value="amount">$ off</option></Select></Field>
          <Field label="Value"><Input value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max uses"><Input type="number" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} placeholder="∞" /></Field>
          <Field label="Ends"><Input type="date" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} /></Field>
        </div>
        <Toggle checked={f.first} onChange={(v) => setF({ ...f, first: v })} label="First visit only" />
        <Button block disabled={f.code.length < 2} onClick={create} icon={<Plus className="size-4" />}>Create</Button>
      </Card>
    </div>
  )
}

function GiftCards() {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data } = useQuery({ queryKey: ['gift_cards', ws.shop_id], queryFn: async () => (await supabase.from('gift_cards').select('*').eq('shop_id', ws.shop_id).order('created_at', { ascending: false })).data ?? [] })
  const [amount, setAmount] = useState('50')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [expires, setExpires] = useState('')
  const [redeem, setRedeem] = useState({ code: '', amount: '' })
  const issue = async () => {
    try {
      const r = await rpc<{ code: string }>('issue_gift_card', { p_shop_id: ws.shop_id, p_amount_cents: parseMoney(amount), p_recipient_name: name || null, p_recipient_email: email || null, p_expires_at: expires || null })
      toast(`Gift card ${r.code} issued`, 'success')
      qc.invalidateQueries({ queryKey: ['gift_cards', ws.shop_id] })
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  const doRedeem = async () => {
    try {
      const left = await rpc<number>('redeem_gift_card', { p_shop_id: ws.shop_id, p_code: redeem.code, p_amount_cents: parseMoney(redeem.amount) })
      toast(`Redeemed. Remaining balance ${money(left)}`, 'success')
      qc.invalidateQueries({ queryKey: ['gift_cards', ws.shop_id] })
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  const issued = data?.reduce((t: number, g: any) => t + g.initial_cents, 0) ?? 0
  const outstanding = data?.filter((g: any) => g.status === 'active').reduce((t: number, g: any) => t + g.balance_cents, 0) ?? 0
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader title="Gift cards" subtitle={`${money(issued)} issued · ${money(outstanding)} outstanding · ${money(issued - outstanding)} redeemed`} />
        {!data?.length ? <EmptyState icon={<Gift className="size-6" />} title="No gift cards yet" /> : (
          <div className="mt-3 divide-y divide-line">
            {data.map((g: any) => (
              <div key={g.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className="font-mono font-semibold">{g.code}</span>
                <span className="text-muted">{g.recipient_name ?? ''}</span>
                <span className="ml-auto tnum">{money(g.balance_cents)} <span className="text-muted">/ {money(g.initial_cents)}</span></span>
                <Badge tone={g.status === 'active' ? 'success' : 'neutral'}>{g.status}</Badge>
                {g.expires_at && <span className="text-xs text-muted">exp {g.expires_at}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>
      <div className="space-y-4">
        <Card className="space-y-3 p-5">
          <div className="font-semibold">Sell a gift card</div>
          <div className="flex gap-2">{['25', '50', '100'].map((v) => <button key={v} onClick={() => setAmount(v)} className={cx('h-10 flex-1 rounded-xl border text-sm font-semibold', amount === v ? 'border-accent bg-accent-soft' : 'border-line')}>${v}</button>)}</div>
          <Field label="Custom amount"><Input leading="$" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Recipient"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Recipient email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Expires"><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
          <Button block onClick={issue}>Issue & record sale</Button>
        </Card>
        <Card className="space-y-3 p-5">
          <div className="font-semibold">Redeem</div>
          <Input placeholder="Code" value={redeem.code} onChange={(e) => setRedeem({ ...redeem, code: e.target.value.toUpperCase() })} />
          <Input leading="$" placeholder="Amount" value={redeem.amount} onChange={(e) => setRedeem({ ...redeem, amount: e.target.value })} />
          <Button variant="secondary" block onClick={doRedeem}>Redeem</Button>
        </Card>
      </div>
    </div>
  )
}

function Memberships() {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: plans } = useQuery({ queryKey: ['membership_plans', ws.shop_id], queryFn: async () => (await supabase.from('membership_plans').select('*').eq('shop_id', ws.shop_id).order('created_at')).data ?? [] })
  const { data: members } = useQuery({ queryKey: ['client_memberships', ws.shop_id], queryFn: async () => (await supabase.from('client_memberships').select('*, client:clients(first_name, last_name), plan:membership_plans(name)').eq('shop_id', ws.shop_id).order('created_at', { ascending: false })).data ?? [] })
  const [f, setF] = useState({ name: '4 cuts / month', price: '99', visits: '4', interval: 'month' })
  const create = async () => {
    const { error } = await supabase.from('membership_plans').insert({ shop_id: ws.shop_id, name: f.name, price_cents: parseMoney(f.price), included_visits: f.visits ? Number(f.visits) : null, billing_interval: f.interval })
    if (error) return toast(friendlyError(error), 'error')
    qc.invalidateQueries({ queryKey: ['membership_plans', ws.shop_id] })
  }
  const setStatus = async (id: string, s: string) => {
    try { await rpc('update_client_membership', { p_id: id, p_status: s }); qc.invalidateQueries({ queryKey: ['client_memberships', ws.shop_id] }) } catch (e) { toast(friendlyError(e), 'error') }
  }
  const active = members?.filter((m: any) => m.status === 'active') ?? []
  const mrr = active.reduce((t: number, m: any) => t + (plans?.find((p: any) => p.id === m.plan_id)?.price_cents ?? 0), 0)
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <Card>
          <CardHeader title="Plans" subtitle={`${active.length} active members · ${money(mrr)} recurring`} />
          {!plans?.length ? <EmptyState title="No membership plans" body="e.g. 4 haircuts/month, unlimited cuts, haircut + beard package." /> : (
            <div className="mt-3 divide-y divide-line">{plans.map((p: any) => <div key={p.id} className="flex justify-between px-5 py-3 text-sm"><span className="font-medium">{p.name}</span><span className="text-muted">{money(p.price_cents)}/{p.billing_interval} · {p.included_visits ?? 'unlimited'} visits</span></div>)}</div>
          )}
        </Card>
        <Card>
          <CardHeader title="Members" subtitle="Sell a membership from a client's profile flow below" />
          {!members?.length ? <EmptyState title="No members yet" /> : (
            <div className="mt-3 divide-y divide-line">
              {members.map((m: any) => (
                <div key={m.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                  <span className="font-medium">{m.client.first_name} {m.client.last_name}</span>
                  <span className="text-muted">{m.plan.name} · {m.visits_used} used · renews {m.current_period_end}</span>
                  <Select className="ml-auto h-8 w-32 text-xs" value={m.status} onChange={(e) => setStatus(m.id, e.target.value)}>
                    <option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <div className="space-y-4">
        <Card className="space-y-3 p-5">
          <div className="font-semibold">New plan</div>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Price"><Input leading="$" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
            <Field label="Visits" hint="Empty = unlimited"><Input type="number" value={f.visits} onChange={(e) => setF({ ...f, visits: e.target.value })} /></Field>
          </div>
          <Field label="Billed every"><Select value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></Select></Field>
          <Button block onClick={create}>Create plan</Button>
        </Card>
        <SellMembership plans={plans ?? []} />
      </div>
    </div>
  )
}

function SellMembership({ plans }: { plans: any[] }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [plan, setPlan] = useState('')
  const { data } = useQuery({ queryKey: ['sell-search', q], enabled: q.length >= 2, queryFn: () => rpc<any[]>('list_clients', { p_shop_id: ws.shop_id, p_search: q, p_limit: 5 }) })
  const sell = async (clientId: string) => {
    try {
      await rpc('assign_membership', { p_client_id: clientId, p_plan_id: plan || plans[0]?.id })
      toast('Membership started & payment recorded', 'success')
      qc.invalidateQueries({ queryKey: ['client_memberships', ws.shop_id] })
      setQ('')
    } catch (e) { toast(friendlyError(e), 'error') }
  }
  if (!plans.length) return null
  return (
    <Card className="space-y-3 p-5">
      <div className="font-semibold">Sell a membership</div>
      <Select value={plan} onChange={(e) => setPlan(e.target.value)}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      <Input placeholder="Find client…" value={q} onChange={(e) => setQ(e.target.value)} />
      {data?.map((c) => <button key={c.id} onClick={() => sell(c.id)} className="block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2">{c.first_name} {c.last_name} <span className="text-muted">{c.phone}</span></button>)}
    </Card>
  )
}

function Reviews() {
  const { ws, can } = useWorkspace()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['reviews', ws.shop_id], queryFn: async () => (await supabase.from('reviews').select('*, client:clients(first_name), barber:barbers(display_name)').eq('shop_id', ws.shop_id).order('created_at', { ascending: false }).limit(100)).data ?? [] })
  const [reply, setReply] = useState<Record<string, string>>({})
  const update = async (id: string, patch: Record<string, unknown>) => {
    await supabase.from('reviews').update(patch).eq('id', id)
    qc.invalidateQueries({ queryKey: ['reviews', ws.shop_id] })
  }
  if (!data?.length) return <Card><EmptyState icon={<Star className="size-6" />} title="No reviews yet" body="After each completed cut, clients get a review request automatically." /></Card>
  return (
    <div className="space-y-3">
      {data.map((r: any) => (
        <Card key={r.id} className={cx('p-5', r.hidden_at && 'opacity-60')}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-accent">{'★'.repeat(r.barber_rating ?? r.shop_rating)}<span className="opacity-25">{'★'.repeat(5 - (r.barber_rating ?? r.shop_rating))}</span></div>
              <p className="mt-2">{r.comment ?? <span className="text-muted">No comment</span>}</p>
              <p className="mt-1 text-xs text-muted">{r.client?.first_name} · {r.barber?.display_name} · {dateLabel(r.created_at, ws.timezone)}</p>
            </div>
            {can('reviews.manage') && <Button size="sm" variant="ghost" onClick={() => update(r.id, { hidden_at: r.hidden_at ? null : new Date().toISOString() })}>{r.hidden_at ? 'Show' : 'Hide'}</Button>}
          </div>
          {r.owner_reply ? <p className="mt-3 border-l-2 border-accent pl-3 text-sm text-muted">{r.owner_reply}</p> : can('reviews.manage') && (
            <div className="mt-3 flex gap-2">
              <Input placeholder="Reply publicly…" value={reply[r.id] ?? ''} onChange={(e) => setReply({ ...reply, [r.id]: e.target.value })} />
              <Button variant="secondary" icon={<MessageCircle className="size-4" />} disabled={!reply[r.id]} onClick={() => update(r.id, { owner_reply: reply[r.id], replied_at: new Date().toISOString() })}>Reply</Button>
            </div>
          )}
        </Card>
      ))}
    </div>
  )
}
