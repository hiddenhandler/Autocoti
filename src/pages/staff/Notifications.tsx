import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { rpc, supabase } from '@/lib/supabase'
import { ago } from '@/lib/format'
import { Badge, Card, cx, EmptyState, PageHeader, Skeleton } from '@/components/ui'

export default function Notifications() {
  const { ws, can } = useWorkspace()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['inbox', ws.shop_id],
    queryFn: async () => (await supabase.from('notifications').select('*').eq('shop_id', ws.shop_id).eq('channel', 'in_app').order('created_at', { ascending: false }).limit(100)).data ?? [],
  })
  const { data: outbox } = useQuery({
    queryKey: ['outbox', ws.shop_id],
    enabled: can('notifications.view'),
    queryFn: async () => (await supabase.from('notifications').select('id, event, status, to_address, scheduled_for, sent_at, last_error').eq('shop_id', ws.shop_id).neq('channel', 'in_app').order('scheduled_for', { ascending: false }).limit(50)).data ?? [],
  })
  useEffect(() => {
    if (data?.some((n: any) => !n.read_at)) rpc('mark_notifications_read', { p_ids: null }).then(() => qc.invalidateQueries({ queryKey: ['owner_actions'] }))
  }, [data, qc])

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Notifications" />
      {isLoading ? <Skeleton className="h-64" /> : !data?.length ? <Card><EmptyState icon={<Bell className="size-6" />} title="You're all caught up" /></Card> : (
        <Card className="divide-y divide-line">
          {data.map((n: any) => (
            <div key={n.id} className={cx('px-5 py-3 text-sm', !n.read_at && 'bg-accent-soft/40')}>
              <div className="flex justify-between gap-3">
                <span className="font-medium">{n.event === 'staff.new_booking' ? 'New booking' : n.event === 'staff.cancellation' ? 'Cancellation' : n.event}</span>
                <span className="text-xs text-muted">{ago(n.created_at)}</span>
              </div>
              <div className="text-muted">{n.payload.client_name} · {n.payload.service_name} · {n.payload.when}{n.payload.barber_name ? ` · ${n.payload.barber_name}` : ''}</div>
            </div>
          ))}
        </Card>
      )}
      {!!outbox?.length && (
        <div>
          <div className="eyebrow mb-3">Messages to clients</div>
          <Card className="divide-y divide-line">
            {outbox.map((n: any) => (
              <div key={n.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className="flex-1 truncate">{n.event} → {n.to_address ?? 'no address'}</span>
                <Badge tone={n.status === 'sent' ? 'success' : n.status === 'failed' ? 'danger' : n.status === 'queued' ? 'info' : 'neutral'}>{n.status}</Badge>
                <span className="w-24 text-right text-xs text-muted">{ago(n.sent_at ?? n.scheduled_for)}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  )
}
