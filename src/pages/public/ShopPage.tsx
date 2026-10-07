import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Clock, AtSign, MapPin, Phone, Star } from 'lucide-react'
import { usePublicShop, useSlots, useFirstAvailable, ShopNotFound, PublicFooter, track } from './shared'
import { Avatar, Badge, Button, Card, Chip, cx, Skeleton } from '@/components/ui'
import { money, minutes, relativeDay, time } from '@/lib/format'
import { todayInTz, WEEKDAY_NAMES } from '@/lib/time'
import type { PublicShop } from '@/lib/types'

export default function ShopPage() {
  const { slug } = useParams()
  const { data: shop, isLoading } = usePublicShop(slug)
  useEffect(() => {
    if (shop) {
      document.title = `${shop.name} — Book online`
      track(shop.id, 'view')
    }
  }, [shop])

  if (isLoading) return <ShopSkeleton />
  if (!shop) return <ShopNotFound />

  const addr = [shop.address.line1, shop.address.city, shop.address.region].filter(Boolean).join(', ')

  return (
    <div className="min-h-dvh">
      {shop.is_preview && (
        <div className="bg-warning/15 px-4 py-2 text-center text-xs font-semibold text-warning">Preview — this page isn't published yet. Only your team can see it.</div>
      )}
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line">
        {shop.cover_url ? (
          <img src={shop.cover_url} alt="" className="absolute inset-0 size-full object-cover opacity-35" />
        ) : (
          <div className="absolute inset-0" style={{ background: 'radial-gradient(1200px 400px at 20% -10%, color-mix(in oklab, var(--accent) 22%, transparent), transparent)' }} />
        )}
        <div className="pole absolute inset-x-0 bottom-0 h-1 opacity-50" />
        <div className="relative mx-auto max-w-5xl px-5 pb-10 pt-8 sm:pb-14 sm:pt-12">
          <div className="flex items-center gap-3">
            {shop.logo_url ? <img src={shop.logo_url} alt="" className="size-14 rounded-2xl object-cover" /> : <Avatar name={shop.name} size={56} color={shop.accent_color} className="rounded-2xl" />}
            {shop.rating?.count ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-3 py-1 text-sm font-semibold backdrop-blur">
                <Star className="size-4 fill-accent text-accent" /> {Number(shop.rating.average).toFixed(1)} <span className="font-normal text-muted">({shop.rating.count})</span>
              </span>
            ) : null}
          </div>
          <h1 className="display mt-6 text-[52px] leading-[0.95] sm:text-[76px]">{shop.name}</h1>
          {shop.tagline && <p className="mt-3 max-w-xl text-lg text-muted">{shop.tagline}</p>}
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
            {addr && <span className="inline-flex items-center gap-1.5"><MapPin className="size-4" />{addr}</span>}
            <OpenNow shop={shop} />
            {shop.phone && <a href={`tel:${shop.phone}`} className="inline-flex items-center gap-1.5 hover:text-ink"><Phone className="size-4" />{shop.phone}</a>}
            {shop.instagram && (
              <a href={`https://instagram.com/${shop.instagram.replace('@', '')}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-ink">
                <AtSign className="size-4" />{shop.instagram}
              </a>
            )}
          </div>
          <div className="mt-8 hidden sm:block">
            <Link to={`/s/${shop.slug}/book`}><Button size="xl">BOOK YOUR CUT</Button></Link>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-5xl space-y-14 px-5 pb-32 pt-10">
        {shop.booking.enabled && shop.services.length > 0 && <AvailableNow shop={shop} />}

        <section>
          <SectionTitle>Services</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            {shop.services.map((s) => (
              <Link key={s.id} to={`/s/${shop.slug}/book?service=${s.id}`}>
                <Card className="group flex items-center justify-between gap-4 p-5 transition hover:border-accent">
                  <div className="min-w-0">
                    <div className="font-semibold">{s.name}</div>
                    <div className="mt-1 text-sm text-muted">{minutes(s.duration_minutes)}{s.description ? ` · ${s.description}` : ''}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold tnum">
                      {s.min_price_cents !== null && s.max_price_cents !== null && s.min_price_cents !== s.max_price_cents
                        ? `${money(s.min_price_cents)}–${money(s.max_price_cents)}`
                        : money(s.min_price_cents ?? s.price_cents)}
                    </div>
                    <div className="text-xs font-semibold text-accent opacity-0 transition group-hover:opacity-100">Book →</div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle>Barbers</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shop.barbers.map((b) => (
              <BarberCard key={b.id} shop={shop} barber={b} />
            ))}
          </div>
        </section>

        {shop.reviews.length > 0 && (
          <section>
            <SectionTitle>
              What clients say
              {shop.rating.count ? <span className="ml-3 align-middle text-base font-normal text-muted">★ {Number(shop.rating.average).toFixed(1)} · {shop.rating.count} reviews</span> : null}
            </SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              {shop.reviews.slice(0, 6).map((r, i) => (
                <Card key={i} className="p-5">
                  <div className="flex text-accent">{Array.from({ length: 5 }, (_, j) => <Star key={j} className={cx('size-4', j < r.rating ? 'fill-current' : 'opacity-25')} />)}</div>
                  <p className="mt-3 text-[15px] leading-relaxed">“{r.comment}”</p>
                  <p className="mt-3 text-xs text-muted">{r.client_name}{r.barber_name ? ` · cut by ${r.barber_name}` : ''}</p>
                  {r.owner_reply && <p className="mt-3 border-l-2 border-accent pl-3 text-sm text-muted">{r.owner_reply}</p>}
                </Card>
              ))}
            </div>
          </section>
        )}

        <section className="grid gap-6 md:grid-cols-2">
          <div>
            <SectionTitle>Hours</SectionTitle>
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
          {addr && (
            <div>
              <SectionTitle>Find us</SectionTitle>
              <Card className="overflow-hidden">
                <iframe
                  title="Map"
                  loading="lazy"
                  className="h-64 w-full border-0 grayscale-[30%]"
                  src={`https://www.google.com/maps?q=${encodeURIComponent(shop.latitude && shop.longitude ? `${shop.latitude},${shop.longitude}` : `${shop.name} ${addr}`)}&output=embed`}
                />
                <a className="block px-5 py-3 text-sm font-medium hover:bg-surface-2" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${shop.name} ${addr}`)}`}>
                  Get directions →
                </a>
              </Card>
            </div>
          )}
        </section>
        {shop.description && <p className="max-w-2xl text-muted">{shop.description}</p>}
        <PublicFooter />
      </div>

      {/* Sticky mobile CTA */}
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/92 p-3 backdrop-blur-md sm:hidden">
        <Link to={`/s/${shop.slug}/book`}><Button size="xl" block>BOOK YOUR CUT</Button></Link>
      </div>
    </div>
  )
}

function fmt12(t: string) {
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="display mb-5 text-[32px] leading-none">{children}</h2>
}

function OpenNow({ shop }: { shop: PublicShop }) {
  const now = new Date()
  const wd = WEEKDAY_NAMES.indexOf(now.toLocaleDateString('en-US', { timeZone: shop.timezone, weekday: 'long' }))
  const hm = now.toLocaleTimeString('en-GB', { timeZone: shop.timezone, hour: '2-digit', minute: '2-digit' })
  const open = shop.hours.some((h) => h.weekday === wd && h.opens_at.slice(0, 5) <= hm && hm < h.closes_at.slice(0, 5))
  return (
    <span className="inline-flex items-center gap-1.5">
      <Clock className="size-4" />
      <span className={open ? 'text-success' : ''}>{open ? 'Open now' : 'Closed now'}</span>
    </span>
  )
}

/** Real-time availability strip: today's open times per barber. */
function AvailableNow({ shop }: { shop: PublicShop }) {
  const [serviceId, setServiceId] = useState(shop.services[0]?.id)
  const today = todayInTz(shop.timezone)
  const { data: slots, isLoading } = useSlots(shop.id, serviceId ? [serviceId] : [], today, null)
  const { data: first } = useFirstAvailable(shop.id, serviceId ? [serviceId] : [], today, 14)
  const byBarber = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const s of slots ?? []) m.set(s.barber_id, [...(m.get(s.barber_id) ?? []), s.starts_at])
    return m
  }, [slots])

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <h2 className="display text-[32px] leading-none">Available today</h2>
        <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5">
          {shop.services.slice(0, 6).map((s) => (
            <Chip key={s.id} active={s.id === serviceId} onClick={() => setServiceId(s.id)}>{s.name}</Chip>
          ))}
        </div>
      </div>
      <Card className="divide-y divide-line">
        {isLoading && <div className="p-5"><Skeleton className="h-10" /></div>}
        {shop.barbers.map((b) => {
          if (!b.services.some((s) => s.service_id === serviceId)) return null
          const times = byBarber.get(b.id) ?? []
          const next = first?.find((f) => f.barber_id === b.id)
          return (
            <div key={b.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="flex w-44 items-center gap-3">
                <Avatar name={b.name} src={b.photo_url} size={40} />
                <div className="min-w-0">
                  <div className="truncate font-semibold">{b.name}</div>
                  {b.title && <div className="truncate text-xs text-muted">{b.title}</div>}
                </div>
              </div>
              <div className="no-scrollbar flex flex-1 gap-2 overflow-x-auto">
                {times.length ? (
                  times.slice(0, 8).map((t) => (
                    <Link key={t} to={`/s/${shop.slug}/book?service=${serviceId}&barber=${b.id}&date=${today}&time=${encodeURIComponent(t)}`}
                      className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-sm font-semibold tnum transition hover:border-accent hover:bg-accent-soft">
                      {time(t, shop.timezone)}
                    </Link>
                  ))
                ) : next ? (
                  <Link to={`/s/${shop.slug}/book?service=${serviceId}&barber=${b.id}&time=${encodeURIComponent(next.starts_at)}`} className="text-sm text-muted hover:text-ink">
                    Next available: <b className="text-ink">{relativeDay(next.starts_at, shop.timezone)} {time(next.starts_at, shop.timezone)}</b>
                  </Link>
                ) : (
                  <span className="text-sm text-muted">No openings in the next two weeks</span>
                )}
              </div>
            </div>
          )
        })}
      </Card>
    </section>
  )
}

function BarberCard({ shop, barber }: { shop: PublicShop; barber: PublicShop['barbers'][number] }) {
  const { data: first } = useFirstAvailable(shop.id, barber.services[0] ? [barber.services[0].service_id] : [])
  const next = first?.find((f) => f.barber_id === barber.id)
  return (
    <Card className="flex flex-col p-5">
      <Link to={`/s/${shop.slug}/barber/${barber.slug}`} className="flex items-center gap-4">
        <Avatar name={barber.name} src={barber.photo_url} size={64} />
        <div className="min-w-0">
          <div className="text-lg font-semibold">{barber.name}</div>
          {barber.title && <div className="text-sm text-muted">{barber.title}</div>}
          {barber.review_count > 0 && (
            <div className="mt-1 flex items-center gap-1 text-sm"><Star className="size-3.5 fill-accent text-accent" /> {Number(barber.rating).toFixed(1)} <span className="text-muted">({barber.review_count})</span></div>
          )}
        </div>
      </Link>
      {barber.specialties.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">{barber.specialties.slice(0, 4).map((s) => <Badge key={s}>{s}</Badge>)}</div>
      )}
      <div className="mt-auto pt-5">
        <div className="mb-3 text-sm text-muted">
          {next ? <>Next available: <b className="text-ink">{relativeDay(next.starts_at, shop.timezone)} {time(next.starts_at, shop.timezone)}</b></> : 'Fully booked for now'}
        </div>
        <Link to={`/s/${shop.slug}/book?barber=${barber.id}`}><Button variant="outline" block>Book with {barber.name.split(' ')[0]}</Button></Link>
      </div>
    </Card>
  )
}

function ShopSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-5 py-12">
      <Skeleton className="size-14" />
      <Skeleton className="h-16 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-40" />
    </div>
  )
}
