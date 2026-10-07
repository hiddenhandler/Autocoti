import { useState } from 'react'
import { Navigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Plus, Sparkles } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useBarberServices, useServices, useServiceTimes } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { minutes, money, parseMoney } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import type { Service } from '@/lib/types'
import { Badge, Button, Card, Field, Input, PageHeader, Sheet, Skeleton, Toggle, useToast } from '@/components/ui'

/** A barber's menu: which services they do, at what price and duration. */
export default function MyServices() {
  const { ws } = useWorkspace()
  if (!ws.barber_id) return <Navigate to="/app" replace />
  return <Menu barberId={ws.barber_id} />
}

function Menu({ barberId }: { barberId: string }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: services, isLoading } = useServices(ws.shop_id)
  const { data: links } = useBarberServices(ws.shop_id)
  const { data: times } = useServiceTimes(ws.shop_id, barberId)
  const { data: settings } = useQuery({
    queryKey: ['shop_settings', ws.shop_id],
    queryFn: async () => (await supabase.from('shop_settings').select('*').eq('shop_id', ws.shop_id).maybeSingle()).data,
  })
  const chairOwner = ws.barber_type === 'chair_owner'
  const canPrice = chairOwner || !!settings?.barbers_can_set_prices
  const [edit, setEdit] = useState<Service | 'new' | null>(null)
  const mine = (links ?? []).filter((l) => l.barber_id === barberId)
  const visible = (services ?? []).filter((s) => s.is_active && (!s.owner_barber_id || s.owner_barber_id === barberId))
  const on = new Set(mine.filter((l) => l.is_active).map((l) => l.service_id))

  const toggle = async (id: string, v: boolean) => {
    const next = [...on].filter((x) => x !== id).concat(v ? [id] : [])
    try {
      await rpc('set_barber_services', { p_barber_id: barberId, p_service_ids: `{${next.join(',')}}` })
      qc.invalidateQueries({ queryKey: ['barber_services', ws.shop_id] })
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="My services" subtitle={chairOwner ? 'You set your own menu and prices.' : canPrice ? 'Your shop lets you set your own prices.' : 'Prices are set by your shop.'}
        actions={chairOwner && <Button icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>Service</Button>} />
      {isLoading ? <Skeleton className="h-64" /> : (
        <Card className="divide-y divide-line">
          {visible.map((s) => {
            const link = mine.find((l) => l.service_id === s.id)
            const t = times?.find((x) => x.service_id === s.id)
            const price = link?.price_cents ?? s.price_cents
            const dur = link?.duration_minutes ?? s.duration_minutes
            return (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3.5">
                <button className="min-w-0 flex-1 text-left" disabled={!canPrice} onClick={() => setEdit(s)}>
                  <div className="flex items-center gap-2 font-semibold">{s.name}{s.owner_barber_id && <Badge tone="accent">Mine</Badge>}</div>
                  <div className="text-sm text-muted">
                    {money(price)} · {minutes(dur)}
                    {t?.learned_minutes && !link?.duration_minutes && <span className="ml-1.5 inline-flex items-center gap-1 text-accent"><Sparkles className="size-3" />books as {t.learned_minutes} min (your average)</span>}
                  </div>
                </button>
                {!canPrice && <Lock className="size-4 text-faint" />}
                <Toggle checked={on.has(s.id)} onChange={(v) => toggle(s.id, v)} />
              </div>
            )
          })}
        </Card>
      )}
      <p className="mt-3 text-xs text-muted">Turn a service off to stop clients booking it with you. {canPrice ? 'Tap a service to change your price or time.' : ''}</p>
      {edit && <PriceSheet barberId={barberId} service={edit === 'new' ? null : edit} link={edit === 'new' ? undefined : mine.find((l) => l.service_id === edit.id)} onClose={() => setEdit(null)} />}
    </div>
  )
}

function PriceSheet({ barberId, service, link, onClose }: { barberId: string; service: Service | null; link?: { price_cents: number | null; duration_minutes: number | null }; onClose: () => void }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const own = !service || service.owner_barber_id === barberId
  const [name, setName] = useState(service?.name ?? '')
  const [price, setPrice] = useState(String(((link?.price_cents ?? service?.price_cents) ?? 0) / 100 || ''))
  const [dur, setDur] = useState(String(link?.duration_minutes ?? service?.duration_minutes ?? 30))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      if (own) {
        await rpc('save_my_service', { p_barber_id: barberId, p_service_id: service?.id ?? null, p_name: name, p_price_cents: parseMoney(price), p_duration_minutes: Number(dur) })
      } else {
        await rpc('set_my_service_price', { p_barber_id: barberId, p_service_id: service!.id, p_price_cents: parseMoney(price), p_duration_minutes: Number(dur) || null })
      }
      qc.invalidateQueries({ queryKey: ['services', ws.shop_id] })
      qc.invalidateQueries({ queryKey: ['barber_services', ws.shop_id] })
      toast('Saved', 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet open onClose={onClose} title={service ? service.name : 'New service'} footer={<Button block loading={busy} disabled={!parseMoney(price) || (own && !name.trim())} onClick={save}>Save</Button>}>
      <div className="space-y-3">
        {own && <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Signature fade" /></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Your price"><Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label="Minutes"><Input inputMode="numeric" value={dur} onChange={(e) => setDur(e.target.value)} /></Field>
        </div>
        {!own && service && <p className="text-xs text-muted">Shop default: {money(service.price_cents)} · {service.duration_minutes} min</p>}
      </div>
    </Sheet>
  )
}
