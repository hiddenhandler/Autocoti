import { useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Scissors } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useAnalytics, useBarbers, useServices } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { addDays, todayInTz } from '@/lib/time'
import { money, pct } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import { Avatar, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Sheet, Skeleton, Toggle, useToast } from '@/components/ui'

export default function Barbers() {
  const { ws, hasFeature } = useWorkspace()
  const today = todayInTz(ws.timezone)
  const { data: barbers, isLoading } = useBarbers(ws.shop_id, { includeArchived: true })
  const { data: a } = useAnalytics(ws.shop_id, addDays(today, -29), today)
  const [adding, setAdding] = useState(false)
  const active = barbers?.filter((b) => b.status !== 'archived') ?? []
  const archived = barbers?.filter((b) => b.status === 'archived') ?? []
  const maxBarbers = (useWorkspace().features?.max_barbers as number | null) ?? null

  return (
    <div>
      <PageHeader title="Barbers" subtitle={maxBarbers ? `${active.filter((b) => b.status === 'active').length} of ${maxBarbers} on your plan` : 'Last 30 days performance'}
        actions={<Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add barber</Button>} />
      {isLoading ? <Skeleton className="h-64" /> : active.length === 0 ? (
        <Card><EmptyState icon={<Scissors className="size-6" />} title="No barbers yet" body="Add your first barber to start taking bookings." action={<Button onClick={() => setAdding(true)}>Add barber</Button>} /></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {active.map((b) => {
            const p = a?.barbers.find((x) => x.barber_id === b.id)
            return (
              <Link key={b.id} to={`/app/barbers/${b.id}`}>
                <Card className="p-5 transition hover:border-accent">
                  <div className="flex items-center gap-3">
                    <Avatar name={b.display_name} src={b.photo_url} size={48} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{b.display_name}</div>
                      <div className="truncate text-sm text-muted">{b.title ?? 'Barber'}</div>
                    </div>
                    {b.status === 'suspended' ? <Badge tone="danger">Suspended</Badge> : !b.user_id ? <Badge tone="warning">No login</Badge> : !b.accepts_online_booking ? <Badge>Offline</Badge> : null}
                  </div>
                  <div className="mt-5 grid grid-cols-3 gap-2 text-sm">
                    <div><div className="text-[11px] uppercase tracking-wider text-muted">Revenue</div><div className="mt-0.5 font-semibold tnum">{p?.net_revenue_cents !== null && p?.net_revenue_cents !== undefined ? money(p.net_revenue_cents, { compact: true }) : '—'}</div></div>
                    <div><div className="text-[11px] uppercase tracking-wider text-muted">Cuts</div><div className="mt-0.5 font-semibold tnum">{p?.cuts ?? 0}</div></div>
                    <div><div className="text-[11px] uppercase tracking-wider text-muted">Utilization</div><div className="mt-0.5 font-semibold tnum">{pct(p?.utilization)}</div></div>
                  </div>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
      {archived.length > 0 && (
        <div className="mt-8">
          <div className="eyebrow mb-3">Former barbers</div>
          <div className="flex flex-wrap gap-2">{archived.map((b) => <Link key={b.id} to={`/app/barbers/${b.id}`}><Badge>{b.display_name}</Badge></Link>)}</div>
        </div>
      )}
      <AddBarberSheet open={adding} onClose={() => setAdding(false)} commissions={hasFeature('commissions')} />
    </div>
  )
}

function AddBarberSheet({ open, onClose, commissions }: { open: boolean; onClose: () => void; commissions: boolean }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: services } = useServices(ws.shop_id)
  const [f, setF] = useState({ name: '', email: '', title: '', percent: '50', copyHours: true })
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const { data: b, error } = await supabase.from('barbers').insert({ shop_id: ws.shop_id, display_name: f.name.trim(), title: f.title || null }).select().single()
      if (error) throw error
      await rpc('set_barber_services', { p_barber_id: b.id, p_service_ids: (services ?? []).filter((s) => s.is_active).map((s) => s.id) })
      if (f.copyHours) {
        const { data: hours } = await supabase.from('business_hours').select('*').eq('shop_id', ws.shop_id)
        await rpc('set_weekly_schedule', { p_barber_id: b.id, p_rows: (hours ?? []).map((h) => ({ weekday: h.weekday, starts_at: h.opens_at, ends_at: h.closes_at })) })
      }
      if (commissions && f.percent) await rpc('set_commission', { p_barber_id: b.id, p_type: 'percentage', p_percent_bps: Math.round(Number(f.percent) * 100) })
      if (f.email.trim()) {
        const token = await rpc<string>('invite_staff', { p_shop_id: ws.shop_id, p_email: f.email.trim(), p_role: 'barber', p_barber_id: b.id })
        await navigator.clipboard?.writeText(`${window.location.origin}/invite/${token}`).catch(() => {})
        toast(`${f.name} added. Invite emailed (link copied).`, 'success')
      } else toast(`${f.name} added`, 'success')
      qc.invalidateQueries({ queryKey: ['barbers', ws.shop_id] })
      qc.invalidateQueries({ queryKey: ['barber_services', ws.shop_id] })
      setF({ name: '', email: '', title: '', percent: '50', copyHours: true })
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Add barber" footer={<Button size="lg" block loading={busy} disabled={!f.name.trim()} onClick={submit}>Add barber</Button>}>
      <div className="space-y-4">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Title (optional)"><Input value={f.title} placeholder="Fade Specialist" onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Email (optional)" hint="We'll send an invite so they get their own login, calendar and earnings."><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        {commissions && <Field label="Commission %" hint="Share of service revenue. Change anytime (fixed, tiered, booth rental too)."><Input type="number" min={0} max={100} value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} /></Field>}
        <Toggle checked={f.copyHours} onChange={(v) => setF({ ...f, copyHours: v })} label="Start with shop hours" description="Performs all services; edit schedule and prices after." />
      </div>
    </Sheet>
  )
}
