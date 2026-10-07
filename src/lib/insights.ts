// Smart insights: turn real analytics into recommendations.
// Every rule has a minimum-data threshold so we never draw conclusions from
// noise, and every number in the text comes from the analytics payload.
import type { Analytics } from './types'
import { money } from './format'
import { WEEKDAY_NAMES } from './time'

export type InsightKind = 'opportunity' | 'warning' | 'win' | 'info'

export interface Insight {
  id: string
  kind: InsightKind
  title: string
  detail: string
  recommendation?: string
  action?: { label: string; to: string }
  score: number // ordering weight
}

const fmtHour = (h: number) => {
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hh = h % 12 === 0 ? 12 : h % 12
  return `${hh} ${suffix}`
}

/** Merge consecutive hours into ranges: [14,15,16] → "2 PM–5 PM". */
export function hourRanges(hours: number[]): { start: number; end: number }[] {
  const sorted = [...new Set(hours)].sort((a, b) => a - b)
  const out: { start: number; end: number }[] = []
  for (const h of sorted) {
    const last = out[out.length - 1]
    if (last && last.end === h) last.end = h + 1
    else out.push({ start: h, end: h + 1 })
  }
  return out
}

export function generateInsights(a: Analytics, opts: { currency?: string } = {}): Insight[] {
  const out: Insight[] = []
  const m = (c: number | null | undefined) => money(c, { currency: opts.currency ?? a.period.currency, cents: false })
  const s = a.summary
  const weeks = Math.max(1, a.period.days / 7)

  // 1) Peak capacity windows (need ≥ 2 weeks of data so "consistently" is true).
  if (a.period.days >= 14) {
    const byDay = new Map<number, number[]>()
    for (const c of a.heatmap) {
      if ((c.utilization ?? 0) >= 90 && c.available_minutes >= 60 * weeks * 0.5) {
        byDay.set(c.dow, [...(byDay.get(c.dow) ?? []), c.hour])
      }
    }
    for (const [dow, hours] of byDay) {
      const best = hourRanges(hours).sort((x, y) => y.end - y.start - (x.end - x.start))[0]
      if (!best || best.end - best.start < 2) continue
      const cells = a.heatmap.filter((c) => c.dow === dow && c.hour >= best.start && c.hour < best.end)
      const avg = cells.reduce((t, c) => t + (c.utilization ?? 0), 0) / cells.length
      out.push({
        id: `peak-${dow}-${best.start}`,
        kind: 'opportunity',
        title: `${WEEKDAY_NAMES[dow]} ${fmtHour(best.start)}–${fmtHour(best.end)} is consistently at ${Math.floor(avg)}%+ capacity`,
        detail: `Across the last ${a.period.days} days, these hours are almost always fully booked.`,
        recommendation: `Consider extending ${WEEKDAY_NAMES[dow]} availability by ${Math.min(2, best.end - best.start)} hours or adding a chair at that time.`,
        action: { label: 'Edit schedules', to: '/app/barbers' },
        score: 90 + avg / 10,
      })
    }
  }

  // 2) Slot length vs actual cut time.
  const ct = a.cut_time
  if (ct.count >= 10 && ct.avg_actual_minutes !== null && ct.avg_scheduled_minutes !== null) {
    const gap = ct.avg_scheduled_minutes - ct.avg_actual_minutes
    const availPerBarberDay =
      a.barbers.length && a.period.days ? (a.utilization.available_minutes ?? 0) / a.barbers.length / a.period.days : 0
    if (gap >= 4) {
      const extra = availPerBarberDay > 0 ? availPerBarberDay / ct.avg_actual_minutes - availPerBarberDay / ct.avg_scheduled_minutes : 0
      out.push({
        id: 'slots-too-long',
        kind: 'opportunity',
        title: `Cuts take ${Math.round(ct.avg_actual_minutes)} min on average, but you book ${Math.round(ct.avg_scheduled_minutes)}-minute slots`,
        detail: `Based on ${ct.count} timed cuts. ${ct.finished_early} finished more than 2 minutes early.`,
        recommendation:
          extra >= 0.5
            ? `Tightening durations could add roughly ${extra < 1.5 ? '1' : `${Math.floor(extra)}–${Math.ceil(extra)}`} appointment${extra >= 1.5 ? 's' : ''} per barber per day.`
            : 'Tightening service durations would free up time for more bookings.',
        action: { label: 'Review services', to: '/app/services' },
        score: 85,
      })
    } else if (gap <= -5) {
      out.push({
        id: 'slots-too-short',
        kind: 'warning',
        title: `Cuts run ${Math.round(-gap)} min over the booked time on average`,
        detail: `${ct.ran_over} of ${ct.count} timed cuts ran long — clients later in the day end up waiting.`,
        recommendation: 'Lengthen the affected services or add a buffer between appointments.',
        action: { label: 'Review services', to: '/app/services' },
        score: 80,
      })
    }
    for (const sv of ct.by_service) {
      if (sv.count >= 8 && sv.scheduled_minutes - sv.avg_minutes >= 8) {
        out.push({
          id: `svc-${sv.name}`,
          kind: 'opportunity',
          title: `${sv.name}: ${Math.round(sv.avg_minutes)} min actual vs ${Math.round(sv.scheduled_minutes)} min booked`,
          detail: `Measured over ${sv.count} cuts.`,
          recommendation: `Try booking ${sv.name} at ${Math.ceil(sv.avg_minutes / 5) * 5} minutes.`,
          action: { label: 'Edit service', to: '/app/services' },
          score: 60,
        })
      }
    }
  }

  // 3) Barber revenue per available hour vs shop average.
  const money_rows = a.barbers.filter((b) => b.revenue_per_hour_cents !== null && b.available_hours >= 8 && b.cuts >= 5)
  if (money_rows.length >= 2) {
    const totalRev = money_rows.reduce((t, b) => t + (b.net_revenue_cents ?? 0), 0)
    const totalHours = money_rows.reduce((t, b) => t + b.available_hours, 0)
    const avg = totalHours ? totalRev / totalHours : 0
    const top = [...money_rows].sort((x, y) => (y.revenue_per_hour_cents ?? 0) - (x.revenue_per_hour_cents ?? 0))[0]
    const lift = avg ? ((top.revenue_per_hour_cents! - avg) / avg) * 100 : 0
    if (lift >= 15) {
      out.push({
        id: `rph-${top.barber_id}`,
        kind: 'win',
        title: `${top.name} generates ${Math.round(lift)}% more revenue per available hour than the shop average`,
        detail: `${m(top.revenue_per_hour_cents)}/hour vs a shop average of ${m(avg)}/hour.`,
        recommendation: `Give ${top.name} the busiest slots, and look at what they do differently (service mix, upsells, rebooking).`,
        score: 70,
      })
    }
  }

  // 4) Under-utilised barbers.
  for (const b of a.barbers) {
    if (b.available_hours >= 16 && b.utilization !== null && b.utilization < 45) {
      out.push({
        id: `underused-${b.barber_id}`,
        kind: 'warning',
        title: `${b.name}'s chair is only ${Math.round(b.utilization)}% booked`,
        detail: `${Math.round(b.available_hours)} available hours in this period.`,
        recommendation: `Feature ${b.name} on your booking page, send a "book with ${b.name}" offer to lapsed clients, or trim quiet hours.`,
        action: { label: 'Clients to win back', to: '/app/clients?health=AT_RISK' },
        score: 65 - b.utilization / 10,
      })
    }
  }

  // 5) No-shows / cancellations.
  if (s.bookings >= 20 && (s.no_show_rate ?? 0) >= 8) {
    out.push({
      id: 'no-shows',
      kind: 'warning',
      title: `${s.no_show_rate}% of bookings were no-shows`,
      detail: `${s.no_shows} no-shows out of ${s.bookings} bookings.`,
      recommendation: 'Require a deposit or card on file, and make sure the 2-hour reminder is on.',
      action: { label: 'Booking policy', to: '/app/settings/booking' },
      score: 88,
    })
  }
  if (s.bookings >= 20 && (s.cancellation_rate ?? 0) >= 15) {
    out.push({
      id: 'cancellations',
      kind: 'warning',
      title: `Cancellation rate is ${s.cancellation_rate}%`,
      detail: `${s.cancelled} cancellations out of ${s.bookings} bookings. ${a.bookings.late_cancellations} were inside the cancellation window.`,
      recommendation: 'A late-cancellation fee and the waitlist will help refill these slots.',
      action: { label: 'Booking policy', to: '/app/settings/booking' },
      score: 75,
    })
  }

  // 6) Rebooking.
  if (s.completed >= 20 && s.rebooking_rate !== null) {
    if (s.rebooking_rate < 50) {
      out.push({
        id: 'rebooking-low',
        kind: 'opportunity',
        title: `Only ${s.rebooking_rate}% of clients rebook before leaving`,
        detail: `${s.rebooked} of ${s.completed} completed cuts led to a next booking.`,
        recommendation: 'Ask every client "Same time in 3 weeks?" at checkout — the Book Again button does it in one tap.',
        score: 72,
      })
    } else if (s.rebooking_rate >= 70) {
      out.push({ id: 'rebooking-high', kind: 'win', title: `${s.rebooking_rate}% rebooking rate`, detail: 'Most clients lock in their next cut before leaving. Keep it up.', score: 30 })
    }
  }

  // 7) Retention.
  const atRisk = a.clients.health?.AT_RISK ?? 0
  if (atRisk >= 3) {
    out.push({
      id: 'at-risk',
      kind: 'opportunity',
      title: `${atRisk} regular clients are overdue for a cut`,
      detail: 'They have gone well past their usual visit rhythm and have nothing booked.',
      recommendation: 'Send them a "time for a fresh cut?" message with a link to book their usual barber.',
      action: { label: 'See clients', to: '/app/clients?health=AT_RISK' },
      score: 78 + Math.min(10, atRisk),
    })
  }

  // 8) Revenue trend.
  const prev = a.previous
  if (prev.net_revenue_cents > 0 && s.net_revenue_cents > 0 && prev.tickets >= 10) {
    const change = ((s.net_revenue_cents - prev.net_revenue_cents) / prev.net_revenue_cents) * 100
    if (Math.abs(change) >= 10) {
      const drivers: string[] = []
      if (prev.tickets && Math.abs((s.tickets - prev.tickets) / prev.tickets) >= 0.05)
        drivers.push(`${s.tickets > prev.tickets ? 'more' : 'fewer'} paid visits (${s.tickets} vs ${prev.tickets})`)
      if (prev.avg_ticket_cents && s.avg_ticket_cents && Math.abs((s.avg_ticket_cents - prev.avg_ticket_cents) / prev.avg_ticket_cents) >= 0.05)
        drivers.push(`average ticket ${s.avg_ticket_cents > prev.avg_ticket_cents ? 'up' : 'down'} to ${m(s.avg_ticket_cents)} from ${m(prev.avg_ticket_cents)}`)
      if ((s.no_shows ?? 0) > (prev.no_shows ?? 0) + 2) drivers.push(`more no-shows (${s.no_shows} vs ${prev.no_shows})`)
      out.push({
        id: 'revenue-trend',
        kind: change > 0 ? 'win' : 'warning',
        title: `Revenue is ${change > 0 ? 'up' : 'down'} ${Math.abs(Math.round(change))}% vs the previous ${a.period.days} days`,
        detail: drivers.length ? `Driven by ${drivers.join(', ')}.` : `${m(s.net_revenue_cents)} vs ${m(prev.net_revenue_cents)}.`,
        score: change > 0 ? 50 : 86,
      })
    }
  }

  // 9) Quiet hours.
  if (a.period.days >= 14) {
    const quiet = a.heatmap.filter((c) => (c.utilization ?? 100) < 20 && c.available_minutes >= 60 * weeks * 0.8)
    const byDay = new Map<number, number[]>()
    for (const c of quiet) byDay.set(c.dow, [...(byDay.get(c.dow) ?? []), c.hour])
    const worst = [...byDay.entries()].map(([d, hs]) => ({ d, r: hourRanges(hs).sort((x, y) => y.end - y.start - (x.end - x.start))[0] })).filter((x) => x.r && x.r.end - x.r.start >= 2)
    if (worst.length) {
      const w = worst.sort((x, y) => y.r.end - y.r.start - (x.r.end - x.r.start))[0]
      out.push({
        id: 'quiet',
        kind: 'info',
        title: `${WEEKDAY_NAMES[w.d]} ${fmtHour(w.r.start)}–${fmtHour(w.r.end)} is under 20% booked`,
        detail: 'Chairs are staffed but mostly empty in this window.',
        recommendation: 'Try an off-peak price, a walk-in special, or move breaks/personal time here.',
        action: { label: 'Create promo', to: '/app/marketing' },
        score: 40,
      })
    }
  }

  // 10) Payments missing.
  if (a.revenue.unpaid_completed > 0) {
    out.push({
      id: 'unpaid',
      kind: 'warning',
      title: `${a.revenue.unpaid_completed} completed appointment${a.revenue.unpaid_completed > 1 ? 's have' : ' has'} no payment recorded`,
      detail: 'Revenue and barber earnings are under-reported until these are checked out.',
      action: { label: 'Review', to: '/app/payments?filter=unpaid' },
      score: 95,
    })
  }

  return out.sort((x, y) => y.score - x.score)
}
