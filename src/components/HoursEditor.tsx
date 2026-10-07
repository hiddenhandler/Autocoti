import { Plus, X } from 'lucide-react'
import { cx, IconButton, Toggle } from './ui'
import { WEEKDAY_NAMES } from '@/lib/time'

export interface HoursRow {
  weekday: number
  starts_at: string
  ends_at: string
  kind?: 'work' | 'break'
  label?: string | null
}

const ORDER = [1, 2, 3, 4, 5, 6, 0]
const hhmm = (t: string) => t.slice(0, 5)

/** Weekly schedule editor: one working window per day + any number of breaks. */
export function HoursEditor({ value, onChange, allowBreaks = true }: { value: HoursRow[]; onChange: (rows: HoursRow[]) => void; allowBreaks?: boolean }) {
  const forDay = (d: number) => value.filter((r) => r.weekday === d)
  const set = (d: number, rows: HoursRow[]) => onChange([...value.filter((r) => r.weekday !== d), ...rows].sort((a, b) => a.weekday - b.weekday || a.starts_at.localeCompare(b.starts_at)))

  return (
    <div className="divide-y divide-line">
      {ORDER.map((d) => {
        const rows = forDay(d)
        const work = rows.find((r) => (r.kind ?? 'work') === 'work')
        const breaks = rows.filter((r) => r.kind === 'break')
        const invalid = work && work.ends_at <= work.starts_at
        return (
          <div key={d} className="py-3.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex w-36 items-center gap-3">
                <Toggle
                  checked={!!work}
                  onChange={(on) => set(d, on ? [{ weekday: d, starts_at: '09:00', ends_at: '18:00', kind: 'work' }] : [])}
                />
                <span className={cx('text-sm font-medium', !work && 'text-muted')}>{WEEKDAY_NAMES[d]}</span>
              </div>
              {work ? (
                <div className="flex items-center gap-2">
                  <TimeInput value={hhmm(work.starts_at)} onChange={(v) => set(d, [{ ...work, starts_at: v }, ...breaks])} label={`${WEEKDAY_NAMES[d]} start`} />
                  <span className="text-muted">→</span>
                  <TimeInput value={hhmm(work.ends_at)} onChange={(v) => set(d, [{ ...work, ends_at: v }, ...breaks])} label={`${WEEKDAY_NAMES[d]} end`} />
                  {allowBreaks && (
                    <button
                      type="button"
                      className="ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-ink"
                      onClick={() => set(d, [work, ...breaks, { weekday: d, starts_at: '13:00', ends_at: '14:00', kind: 'break', label: 'Lunch' }])}
                    >
                      <Plus className="size-3.5" /> Break
                    </button>
                  )}
                </div>
              ) : (
                <span className="text-sm text-faint">Closed</span>
              )}
            </div>
            {invalid && <p className="ml-40 mt-1 text-xs text-danger">End must be after start</p>}
            {work &&
              breaks.map((b, i) => (
                <div key={i} className="ml-0 mt-2 flex items-center gap-2 sm:ml-40">
                  <span className="w-12 text-xs text-muted">Break</span>
                  <TimeInput value={hhmm(b.starts_at)} onChange={(v) => set(d, [work, ...breaks.map((x, j) => (j === i ? { ...x, starts_at: v } : x))])} label="Break start" />
                  <span className="text-muted">→</span>
                  <TimeInput value={hhmm(b.ends_at)} onChange={(v) => set(d, [work, ...breaks.map((x, j) => (j === i ? { ...x, ends_at: v } : x))])} label="Break end" />
                  <IconButton label="Remove break" onClick={() => set(d, [work, ...breaks.filter((_, j) => j !== i)])}>
                    <X className="size-4" />
                  </IconButton>
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

function TimeInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <input
      type="time"
      step={300}
      aria-label={label}
      value={value}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="h-9 rounded-lg border border-line bg-surface px-2 text-sm tnum focus:border-accent focus:outline-none"
    />
  )
}

export function validHours(rows: HoursRow[]) {
  return rows.every((r) => r.ends_at > r.starts_at)
}
