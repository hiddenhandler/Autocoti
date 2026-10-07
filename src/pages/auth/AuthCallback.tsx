import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { supabase } from '@/lib/supabase'
import { postAuthPath } from '@/lib/postAuth'
import { Button, EmptyState, Spinner } from '@/components/ui'

// Landing page for Google sign-in and emailed sign-in links. supabase-js reads
// the session from the URL; once it exists we route like a normal sign-in.
export default function AuthCallback() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const urlError = params.get('error_description') ?? hash.get('error_description')
    if (urlError) {
      setError(urlError)
      return
    }
    let done = false
    const go = async () => {
      if (done) return
      done = true
      nav(await postAuthPath(params.get('intent'), params.get('next')), { replace: true })
    }
    supabase.auth.getSession().then(({ data }) => data.session && go())
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => session && go())
    const timeout = setTimeout(() => !done && setError('That sign-in link is invalid or has expired.'), 10_000)
    return () => {
      sub.subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [params, nav])

  if (error)
    return (
      <EmptyState className="min-h-dvh" title="Couldn't sign you in" body={error}
        action={<Link to="/login"><Button>Back to sign in</Button></Link>} />
    )
  return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
}
