import { useQuery } from '@tanstack/react-query'
import { rpc } from '@/lib/supabase'

export interface MyAppointment {
  id: string
  shop_id: string
  shop_name: string
  shop_slug: string
  accent_color: string
  timezone: string
  barber_id: string
  barber_name: string
  barber_photo_url: string | null
  service_ids: string[]
  service_name: string
  starts_at: string
  ends_at: string
  status: string
  price_cents: number
  manage_token: string
  review_token: string | null
  has_review: boolean
}

export function useMyAppointments() {
  return useQuery({ queryKey: ['my_appointments'], queryFn: () => rpc<MyAppointment[]>('my_appointments') })
}

export function useMyFavorites() {
  return useQuery({
    queryKey: ['my_favorites'],
    queryFn: () => rpc<{ barber_id: string; barber_name: string; photo_url: string | null; title: string | null; shop_id: string; shop_name: string; shop_slug: string; barber_slug: string; timezone: string }[]>('my_favorite_barbers'),
  })
}

export const isUpcoming = (a: MyAppointment) => ['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE'].includes(a.status) && new Date(a.ends_at) > new Date()
