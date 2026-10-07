import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Mail } from 'lucide-react'
import { supabase, isConfigured } from '@/lib/supabase'
import { Button, Field, Input, Logo } from '@/components/ui'
import { friendlyError } from '@/lib/errors'
import { SetupNotice } from '@/components/SetupNotice'
import { authCallbackUrl, postAuthPath } from '@/lib/postAuth'

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
    nav(await postAuthPath(intent, next), { replace: true })
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
          options: { data: { full_name: name }, emailRedirectTo: authCallbackUrl(intent, next) },
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
    if (isSignup && !name) return setError('Enter your name first.')
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: authCallbackUrl(intent, next),
        shouldCreateUser: isSignup,
        ...(isSignup ? { data: { full_name: name } } : {}),
      },
    })
    setBusy(false)
    if (error) setError(friendlyError(error))
    else setSent(true)
  }

  async function google() {
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: authCallbackUrl(intent, next) } })
    if (error) {
      setBusy(false)
      setError(friendlyError(error))
    }
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
              <Button variant="outline" size="lg" block className="mt-8" onClick={google} disabled={busy} icon={<GoogleIcon />}>
                Continue with Google
              </Button>
              <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-faint">
                <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
              </div>
              <form onSubmit={submit} className="space-y-4">
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
                <Button variant="ghost" block onClick={magicLink} disabled={busy} icon={<Mail className="size-4" />}>
                  {isSignup ? 'Skip the password — email me a link' : 'Email me a sign-in link'}
                </Button>
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
          <p className="display max-w-md text-5xl leading-[1.05]">Run Your Shop.<br /><span className="text-glow">Grow Your Business.</span></p>
          <p className="mt-6 text-sm text-muted">Everything your barbershop needs. One platform.</p>
        </div>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z" />
    </svg>
  )
}
