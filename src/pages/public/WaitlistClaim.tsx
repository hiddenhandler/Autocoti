import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { rpc } from '@/lib/supabase'
import { useAccent } from './shared'
import { Button, Card, Spinner } from '@/components/ui'
import { relativeDay, time, dateStrLabel } from '@/lib/format'
import { friendlyError } from '@/lib/errors'

interface Offer {
  status: string
  shop_name: string
  shop_slug: string
  accent_color: string
  timezone: string
  service_name: string
  barber_name: string | null
  offered_starts_at: string | null
  offer_expires_at: string | null
  desired_date: string
  claimed_manage_token: string | null
}

export default function WaitlistClaim() {
  const { token } = useParams()
  const qc = useQueryClient()
  const { data: o, isLoading } = useQuery({ queryKey: ['waitlist', token], refetchInterval: 20_000, queryFn: () => rpc<Offer | null>('get_waitlist_offer', { p_token: token }) })
  useAccent(o?.accent_color)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  if (isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (!o) return <div className="flex min-h-dvh items-center justify-center text-muted">This link is not valid.</div>

  const claim = async () => {
    setBusy(true)
    try {
      const r = await rpc<{ error?: string; message?: string; manage_token?: string }>('claim_waitlist_slot', { p_token: token })
      setMsg(r.error ? r.message ?? 'Someone else got it first.' : null)
      qc.invalidateQueries({ queryKey: ['waitlist', token] })
    } catch (e) {
      setMsg(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <div className="eyebrow">{o.shop_name} · Waitlist</div>
      {o.status === 'notified' && o.offered_starts_at ? (
        <>
          <h1 className="display mt-2 text-5xl leading-none">A spot opened up.</h1>
          <Card className="mt-6 p-6">
            <div className="text-lg font-semibold">{o.service_name} with {o.barber_name}</div>
            <div className="mt-2 text-2xl font-semibold">{relativeDay(o.offered_starts_at, o.timezone)}, {time(o.offered_starts_at, o.timezone)}</div>
            {o.offer_expires_at && <div className="mt-3 flex items-center gap-1.5 text-sm text-muted"><Clock className="size-4" />Offer held until {time(o.offer_expires_at, o.timezone)} — first to claim gets it</div>}
          </Card>
          {msg && <p className="mt-4 rounded-xl bg-warning/14 px-4 py-3 text-sm">{msg}</p>}
          <Button size="xl" block className="mt-6" loading={busy} onClick={claim}>Claim this slot</Button>
        </>
      ) : o.status === 'claimed' ? (
        <>
          <h1 className="display mt-2 text-5xl leading-none">It's yours.</h1>
          <p className="mt-3 text-muted">You're booked. We've sent the details by email.</p>
          {o.claimed_manage_token && <Link to={`/a/${o.claimed_manage_token}`} className="mt-6"><Button size="lg" block>View appointment</Button></Link>}
        </>
      ) : o.status === 'active' ? (
        <>
          <h1 className="display mt-2 text-5xl leading-none">You're on the list.</h1>
          <p className="mt-3 text-muted">For {o.service_name} on {dateStrLabel(o.desired_date)}. We'll email you as soon as a matching spot opens.</p>
          {msg && <p className="mt-4 rounded-xl bg-warning/14 px-4 py-3 text-sm">{msg}</p>}
          <Button variant="ghost" className="mt-6" onClick={async () => { await rpc('cancel_waitlist', { p_token: token }); qc.invalidateQueries({ queryKey: ['waitlist', token] }) }}>Leave waitlist</Button>
        </>
      ) : (
        <>
          <h1 className="display mt-2 text-5xl leading-none">This waitlist spot has {o.status === 'cancelled' ? 'been cancelled' : 'expired'}.</h1>
          <Link to={`/s/${o.shop_slug}/book`} className="mt-6"><Button size="lg">See open times</Button></Link>
        </>
      )}
    </div>
  )
}
