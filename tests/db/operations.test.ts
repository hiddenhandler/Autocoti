import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, buildShop, expectError, localDate, localTs, pgArray, pool, service, sql } from './helpers'

let s: Awaited<ReturnType<typeof buildShop>>
let today: string

beforeAll(async () => {
  s = await buildShop()
  today = await localDate(s.tz, 0)
})
afterAll(() => pool.end())

const newClient = (n: string) => JSON.stringify({ first_name: n, phone: `555${Math.random().toString().slice(2, 9)}`, email: `${n}${Math.random().toString().slice(2, 6)}@x.dev` })

async function pastAppointment(barber: string, hoursAgo: number, service = s.haircut, name = 'Client') {
  const start = new Date(Date.now() - hoursAgo * 3600e3)
  start.setSeconds(0, 0)
  const r = await s.owner.rpc('staff_create_appointment', {
    p_shop_id: s.shopId, p_barber_id: barber, p_service_ids: pgArray([service]), p_starts_at: start.toISOString(),
    p_client: newClient(name), p_force: true,
  })
  return r.appointment_id as string
}

describe('haircut timer & checkout', () => {
  it('START CUT → FINISH CUT records actual vs scheduled duration', async () => {
    const id = await pastAppointment(s.carlos, 2)
    await s.carlosUser.rpc('start_cut', { p_appointment_id: id })
    let [a] = await sql(`select status, actual_started_at from appointments where id = $1`, [id])
    expect(a.status).toBe('IN_SERVICE')
    // Simulate a 37 minute cut
    await sql(`update appointments set actual_started_at = now() - interval '37 minutes' where id = $1`, [id])
    const res = await s.carlosUser.rpc('finish_cut', { p_appointment_id: id })
    expect(res.scheduled_minutes).toBe(45)
    expect(Math.round(res.actual_seconds / 60)).toBe(37)
    expect(res.rebook_weeks).toBe(3)
    ;[a] = await sql(`select status, actual_duration_seconds, payment_status from appointments where id = $1`, [id])
    expect(a.status).toBe('COMPLETED')
    expect(Math.round(a.actual_duration_seconds / 60)).toBe(37)
    expect(a.payment_status).toBe('UNPAID') // payment missing is visible, never blocks the barber
    const history = await sql(`select to_status from appointment_status_history where appointment_id = $1 order by id`, [id])
    expect(history.map((h) => h.to_status)).toEqual(['BOOKED', 'IN_SERVICE', 'COMPLETED'])
  })

  it('prevents a barber from running two cuts at once and blocks invalid transitions', async () => {
    const a1 = await pastAppointment(s.luis, 5)
    const a2 = await pastAppointment(s.luis, 4)
    await s.luisUser.rpc('start_cut', { p_appointment_id: a1 })
    await expectError(s.luisUser.rpc('start_cut', { p_appointment_id: a2 }), 'BARBER_BUSY')
    await s.luisUser.rpc('finish_cut', { p_appointment_id: a1 })
    await expectError(s.luisUser.rpc('set_appointment_status', { p_appointment_id: a1, p_status: 'BOOKED' }), 'INVALID_STATUS_TRANSITION')
    await s.luisUser.rpc('set_appointment_status', { p_appointment_id: a2, p_status: 'NO_SHOW' })
  })

  it('checkout: price, tip, discount, tax, commission split — tips tracked separately', async () => {
    await s.owner.q(`update shop_settings set tax_rate_bps = 0 where shop_id = $1`, [s.shopId])
    const id = await pastAppointment(s.carlos, 3)
    await s.carlosUser.rpc('start_cut', { p_appointment_id: id })
    const pay = await s.carlosUser.rpc('record_payment', {
      p_appointment_id: id, p_items: JSON.stringify([{ service_id: s.haircut, description: 'Haircut', price_cents: 3500 }]),
      p_tip_cents: 1000, p_discount_cents: 0, p_method: 'cash',
    })
    expect(pay).toMatchObject({ subtotal_cents: 3500, tip_cents: 1000, total_cents: 4500, status: 'PAID', commission_cents: 1750 })
    const [e] = await sql(`select * from barber_earnings where payment_id = $1`, [pay.payment_id])
    expect(Number(e.commission_cents)).toBe(1750) // 50% of $35
    expect(Number(e.shop_cents)).toBe(1750)
    expect(Number(e.tip_cents)).toBe(1000) // tips go to the barber
    const [t] = await sql(`select amount_cents from tips where payment_id = $1`, [pay.payment_id])
    expect(Number(t.amount_cents)).toBe(1000)
    const [a] = await sql(`select status, payment_status, actual_finished_at from appointments where id = $1`, [id])
    expect(a.status).toBe('COMPLETED') // checkout from IN_SERVICE stops the timer
    expect(a.actual_finished_at).not.toBeNull()
    await expectError(s.carlosUser.rpc('record_payment', {
      p_appointment_id: id, p_items: JSON.stringify([{ description: 'Again', price_cents: 1 }]),
    }), 'ALREADY_PAID')
  })

  it('tax, promo codes, partial payments, refunds and voids keep the books consistent', async () => {
    await s.owner.q(`update shop_settings set tax_rate_bps = 800 where shop_id = $1`, [s.shopId])
    await s.owner.q(`insert into promo_codes (shop_id, code, discount_type, discount_value) values ($1, 'WELCOME10', 'percent', 1000)`, [s.shopId])
    const id = await pastAppointment(s.luis, 6)
    const pay = await s.owner.rpc('record_payment', {
      p_appointment_id: id, p_items: JSON.stringify([{ service_id: s.haircut, description: 'Haircut', price_cents: 4000 }]),
      p_tip_cents: 500, p_method: 'card', p_promo_code: 'welcome10', p_amount_paid_cents: 3000,
    })
    // 4000 - 400 promo = 3600 net; tax 8% = 288; + 500 tip = 4388
    expect(pay).toMatchObject({ discount_cents: 400, tax_cents: 288, total_cents: 4388, status: 'PARTIAL', commission_cents: 1620 })
    await s.owner.rpc('settle_payment', { p_payment_id: pay.payment_id, p_amount_cents: 1388 })
    let [p] = await sql(`select status from payments where id = $1`, [pay.payment_id])
    expect(p.status).toBe('PAID')
    await s.owner.rpc('refund_payment', { p_payment_id: pay.payment_id, p_amount_cents: 4388, p_reason: 'Unhappy' })
    ;[p] = await sql(`select status, refunded_cents from payments where id = $1`, [pay.payment_id])
    expect(p.status).toBe('REFUNDED')
    const [sum] = await sql(`select sum(commission_cents)::int c, sum(service_revenue_cents)::int r from barber_earnings where payment_id = $1`, [pay.payment_id])
    expect(sum.c).toBe(0)
    expect(sum.r).toBe(0)
    await expectError(s.luisUser.rpc('refund_payment', { p_payment_id: pay.payment_id, p_amount_cents: 1 }), 'FORBIDDEN')
    await s.owner.q(`update shop_settings set tax_rate_bps = 0 where shop_id = $1`, [s.shopId])
  })

  it('tiered commission is marginal on month-to-date revenue', async () => {
    await s.owner.rpc('set_commission', {
      p_barber_id: s.luis, p_type: 'tiered',
      p_tiers: JSON.stringify([{ up_to_cents: 5000, percent_bps: 4000 }, { up_to_cents: null, percent_bps: 6000 }]),
    })
    const [{ mtd }] = await sql(`select coalesce(sum(service_revenue_cents),0)::int mtd from barber_earnings where barber_id = $1
                                   and earned_at >= date_trunc('month', now() at time zone $2) at time zone $2`, [s.luis, s.tz])
    const id = await pastAppointment(s.luis, 7)
    const pay = await s.owner.rpc('record_payment', {
      p_appointment_id: id, p_items: JSON.stringify([{ service_id: s.haircut, description: 'Haircut', price_cents: 4000 }]), p_method: 'cash',
    })
    const below = Math.max(0, Math.min(4000, 5000 - mtd))
    expect(pay.commission_cents).toBe(Math.round(below * 0.4 + (4000 - below) * 0.6))
  })
})

describe('walk-in queue', () => {
  it('quotes a wait, assigns FIFO and moves the next client into the chair', async () => {
    const w1 = await s.owner.rpc('add_walk_in', { p_shop_id: s.shopId, p_name: 'Mike Walker', p_phone: '5551112222', p_service_id: s.beard })
    const w2 = await s.owner.rpc('add_walk_in', { p_shop_id: s.shopId, p_name: 'David', p_service_id: s.beard, p_preferred_barber_id: s.carlos })
    const queue = await s.owner.rows('walk_in_queue', { p_shop_id: s.shopId })
    expect(queue.map((q) => q.id)).toEqual([w1.id, w2.id])
    expect(queue[0].queue_position).toBe(1)
    const res = await s.carlosUser.rpc('call_next_walk_in', { p_barber_id: s.carlos })
    expect(res.walk_in_id).toBe(w1.id)
    const [a] = await sql(`select status, source from appointments where id = $1`, [res.appointment_id])
    expect(a).toEqual({ status: 'CHECKED_IN', source: 'walk_in' })
    const [w] = await sql(`select status from walk_ins where id = $1`, [w1.id])
    expect(w.status).toBe('serving')
  })
})

describe('waitlist', () => {
  it('offers a cancelled slot to the waitlist; first valid claim wins', async () => {
    const day = await localDate(s.tz, 2)
    // Fill Luis's whole day so the waitlist is needed
    const slots = await anon.rows('get_available_slots', { p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_date: day, p_barber_id: s.luis })
    expect(slots.length).toBeGreaterThan(0)
    let cancelToken = ''
    for (let i = 0; i < 30; i++) {
      const free = await anon.rows('get_available_slots', { p_shop_id: s.shopId, p_service_ids: pgArray([s.beard]), p_date: day, p_barber_id: s.luis })
      if (!free.length) break
      const r = await anon.rpc('book_appointment', { p_shop_id: s.shopId, p_service_ids: pgArray([s.beard]), p_starts_at: free[0].starts_at, p_barber_id: s.luis, p_client: newClient(`Fill${i}`) })
      if (i === 3) cancelToken = r.manage_token
    }
    expect(await anon.rows('get_available_slots', { p_shop_id: s.shopId, p_service_ids: pgArray([s.beard]), p_date: day, p_barber_id: s.luis })).toEqual([])

    const w1 = await anon.rpc('join_waitlist', { p_shop_id: s.shopId, p_service_id: s.beard, p_date: day, p_barber_id: s.luis, p_client: newClient('Wait1') })
    const w2 = await anon.rpc('join_waitlist', { p_shop_id: s.shopId, p_service_id: s.beard, p_date: day, p_client: newClient('Wait2') })
    await anon.rpc('cancel_booking', { p_token: cancelToken })

    const o1 = await anon.rpc('get_waitlist_offer', { p_token: w1.token })
    const o2 = await anon.rpc('get_waitlist_offer', { p_token: w2.token })
    expect(o1.status).toBe('notified')
    expect(o2.status).toBe('notified')
    const [n] = await sql(`select count(*)::int c from notifications where event = 'waitlist.slot_available' and waitlist_id in ($1, $2)`, [w1.id, w2.id])
    expect(n.c).toBe(2)

    const claim = await anon.rpc('claim_waitlist_slot', { p_token: w2.token })
    expect(claim.appointment_id).toBeTruthy()
    expect((await anon.rpc('claim_waitlist_slot', { p_token: w1.token })).error).toBe('SLOT_TAKEN')
    expect((await anon.rpc('get_waitlist_offer', { p_token: w1.token })).status).toBe('active') // back in line
  })
})

describe('analytics', () => {
  it('reports real revenue, cut time, utilization and barber performance', async () => {
    // one booking inside working hours yesterday (the timer tests above ran at night, outside hours)
    const y = await localDate(s.tz, -1)
    await s.owner.rpc('staff_create_appointment', {
      p_shop_id: s.shopId, p_barber_id: s.luis, p_service_ids: pgArray([s.haircut]), p_starts_at: await localTs(s.tz, y, '10:00'),
      p_client: newClient('Day'), p_force: true,
    })
    // two-day window so the test is independent of the time of day
    const r = await s.owner.rpc('shop_analytics', { p_shop_id: s.shopId, p_from: await localDate(s.tz, -1), p_to: today })
    expect(r.revenue.tickets).toBeGreaterThanOrEqual(2)
    expect(r.revenue.tips_cents).toBe(1500)
    expect(r.cut_time.count).toBeGreaterThanOrEqual(1)
    expect(r.cut_time.by_barber.find((x: any) => x.name === 'Carlos').avg_minutes).toBeGreaterThan(0)
    expect(r.utilization.available_minutes).toBe(2 * 2 * 8 * 60) // two barbers × two days × (9h − 1h lunch)
    expect(r.utilization.booked_minutes).toBe(40) // only time inside open hours counts
    expect(r.utilization.utilization).toBeCloseTo(2.1, 1)
    const carlos = r.barbers.find((x: any) => x.barber_id === s.carlos)
    expect(carlos.tips_cents).toBe(1000)
    expect(carlos.commission_cents).toBe(1750)
    expect(r.bookings.no_shows).toBe(1)
    expect(r.series.length).toBe(2)
  })

  it('empty periods produce empty values, not fake numbers', async () => {
    const r = await s.owner.rpc('shop_analytics', { p_shop_id: s.shopId, p_from: '2020-01-01', p_to: '2020-01-07' })
    expect(r.summary.avg_ticket_cents).toBeNull()
    expect(r.summary.rebooking_rate).toBeNull()
    expect(r.cut_time.avg_actual_minutes).toBeNull()
    expect(r.revenue.net_service_cents).toBe(0)
  })

  it('classifies client health from visit cadence', async () => {
    const [c] = await sql(`insert into clients (shop_id, first_name) values ($1, 'John') returning id`, [s.shopId])
    // visits 70, 42 days ago → cadence 28 days, 42 days since last → AT_RISK (28*1.25 < 42 <= 28*2.5)
    for (const d of [70, 42]) {
      await sql(`insert into appointments (shop_id, barber_id, client_id, starts_at, ends_at, status)
                 values ($1, $2, $3, now() - make_interval(days => $4), now() - make_interval(days => $4) + interval '45 min', 'COMPLETED')`,
        [s.shopId, s.carlos, c.id, d])
    }
    const rows = await s.owner.rows('list_clients', { p_shop_id: s.shopId, p_search: 'john' })
    const john = rows.find((x) => x.id === c.id)
    expect(john.visits).toBe(2)
    expect(john.cadence_days).toBe(28)
    expect(john.health).toBe('AT_RISK')
    expect(john.is_due).toBe(true)
    const actions = await s.owner.rpc('owner_actions', { p_shop_id: s.shopId })
    expect(actions.follow_up_clients).toBeGreaterThanOrEqual(1)
  })

  it('global search respects permissions', async () => {
    const res = await s.owner.rpc('global_search', { p_shop_id: s.shopId, p_query: 'mike' })
    expect(res.some((x: any) => x.type === 'client')).toBe(true)
    const luisSees = await s.luisUser.rpc('global_search', { p_shop_id: s.shopId, p_query: 'mike' })
    expect(luisSees.filter((x: any) => x.type === 'client')).toEqual([]) // Luis never served Mike
  })

  it('periodic jobs run as service role', async () => {
    const out = await service.rpc('run_periodic_jobs')
    expect(out).toHaveProperty('snapshots')
    const due = await service.rows('claim_due_notifications', { p_limit: 5 })
    expect(Array.isArray(due)).toBe(true)
  })
})
