import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, supabase } from './supabase'
import type { Permission, Workspace } from './types'
import { setDefaultCurrency } from './format'

interface AuthState {
  session: Session | null
  user: User | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({ session: null, user: null, loading: true, signOut: async () => {} })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const qc = useQueryClient()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (s?.user) {
        // Attach guest bookings made with the same (verified) email.
        rpc('link_my_client_records').catch(() => {})
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    qc.clear()
    try {
      localStorage.removeItem('autocoti.workspace')
    } catch {
      /* storage unavailable */
    }
  }, [qc])

  const value = useMemo(() => ({ session, user: session?.user ?? null, loading, signOut }), [session, loading, signOut])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)

// ---------------------------------------------------------------------------
// Workspaces (shops the user works at) and the active one.
// ---------------------------------------------------------------------------
export function useWorkspaces() {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['workspaces', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: () => rpc<Workspace[]>('my_workspaces'),
  })
}

interface WorkspaceCtx {
  ws: Workspace
  can: (p: Permission) => boolean
  isOwner: boolean
  isBarberOnly: boolean
  features: Record<string, unknown>
  hasFeature: (f: string) => boolean
  switchTo: (shopId: string) => void
  all: Workspace[]
}

const WorkspaceContext = createContext<WorkspaceCtx | null>(null)

export function WorkspaceProvider({ workspaces, children }: { workspaces: Workspace[]; children: ReactNode }) {
  const [activeId, setActiveId] = useState<string>(() => {
    try {
      return localStorage.getItem('autocoti.workspace') ?? ''
    } catch {
      return ''
    }
  })
  const ws = workspaces.find((w) => w.shop_id === activeId) ?? workspaces[0]

  const { data: features = {} } = useQuery({
    queryKey: ['features', ws.shop_id],
    staleTime: 5 * 60_000,
    queryFn: () => rpc<Record<string, unknown>>('shop_features', { p_shop_id: ws.shop_id }),
  })
  const { data: settings } = useQuery({
    queryKey: ['shop_settings', ws.shop_id],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase.from('shop_settings').select('*').eq('shop_id', ws.shop_id).maybeSingle()
      return data
    },
  })
  setDefaultCurrency(settings?.currency)

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', ws.accent_color)
    return () => {
      document.documentElement.style.removeProperty('--accent')
    }
  }, [ws.accent_color])

  const value = useMemo<WorkspaceCtx>(
    () => ({
      ws,
      all: workspaces,
      can: (p) => ws.role === 'owner' || ws.permissions.includes(p),
      isOwner: ws.role === 'owner',
      isBarberOnly: ws.role === 'barber',
      features,
      hasFeature: (f) => Boolean(features?.[f]),
      switchTo: (id) => {
        setActiveId(id)
        try {
          localStorage.setItem('autocoti.workspace', id)
        } catch {
          /* ignore */
        }
      },
    }),
    [ws, workspaces, features],
  )
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used inside the staff app')
  return ctx
}
