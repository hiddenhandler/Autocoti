import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && anonKey)

export const supabase: SupabaseClient = createClient(url ?? 'http://localhost:54321', anonKey ?? 'missing-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

export const APP_URL = (import.meta.env.VITE_APP_URL as string | undefined) ?? (typeof window !== 'undefined' ? window.location.origin : '')

/** Call a Postgres RPC and throw on error. */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw error
  return data as T
}

/** Throw on Supabase query errors and return data. */
export function must<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error
  return res.data as T
}
