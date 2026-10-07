import { useEffect, useState } from 'react'
import type { BarberLive, LiveStatus } from '@/lib/types'
import { clock, relativeDay, time } from '@/lib/format'
import { cx } from './ui'

/** One vocabulary for barber status everywhere: customer page, chair board, barber app. */
export const LIVE: Record<LiveStatus, { label: string; emoji: string; dot: string; text: string; ring: string }> = {
  AVAILABLE: { label: 'Available', emoji: '🟢', dot: 'bg-success', text: 'text-success', ring: 'border-success/40' },
  CUTTING: { label: 'Cutting now', emoji: '✂️', dot: 'bg-accent', text: 'text-accent', ring: 'border-accent/40' },
  BOOKED: { label: 'With a client', emoji: '✂️', dot: 'bg-accent', text: 'text-accent', ring: 'border-accent/30' },
  BREAK: { label: 'On break', emoji: '🟡', dot: 'bg-warning', text: 'text-warning', ring: 'border-warning/40' },
  QUEUE: { label: 'Queue', emoji: '👥', dot: 'bg-info', text: 'text-info', ring: 'border-info/40' },
  OFFLINE: { label: 'Offline', emoji: '🔴', dot: 'bg-danger', text: 'text-danger', ring: 'border-line' },
  NOT_WORKING: { label: 'Not working today', emoji: '⚪', dot: 'bg-faint', text: 'text-muted', ring: 'border-line' },
}

export function LivePill({ status, className, size = 'md' }: { status: LiveStatus; className?: string; size?: 'sm' | 'md' }) {
  const m = LIVE[status]
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap font-semibold', size === 'sm' ? 'text-[12px]' : 'text-[13px]', m.text, className)}>
      <span className={cx('inline-block size-2 shrink-0 rounded-full', m.dot, (status === 'CUTTING' || status === 'AVAILABLE') && 'pulse-ring')} />
      {m.label}
    </span>
  )
}

/** The short explanatory lines under a barber's status ("Estimated finish 2:45 PM"). */
export function liveLines(b: BarberLive, tz: string): string[] {
  const lines: string[] = []
  const t = (d: string | null) => (d ? time(d, tz) : '')
  switch (b.status) {
    case 'CUTTING':
      lines.push(`Estimated finish ${t(b.until)}`)
      break
    case 'BOOKED':
      if (b.until) lines.push(`Free at ${t(b.until)}`)
      break
    case 'BREAK':
      lines.push(b.until ? `Back at ${t(b.until)}` : 'Back soon')
      break
    case 'QUEUE':
      lines.push(`${b.queue_count} ${b.queue_count === 1 ? 'person' : 'people'} waiting`)
      lines.push(`Estimated wait ${b.estimated_wait_minutes} min`)
      break
    case 'OFFLINE':
      if (b.note === 'starts' && b.until) lines.push(`Starts at ${t(b.until)}`)
      else if (b.note === 'done') lines.push('Done for today')
      break
  }
  if (b.status !== 'QUEUE' && b.queue_count > 0) lines.push(`${b.queue_count} waiting · ~${b.estimated_wait_minutes} min`)
  return lines
}

export function nextAvailableLabel(b: BarberLive, tz: string): string | null {
  if (!b.next_available) return null
  const day = relativeDay(b.next_available, tz)
  return `${day === 'Today' ? '' : `${day} `}${time(b.next_available, tz)}`
}

/** Elapsed time since a start, ticking every second. */
export function useElapsed(startedAt: string | null | undefined) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!startedAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startedAt])
  return startedAt ? Math.max(0, (now - new Date(startedAt).getTime()) / 1000) : 0
}

export function Elapsed({ startedAt, className }: { startedAt: string; className?: string }) {
  const s = useElapsed(startedAt)
  return <span className={cx('tnum', className)}>{clock(s)}</span>
}
