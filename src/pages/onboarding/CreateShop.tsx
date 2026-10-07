import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Plus, Trash2 } from 'lucide-react'
import { rpc, supabase, isConfigured } from '@/lib/supabase'
import { useAuth, useWorkspaces } from '@/lib/auth'
import { Button, Card, cx, Field, Input, Logo, Select, Toggle } from '@/components/ui'
import { HoursEditor, validHours, type HoursRow } from '@/components/HoursEditor'
import { friendlyError } from '@/lib/errors'
import { money, parseMoney } from '@/lib/format'
import { app_slug } from './slug'
import { PageSpinner } from '@/router'
import { SetupNotice } from '@/components/SetupNotice'

const STEPS = ['Your shop', 'Services', 'Hours', 'Go live']

const DEFAULT_SERVICES = [
  { name: 'Haircut', price: '30', duration: 45 },
  { name: 'Haircut + Beard', price: '45', duration: 60 },
  { name: 'Beard trim', price: '20', duration: 30 },
  { name: 'Kids cut', price: '25', duration: 30 },
]

const DEFAULT_HOURS: HoursRow[] = [2, 3, 4, 5, 6].map((d) => ({ weekday: d, starts_at: '09:00', ends_at: '19:00', kind: 'work' }))

export default function CreateShop() {
  const { user, loading } = useAuth()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { data: workspaces } = useWorkspaces()
  const addingLocation = params.get('location') === '1'
  const orgId = addingLocation ? workspaces?.find((w) => w.role === 'owner')?.organization_id ?? null : null

  const [step, setStep] = useState(0)
  const [shopId, setShopId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // step 1
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York')
  const [ownerCuts, setOwnerCuts] = useState(true)
  const [displayName, setDisplayName] = useState('')
  const [plan, setPlan] = useState('shop')
  // step 2
  const [services, setServices] = useState(DEFAULT_SERVICES)
  // step 3
  const [hours, setHours] = useState<HoursRow[]>(DEFAULT_HOURS)
  // step 4
  const [address, setAddress] = useState({ line1: '', city: '', region: '', phone: '', instagram: '' })

  useEffect(() => {
    if (!slugTouched) setSlug(app_slug(name))
  }, [name, slugTouched])
  useEffect(() => {
    if (user && !displayName) setDisplayName(user.user_metadata?.full_name ?? '')
  }, [user, displayName])

  const { data: slugOk } = useQuery({
    queryKey: ['slug', slug],
    enabled: slug.length >= 3,
    queryFn: () => rpc<boolean>('check_slug_available', { p_slug: slug }),
  })
  const { data: plans } = useQuery({
    queryKey: ['plans'],
    queryFn: async () => (await supabase.from('subscription_plans').select('*').order('sort_order')).data ?? [],
  })
  const timezones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone')
    } catch {
      return [tz]
    }
  }, [tz])

  if (!isConfigured) return <SetupNotice />
  if (loading) return <PageSpinner />
  if (!user) return <Navigate to="/signup?intent=owner" replace />

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const createShop = () =>
    run(async () => {
      const id = await rpc<string>('create_shop', {
        p_shop_name: name.trim(),
        p_slug: slug,
        p_timezone: tz,
        p_owner_is_barber: ownerCuts,
        p_owner_display_name: displayName || null,
        p_plan_code: plan,
        p_organization_id: orgId,
      })
      setShopId(id)
      await qc.invalidateQueries({ queryKey: ['workspaces'] })
      setStep(1)
    })

  const saveServices = () =>
    run(async () => {
      const rows = services
        .filter((s) => s.name.trim())
        .map((s, i) => ({ shop_id: shopId, name: s.name.trim(), price_cents: parseMoney(s.price) ?? 0, duration_minutes: s.duration, sort_order: i }))
      if (!rows.length) throw new Error('Add at least one service')
      const { data, error } = await supabase.from('services').insert(rows).select('id')
      if (error) throw error
      const { data: barbers } = await supabase.from('barbers').select('id').eq('shop_id', shopId!)
      for (const b of barbers ?? []) await rpc('set_barber_services', { p_barber_id: b.id, p_service_ids: data!.map((d) => d.id) })
      setStep(2)
    })

  const saveHours = () =>
    run(async () => {
      if (!validHours(hours)) throw new Error('Check your hours — an end time is before its start')
      await supabase.from('business_hours').delete().eq('shop_id', shopId!)
      const work = hours.filter((h) => (h.kind ?? 'work') === 'work')
      const { error } = await supabase.from('business_hours').insert(work.map((h) => ({ shop_id: shopId, weekday: h.weekday, opens_at: h.starts_at, closes_at: h.ends_at })))
      if (error) throw error
      const { data: barbers } = await supabase.from('barbers').select('id').eq('shop_id', shopId!)
      for (const b of barbers ?? []) await rpc('set_weekly_schedule', { p_barber_id: b.id, p_rows: hours })
      setStep(3)
    })

  const publish = (live: boolean) =>
    run(async () => {
      const { error } = await supabase
        .from('shops')
        .update({ address_line1: address.line1 || null, city: address.city || null, region: address.region || null, phone: address.phone || null, instagram: address.instagram || null, is_published: live })
        .eq('id', shopId!)
      if (error) throw error
      await qc.invalidateQueries({ queryKey: ['workspaces'] })
      try {
        localStorage.setItem('autocoti.workspace', shopId!)
      } catch {
        /* ignore */
      }
      nav('/app', { replace: true })
    })

  return (
    <div className="min-h-dvh">
      <header className="flex h-16 items-center justify-between px-6">
        <Logo />
        <span className="text-sm text-muted">{user.email}</span>
      </header>
      <div className="mx-auto max-w-2xl px-5 pb-20 pt-6">
        <ol className="mb-10 flex items-center gap-2">
          {STEPS.map((s, i) => (
            <li key={s} className="flex flex-1 items-center gap-2">
              <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold', i < step ? 'bg-accent text-accent-ink' : i === step ? 'border-2 border-accent text-ink' : 'bg-surface-2 text-muted')}>
                {i < step ? <Check className="size-4" /> : i + 1}
              </span>
              <span className={cx('hidden text-sm sm:block', i === step ? 'font-semibold' : 'text-muted')}>{s}</span>
              {i < STEPS.length - 1 && <span className="h-px flex-1 bg-line" />}
            </li>
          ))}
        </ol>

        {error && <p className="mb-5 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">{error}</p>}

        {step === 0 && (
          <div className="animate-rise">
            <h1 className="display text-5xl">{addingLocation ? 'Add a location.' : "Let's open your shop."}</h1>
            <p className="mt-3 text-muted">Takes about two minutes. You can change everything later.</p>
            <Card className="mt-8 space-y-5 p-6">
              <Field label="Shop name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fade Factory" autoFocus />
              </Field>
              <Field
                label="Booking link"
                error={slug.length >= 3 && slugOk === false ? 'That link is taken or reserved' : undefined}
                hint={slug.length >= 3 && slugOk ? 'Available ✓' : 'Lowercase letters, numbers and dashes'}
              >
                <div className="flex items-center rounded-xl border border-line bg-surface focus-within:border-accent">
                  <span className="pl-3.5 text-[15px] text-muted">{window.location.host}/s/</span>
                  <input className="h-11 flex-1 bg-transparent pr-3 text-[15px] outline-none" value={slug}
                    onChange={(e) => { setSlugTouched(true); setSlug(app_slug(e.target.value)) }} />
                </div>
              </Field>
              <Field label="Timezone">
                <Select value={tz} onChange={(e) => setTz(e.target.value)}>
                  {timezones.map((t) => <option key={t}>{t}</option>)}
                </Select>
              </Field>
              <Toggle checked={ownerCuts} onChange={setOwnerCuts} label="I cut hair here too" description="You'll get your own chair, calendar and earnings." />
              {ownerCuts && (
                <Field label="Your barber name">
                  <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Carlos" />
                </Field>
              )}
              {!addingLocation && (
                <div>
                  <div className="mb-2 text-[13px] font-medium">Plan <span className="font-normal text-muted">· 14-day free trial</span></div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(plans ?? []).map((p: any) => (
                      <button key={p.code} type="button" onClick={() => setPlan(p.code)}
                        className={cx('rounded-xl border p-3 text-left transition', plan === p.code ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}>
                        <div className="text-sm font-semibold">{p.name}</div>
                        <div className="text-xs text-muted">{money(p.price_cents, { currency: p.currency })}/mo</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Card>
            <Button size="xl" block className="mt-6" loading={busy} disabled={!name.trim() || slug.length < 3 || slugOk === false} onClick={createShop}>
              Continue
            </Button>
          </div>
        )}

        {step === 1 && (
          <div className="animate-rise">
            <h1 className="display text-5xl">What do you offer?</h1>
            <p className="mt-3 text-muted">Price and length per service. Barbers can have their own prices later.</p>
            <Card className="mt-8 divide-y divide-line">
              {services.map((s, i) => (
                <div key={i} className="grid grid-cols-[1fr_90px_100px_36px] items-center gap-2 p-3">
                  <Input aria-label="Service name" value={s.name} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <Input aria-label="Price" inputMode="decimal" leading="$" value={s.price} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                  <Select aria-label="Duration" value={s.duration} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, duration: Number(e.target.value) } : x)))}>
                    {[15, 20, 25, 30, 35, 40, 45, 50, 60, 75, 90, 120].map((m) => <option key={m} value={m}>{m} min</option>)}
                  </Select>
                  <button aria-label="Remove" className="text-muted hover:text-danger" onClick={() => setServices(services.filter((_, j) => j !== i))}>
                    <Trash2 className="mx-auto size-4" />
                  </button>
                </div>
              ))}
              <button className="flex w-full items-center gap-2 p-4 text-sm font-medium text-muted hover:text-ink" onClick={() => setServices([...services, { name: '', price: '', duration: 30 }])}>
                <Plus className="size-4" /> Add service
              </button>
            </Card>
            <Button size="xl" block className="mt-6" loading={busy} onClick={saveServices}>Continue</Button>
          </div>
        )}

        {step === 2 && (
          <div className="animate-rise">
            <h1 className="display text-5xl">When are you open?</h1>
            <p className="mt-3 text-muted">These become your shop hours and your starting schedule. Breaks are never bookable.</p>
            <Card className="mt-8 px-5">
              <HoursEditor value={hours} onChange={setHours} />
            </Card>
            <Button size="xl" block className="mt-6" loading={busy} onClick={saveHours}>Continue</Button>
          </div>
        )}

        {step === 3 && (
          <div className="animate-rise">
            <h1 className="display text-5xl">Where can clients find you?</h1>
            <p className="mt-3 text-muted">Shown on your booking page.</p>
            <Card className="mt-8 grid gap-4 p-6 sm:grid-cols-2">
              <Field label="Street address" className="sm:col-span-2"><Input value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} /></Field>
              <Field label="City"><Input value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} /></Field>
              <Field label="State / region"><Input value={address.region} onChange={(e) => setAddress({ ...address, region: e.target.value })} /></Field>
              <Field label="Phone"><Input type="tel" value={address.phone} onChange={(e) => setAddress({ ...address, phone: e.target.value })} /></Field>
              <Field label="Instagram"><Input value={address.instagram} placeholder="@yourshop" onChange={(e) => setAddress({ ...address, instagram: e.target.value })} /></Field>
            </Card>
            <div className="mt-6 grid gap-2">
              <Button size="xl" block loading={busy} onClick={() => publish(true)}>Publish & open dashboard</Button>
              <Button variant="ghost" block disabled={busy} onClick={() => publish(false)}>Not yet — keep it private</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
