import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CalendarPlus, Lock, Mail, MessageSquare, Phone, Pin, Trash2, Users } from 'lucide-react'
import { useWorkspace } from '@/lib/auth'
import { rpc, supabase } from '@/lib/supabase'
import { useBarbers, useServices } from '@/lib/api'
import type { ClientRow } from '@/lib/types'
import { ago, dateLabel, minutes, money, time } from '@/lib/format'
import { friendlyError } from '@/lib/errors'
import { HEALTH_LABEL, HEALTH_TONE } from './Clients'
import { NewAppointmentSheet } from '@/components/appointments'
import { Avatar, Badge, Button, Card, CardHeader, cx, EmptyState, Field, Input, Segmented, Select, Sheet, Skeleton, StatusBadge, Textarea, Toggle, useToast } from '@/components/ui'

interface Profile {
  client: { id: string; first_name: string; last_name: string | null; phone: string | null; email: string | null; birthday: string | null; tags: string[]; source: string; referral_code: string; marketing_email_opt_in: boolean; marketing_sms_opt_in: boolean; created_at: string; user_id: string | null }
  stats: { visits: number; last_visit: string | null; next_appointment: string | null; avg_gap_days: number | null; cadence_days: number; days_since_last: number | null; total_spent_cents: number | null; avg_ticket_cents: number | null; no_shows: number; cancellations: number; late_cancellations: number; health: keyof typeof HEALTH_TONE; is_due: boolean; favorite_service: string | null; favorite_barber: string | null; loyalty_points: number }
  preferences: { preferred_barber_id: string | null; preferred_service_id: string | null; rebook_interval_days: number | null; preferred_contact: string | null; preferences: Record<string, string> } | null
  appointments: { id: string; starts_at: string; status: string; barber_name: string; services: string; price_cents: number | null; payment_status: string; actual_duration_seconds: number | null; notes: string | null }[]
  notes: { id: string; body: string; visibility: 'team' | 'private'; is_pinned: boolean; created_at: string; author_name: string | null; barber_name: string | null; mine: boolean }[]
  memberships: { plan: string; status: string; visits_used: number; included_visits: number | null; period_end: string }[]
}

export default function ClientDetail() {
  const { id } = useParams()
  const { ws, can } = useWorkspace()
  const qc = useQueryClient()
  const toast = useToast()
  const [booking, setBooking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [merging, setMerging] = useState(false)
  const { data: p, isLoading, error } = useQuery({ queryKey: ['client', id], queryFn: () => rpc<Profile>('get_client_profile', { p_client_id: id }) })
  if (isLoading) return <Skeleton className="h-96" />
  if (error || !p) return <EmptyState title="Client not available" body={friendlyError(error)} />
  const c = p.client
  const s = p.stats
  const name = `${c.first_name} ${c.last_name ?? ''}`.trim()
  const refresh = () => qc.invalidateQueries({ queryKey: ['client', id] })

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/app/clients" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Clients</Link>
      <div className="mb-6 mt-4 flex flex-wrap items-center gap-4">
        <Avatar name={name} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="display text-[40px] leading-none">{name}</h1>
            <Badge tone={HEALTH_TONE[s.health]}>{HEALTH_LABEL[s.health]}</Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
            {c.phone && <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 hover:text-ink"><Phone className="size-3.5" />{c.phone}</a>}
            {c.email && <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 hover:text-ink"><Mail className="size-3.5" />{c.email}</a>}
            <span>Client since {dateLabel(c.created_at, ws.timezone, { month: 'short', year: 'numeric' })}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.phone && <a href={`sms:${c.phone}`}><Button variant="secondary" icon={<MessageSquare className="size-4" />}>Text</Button></a>}
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
          <Button icon={<CalendarPlus className="size-4" />} onClick={() => setBooking(true)}>Book</Button>
        </div>
      </div>

      {s.is_due && !s.next_appointment && s.visits > 0 && (
        <Card className="mb-4 border-warning/40 p-4 text-sm">
          <b>{c.first_name} may be due for a haircut.</b> <span className="text-muted">It's been {s.days_since_last} days; they usually come every {s.cadence_days} days.</span>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Visits" value={s.visits} sub={s.last_visit ? `last ${ago(s.last_visit)}` : 'none yet'} />
            <StatCard label="Total spent" value={money(s.total_spent_cents, { cents: false })} sub={s.avg_ticket_cents ? `avg ${money(s.avg_ticket_cents)}` : undefined} />
            <StatCard label="Rhythm" value={s.avg_gap_days ? `${Math.round(s.avg_gap_days)}d` : '—'} sub={`expected every ${s.cadence_days}d`} />
            <StatCard label="No-shows" value={s.no_shows} sub={`${s.cancellations} cancelled`} warn={s.no_shows > 0} />
          </div>
          <Notes clientId={c.id} notes={p.notes} onChange={refresh} />
          <Card>
            <CardHeader title="Visit history" />
            {p.appointments.length === 0 ? <EmptyState title="No visits yet" /> : (
              <div className="mt-3 divide-y divide-line">
                {p.appointments.map((a) => (
                  <Link key={a.id} to={`/app/appointments/${a.id}`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-surface-2">
                    <div className="w-28 shrink-0"><div className="font-medium">{dateLabel(a.starts_at, ws.timezone, { month: 'short', day: 'numeric', year: '2-digit' })}</div><div className="text-xs text-muted">{time(a.starts_at, ws.timezone)}</div></div>
                    <div className="min-w-0 flex-1"><div className="truncate">{a.services}</div><div className="text-xs text-muted">with {a.barber_name}{a.actual_duration_seconds ? ` · ${minutes(a.actual_duration_seconds / 60)}` : ''}</div></div>
                    <StatusBadge status={a.status} />
                    <div className="w-16 text-right tnum">{a.price_cents !== null ? money(a.price_cents, { cents: false }) : ''}</div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card className="p-5 text-sm">
            <div className="mb-3 font-semibold">Favorites</div>
            <dl className="space-y-2">
              <div className="flex justify-between"><dt className="text-muted">Barber</dt><dd>{s.favorite_barber ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Service</dt><dd>{s.favorite_service ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Loyalty points</dt><dd className="tnum">{s.loyalty_points}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Referral code</dt><dd className="font-mono">{c.referral_code}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Account</dt><dd>{c.user_id ? 'Linked' : 'Guest'}</dd></div>
            </dl>
          </Card>
          <Preferences clientId={c.id} prefs={p.preferences} onChange={refresh} />
          {p.memberships.length > 0 && (
            <Card className="p-5 text-sm">
              <div className="mb-2 font-semibold">Memberships</div>
              {p.memberships.map((m, i) => <div key={i} className="flex justify-between"><span>{m.plan}</span><span className="text-muted">{m.status} · {m.visits_used}/{m.included_visits ?? '∞'}</span></div>)}
            </Card>
          )}
          {can('clients.all') && <Button variant="ghost" icon={<Users className="size-4" />} onClick={() => setMerging(true)}>Merge duplicate…</Button>}
        </div>
      </div>
      <NewAppointmentSheet open={booking} onClose={() => { setBooking(false); refresh() }} defaults={{}} />
      {editing && <EditClient client={c} onClose={() => { setEditing(false); refresh() }} />}
      {merging && <MergeSheet keepId={c.id} onClose={() => { setMerging(false); refresh(); toast('Merged', 'success') }} />}
    </div>
  )
}

function StatCard({ label, value, sub, warn }: { label: string; value: React.ReactNode; sub?: string; warn?: boolean }) {
  return (
    <Card className="p-4">
      <div className="eyebrow">{label}</div>
      <div className={cx('mt-1.5 text-xl font-semibold tnum', warn && 'text-danger')}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </Card>
  )
}

function Notes({ clientId, notes, onChange }: { clientId: string; notes: Profile['notes']; onChange: () => void }) {
  const { ws } = useWorkspace()
  const toast = useToast()
  const [body, setBody] = useState('')
  const [visibility, setVisibility] = useState<'team' | 'private'>('team')
  const add = async () => {
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('client_notes').insert({ shop_id: ws.shop_id, client_id: clientId, author_id: u.user!.id, barber_id: ws.barber_id, body, visibility })
    if (error) return toast(friendlyError(error), 'error')
    setBody('')
    onChange()
  }
  const update = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await supabase.from('client_notes').update(patch).eq('id', id)
    if (error) toast(friendlyError(error), 'error')
    onChange()
  }
  return (
    <Card>
      <CardHeader title="Cut notes" subtitle="e.g. “Low fade, #2 on top, beard shaped naturally.”" />
      <div className="space-y-2 p-5">
        {notes.map((n) => (
          <div key={n.id} className={cx('group rounded-xl border p-3 text-sm', n.is_pinned ? 'border-accent bg-accent-soft' : 'border-line')}>
            <p className="whitespace-pre-line">{n.body}</p>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted">
              {n.visibility === 'private' && <Lock className="size-3" />}
              <span>{n.author_name ?? 'Staff'} · {ago(n.created_at)}</span>
              {n.mine && (
                <span className="ml-auto flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <button aria-label="Pin" onClick={() => update(n.id, { is_pinned: !n.is_pinned })} className="rounded p-1 hover:bg-surface-2"><Pin className="size-3.5" /></button>
                  <button aria-label="Delete" onClick={() => update(n.id, { deleted_at: new Date().toISOString() })} className="rounded p-1 hover:bg-surface-2 hover:text-danger"><Trash2 className="size-3.5" /></button>
                </span>
              )}
            </div>
          </div>
        ))}
        <Textarea rows={2} placeholder="Add a note…" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex items-center justify-between">
          <Segmented size="sm" value={visibility} onChange={setVisibility} options={[{ value: 'team', label: 'Team' }, { value: 'private', label: 'Only me & owner' }]} />
          <Button size="sm" disabled={!body.trim()} onClick={add}>Save note</Button>
        </div>
      </div>
    </Card>
  )
}

function Preferences({ clientId, prefs, onChange }: { clientId: string; prefs: Profile['preferences']; onChange: () => void }) {
  const { ws } = useWorkspace()
  const toast = useToast()
  const { data: barbers } = useBarbers(ws.shop_id)
  const { data: services } = useServices(ws.shop_id)
  const [f, setF] = useState({ barber: '', service: '', interval: '', contact: '', drink: '' })
  useEffect(() => {
    setF({ barber: prefs?.preferred_barber_id ?? '', service: prefs?.preferred_service_id ?? '', interval: prefs?.rebook_interval_days?.toString() ?? '', contact: prefs?.preferred_contact ?? '', drink: prefs?.preferences?.drink ?? '' })
  }, [prefs])
  const save = async () => {
    const { error } = await supabase.from('client_preferences').upsert({
      client_id: clientId, preferred_barber_id: f.barber || null, preferred_service_id: f.service || null,
      rebook_interval_days: f.interval ? Number(f.interval) : null, preferred_contact: f.contact || null, preferences: { ...(prefs?.preferences ?? {}), drink: f.drink },
    })
    if (error) toast(friendlyError(error), 'error')
    else { toast('Preferences saved', 'success'); onChange() }
  }
  return (
    <Card className="p-5">
      <div className="mb-3 font-semibold">Preferences</div>
      <div className="space-y-3">
        <Field label="Preferred barber"><Select value={f.barber} onChange={(e) => setF({ ...f, barber: e.target.value })}><option value="">No preference</option>{barbers?.map((b) => <option key={b.id} value={b.id}>{b.display_name}</option>)}</Select></Field>
        <Field label="Usual service"><Select value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}><option value="">—</option>{services?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Comes every (days)" hint="Overrides the computed rhythm for reminders"><Input type="number" min={3} max={365} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })} /></Field>
        <Field label="Contact via"><Select value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })}><option value="">Any</option><option value="sms">SMS</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option></Select></Field>
        <Field label="Likes"><Input placeholder="e.g. espresso, quiet cut" value={f.drink} onChange={(e) => setF({ ...f, drink: e.target.value })} /></Field>
        <Button size="sm" variant="secondary" onClick={save}>Save</Button>
      </div>
    </Card>
  )
}

function EditClient({ client, onClose }: { client: Profile['client']; onClose: () => void }) {
  const toast = useToast()
  const nav = useNavigate()
  const { can } = useWorkspace()
  const [f, setF] = useState({ first_name: client.first_name, last_name: client.last_name ?? '', phone: client.phone ?? '', email: client.email ?? '', birthday: client.birthday ?? '', tags: client.tags.join(', '), email_opt: client.marketing_email_opt_in, sms_opt: client.marketing_sms_opt_in })
  const save = async () => {
    const { error } = await supabase.from('clients').update({
      first_name: f.first_name, last_name: f.last_name || null, phone: f.phone || null, email: f.email || null, birthday: f.birthday || null,
      tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), marketing_email_opt_in: f.email_opt, marketing_sms_opt_in: f.sms_opt,
    }).eq('id', client.id)
    if (error) return toast(error.code === '23505' ? 'Another client already uses that phone or email — merge them instead' : friendlyError(error), 'error')
    onClose()
  }
  const remove = async () => {
    if (!confirm('Delete this client? Their visit history stays in reports.')) return
    const { error } = await supabase.from('clients').update({ deleted_at: new Date().toISOString() }).eq('id', client.id)
    if (error) return toast(friendlyError(error), 'error')
    nav('/app/clients')
  }
  return (
    <Sheet open onClose={onClose} title="Edit client" footer={<div className="flex gap-2"><Button size="lg" className="flex-1" onClick={save}>Save</Button>{can('clients.all') && <Button size="lg" variant="danger" onClick={remove}>Delete</Button>}</div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name"><Input value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} /></Field>
        <Field label="Last name"><Input value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} /></Field>
        <Field label="Phone"><Input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Birthday"><Input type="date" value={f.birthday} onChange={(e) => setF({ ...f, birthday: e.target.value })} /></Field>
        <Field label="Tags"><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="vip, student" /></Field>
        <div className="space-y-3 sm:col-span-2">
          <Toggle checked={f.email_opt} onChange={(v) => setF({ ...f, email_opt: v })} label="Marketing emails" description="Only with the client's consent" />
          <Toggle checked={f.sms_opt} onChange={(v) => setF({ ...f, sms_opt: v })} label="Marketing SMS" />
        </div>
      </div>
    </Sheet>
  )
}

function MergeSheet({ keepId, onClose }: { keepId: string; onClose: () => void }) {
  const { ws } = useWorkspace()
  const toast = useToast()
  const [q, setQ] = useState('')
  const { data } = useQuery({ queryKey: ['merge-search', q], enabled: q.length >= 2, queryFn: () => rpc<ClientRow[]>('list_clients', { p_shop_id: ws.shop_id, p_search: q, p_limit: 8 }) })
  const merge = async (id: string) => {
    if (!confirm('Merge this client into the current one? Visits, payments and notes move over. This cannot be undone.')) return
    try {
      await rpc('merge_clients', { p_keep_id: keepId, p_merge_id: id })
      onClose()
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }
  return (
    <Sheet open onClose={onClose} title="Merge duplicate">
      <Input placeholder="Search the duplicate…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="mt-3 divide-y divide-line">
        {data?.filter((c) => c.id !== keepId).map((c) => (
          <div key={c.id} className="flex items-center gap-3 py-2.5">
            <div className="flex-1 text-sm"><div className="font-medium">{c.first_name} {c.last_name}</div><div className="text-xs text-muted">{c.phone ?? c.email} · {c.visits} visits</div></div>
            <Button size="sm" variant="secondary" onClick={() => merge(c.id)}>Merge</Button>
          </div>
        ))}
      </div>
    </Sheet>
  )
}
