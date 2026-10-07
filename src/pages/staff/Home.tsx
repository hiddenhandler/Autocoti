import { Navigate } from 'react-router'
import { useWorkspace } from '@/lib/auth'

/** Each role lands on the screen that answers its question. */
export default function Home() {
  const { ws, can } = useWorkspace()
  if (can('reports.shop')) return <Navigate to="/app/dashboard" replace /> // "How is my shop performing?"
  if (ws.barber_id) return <Navigate to="/app/today" replace /> // "Who is next?"
  return <Navigate to="/app/calendar" replace />
}
