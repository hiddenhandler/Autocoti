import { defineConfig, devices } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'

// The e2e stack (scripts/e2e/stack.sh up) writes the local Supabase keys here.
const env: Record<string, string> = {}
if (existsSync('.env.e2e')) {
  for (const line of readFileSync('.env.e2e', 'utf8').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
  }
}

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    env: { VITE_SUPABASE_URL: env.VITE_SUPABASE_URL ?? '', VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY ?? '', VITE_APP_URL: 'http://localhost:5173' },
  },
})
