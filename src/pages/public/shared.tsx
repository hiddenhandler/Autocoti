import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { rpc, isConfigured } from '@/lib/supabase'
import type { PublicShop, Slot } from '@/lib/types'
import { setDefaultCurrency } from '@/lib/format'
import { Logo } from '@/components/ui'

export function usePublicShop(slug: string | undefined) {
  const q = useQuery({
    queryKey: ['public_shop', slug],
    enabled: !!slug && isConfigured,
    staleTime: 60_000,
    queryFn: () => rpc<PublicShop | null>('get_public_shop', { p_slug: slug }),
  })
  useAccent(q.data?.accent_color)
  if (q.data?.currency) setDefaultCurrency(q.data.currency)
  return q
}

export function useAccent(color: string | null | undefined) {
  useEffect(() => {
    if (!color) return
    document.documentElement.style.setProperty('--accent', color)
    return () => {
      document.documentElement.style.removeProperty('--accent')
    }
  }, [color])
}

export function useSlots(shopId: string | undefined, serviceIds: string[], date: string | null, barberId: string | null, days = 1) {
  return useQuery({
    queryKey: ['slots', shopId, serviceIds.join(','), date, barberId, days],
    enabled: !!shopId && serviceIds.length > 0 && !!date,
    refetchInterval: 30_000,
    staleTime: 10_000,
    queryFn: () => rpc<Slot[]>('get_available_slots', { p_shop_id: shopId, p_service_ids: serviceIds, p_date: date, p_days: days, p_barber_id: barberId }),
  })
}

export function useAvailableDays(shopId: string | undefined, serviceIds: string[], from: string, days: number, barberId: string | null) {
  return useQuery({
    queryKey: ['days', shopId, serviceIds.join(','), from, days, barberId],
    enabled: !!shopId && serviceIds.length > 0,
    refetchInterval: 60_000,
    queryFn: () => rpc<{ day: string; slots: number }[]>('get_available_days', { p_shop_id: shopId, p_service_ids: serviceIds, p_from_date: from, p_days: days, p_barber_id: barberId }),
  })
}

export function useFirstAvailable(shopId: string | undefined, serviceIds: string[], from?: string, days = 14) {
  return useQuery({
    queryKey: ['first', shopId, serviceIds.join(','), from, days],
    enabled: !!shopId && serviceIds.length > 0,
    refetchInterval: 30_000,
    queryFn: () => rpc<Slot[]>('get_first_available', { p_shop_id: shopId, p_service_ids: serviceIds, p_from_date: from ?? null, p_days: days }),
  })
}

let sessionId: string | null = null
export function track(shopId: string | undefined, step: 'view' | 'service' | 'barber' | 'time' | 'details' | 'booked') {
  if (!shopId) return
  try {
    sessionId ??= sessionStorage.getItem('ac.sid') ?? crypto.randomUUID()
    sessionStorage.setItem('ac.sid', sessionId)
  } catch {
    sessionId ??= crypto.randomUUID()
  }
  rpc('track_booking_event', { p_shop_id: shopId, p_session_id: sessionId, p_step: step }).catch(() => {})
}

export function PublicFooter() {
  return (
    <footer className="mt-16 border-t border-line py-8 text-center text-xs text-muted">
      <Link to="/" className="inline-flex items-center gap-1.5 opacity-80 hover:opacity-100">
        Powered by <Logo className="scale-75" />
      </Link>
    </footer>
  )
}

export function ShopNotFound({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-6 text-center">
      <h1 className="display text-4xl">Shop not found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">{children ?? "This booking page doesn't exist or isn't published yet."}</p>
      <Link to="/" className="mt-6 text-sm font-semibold underline-offset-4 hover:underline">Go to BarberNGo</Link>
    </div>
  )
}

/** Build an .ics file so clients can add the appointment to their calendar. */
export function icsHref(opts: { title: string; start: string; end: string; location?: string; description?: string }) {
  const f = (d: string) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BarberNGo//EN', 'BEGIN:VEVENT',
    `UID:${f(opts.start)}-${Math.random().toString(36).slice(2)}@barberngo`,
    `DTSTAMP:${f(new Date().toISOString())}`, `DTSTART:${f(opts.start)}`, `DTEND:${f(opts.end)}`,
    `SUMMARY:${opts.title}`, opts.location ? `LOCATION:${opts.location}` : '', opts.description ? `DESCRIPTION:${opts.description}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n')
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(body)}`
}

const CLIENT_KEY = 'barberngo.client'
export interface SavedClient { first_name: string; last_name: string; phone: string; email: string }
export function loadSavedClient(): SavedClient | null {
  try {
    return JSON.parse(localStorage.getItem(CLIENT_KEY) ?? 'null')
  } catch {
    return null
  }
}
export function saveClient(c: SavedClient) {
  try {
    localStorage.setItem(CLIENT_KEY, JSON.stringify(c))
  } catch {
    /* ignore */
  }
}
