import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ListOrdered } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { useBarbers } from '@/lib/api'
import { rpc, supabase } from '@/lib/supabase'
import { todayInTz, zonedToUtc } from '@/lib/time'
import { ago, relativeDateStr, time } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import type { Slot } from '@/lib/types'
import { Badge, Button, Card, EmptyState, PageHeader, Sheet, Skeleton, useToast } from '@/components/ui'

export default function Waitlist() {
  const { ws } = useWorkspace()
  const { data: barbers } = useBarbers(ws.shop_id)
  const [booking, setBooking] = useState<any>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['waitlist', ws.shop_id],
    refetchInterval: 30_000,
    queryFn: async () => (await supabase.from('waitlist').select('*, client:clients(first_name, last_name, phone, email), service:services(name)')
      .eq('shop_id', ws.shop_id).in('status', ['active', 'notified']).gte('desired_date', todayInTz(ws.timezone)).order('desired_date').order('created_at')).data ?? [],
  })
  const bname = (id: string | null) => (id ? barbers?.find((b) => b.id === id)?.display_name : 'Any barber')
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Waitlist" subtitle="When something opens up, matching clients are notified automatically. First to claim wins." />
      {isLoading ? <Skeleton className="h-64" /> : !data?.length ? (
        <Card><EmptyState icon={<ListOrdered className="size-6" />} title="Waitlist is empty" body="Clients can join from your booking page when their day is full." /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {data.map((w: any) => (
            <div key={w.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-semibold">{w.client.first_name} {w.client.last_name} {w.status === 'notified' && <Badge tone="accent">Offer sent</Badge>}</div>
                <div className="text-sm text-muted">{w.service.name} · {bname(w.barber_id)} · {relativeDateStr(w.desired_date, ws.timezone)} {w.time_from.slice(0, 5)}–{w.time_to.slice(0, 5)}</div>
                <div className="text-xs text-faint">{w.client.phone ?? w.client.email} · joined {ago(w.created_at)}</div>
              </div>
              <Button variant="secondary" onClick={() => setBooking(w)}>Book now</Button>
            </div>
          ))}
        </Card>
      )}
      {booking && <BookFromWaitlist entry={booking} onClose={() => setBooking(null)} />}
    </div>
  )
}

function BookFromWaitlist({ entry, onClose }: { entry: any; onClose: () => void }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: barbers } = useBarbers(ws.shop_id)
  const { data: slots, isLoading } = useQuery({
    queryKey: ['wl-slots', entry.id],
    queryFn: () => rpc<Slot[]>('get_available_slots', { p_shop_id: ws.shop_id, p_service_ids: [entry.service_id], p_date: entry.desired_date, p_days: 1, p_barber_id: entry.barber_id }),
  })
  const from = zonedToUtc(entry.desired_date, entry.time_from.slice(0, 5), ws.timezone).getTime()
  const to = zonedToUtc(entry.desired_date, entry.time_to.slice(0, 5), ws.timezone).getTime()
  const matching = (slots ?? []).filter((s) => { const t = new Date(s.starts_at).getTime(); return t >= from && t <= to })
  const book = async (s: Slot) => {
    try {
      await rpc('book_from_waitlist', { p_waitlist_id: entry.id, p_barber_id: s.barber_id, p_starts_at: s.starts_at })
      qc.invalidateQueries({ queryKey: ['waitlist', ws.shop_id] })
      qc.invalidateQueries({ queryKey: ['appointments', ws.shop_id] })
      toast('Booked from waitlist — client notified', 'success')
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  return (
    <Sheet open onClose={onClose} title={`Book ${entry.client.first_name}`}>
      {isLoading ? <Skeleton className="h-24" /> : matching.length === 0 ? <p className="text-sm text-muted">No openings in their window yet.</p> : (
        <div className="grid grid-cols-2 gap-2">
          {matching.map((s) => <Button key={s.barber_id + s.starts_at} variant="outline" onClick={() => book(s)}>{time(s.starts_at, ws.timezone)} · {barbers?.find((b) => b.id === s.barber_id)?.display_name}</Button>)}
        </div>
      )}
    </Sheet>
  )
}
