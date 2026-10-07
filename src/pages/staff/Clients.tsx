import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Plus, Search, Users } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { rpc, supabase } from '@/lib/supabase'
import type { ClientRow } from '@/lib/types'
import { ago, money, relativeDay } from '@/lib/format'
import { downloadCsv } from '@/lib/csv'
import { friendlyError } from '@/lib/errors'
import { Avatar, Badge, Button, Card, Chip, cx, EmptyState, Field, Input, PageHeader, Select, Sheet, Skeleton, useToast } from '@/components/ui'

export const HEALTH_TONE = { NEW: 'info', ACTIVE: 'success', AT_RISK: 'warning', LOST: 'danger' } as const
export const HEALTH_LABEL = { NEW: 'New', ACTIVE: 'Active', AT_RISK: 'At risk', LOST: 'Lost' } as const

const PAGE = 50

export default function Clients() {
  const { ws, can } = useWorkspace()
  const [params, setParams] = useSearchParams()
  const health = params.get('health')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sort, setSort] = useState('last_visit')
  const [page, setPage] = useState(0)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(0) }, 200)
    return () => clearTimeout(t)
  }, [search])
  const { data, isLoading } = useQuery({
    queryKey: ['clients', ws.shop_id, debounced, health, sort, page],
    placeholderData: (prev) => prev,
    queryFn: () => rpc<ClientRow[]>('list_clients', { p_shop_id: ws.shop_id, p_search: debounced || null, p_health: health, p_limit: PAGE, p_offset: page * PAGE, p_sort: sort }),
  })
  const total = data?.[0]?.total_count ?? 0

  const exportAll = async () => {
    const rows = await rpc<ClientRow[]>('list_clients', { p_shop_id: ws.shop_id, p_search: debounced || null, p_health: health, p_limit: 500, p_offset: 0, p_sort: sort })
    downloadCsv('clients.csv', rows.map((c) => ({
      first_name: c.first_name, last_name: c.last_name ?? '', phone: c.phone ?? '', email: c.email ?? '', health: c.health, visits: c.visits,
      last_visit: c.last_visit?.slice(0, 10) ?? '', next_appointment: c.next_appointment?.slice(0, 10) ?? '',
      total_spent: c.total_spent_cents !== null ? (c.total_spent_cents / 100).toFixed(2) : '', no_shows: c.no_shows, cancellations: c.cancellations,
    })))
  }

  return (
    <div>
      <PageHeader title="Clients" subtitle={total ? `${total.toLocaleString()} clients` : undefined} actions={
        <>
          {can('clients.all') && <Button variant="secondary" icon={<Download className="size-4" />} onClick={exportAll}>CSV</Button>}
          <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add client</Button>
        </>
      } />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-72"><Input leading={<Search className="size-4" />} placeholder="Name, phone or email" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {[[null, 'All'], ['DUE', 'Due for a cut'], ['NEW', 'New'], ['ACTIVE', 'Active'], ['AT_RISK', 'At risk'], ['LOST', 'Lost']].map(([k, l]) => (
            <Chip key={l} active={health === k} onClick={() => { setParams(k ? { health: k } : {}); setPage(0) }}>{l}</Chip>
          ))}
        </div>
        <Select className="ml-auto h-9 w-40" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="last_visit">Recent visit</option><option value="name">Name</option><option value="visits">Most visits</option><option value="spent">Top spenders</option>
        </Select>
      </div>
      {isLoading ? <Skeleton className="h-96" /> : !data?.length ? (
        <Card><EmptyState icon={<Users className="size-6" />} title={debounced || health ? 'No clients match' : 'No clients yet'} body={debounced || health ? undefined : 'Clients are created automatically when they book.'} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-line">
            {data.map((c) => (
              <Link key={c.id} to={`/app/clients/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                <Avatar name={`${c.first_name} ${c.last_name ?? ''}`} size={38} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{c.first_name} {c.last_name}</span>
                    <Badge tone={HEALTH_TONE[c.health]}>{HEALTH_LABEL[c.health]}</Badge>
                    {c.is_due && c.health !== 'LOST' && !c.next_appointment && c.visits > 0 && <span className="hidden text-xs text-warning sm:inline">due for a cut</span>}
                  </div>
                  <div className="truncate text-xs text-muted">{c.phone ?? c.email ?? 'No contact'}</div>
                </div>
                <div className="hidden w-32 text-right text-sm sm:block">
                  <div className="tnum">{c.visits} visit{c.visits === 1 ? '' : 's'}</div>
                  <div className="text-xs text-muted">{c.last_visit ? ago(c.last_visit) : 'never'}</div>
                </div>
                <div className="hidden w-32 text-right text-sm md:block">
                  {c.next_appointment ? <span className="text-success">{relativeDay(c.next_appointment, ws.timezone)}</span> : <span className="text-faint">—</span>}
                  <div className="text-xs text-muted">next</div>
                </div>
                {c.total_spent_cents !== null && <div className="w-20 text-right text-sm font-semibold tnum">{money(c.total_spent_cents, { cents: false })}</div>}
              </Link>
            ))}
          </div>
          {total > PAGE && (
            <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
              <span className="text-muted">{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </Card>
      )}
      <AddClientSheet open={adding} onClose={() => setAdding(false)} />
    </div>
  )
}

function AddClientSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ws } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [f, setF] = useState({ first_name: '', last_name: '', phone: '', email: '', birthday: '' })
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    const { error } = await supabase.from('clients').insert({ shop_id: ws.shop_id, ...f, last_name: f.last_name || null, phone: f.phone || null, email: f.email || null, birthday: f.birthday || null, source: 'staff' })
    setBusy(false)
    if (error) return toast(error.code === '23505' ? 'A client with that phone or email already exists' : friendlyError(error), 'error')
    qc.invalidateQueries({ queryKey: ['clients', ws.shop_id] })
    toast('Client added', 'success')
    setF({ first_name: '', last_name: '', phone: '', email: '', birthday: '' })
    onClose()
  }
  return (
    <Sheet open={open} onClose={onClose} title="Add client" footer={<Button size="lg" block loading={busy} disabled={!f.first_name.trim()} onClick={submit}>Save</Button>}>
      <div className={cx('grid gap-3 sm:grid-cols-2')}>
        <Field label="First name"><Input value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} autoFocus /></Field>
        <Field label="Last name"><Input value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} /></Field>
        <Field label="Phone"><Input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Birthday"><Input type="date" value={f.birthday} onChange={(e) => setF({ ...f, birthday: e.target.value })} /></Field>
      </div>
    </Sheet>
  )
}
