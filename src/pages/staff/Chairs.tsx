import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Users } from 'lucide-react'
import { BarberChair3D, BarberChairIcon } from '@/components/BarberChair'
import { useWorkspace } from '@/lib/auth'
import { useBarbers, useLiveBoard } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { money, parseMoney } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import type { BarberType, LiveBoard, LiveBoardBarber } from '@/lib/types'
import { Avatar, Badge, Button, Card, cx, EmptyState, Field, Input, PageHeader, Segmented, Select, Sheet, Skeleton, useToast } from '@/components/ui'
import { LIVE, LivePill, liveLines } from '@/components/live'

type Chair = LiveBoard['chairs'][number]

/** CHAIR VIEW: every chair, who's in it, live status, employee vs chair owner. */
export default function Chairs() {
  const { ws, can } = useWorkspace()
  const { data: board, isLoading } = useLiveBoard(ws.shop_id)
  const [edit, setEdit] = useState<Chair | 'new' | null>(null)
  const manage = can('staff.manage')
  const unseated = (board?.barbers ?? []).filter((b) => !b.chair_id)

  return (
    <div>
      <PageHeader eyebrow="Live" title="Chairs"
        subtitle={board ? `${board.counts.working} working · ${board.counts.available} available · ${board.counts.cutting} cutting · ${board.counts.on_break} on break` : 'Who is in which chair, right now'}
        actions={manage && <Button icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>Add chair</Button>} />

      {board && <StatusStrip board={board} />}

      {isLoading || !board ? <Skeleton className="h-64" /> : board.chairs.length === 0 ? (
        <Card>
          <EmptyState icon={<BarberChairIcon className="size-6" />} title="Set up your chairs"
            body="Add a chair for each station and assign a barber. Employees and chair owners are handled differently for pricing, schedule and money."
            action={manage && <Button onClick={() => setEdit('new')}>Add first chair</Button>} />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {board.chairs.map((c) => (
            <ChairCard key={c.id} chair={c} tz={ws.timezone} onClick={manage ? () => setEdit(c) : undefined} />
          ))}
        </div>
      )}

      {unseated.length > 0 && (
        <div className="mt-8">
          <div className="eyebrow mb-3">Not assigned to a chair</div>
          <div className="flex flex-wrap gap-2">
            {unseated.map((b) => (
              <Card key={b.barber_id} className="flex items-center gap-2.5 px-3 py-2">
                <Avatar name={b.name} src={b.photo_url} size={28} />
                <span className="text-sm font-medium">{b.name}</span>
                <LivePill status={b.status} size="sm" />
              </Card>
            ))}
          </div>
        </div>
      )}

      {edit && <ChairSheet chair={edit === 'new' ? null : edit} board={board!} onClose={() => setEdit(null)} />}
    </div>
  )
}

function StatusStrip({ board }: { board: LiveBoard }) {
  const items = [
    { label: 'Working', value: board.counts.working, tone: 'text-ink' },
    { label: 'Available', value: board.counts.available, tone: 'text-success' },
    { label: 'Cutting', value: board.counts.cutting, tone: 'text-accent' },
    { label: 'On break', value: board.counts.on_break, tone: 'text-warning' },
    { label: 'Queue', value: board.walk_ins.waiting, tone: 'text-info' },
  ]
  return (
    <Card className="mb-5 grid grid-cols-5 divide-x divide-line">
      {items.map((i) => (
        <div key={i.label} className="px-2 py-3 text-center">
          <div className={cx('text-2xl font-bold tnum', i.tone)}>{i.value}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{i.label}</div>
        </div>
      ))}
    </Card>
  )
}

function ChairCard({ chair, tz, onClick }: { chair: Chair; tz: string; onClick?: () => void }) {
  const b = chair.barber
  return (
    <Card as="article" className={cx('overflow-hidden transition', b && LIVE[b.status].ring, onClick && 'cursor-pointer hover:-translate-y-0.5 hover:border-accent', !chair.is_active && 'opacity-50')} onClick={onClick}>
      {/* Stage: the chair itself, lit in the barber's live status colour */}
      <div className="relative bg-[radial-gradient(120%_90%_at_50%_0%,var(--surface-3),var(--surface-2)_55%,var(--surface))] px-5 pt-4">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-bold tracking-[0.18em] text-muted">{chair.label.toUpperCase()}</div>
          {b && <Badge tone={b.barber_type === 'chair_owner' ? 'accent' : 'neutral'}>{b.barber_type === 'chair_owner' ? 'Chair owner' : 'Employee'}</Badge>}
          {!chair.is_active && <Badge>Inactive</Badge>}
        </div>
        <BarberChair3D status={b ? b.status : 'EMPTY'} dim={!b} className="mx-auto -mb-1 mt-1 h-32 w-auto" />
        {b && <Avatar name={b.name} src={b.photo_url} size={40} className="absolute bottom-3 right-4 ring-2 ring-surface" />}
      </div>
      <div className="border-t border-line p-5 pt-4">
        {b ? (
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold leading-tight">{b.name}</div>
            <LivePill status={b.status} className="mt-1" />
            <div className="mt-1 space-y-0.5 text-[13px] text-muted">
              {b.current?.service && <div>{b.current.service}</div>}
              {liveLines(b, tz).map((l) => <div key={l}>{l}</div>)}
            </div>
          </div>
        ) : (
          <div>
            <div className="font-semibold">Open chair</div>
            <div className="text-[13px] text-muted">No barber assigned{onClick ? ' — tap to assign' : ''}</div>
          </div>
        )}
      </div>
    </Card>
  )
}

function ChairSheet({ chair, board, onClose }: { chair: Chair | null; board: LiveBoard; onClose: () => void }) {
  const { ws, can } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: barbers } = useBarbers(ws.shop_id)
  const [label, setLabel] = useState(chair?.label ?? `Chair ${String(board.chairs.length + 1).padStart(2, '0')}`)
  const [barberId, setBarberId] = useState<string>(chair?.barber_id ?? '')
  const [active, setActive] = useState(chair?.is_active ?? true)
  const [busy, setBusy] = useState(false)
  const barber = board.barbers.find((b) => b.barber_id === barberId)
  const canTerms = can('commissions.manage') && !!barberId

  const save = async () => {
    setBusy(true)
    try {
      await rpc('save_chair', { p_shop_id: ws.shop_id, p_chair_id: chair?.id ?? null, p_label: label, p_barber_id: barberId || null, p_is_active: active })
      qc.invalidateQueries({ queryKey: ['live_board', ws.shop_id] })
      toast('Chair saved', 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!chair || !confirm(`Remove ${chair.label}?`)) return
    try {
      await rpc('delete_chair', { p_chair_id: chair.id })
      qc.invalidateQueries({ queryKey: ['live_board', ws.shop_id] })
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }

  return (
    <Sheet open onClose={onClose} title={chair ? chair.label : 'New chair'}
      footer={<div className="flex gap-2">
        {chair && <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={remove}>Remove</Button>}
        <Button className="flex-1" loading={busy} onClick={save}>Save chair</Button>
      </div>}>
      <div className="space-y-4">
        <Field label="Chair name"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Chair 01" /></Field>
        <Field label="Barber" hint="A barber sits in one chair at a time; assigning them here frees their old chair.">
          <Select value={barberId} onChange={(e) => setBarberId(e.target.value)}>
            <option value="">— Available (no barber) —</option>
            {(barbers ?? []).filter((b) => b.status === 'active').map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}
          </Select>
        </Field>
        <Segmented value={active ? 'on' : 'off'} onChange={(v) => setActive(v === 'on')} options={[{ value: 'on', label: 'In use' }, { value: 'off', label: 'Out of service' }]} />
        {canTerms && barber && <BarberTerms barber={barber} />}
        {!barbers?.length && <p className="text-sm text-muted"><Link className="underline" to="/app/barbers">Add barbers</Link> first.</p>}
      </div>
    </Sheet>
  )
}

/** Employee (commission) vs chair owner (rent, keeps 100%). */
function BarberTerms({ barber }: { barber: LiveBoardBarber }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: rule } = useQuery({
    queryKey: ['commission', barber.barber_id, 'current'],
    queryFn: async () => (await supabase.from('commissions').select('*').eq('barber_id', barber.barber_id).order('effective_from', { ascending: false }).limit(1).maybeSingle()).data,
  })
  const [type, setType] = useState<BarberType>(barber.barber_type)
  const [rent, setRent] = useState('')
  const [period, setPeriod] = useState<'week' | 'month'>('week')
  const [percent, setPercent] = useState('')
  const [busy, setBusy] = useState(false)
  const rentVal = rent || (rule?.rent_cents ? String(rule.rent_cents / 100) : '')
  const pctVal = percent || (rule?.percent_bps && rule.type !== 'booth_rental' ? String(rule.percent_bps / 100) : '50')

  const save = async () => {
    setBusy(true)
    try {
      await rpc('set_barber_type', {
        p_barber_id: barber.barber_id, p_type: type,
        p_rent_cents: type === 'chair_owner' ? parseMoney(rentVal) : null,
        p_rent_period: rule?.rent_period && !rent ? rule.rent_period : period,
        p_percent_bps: type === 'employee' ? Math.round(Number(pctVal) * 100) : null,
      })
      qc.invalidateQueries({ queryKey: ['live_board', ws.shop_id] })
      qc.invalidateQueries({ queryKey: ['commission', barber.barber_id] })
      qc.invalidateQueries({ queryKey: ['barbers', ws.shop_id] })
      qc.invalidateQueries({ queryKey: ['finance', ws.shop_id] })
      toast(type === 'chair_owner' ? `${barber.name} is a chair owner` : `${barber.name} is an employee`, 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-4 bg-surface-2/50 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold"><Users className="size-4" /> {barber.name}'s terms</div>
      <Segmented value={type} onChange={setType} options={[{ value: 'employee', label: 'Employee' }, { value: 'chair_owner', label: 'Chair owner' }]} />
      {type === 'employee' ? (
        <>
          <p className="text-[13px] text-muted">The shop controls schedule, services, pricing and availability, and pays a commission on services.</p>
          <Field label="Commission on services (%)"><Input inputMode="decimal" value={pctVal} onChange={(e) => setPercent(e.target.value)} /></Field>
        </>
      ) : (
        <>
          <p className="text-[13px] text-muted">An independent business in your shop: they keep 100% of services and tips and control their own schedule, prices, customers, inventory and expenses. You track chair rent.</p>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Field label="Chair rent"><Input inputMode="decimal" value={rentVal} onChange={(e) => setRent(e.target.value)} placeholder={money(500000, { cents: false })} /></Field>
            <Field label="Every">
              <Select value={rule?.rent_period && !rent ? rule.rent_period : period} onChange={(e) => setPeriod(e.target.value as 'week' | 'month')}>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </Select>
            </Field>
          </div>
        </>
      )}
      <Button variant="secondary" block loading={busy} disabled={type === 'chair_owner' && parseMoney(rentVal) === null} onClick={save}>Save terms</Button>
    </Card>
  )
}
