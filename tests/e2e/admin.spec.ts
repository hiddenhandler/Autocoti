// System owner console: create an account → the invitee activates it → gift and sell months → cash flow.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = Object.fromEntries(
  readFileSync('.env.e2e', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const db = new pg.Pool({ database: process.env.E2E_DB ?? 'barberngo_e2e', user: process.env.PGUSER ?? 'root', host: '/var/run/postgresql' })
const run = Date.now().toString(36)
const sysEmail = `sys-${run}@e2e.dev`
const ownerEmail = `rafa-${run}@e2e.dev`
const password = 'correct-horse-9'
const shopName = `Rafa Studio ${run}`

test.describe.configure({ mode: 'serial' })
test.afterAll(() => db.end())

test.beforeAll(async () => {
  const res = await fetch(`${env.VITE_SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: sysEmail, password, email_confirm: true, user_metadata: { full_name: 'Sys Owner' } }),
  })
  const u = (await res.json()) as { id: string }
  await db.query('insert into public.platform_admins (user_id) values ($1)', [u.id])
})

let claimUrl = ''

test('system owner creates a chair-owner account with gifted months', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(sysEmail)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/admin/)
  await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible()

  await page.getByRole('tab', { name: 'Accounts' }).click()
  await page.getByRole('button', { name: 'Create account' }).first().click()
  await page.getByRole('tab', { name: 'Chair owner' }).click()
  await page.getByLabel('Full name').fill('Rafa Cuts')
  await page.getByLabel('Email (their login)').fill(ownerEmail)
  await page.getByLabel('Business name').fill(shopName)
  await page.getByLabel('Gift').selectOption('3')
  await page.getByRole('button', { name: 'Create & get link' }).click()
  await expect(page.getByText('Account ready to activate')).toBeVisible()
  claimUrl = (await page.locator('.font-mono').innerText()).trim()
  expect(claimUrl).toMatch(/\/claim\//)
})

test('the invitee signs up with that email and activates their chair', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto(claimUrl)
  await expect(page.getByText('your chair is ready.')).toBeVisible()
  await expect(page.getByText('3 months free')).toBeVisible()
  await page.getByRole('link', { name: 'Create my login' }).click()
  await page.getByLabel('Your name').fill('Rafa Cuts')
  await page.getByLabel('Email').fill(ownerEmail)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/claim\//)
  await page.getByRole('button', { name: 'Activate my account' }).click()
  await expect(page).toHaveURL(/\/app\/settings/)
  await page.context().close()
})

test('system owner gifts and sells months; cash flow and people reflect it', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(sysEmail)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/admin/)

  await page.getByRole('tab', { name: 'Accounts' }).click()
  const row = page.getByRole('row', { name: new RegExp(shopName) })
  await expect(row).toContainText('Gifted until')
  await row.click()
  await page.getByRole('tab', { name: 'Paid' }).click()
  await page.getByLabel('Amount received').fill('29')
  await page.getByRole('button', { name: /Record payment & add 1 month/ }).click()
  await expect(page.getByText(/Paid — active until/)).toBeVisible()
  await expect(page.getByRole('row', { name: new RegExp(shopName) })).toContainText('$29')

  await page.getByRole('tab', { name: 'Overview' }).click()
  await expect(page.getByText('BarberNGo revenue')).toBeVisible()
  await expect(page.getByRole('table')).toContainText('$29')

  await page.getByRole('tab', { name: 'People' }).click()
  await page.getByPlaceholder('Search name or email…').fill(`rafa-${run}`)
  const person = page.locator('div.flex-wrap', { hasText: ownerEmail }).last()
  await expect(person.locator('span', { hasText: /^Chair owner$/ })).toBeVisible()
  await expect(person.locator('span', { hasText: /^Shop owner$/ })).toBeVisible()
})
