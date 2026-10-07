import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DoorOpen, Plus, UserX } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useBarbers, useServices } from '@/lib/api'
import { rpc } from '@/lib/supabase'
import { ago, time } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import { Avatar, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Sheet, Skeleton, Textarea, useToast } from '@/components/ui'

interface QueueRow {
  id: string
  name: string
  phone: string | null
  service_id: string | null
  service_name: string | null
  preferred_barber_id: string | null
  status: string
  created_at: string
  queue_position: number
  estimated_start: string | null
  estimated_wait_minutes: number | null
  likely_barber_id: string | null
  notes: string | null
}

export default function WalkIns() {
  const { ws, hasFeature } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(params.get('add') === '1')
  const { data: barbers } = useBarbers(ws.shop_id)
  const { data: queue, isLoading } = useQuery({
    queryKey: ['walk_ins', ws.shop_id, 'queue'],
    enabled: hasFeature('walk_ins'),
    refetchInterval: 20_000,
    queryFn: () => rpc<QueueRow[]>('walk_in_queue', { p_shop_id: ws.shop_id }),
  })
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['walk_ins', ws.shop_id] })
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key)
    try {
      await fn()
      refresh()
      qc.invalidateQueries({ queryKey: ['appointments', ws.shop_id] })
      if (ok) toast(ok, 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  if (!hasFeature('walk_ins')) return <Card><EmptyState icon={<DoorOpen className="size-6" />} title="Walk-in queue is on the Shop plan" body="Upgrade to manage a live walk-in queue with wait estimates." /></Card>
  const bname = (id: string | null) => barbers?.find((b) => b.id === id)?.display_name

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Walk-ins" subtitle="Live queue · wait times come from each barber's real calendar" actions={<Button size="lg" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add walk-in</Button>} />
      {isLoading ? <Skeleton className="h-64" /> : !queue?.length ? (
        <Card><EmptyState icon={<DoorOpen className="size-6" />} title="Nobody waiting" body="Add walk-ins as they arrive — the queue estimates wait times automatically." /></Card>
      ) : (
        <div className="space-y-3">
          {queue.map((w) => (
            <Card key={w.id} className="flex flex-wrap items-center gap-4 p-4">
              <div className="flex size-10 items-center justify-center rounded-full bg-surface-2 text-lg font-semibold tnum">{w.queue_position}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-semibold">{w.name} {w.status === 'called' && <Badge tone="warning">Called</Badge>}</div>
                <div className="text-sm text-muted">{w.service_name ?? 'No service'} · {w.preferred_barber_id ? `wants ${bname(w.preferred_barber_id)}` : 'any barber'} · arrived {ago(w.created_at)}</div>
              </div>
              <div className="text-right">
                <div className="text-xl font-semibold tnum">{w.estimated_wait_minutes === null ? '—' : w.estimated_wait_minutes === 0 ? 'Now' : `~${w.estimated_wait_minutes} min`}</div>
                <div className="text-xs text-muted">{w.likely_barber_id ? `${bname(w.likely_barber_id)} · ${time(w.estimated_start!, ws.timezone)}` : 'no opening today'}</div>
              </div>
              <div className="flex w-full gap-2 sm:w-auto">
                <Select className="h-10 flex-1 sm:w-36" defaultValue={w.likely_barber_id ?? w.preferred_barber_id ?? ''} id={`b-${w.id}`}>
                  {barbers?.filter((b) => !w.preferred_barber_id || b.id === w.preferred_barber_id).map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}
                </Select>
                <Button loading={busy === w.id} onClick={() => {
                  const sel = (document.getElementById(`b-${w.id}`) as HTMLSelectElement).value
                  act(w.id, () => rpc('call_next_walk_in', { p_barber_id: sel, p_walk_in_id: w.id }), `${w.name} is in the chair`)
                }}>Seat</Button>
                <Button variant="ghost" aria-label="Left" onClick={() => act(`l${w.id}`, () => rpc('update_walk_in', { p_walk_in_id: w.id, p_status: 'left' }), 'Marked as left')}><UserX className="size-4" /></Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {barbers && (
        <div className="mt-8">
          <div className="eyebrow mb-3">Next client</div>
          <div className="flex flex-wrap gap-2">
            {barbers.filter((b) => b.status === 'active').map((b) => (
              <Button key={b.id} variant="secondary" loading={busy === `n${b.id}`} icon={<Avatar name={b.display_name} src={b.photo_url} size={20} />}
                onClick={() => act(`n${b.id}`, () => rpc('call_next_walk_in', { p_barber_id: b.id }), `Next client seated with ${b.display_name}`)}>
                {b.display_name}
              </Button>
            ))}
          </div>
        </div>
      )}
      <AddWalkIn open={adding} onClose={() => { setAdding(false); params.delete('add'); setParams(params) }} onAdded={refresh} />
    </div>
  )
}

function AddWalkIn({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const { ws } = useWorkspace()
  const toast = useToast()
  const { data: services } = useServices(ws.shop_id)
  const { data: barbers } = useBarbers(ws.shop_id)
  const [f, setF] = useState({ name: '', phone: '', service: '', barber: '', notes: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!f.service && services?.length) setF((x) => ({ ...x, service: services[0].id }))
  }, [services, f.service])
  const submit = async () => {
    setBusy(true)
    try {
      const r = await rpc<{ estimated_wait_minutes: number | null }>('add_walk_in', { p_shop_id: ws.shop_id, p_name: f.name, p_phone: f.phone || null, p_service_id: f.service || null, p_preferred_barber_id: f.barber || null, p_notes: f.notes || null })
      toast(r.estimated_wait_minutes !== null ? `Added · estimated wait ${r.estimated_wait_minutes} min` : 'Added to the queue', 'success')
      onAdded()
      setF({ name: '', phone: '', service: services?.[0]?.id ?? '', barber: '', notes: '' })
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Add walk-in" footer={<Button size="lg" block loading={busy} disabled={!f.name.trim()} onClick={submit}>Add to queue</Button>}>
      <div className="space-y-4">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Phone (optional)" hint="We'll match returning clients"><Input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Service"><Select value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}>{services?.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Preferred barber"><Select value={f.barber} onChange={(e) => setF({ ...f, barber: e.target.value })}><option value="">Any barber</option>{barbers?.map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}</Select></Field>
        <Field label="Notes"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Sheet>
  )
}
