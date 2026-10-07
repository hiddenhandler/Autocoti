// The complete product journey from the spec (§60), through the real UI,
// real auth (GoTrue), real REST (PostgREST) and real RLS:
//
//   OWNER creates shop → adds barber → creates service → sets availability → publishes
//   CLIENT visits public page → picks service & barber → sees real availability → books
//   BARBER receives appointment → START CUT → FINISH CUT → records price/tip/payment → rebooks
//   OWNER sees revenue, barber performance, cut duration, utilization, rebooking, clients
//
// The only direct database access is test plumbing: moving the shop into a
// timezone where it is currently daytime (so the run never depends on the
// wall clock) and reading the invitation token that would arrive by email.
import { test, expect, type Browser, type Page } from '@playwright/test'
import pg from 'pg'

const db = new pg.Pool({ database: process.env.E2E_DB ?? 'barberngo_e2e', user: process.env.PGUSER ?? 'root', host: '/var/run/postgresql' })
const run = Date.now().toString(36)
const owner = { name: 'Ana Owner', email: `owner-${run}@e2e.dev`, password: 'correct-horse-9' }
const barber = { name: 'Luis Barber', email: `luis-${run}@e2e.dev`, password: 'correct-horse-9' }
const client = { first: 'John', last: 'Client', phone: `555${String(Date.now()).slice(-7)}`, email: `john-${run}@e2e.dev` }
const shopName = `Fade Factory ${run}`
let slug = ''

test.describe.configure({ mode: 'serial' })
test.afterAll(() => db.end())

// An Etc/GMT zone where local time is ~noon right now (POSIX sign is inverted).
function daytimeZone() {
  const offset = 12 - new Date().getUTCHours() // local = utc + offset
  const o = Math.max(-12, Math.min(14, offset))
  return o === 0 ? 'Etc/GMT' : `Etc/GMT${o > 0 ? '-' : '+'}${Math.abs(o)}`
}

async function signUp(page: Page, who: { name: string; email: string; password: string }) {
  await page.getByLabel('Your name').fill(who.name)
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: 'Create account' }).click()
}

async function newPage(browser: Browser) {
  const ctx = await browser.newContext({ timezoneId: 'UTC' })
  return ctx.newPage()
}

test('owner creates and publishes a shop', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: /Run Your Shop/i })).toBeVisible()
  await page.getByRole('link', { name: 'Start Free' }).first().click()
  await signUp(page, owner)

  // Onboarding wizard
  await expect(page.getByText("Let's open your shop.")).toBeVisible()
  await page.getByPlaceholder('Fade Factory').fill(shopName)
  await expect(page.getByText('Available ✓')).toBeVisible()
  await page.getByLabel('Your barber name').fill('Ana')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('What do you offer?')).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('When are you open?')).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Where can clients find you?')).toBeVisible()
  await page.getByLabel('City').fill('Brooklyn')
  await page.getByRole('button', { name: 'Publish & open dashboard' }).click()
  await expect(page).toHaveURL(/\/app\/dashboard/)
  await expect(page.getByText(/Good (morning|afternoon|evening), Ana/)).toBeVisible()

  const { rows } = await db.query('select id, slug from shops where name = $1', [shopName])
  slug = rows[0].slug
  // Test plumbing: daytime timezone + open all day, so slots exist whenever CI runs.
  await db.query(`update shops set timezone = $2 where id = $1`, [rows[0].id, daytimeZone()])
  await db.query(`update booking_settings set min_notice_minutes = 0 where shop_id = $1`, [rows[0].id])
  await db.query(`delete from business_hours where shop_id = $1`, [rows[0].id])
  await db.query(`insert into business_hours (shop_id, weekday, opens_at, closes_at) select $1, d, '00:00', '23:55' from generate_series(0,6) d`, [rows[0].id])
})

test('owner adds a barber and a service', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/app/)

  await page.goto('/app/barbers')
  await page.getByRole('button', { name: 'Add barber' }).first().click()
  await page.getByLabel('Name').fill('Luis')
  await page.getByLabel('Email (optional)').fill(barber.email)
  await page.getByRole('dialog').getByRole('button', { name: 'Add barber' }).click()
  await expect(page.getByText(/Luis added/)).toBeVisible()

  await page.goto('/app/services')
  await page.getByRole('button', { name: 'New service' }).click()
  await page.getByLabel('Name').fill('Skin Fade')
  await page.getByLabel('Price').fill('40')
  await page.getByLabel('Duration').selectOption('45')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Service created')).toBeVisible()
  await expect(page.getByRole('button', { name: /Skin Fade/ })).toBeVisible()
})

test('barber accepts the invitation and gets a private workspace', async ({ browser }) => {
  const page = await newPage(browser)
  const { rows } = await db.query('select token from invitations where email = $1 and accepted_at is null', [barber.email])
  await page.goto(`/invite/${rows[0].token}`)
  await expect(page.getByText(`Join ${shopName}`)).toBeVisible()
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Your name').fill(barber.name)
  await page.getByLabel('Password').fill(barber.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page).toHaveURL(/\/app\/today/)
  await expect(page.getByText(/No more clients booked today|Next client/)).toBeVisible()
  // Barbers cannot open shop reports
  await page.goto('/app/reports')
  await expect(page.getByText('Reports are for owners and managers')).toBeVisible()
  await page.context().close()
})

test('client books through the public page with real availability', async ({ browser }) => {
  const page = await newPage(browser)
  await page.goto(`/s/${slug}`)
  await expect(page.getByRole('heading', { name: shopName })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Available today' })).toBeVisible()
  await page.getByRole('link', { name: 'BOOK YOUR CUT' }).first().click()
  await expect(page.getByRole('heading', { name: 'Choose a service' })).toBeVisible()
  await page.getByRole('button', { name: /Skin Fade/ }).click()
  await expect(page.getByText("Who's cutting?")).toBeVisible()
  await expect(page.getByRole('button', { name: /First available/ })).toBeVisible()
  await page.getByRole('button', { name: /^Luis/ }).click()
  await expect(page.getByRole('heading', { name: 'Pick a time' })).toBeVisible()
  const firstTime = page.locator('button.h-12').first()
  await expect(firstTime).toBeVisible()
  await firstTime.click()

  await expect(page.getByText('Almost done')).toBeVisible()
  await page.getByLabel('First name').fill(client.first)
  await page.getByLabel('Last name').fill(client.last)
  await page.getByLabel(/^Phone/).fill(client.phone)
  await page.getByLabel(/^Email/).fill(client.email)
  await page.getByRole('button', { name: /Confirm booking · \$40/ }).click()
  await expect(page.getByText("You're booked.")).toBeVisible()
  await expect(page.getByText(/with Luis/)).toBeVisible()
  await page.context().close()
})

test('barber runs the cut, records payment and rebooks', async ({ browser }) => {
  test.setTimeout(240_000)
  const page = await newPage(browser)
  await page.goto('/login')
  await page.getByLabel('Email').fill(barber.email)
  await page.getByLabel('Password').fill(barber.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/app\/today/)

  await expect(page.getByText('John Client').first()).toBeVisible()
  await page.getByRole('button', { name: 'START CUT' }).click()
  await expect(page.getByText('In chair')).toBeVisible()
  // A real cut takes time; the analytics ignore sub-minute accidental timers.
  await page.waitForTimeout(62_000)
  await page.getByRole('button', { name: 'FINISH CUT' }).click()

  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Complete appointment')).toBeVisible()
  await sheet.getByRole('button', { name: /^20%/ }).click()
  await sheet.getByRole('button', { name: 'Cash' }).click()
  await sheet.getByRole('button', { name: 'Charge $48' }).click()
  await expect(page.getByText(/Paid \$48/)).toBeVisible()

  // Rebooking sheet opens straight after checkout
  await expect(page.getByRole('dialog').getByText('Book the next cut')).toBeVisible()
  await page.getByRole('dialog').locator('button.h-10').first().click()
  await expect(page.getByText(/Next cut booked/)).toBeVisible()

  await page.goto('/app/earnings')
  await expect(page.getByText('Estimated take-home')).toBeVisible()
  await page.context().close()
})

test('owner sees revenue, performance, cut time, utilization, rebooking and the client', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/app\/dashboard/)
  await expect(page.getByText('$40').first()).toBeVisible()
  await expect(page.getByText('+ $8 tips')).toBeVisible()

  await page.goto('/app/reports')
  await page.getByRole('tab', { name: 'Today' }).click()
  const kpis = page.locator('.grid').first()
  await expect(kpis.getByText('$40').first()).toBeVisible()
  await expect(page.getByText('Rebooking').first()).toBeVisible()
  await expect(page.getByText('100%').first()).toBeVisible() // rebooking rate: 1 of 1
  await expect(page.getByRole('heading', { name: 'Average cut time' })).toBeVisible()
  await expect(page.getByText(/1 cuts/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Chair utilization' })).toBeVisible()
  const row = page.locator('tr', { hasText: 'Luis' })
  await expect(row).toContainText('$40')

  await page.goto('/app/clients')
  await page.getByPlaceholder('Name, phone or email').fill('john')
  await page.getByRole('link', { name: /John Client/ }).click()
  await expect(page.getByText('Visit history')).toBeVisible()
  await expect(page.getByText('Skin Fade').first()).toBeVisible()
})
