import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ClipboardList, Eye, EyeOff, Plus } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useBarberServices, useBarbers, useServices } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import { money, minutes, parseMoney } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import type { Service } from '@/lib/types'
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Sheet, Skeleton, Textarea, Toggle, useToast } from '@/components/ui'

export default function Services() {
  const { ws } = useWorkspace()
  const { data: services, isLoading } = useServices(ws.shop_id)
  const { data: bs } = useBarberServices(ws.shop_id)
  const { data: barbers } = useBarbers(ws.shop_id)
  const [edit, setEdit] = useState<Partial<Service> | null>(null)
  return (
    <div>
      <PageHeader title="Services" subtitle="Prices and lengths here are the defaults; each barber can override them." actions={<Button icon={<Plus className="size-4" />} onClick={() => setEdit({})}>New service</Button>} />
      {isLoading ? <Skeleton className="h-64" /> : !services?.length ? (
        <Card><EmptyState icon={<ClipboardList className="size-6" />} title="No services yet" action={<Button onClick={() => setEdit({})}>Create a service</Button>} /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {services.map((s) => {
            const n = bs?.filter((x) => x.service_id === s.id && x.is_active).length ?? 0
            return (
              <button key={s.id} onClick={() => setEdit(s)} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-surface-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-semibold">
                    {s.name}
                    {!s.is_active && <Badge>Inactive</Badge>}
                    {s.is_active && !s.is_public && <Badge tone="warning"><EyeOff className="size-3" /> In-shop only</Badge>}
                  </div>
                  <div className="text-sm text-muted">{minutes(s.duration_minutes)}{s.category ? ` · ${s.category}` : ''} · {n} of {barbers?.length ?? 0} barbers</div>
                </div>
                <div className="text-lg font-semibold tnum">{money(s.price_cents)}</div>
              </button>
            )
          })}
        </Card>
      )}
      {edit && <ServiceSheet service={edit} onClose={() => setEdit(null)} />}
    </div>
  )
}

function ServiceSheet({ service, onClose }: { service: Partial<Service>; onClose: () => void }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: barbers } = useBarbers(ws.shop_id)
  const isNew = !service.id
  const [f, setF] = useState({
    name: service.name ?? '', description: service.description ?? '', category: service.category ?? '',
    price: service.price_cents !== undefined ? (service.price_cents / 100).toString() : '', duration: service.duration_minutes ?? 30,
    is_active: service.is_active ?? true, is_public: service.is_public ?? true,
  })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const row = { name: f.name.trim(), description: f.description || null, category: f.category || null, price_cents: parseMoney(f.price) ?? 0, duration_minutes: f.duration, is_active: f.is_active, is_public: f.is_public }
      if (isNew) {
        const { data, error } = await supabase.from('services').insert({ shop_id: ws.shop_id, ...row }).select().single()
        if (error) throw error
        // Assign to every active barber by default.
        for (const b of barbers ?? []) {
          await supabase.from('barber_services').upsert({ barber_id: b.id, service_id: data.id, is_active: true })
        }
      } else {
        const { error } = await supabase.from('services').update(row).eq('id', service.id!)
        if (error) throw error
      }
      qc.invalidateQueries({ queryKey: ['services', ws.shop_id] })
      qc.invalidateQueries({ queryKey: ['barber_services', ws.shop_id] })
      toast(isNew ? 'Service created' : 'Service updated — new bookings use it; past ones keep their price', 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!confirm('Delete this service? Past appointments keep their history.')) return
    const { error } = await supabase.from('services').update({ deleted_at: new Date().toISOString(), is_active: false }).eq('id', service.id!)
    if (error) return toast(friendlyError(error), 'error')
    qc.invalidateQueries({ queryKey: ['services', ws.shop_id] })
    onClose()
  }
  return (
    <Sheet open onClose={onClose} title={isNew ? 'New service' : 'Edit service'} footer={
      <div className="flex gap-2">
        <Button size="lg" className="flex-1" loading={busy} disabled={!f.name.trim() || parseMoney(f.price) === null} onClick={save}>Save</Button>
        {!isNew && <Button size="lg" variant="danger" onClick={remove}>Delete</Button>}
      </div>
    }>
      <div className="space-y-4">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus placeholder="Haircut + Beard" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price"><Input leading="$" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
          <Field label="Duration">
            <Select value={f.duration} onChange={(e) => setF({ ...f, duration: Number(e.target.value) })}>
              {[10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 75, 90, 105, 120, 150, 180].map((m) => <option key={m} value={m}>{minutes(m)}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Category (optional)"><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Cuts, Beard, Kids…" /></Field>
        <Field label="Description (optional)"><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Toggle checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} label="Active" />
        <Toggle checked={f.is_public} onChange={(v) => setF({ ...f, is_public: v })} label={<span className="inline-flex items-center gap-1.5"><Eye className="size-4" /> Bookable online</span>} description="Turn off for services you only offer in the shop." />
      </div>
    </Sheet>
  )
}
