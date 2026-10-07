import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { must, rpc, supabase } from './supabase'
import type { Analytics, Appointment, Barber, BarberService, Service, Shop } from './types'
import { useToast } from '@/components/ui'
import { friendlyError } from './errors'

export const APPT_SELECT = '*, client:clients(id, first_name, last_name, phone, email), services:appointment_services(id, service_id, name, price_cents, duration_minutes, position)'

export function useShop(shopId: string) {
  return useQuery({
    queryKey: ['shop', shopId],
    queryFn: async () => must(await supabase.from('shops').select('*').eq('id', shopId).single()) as Shop,
  })
}

export function useBarbers(shopId: string, opts: { includeArchived?: boolean } = {}) {
  return useQuery({
    queryKey: ['barbers', shopId, opts.includeArchived ?? false],
    queryFn: async () => {
      let q = supabase.from('barbers').select('*').eq('shop_id', shopId).is('deleted_at', null).order('sort_order').order('display_name')
      if (!opts.includeArchived) q = q.neq('status', 'archived')
      return must(await q) as Barber[]
    },
  })
}

export function useServices(shopId: string) {
  return useQuery({
    queryKey: ['services', shopId],
    queryFn: async () =>
      must(await supabase.from('services').select('*').eq('shop_id', shopId).is('deleted_at', null).order('sort_order').order('name')) as Service[],
  })
}

export function useBarberServices(shopId: string) {
  return useQuery({
    queryKey: ['barber_services', shopId],
    queryFn: async () => must(await supabase.from('barber_services').select('*, barbers!inner(shop_id)').eq('barbers.shop_id', shopId)) as BarberService[],
  })
}

export function useAppointments(shopId: string, fromIso: string, toIso: string, opts: { barberId?: string | null; includeCancelled?: boolean } = {}) {
  return useQuery({
    queryKey: ['appointments', shopId, fromIso, toIso, opts.barberId ?? null, opts.includeCancelled ?? false],
    queryFn: async () => {
      let q = supabase
        .from('appointments')
        .select(APPT_SELECT)
        .eq('shop_id', shopId)
        .is('deleted_at', null)
        .gte('starts_at', fromIso)
        .lt('starts_at', toIso)
        .neq('status', 'RESCHEDULED')
        .order('starts_at')
      if (opts.barberId) q = q.eq('barber_id', opts.barberId)
      if (!opts.includeCancelled) q = q.not('status', 'in', '(CANCELLED)')
      return must(await q) as Appointment[]
    },
  })
}

export function useAnalytics(shopId: string, from: string, to: string, barberId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ['analytics', shopId, from, to, barberId ?? null],
    enabled,
    staleTime: 60_000,
    queryFn: () => rpc<Analytics>('shop_analytics', { p_shop_id: shopId, p_from: from, p_to: to, p_barber_id: barberId ?? null }),
  })
}

/** Live updates: any change to this shop's calendar refreshes dependent queries. */
export function useRealtimeShop(shopId: string) {
  const qc = useQueryClient()
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(t)
      t = setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['appointments', shopId] })
        qc.invalidateQueries({ queryKey: ['walk_ins', shopId] })
        qc.invalidateQueries({ queryKey: ['analytics', shopId] })
        qc.invalidateQueries({ queryKey: ['owner_actions', shopId] })
      }, 250)
    }
    const ch = supabase
      .channel(`shop:${shopId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments', filter: `shop_id=eq.${shopId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'walk_ins', filter: `shop_id=eq.${shopId}` }, refresh)
      .subscribe()
    return () => {
      clearTimeout(t)
      supabase.removeChannel(ch)
    }
  }, [qc, shopId])
}

/** Mutation helper: runs fn, toasts friendly errors, invalidates keys. */
export function useAction<TArgs, TResult = unknown>(
  fn: (args: TArgs) => Promise<TResult>,
  opts: { invalidate?: QueryKey[]; success?: string | ((r: TResult) => string); onSuccess?: (r: TResult, a: TArgs) => void } = {},
) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, a) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k })
      if (opts.success) toast(typeof opts.success === 'function' ? opts.success(r) : opts.success, 'success')
      opts.onSuccess?.(r, a)
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  })
}
