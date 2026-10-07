// Passwordless sign-in: emailed links land on /auth/callback, which routes the
// new owner into onboarding. The email itself is replaced by GoTrue's admin
// generate_link (test plumbing) — the same link Supabase would email.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.e2e', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)

async function emailedLink(email: string, redirectTo: string) {
  const res = await fetch(`${env.VITE_SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email, redirect_to: redirectTo, data: { full_name: 'Mia Magic' } }),
  })
  const body = (await res.json()) as { action_link?: string; properties?: { action_link?: string }; msg?: string }
  const link = body.action_link ?? body.properties?.action_link
  if (!link) throw new Error(`generate_link failed: ${JSON.stringify(body)}`)
  // The local GoTrue drops API_EXTERNAL_URL's path; hosted Supabase links include /auth/v1.
  const url = new URL(link)
  if (!url.pathname.startsWith('/auth/v1')) url.pathname = `/auth/v1${url.pathname}`
  return url.toString()
}

test('sign-in and sign-up offer Google and an emailed link', async ({ page }) => {
  for (const path of ['/login', '/signup?intent=owner']) {
    await page.goto(path)
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
    await expect(page.getByRole('button', { name: /email me a (sign-in )?link/i })).toBeVisible()
  }
})

test('an emailed sign-in link takes a new owner to onboarding', async ({ page }) => {
  const email = `magic-${Date.now().toString(36)}@e2e.dev`
  await page.goto('/signup?intent=owner')
  await page.getByLabel('Your name').fill('Mia Magic')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: /email me a link/i }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()

  await page.goto(await emailedLink(email, 'http://localhost:5173/auth/callback?intent=owner'))
  await expect(page).toHaveURL(/\/onboarding/)
})

test('a bad sign-in link explains itself', async ({ page }) => {
  await page.goto('/auth/callback#error=access_denied&error_description=Email+link+is+invalid+or+has+expired')
  await expect(page.getByText("Couldn't sign you in")).toBeVisible()
  await expect(page.getByText('Email link is invalid or has expired')).toBeVisible()
})
