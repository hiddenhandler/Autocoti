import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, buildShop, createUser, emailOf, expectError, localDate, localTs, pgArray, pool, sql } from './helpers'

let a: Awaited<ReturnType<typeof buildShop>>
let b: Awaited<ReturnType<typeof buildShop>>
let apptCarlos: string
let apptLuis: string

beforeAll(async () => {
  a = await buildShop()
  b = await buildShop()
  const day = await localDate(a.tz, 0)
  // Two appointments earlier today (staff can create them in the past), completed & paid.
  const mk = async (barber: string, t: string, name: string) =>
    (await a.owner.rpc('staff_create_appointment', {
      p_shop_id: a.shopId, p_barber_id: barber, p_service_ids: pgArray([a.haircut]),
      p_starts_at: await localTs(a.tz, day, t), p_client: JSON.stringify({ first_name: name, phone: `555${Math.random().toString().slice(2, 9)}` }),
      p_force: true,
    })).appointment_id
  apptCarlos = await mk(a.carlos, '00:05', 'Ana')
  apptLuis = await mk(a.luis, '00:10', 'Ben')
})
afterAll(() => pool.end())

describe('tenant isolation', () => {
  it('anon has no direct table access at all', async () => {
    for (const t of ['shops', 'clients', 'appointments', 'payments', 'barbers', 'services', 'audit_logs']) {
      await expectError(anon.q(`select * from ${t} limit 1`), 'permission denied')
    }
  })

  it('an owner cannot see or touch another shop', async () => {
    expect(await b.owner.q(`select id from clients where shop_id = $1`, [a.shopId])).toEqual([])
    expect(await b.owner.q(`select id from appointments where shop_id = $1`, [a.shopId])).toEqual([])
    expect(await b.owner.q(`select id from shops where id = $1`, [a.shopId])).toEqual([])
    const upd = await b.owner.q(`update services set price_cents = 1 where shop_id = $1 returning id`, [a.shopId])
    expect(upd).toEqual([])
    await expectError(b.owner.rpc('shop_analytics', { p_shop_id: a.shopId, p_from: '2026-01-01', p_to: '2026-01-31' }), 'FORBIDDEN')
    await expectError(b.owner.rpc('start_cut', { p_appointment_id: apptCarlos }), 'FORBIDDEN')
    await expectError(
      b.owner.q(`insert into barbers (shop_id, display_name) values ($1, 'Intruder')`, [a.shopId]),
      'row-level security',
    )
  })

  it('a barber cannot be booked into another shop', async () => {
    await expectError(b.owner.rpc('staff_create_appointment', {
      p_shop_id: b.shopId, p_barber_id: a.carlos, p_service_ids: pgArray([b.haircut]),
      p_starts_at: new Date(Date.now() + 864e5).toISOString(), p_client: JSON.stringify({ first_name: 'X' }),
    }), /BARBER_NOT_IN_SHOP|FORBIDDEN/)
  })
})

describe('barber data isolation', () => {
  it('a barber sees only their own appointments', async () => {
    const rows = await a.carlosUser.q(`select id, barber_id from appointments where shop_id = $1`, [a.shopId])
    expect(rows.every((r) => r.barber_id === a.carlos)).toBe(true)
    expect(rows.map((r) => r.id)).toContain(apptCarlos)
    expect(rows.map((r) => r.id)).not.toContain(apptLuis)
  })

  it("a barber cannot run another barber's cut or record their payment by changing an id", async () => {
    await expectError(a.carlosUser.rpc('start_cut', { p_appointment_id: apptLuis }), 'FORBIDDEN')
    await expectError(a.carlosUser.rpc('record_payment', {
      p_appointment_id: apptLuis, p_items: JSON.stringify([{ description: 'Haircut', price_cents: 1 }]),
    }), 'FORBIDDEN')
  })

  it("a barber cannot write financial tables directly or read others' earnings", async () => {
    await a.carlosUser.rpc('record_payment', {
      p_appointment_id: apptCarlos, p_items: JSON.stringify([{ service_id: a.haircut, description: 'Haircut', price_cents: 3500 }]),
      p_tip_cents: 500, p_method: 'cash',
    })
    await a.luisUser.rpc('record_payment', {
      p_appointment_id: apptLuis, p_items: JSON.stringify([{ service_id: a.haircut, description: 'Haircut', price_cents: 4000 }]),
      p_method: 'card',
    })
    await expectError(
      a.carlosUser.q(`insert into payments (shop_id, barber_id, subtotal_cents, total_cents) values ($1,$2,100,100)`, [a.shopId, a.luis]),
      'row-level security',
    )
    const upd = await a.carlosUser.q(`update payments set subtotal_cents = 999999 where barber_id = $1 returning id`, [a.luis])
    expect(upd).toEqual([])
    const earn = await a.carlosUser.q(`select barber_id from barber_earnings where shop_id = $1`, [a.shopId])
    expect(earn.length).toBeGreaterThan(0)
    expect(earn.every((r) => r.barber_id === a.carlos)).toBe(true)
    const tips = await a.carlosUser.q(`select barber_id from tips where shop_id = $1`, [a.shopId])
    expect(tips.every((r) => r.barber_id === a.carlos)).toBe(true)
    // Shop-wide reports are owner territory
    await expectError(a.carlosUser.rpc('shop_analytics', { p_shop_id: a.shopId, p_from: '2026-01-01', p_to: '2026-01-31' }), 'FORBIDDEN')
    // …but a barber can see their own analytics
    const mine = await a.carlosUser.rpc('shop_analytics', { p_shop_id: a.shopId, p_from: '2026-01-01', p_to: '2026-01-31', p_barber_id: a.carlos })
    expect(mine.period.barber_id).toBe(a.carlos)
    await expectError(a.carlosUser.rpc('shop_analytics', { p_shop_id: a.shopId, p_from: '2026-01-01', p_to: '2026-01-31', p_barber_id: a.luis }), 'FORBIDDEN')
  })

  it('a barber cannot change commissions, services prices or other barbers', async () => {
    await expectError(a.carlosUser.rpc('set_commission', { p_barber_id: a.carlos, p_type: 'percentage', p_percent_bps: 10000 }), 'FORBIDDEN')
    expect(await a.carlosUser.q(`update services set price_cents = 1 where shop_id = $1 returning id`, [a.shopId])).toEqual([])
    expect(await a.carlosUser.q(`update barbers set status = 'suspended' where id = $1 returning id`, [a.luis])).toEqual([])
    // own availability: allowed; others': not
    await a.carlosUser.rpc('set_weekly_schedule', { p_barber_id: a.carlos, p_rows: JSON.stringify([{ weekday: 1, starts_at: '10:00', ends_at: '19:00' }]) })
    await expectError(a.carlosUser.rpc('set_weekly_schedule', { p_barber_id: a.luis, p_rows: '[]' }), 'FORBIDDEN')
  })

  it('private client notes are visible only to the author and the owner', async () => {
    const [c] = await sql(`select client_id from appointments where id = $1`, [apptCarlos])
    await a.carlosUser.q(
      `insert into client_notes (shop_id, client_id, author_id, barber_id, body, visibility) values ($1,$2,$3,$4,'Low fade, #2 on top','private')`,
      [a.shopId, c.client_id, a.carlosUser.id, a.carlos],
    )
    expect((await a.carlosUser.q(`select body from client_notes where client_id = $1`, [c.client_id])).length).toBe(1)
    expect((await a.owner.q(`select body from client_notes where client_id = $1`, [c.client_id])).length).toBe(1)
    expect((await a.luisUser.q(`select body from client_notes where client_id = $1`, [c.client_id])).length).toBe(0)
    // Luis never served this client → cannot see the client at all
    expect((await a.luisUser.q(`select id from clients where id = $1`, [c.client_id])).length).toBe(0)
  })
})

describe('roles & invitations', () => {
  it('receptionist: calendar + clients + checkout, but no reports or settings', async () => {
    const rec = await createUser('Rita')
    const token = await a.owner.rpc('invite_staff', { p_shop_id: a.shopId, p_email: await emailOf(rec), p_role: 'receptionist' })
    await rec.rpc('accept_invitation', { p_token: token })
    const ws = await rec.rows('my_workspaces')
    expect(ws[0].role).toBe('receptionist')
    expect(ws[0].permissions).toContain('calendar.all')
    expect(ws[0].permissions).not.toContain('reports.shop')
    expect((await rec.q(`select id from appointments where shop_id = $1`, [a.shopId])).length).toBeGreaterThanOrEqual(2)
    await expectError(rec.rpc('shop_analytics', { p_shop_id: a.shopId, p_from: '2026-01-01', p_to: '2026-01-02' }), 'FORBIDDEN')
    expect(await rec.q(`update booking_settings set buffer_minutes = 30 where shop_id = $1 returning shop_id`, [a.shopId])).toEqual([])
  })

  it('invitations are bound to the invited email', async () => {
    const someone = await createUser('Eve')
    const token = await a.owner.rpc('invite_staff', { p_shop_id: a.shopId, p_email: 'not-eve@test.dev', p_role: 'manager' })
    await expectError(someone.rpc('accept_invitation', { p_token: token }), 'INVITATION_EMAIL_MISMATCH')
  })

  it('managers cannot escalate (invite managers / change permissions)', async () => {
    const mgr = await createUser('Max')
    const token = await a.owner.rpc('invite_staff', { p_shop_id: a.shopId, p_email: await emailOf(mgr), p_role: 'manager' })
    await mgr.rpc('accept_invitation', { p_token: token })
    await expectError(mgr.rpc('invite_staff', { p_shop_id: a.shopId, p_email: 'x@y.dev', p_role: 'manager' }), 'FORBIDDEN')
    const team = await a.owner.rows('list_team', { p_shop_id: a.shopId })
    const ownerM = team.find((t) => t.role === 'owner')
    await expectError(mgr.rpc('update_membership', { p_membership_id: ownerM.membership_id, p_is_active: false }), 'FORBIDDEN')
    // Manager sees shop reports but not individual barber money (owner can grant it)
    const rep = await mgr.rpc('shop_analytics', { p_shop_id: a.shopId, p_from: await localDate(a.tz, 0), p_to: await localDate(a.tz, 0) })
    expect(rep.barbers.every((r: any) => r.net_revenue_cents === null)).toBe(true)
    const mgrRow = team.find((t) => t.user_id === mgr.id) ?? (await a.owner.rows('list_team', { p_shop_id: a.shopId })).find((t) => t.user_id === mgr.id)
    await a.owner.rpc('update_membership', { p_membership_id: mgrRow.membership_id, p_permissions: JSON.stringify({ 'financials.all_barbers': true }) })
    const rep2 = await mgr.rpc('shop_analytics', { p_shop_id: a.shopId, p_from: await localDate(a.tz, 0), p_to: await localDate(a.tz, 0) })
    expect(rep2.barbers.some((r: any) => r.net_revenue_cents !== null)).toBe(true)
  })

  it('plan limits are enforced server-side', async () => {
    const solo = await buildShop({ plan: 'starter' }).catch((e) => e)
    expect(String(solo.message ?? solo)).toContain('PLAN_LIMIT_BARBERS')
  })

  it('service-only functions are not callable by users', async () => {
    await expectError(a.owner.q(`select * from claim_due_notifications(10)`), 'permission denied')
    await expectError(anon.q(`select run_periodic_jobs()`), 'permission denied')
  })
})

describe('audit log', () => {
  it('records who changed a price, with before/after', async () => {
    await a.owner.q(`update services set price_cents = 3800 where id = $1`, [a.haircut])
    const [log] = await a.owner.q(`select * from audit_logs where entity = 'services' and entity_id = $1 and action = 'update' order by id desc limit 1`, [a.haircut])
    expect(log.actor_id).toBe(a.owner.id)
    expect(log.changes.price_cents).toEqual([3500, 3800])
    expect(await a.carlosUser.q(`select id from audit_logs where shop_id = $1`, [a.shopId])).toEqual([])
  })
})
