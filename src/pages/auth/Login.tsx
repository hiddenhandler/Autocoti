import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Mail } from 'lucide-react'
import { rpc, supabase, isConfigured } from '@/lib/supabase'
import { Button, Field, Input, Logo } from '@/components/ui'
import { friendlyError } from '@/lib/errors'
import { SetupNotice } from '@/components/SetupNotice'
import type { Workspace } from '@/lib/types'

export default function Login() {
  const loc = useLocation()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const isSignup = loc.pathname === '/signup'
  const intent = params.get('intent') ?? (params.get('client') ? 'client' : isSignup ? 'owner' : null)
  const next = params.get('next')
  const [name, setName] = useState('')
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  if (!isConfigured) return <SetupNotice />

  async function afterAuth() {
    if (next) return nav(next, { replace: true })
    const ws = await rpc<Workspace[]>('my_workspaces').catch(() => [])
    if (ws.length) return nav('/app', { replace: true })
    if (intent === 'owner') return nav('/onboarding', { replace: true })
    return nav('/me', { replace: true })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name }, emailRedirectTo: `${window.location.origin}${intent === 'owner' ? '/onboarding' : next ?? '/me'}` },
        })
        if (error) throw error
        if (!data.session) {
          setSent(true)
          return
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      }
      await afterAuth()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  async function magicLink() {
    if (!email) return setError('Enter your email first.')
    setBusy(true)
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}${next ?? '/app'}` } })
    setBusy(false)
    if (error) setError(friendlyError(error))
    else setSent(true)
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link to="/" className="mb-10 inline-block">
            <Logo />
          </Link>
          {sent ? (
            <div className="animate-rise">
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Mail className="size-6" />
              </div>
              <h1 className="display text-4xl">Check your inbox</h1>
              <p className="mt-3 text-sm text-muted">We sent a link to <b className="text-ink">{email}</b>. Open it on this device to continue.</p>
            </div>
          ) : (
            <>
              <h1 className="display text-[42px] leading-none">{isSignup ? (intent === 'owner' ? 'Open your shop.' : 'Create account') : 'Welcome back.'}</h1>
              <p className="mt-3 text-sm text-muted">
                {isSignup
                  ? intent === 'owner'
                    ? '14 days free. No card required.'
                    : 'Manage your appointments and rebook in one tap.'
                  : 'Sign in to your shop or your bookings.'}
              </p>
              <form onSubmit={submit} className="mt-8 space-y-4">
                {isSignup && (
                  <Field label="Your name">
                    <Input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" placeholder="Carlos Rivera" />
                  </Field>
                )}
                <Field label="Email">
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@shop.com" />
                </Field>
                <Field label="Password" hint={isSignup ? 'At least 8 characters' : undefined}>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={isSignup ? 8 : 1}
                    autoComplete={isSignup ? 'new-password' : 'current-password'} />
                </Field>
                {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
                <Button type="submit" size="lg" block loading={busy}>
                  {isSignup ? 'Create account' : 'Sign in'}
                </Button>
                {!isSignup && (
                  <Button variant="ghost" block onClick={magicLink} disabled={busy}>
                    Email me a sign-in link
                  </Button>
                )}
              </form>
              <p className="mt-8 text-sm text-muted">
                {isSignup ? (
                  <>Already have an account? <Link className="font-semibold text-ink underline-offset-4 hover:underline" to={`/login${loc.search}`}>Sign in</Link></>
                ) : (
                  <>New here? <Link className="font-semibold text-ink underline-offset-4 hover:underline" to={`/signup?intent=owner`}>Open a shop</Link> · <Link className="font-semibold text-ink underline-offset-4 hover:underline" to={`/signup?intent=client${next ? `&next=${encodeURIComponent(next)}` : ''}`}>I'm a client</Link></>
                )}
              </p>
            </>
          )}
        </div>
      </div>
      <div className="relative hidden overflow-hidden border-l border-line bg-surface lg:block">
        <div className="pole absolute inset-y-0 left-0 w-2 opacity-60" />
        <div className="flex h-full flex-col justify-end p-14">
          <p className="display max-w-md text-5xl leading-[1.05]">“I stopped guessing. I know exactly how every chair is doing.”</p>
          <p className="mt-6 text-sm text-muted">The operating system for your barbershop.</p>
        </div>
      </div>
    </div>
  )
}
