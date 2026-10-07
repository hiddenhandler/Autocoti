import { rpc } from '@/lib/supabase'
import type { Workspace } from '@/lib/types'

/** Where to land after any sign-in (password, Google, email link). */
export async function postAuthPath(intent: string | null, next: string | null): Promise<string> {
  // Only same-site relative paths, never an open redirect.
  if (next && next.startsWith('/') && !next.startsWith('//')) return next
  const ws = await rpc<Workspace[]>('my_workspaces').catch(() => [])
  if (ws.length) return '/app'
  if (await rpc<boolean>('am_platform_admin').catch(() => false)) return '/admin'
  if (intent === 'owner') return '/onboarding'
  return '/me'
}

/** Absolute URL that OAuth / email links return to, carrying intent + next. */
export function authCallbackUrl(intent: string | null, next: string | null): string {
  const q = new URLSearchParams()
  if (intent) q.set('intent', intent)
  if (next) q.set('next', next)
  const qs = q.toString()
  return `${window.location.origin}/auth/callback${qs ? `?${qs}` : ''}`
}
