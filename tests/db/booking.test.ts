import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, buildShop, createUser, expectError, hhmm, localDate, localTs, pgArray, pool, sql } from './helpers'

let s: Awaited<ReturnType<typeof buildShop>>
let day: string // a date 3 days out, so min-notice rules never interfere

beforeAll(async () => {
  s = await buildShop()
  day = await localDate(s.tz, 3)
})
afterAll(() => pool.end())

const client = (n: string, phone = `555${Math.floor(Math.random() * 1e7)}`) =>
  JSON.stringify({ first_name: n, last_name: 'Test', phone, email: `${n.toLowerCase()}${phone}@mail.dev` })

describe('availability engine', () => {
  it('offers smart slots: tight fits after bookings, gap fill before breaks, skips gaps too small', async () => {
    // Carlos: 14:00–14:45, 14:45–15:30, 16:00–16:45 already booked
    for (const t of ['14:00', '14:45', '16:00']) {
      await s.owner.rpc('staff_create_appointment', {
        p_shop_id: s.shopId, p_barber_id: s.carlos, p_service_ids: pgArray([s.haircut]),
        p_starts_at: await localTs(s.tz, day, t), p_client: client('Pre'),
      })
    }
    const slots = await anon.rows('get_available_slots', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_date: day, p_barber_id: s.carlos,
    })
    const times = slots.map((r) => hhmm(r.starts_at, s.tz))
    expect(times).toContain('09:00')
    expect(times).toContain('12:15') // finishes exactly at lunch (13:00)
    expect(times).not.toContain('12:30') // would run into lunch
    expect(times).not.toContain('13:15') // lunch
    expect(times).not.toContain('15:30') // only 30 free minutes before 16:00
    expect(times).toContain('16:45') // tight fit right after the 16:00 haircut ends
    expect(times).toContain('17:15') // last start that ends at 18:00
    expect(times).not.toContain('17:30')
  })

  it('uses barber-specific durations (Luis: 40 min haircut)', async () => {
    const slots = await anon.rows('get_available_slots', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_date: day, p_barber_id: s.luis,
    })
    expect(slots[0].duration_minutes).toBe(40)
    expect(Number(slots[0].price_cents)).toBe(4000)
    expect(slots.map((r) => hhmm(r.starts_at, s.tz))).toContain('17:20') // 17:20 + 40 = 18:00 gap fill
  })

  it('first available returns the earliest slot per barber', async () => {
    const rows = await anon.rows('get_first_available', { p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_from_date: day, p_days: 2 })
    expect(rows.length).toBe(2)
    for (const r of rows) expect(hhmm(r.starts_at, s.tz)).toBe('09:00')
  })

  it('respects shop closures and barber time off', async () => {
    const d2 = await localDate(s.tz, 4)
    await s.owner.rpc('close_shop', {
      p_shop_id: s.shopId, p_starts_at: await localTs(s.tz, d2, '00:00'), p_ends_at: await localTs(s.tz, d2, '12:00'), p_note: 'Power cut',
    })
    await s.carlosUser.q(
      `insert into availability_exceptions (shop_id, barber_id, kind, starts_at, ends_at) values ($1,$2,'vacation',$3,$4)`,
      [s.shopId, s.carlos, await localTs(s.tz, d2, '15:00'), await localTs(s.tz, d2, '23:59')],
    )
    const slots = await anon.rows('get_available_slots', { p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_date: d2, p_barber_id: s.carlos })
    const times = slots.map((r) => hhmm(r.starts_at, s.tz))
    expect(times[0]).toBe('12:00')
    expect(times.at(-1)).toBe('14:15') // 14:15 + 45 = 15:00 vacation starts
  })

  it('handles the DST transition day correctly (wall-clock hours stay 09:00–18:00)', async () => {
    // Find the next US DST change (second Sunday in March / first Sunday in November).
    const [r] = await sql<{ d: string }>(`
      select to_char(d, 'YYYY-MM-DD') d from generate_series(current_date + 5, current_date + 400, interval '1 day') d
       where extract(dow from d) = 0
         and ((d::date + 1)::timestamp at time zone 'America/New_York') - (d::date::timestamp at time zone 'America/New_York') <> interval '24 hours'
       limit 1`)
    await s.owner.q(`update booking_settings set max_advance_days = 365 where shop_id = $1`, [s.shopId])
    const slots = await anon.rows('get_available_slots', { p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_date: r.d, p_barber_id: s.luis })
    const times = slots.map((x) => hhmm(x.starts_at, s.tz))
    expect(times[0]).toBe('09:00')
    expect(times.at(-1)).toBe('17:20')
    await s.owner.q(`update booking_settings set max_advance_days = 60 where shop_id = $1`, [s.shopId])
  })

  it('never offers odd start times derived from the notice cutoff', async () => {
    const today = await localDate(s.tz, 0)
    const slots = await anon.rows('get_available_slots', { p_shop_id: s.shopId, p_service_ids: pgArray([s.beard]), p_date: today, p_days: 2, p_barber_id: s.luis })
    for (const x of slots) expect(new Date(x.starts_at).getUTCMinutes() % 5).toBe(0)
  })

  it('hides unpublished shops from the public', async () => {
    const other = await buildShop()
    await other.owner.q(`update shops set is_published = false where id = $1`, [other.shopId])
    await expectError(anon.rows('get_available_slots', { p_shop_id: other.shopId, p_service_ids: pgArray([other.haircut]), p_date: day }), 'SHOP_NOT_AVAILABLE')
    expect(await anon.rpc('get_public_shop', { p_slug: other.slug })).toBeNull()
    // …but the owner can preview it
    const preview = await other.owner.rpc('get_public_shop', { p_slug: other.slug })
    expect(preview.is_preview).toBe(true)
  })
})

describe('booking', () => {
  it('books as a guest, dedupes the client by phone and queues confirmation + reminders', async () => {
    const start = await localTs(s.tz, day, '10:00')
    const res = await anon.rpc('book_appointment', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_starts_at: start, p_barber_id: s.luis,
      p_client: JSON.stringify({ first_name: 'John', last_name: 'Doe', phone: '(555) 010-2000', email: 'john@doe.dev' }),
    })
    expect(res.manage_token).toBeTruthy()
    const [a] = await sql(`select * from appointments where id = $1`, [res.appointment_id])
    expect(a.status).toBe('BOOKED')
    expect(Number(a.expected_price_cents)).toBe(4000)
    expect((new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60000).toBe(40)

    const notes = await sql(`select event, status from notifications where appointment_id = $1 and audience = 'client' order by scheduled_for`, [res.appointment_id])
    expect(notes.map((n) => n.event)).toEqual(['appointment.created', 'appointment.reminder', 'appointment.reminder'])

    // Same phone, different formatting → same client record
    const res2 = await anon.rpc('book_appointment', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.beard]), p_starts_at: await localTs(s.tz, day, '11:00'), p_barber_id: s.luis,
      p_client: JSON.stringify({ first_name: 'Johnny', phone: '555-010-2000' }),
    })
    expect(res2.client_id).toBe(res.client_id)
    const [c] = await sql(`select first_name from clients where id = $1`, [res.client_id])
    expect(c.first_name).toBe('John') // anonymous booker cannot overwrite stored data
  })

  it('"any barber" picks an available barber', async () => {
    const res = await anon.rpc('book_appointment', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_starts_at: await localTs(s.tz, day, '09:00'),
      p_client: client('Any'),
    })
    expect([s.carlos, s.luis]).toContain(res.barber_id)
  })

  it('never double books — even under concurrent requests', async () => {
    const start = await localTs(s.tz, day, '17:00')
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        anon.rpc('book_appointment', {
          p_shop_id: s.shopId, p_service_ids: pgArray([s.beard]), p_starts_at: start, p_barber_id: s.luis,
          p_client: client(`Racer${i}`),
        }),
      ),
    )
    const ok = attempts.filter((a) => a.status === 'fulfilled')
    expect(ok.length).toBe(1)
    for (const a of attempts.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
      expect(String(a.reason.message)).toMatch(/SLOT_TAKEN|exclusion|could not serialize/)
    }
  })

  it('rejects times that are not offered (outside hours, during breaks, past)', async () => {
    for (const t of ['08:00', '13:15', '18:00']) {
      await expectError(anon.rpc('book_appointment', {
        p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_starts_at: await localTs(s.tz, day, t), p_barber_id: s.luis, p_client: client('Bad'),
      }), 'SLOT_TAKEN')
    }
    await expectError(anon.rpc('book_appointment', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_starts_at: new Date(Date.now() - 3600e3).toISOString(), p_barber_id: s.luis, p_client: client('Past'),
    }), 'SLOT_TAKEN')
  })

  it('reschedules and cancels through the guest manage link with policy', async () => {
    const res = await anon.rpc('book_appointment', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.haircut]), p_starts_at: await localTs(s.tz, day, '15:00'), p_barber_id: s.luis, p_client: client('Resch'),
    })
    const moved = await anon.rpc('reschedule_booking', { p_token: res.manage_token, p_new_start: await localTs(s.tz, day, '15:30') })
    // Overlapping its own old slot is fine — the old one is released atomically.
    expect(moved.appointment_id).not.toBe(res.appointment_id)
    const [old] = await sql(`select status from appointments where id = $1`, [res.appointment_id])
    expect(old.status).toBe('RESCHEDULED')
    const b = await anon.rpc('get_booking', { p_token: moved.manage_token })
    expect(b.can_cancel).toBe(true)
    expect(b.is_late).toBe(false)
    const out = await anon.rpc('cancel_booking', { p_token: moved.manage_token, p_reason: 'Busy' })
    expect(out.late).toBe(false)
    await expectError(anon.rpc('cancel_booking', { p_token: moved.manage_token }), 'NOT_CANCELLABLE')
    const queued = await sql(`select count(*)::int n from notifications where appointment_id = $1 and event = 'appointment.reminder' and status = 'queued'`, [moved.appointment_id])
    expect(queued[0].n).toBe(0) // reminders cancelled
  })

  it('applies the late-cancellation fee inside the window', async () => {
    await s.owner.q(`update booking_settings set cancellation_window_hours = 200, late_cancel_fee_cents = 1500 where shop_id = $1`, [s.shopId])
    const res = await anon.rpc('book_appointment', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.beard]), p_starts_at: await localTs(s.tz, day, '16:00'), p_barber_id: s.luis, p_client: client('Late'),
    })
    const out = await anon.rpc('cancel_booking', { p_token: res.manage_token })
    expect(out).toEqual({ late: true, fee_cents: 1500 })
    await s.owner.q(`update booking_settings set cancellation_window_hours = 4, late_cancel_fee_cents = 0 where shop_id = $1`, [s.shopId])
  })

  it('links guest bookings to a client account with the same email', async () => {
    const user = await createUser('Mia')
    const [{ email }] = await sql(`select email from auth.users where id = $1`, [user.id])
    await anon.rpc('book_appointment', {
      p_shop_id: s.shopId, p_service_ids: pgArray([s.beard]), p_starts_at: await localTs(s.tz, day, '12:00'), p_barber_id: s.luis,
      p_client: JSON.stringify({ first_name: 'Mia', phone: '5550999111', email }),
    })
    expect(await user.rpc('link_my_client_records')).toBe(1)
    const mine = await user.rows('my_appointments')
    expect(mine.length).toBe(1)
    expect(mine[0].barber_name).toBe('Luis')
  })
})
