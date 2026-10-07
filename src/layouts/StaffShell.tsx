import { useEffect, useState, type ComponentType } from 'react'
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router'
import {
  BarChart3, Bell, Contact, CalendarDays, ChevronsUpDown, ClipboardList, CreditCard, DoorOpen, Gauge, Home, Landmark, ListOrdered, LogOut,
  Megaphone, Menu, Monitor, Moon, Package, QrCode, Search, Settings, ShieldCheck, Sparkles, Sun, Tags, Timer, User, Users, Wallet, X, Clock,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { BarberChairIcon } from '@/components/BarberChair'
import { useAuth, useWorkspace, useWorkspaces, WorkspaceProvider } from '@/lib/auth'
import { isConfigured, rpc, supabase } from '@/lib/supabase'
import { Avatar, cx, IconButton, KeyHint, Logo } from '@/components/ui'
import { PageSpinner } from '@/router'
import { CommandPalette } from '@/components/CommandPalette'
import { SetupNotice } from '@/components/SetupNotice'
import type { Permission } from '@/lib/types'
import { getThemePref, setThemePref, type ThemePref } from '@/lib/theme'
import { useRealtimeShop } from '@/lib/api'

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
  perm?: Permission
  feature?: string
  barber?: boolean // only for people with a chair
  notPerm?: Permission // hide when the user has this permission
  end?: boolean
}

// SHOP → CHAIRS → BARBERS → CUSTOMERS → APPOINTMENTS → PAYMENTS → ANALYTICS
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Operations',
    items: [
      { to: '/app/dashboard', label: 'Overview', icon: Gauge, perm: 'reports.shop' },
      { to: '/app/today', label: 'Today', icon: Timer, barber: true },
      { to: '/app/chairs', label: 'Chairs', icon: BarberChairIcon },
      { to: '/app/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/app/appointments', label: 'Appointments', icon: ClipboardList, perm: 'calendar.all' },
      { to: '/app/walk-ins', label: 'Walk-in queue', icon: DoorOpen, feature: 'walk_ins' },
      { to: '/app/waitlist', label: 'Waitlist', icon: ListOrdered, perm: 'waitlist.manage', feature: 'waitlist' },
    ],
  },
  {
    group: 'People',
    items: [
      { to: '/app/barbers', label: 'Barbers', icon: Contact, perm: 'staff.manage' },
      { to: '/app/clients', label: 'Customers', icon: Users },
      { to: '/app/services', label: 'Services & prices', icon: Tags, perm: 'services.manage' },
    ],
  },
  {
    group: 'Money',
    items: [
      { to: '/app/finance', label: 'Finance', icon: Landmark, perm: 'finance.manage' },
      { to: '/app/finance', label: 'My money', icon: Wallet, barber: true, notPerm: 'finance.manage' },
      { to: '/app/inventory', label: 'Inventory', icon: Package },
      { to: '/app/payments', label: 'Payments', icon: CreditCard, perm: 'payments.view' },
    ],
  },
  {
    group: 'Grow',
    items: [
      { to: '/app/reports', label: 'Analytics', icon: BarChart3, perm: 'reports.shop' },
      { to: '/app/insights', label: 'Insights & AI', icon: Sparkles, perm: 'reports.shop' },
      { to: '/app/marketing', label: 'Marketing', icon: Megaphone, perm: 'marketing.manage' },
      { to: '/app/share', label: 'Booking page & QR', icon: QrCode },
    ],
  },
  {
    group: 'Me & shop',
    items: [
      { to: '/app/schedule', label: 'My schedule', icon: Clock, barber: true },
      { to: '/app/my-services', label: 'My services', icon: Tags, barber: true },
      { to: '/app/settings', label: 'Settings', icon: Settings, perm: 'shop.settings' },
      { to: '/app/audit', label: 'Audit log', icon: ShieldCheck, perm: 'audit.view' },
    ],
  },
]

export default function StaffShell() {
  const { user, loading } = useAuth()
  const { data: workspaces, isLoading } = useWorkspaces()
  const loc = useLocation()
  if (!isConfigured) return <SetupNotice />
  if (loading || (user && isLoading)) return <PageSpinner />
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  if (!workspaces?.length) return <Navigate to="/onboarding" replace />
  return (
    <WorkspaceProvider workspaces={workspaces}>
      <Shell />
    </WorkspaceProvider>
  )
}

function useNavItems() {
  const { ws, can, hasFeature } = useWorkspace()
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => (!i.perm || can(i.perm)) && (!i.notPerm || !can(i.notPerm)) && (!i.feature || hasFeature(i.feature)) && (!i.barber || !!ws.barber_id)),
  })).filter((g) => g.items.length)
}

function Shell() {
  const { ws, isBarberOnly } = useWorkspace()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const loc = useLocation()
  useRealtimeShop(ws.shop_id)

  useEffect(() => setDrawer(false), [loc.pathname])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar (hidden for barber-only on mobile-first experience but available on desktop) */}
      <aside className="no-print sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <SidebarContent onSearch={() => setPaletteOpen(true)} />
      </aside>

      {/* Mobile top bar */}
      <header className="no-print sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-bg/85 px-3 backdrop-blur-md lg:hidden">
        <button className="flex items-center gap-2" onClick={() => setDrawer(true)} aria-label="Open menu">
          <Menu className="size-5 text-muted" />
          <Logo mark />
          <span className="max-w-[140px] truncate text-sm font-semibold">{ws.shop_name}</span>
        </button>
        <div className="flex items-center gap-1">
          <IconButton label="Search" onClick={() => setPaletteOpen(true)}>
            <Search className="size-5" />
          </IconButton>
          <NotificationsBell />
        </div>
      </header>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="animate-fade absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <div className="animate-rise absolute inset-y-0 left-0 flex w-72 flex-col bg-surface shadow-2xl">
            <div className="flex justify-end p-2">
              <IconButton label="Close menu" onClick={() => setDrawer(false)}>
                <X className="size-5" />
              </IconButton>
            </div>
            <SidebarContent onSearch={() => setPaletteOpen(true)} />
          </div>
        </div>
      )}

      <main className={cx('min-w-0 flex-1 px-4 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-12 lg:pt-8')}>
        <div className="mx-auto max-w-[1400px]">
          <Outlet />
        </div>
      </main>

      <BottomNav barber={isBarberOnly || !!ws.barber_id} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}

function SidebarContent({ onSearch }: { onSearch: () => void }) {
  const groups = useNavItems()
  const { ws, all, switchTo } = useWorkspace()
  const { user, signOut } = useAuth()
  const { data: isSystemOwner } = useQuery({ queryKey: ['am_platform_admin', user?.id], enabled: !!user, staleTime: 5 * 60_000, queryFn: () => rpc<boolean>('am_platform_admin') })
  const [switcher, setSwitcher] = useState(false)
  const [theme, setTheme] = useState<ThemePref>(getThemePref())
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-5">
        <Link to="/app" className="mb-5 flex items-center">
          <Logo />
        </Link>
        <div className="relative">
          <button
            onClick={() => setSwitcher((s) => !s)}
            className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface-2/60 px-3 py-2.5 text-left transition hover:bg-surface-2"
          >
            <span className="flex size-8 items-center justify-center rounded-lg text-sm font-bold" style={{ background: ws.accent_color, color: '#fff' }}>
              {ws.shop_name[0]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{ws.shop_name}</span>
              <span className="block text-xs capitalize text-muted">{ws.role}</span>
            </span>
            <ChevronsUpDown className="size-4 text-muted" />
          </button>
          {switcher && (
            <div className="animate-rise absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
              {all.map((w) => (
                <button
                  key={w.shop_id}
                  onClick={() => {
                    switchTo(w.shop_id)
                    setSwitcher(false)
                  }}
                  className={cx('flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-surface-2', w.shop_id === ws.shop_id && 'font-semibold')}
                >
                  <span className="size-2 rounded-full" style={{ background: w.accent_color }} />
                  <span className="flex-1 truncate">{w.shop_name}</span>
                  <span className="text-xs capitalize text-muted">{w.role}</span>
                </button>
              ))}
              {ws.role === 'owner' && (
                <Link to="/onboarding?location=1" className="block border-t border-line px-3 py-2.5 text-sm text-muted hover:bg-surface-2">
                  + Add location
                </Link>
              )}
            </div>
          )}
        </div>
        <button onClick={onSearch} className="mt-3 flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm text-muted transition hover:text-ink">
          <Search className="size-4" />
          <span className="flex-1 text-left">Search</span>
          <KeyHint>⌘K</KeyHint>
        </button>
      </div>

      <nav className="mt-4 flex-1 overflow-y-auto px-3 pb-4">
        <NavLink to="/app" end className={({ isActive }) => navCls(isActive)}>
          <Home className="size-[18px]" /> Home
        </NavLink>
        {groups.map((g) => (
          <div key={g.group} className="mt-5">
            <div className="eyebrow mb-1.5 px-3 text-[10px]">{g.group}</div>
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} className={({ isActive }) => navCls(isActive)}>
                <i.icon className="size-[18px]" /> {i.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-line p-3">
        {isSystemOwner && (
          <Link to="/admin" className="mb-2 flex items-center gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm font-semibold text-warning hover:bg-warning/15">
            <ShieldCheck className="size-4" /> System owner console
          </Link>
        )}
        <div className="mb-2 flex items-center justify-between px-1">
          <div className="flex rounded-lg bg-surface-2 p-0.5">
            {(['light', 'system', 'dark'] as ThemePref[]).map((t) => {
              const Icon = t === 'light' ? Sun : t === 'dark' ? Moon : Monitor
              return (
                <button key={t} aria-label={`${t} theme`} onClick={() => { setThemePref(t); setTheme(t) }}
                  className={cx('rounded-md p-1.5', theme === t ? 'bg-surface text-ink shadow-sm' : 'text-muted')}>
                  <Icon className="size-3.5" />
                </button>
              )
            })}
          </div>
          <span className="hidden lg:block"><NotificationsBell /></span>
        </div>
        <div className="flex items-center gap-2.5 rounded-xl px-2 py-2">
          <Avatar name={user?.user_metadata?.full_name ?? user?.email} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user?.user_metadata?.full_name ?? 'Account'}</div>
            <div className="truncate text-xs text-muted">{user?.email}</div>
          </div>
          {ws.barber_id && (
            <Link to="/app/profile" aria-label="My profile" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink">
              <User className="size-4" />
            </Link>
          )}
          <button onClick={signOut} aria-label="Sign out" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

const navCls = (active: boolean) =>
  cx(
    'flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] font-medium transition',
    active ? 'bg-accent-soft text-ink [&>svg]:text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink',
  )

function NotificationsBell() {
  const { ws } = useWorkspace()
  const { data } = useQuery({
    queryKey: ['owner_actions', ws.shop_id, 'unread'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('channel', 'in_app')
        .is('read_at', null)
        .eq('shop_id', ws.shop_id)
      return count ?? 0
    },
  })
  return (
    <Link to="/app/notifications" aria-label="Notifications" className="relative inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink">
      <Bell className="size-5" />
      {!!data && <span className="absolute right-1.5 top-1.5 flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-ink">{data > 9 ? '9+' : data}</span>}
    </Link>
  )
}

function BottomNav({ barber }: { barber: boolean }) {
  const { can, hasFeature } = useWorkspace()
  // Barber: Today · Queue · Schedule · Customers · Earnings
  // Owner:  Overview · Appointments · Chairs · Customers · Finance
  const items: NavItem[] = barber && !can('reports.shop')
    ? [
        { to: '/app/today', label: 'Today', icon: Timer },
        ...(hasFeature('walk_ins') ? [{ to: '/app/walk-ins', label: 'Queue', icon: DoorOpen }] : []),
        { to: '/app/calendar', label: 'Schedule', icon: CalendarDays },
        { to: '/app/clients', label: 'Customers', icon: Users },
        { to: '/app/finance', label: 'Earnings', icon: Wallet },
      ]
    : [
        { to: '/app', label: 'Overview', icon: Home, end: true },
        { to: '/app/calendar', label: 'Appointments', icon: CalendarDays },
        { to: '/app/chairs', label: 'Chairs', icon: BarberChairIcon },
        { to: '/app/clients', label: 'Customers', icon: Users },
        ...(can('finance.manage') ? [{ to: '/app/finance', label: 'Finance', icon: Landmark }] : can('reports.shop') ? [{ to: '/app/reports', label: 'Analytics', icon: BarChart3 }] : [{ to: '/app/payments', label: 'Payments', icon: CreditCard }]),
      ]
  return (
    <nav className="no-print safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/92 backdrop-blur-md lg:hidden">
      <div className="mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end}
            className={({ isActive }) => cx('flex flex-col items-center gap-1 pb-2 pt-2.5 text-[10.5px] font-semibold tracking-wide', isActive ? 'text-accent' : 'text-muted')}>
            <i.icon className="size-[22px]" />
            {i.label.toUpperCase()}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
