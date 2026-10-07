import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Mail, Plus, Trash2 } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useBarberServices, useBarbers, useServices } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { money, parseMoney } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import { BarberScheduleEditor } from '@/components/BarberScheduleEditor'
import { BarberEarnings } from './Earnings'
import { ProfileForm } from './MyProfile'
import { Avatar, Badge, Button, Card, CardHeader, Field, Input, Segmented, Select, Skeleton, Toggle, useToast } from '@/components/ui'
import type { Barber } from '@/lib/types'

type Tab = 'performance' | 'profile' | 'services' | 'schedule' | 'commission' | 'access'

export default function BarberDetail() {
  const { id } = useParams()
  const { ws, can, hasFeature } = useWorkspace()
  const { data: barbers } = useBarbers(ws.shop_id, { includeArchived: true })
  const b = barbers?.find((x) => x.id === id)
  const [tab, setTab] = useState<Tab>('performance')
  if (!barbers) return <Skeleton className="h-96" />
  if (!b) return <p className="text-muted">Barber not found.</p>
  const tabs: { value: Tab; label: string }[] = [
    { value: 'performance', label: 'Performance' },
    { value: 'profile', label: 'Profile' },
    { value: 'services', label: 'Services & prices' },
    { value: 'schedule', label: 'Schedule' },
    ...(can('commissions.manage') && hasFeature('commissions') ? [{ value: 'commission' as Tab, label: 'Commission' }] : []),
    { value: 'access', label: 'Access' },
  ]
  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/app/barbers" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Barbers</Link>
      <div className="mb-6 mt-4 flex flex-wrap items-center gap-4">
        <Avatar name={b.display_name} src={b.photo_url} size={64} />
        <div className="flex-1">
          <h1 className="display text-[40px] leading-none">{b.display_name}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted">{b.title ?? 'Barber'} {b.status !== 'active' && <Badge tone="danger">{b.status}</Badge>}</div>
        </div>
      </div>
      <div className="no-scrollbar -mx-4 mb-6 overflow-x-auto px-4"><Segmented value={tab} onChange={setTab} options={tabs} /></div>
      {tab === 'performance' && <BarberEarnings barberId={b.id} embedded />}
      {tab === 'profile' && <ProfileForm barber={b} title="Public profile" />}
      {tab === 'services' && <ServicePrices barber={b} />}
      {tab === 'schedule' && <BarberScheduleEditor barber={b} />}
      {tab === 'commission' && <CommissionEditor barber={b} />}
      {tab === 'access' && <Access barber={b} />}
    </div>
  )
}

function ServicePrices({ barber }: { barber: Barber }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: services } = useServices(ws.shop_id)
  const { data: bs } = useBarberServices(ws.shop_id)
  const mine = (bs ?? []).filter((x) => x.barber_id === barber.id)
  const save = async (serviceId: string, patch: { price_cents?: number | null; duration_minutes?: number | null; is_active?: boolean }) => {
    const existing = mine.find((x) => x.service_id === serviceId)
    const { error } = existing
      ? await supabase.from('barber_services').update(patch).eq('barber_id', barber.id).eq('service_id', serviceId)
      : await supabase.from('barber_services').insert({ barber_id: barber.id, service_id: serviceId, ...patch })
    if (error) toast(friendlyError(error), 'error')
    else qc.invalidateQueries({ queryKey: ['barber_services', ws.shop_id] })
  }
  return (
    <Card>
      <CardHeader title="Services & prices" subtitle="Leave price or duration empty to use the shop default." />
      <div className="mt-3 divide-y divide-line">
        {services?.filter((s) => s.is_active).map((s) => {
          const row = mine.find((x) => x.service_id === s.id)
          const on = !!row?.is_active
          return (
            <div key={s.id} className="grid grid-cols-[1fr_auto] items-center gap-3 px-5 py-3 sm:grid-cols-[1fr_120px_120px_auto]">
              <div>
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-muted">Shop default {money(s.price_cents)} · {s.duration_minutes} min</div>
              </div>
              <PriceInput disabled={!on} value={row?.price_cents ?? null} placeholder={(s.price_cents / 100).toString()} onSave={(v) => save(s.id, { price_cents: v })} />
              <Select disabled={!on} className="h-10" value={row?.duration_minutes ?? ''} onChange={(e) => save(s.id, { duration_minutes: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{s.duration_minutes} min</option>
                {[15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 75, 90].map((m) => <option key={m} value={m}>{m} min</option>)}
              </Select>
              <Toggle checked={on} onChange={(v) => save(s.id, { is_active: v })} />
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function PriceInput({ value, placeholder, onSave, disabled }: { value: number | null; placeholder: string; onSave: (v: number | null) => void; disabled?: boolean }) {
  const [v, setV] = useState(value !== null ? (value / 100).toString() : '')
  useEffect(() => setV(value !== null ? (value / 100).toString() : ''), [value])
  return (
    <Input disabled={disabled} className="h-10" leading="$" inputMode="decimal" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => { const next = v === '' ? null : parseMoney(v); if (next !== value) onSave(next) }} />
  )
}

function CommissionEditor({ barber }: { barber: Barber }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { data: history } = useQuery({
    queryKey: ['commission', barber.id, 'all'],
    queryFn: async () => (await supabase.from('commissions').select('*').eq('barber_id', barber.id).order('effective_from', { ascending: false })).data ?? [],
  })
  const current = history?.find((h: any) => !h.effective_to)
  const [type, setType] = useState('percentage')
  const [percent, setPercent] = useState('50')
  const [fixed, setFixed] = useState('15')
  const [rent, setRent] = useState('250')
  const [period, setPeriod] = useState('week')
  const [tipShare, setTipShare] = useState('100')
  const [tiers, setTiers] = useState([{ up_to: '3000', percent: '40' }, { up_to: '', percent: '50' }])
  useEffect(() => {
    if (!current) return
    setType(current.type)
    if (current.percent_bps !== null) setPercent(String(current.percent_bps / 100))
    if (current.fixed_cents !== null) setFixed(String(current.fixed_cents / 100))
    if (current.rent_cents !== null) setRent(String(current.rent_cents / 100))
    if (current.rent_period) setPeriod(current.rent_period)
    setTipShare(String(current.tip_share_bps / 100))
    if (current.tiers) setTiers(current.tiers.map((t: any) => ({ up_to: t.up_to_cents === null ? '' : String(t.up_to_cents / 100), percent: String(t.percent_bps / 100) })))
  }, [current])

  const example = 3500
  const exampleCut = type === 'percentage' || type === 'hybrid' ? Math.round((example * Number(percent)) / 100) : type === 'fixed' ? Math.min(example, (parseMoney(fixed) ?? 0)) : type === 'booth_rental' ? example : null

  const save = async () => {
    try {
      await rpc('set_commission', {
        p_barber_id: barber.id, p_type: type,
        p_percent_bps: ['percentage', 'hybrid'].includes(type) ? Math.round(Number(percent) * 100) : null,
        p_fixed_cents: type === 'fixed' ? parseMoney(fixed) : null,
        p_tiers: type === 'tiered' ? tiers.map((t) => ({ up_to_cents: t.up_to ? parseMoney(t.up_to) : null, percent_bps: Math.round(Number(t.percent) * 100) })) : null,
        p_rent_cents: ['booth_rental', 'hybrid'].includes(type) ? parseMoney(rent) : null,
        p_rent_period: ['booth_rental', 'hybrid'].includes(type) ? period : null,
        p_tip_share_bps: Math.round(Number(tipShare) * 100),
      })
      qc.invalidateQueries({ queryKey: ['commission', barber.id] })
      toast('Commission saved — applies from today', 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="mb-4 text-[15px] font-semibold">Pay structure</div>
        <Segmented value={type} onChange={setType} options={[
          { value: 'percentage', label: 'Percentage' }, { value: 'fixed', label: 'Per service' }, { value: 'tiered', label: 'Tiered' },
          { value: 'booth_rental', label: 'Booth rent' }, { value: 'hybrid', label: 'Hybrid' }]} />
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {['percentage', 'hybrid'].includes(type) && <Field label="Barber's share %"><Input type="number" min={0} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} /></Field>}
          {type === 'fixed' && <Field label="Per service"><Input leading="$" value={fixed} onChange={(e) => setFixed(e.target.value)} /></Field>}
          {['booth_rental', 'hybrid'].includes(type) && (
            <>
              <Field label="Rent"><Input leading="$" value={rent} onChange={(e) => setRent(e.target.value)} /></Field>
              <Field label="Per"><Select value={period} onChange={(e) => setPeriod(e.target.value)}><option value="week">Week</option><option value="month">Month</option></Select></Field>
            </>
          )}
          <Field label="Barber's share of tips %"><Input type="number" min={0} max={100} value={tipShare} onChange={(e) => setTipShare(e.target.value)} /></Field>
        </div>
        {type === 'tiered' && (
          <div className="mt-4 space-y-2">
            <div className="text-[13px] text-muted">Month-to-date service revenue → share</div>
            {tiers.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-16 text-sm text-muted">{i === 0 ? 'Up to' : tiers[i - 1]?.up_to ? `After $${tiers[i - 1].up_to}` : 'Next'}</span>
                <Input className="w-32" leading="$" placeholder="no limit" value={t.up_to} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, up_to: e.target.value } : x)))} />
                <Input className="w-24" type="number" value={t.percent} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} />
                <span className="text-sm text-muted">%</span>
                {tiers.length > 1 && <button aria-label="Remove tier" onClick={() => setTiers(tiers.filter((_, j) => j !== i))} className="text-muted hover:text-danger"><Trash2 className="size-4" /></button>}
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setTiers([...tiers, { up_to: '', percent: '' }])}>Tier</Button>
          </div>
        )}
        {exampleCut !== null && (
          <div className="mt-5 rounded-xl bg-surface-2 p-4 text-sm">
            Example: a {money(example)} haircut → <b>{barber.display_name} {money(exampleCut)}</b> · Shop {money(example - exampleCut)}
            {['booth_rental', 'hybrid'].includes(type) && <span className="text-muted"> (+ {money(parseMoney(rent))}/{period} rent to the shop)</span>}
          </div>
        )}
        <Button className="mt-5" onClick={save}>Save commission</Button>
      </Card>
      {!!history?.length && (
        <Card>
          <CardHeader title="History" />
          <div className="divide-y divide-line px-5 py-2 text-sm">
            {history.map((h: any) => (
              <div key={h.id} className="flex justify-between py-2.5">
                <span className="capitalize">{h.type.replace('_', ' ')} {h.percent_bps !== null ? `${h.percent_bps / 100}%` : ''} {h.fixed_cents !== null ? money(h.fixed_cents) : ''}</span>
                <span className="text-muted">{h.effective_from} → {h.effective_to ?? 'now'}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function Access({ barber }: { barber: Barber }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const setStatus = async (status: 'active' | 'suspended') => {
    const { error } = await supabase.from('barbers').update({ status }).eq('id', barber.id)
    if (error) toast(friendlyError(error), 'error')
    else { toast(status === 'active' ? 'Reactivated' : 'Suspended — removed from online booking', 'success'); qc.invalidateQueries({ queryKey: ['barbers'] }) }
  }
  const archive = async () => {
    if (!confirm(`Remove ${barber.display_name} from the shop? History and reports stay intact.`)) return
    try {
      const future = await rpc<number>('archive_barber', { p_barber_id: barber.id })
      toast(future ? `Archived. ${future} future appointment(s) need reassigning.` : 'Archived', future ? 'error' : 'success')
      qc.invalidateQueries({ queryKey: ['barbers'] })
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  const invite = async () => {
    try {
      const token = await rpc<string>('invite_staff', { p_shop_id: ws.shop_id, p_email: email, p_role: 'barber', p_barber_id: barber.id })
      await navigator.clipboard?.writeText(`${window.location.origin}/invite/${token}`).catch(() => {})
      toast('Invite sent (link copied)', 'success')
      setEmail('')
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="font-semibold">Login</div>
        {barber.user_id ? (
          <p className="mt-1 text-sm text-muted">{barber.display_name} has their own login and sees only their schedule, clients and earnings.</p>
        ) : (
          <div className="mt-3 flex gap-2">
            <Input type="email" placeholder="barber@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button icon={<Mail className="size-4" />} disabled={!email} onClick={invite}>Invite</Button>
          </div>
        )}
      </Card>
      <Card className="p-5">
        <div className="font-semibold">Status</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {barber.status === 'active' ? <Button variant="secondary" onClick={() => setStatus('suspended')}>Suspend</Button> : barber.status === 'suspended' ? <Button variant="secondary" onClick={() => setStatus('active')}>Reactivate</Button> : null}
          {barber.status !== 'archived' && <Button variant="danger" onClick={archive}>Remove from shop</Button>}
        </div>
      </Card>
    </div>
  )
}
