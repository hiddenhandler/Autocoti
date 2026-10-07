import { useParams, useNavigate, Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { rpc } from '@/lib/supabase'
import { useAuth } from '@/lib/auth'
import { Button, Card, Logo, Spinner } from '@/components/ui'
import { friendlyError } from '@/lib/errors'

export default function AcceptInvite() {
  const { token } = useParams()
  const { user, loading } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data: inv, isLoading } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => rpc<{ shop_name: string; role: string; email: string; expired: boolean; accepted: boolean } | null>('get_invitation', { p_token: token }),
  })

  async function accept() {
    setBusy(true)
    try {
      await rpc('accept_invitation', { p_token: token })
      await qc.invalidateQueries({ queryKey: ['workspaces'] })
      nav('/app', { replace: true })
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
        ) : !inv || inv.expired ? (
          <p className="mt-8 text-muted">This invitation is no longer valid. Ask the shop owner for a new one.</p>
        ) : inv.accepted ? (
          <p className="mt-8 text-muted">This invitation was already accepted. <Link to="/app" className="text-ink underline">Open the app</Link></p>
        ) : (
          <>
            <h1 className="display mt-8 text-4xl">Join {inv.shop_name}</h1>
            <p className="mt-2 text-sm text-muted">You've been invited as <b className="capitalize text-ink">{inv.role}</b> ({inv.email}).</p>
            {error && <p className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
            <div className="mt-8">
              {user ? (
                <Button size="lg" block loading={busy} onClick={accept}>Accept invitation</Button>
              ) : (
                <div className="grid gap-2">
                  <Button size="lg" block onClick={() => nav(`/signup?intent=staff&email=${encodeURIComponent(inv.email)}&next=/invite/${token}`)}>Create account</Button>
                  <Button variant="ghost" block onClick={() => nav(`/login?email=${encodeURIComponent(inv.email)}&next=/invite/${token}`)}>I already have an account</Button>
                </div>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
