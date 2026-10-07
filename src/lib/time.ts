// Timezone-correct date helpers. All calendar rendering happens in the SHOP's
// timezone (not the device's), so a barber travelling or a client booking
// from another city always sees the shop's wall clock.

export type DateStr = string // 'YYYY-MM-DD'

const partsCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string) {
  let f = partsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    partsCache.set(tz, f)
  }
  return f
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number // 0 = Sunday
}

export function zonedParts(date: Date | string | number, tz: string): ZonedParts {
  const d = new Date(date)
  const out: Record<string, string> = {}
  for (const p of fmt(tz).formatToParts(d)) out[p.type] = p.value
  return {
    year: +out.year,
    month: +out.month,
    day: +out.day,
    hour: +out.hour % 24,
    minute: +out.minute,
    second: +out.second,
    weekday: WEEKDAYS.indexOf(out.weekday),
  }
}

/** Offset of tz from UTC at an instant, in minutes (e.g. -240 for New York in summer). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000)
}

/** Convert a wall-clock time in tz to an absolute instant (DST aware). */
export function zonedToUtc(date: DateStr, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm || 0)
  const off1 = tzOffsetMinutes(new Date(guess), tz)
  let ts = guess - off1 * 60000
  const off2 = tzOffsetMinutes(new Date(ts), tz)
  if (off2 !== off1) ts = guess - off2 * 60000
  return new Date(ts)
}

export function pad(n: number) {
  return String(n).padStart(2, '0')
}

export function toDateStr(p: { year: number; month: number; day: number }): DateStr {
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

export function dateInTz(date: Date | string | number, tz: string): DateStr {
  return toDateStr(zonedParts(date, tz))
}

export function todayInTz(tz: string): DateStr {
  return dateInTz(new Date(), tz)
}

export function addDays(date: DateStr, n: number): DateStr {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export function weekdayOf(date: DateStr): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export function diffDays(a: DateStr, b: DateStr): number {
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / 864e5)
}

export function startOfWeek(date: DateStr, weekStartsOn = 1): DateStr {
  const wd = weekdayOf(date)
  return addDays(date, -((wd - weekStartsOn + 7) % 7))
}

export function startOfMonth(date: DateStr): DateStr {
  return date.slice(0, 8) + '01'
}

export function endOfMonth(date: DateStr): DateStr {
  const [y, m] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m, 0))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Minutes since local midnight in tz. */
export function minutesOfDay(date: Date | string, tz: string): number {
  const p = zonedParts(date, tz)
  return p.hour * 60 + p.minute
}

export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + (m || 0)
}

export function minutesToTime(min: number): string {
  return `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`
}

export type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'mtd' | 'custom'

export function rangeFor(key: RangeKey, tz: string, custom?: { from: DateStr; to: DateStr }): { from: DateStr; to: DateStr } {
  const today = todayInTz(tz)
  switch (key) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) }
    case '7d':
      return { from: addDays(today, -6), to: today }
    case '30d':
      return { from: addDays(today, -29), to: today }
    case '90d':
      return { from: addDays(today, -89), to: today }
    case 'mtd':
      return { from: startOfMonth(today), to: today }
    case 'custom':
      return custom ?? { from: addDays(today, -29), to: today }
  }
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
