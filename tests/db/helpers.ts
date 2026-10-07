import pg from 'pg'
import { randomUUID } from 'node:crypto'

export const DB_NAME = process.env.TEST_DB ?? 'autocoti_test'
export const pool = new pg.Pool({ database: DB_NAME, max: 8, user: process.env.PGUSER ?? 'root', host: process.env.PGHOST ?? '/var/run/postgresql' })

/** Run SQL as superuser (test setup only). */
export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params)
  return res.rows as T[]
}

/** A database actor: anon, an authenticated user, or service_role — exactly as PostgREST would run it. */
export class Actor {
  constructor(
    public readonly id: string | null,
    public readonly role: 'anon' | 'authenticated' | 'service_role' = id ? 'authenticated' : 'anon',
  ) {}

  async q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: this.id ?? undefined, role: this.role }),
      ])
      await client.query(`set local role ${this.role}`)
      const res = await client.query(text, params)
      await client.query('commit')
      return res.rows as T[]
    } catch (e) {
      await client.query('rollback').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  async one<T = any>(text: string, params: unknown[] = []): Promise<T> {
    const rows = await this.q<T>(text, params)
    return rows[0]
  }

  /** Call an RPC and return its scalar value (first column of first row). */
  async rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const keys = Object.keys(args)
    const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as v`
    const rows = await this.q<{ v: T }>(call, keys.map((k) => args[k]))
    return rows[0]?.v
  }

  async rows<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
    const keys = Object.keys(args)
    return this.q<T>(`select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, keys.map((k) => args[k]))
  }
}

export const anon = new Actor(null, 'anon')
export const service = new Actor(null, 'service_role')

export async function createUser(name: string): Promise<Actor> {
  const id = randomUUID()
  await sql(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
    id,
    `${name.toLowerCase()}-${id.slice(0, 6)}@test.dev`,
    { full_name: name },
  ])
  return new Actor(id)
}

export async function emailOf(a: Actor): Promise<string> {
  const [r] = await sql<{ email: string }>(`select email from auth.users where id = $1`, [a.id])
  return r.email
}

/** Local date string (YYYY-MM-DD) N days from today in a timezone. */
export async function localDate(tz: string, plusDays = 0): Promise<string> {
  const [r] = await sql<{ d: string }>(`select to_char((now() at time zone $1)::date + $2::int, 'YYYY-MM-DD') d`, [tz, plusDays])
  return r.d
}

/** timestamptz for a local wall-clock time. */
export async function localTs(tz: string, date: string, time: string): Promise<string> {
  const [r] = await sql<{ t: Date }>(`select (($1::date + $2::time) at time zone $3) t`, [date, time, tz])
  return r.t.toISOString()
}

export function hhmm(d: Date | string, tz: string): string {
  return new Date(d).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
}

export async function expectError(p: Promise<unknown>, code: string | RegExp) {
  try {
    await p
  } catch (e: any) {
    const msg = String(e.message)
    if (typeof code === 'string' ? msg.includes(code) : code.test(msg)) return e
    throw new Error(`Expected error ${code}, got: ${msg}`)
  }
  throw new Error(`Expected error ${code}, but call succeeded`)
}

export const TZ = 'America/New_York'

/** Builds a realistic shop: owner + 2 barbers (linked logins) + 3 services + schedules. */
export async function buildShop(opts: { plan?: string; slug?: string; tz?: string } = {}) {
  const tz = opts.tz ?? TZ
  const owner = await createUser('Owner')
  const slug = opts.slug ?? `shop-${randomUUID().slice(0, 8)}`
  const shopId = await owner.rpc<string>('create_shop', {
    p_shop_name: 'Test Cuts',
    p_slug: slug,
    p_timezone: tz,
    p_owner_is_barber: false,
    p_plan_code: opts.plan ?? 'pro',
  })
  await owner.q(`update shops set is_published = true where id = $1`, [shopId])
  await owner.q(`update booking_settings set min_notice_minutes = 0, slot_interval_minutes = 15 where shop_id = $1`, [shopId])

  const [haircut] = await owner.q(`insert into services (shop_id, name, price_cents, duration_minutes) values ($1,'Haircut',3500,45) returning id`, [shopId])
  const [beard] = await owner.q(`insert into services (shop_id, name, price_cents, duration_minutes) values ($1,'Beard',2000,30) returning id`, [shopId])
  const [combo] = await owner.q(`insert into services (shop_id, name, price_cents, duration_minutes) values ($1,'Haircut + Beard',4500,60) returning id`, [shopId])

  const carlosUser = await createUser('Carlos')
  const luisUser = await createUser('Luis')
  const [carlos] = await owner.q(`insert into barbers (shop_id, display_name, user_id) values ($1,'Carlos',$2) returning id`, [shopId, carlosUser.id])
  const [luis] = await owner.q(`insert into barbers (shop_id, display_name, user_id) values ($1,'Luis',$2) returning id`, [shopId, luisUser.id])
  const [org] = await sql(`select organization_id from shops where id = $1`, [shopId])
  for (const u of [carlosUser, luisUser]) {
    await sql(`insert into memberships (organization_id, shop_id, user_id, role) values ($1,$2,$3,'barber')`, [org.organization_id, shopId, u.id])
  }
  for (const b of [carlos.id, luis.id]) {
    await owner.rpc('set_barber_services', { p_barber_id: b, p_service_ids: `{${haircut.id},${beard.id},${combo.id}}` })
    const rows = [0, 1, 2, 3, 4, 5, 6].flatMap((d) => [
      { weekday: d, starts_at: '09:00', ends_at: '18:00' },
      { weekday: d, starts_at: '13:00', ends_at: '14:00', kind: 'break' },
    ])
    await owner.rpc('set_weekly_schedule', { p_barber_id: b, p_rows: JSON.stringify(rows) })
  }
  // Luis: $40 haircut, 40 minutes
  await owner.q(`update barber_services set price_cents = 4000, duration_minutes = 40 where barber_id = $1 and service_id = $2`, [luis.id, haircut.id])
  await owner.rpc('set_commission', { p_barber_id: carlos.id, p_type: 'percentage', p_percent_bps: 5000 })
  await owner.rpc('set_commission', { p_barber_id: luis.id, p_type: 'percentage', p_percent_bps: 4500 })

  return {
    tz, slug, shopId, owner, carlosUser, luisUser, orgId: org.organization_id as string,
    carlos: carlos.id as string, luis: luis.id as string,
    haircut: haircut.id as string, beard: beard.id as string, combo: combo.id as string,
  }
}

export const pgArray = (ids: string[]) => `{${ids.join(',')}}`
