import { addDays, dateInTz, diffDays, todayInTz } from './time'

let defaultCurrency = 'USD'
export function setDefaultCurrency(c: string | undefined | null) {
  if (c) defaultCurrency = c
}

const moneyFmt = new Map<string, Intl.NumberFormat>()
export function money(cents: number | string | null | undefined, opts: { currency?: string; compact?: boolean; cents?: boolean } = {}): string {
  if (cents === null || cents === undefined || cents === '') return '—'
  const value = Number(cents) / 100
  const currency = opts.currency ?? defaultCurrency
  const showCents = opts.cents ?? !Number.isInteger(value)
  const key = `${currency}|${opts.compact}|${showCents}`
  let f = moneyFmt.get(key)
  if (!f) {
    f = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: opts.compact ? 'compact' : 'standard',
      minimumFractionDigits: showCents && !opts.compact ? 2 : 0,
      maximumFractionDigits: opts.compact ? 1 : showCents ? 2 : 0,
    })
    moneyFmt.set(key, f)
  }
  return f.format(value)
}

/** Parse a user-entered amount ("35", "35.5", "$35.50") into cents. */
export function parseMoney(input: string): number | null {
  const cleaned = input.replace(/[^\d.,-]/g, '').replace(',', '.')
  if (!cleaned) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

export function pct(v: number | string | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return '—'
  return `${Number(v).toFixed(digits)}%`
}

export function num(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return new Intl.NumberFormat().format(Number(v))
}

export function minutes(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const m = Math.round(Number(v))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

export function time(d: Date | string, tz: string): string {
  return new Date(d).toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' })
}

export function dateLabel(d: Date | string, tz: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }): string {
  return new Date(d).toLocaleDateString(undefined, { timeZone: tz, ...opts })
}

/** "Today", "Tomorrow", "Yesterday" or "Fri, Oct 9" */
export function relativeDay(d: Date | string, tz: string): string {
  const ds = dateInTz(d, tz)
  const today = todayInTz(tz)
  if (ds === today) return 'Today'
  if (ds === addDays(today, 1)) return 'Tomorrow'
  if (ds === addDays(today, -1)) return 'Yesterday'
  return dateLabel(d, tz)
}

export function dateStrLabel(ds: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }): string {
  const [y, m, d] = ds.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts })
}

export function relativeDateStr(ds: string, tz: string): string {
  const diff = diffDays(ds, todayInTz(tz))
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return dateStrLabel(ds)
}

export function ago(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const s = (Date.now() - new Date(d).getTime()) / 1000
  if (s < -60) {
    const f = -s
    if (f < 3600) return `in ${Math.round(f / 60)}m`
    if (f < 86400) return `in ${Math.round(f / 3600)}h`
    return `in ${Math.round(f / 86400)}d`
  }
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  const days = Math.floor(s / 86400)
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
}

export function fullName(c: { first_name?: string | null; last_name?: string | null } | null | undefined): string {
  if (!c) return ''
  return [c.first_name, c.last_name].filter(Boolean).join(' ')
}

export function delta(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || Number(prev) === 0) return null
  return ((Number(cur) - Number(prev)) / Math.abs(Number(prev))) * 100
}

export function greeting(tz: string): string {
  const h = Number(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }))
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}
