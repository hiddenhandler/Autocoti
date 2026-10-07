import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AtSign, Clock, Globe, MapPin, Phone, QrCode, Share2, Star, Timer, Users } from 'lucide-react'
import { usePublicShop, ShopNotFound, PublicFooter, track } from './shared'
import { Avatar, Badge, Button, Card, cx, Sheet, Skeleton } from '@/components/ui'
import { LIVE, LivePill, liveLines, nextAvailableLabel } from '@/components/live'
import { QrImage } from '@/components/QrImage'
import { money, minutes } from '@/lib/format'
import { WEEKDAY_NAMES } from '@/lib/time'
import { rpc, APP_URL } from '@/lib/supabase'
import type { PublicShop, ShopLive } from '@/lib/types'

/** Live view of the shop: polled so a barber starting/finishing a cut shows up within seconds. */
export function useShopLive(slug: string | undefined) {
  return useQuery({
    queryKey: ['shop_live', slug],
    enabled: !!slug,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    queryFn: () => rpc<ShopLive | null>('get_shop_live', { p_slug: slug }),
  })
}

export default function ShopPage() {
  const { slug } = useParams()
  const { data: shop, isLoading } = usePublicShop(slug)
  const { data: live } = useShopLive(slug)
  const [qrOpen, setQrOpen] = useState(false)
  useEffect(() => {
    if (shop) {
      document.title = `${shop.name} — Book your cut`
      track(shop.id, 'view')
    }
  }, [shop])

  if (isLoading) return <ShopSkeleton />
  if (!shop) return <ShopNotFound />

  const city = shop.address.city ?? shop.address.region
  const addr = [shop.address.line1, shop.address.city, shop.address.region].filter(Boolean).join(', ')
  const shopUrl = `${APP_URL}/shop/${shop.slug}`
  const queueOn = !!live?.walk_ins.enabled
  const openNow = live?.open_now ?? isOpenNow(shop)

  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: shop.name, text: `Book your cut at ${shop.name}`, url: shopUrl })
      else {
        await navigator.clipboard.writeText(shopUrl)
        alert('Link copied')
      }
    } catch {
      /* dismissed */
    }
  }

  return (
    <div className="min-h-dvh">
      {shop.is_preview && (
        <div className="bg-warning/15 px-4 py-2 text-center text-xs font-semibold text-warning">Preview — this page isn't published yet. Only your team can see it.</div>
      )}

      {/* Shop header */}
      <section className="relative overflow-hidden border-b border-line">
        {shop.cover_url ? (
          <img src={shop.cover_url} alt="" className="absolute inset-0 size-full object-cover opacity-30" />
        ) : (
          <div className="absolute inset-0" style={{ background: 'radial-gradient(900px 360px at 15% -10%, color-mix(in oklab, var(--accent) 24%, transparent), transparent)' }} />
        )}
        <div className="pole absolute inset-x-0 bottom-0 h-1 opacity-50" />
        <div className="relative mx-auto max-w-3xl px-5 pb-8 pt-6 sm:pb-12">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold tracking-[0.2em] text-muted">BARBER<span className="text-accent">NGO</span></span>
            <div className="flex gap-1">
              <button onClick={() => setQrOpen(true)} aria-label="Show QR code" className="rounded-full bg-surface/70 p-2 text-muted backdrop-blur hover:text-ink"><QrCode className="size-4" /></button>
              <button onClick={share} aria-label="Share" className="rounded-full bg-surface/70 p-2 text-muted backdrop-blur hover:text-ink"><Share2 className="size-4" /></button>
            </div>
          </div>
          <div className="mt-6 flex items-center gap-4">
            {shop.logo_url ? <img src={shop.logo_url} alt="" className="size-16 rounded-2xl object-cover" /> : <Avatar name={shop.name} size={64} color={shop.accent_color} className="rounded-2xl" />}
            <div className="min-w-0">
              <h1 className="text-[28px] font-extrabold uppercase leading-[1.05] tracking-tight sm:text-[40px]">{shop.name}</h1>
              {shop.tagline && <p className="mt-1 text-[15px] text-muted">{shop.tagline}</p>}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[15px] font-medium">
            {shop.rating?.count ? (
              <span className="inline-flex items-center gap-1"><Star className="size-4 fill-accent text-accent" />{Number(shop.rating.average).toFixed(1)} <span className="text-sm font-normal text-muted">({shop.rating.count})</span></span>
            ) : null}
            {city && <span className="inline-flex items-center gap-1 text-muted"><MapPin className="size-4" />{city}</span>}
            <span className={cx('inline-flex items-center gap-1.5', openNow ? 'text-success' : 'text-danger')}>
              <span className={cx('size-2 rounded-full', openNow ? 'bg-success pulse-ring' : 'bg-danger')} />
              {openNow ? 'OPEN NOW' : 'CLOSED NOW'}
            </span>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-3xl space-y-12 px-5 pb-36 pt-8">
        {/* Choose your barber — live */}
        <section>
          <div className="mb-4 flex items-end justify-between">
            <h2 className="text-[13px] font-bold tracking-[0.16em] text-muted">CHOOSE YOUR BARBER</h2>
            <span className="text-[11px] text-faint">Live · updates automatically</span>
          </div>
          <div className="space-y-3">
            {shop.barbers.length === 0 && <Card className="p-6 text-center text-sm text-muted">No barbers are taking bookings right now.</Card>}
            {shop.barbers.map((b) => (
              <BarberLiveCard key={b.id} shop={shop} barber={b} live={live?.barbers.find((x) => x.barber_id === b.id)} queueOn={queueOn} />
            ))}
          </div>
        </section>

        {/* Walk-in queue */}
        {queueOn && live && (
          <section>
            <Card className="overflow-hidden">
              <div className="flex items-start gap-4 p-5">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-info/12 text-info"><Users className="size-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-bold tracking-[0.16em] text-muted">WALK-IN</div>
                  {live.walk_ins.estimated_wait_minutes === null ? (
                    <div className="mt-1 text-lg font-semibold">No barbers on the floor right now</div>
                  ) : (
                    <>
                      <div className="mt-1 text-sm text-muted">Current estimated wait</div>
                      <div className="text-3xl font-bold tnum">{live.walk_ins.estimated_wait_minutes === 0 ? 'No wait' : `${live.walk_ins.estimated_wait_minutes} min`}</div>
                    </>
                  )}
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <div><div className="text-muted">People ahead</div><div className="text-lg font-semibold tnum">{live.walk_ins.waiting}</div></div>
                    <div><div className="text-muted">Average service</div><div className="text-lg font-semibold tnum">{live.walk_ins.avg_service_minutes} min</div></div>
                  </div>
                </div>
              </div>
              {live.walk_ins.estimated_wait_minutes !== null && (
                <Link to={`/shop/${shop.slug}/queue`} className="block border-t border-line p-3">
                  <Button size="lg" block variant="secondary" icon={<Timer className="size-4" />}>JOIN QUEUE</Button>
                </Link>
              )}
            </Card>
          </section>
        )}

        {/* Services & prices */}
        <section>
          <h2 className="mb-4 text-[13px] font-bold tracking-[0.16em] text-muted">SERVICES</h2>
          <Card className="divide-y divide-line">
            {shop.services.map((s) => (
              <Link key={s.id} to={`/shop/${shop.slug}/book?service=${s.id}`} className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-surface-2">
                <div className="min-w-0">
                  <div className="font-semibold">{s.name}</div>
                  <div className="mt-0.5 text-sm text-muted">{minutes(s.duration_minutes)}{s.description ? ` · ${s.description}` : ''}</div>
                </div>
                <div className="shrink-0 text-right font-semibold tnum">
                  {s.min_price_cents !== null && s.max_price_cents !== null && s.min_price_cents !== s.max_price_cents
                    ? `${money(s.min_price_cents, { cents: false })}–${money(s.max_price_cents, { cents: false })}`
                    : money(s.min_price_cents ?? s.price_cents, { cents: false })}
                </div>
              </Link>
            ))}
          </Card>
        </section>

        {shop.reviews.length > 0 && (
          <section>
            <h2 className="mb-4 text-[13px] font-bold tracking-[0.16em] text-muted">
              REVIEWS {shop.rating.count ? <span className="ml-2 font-semibold normal-case tracking-normal text-ink">★ {Number(shop.rating.average).toFixed(1)} · {shop.rating.count}</span> : null}
            </h2>
            <div className="no-scrollbar -mx-5 flex snap-x gap-3 overflow-x-auto px-5 pb-1">
              {shop.reviews.slice(0, 8).map((r, i) => (
                <Card key={i} className="w-[280px] shrink-0 snap-start p-5">
                  <div className="flex text-accent">{Array.from({ length: 5 }, (_, j) => <Star key={j} className={cx('size-4', j < r.rating ? 'fill-current' : 'opacity-25')} />)}</div>
                  <p className="mt-3 line-clamp-4 text-[15px] leading-relaxed">“{r.comment}”</p>
                  <p className="mt-3 text-xs text-muted">{r.client_name}{r.barber_name ? ` · cut by ${r.barber_name}` : ''}</p>
                  {r.owner_reply && <p className="mt-3 border-l-2 border-accent pl-3 text-sm text-muted">{r.owner_reply}</p>}
                </Card>
              ))}
            </div>
          </section>
        )}

        <section className="grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="mb-4 text-[13px] font-bold tracking-[0.16em] text-muted">HOURS</h2>
            <Card className="divide-y divide-line">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const h = shop.hours.filter((x) => x.weekday === d)
                const today = new Date().toLocaleDateString('en-US', { timeZone: shop.timezone, weekday: 'long' }) === WEEKDAY_NAMES[d]
                return (
                  <div key={d} className={cx('flex justify-between px-5 py-3 text-sm', today && 'font-semibold')}>
                    <span>{WEEKDAY_NAMES[d]}</span>
                    <span className={cx('tnum', !h.length && 'text-muted')}>{h.length ? h.map((x) => `${fmt12(x.opens_at)} – ${fmt12(x.closes_at)}`).join(', ') : 'Closed'}</span>
                  </div>
                )
              })}
            </Card>
          </div>
          <div>
            <h2 className="mb-4 text-[13px] font-bold tracking-[0.16em] text-muted">LOCATION</h2>
            <Card className="overflow-hidden">
              {addr && (
                <iframe title="Map" loading="lazy" className="h-48 w-full border-0 grayscale-[30%]"
                  src={`https://www.google.com/maps?q=${encodeURIComponent(shop.latitude && shop.longitude ? `${shop.latitude},${shop.longitude}` : `${shop.name} ${addr}`)}&output=embed`} />
              )}
              <div className="space-y-2.5 p-5 text-sm">
                {addr && <a className="flex items-center gap-2 hover:text-accent" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${shop.name} ${addr}`)}`}><MapPin className="size-4 text-muted" />{addr}</a>}
                {shop.phone && <a href={`tel:${shop.phone}`} className="flex items-center gap-2 hover:text-accent"><Phone className="size-4 text-muted" />{shop.phone}</a>}
                {shop.instagram && <a href={`https://instagram.com/${shop.instagram.replace('@', '')}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-accent"><AtSign className="size-4 text-muted" />{shop.instagram}</a>}
                {shop.website && <a href={shop.website} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-accent"><Globe className="size-4 text-muted" />{shop.website.replace(/^https?:\/\//, '')}</a>}
                <button onClick={() => setQrOpen(true)} className="flex items-center gap-2 hover:text-accent"><QrCode className="size-4 text-muted" />Shop QR code</button>
              </div>
            </Card>
          </div>
        </section>
        {shop.description && <p className="max-w-2xl text-muted">{shop.description}</p>}
        <PublicFooter />
      </div>

      {/* Sticky CTA */}
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/92 p-3 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl gap-2">
          <Link to={`/shop/${shop.slug}/book`} className="flex-1"><Button size="xl" block>BOOK YOUR CUT</Button></Link>
          {queueOn && live?.walk_ins.estimated_wait_minutes !== null && (
            <Link to={`/shop/${shop.slug}/queue`}><Button size="xl" variant="secondary" aria-label="Join walk-in queue"><Users className="size-5" /></Button></Link>
          )}
        </div>
      </div>

      <Sheet open={qrOpen} onClose={() => setQrOpen(false)} title="Book your cut">
        <div className="flex flex-col items-center gap-4 pb-4 text-center">
          <QrImage value={shopUrl} size={240} />
          <div className="text-sm text-muted">Scan to open {shop.name}. No app needed.</div>
          <code className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs">{shopUrl.replace(/^https?:\/\//, '')}</code>
        </div>
      </Sheet>
    </div>
  )
}

function BarberLiveCard({ shop, barber, live, queueOn }: {
  shop: PublicShop; barber: PublicShop['barbers'][number]; live: ShopLive['barbers'][number] | undefined; queueOn: boolean
}) {
  const status = live?.status
  const muted = status === 'NOT_WORKING' || status === 'OFFLINE'
  const lines = live ? liveLines(live, shop.timezone) : []
  const next = live ? nextAvailableLabel(live, shop.timezone) : null
  const canQueue = queueOn && live && ['AVAILABLE', 'QUEUE', 'CUTTING', 'BOOKED', 'BREAK'].includes(live.status)
  const queueFirst = live?.status === 'QUEUE'
  return (
    <Card className={cx('p-4 transition', live && LIVE[live.status].ring, muted && 'opacity-70')}>
      <div className="flex items-start gap-4">
        <Link to={`/shop/${shop.slug}/barber/${barber.slug}`} className="shrink-0">
          <Avatar name={barber.name} src={barber.photo_url} size={56} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link to={`/shop/${shop.slug}/barber/${barber.slug}`} className="min-w-0">
              <div className="truncate text-lg font-bold leading-tight">{barber.name}</div>
              {barber.title && <div className="truncate text-[13px] text-muted">{barber.title}</div>}
            </Link>
            {barber.review_count > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold"><Star className="size-3.5 fill-accent text-accent" />{Number(barber.rating).toFixed(1)}</span>
            )}
          </div>
          <div className="mt-2">{live ? <LivePill status={live.status} /> : <Skeleton className="h-4 w-24" />}</div>
          <div className="mt-1.5 space-y-0.5 text-[13px] text-muted">
            {lines.map((l) => <div key={l}>{l}</div>)}
            {next && <div>Next available: <b className="text-ink">{next}</b></div>}
            {live?.avg_cut_minutes ? <div className="inline-flex items-center gap-1"><Clock className="size-3" />Average cut: {live.avg_cut_minutes} min</div> : null}
          </div>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        {queueFirst && canQueue ? (
          <>
            <Link to={`/shop/${shop.slug}/queue?barber=${barber.id}`} className="flex-1"><Button block>JOIN QUEUE</Button></Link>
            <Link to={`/shop/${shop.slug}/book?barber=${barber.id}`}><Button variant="outline">BOOK</Button></Link>
          </>
        ) : (
          <>
            <Link to={`/shop/${shop.slug}/book?barber=${barber.id}`} className="flex-1"><Button block variant={muted ? 'outline' : 'primary'}>BOOK {barber.name.split(' ')[0].toUpperCase()}</Button></Link>
            {canQueue && live?.status === 'AVAILABLE' && (
              <Link to={`/shop/${shop.slug}/queue?barber=${barber.id}`}><Button variant="outline">WALK IN</Button></Link>
            )}
          </>
        )}
      </div>
      {barber.services.length > 0 && (
        <div className="no-scrollbar -mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4">
          {barber.services.slice(0, 5).map((s) => {
            const svc = shop.services.find((x) => x.id === s.service_id)
            return svc ? <Badge key={s.service_id} className="normal-case tracking-normal">{svc.name} · {money(s.price_cents, { cents: false })}</Badge> : null
          })}
        </div>
      )}
    </Card>
  )
}

function isOpenNow(shop: PublicShop) {
  const now = new Date()
  const wd = WEEKDAY_NAMES.indexOf(now.toLocaleDateString('en-US', { timeZone: shop.timezone, weekday: 'long' }))
  const hm = now.toLocaleTimeString('en-GB', { timeZone: shop.timezone, hour: '2-digit', minute: '2-digit' })
  return shop.hours.some((h) => h.weekday === wd && h.opens_at.slice(0, 5) <= hm && hm < h.closes_at.slice(0, 5))
}

export function fmt12(t: string) {
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`
}

function ShopSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <Skeleton className="size-16" />
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
    </div>
  )
}
