import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, Users } from 'lucide-react'
import { usePublicShop, ShopNotFound, loadSavedClient, saveClient } from './shared'
import { useShopLive } from './ShopPage'
import { Avatar, Button, Card, cx, Field, Input, Spinner } from '@/components/ui'
import { LivePill } from '@/components/live'
import { rpc } from '@/lib/supabase'
import { friendlyError } from '@/lib/errors'
import { money, minutes } from '@/lib/format'

/** Join the shop's walk-in queue from a QR code / link. No account, no app. */
export default function JoinQueue() {
  const { slug } = useParams()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const { data: shop, isLoading } = usePublicShop(slug)
  const { data: live } = useShopLive(slug)
  const saved = loadSavedClient()
  const [name, setName] = useState(saved ? [saved.first_name, saved.last_name].filter(Boolean).join(' ') : '')
  const [phone, setPhone] = useState(saved?.phone ?? '')
  const [barberId, setBarberId] = useState<string | null>(params.get('barber'))
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (shop) document.title = `Join the queue — ${shop.name}`
  }, [shop])

  if (isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (!shop) return <ShopNotFound />

  const barber = shop.barbers.find((b) => b.id === barberId)
  const services = barber ? shop.services.filter((s) => barber.services.some((x) => x.service_id === s.id)) : shop.services
  const service = services.find((s) => s.id === serviceId) ?? services[0]
  const queueOpen = live?.walk_ins.enabled && live.walk_ins.estimated_wait_minutes !== null
  const barberLive = live?.barbers.find((b) => b.barber_id === barberId)
  const wait = barberLive ? barberLive.estimated_wait_minutes : live?.walk_ins.estimated_wait_minutes

  const join = async () => {
    setBusy(true)
    setError(null)
    try {
      const [first, ...rest] = name.trim().split(/\s+/)
      saveClient({ first_name: first ?? '', last_name: rest.join(' '), phone, email: saved?.email ?? '' })
      const r = await rpc<{ token: string }>('join_walk_in_queue', {
        p_shop_id: shop.id, p_name: name, p_phone: phone, p_service_id: service?.id, p_barber_id: barberId,
      })
      nav(`/q/${r.token}`, { replace: true })
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto min-h-dvh max-w-md px-5 pb-32 pt-6">
      <Link to={`/shop/${shop.slug}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" />{shop.name}</Link>
      <div className="mt-6 text-[13px] font-bold tracking-[0.16em] text-muted">WALK-IN</div>
      <h1 className="mt-1 text-3xl font-extrabold">Join the queue</h1>

      <Card className="mt-5 flex items-center gap-4 p-5">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-info/12 text-info"><Users className="size-6" /></span>
        <div>
          <div className="text-sm text-muted">{barber ? `Estimated wait for ${barber.name.split(' ')[0]}` : 'Current estimated wait'}</div>
          <div className="text-3xl font-bold tnum">{wait === undefined ? '…' : wait === null ? '—' : wait === 0 ? 'No wait' : `${wait} min`}</div>
          {live && <div className="text-sm text-muted">{live.walk_ins.waiting} {live.walk_ins.waiting === 1 ? 'person' : 'people'} ahead</div>}
        </div>
      </Card>

      {live && !queueOpen ? (
        <Card className="mt-5 p-5 text-center text-muted">The walk-in queue is closed right now. <Link className="font-semibold text-ink underline" to={`/shop/${shop.slug}/book`}>Book a time instead</Link>.</Card>
      ) : (
        <div className="mt-6 space-y-5">
          <div>
            <div className="mb-2 text-sm font-semibold">Barber</div>
            <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5">
              <BarberChip active={!barberId} onClick={() => setBarberId(null)} name="Anyone" sub="Fastest" />
              {shop.barbers.map((b) => {
                const l = live?.barbers.find((x) => x.barber_id === b.id)
                if (l && (l.status === 'NOT_WORKING' || l.status === 'OFFLINE')) return null
                return <BarberChip key={b.id} active={barberId === b.id} onClick={() => setBarberId(b.id)} name={b.name.split(' ')[0]} photo={b.photo_url}
                  sub={l ? <LivePill status={l.status} size="sm" /> : null} />
              })}
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold">Service</div>
            <div className="grid gap-2">
              {services.map((s) => {
                const price = barber?.services.find((x) => x.service_id === s.id)?.price_cents ?? s.min_price_cents ?? s.price_cents
                return (
                  <button key={s.id} onClick={() => setServiceId(s.id)}
                    className={cx('flex items-center justify-between rounded-xl border px-4 py-3 text-left transition', service?.id === s.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}>
                    <span><span className="font-semibold">{s.name}</span><span className="ml-2 text-sm text-muted">{minutes(s.duration_minutes)}</span></span>
                    <span className="font-semibold tnum">{money(price, { cents: false })}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <Field label="Your name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Juan Perez" /></Field>
          <Field label="Phone" hint="We'll text / WhatsApp you when you're almost up."><Input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" autoComplete="tel" inputMode="tel" placeholder="809 555 0101" /></Field>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}

      {queueOpen && (
        <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-line bg-surface/92 p-3 backdrop-blur-md">
          <div className="mx-auto max-w-md">
            <Button size="xl" block loading={busy} disabled={!name.trim() || phone.replace(/\D/g, '').length < 7 || !service} onClick={join}>JOIN QUEUE</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function BarberChip({ active, onClick, name, sub, photo }: { active: boolean; onClick: () => void; name: string; sub?: React.ReactNode; photo?: string | null }) {
  return (
    <button onClick={onClick} className={cx('flex w-24 shrink-0 flex-col items-center gap-1.5 rounded-2xl border px-2 py-3 transition', active ? 'border-accent bg-accent-soft' : 'border-line')}>
      <Avatar name={name} src={photo} size={40} />
      <span className="text-sm font-semibold">{name}</span>
      {sub && <span className="text-[11px] text-muted">{sub}</span>}
    </button>
  )
}
