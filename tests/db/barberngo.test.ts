import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, buildShop, createUser, expectError, localDate, pgArray, pool, sql } from './helpers'

afterAll(() => pool.end())

/** A fixed-offset zone where it is currently ~midday, so "now" is inside working hours. */
async function middayZone(): Promise<string> {
  const h = new Date().getUTCHours()
  const offset = ((12 - h + 36) % 24) - 12 // local = utc + offset ≈ 12:00
  // Etc/GMT signs are inverted: Etc/GMT-3 = UTC+3.
  return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`
}

const allDay = JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, starts_at: '00:00', ends_at: '23:59' })))
const client = (n: string) => JSON.stringify({ first_name: n, phone: `809${Math.floor(1e6 + Math.random() * 8e6)}` })

async function apptAt(s: Awaited<ReturnType<typeof buildShop>>, barber: string, minutesFromNow: number, service = s.haircut) {
  const start = new Date(Date.now() + minutesFromNow * 60e3)
  start.setSeconds(0, 0)
  const r = await s.owner.rpc('staff_create_appointment', {
    p_shop_id: s.shopId, p_barber_id: barber, p_service_ids: pgArray([service]), p_starts_at: start.toISOString(),
    p_client: client('Client'), p_force: true,
  })
  return r.appointment_id as string
}

/** A completed cut with a real timer of `minutes`. */
async function timedCut(s: Awaited<ReturnType<typeof buildShop>>, barber: string, hoursAgo: number, minutes: number, service = s.haircut) {
  const id = await apptAt(s, barber, -hoursAgo * 60, service)
  await s.owner.rpc('start_cut', { p_appointment_id: id })
  await s.owner.rpc('finish_cut', { p_appointment_id: id })
  await sql(`update appointments set actual_started_at = actual_finished_at - make_interval(mins => $2) where id = $1`, [id, minutes])
  return id
}

describe('chairs, employees and chair owners', () => {
  let s: Awaited<ReturnType<typeof buildShop>>
  beforeAll(async () => {
    s = await buildShop()
  })

  it('owner manages chairs; a barber sits in one chair at a time', async () => {
    const c1 = await s.owner.rpc('save_chair', { p_shop_id: s.shopId, p_chair_id: null, p_label: 'Chair 01', p_barber_id: s.carlos })
    const c2 = await s.owner.rpc('save_chair', { p_shop_id: s.shopId, p_chair_id: null, p_label: 'Chair 02', p_barber_id: null })
    await s.owner.rpc('save_chair', { p_shop_id: s.shopId, p_chair_id: c2, p_label: 'Chair 02', p_barber_id: s.carlos })
    const rows = await sql(`select id, barber_id from chairs where shop_id = $1 order by position`, [s.shopId])
    expect(rows.find((r) => r.id === c1)!.barber_id).toBeNull()
    expect(rows.find((r) => r.id === c2)!.barber_id).toBe(s.carlos)
    await expectError(s.owner.rpc('save_chair', { p_shop_id: s.shopId, p_chair_id: null, p_label: 'chair 01' }), 'CHAIR_LABEL_TAKEN')
    await expectError(s.carlosUser.rpc('save_chair', { p_shop_id: s.shopId, p_chair_id: null, p_label: 'Mine' }), 'FORBIDDEN')
    // Barbers see the board, anon sees nothing
    expect((await s.luisUser.q(`select id from chairs`)).length).toBe(2)
    await expectError(anon.q(`select id from chairs`), /permission denied/)
  })

  it('a chair owner keeps 100% of services and tips; the shop tracks rent separately', async () => {
    await s.owner.rpc('set_barber_type', { p_barber_id: s.luis, p_type: 'chair_owner', p_rent_cents: 10000, p_rent_period: 'week' })
    const [b] = await sql(`select barber_type from barbers where id = $1`, [s.luis])
    expect(b.barber_type).toBe('chair_owner')
    const id = await apptAt(s, s.luis, -120)
    const pay = await s.luisUser.rpc('record_payment', {
      p_appointment_id: id, p_items: JSON.stringify([{ service_id: s.haircut, description: 'Haircut', price_cents: 4000 }]), p_tip_cents: 500,
    })
    expect(pay.commission_cents).toBe(4000)
    const [e] = await sql(`select commission_cents, tip_cents, shop_cents from barber_earnings where payment_id = $1`, [pay.payment_id])
    expect([Number(e.commission_cents), Number(e.tip_cents), Number(e.shop_cents)]).toEqual([4000, 500, 0])

    const ledger = await s.owner.rows('rent_ledger', { p_shop_id: s.shopId })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ barber_id: s.luis, period: 'week', amount_cents: '10000', paid_cents: '0' })
    // Generating again is idempotent
    expect(await s.owner.rows('rent_ledger', { p_shop_id: s.shopId })).toHaveLength(1)

    await s.owner.rpc('record_rent_payment', { p_charge_id: ledger[0].id, p_amount_cents: 6000, p_method: 'transfer' })
    await expectError(s.owner.rpc('record_rent_payment', { p_charge_id: ledger[0].id, p_amount_cents: 5000 }), 'INVALID_AMOUNT')
    await expectError(s.luisUser.rpc('record_rent_payment', { p_charge_id: ledger[0].id, p_amount_cents: 100 }), 'FORBIDDEN')
    const mine = await s.luisUser.rows('rent_ledger', { p_shop_id: s.shopId, p_barber_id: s.luis })
    expect(mine[0]).toMatchObject({ balance_cents: '4000', paid_cents: '6000' })
    await expectError(s.carlosUser.rows('rent_ledger', { p_shop_id: s.shopId, p_barber_id: s.luis }), 'FORBIDDEN')
    await expectError(s.carlosUser.rows('rent_ledger', { p_shop_id: s.shopId }), 'FORBIDDEN')
  })

  it('chair owners set their own prices and create private services; employees follow shop rules', async () => {
    await s.luisUser.rpc('set_my_service_price', { p_barber_id: s.luis, p_service_id: s.beard, p_price_cents: 2500, p_duration_minutes: 25 })
    const [bs] = await sql(`select price_cents, duration_minutes from barber_services where barber_id = $1 and service_id = $2`, [s.luis, s.beard])
    expect([Number(bs.price_cents), bs.duration_minutes]).toEqual([2500, 25])
    await expectError(s.carlosUser.rpc('set_my_service_price', { p_barber_id: s.carlos, p_service_id: s.beard, p_price_cents: 1 }), 'FORBIDDEN')
    await s.owner.q(`update shop_settings set barbers_can_set_prices = true where shop_id = $1`, [s.shopId])
    await s.carlosUser.rpc('set_my_service_price', { p_barber_id: s.carlos, p_service_id: s.beard, p_price_cents: 2200 })
    await s.owner.q(`update shop_settings set barbers_can_set_prices = false where shop_id = $1`, [s.shopId])

    const svc = await s.luisUser.rpc('save_my_service', {
      p_barber_id: s.luis, p_service_id: null, p_name: 'Luis Signature Fade', p_price_cents: 6000, p_duration_minutes: 50,
    })
    const quote = await sql(`select * from app.barber_service_quote($1, $2)`, [s.luis, pgArray([svc])])
    expect(Number(quote[0].price_cents)).toBe(6000)
    await expectError(s.carlosUser.rpc('set_barber_services', { p_barber_id: s.carlos, p_service_ids: pgArray([s.haircut, svc]) }), 'SERVICE_NOT_IN_SHOP')
    await expectError(s.carlosUser.rpc('save_my_service', {
      p_barber_id: s.carlos, p_service_id: null, p_name: 'Nope', p_price_cents: 1, p_duration_minutes: 10,
    }), 'FORBIDDEN')

    // Schedule control: the shop can lock employees' hours; chair owners always manage their own.
    await s.owner.q(`update shop_settings set employees_manage_schedule = false where shop_id = $1`, [s.shopId])
    await expectError(s.carlosUser.rpc('set_weekly_schedule', { p_barber_id: s.carlos, p_rows: '[]' }), 'FORBIDDEN')
    await expectError(s.carlosUser.q(`insert into availability (barber_id, weekday, starts_at, ends_at) values ($1, 1, '08:00', '09:00')`, [s.carlos]), /row-level security/)
    await s.luisUser.rpc('set_weekly_schedule', { p_barber_id: s.luis, p_rows: allDay })
    await s.owner.q(`update shop_settings set employees_manage_schedule = true where shop_id = $1`, [s.shopId])
  })
})

describe('inventory & finance', () => {
  let s: Awaited<ReturnType<typeof buildShop>>
  let today: string
  let pomade: string
  let oil: string
  beforeAll(async () => {
    s = await buildShop()
    today = await localDate(s.tz)
    await s.owner.rpc('set_barber_type', { p_barber_id: s.luis, p_type: 'chair_owner', p_rent_cents: 10000, p_rent_period: 'week' })
  })

  it('shop stock is managed by the owner; a chair owner runs a private inventory', async () => {
    pomade = await s.owner.rpc('save_product', {
      p_shop_id: s.shopId, p_product_id: null, p_name: 'Matte Pomade', p_cost_cents: 600, p_price_cents: 1500, p_initial_qty: 10, p_low_stock_at: 3,
    })
    await expectError(s.carlosUser.rpc('save_product', { p_shop_id: s.shopId, p_product_id: null, p_name: 'Hack' }), 'FORBIDDEN')
    oil = await s.luisUser.rpc('save_product', {
      p_shop_id: s.shopId, p_product_id: null, p_name: 'Beard Oil', p_owner_barber_id: s.luis, p_cost_cents: 400, p_price_cents: 1200, p_initial_qty: 5,
    })
    await expectError(s.carlosUser.rpc('save_product', {
      p_shop_id: s.shopId, p_product_id: null, p_name: 'Not mine', p_owner_barber_id: s.luis,
    }), 'FORBIDDEN')

    // Privacy: the chair owner's stock is invisible to the shop owner and other barbers.
    expect((await s.owner.q(`select id from products`)).map((r) => r.id)).toEqual([pomade])
    expect((await s.carlosUser.q(`select id from products`)).map((r) => r.id)).toEqual([pomade])
    expect((await s.luisUser.q(`select id from products order by name`)).map((r) => r.id).sort()).toEqual([oil, pomade].sort())
    expect(await s.owner.q(`select id from inventory_movements where product_id = $1`, [oil])).toHaveLength(0)
    // No write policies: direct updates touch nothing, stock only moves through RPCs.
    expect(await s.owner.q(`update products set stock_qty = 999 where id = $1 returning id`, [pomade])).toHaveLength(0)
    const after = await sql(`select stock_qty from products where id = $1`, [pomade])
    expect(after[0].stock_qty).toBe(10)

    // Movements: any barber logs back-bar use of shop stock; counts set the absolute number.
    expect(await s.carlosUser.rpc('move_stock', { p_product_id: pomade, p_kind: 'use', p_qty: 1 })).toBe(9)
    expect(await s.owner.rpc('move_stock', { p_product_id: pomade, p_kind: 'count', p_qty: 10 })).toBe(10)
    await expectError(s.owner.rpc('move_stock', { p_product_id: pomade, p_kind: 'waste', p_qty: 11 }), 'OUT_OF_STOCK')
    await expectError(s.carlosUser.rpc('move_stock', { p_product_id: oil, p_kind: 'use', p_qty: 1 }), 'FORBIDDEN')
  })

  it('product sales move stock and split money: own products 100%, shop products on commission', async () => {
    const shopSale = await s.carlosUser.rpc('sell_products', {
      p_shop_id: s.shopId, p_barber_id: s.carlos, p_items: JSON.stringify([{ product_id: pomade, quantity: 2 }]),
    })
    expect(shopSale.total_cents).toBe(3000)
    const [e1] = await sql(`select kind, product_revenue_cents, product_cents, shop_cents from barber_earnings where payment_id = $1`, [shopSale.payment_id])
    expect(e1).toMatchObject({ kind: 'product', product_revenue_cents: '3000', product_cents: '300', shop_cents: '2700' })

    const ownSale = await s.luisUser.rpc('sell_products', {
      p_shop_id: s.shopId, p_barber_id: s.luis, p_items: JSON.stringify([{ product_id: oil, quantity: 1 }]),
    })
    const [e2] = await sql(`select kind, product_cents, shop_cents from barber_earnings where payment_id = $1`, [ownSale.payment_id])
    expect(e2).toMatchObject({ kind: 'product_own', product_cents: '1200', shop_cents: '0' })

    await expectError(s.carlosUser.rpc('sell_products', {
      p_shop_id: s.shopId, p_barber_id: s.carlos, p_items: JSON.stringify([{ product_id: oil, quantity: 1 }]),
    }), 'PRODUCT_NOT_YOURS')
    await expectError(s.carlosUser.rpc('sell_products', {
      p_shop_id: s.shopId, p_barber_id: s.carlos, p_items: JSON.stringify([{ product_id: pomade, quantity: 50 }]),
    }), 'OUT_OF_STOCK')
    // The failed sale left nothing behind
    expect((await sql(`select stock_qty from products where id = $1`, [pomade]))[0].stock_qty).toBe(8)

    // Voiding a wrong sale puts the item back on the shelf.
    const oops = await s.luisUser.rpc('sell_products', {
      p_shop_id: s.shopId, p_barber_id: s.luis, p_items: JSON.stringify([{ product_id: oil, quantity: 2 }]),
    })
    expect((await sql(`select stock_qty from products where id = $1`, [oil]))[0].stock_qty).toBe(2)
    await s.luisUser.rpc('void_payment', { p_payment_id: oops.payment_id, p_reason: 'wrong item' })
    expect((await sql(`select stock_qty from products where id = $1`, [oil]))[0].stock_qty).toBe(4)
    expect(await sql(`select 1 from barber_earnings where payment_id = $1`, [oops.payment_id])).toHaveLength(0)

    // Product sales never count as service revenue.
    const a = await s.owner.rpc('shop_analytics', { p_shop_id: s.shopId, p_from: today, p_to: today })
    expect(a.summary.net_revenue_cents).toBe(0)
  })

  it('expenses are private to their business; finance adds up for the shop and for a chair owner', async () => {
    // Services: Carlos (employee, 50%) $35 · Luis (chair owner) $40 + $5 tip
    const c = await apptAt(s, s.carlos, -180)
    await s.carlosUser.rpc('record_payment', { p_appointment_id: c, p_items: JSON.stringify([{ service_id: s.haircut, description: 'Haircut', price_cents: 3500 }]) })
    const l = await apptAt(s, s.luis, -180)
    await s.luisUser.rpc('record_payment', {
      p_appointment_id: l, p_items: JSON.stringify([{ service_id: s.haircut, description: 'Haircut', price_cents: 4000 }]), p_tip_cents: 500,
    })
    const [charge] = await s.owner.rows('rent_ledger', { p_shop_id: s.shopId })
    await s.owner.rpc('record_rent_payment', { p_charge_id: charge.id, p_amount_cents: 6000 })

    await s.owner.q(`insert into expenses (shop_id, category, amount_cents, spent_on, created_by) values ($1, 'utilities', 2500, $2, $3)`, [s.shopId, today, s.owner.id])
    await s.luisUser.q(`insert into expenses (shop_id, barber_id, category, amount_cents, spent_on, created_by) values ($1, $2, 'supplies', 800, $3, $4)`, [s.shopId, s.luis, today, s.luisUser.id])
    await expectError(s.carlosUser.q(`insert into expenses (shop_id, category, amount_cents, spent_on, created_by) values ($1, 'other', 1, $2, $3)`, [s.shopId, today, s.carlosUser.id]), /row-level/)
    await expectError(s.carlosUser.q(`insert into expenses (shop_id, barber_id, category, amount_cents, spent_on, created_by) values ($1, $2, 'other', 1, $3, $4)`, [s.shopId, s.luis, today, s.carlosUser.id]), /row-level/)
    expect((await s.owner.q(`select amount_cents from expenses`)).map((r) => Number(r.amount_cents))).toEqual([2500])
    expect((await s.luisUser.q(`select amount_cents from expenses`)).map((r) => Number(r.amount_cents))).toEqual([800])
    expect(await s.carlosUser.q(`select amount_cents from expenses`)).toHaveLength(0)

    const shop = await s.owner.rpc('finance_summary', { p_shop_id: s.shopId, p_from: today, p_to: today })
    expect(shop.money_in).toEqual({ services_cents: 3500, products_cents: 3000, rent_cents: 6000, fees_cents: 0, tips_kept_cents: 0 })
    expect(shop.money_out).toEqual({ commissions_cents: 1750, product_commissions_cents: 300, inventory_cents: 6000, expenses_cents: 2500 })
    expect(shop.net_cents).toBe(12500 - 10550)
    expect(shop.pass_through.chair_owner_services_cents).toBe(4000)
    expect(shop.rent.outstanding_cents).toBe(4000)
    const carlosRow = shop.barbers.find((b: any) => b.barber_id === s.carlos)
    expect(carlosRow.payout_cents).toBe(1750 + 300)

    const luis = await s.luisUser.rpc('finance_summary', { p_shop_id: s.shopId, p_from: today, p_to: today, p_barber_id: s.luis })
    expect(luis.money_in).toEqual({ services_cents: 4000, tips_cents: 500, products_cents: 1200, product_commissions_cents: 0, gross_services_cents: 4000 })
    expect(luis.money_out).toEqual({ rent_cents: 6000, inventory_cents: 2000, expenses_cents: 800 })
    expect(luis.net_cents).toBe(5700 - 8800)
    expect(luis.rent.outstanding_cents).toBe(4000)

    // The shop owner sees the chair owner's earnings and rent, never their private costs.
    const asOwner = await s.owner.rpc('finance_summary', { p_shop_id: s.shopId, p_from: today, p_to: today, p_barber_id: s.luis })
    expect(asOwner.private).toBe(false)
    expect(asOwner.money_out).toEqual({ rent_cents: 6000, inventory_cents: 0, expenses_cents: 0 })
    await expectError(s.carlosUser.rpc('finance_summary', { p_shop_id: s.shopId, p_from: today, p_to: today, p_barber_id: s.luis }), 'FORBIDDEN')
    await expectError(s.carlosUser.rpc('finance_summary', { p_shop_id: s.shopId, p_from: today, p_to: today }), 'FORBIDDEN')
  })
})

describe('live status, public queue and smart service times', () => {
  let s: Awaited<ReturnType<typeof buildShop>>
  beforeAll(async () => {
    s = await buildShop({ tz: await middayZone() })
    for (const b of [s.carlos, s.luis]) await s.owner.rpc('set_weekly_schedule', { p_barber_id: b, p_rows: allDay })
  })

  const status = async (barber: string) => (await sql(`select app.barber_live($1) v`, [barber]))[0].v

  it('derives AVAILABLE · CUTTING · BREAK · OFFLINE · NOT_WORKING · BOOKED from the real calendar', async () => {
    expect((await status(s.carlos)).status).toBe('AVAILABLE')

    const id = await apptAt(s, s.carlos, 0)
    expect((await status(s.carlos)).status).toBe('BOOKED')
    await s.carlosUser.rpc('start_cut', { p_appointment_id: id })
    const cutting = await status(s.carlos)
    expect(cutting.status).toBe('CUTTING')
    const finishIn = (new Date(cutting.current.estimated_finish).getTime() - Date.now()) / 60e3
    expect(finishIn).toBeGreaterThan(40)
    expect(finishIn).toBeLessThan(46)
    await s.carlosUser.rpc('finish_cut', { p_appointment_id: id })
    expect((await status(s.carlos)).status).toBe('AVAILABLE')

    await s.carlosUser.rpc('set_my_presence', { p_barber_id: s.carlos, p_presence: 'break', p_minutes: 15 })
    expect((await status(s.carlos))).toMatchObject({ status: 'BREAK' })
    await s.carlosUser.rpc('set_my_presence', { p_barber_id: s.carlos, p_presence: 'offline' })
    expect((await status(s.carlos)).status).toBe('OFFLINE')
    await expectError(s.luisUser.rpc('set_my_presence', { p_barber_id: s.carlos, p_presence: 'auto' }), 'FORBIDDEN')
    await s.carlosUser.rpc('set_my_presence', { p_barber_id: s.carlos, p_presence: 'auto' })

    // Time off covering today → not working (next available is after it)
    await s.owner.q(`insert into availability_exceptions (shop_id, barber_id, kind, starts_at, ends_at) values ($1, $2, 'time_off', now() - interval '1 day', now() + interval '1 day')`, [s.shopId, s.luis])
    const off = await status(s.luis)
    expect(off.status).toBe('NOT_WORKING')
    await s.owner.q(`delete from availability_exceptions where barber_id = $1`, [s.luis])
    expect((await status(s.luis)).next_available).toBeTruthy()

    // Public live view (anon) and unpublished shops
    const live = await anon.rpc('get_shop_live', { p_slug: s.slug })
    expect(live.barbers.map((b: any) => b.status).sort()).toEqual(['AVAILABLE', 'AVAILABLE'])
    expect(live.walk_ins).toMatchObject({ enabled: true, waiting: 0, estimated_wait_minutes: 0 })
    await s.owner.q(`update shops set is_published = false where id = $1`, [s.shopId])
    expect(await anon.rpc('get_shop_live', { p_slug: s.slug })).toBeNull()
    await s.owner.q(`update shops set is_published = true where id = $1`, [s.shopId])

    const board = await s.owner.rpc('shop_live_board', { p_shop_id: s.shopId })
    expect(board.counts).toMatchObject({ working: 2, available: 2 })
    await expectError(anon.rpc('shop_live_board', { p_shop_id: s.shopId }), /NOT_AUTHENTICATED|FORBIDDEN|permission/)
  })

  it('customers join the walk-in queue without an account and follow their ticket live', async () => {
    // Both barbers are busy for the next hour
    const a1 = await apptAt(s, s.carlos, 2)
    const a2 = await apptAt(s, s.luis, 2)
    await s.carlosUser.rpc('start_cut', { p_appointment_id: a1 })
    await s.luisUser.rpc('start_cut', { p_appointment_id: a2 })

    const t1 = await anon.rpc('join_walk_in_queue', { p_shop_id: s.shopId, p_name: 'Juan Perez', p_phone: '809-555-0101', p_service_id: s.haircut })
    const t2 = await anon.rpc('join_walk_in_queue', { p_shop_id: s.shopId, p_name: 'Pedro', p_phone: '809-555-0102', p_service_id: s.haircut, p_barber_id: s.luis })
    // Rejoining with the same phone returns the same ticket
    expect((await anon.rpc('join_walk_in_queue', { p_shop_id: s.shopId, p_name: 'Juan', p_phone: '(809) 555 0101', p_service_id: s.haircut })).token).toBe(t1.token)
    await expectError(anon.rpc('join_walk_in_queue', { p_shop_id: s.shopId, p_name: 'X', p_phone: '12', p_service_id: s.haircut }), 'PHONE_REQUIRED')

    const ticket1 = await anon.rpc('get_walk_in_ticket', { p_token: t1.token })
    const ticket2 = await anon.rpc('get_walk_in_ticket', { p_token: t2.token })
    expect(ticket1).toMatchObject({ status: 'waiting', position: 1, ahead: 0, name: 'Juan' })
    expect(ticket2).toMatchObject({ position: 2, ahead: 1, preferred_barber: 'Luis' })
    expect(ticket1.estimated_wait_minutes).toBeGreaterThan(35)
    expect(ticket1.wait_low).toBeLessThan(ticket1.wait_high)
    expect((await status(s.luis)).queue_count).toBe(1)

    const joined = await sql(`select channel, to_address from notifications where event = 'queue.joined' and walk_in_id = $1`, [ticket1.id])
    expect(joined).toEqual([{ channel: 'whatsapp', to_address: '8095550101' }])

    // Carlos finishes → Juan is next; the barber calls them → "your turn"
    await s.carlosUser.rpc('finish_cut', { p_appointment_id: a1 })
    expect((await anon.rpc('get_walk_in_ticket', { p_token: t1.token })).almost_ready).toBe(true)
    expect(await sql(`select 1 from notifications where event = 'queue.almost_ready' and walk_in_id = $1`, [ticket1.id])).toHaveLength(1)
    await s.carlosUser.rpc('call_next_walk_in', { p_barber_id: s.carlos })
    const serving = await anon.rpc('get_walk_in_ticket', { p_token: t1.token })
    expect(serving.status).toBe('serving')
    expect(serving.likely_barber).toBe('Carlos')
    expect(await sql(`select 1 from notifications where event = 'queue.your_turn' and walk_in_id = $1`, [ticket1.id])).toHaveLength(1)

    await anon.rpc('leave_walk_in_queue', { p_token: t2.token })
    expect((await anon.rpc('get_walk_in_ticket', { p_token: t2.token })).status).toBe('left')
    await s.luisUser.rpc('finish_cut', { p_appointment_id: a2 })
  })

  it('learns each barber\'s real cut time and books with it', async () => {
    const before = await sql(`select * from app.barber_service_quote($1, $2)`, [s.carlos, pgArray([s.haircut])])
    expect(before[0].duration_minutes).toBe(45)
    for (let i = 0; i < 5; i++) await timedCut(s, s.carlos, 30 + i, 29 + i % 3) // ~30 min average
    const after = await sql(`select * from app.barber_service_quote($1, $2)`, [s.carlos, pgArray([s.haircut])])
    expect(after[0].duration_minutes).toBe(30)

    const stats = await s.owner.rows('service_time_stats', { p_shop_id: s.shopId, p_barber_id: s.carlos })
    const hc = stats.find((r) => r.service_id === s.haircut)
    expect(hc).toMatchObject({ default_minutes: 45, booked_minutes: 30, learned_minutes: 30, samples_30d: 5 })

    // The owner can switch learning off, and an explicit per-barber duration always wins.
    await s.owner.q(`update booking_settings set smart_durations = false where shop_id = $1`, [s.shopId])
    expect((await sql(`select * from app.barber_service_quote($1, $2)`, [s.carlos, pgArray([s.haircut])]))[0].duration_minutes).toBe(45)
    await s.owner.q(`update booking_settings set smart_durations = true where shop_id = $1`, [s.shopId])
    await s.owner.q(`update barber_services set duration_minutes = 40 where barber_id = $1 and service_id = $2`, [s.carlos, s.haircut])
    expect((await sql(`select * from app.barber_service_quote($1, $2)`, [s.carlos, pgArray([s.haircut])]))[0].duration_minutes).toBe(40)

    const ops = await s.owner.rpc('shop_operations', { p_shop_id: s.shopId, p_from: await localDate(s.tz, -2), p_to: await localDate(s.tz) })
    expect(ops.timed_cuts).toBeGreaterThanOrEqual(5)
    expect(ops.walk_ins).toBe(2)
    await expectError(s.carlosUser.rpc('shop_operations', { p_shop_id: s.shopId, p_from: '2026-01-01', p_to: '2026-01-02' }), 'FORBIDDEN')
  })

  it('the guest appointment page shows the live cut', async () => {
    const res = await anon.rpc('book_appointment', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.beard]), p_barber_id: s.luis,
      p_starts_at: new Date(Math.ceil((Date.now() + 2 * 3600e3) / 900e3) * 900e3).toISOString(), p_client: client('Ana'),
    })
    let b = await anon.rpc('get_booking', { p_token: res.manage_token })
    expect(b.status).toBe('BOOKED')
    expect(b.barber_live.status).toBeTruthy()
    expect(b.rebook_weeks).toBe(3)
    await s.luisUser.rpc('start_cut', { p_appointment_id: res.appointment_id })
    b = await anon.rpc('get_booking', { p_token: res.manage_token })
    expect(b.status).toBe('IN_SERVICE')
    expect(b.actual_started_at).toBeTruthy()
    expect(b.estimated_finish).toBeTruthy()
    await s.luisUser.rpc('finish_cut', { p_appointment_id: res.appointment_id })
    b = await anon.rpc('get_booking', { p_token: res.manage_token })
    expect(b.status).toBe('COMPLETED')
    expect(b.review_token).toBeTruthy()
  })

  it('an unrelated user sees nothing of another shop\'s finances or inventory', async () => {
    const stranger = await createUser('Stranger')
    expect(await stranger.q(`select id from products`)).toHaveLength(0)
    expect(await stranger.q(`select id from expenses`)).toHaveLength(0)
    expect(await stranger.q(`select id from rent_charges`)).toHaveLength(0)
    await expectError(stranger.rpc('finance_summary', { p_shop_id: s.shopId, p_from: '2026-01-01', p_to: '2026-01-02' }), 'FORBIDDEN')
    await expectError(stranger.rpc('shop_live_board', { p_shop_id: s.shopId }), 'FORBIDDEN')
  })
})
