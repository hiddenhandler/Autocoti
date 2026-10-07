import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, MapPin, Phone, Scissors, Star } from 'lucide-react'
import { rpc } from '@/lib/supabase'
import { useAccent } from './shared'
import { Button, Card, cx, Spinner } from '@/components/ui'
import { Elapsed } from '@/components/live'
import { time } from '@/lib/format'
import type { WalkInTicket } from '@/lib/types'

/** The customer's live place in line. Polls every 10 s; buzzes when they're almost up. */
export default function QueueTicket() {
  const { token } = useParams()
  const qc = useQueryClient()
  const { data: t, isLoading } = useQuery({
    queryKey: ['ticket', token],
    refetchInterval: (q) => (['done', 'left', 'cancelled'].includes((q.state.data as WalkInTicket | null)?.status ?? '') ? false : 10_000),
    refetchOnWindowFocus: true,
    queryFn: () => rpc<WalkInTicket | null>('get_walk_in_ticket', { p_token: token }),
  })
  useAccent(t?.shop.accent_color)
  const [leaving, setLeaving] = useState(false)
  const alerted = useRef(false)

  // Close to the front (or called): vibrate + system notification once.
  const almost = !!t && ((t.status === 'waiting' && t.almost_ready) || t.status === 'called' || t.status === 'serving')
  useEffect(() => {
    if (!almost || alerted.current || !t) return
    alerted.current = true
    try {
      navigator.vibrate?.([200, 100, 200])
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(t.status === 'waiting' ? "You're almost up" : "It's your turn", { body: `${t.shop.name}${t.estimated_wait_minutes ? ` · about ${t.estimated_wait_minutes} min` : ''}` })
      }
    } catch {
      /* not supported */
    }
  }, [almost, t])

  if (isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (!t) return <div className="flex min-h-dvh items-center justify-center p-6 text-center text-muted">This queue link is not valid.</div>

  const leave = async () => {
    if (!confirm('Leave the queue?')) return
    setLeaving(true)
    await rpc('leave_walk_in_queue', { p_token: token }).catch(() => {})
    await qc.invalidateQueries({ queryKey: ['ticket', token] })
    setLeaving(false)
  }

  return (
    <div className="mx-auto min-h-dvh max-w-md px-5 py-8">
      <Link to={`/shop/${t.shop.slug}`} className="text-[13px] font-bold tracking-[0.16em] text-muted hover:text-ink">{t.shop.name.toUpperCase()}</Link>

      {t.status === 'waiting' && (
        <>
          {t.almost_ready && (
            <div className="animate-rise mt-5 flex items-center gap-3 rounded-2xl bg-success/12 px-4 py-3 text-success">
              <Bell className="size-5" />
              <div className="font-semibold">You're almost up.{t.estimated_wait_minutes !== null ? ` Estimated wait: ${t.estimated_wait_minutes} minutes.` : ''}</div>
            </div>
          )}
          <Card className="mt-5 p-7 text-center">
            <div className="text-sm font-semibold tracking-[0.16em] text-muted">YOU ARE</div>
            <div className="mt-1 text-[88px] font-extrabold leading-none tnum">#{t.position ?? '–'}</div>
            <div className="mt-2 text-lg text-muted">{t.ahead === 0 ? 'Nobody ahead of you' : `${t.ahead} ${t.ahead === 1 ? 'person' : 'people'} ahead`}</div>
            <div className="mt-6 rounded-2xl bg-surface-2 p-4">
              <div className="text-sm text-muted">Estimated wait</div>
              <div className="text-3xl font-bold tnum">
                {t.estimated_wait_minutes === null ? '—' : t.estimated_wait_minutes <= 2 ? 'Any minute' : `${t.wait_low}–${t.wait_high} min`}
              </div>
              {t.estimated_start && t.estimated_wait_minutes! > 2 && <div className="mt-1 text-sm text-muted">around {time(t.estimated_start, t.shop.timezone)}</div>}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 text-left text-sm">
              <div><div className="text-muted">Service</div><div className="font-semibold">{t.service_name ?? '—'}</div></div>
              <div><div className="text-muted">Barber</div><div className="font-semibold">{t.preferred_barber ?? (t.likely_barber ? `Likely ${t.likely_barber}` : 'First available')}</div></div>
            </div>
          </Card>
          <EnableAlerts />
          <p className="mt-4 text-center text-xs text-muted">This page updates by itself. We'll also message you when you're close.</p>
        </>
      )}

      {(t.status === 'called' || t.status === 'serving') && (
        <Card className="animate-rise mt-5 border-success/40 p-7 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-success/15 text-success"><Scissors className="size-7" /></span>
          {t.appointment?.actual_started_at ? (
            <>
              <div className="mt-4 text-sm font-semibold tracking-[0.16em] text-muted">CUT IN PROGRESS</div>
              <div className="mt-1 text-2xl font-bold">with {t.likely_barber}</div>
              <div className="mt-4 text-5xl font-bold"><Elapsed startedAt={t.appointment.actual_started_at} /></div>
              <div className="mt-1 text-sm text-muted">Started {time(t.appointment.actual_started_at, t.shop.timezone)} · about {t.appointment.scheduled_minutes} min</div>
            </>
          ) : (
            <>
              <div className="mt-4 text-3xl font-extrabold">It's your turn</div>
              <div className="mt-1 text-lg text-muted">{t.likely_barber ? `${t.likely_barber} is ready for you.` : 'Head to the front desk.'}</div>
            </>
          )}
        </Card>
      )}

      {t.status === 'done' && (
        <Card className="mt-5 p-7 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-7" /></span>
          <div className="mt-4 text-2xl font-bold">All done — looking sharp.</div>
          <div className="mt-6 grid gap-2">
            <Link to={`/shop/${t.shop.slug}/book`}><Button size="lg" block>BOOK AGAIN</Button></Link>
            <Link to={`/shop/${t.shop.slug}`}><Button size="lg" variant="ghost" block icon={<Star className="size-4" />}>Visit the shop page</Button></Link>
          </div>
        </Card>
      )}

      {(t.status === 'left' || t.status === 'cancelled') && (
        <Card className="mt-5 p-7 text-center">
          <div className="text-xl font-semibold">You left the queue.</div>
          <div className="mt-6 grid gap-2">
            <Link to={`/shop/${t.shop.slug}/queue`}><Button size="lg" block>Join again</Button></Link>
            <Link to={`/shop/${t.shop.slug}/book`}><Button size="lg" variant="secondary" block>Book a time instead</Button></Link>
          </div>
        </Card>
      )}

      <div className="mt-6 space-y-2 text-sm text-muted">
        {t.shop.address && <div className="flex items-center gap-2"><MapPin className="size-4" />{t.shop.address}</div>}
        {t.shop.phone && <a href={`tel:${t.shop.phone}`} className="flex items-center gap-2 hover:text-ink"><Phone className="size-4" />{t.shop.phone}</a>}
      </div>
      {t.status === 'waiting' && (
        <Button variant="ghost" block className="mt-6" loading={leaving} onClick={leave}>Leave the queue</Button>
      )}
    </div>
  )
}

function EnableAlerts() {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  const [perm, setPerm] = useState(supported ? Notification.permission : 'denied')
  if (!supported || perm !== 'default') return null
  return (
    <button onClick={async () => setPerm(await Notification.requestPermission())}
      className={cx('mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-line py-3 text-sm font-semibold hover:bg-surface-2')}>
      <Bell className="size-4" /> Alert me on this phone when I'm close
    </button>
  )
}
