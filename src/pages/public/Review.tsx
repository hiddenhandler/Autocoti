import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Check, Star } from 'lucide-react'
import { rpc } from '@/lib/supabase'
import { useAccent } from './shared'
import { Button, cx, Spinner, Textarea } from '@/components/ui'
import { friendlyError } from '@/lib/errors'

export default function Review() {
  const { token } = useParams()
  const { data: ctx, isLoading } = useQuery({
    queryKey: ['review', token],
    queryFn: () => rpc<{ barber_name: string; shop_name: string; shop_slug: string; service_name: string; client_first_name: string; status: string; already_reviewed: boolean; accent_color: string } | null>('get_review_context', { p_token: token }),
  })
  useAccent(ctx?.accent_color)
  const [rating, setRating] = useState(0)
  const [shopRating, setShopRating] = useState(0)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (!ctx) return <div className="flex min-h-dvh items-center justify-center text-muted">This link is not valid.</div>

  if (done || ctx.already_reviewed)
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
        <div className="flex size-16 items-center justify-center rounded-full bg-accent text-accent-ink"><Check className="size-8" /></div>
        <h1 className="display mt-6 text-4xl">Thanks{ctx.client_first_name ? `, ${ctx.client_first_name}` : ''}!</h1>
        <p className="mt-2 text-muted">Your feedback helps {ctx.barber_name} and {ctx.shop_name}.</p>
        <Link to={`/s/${ctx.shop_slug}/book`} className="mt-8"><Button size="lg">Book your next cut</Button></Link>
      </div>
    )

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await rpc('submit_review', { p_token: token, p_barber_rating: rating || null, p_shop_rating: shopRating || null, p_comment: comment || null })
      setDone(true)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-10">
      <div className="eyebrow">{ctx.shop_name}</div>
      <h1 className="display mt-2 text-5xl leading-none">How was your cut?</h1>
      <p className="mt-3 text-muted">{ctx.service_name} with {ctx.barber_name}</p>
      <Stars value={rating} onChange={setRating} label={`Rate ${ctx.barber_name}`} big />
      <div className="mt-8 text-sm font-medium">And the shop overall?</div>
      <Stars value={shopRating} onChange={setShopRating} label="Rate the shop" />
      <Textarea className="mt-8" rows={3} placeholder="Tell us more (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <Button size="xl" block className="mt-6" disabled={!rating && !shopRating} loading={busy} onClick={submit}>Send review</Button>
    </div>
  )
}

function Stars({ value, onChange, label, big }: { value: number; onChange: (v: number) => void; label: string; big?: boolean }) {
  return (
    <div className="mt-4 flex gap-2" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => onChange(n)} className="transition active:scale-90">
          <Star className={cx(big ? 'size-11' : 'size-8', 'text-accent', n <= value ? 'fill-current' : 'opacity-30')} />
        </button>
      ))}
    </div>
  )
}
