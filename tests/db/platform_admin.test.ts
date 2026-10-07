// System owner (platform admin): accounts, gifted/sold plan months, ledger, claimable invitations.
import { describe, expect, it, beforeAll } from 'vitest'
import { Actor, anon, createUser, emailOf, sql } from './helpers'

let admin: Actor
let stranger: Actor

beforeAll(async () => {
  admin = await createUser('Sys')
  stranger = await createUser('Mallory')
  await sql(`insert into public.platform_admins (user_id) values ($1)`, [admin.id])
})

describe('access', () => {
  it('only system owners can use the console', async () => {
    expect(await admin.rpc('am_platform_admin')).toBe(true)
    expect(await stranger.rpc('am_platform_admin')).toBe(false)
    for (const fn of ['admin_overview', 'admin_accounts', 'admin_people', 'admin_invites', 'admin_ledger']) {
      await expect(stranger.rpc(fn)).rejects.toThrow(/FORBIDDEN/)
    }
    await expect(anon.rpc('admin_overview')).rejects.toThrow()
  })

  it('platform tables are not readable directly, even by admins', async () => {
    await expect(admin.q('select * from public.platform_ledger')).rejects.toThrow(/permission denied/)
    await expect(stranger.q('select * from public.account_invites')).rejects.toThrow(/permission denied/)
  })
})

describe('creating accounts', () => {
  it('a chair owner claims a gifted account and gets org, plan, shop and their own chair at 100%', async () => {
    const owner = await createUser('Rafa')
    const email = await emailOf(owner)
    const inv = await admin.rpc('admin_create_account', {
      p_email: email.toUpperCase(), p_full_name: 'Rafa Cuts', p_kind: 'chair_owner', p_shop_name: 'Rafa Studio',
      p_plan_code: 'starter', p_comp_months: 3, p_timezone: 'America/Santo_Domingo',
    })
    expect(inv.claim_url).toMatch(/^\/claim\//)

    const pub = await anon.rpc('get_account_invite', { p_token: inv.token })
    expect(pub).toMatchObject({ shop_name: 'Rafa Studio', kind: 'chair_owner', plan_name: 'Starter', comp_months: 3, status: 'pending' })
    expect(pub.email_hint).not.toContain(email.split('@')[0])

    await expect(stranger.rpc('claim_account_invite', { p_token: inv.token })).rejects.toThrow(/EMAIL_MISMATCH/)
    const shopId = await owner.rpc('claim_account_invite', { p_token: inv.token })
    expect(shopId).toBeTruthy()
    await expect(owner.rpc('claim_account_invite', { p_token: inv.token })).rejects.toThrow(/ALREADY_CLAIMED/)

    const [sub] = await sql(`select s.status, s.is_comp, p.code, s.current_period_end > now() + interval '85 days' as long
                               from subscriptions s join subscription_plans p on p.id = s.plan_id
                               join shops sh on sh.organization_id = s.organization_id where sh.id = $1`, [shopId])
    expect(sub).toMatchObject({ status: 'active', is_comp: true, code: 'starter', long: true })
    const [shop] = await sql(`select slug, timezone from shops where id = $1`, [shopId])
    expect(shop).toMatchObject({ slug: 'rafa-studio', timezone: 'America/Santo_Domingo' })
    const [b] = await sql(`select b.barber_type, c.percent_bps from barbers b join commissions c on c.barber_id = b.id where b.shop_id = $1`, [shopId])
    expect(b).toMatchObject({ barber_type: 'chair_owner', percent_bps: 10000 })

    const ws = await owner.rows('my_workspaces')
    expect(ws).toHaveLength(1)
    expect(ws[0].role).toBe('owner')
  })

  it('a shop owner without gift starts on a 14-day trial; duplicate shop names get a free slug', async () => {
    const owner = await createUser('Tina')
    const inv = await admin.rpc('admin_create_account', {
      p_email: await emailOf(owner), p_full_name: null, p_kind: 'shop_owner', p_shop_name: 'Rafa Studio', p_plan_code: 'shop',
    })
    const shopId = await owner.rpc('claim_account_invite', { p_token: inv.token })
    const [row] = await sql(`select sh.slug, s.status, s.is_comp from shops sh join subscriptions s on s.organization_id = sh.organization_id where sh.id = $1`, [shopId])
    expect(row).toMatchObject({ slug: 'rafa-studio-2', status: 'trialing', is_comp: false })
    expect(await sql(`select 1 from barbers where shop_id = $1`, [shopId])).toHaveLength(0)
  })

  it('a new invitation for the same email revokes the old one; revoked links are dead', async () => {
    const a = await admin.rpc('admin_create_account', { p_email: 'later@x.dev', p_full_name: 'L', p_kind: 'shop_owner', p_shop_name: 'L1', p_plan_code: 'shop' })
    const b = await admin.rpc('admin_create_account', { p_email: 'later@x.dev', p_full_name: 'L', p_kind: 'shop_owner', p_shop_name: 'L2', p_plan_code: 'pro' })
    expect((await anon.rpc('get_account_invite', { p_token: a.token })).status).toBe('expired')
    await admin.rpc('admin_revoke_invite', { p_id: b.id })
    expect((await anon.rpc('get_account_invite', { p_token: b.token })).status).toBe('expired')
    await expect(admin.rpc('admin_create_account', { p_email: 'bad', p_full_name: 'x', p_kind: 'shop_owner', p_shop_name: 'x', p_plan_code: 'shop' })).rejects.toThrow()
    await expect(admin.rpc('admin_create_account', { p_email: 'ok@x.dev', p_full_name: 'x', p_kind: 'shop_owner', p_shop_name: 'x', p_plan_code: 'nope' })).rejects.toThrow(/UNKNOWN_PLAN/)
  })
})

describe('memberships and cash flow', () => {
  it('gifting, selling and changing plans are recorded in the ledger and reflected in MRR', async () => {
    const owner = await createUser('Paco')
    const inv = await admin.rpc('admin_create_account', { p_email: await emailOf(owner), p_full_name: 'Paco', p_kind: 'shop_owner', p_shop_name: 'Paco Barber', p_plan_code: 'shop' })
    const shopId = await owner.rpc('claim_account_invite', { p_token: inv.token })
    const [{ organization_id: org }] = await sql(`select organization_id from shops where id = $1`, [shopId])

    const before = (await admin.rpc('admin_overview')).subscriptions.mrr_cents

    const gift = await admin.rpc('admin_grant_months', { p_org: org, p_plan_code: 'shop', p_months: 2, p_gift: true })
    expect(gift.is_comp).toBe(true)
    expect((await admin.rpc('admin_overview')).subscriptions.mrr_cents).toBe(before) // comped = no MRR

    await expect(admin.rpc('admin_grant_months', { p_org: org, p_plan_code: 'pro', p_months: 1, p_gift: false, p_amount_cents: 0 })).rejects.toThrow(/AMOUNT_REQUIRED/)
    const sale = await admin.rpc('admin_grant_months', { p_org: org, p_plan_code: 'pro', p_months: 1, p_gift: false, p_amount_cents: 14900, p_method: 'transfer' })
    // Paid month stacks on top of the 2 gifted months.
    const [{ months }] = await sql(`select round(extract(epoch from ($1::timestamptz - now())) / 86400 / 30) as months`, [sale.current_period_end])
    expect(Number(months)).toBe(3)

    const ov = await admin.rpc('admin_overview')
    expect(ov.subscriptions.mrr_cents).toBe(before + 14900)
    const thisMonth = ov.cashflow[ov.cashflow.length - 1]
    expect(thisMonth.platform_in_cents).toBeGreaterThanOrEqual(14900)
    expect(thisMonth.gifted_months).toBeGreaterThanOrEqual(2)

    await admin.rpc('admin_record_entry', { p_org: org, p_kind: 'refund', p_amount_cents: 4900, p_note: 'partial refund' })
    const ledger = await admin.rpc('admin_ledger', { p_org: org })
    expect(ledger.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['gift', 'payment', 'refund']))

    const accounts = await admin.rpc('admin_accounts', { p_search: 'paco' })
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ name: 'Paco Barber', kind: 'shop_owner', paid_total_cents: 10000, plan: { code: 'pro' } })

    await admin.rpc('admin_update_subscription', { p_org: org, p_plan_code: 'starter', p_status: 'cancelled' })
    expect((await owner.rpc('shop_features', { p_shop_id: shopId }))).toBeNull()
  })

  it('people lists roles across the system', async () => {
    const people = await admin.rpc('admin_people', { p_role: 'system_owner' })
    expect(people.some((p: any) => p.id === admin.id)).toBe(true)
    const owners = await admin.rpc('admin_people', { p_role: 'chair_owner' })
    expect(owners.some((p: any) => p.full_name === 'Rafa' || p.roles.includes('chair_owner'))).toBe(true)
  })

  it('system owners can add and remove other system owners, but not themselves', async () => {
    const helper = await createUser('Helper')
    await admin.rpc('admin_set_platform_admin', { p_email: await emailOf(helper), p_on: true })
    expect(await helper.rpc('am_platform_admin')).toBe(true)
    await expect(admin.rpc('admin_set_platform_admin', { p_email: await emailOf(admin), p_on: false })).rejects.toThrow(/FORBIDDEN/)
    await admin.rpc('admin_set_platform_admin', { p_email: await emailOf(helper), p_on: false })
    expect(await helper.rpc('am_platform_admin')).toBe(false)
  })
})
