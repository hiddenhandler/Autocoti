import { Link, useParams } from 'react-router'
import { ArrowLeft, AtSign, Star } from 'lucide-react'
import { usePublicShop, useFirstAvailable, ShopNotFound, PublicFooter } from './shared'
import { Avatar, Badge, Button, Card, cx, Spinner } from '@/components/ui'
import { money, minutes, relativeDay, time } from '@/lib/format'

export default function BarberProfile() {
  const { slug, barberSlug } = useParams()
  const { data: shop, isLoading } = usePublicShop(slug)
  const barber = shop?.barbers.find((b) => b.slug === barberSlug)
  const { data: first } = useFirstAvailable(shop?.id, barber?.services[0] ? [barber.services[0].service_id] : [])
  if (isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (!shop || !barber) return <ShopNotFound />
  const next = first?.find((f) => f.barber_id === barber.id)
  const reviews = shop.reviews.filter((r) => r.barber_name === barber.name)

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 pb-32 pt-6">
      <Link to={`/s/${shop.slug}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> {shop.name}</Link>
      <div className="mt-8 flex flex-col items-center text-center">
        <Avatar name={barber.name} src={barber.photo_url} size={112} />
        <h1 className="display mt-5 text-5xl">{barber.name}</h1>
        {barber.title && <p className="mt-1 text-lg text-muted">{barber.title}</p>}
        {barber.review_count > 0 && (
          <div className="mt-3 flex items-center gap-1.5">
            {Array.from({ length: 5 }, (_, i) => <Star key={i} className={cx('size-4 text-accent', i < Math.round(Number(barber.rating)) && 'fill-current')} />)}
            <span className="ml-1 text-sm font-semibold">{Number(barber.rating).toFixed(1)}</span>
            <span className="text-sm text-muted">({barber.review_count} reviews)</span>
          </div>
        )}
        {barber.specialties.length > 0 && <div className="mt-4 flex flex-wrap justify-center gap-1.5">{barber.specialties.map((s) => <Badge key={s}>{s}</Badge>)}</div>}
        {barber.instagram && (
          <a href={`https://instagram.com/${barber.instagram.replace('@', '')}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
            <AtSign className="size-4" /> {barber.instagram}
          </a>
        )}
        <p className="mt-4 text-sm">
          {next ? <>Next available: <b>{relativeDay(next.starts_at, shop.timezone)} {time(next.starts_at, shop.timezone)}</b></> : <span className="text-muted">Fully booked for the next two weeks</span>}
        </p>
      </div>
      {barber.bio && <p className="mt-8 whitespace-pre-line text-center leading-relaxed text-muted">{barber.bio}</p>}

      <h2 className="display mb-4 mt-12 text-3xl">Services</h2>
      <Card className="divide-y divide-line">
        {barber.services.map((bs) => {
          const s = shop.services.find((x) => x.id === bs.service_id)
          if (!s) return null
          return (
            <Link key={s.id} to={`/s/${shop.slug}/book?service=${s.id}&barber=${barber.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-surface-2">
              <div>
                <div className="font-semibold">{s.name}</div>
                <div className="text-sm text-muted">{minutes(bs.duration_minutes)}</div>
              </div>
              <div className="font-semibold tnum">{money(bs.price_cents)}</div>
            </Link>
          )
        })}
      </Card>

      {reviews.length > 0 && (
        <>
          <h2 className="display mb-4 mt-12 text-3xl">Reviews</h2>
          <div className="space-y-3">
            {reviews.map((r, i) => (
              <Card key={i} className="p-5">
                <div className="flex text-accent">{Array.from({ length: 5 }, (_, j) => <Star key={j} className={cx('size-3.5', j < r.rating && 'fill-current')} />)}</div>
                <p className="mt-2">“{r.comment}”</p>
                <p className="mt-2 text-xs text-muted">{r.client_name}</p>
              </Card>
            ))}
          </div>
        </>
      )}
      <PublicFooter />
      <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-line bg-surface/92 p-3 backdrop-blur-md">
        <div className="mx-auto max-w-2xl">
          <Link to={`/s/${shop.slug}/book?barber=${barber.id}`}><Button size="xl" block>BOOK WITH {barber.name.split(' ')[0].toUpperCase()}</Button></Link>
        </div>
      </div>
    </div>
  )
}
