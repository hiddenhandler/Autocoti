# BarberNGo — Your shop. Your chairs. Your schedule.

A SaaS for **barbershop owners and independent chair owners**. It is **not a marketplace**: every shop gets its own branded page (`/shop/:slug`, plus a QR code) where *its* customers see *its* barbers' live status, book, or join the walk-in queue.

**SHOP → CHAIRS → BARBERS → CUSTOMERS → APPOINTMENTS → PAYMENTS → ANALYTICS**

| Who | Gets | Where |
|---|---|---|
| **Customer** (no account needed) | Live barber status (available · cutting · break · queue · offline · not working), booking, walk-in queue with "You are #4 · 20–30 min", live appointment page (cut in progress, timer, completed → review / book again) | `/shop/:slug`, `/shop/:slug/queue`, `/q/:token`, `/a/:token`, `/me` |
| **Barber / chair owner** | Today (next client, START / COMPLETE CUT timer, break / offline), queue, schedule, customers, own prices and services, **own inventory, expenses, rent and take-home** | `/app/today`, `/app/finance`, `/app/inventory`, `/app/my-services` |
| **Owner** | Overview + live shop status, chair board, employee vs chair owner, chair rent ledger, payouts, expenses, profit, shop inventory, analytics, smart insights, QR poster, multi-location | `/app/dashboard`, `/app/chairs`, `/app/finance`, `/app/share` |

**Employees vs chair owners.** Employees are on commission and the shop controls their schedule (optional), services and prices. Chair owners keep 100% of services, tips and their own product sales, set their own prices/services/hours, run a **private** inventory and expense book, and pay chair rent (weekly or monthly ledger). The owner sees shop-level info — chairs, live status, appointments, rent — never a chair owner's private costs.

**Smart service time.** The haircut timer learns each barber's real average per service (≥ 5 timed cuts, rounded up to 5 min) and booking uses it; a cut that finishes early frees the chair immediately.

## Stack

- **Frontend:** React 19 + Vite + TypeScript + Tailwind v4, React Router, TanStack Query. PWA (manifest + service worker), Capacitor-ready.
- **Backend:** Supabase — Postgres 16, Auth, Row Level Security, PostgREST RPCs, Realtime, Edge Functions.
- **AI:** Claude (`claude-opus-5-5`) via the `assistant` Edge Function, restricted to RLS-scoped data tools.

All business rules (availability, double-booking prevention, money, permissions, analytics) live in the database, so every client — web, PWA, future native apps, API — gets the same guarantees.

## Getting started

```bash
npm install
cp .env.example .env          # VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
supabase db push              # applies supabase/migrations/*
supabase functions deploy assistant dispatch-notifications
npm run dev
```

Edge Function secrets: `ANTHROPIC_API_KEY` (AI assistant), `RESEND_API_KEY` + `EMAIL_FROM` (email), `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_WHATSAPP_FROM` / `TWILIO_SMS_FROM` (+ `SMS_DEFAULT_COUNTRY_CODE`) for WhatsApp/SMS, `APP_URL`.
Schedule `dispatch-notifications` every minute (Supabase scheduled functions, or `pg_cron` + `pg_net`) with the service-role key as bearer token.

## Tests

| Command | What it covers |
|---|---|
| `npm run test:unit` | Timezone math, money parsing, CSV injection safety, AI assistant parsing/answers, insights engine |
| `npm run test:db` | 40 tests against real Postgres, running as anon / users / barbers / owners through RLS: availability engine (gap-fill, DST, closures), concurrent double-booking, tenant + barber isolation, roles, timer, checkout, tax, promo, refunds, tiered commission, walk-ins, waitlist race, analytics, retention, audit log |
| `npm run e2e:stack && npm run test:e2e` (no Docker? `GOTRUE_BIN=… POSTGREST_BIN=… npm run e2e:stack` runs the release binaries) | The full journey in a real browser against GoTrue + PostgREST + Postgres: owner creates shop → adds barber & service → barber accepts invite → client books with real availability → barber starts/finishes cut, records payment + tip, rebooks → owner sees revenue, cut time, utilization, rebooking, client |

`npm run test:db` needs a local Postgres (it creates `barberngo_test`); the e2e stack needs Docker.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture, schema, roles & permissions, workflows, KPI definitions, security, edge cases, production readiness, roadmap.
