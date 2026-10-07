import { describe, expect, it } from 'vitest'
import { addDays, dateInTz, startOfWeek, weekdayOf, zonedParts, zonedToUtc, rangeFor } from './time'
import { parseMoney, money } from './format'
import { toCsv } from './csv'
import { composeAnswer, parsePeriod, parseQuestion } from './assistant'
import { generateInsights, hourRanges } from './insights'
import type { Analytics, CoreMetrics } from './types'

describe('time', () => {
  it('converts wall-clock time in a zone to UTC, across DST', () => {
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(zonedToUtc('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z')
    // DST start day (2026-03-08): 09:00 local is already EDT
    expect(zonedToUtc('2026-03-08', '09:00', 'America/New_York').toISOString()).toBe('2026-03-08T13:00:00.000Z')
    expect(zonedToUtc('2026-07-01', '09:00', 'Asia/Kolkata').toISOString()).toBe('2026-07-01T03:30:00.000Z')
  })
  it('reads local parts and dates in a zone', () => {
    const d = new Date('2026-10-07T03:30:00Z')
    expect(dateInTz(d, 'America/Los_Angeles')).toBe('2026-10-06')
    expect(zonedParts(d, 'Europe/Madrid').hour).toBe(5)
  })
  it('does calendar arithmetic on date strings', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02')
    expect(weekdayOf('2026-10-07')).toBe(3)
    expect(startOfWeek('2026-10-07')).toBe('2026-10-05')
    expect(startOfWeek('2026-10-04')).toBe('2026-09-28')
  })
  it('builds report ranges', () => {
    const r = rangeFor('7d', 'UTC')
    expect(addDays(r.from, 6)).toBe(r.to)
  })
})

describe('format', () => {
  it('parses money input to cents', () => {
    expect(parseMoney('35')).toBe(3500)
    expect(parseMoney('$35.50')).toBe(3550)
    expect(parseMoney('12,5')).toBe(1250)
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('abc')).toBeNull()
  })
  it('formats cents', () => {
    expect(money(4500, { currency: 'USD' })).toBe('$45')
    expect(money(4550, { currency: 'USD' })).toBe('$45.50')
    expect(money(null)).toBe('—')
  })
})

describe('csv', () => {
  it('quotes and neutralises formula injection', () => {
    const out = toCsv([{ name: '=HYPERLINK("x")', note: 'a, b', n: -5 }])
    expect(out.split('\r\n')[1]).toBe(`"'=HYPERLINK(""x"")","a, b",-5`)
  })
})

const core = (o: Partial<CoreMetrics> = {}): CoreMetrics => ({
  net_revenue_cents: 0, tickets: 0, tips_cents: 0, avg_ticket_cents: null, bookings: 0, completed: 0, cancelled: 0, no_shows: 0,
  cancellation_rate: null, no_show_rate: null, available_minutes: 0, booked_minutes: 0, utilization: null, rebooking_rate: null,
  rebooked: 0, clients_served: 0, new_clients: 0, returning_clients: 0, ...o,
})

function analytics(o: Partial<Analytics> = {}): Analytics {
  return {
    period: { from: '2026-09-08', to: '2026-10-07', days: 30, timezone: 'UTC', currency: 'USD', barber_id: null },
    summary: core(), previous: core(),
    revenue: { gross_cents: 0, discount_cents: 0, net_service_cents: 0, fees_cents: 0, gift_card_sales_cents: 0, tax_cents: 0, tips_cents: 0, refunds_cents: 0, collected_cents: 0, outstanding_cents: 0, tickets: 0, commission_cents: 0, by_method: {}, by_service: [], unpaid_completed: 0 },
    bookings: { total: 0, completed: 0, cancelled: 0, late_cancellations: 0, no_shows: 0, rescheduled: 0, upcoming: 0, walk_ins: 0, online: 0, staff: 0, from_waitlist: 0, avg_lead_time_hours: null, cancellation_rate: null, no_show_rate: null, peak_hours: [], peak_days: [], funnel: null },
    series: [],
    cut_time: { count: 0, avg_actual_minutes: null, avg_scheduled_minutes: null, efficiency: null, finished_early: 0, ran_over: 0, by_barber: [], by_service: [], by_weekday: [], by_hour: [] },
    utilization: { available_minutes: 0, booked_minutes: 0, blocked_minutes: 0, idle_minutes: 0, utilization: null, target: 85, actual_service_minutes: 0 },
    heatmap: [], barbers: [],
    clients: { served: 0, new: 0, returning: 0, rebooking_rate: null, health: {}, due: 0 },
    reviews: { average: null, count: 0, all_time_average: null, distribution: {}, trend: [], recent: [] },
    ...o,
  }
}

describe('assistant', () => {
  const barbers = [{ id: 'c', name: 'Carlos' }, { id: 'l', name: 'Luis' }]
  it('parses intents, periods and barbers', () => {
    expect(parseQuestion('How much did we make last month?', 'UTC', barbers)).toMatchObject({ intent: 'revenue', periodLabel: 'last month' })
    expect(parseQuestion('Which barber generated the most revenue?', 'UTC', barbers).intent).toBe('top_barber')
    expect(parseQuestion('What is our busiest day?', 'UTC', barbers).intent).toBe('busiest_day')
    expect(parseQuestion("Who hasn't returned in more than 30 days?", 'UTC', barbers)).toMatchObject({ intent: 'lapsed_clients', days: 30, needsClients: true })
    expect(parseQuestion('What services make us the most money?', 'UTC', barbers).intent).toBe('top_services')
    expect(parseQuestion('How much did Carlos earn?', 'UTC', barbers)).toMatchObject({ intent: 'barber_earnings', barberId: 'c' })
    expect(parseQuestion('What is our average haircut time?', 'UTC', barbers).intent).toBe('avg_cut_time')
    expect(parseQuestion('Why was revenue lower this month?', 'UTC', barbers)).toMatchObject({ intent: 'revenue_change', periodLabel: 'this month' })
    expect(parseQuestion('Who has the highest rebooking rate?', 'UTC', barbers).intent).toBe('top_rebooking')
  })
  it('resolves last month to the previous calendar month', () => {
    const p = parsePeriod('last month', 'UTC')
    expect(p.from.endsWith('-01')).toBe(true)
    expect(p.to >= p.from).toBe(true)
  })
  it('never invents numbers when there is no data', () => {
    const p = parseQuestion('How much did we make last month?', 'UTC', barbers)
    const a = composeAnswer(p, analytics())
    expect(a.noData).toBe(true)
    expect(a.text).toMatch(/No payments/)
  })
  it('answers from data', () => {
    const p = parseQuestion('Which barber generated the most revenue?', 'UTC', barbers)
    const a = composeAnswer(p, analytics({
      barbers: [
        { barber_id: 'c', name: 'Carlos', net_revenue_cents: 120000, cuts: 30, can_view_money: true } as never,
        { barber_id: 'l', name: 'Luis', net_revenue_cents: 90000, cuts: 25, can_view_money: true } as never,
      ],
    }))
    expect(a.text).toContain('Carlos')
    expect(a.text).toContain('$1,200')
  })
  it('lists lapsed clients beyond a threshold', () => {
    const p = parseQuestion("Who hasn't returned in more than 30 days?", 'UTC', barbers)
    const rows = [
      { id: '1', first_name: 'John', last_name: 'D', visits: 4, next_appointment: null, days_since_last: 42, cadence_days: 28, is_due: true },
      { id: '2', first_name: 'Mike', last_name: null, visits: 2, next_appointment: null, days_since_last: 12, cadence_days: 21, is_due: false },
    ] as never
    const a = composeAnswer(p, null, rows)
    expect(a.list?.map((x) => x.title)).toEqual(['John D'])
  })
})

describe('insights', () => {
  it('merges consecutive hours into ranges', () => {
    expect(hourRanges([16, 14, 15, 9])).toEqual([{ start: 9, end: 10 }, { start: 14, end: 17 }])
  })
  it('stays silent without enough data', () => {
    expect(generateInsights(analytics())).toEqual([])
  })
  it('flags peak capacity windows and over-long slots', () => {
    const heat = [14, 15, 16].map((h) => ({ dow: 6, hour: h, available_minutes: 60 * 3 * 4, booked_minutes: 0, utilization: 96 }))
    const out = generateInsights(analytics({
      heatmap: heat,
      cut_time: { count: 40, avg_actual_minutes: 38, avg_scheduled_minutes: 45, efficiency: 118, finished_early: 30, ran_over: 2, by_barber: [], by_service: [], by_weekday: [], by_hour: [] },
      utilization: { available_minutes: 2 * 30 * 480, booked_minutes: 0, blocked_minutes: 0, idle_minutes: 0, utilization: 70, target: 85, actual_service_minutes: 0 },
      barbers: [{}, {}] as never,
    }))
    const titles = out.map((i) => i.title)
    expect(titles.some((t) => t.startsWith('Saturday 2 PM–5 PM is consistently at 96%+'))).toBe(true)
    expect(titles.some((t) => t.includes('Cuts take 38 min on average, but you book 45-minute slots'))).toBe(true)
  })
})
