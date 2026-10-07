import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Gift } from 'lucide-react'
import { rpc } from '@/lib/supabase'
import { useAuth } from '@/lib/auth'
import { friendlyError } from '@/lib/errors'
import { BarberChairIcon } from '@/components/BarberChair'
import { Badge, Button, Card, Logo, Spinner } from '@/components/ui'

interface AccountInvite {
  email_hint: string
  full_name: string | null
  kind: 'shop_owner' | 'chair_owner'
  shop_name: string
  plan_name: string
  comp_months: number
  status: 'pending' | 'claimed' | 'expired'
}

/** An account created by BarberNGo: sign in with the invited email, then activate. */
export default function ClaimAccount() {
  const { token = '' } = useParams()
  const { user, loading, signOut } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data: inv, isLoading } = useQuery({
    queryKey: ['account-invite', token],
    queryFn: () => rpc<AccountInvite | null>('get_account_invite', { p_token: token }),
  })
  const next = `/claim/${token}`

  async function claim() {
    setBusy(true)
    setError(null)
    try {
      await rpc('claim_account_invite', { p_token: token })
      await qc.invalidateQueries({ queryKey: ['workspaces'] })
      nav('/app/settings/shop', { replace: true })
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-md p-8">
        <Logo />
        {isLoading || loading ? (
          <Spinner className="mt-8" />
        ) : !inv || inv.status === 'expired' ? (
          <p className="mt-8 text-muted">This invitation is no longer valid. Ask BarberNGo for a new link.</p>
        ) : inv.status === 'claimed' ? (
          <p className="mt-8 text-muted">This account is already active. <Link to="/login?next=/app" className="text-ink underline">Sign in</Link></p>
        ) : (
          <>
            <div className="mt-8 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <BarberChairIcon className="size-6" />
            </div>
            <h1 className="display mt-5 text-4xl leading-tight">{inv.full_name ? `${inv.full_name.split(' ')[0]}, your` : 'Your'} {inv.kind === 'chair_owner' ? 'chair' : 'shop'} is ready.</h1>
            <p className="mt-2 text-sm text-muted">BarberNGo set up <b className="text-ink">{inv.shop_name}</b> for you.</p>
            <ul className="mt-6 space-y-2 text-sm">
              <li className="flex items-center gap-2"><Check className="size-4 text-accent" /> {inv.kind === 'chair_owner' ? 'Chair owner account — you keep 100%' : 'Barbershop owner account'}</li>
              <li className="flex items-center gap-2"><Check className="size-4 text-accent" /> Plan: <b>{inv.plan_name}</b></li>
              {inv.comp_months > 0 ? (
                <li className="flex items-center gap-2"><Gift className="size-4 text-accent" /> <Badge tone="accent">{inv.comp_months} month{inv.comp_months > 1 ? 's' : ''} free</Badge></li>
              ) : (
                <li className="flex items-center gap-2"><Check className="size-4 text-accent" /> 14-day free trial</li>
              )}
            </ul>
            {error && <p className="mt-5 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
            <div className="mt-8 space-y-2">
              {user ? (
                <>
                  <Button size="lg" block loading={busy} onClick={claim}>Activate my account</Button>
                  <p className="pt-1 text-center text-xs text-muted">
                    Signed in as {user.email}. Wrong account?{' '}
                    <button className="text-ink underline" onClick={() => signOut()}>Sign out</button>
                  </p>
                </>
              ) : (
                <>
                  <p className="mb-3 text-sm text-muted">Sign in with the email this was sent to ({inv.email_hint}).</p>
                  <Link to={`/signup?intent=owner&next=${encodeURIComponent(next)}`}><Button size="lg" block>Create my login</Button></Link>
                  <Link to={`/login?next=${encodeURIComponent(next)}`}><Button size="lg" block variant="ghost">I already have a login</Button></Link>
                </>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
