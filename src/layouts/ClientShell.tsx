import { NavLink, Navigate, Outlet, useLocation } from 'react-router'
import { CalendarCheck, Home, Scissors, User } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { cx, Logo } from '@/components/ui'
import { PageSpinner } from '@/router'
import { isConfigured } from '@/lib/supabase'
import { SetupNotice } from '@/components/SetupNotice'

const ITEMS = [
  { to: '/me', label: 'Home', icon: Home, end: true },
  { to: '/me/book', label: 'Book', icon: Scissors },
  { to: '/me/appointments', label: 'Appointments', icon: CalendarCheck },
  { to: '/me/profile', label: 'Profile', icon: User },
]

export default function ClientShell() {
  const { user, loading } = useAuth()
  const loc = useLocation()
  if (!isConfigured) return <SetupNotice />
  if (loading) return <PageSpinner />
  if (!user) return <Navigate to={`/login?client=1&next=${encodeURIComponent(loc.pathname)}`} replace />
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-bg/85 px-4 backdrop-blur-md">
        <Logo />
      </header>
      <main className="mx-auto max-w-xl px-4 pb-28 pt-5">
        <Outlet />
      </main>
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/92 backdrop-blur-md">
        <div className="mx-auto grid max-w-xl grid-cols-4">
          {ITEMS.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end}
              className={({ isActive }) => cx('flex flex-col items-center gap-1 pb-2 pt-2.5 text-[10.5px] font-semibold tracking-wide', isActive ? 'text-accent' : 'text-muted')}>
              <i.icon className="size-[22px]" />
              {i.label.toUpperCase()}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
