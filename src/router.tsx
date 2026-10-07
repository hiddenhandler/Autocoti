import { lazy, Suspense, type ComponentType } from 'react'
import { createBrowserRouter, Navigate, Outlet, useLocation, useRouteError } from 'react-router'
import { Button, EmptyState, Spinner } from './components/ui'

function load(factory: () => Promise<{ default: ComponentType }>) {
  const C = lazy(factory)
  return (
    <Suspense fallback={<PageSpinner />}>
      <C />
    </Suspense>
  )
}

export function PageSpinner() {
  return (
    <div className="flex min-h-[50dvh] items-center justify-center">
      <Spinner />
    </div>
  )
}

/** Old short links (/s/:slug/...) keep working. */
function LegacyShopRedirect() {
  const loc = useLocation()
  return <Navigate to={loc.pathname.replace(/^\/s\//, '/shop/') + loc.search} replace />
}

function RouteError() {
  const err = useRouteError() as Error & { status?: number }
  if (err?.status === 404)
    return <EmptyState className="min-h-dvh" title="Page not found" body="That link doesn't go anywhere." action={<Button onClick={() => (window.location.href = '/')}>Go home</Button>} />
  return (
    <EmptyState
      className="min-h-dvh"
      title="Something broke"
      body={err?.message ?? 'Unexpected error'}
      action={<Button onClick={() => window.location.reload()}>Reload</Button>}
    />
  )
}

export const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    element: <Outlet />,
    children: [
      { path: '/', element: load(() => import('./pages/marketing/Landing')) },
      { path: '/login', element: load(() => import('./pages/auth/Login')) },
      { path: '/signup', element: load(() => import('./pages/auth/Login')) },
      { path: '/invite/:token', element: load(() => import('./pages/auth/AcceptInvite')) },
      { path: '/onboarding', element: load(() => import('./pages/onboarding/CreateShop')) },

      // Public: every shop's own branded page (never a marketplace)
      { path: '/shop/:slug', element: load(() => import('./pages/public/ShopPage')) },
      { path: '/shop/:slug/book', element: load(() => import('./pages/public/BookingFlow')) },
      { path: '/shop/:slug/queue', element: load(() => import('./pages/public/JoinQueue')) },
      { path: '/shop/:slug/barber/:barberSlug', element: load(() => import('./pages/public/BarberProfile')) },
      { path: '/s/*', element: <LegacyShopRedirect /> },
      { path: '/q/:token', element: load(() => import('./pages/public/QueueTicket')) },
      { path: '/a/:token', element: load(() => import('./pages/public/ManageBooking')) },
      { path: '/r/:token', element: load(() => import('./pages/public/Review')) },
      { path: '/w/:token', element: load(() => import('./pages/public/WaitlistClaim')) },

      // Client app
      {
        path: '/me',
        element: load(() => import('./layouts/ClientShell')),
        children: [
          { index: true, element: load(() => import('./pages/client/ClientHome')) },
          { path: 'shop', element: load(() => import('./pages/client/ClientShop')) },
          { path: 'book', element: load(() => import('./pages/client/ClientBook')) },
          { path: 'appointments', element: load(() => import('./pages/client/ClientAppointments')) },
          { path: 'profile', element: load(() => import('./pages/client/ClientProfile')) },
        ],
      },

      // Staff app (owner / manager / receptionist / barber)
      {
        path: '/app',
        element: load(() => import('./layouts/StaffShell')),
        children: [
          { index: true, element: load(() => import('./pages/staff/Home')) },
          { path: 'dashboard', element: load(() => import('./pages/staff/OwnerDashboard')) },
          { path: 'today', element: load(() => import('./pages/staff/BarberToday')) },
          { path: 'calendar', element: load(() => import('./pages/staff/Calendar')) },
          { path: 'appointments', element: load(() => import('./pages/staff/Appointments')) },
          { path: 'appointments/:id', element: load(() => import('./pages/staff/AppointmentDetail')) },
          { path: 'barbers', element: load(() => import('./pages/staff/Barbers')) },
          { path: 'barbers/:id', element: load(() => import('./pages/staff/BarberDetail')) },
          { path: 'clients', element: load(() => import('./pages/staff/Clients')) },
          { path: 'clients/:id', element: load(() => import('./pages/staff/ClientDetail')) },
          { path: 'services', element: load(() => import('./pages/staff/Services')) },
          { path: 'walk-ins', element: load(() => import('./pages/staff/WalkIns')) },
          { path: 'waitlist', element: load(() => import('./pages/staff/Waitlist')) },
          { path: 'payments', element: load(() => import('./pages/staff/Payments')) },
          { path: 'reports', element: load(() => import('./pages/staff/Reports')) },
          { path: 'insights', element: load(() => import('./pages/staff/Insights')) },
          { path: 'marketing', element: load(() => import('./pages/staff/Marketing')) },
          { path: 'settings', element: <Navigate to="/app/settings/shop" replace /> },
          { path: 'settings/:section', element: load(() => import('./pages/staff/Settings')) },
          { path: 'audit', element: load(() => import('./pages/staff/AuditLog')) },
          { path: 'earnings', element: load(() => import('./pages/staff/Earnings')) },
          { path: 'schedule', element: load(() => import('./pages/staff/MySchedule')) },
          { path: 'profile', element: load(() => import('./pages/staff/MyProfile')) },
          { path: 'notifications', element: load(() => import('./pages/staff/Notifications')) },
          { path: 'chairs', element: load(() => import('./pages/staff/Chairs')) },
          { path: 'inventory', element: load(() => import('./pages/staff/Inventory')) },
          { path: 'finance', element: load(() => import('./pages/staff/Finance')) },
          { path: 'share', element: load(() => import('./pages/staff/SharePage')) },
          { path: 'my-services', element: load(() => import('./pages/staff/MyServices')) },
        ],
      },
      { path: '*', element: <RouteError /> },
    ],
  },
])
