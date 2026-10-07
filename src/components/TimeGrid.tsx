import { type ReactNode } from 'react'
import { Sun, Sunrise, Sunset } from 'lucide-react'
import { cx, Skeleton, Spinner } from '@/components/ui'
import { time } from '@/lib/format'
import { zonedParts } from '@/lib/time'
import type { Slot } from '@/lib/types'

const PERIODS = [
  { label: 'Morning', icon: Sunrise, test: (h: number) => h < 12 },
  { label: 'Afternoon', icon: Sun, test: (h: number) => h >= 12 && h < 17 },
  { label: 'Evening', icon: Sunset, test: (h: number) => h >= 17 },
]

/**
 * Bookable times as a grid of uniform boxes, grouped Morning / Afternoon / Evening.
 * Used everywhere a time is picked so the experience is identical for clients and staff.
 */
export function TimeGrid({
  slots, timezone, onPick, loading, busy, disabled, empty, sub, dense, dedupe,
}: {
  slots: Slot[] | undefined
  timezone: string
  onPick: (s: Slot) => void
  loading?: boolean
  /** Key (starts_at or barber_id+starts_at) of the slot currently being booked. */
  busy?: string | null
  disabled?: boolean
  empty?: ReactNode
  /** Optional second line under the time (e.g. barber name). */
  sub?: (s: Slot) => ReactNode
  /** Smaller boxes, more columns — for dialogs. */
  dense?: boolean
  /** One box per distinct time ("any barber"). */
  dedupe?: boolean
}) {
  const cols = dense ? 'grid-cols-3 sm:grid-cols-5' : 'grid-cols-3 sm:grid-cols-4'
  if (loading)
    return (
      <div className={cx('grid gap-2', cols)}>
        {Array.from({ length: dense ? 10 : 8 }, (_, i) => <Skeleton key={i} className={dense ? 'h-12' : 'h-14'} />)}
      </div>
    )

  let list = [...(slots ?? [])].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  if (dedupe) list = list.filter((s, i) => i === 0 || s.starts_at !== list[i - 1].starts_at)
  if (!list.length) return <>{empty ?? <p className="py-6 text-center text-sm text-muted">No open times</p>}</>

  const groups = PERIODS.map((p) => ({ ...p, items: list.filter((s) => p.test(zonedParts(s.starts_at, timezone).hour)) })).filter((g) => g.items.length)
  const keyOf = (s: Slot) => (dedupe ? s.starts_at : s.barber_id + s.starts_at)

  return (
    <div className={dense ? 'space-y-4' : 'space-y-6'}>
      {groups.map((g) => (
        <section key={g.label}>
          <div className="mb-2 flex items-center gap-2 text-muted">
            <g.icon className="size-3.5" strokeWidth={2} />
            <span className="eyebrow">{g.label}</span>
            <span className="text-[11px] tnum text-faint">{g.items.length}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className={cx('grid gap-2', cols)}>
            {g.items.map((s) => {
              const label = time(s.starts_at, timezone)
              const m = /^(.*?)\s?([AaPp]\.?\s?[Mm]\.?)$/.exec(label)
              const isBusy = busy === keyOf(s) || busy === s.starts_at
              return (
                <button
                  key={keyOf(s)}
                  type="button"
                  data-slot={s.starts_at}
                  disabled={disabled || !!busy}
                  onClick={() => onPick(s)}
                  className={cx(
                    'group relative flex flex-col items-center justify-center rounded-xl border tnum transition',
                    dense ? 'h-12' : 'h-14',
                    isBusy
                      ? 'border-accent bg-accent text-accent-ink'
                      : 'border-line bg-surface hover:-translate-y-px hover:border-accent hover:bg-accent-soft hover:shadow-[0_6px_18px_-8px_var(--accent)] active:scale-95',
                    (disabled || busy) && !isBusy && 'opacity-60',
                  )}
                >
                  {isBusy ? (
                    <Spinner className="size-4 text-accent-ink" />
                  ) : (
                    <>
                      <span className={cx('font-semibold leading-none', dense ? 'text-[14px]' : 'text-[16px]')}>
                        {m ? m[1] : label}
                        {m && <span className="ml-0.5 text-[10px] font-medium uppercase text-muted group-hover:text-ink">{m[2]}</span>}
                      </span>
                      {sub && <span className="mt-1 max-w-full truncate px-1 text-[10px] text-muted">{sub(s)}</span>}
                    </>
                  )}
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
