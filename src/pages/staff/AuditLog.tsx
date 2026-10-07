import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { dateLabel, time } from '@/lib/format'
import { Badge, Button, Card, EmptyState, PageHeader, Select, Skeleton } from '@/components/ui'

const ENTITY_LABEL: Record<string, string> = {
  appointments: 'Appointment', payments: 'Payment', refunds: 'Refund', commissions: 'Commission', services: 'Service', barbers: 'Barber',
  barber_services: 'Barber price', availability: 'Availability', availability_exceptions: 'Time off', clients: 'Client', client_notes: 'Client note',
  shops: 'Shop', shop_settings: 'Settings', booking_settings: 'Booking policy', business_hours: 'Hours', memberships: 'Team access',
  promo_codes: 'Promo code', gift_cards: 'Gift card', reviews: 'Review', subscriptions: 'Subscription', membership_plans: 'Membership plan', client_memberships: 'Membership',
}
const PAGE = 50

export default function AuditLog() {
  const { ws, can } = useWorkspace()
  const [entity, setEntity] = useState('')
  const [page, setPage] = useState(0)
  const { data, isLoading } = useQuery({
    queryKey: ['audit', ws.shop_id, entity, page],
    enabled: can('audit.view'),
    queryFn: async () => {
      let q = supabase.from('audit_logs').select('*').eq('shop_id', ws.shop_id).order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1)
      if (entity) q = q.eq('entity', entity)
      return (await q).data ?? []
    },
  })
  const actors = useQuery({
    queryKey: ['team', ws.shop_id, 'names'],
    queryFn: async () => (await supabase.rpc('list_team', { p_shop_id: ws.shop_id })).data ?? [],
  })
  const name = (id: string | null) => (id ? actors.data?.find((m: any) => m.user_id === id)?.full_name ?? 'Client / system' : 'Client / system')
  if (!can('audit.view')) return <EmptyState title="Only the owner can view the audit log" />
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Every change to money, schedules, prices, permissions and client records — who, what, when and from where." actions={
        <Select className="h-9 w-48" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(0) }}>
          <option value="">Everything</option>
          {Object.entries(ENTITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      } />
      {isLoading ? <Skeleton className="h-96" /> : !data?.length ? <Card><EmptyState icon={<ShieldCheck className="size-6" />} title="No events" /></Card> : (
        <Card className="divide-y divide-line">
          {data.map((l: any) => (
            <div key={l.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={l.action === 'delete' ? 'danger' : l.action === 'insert' ? 'success' : 'neutral'}>{l.action}</Badge>
                <span className="font-medium">{ENTITY_LABEL[l.entity] ?? l.entity}</span>
                <span className="text-muted">by {name(l.actor_id)}</span>
                <span className="ml-auto text-xs text-muted">{dateLabel(l.created_at, ws.timezone)} {time(l.created_at, ws.timezone)}{l.ip ? ` · ${l.ip}` : ''}</span>
              </div>
              {l.changes && (
                <div className="mt-1.5 space-y-0.5 text-xs text-muted">
                  {Object.entries(l.changes).slice(0, 6).map(([k, v]: any) => <div key={k}><span className="font-mono">{k}</span>: {fmt(v[0])} → <span className="text-ink">{fmt(v[1])}</span></div>)}
                </div>
              )}
              {l.user_agent && <div className="mt-1 truncate text-[11px] text-faint">{l.user_agent}</div>}
            </div>
          ))}
          <div className="flex justify-between px-5 py-3">
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</Button>
            <Button size="sm" variant="secondary" disabled={data.length < PAGE} onClick={() => setPage(page + 1)}>Older</Button>
          </div>
        </Card>
      )}
    </div>
  )
}

function fmt(v: unknown) {
  if (v === null || v === undefined) return '∅'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 60 ? s.slice(0, 57) + '…' : s
}
