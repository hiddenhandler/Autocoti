// Business assistant — deterministic core.
// 1. parseQuestion() figures out WHAT is asked (intent), for WHICH period and
//    WHICH barber.
// 2. The caller fetches real data for exactly that (shop_analytics, list_clients).
// 3. composeAnswer() writes the answer using only numbers from that data.
// If the data can't answer the question, we say so — we never invent numbers.
// An optional LLM layer (supabase/functions/assistant) can phrase richer answers,
// but it calls the same data tools and is bound by the same rule.
import type { Analytics, ClientRow } from './types'
import { addDays, endOfMonth, startOfMonth, startOfWeek, todayInTz, WEEKDAY_NAMES, type DateStr } from './time'
import { money, minutes, pct } from './format'

export type Intent =
  | 'revenue'
  | 'barber_revenue'
  | 'barber_earnings'
  | 'top_barber'
  | 'busiest_day'
  | 'busiest_hour'
  | 'lapsed_clients'
  | 'top_services'
  | 'avg_cut_time'
  | 'revenue_change'
  | 'top_rebooking'
  | 'no_shows'
  | 'utilization'
  | 'new_clients'
  | 'tips'
  | 'avg_ticket'
  | 'bookings'
  | 'unknown'

export interface ParsedQuestion {
  intent: Intent
  from: DateStr
  to: DateStr
  periodLabel: string
  barberId: string | null
  barberName: string | null
  days: number | null // for "hasn't returned in more than N days"
  needsClients: boolean
}

const has = (q: string, ...words: (string | RegExp)[]) => words.some((w) => (typeof w === 'string' ? q.includes(w) : w.test(q)))

export function parsePeriod(q: string, tz: string): { from: DateStr; to: DateStr; label: string } {
  const today = todayInTz(tz)
  if (has(q, 'today')) return { from: today, to: today, label: 'today' }
  if (has(q, 'yesterday')) return { from: addDays(today, -1), to: addDays(today, -1), label: 'yesterday' }
  if (has(q, 'last week', 'previous week')) {
    const s = addDays(startOfWeek(today), -7)
    return { from: s, to: addDays(s, 6), label: 'last week' }
  }
  if (has(q, 'this week')) return { from: startOfWeek(today), to: today, label: 'this week' }
  if (has(q, 'last month', 'previous month')) {
    const s = startOfMonth(addDays(startOfMonth(today), -1))
    return { from: s, to: endOfMonth(s), label: 'last month' }
  }
  if (has(q, 'this month', 'month to date', 'mtd')) return { from: startOfMonth(today), to: today, label: 'this month' }
  if (has(q, 'this year', 'ytd')) return { from: `${today.slice(0, 4)}-01-01`, to: today, label: 'this year' }
  const n = q.match(/(?:last|past)\s+(\d{1,3})\s+days/)
  if (n) {
    const d = Math.min(365, Math.max(1, Number(n[1])))
    return { from: addDays(today, -(d - 1)), to: today, label: `the last ${d} days` }
  }
  if (has(q, 'last 90', 'quarter')) return { from: addDays(today, -89), to: today, label: 'the last 90 days' }
  return { from: addDays(today, -29), to: today, label: 'the last 30 days' }
}

export function parseQuestion(question: string, tz: string, barbers: { id: string; name: string }[]): ParsedQuestion {
  const q = question.toLowerCase().replace(/[’']/g, "'")
  const period = parsePeriod(q, tz)
  const barber = barbers.find((b) => new RegExp(`\\b${b.name.toLowerCase().split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)) ?? null
  const daysMatch = q.match(/(\d{1,3})\s*(?:\+\s*)?days?/)

  let intent: Intent = 'unknown'
  if (has(q, "hasn't returned", 'havent returned', "haven't returned", 'not returned', "hasn't come", "haven't come", 'not been back', 'lapsed', 'lost clients', 'at risk', 'overdue', 'win back', 'need follow'))
    intent = 'lapsed_clients'
  else if (has(q, 'why') && has(q, 'revenue', 'sales', 'money', 'income')) intent = 'revenue_change'
  else if (has(q, 'rebook')) intent = 'top_rebooking'
  else if (has(q, 'busiest hour', 'peak hour', 'busiest time', 'what time')) intent = 'busiest_hour'
  else if (has(q, 'busiest', 'peak day', 'busiest day', 'which day')) intent = 'busiest_day'
  else if (has(q, 'service') && has(q, 'most money', 'most revenue', 'best', 'top', 'popular', 'make us')) intent = 'top_services'
  else if (has(q, 'cut time', 'haircut time', 'how long', 'average cut', 'average haircut', 'duration')) intent = 'avg_cut_time'
  else if (barber && has(q, 'earn', 'commission', 'take home', 'paid')) intent = 'barber_earnings'
  else if (has(q, 'which barber', 'who generated', 'top barber', 'best barber', 'who made', 'most revenue', 'highest revenue')) intent = 'top_barber'
  else if (has(q, 'no-show', 'no show', 'noshow')) intent = 'no_shows'
  else if (has(q, 'utilization', 'utilisation', 'capacity', 'how full', 'chair time')) intent = 'utilization'
  else if (has(q, 'new client', 'new customer')) intent = 'new_clients'
  else if (has(q, 'tip')) intent = 'tips'
  else if (has(q, 'average ticket', 'avg ticket', 'average spend', 'ticket size')) intent = 'avg_ticket'
  else if (has(q, 'how many booking', 'how many appointment', 'bookings', 'appointments')) intent = 'bookings'
  else if (has(q, 'make', 'made', 'revenue', 'sales', 'earn', 'income', 'money', 'gross', 'net'))
    intent = barber ? 'barber_revenue' : 'revenue'

  return {
    intent,
    from: period.from,
    to: period.to,
    periodLabel: period.label,
    barberId: barber?.id ?? null,
    barberName: barber?.name ?? null,
    days: intent === 'lapsed_clients' && daysMatch ? Number(daysMatch[1]) : null,
    needsClients: intent === 'lapsed_clients',
  }
}

export interface Answer {
  text: string
  facts: { label: string; value: string }[]
  list?: { title: string; sub?: string; href?: string }[]
  followUps?: string[]
  noData?: boolean
}

export function composeAnswer(p: ParsedQuestion, a: Analytics | null, clients?: ClientRow[]): Answer {
  const cur = a?.period.currency
  const m = (v: number | null | undefined) => money(v, { currency: cur })
  const period = p.periodLabel
  if (p.intent === 'unknown') {
    return {
      text: "I can answer questions about revenue, barbers, bookings, clients, cut times and capacity — using your shop's real numbers.",
      facts: [],
      followUps: ['How much did we make last month?', 'Which barber generated the most revenue?', 'Who hasn\'t returned in more than 30 days?'],
    }
  }
  if (p.intent === 'lapsed_clients') {
    const threshold = p.days
    const rows = (clients ?? []).filter((c) => c.visits > 0 && c.next_appointment === null && (threshold ? (c.days_since_last ?? 0) > threshold : c.is_due))
    rows.sort((x, y) => (y.days_since_last ?? 0) - (x.days_since_last ?? 0))
    if (!rows.length) return { text: threshold ? `No clients have been away more than ${threshold} days without a booking. 🎉` : 'No clients are overdue right now.', facts: [] }
    return {
      text: threshold
        ? `${rows.length} client${rows.length > 1 ? 's haven\'t' : ' hasn\'t'} been back in more than ${threshold} days and ${rows.length > 1 ? 'have' : 'has'} nothing booked.`
        : `${rows.length} client${rows.length > 1 ? 's are' : ' is'} overdue based on their usual visit rhythm.`,
      facts: [],
      list: rows.slice(0, 15).map((c) => ({
        title: [c.first_name, c.last_name].filter(Boolean).join(' '),
        sub: `${c.days_since_last} days since last visit · usually every ${c.cadence_days} days`,
        href: `/app/clients/${c.id}`,
      })),
      followUps: ['Send them a rebooking message from Marketing → Win back'],
    }
  }
  if (!a) return { text: "I couldn't load the data for that question.", facts: [], noData: true }
  const s = a.summary

  switch (p.intent) {
    case 'revenue':
      if (!s.tickets) return { text: `No payments were recorded ${period}.`, facts: [], noData: true }
      return {
        text: `You made ${m(s.net_revenue_cents)} in service revenue ${period}, plus ${m(a.revenue.tips_cents)} in tips.`,
        facts: [
          { label: 'Net service revenue', value: m(a.revenue.net_service_cents) },
          { label: 'Tips', value: m(a.revenue.tips_cents) },
          { label: 'Total collected', value: m(a.revenue.collected_cents) },
          { label: 'Paid visits', value: String(s.tickets) },
          { label: 'Average ticket', value: m(s.avg_ticket_cents) },
          ...(a.revenue.refunds_cents ? [{ label: 'Refunds', value: m(a.revenue.refunds_cents) }] : []),
        ],
      }
    case 'barber_revenue':
    case 'barber_earnings': {
      const b = a.barbers.find((x) => x.barber_id === p.barberId)
      if (!b) return { text: `I couldn't find ${p.barberName}.`, facts: [], noData: true }
      if (!b.can_view_money) return { text: `You don't have permission to see ${b.name}'s earnings.`, facts: [] }
      if (!b.cuts && !b.net_revenue_cents) return { text: `${b.name} has no completed cuts ${period}.`, facts: [], noData: true }
      return {
        text:
          p.intent === 'barber_earnings'
            ? `${b.name} earned ${m((b.commission_cents ?? 0) + (b.tips_cents ?? 0))} ${period}: ${m(b.commission_cents)} commission plus ${m(b.tips_cents)} in tips.`
            : `${b.name} generated ${m(b.net_revenue_cents)} in service revenue ${period} from ${b.cuts} cuts.`,
        facts: [
          { label: 'Service revenue', value: m(b.net_revenue_cents) },
          { label: 'Commission', value: m(b.commission_cents) },
          { label: 'Tips', value: m(b.tips_cents) },
          { label: 'Cuts', value: String(b.cuts) },
          { label: 'Average ticket', value: m(b.avg_ticket_cents) },
        ],
      }
    }
    case 'top_barber': {
      const rows = a.barbers.filter((b) => b.net_revenue_cents !== null && b.net_revenue_cents > 0)
      if (!rows.length) return { text: a.barbers.some((b) => !b.can_view_money) ? "You don't have permission to compare barbers' revenue." : `No barber revenue recorded ${period}.`, facts: [], noData: true }
      rows.sort((x, y) => (y.net_revenue_cents ?? 0) - (x.net_revenue_cents ?? 0))
      return {
        text: `${rows[0].name} generated the most revenue ${period}: ${m(rows[0].net_revenue_cents)} from ${rows[0].cuts} cuts.`,
        facts: rows.map((b) => ({ label: b.name, value: `${m(b.net_revenue_cents)} · ${b.cuts} cuts` })),
      }
    }
    case 'busiest_day': {
      const days = [...a.bookings.peak_days].sort((x, y) => y.count - x.count)
      if (!days.length) return { text: `No bookings ${period} yet.`, facts: [], noData: true }
      return {
        text: `${WEEKDAY_NAMES[days[0].dow]} is your busiest day ${period}, with ${days[0].count} appointments.`,
        facts: days.map((d) => ({ label: WEEKDAY_NAMES[d.dow], value: `${d.count} appointments` })),
      }
    }
    case 'busiest_hour': {
      const hrs = [...a.bookings.peak_hours].sort((x, y) => y.count - x.count)
      if (!hrs.length) return { text: `No bookings ${period} yet.`, facts: [], noData: true }
      const h = hrs[0].hour
      const label = `${h % 12 === 0 ? 12 : h % 12} ${h >= 12 ? 'PM' : 'AM'}`
      return { text: `${label} is your busiest start time ${period} (${hrs[0].count} appointments).`, facts: hrs.slice(0, 5).map((x) => ({ label: `${x.hour % 12 === 0 ? 12 : x.hour % 12} ${x.hour >= 12 ? 'PM' : 'AM'}`, value: `${x.count}` })) }
    }
    case 'top_services': {
      const sv = a.revenue.by_service
      if (!sv.length) return { text: `No service sales recorded ${period}.`, facts: [], noData: true }
      return {
        text: `${sv[0].name} brings in the most: ${m(sv[0].revenue_cents)} from ${sv[0].count} sales ${period}.`,
        facts: sv.slice(0, 6).map((x) => ({ label: x.name, value: `${m(x.revenue_cents)} · ${x.count}×` })),
      }
    }
    case 'avg_cut_time': {
      const ct = a.cut_time
      if (p.barberId) {
        const b = ct.by_barber.find((x) => x.barber_id === p.barberId)
        if (!b) return { text: `No timed cuts for ${p.barberName} ${period}. Times appear once a barber uses START/COMPLETE CUT.`, facts: [], noData: true }
        return { text: `${b.name}'s average cut takes ${minutes(b.avg_minutes)} (booked: ${minutes(b.scheduled_minutes)}), over ${b.count} timed cuts ${period}.`, facts: [] }
      }
      if (!ct.count || ct.avg_actual_minutes === null)
        return { text: `No timed cuts ${period}. Once barbers use START CUT / COMPLETE CUT, average cut time appears here.`, facts: [], noData: true }
      return {
        text: `Your average haircut takes ${minutes(ct.avg_actual_minutes)} vs ${minutes(ct.avg_scheduled_minutes)} booked (${pct(ct.efficiency)} efficiency), across ${ct.count} timed cuts ${period}.`,
        facts: ct.by_barber.map((b) => ({ label: b.name, value: `${minutes(b.avg_minutes)} · ${b.count} cuts` })),
      }
    }
    case 'revenue_change': {
      const prev = a.previous
      if (!prev.net_revenue_cents && !s.net_revenue_cents) return { text: 'There is no revenue in either period to compare yet.', facts: [], noData: true }
      const change = prev.net_revenue_cents ? ((s.net_revenue_cents - prev.net_revenue_cents) / prev.net_revenue_cents) * 100 : null
      const reasons: string[] = []
      if (s.tickets !== prev.tickets) reasons.push(`${Math.abs(s.tickets - prev.tickets)} ${s.tickets < prev.tickets ? 'fewer' : 'more'} paid visits (${s.tickets} vs ${prev.tickets})`)
      if (s.avg_ticket_cents && prev.avg_ticket_cents && s.avg_ticket_cents !== prev.avg_ticket_cents)
        reasons.push(`average ticket ${s.avg_ticket_cents < prev.avg_ticket_cents ? 'fell' : 'rose'} to ${m(s.avg_ticket_cents)} from ${m(prev.avg_ticket_cents)}`)
      if (s.no_shows !== prev.no_shows) reasons.push(`${s.no_shows} no-shows vs ${prev.no_shows}`)
      if (s.cancelled !== prev.cancelled) reasons.push(`${s.cancelled} cancellations vs ${prev.cancelled}`)
      if (s.utilization !== null && prev.utilization !== null && Math.abs(s.utilization - prev.utilization) >= 2)
        reasons.push(`chair utilization ${s.utilization < prev.utilization ? 'dropped' : 'rose'} to ${pct(s.utilization)} from ${pct(prev.utilization)}`)
      return {
        text:
          change === null
            ? `Revenue ${period} was ${m(s.net_revenue_cents)}; there's no revenue in the previous period to compare.`
            : `Revenue ${change < 0 ? 'was down' : 'was up'} ${Math.abs(change).toFixed(1)}% (${m(s.net_revenue_cents)} vs ${m(prev.net_revenue_cents)} in the previous ${a.period.days} days).${reasons.length ? ' The numbers behind it: ' + reasons.join('; ') + '.' : ''}`,
        facts: [
          { label: 'This period', value: m(s.net_revenue_cents) },
          { label: 'Previous period', value: m(prev.net_revenue_cents) },
        ],
      }
    }
    case 'top_rebooking': {
      const rows = a.barbers.filter((b) => b.rebooking_rate !== null && b.cuts >= 3).sort((x, y) => (y.rebooking_rate ?? 0) - (x.rebooking_rate ?? 0))
      if (!rows.length) return { text: `Not enough completed cuts ${period} to compare rebooking rates (need 3+ per barber).`, facts: [], noData: true }
      return {
        text: `${rows[0].name} has the highest rebooking rate ${period}: ${pct(rows[0].rebooking_rate)} of clients booked again. Shop-wide: ${pct(s.rebooking_rate)}.`,
        facts: rows.map((b) => ({ label: b.name, value: `${pct(b.rebooking_rate)} of ${b.cuts} cuts` })),
      }
    }
    case 'no_shows':
      if (!s.bookings) return { text: `No bookings ${period}.`, facts: [], noData: true }
      return { text: `${s.no_shows} no-shows out of ${s.bookings} bookings ${period} (${pct(s.no_show_rate, 1)}).`, facts: a.barbers.filter((b) => b.no_shows).map((b) => ({ label: b.name, value: `${b.no_shows} no-shows` })) }
    case 'utilization':
      if (!a.utilization.available_minutes) return { text: `No working hours are set ${period}, so there's no capacity to measure.`, facts: [], noData: true }
      return {
        text: `Chairs were ${pct(a.utilization.utilization)} booked ${period} (target ${a.utilization.target}%).`,
        facts: a.barbers.map((b) => ({ label: b.name, value: pct(b.utilization) })),
      }
    case 'new_clients':
      return { text: `${s.new_clients} new client${s.new_clients === 1 ? '' : 's'} and ${s.returning_clients} returning ${period}.`, facts: [] }
    case 'tips':
      return {
        text: `${m(a.revenue.tips_cents)} in tips ${period}.`,
        facts: a.barbers.filter((b) => b.tips_cents !== null).map((b) => ({ label: b.name, value: m(b.tips_cents) })),
      }
    case 'avg_ticket':
      if (!s.avg_ticket_cents) return { text: `No paid visits ${period}.`, facts: [], noData: true }
      return { text: `Average ticket ${period} is ${m(s.avg_ticket_cents)} across ${s.tickets} paid visits (excluding tips).`, facts: [] }
    case 'bookings':
      return {
        text: `${a.bookings.total} bookings ${period}: ${a.bookings.completed} completed, ${a.bookings.cancelled} cancelled, ${a.bookings.no_shows} no-shows, ${a.bookings.upcoming} upcoming.`,
        facts: [
          { label: 'Online', value: String(a.bookings.online) },
          { label: 'Walk-ins', value: String(a.bookings.walk_ins) },
          { label: 'Staff / phone', value: String(a.bookings.staff) },
        ],
      }
  }
  return { text: "I can't answer that one yet.", facts: [] }
}

export const SUGGESTED_QUESTIONS = [
  'How much did we make last month?',
  'Which barber generated the most revenue?',
  'What is our busiest day?',
  "Who hasn't returned in more than 30 days?",
  'What services make us the most money?',
  'What is our average haircut time?',
  'Why was revenue lower this month?',
  'Who has the highest rebooking rate?',
]
