# Autocoti — the operating system for your barbershop

Bookings, barbers, clients, payments and business intelligence in one place.
Three experiences, each built around one question:

| Who | Question | Where |
|---|---|---|
| **Client** | “Book my haircut.” | Public shop page `/s/:slug`, booking flow, `/me` client app |
| **Barber** | “Who is next?” | Mobile-first `/app/today` — START CUT / FINISH CUT, checkout, rebook, earnings |
| **Owner** | “How is my shop performing?” | `/app/dashboard`, reports, insights & AI assistant, settings |

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

Edge Function secrets: `ANTHROPIC_API_KEY` (AI assistant), `RESEND_API_KEY` + `EMAIL_FROM` (email), `APP_URL`.
Schedule `dispatch-notifications` every minute (Supabase scheduled functions, or `pg_cron` + `pg_net`) with the service-role key as bearer token.

## Tests

| Command | What it covers |
|---|---|
| `npm run test:unit` | Timezone math, money parsing, CSV injection safety, AI assistant parsing/answers, insights engine |
| `npm run test:db` | 40 tests against real Postgres, running as anon / users / barbers / owners through RLS: availability engine (gap-fill, DST, closures), concurrent double-booking, tenant + barber isolation, roles, timer, checkout, tax, promo, refunds, tiered commission, walk-ins, waitlist race, analytics, retention, audit log |
| `npm run e2e:stack && npm run test:e2e` | The full journey in a real browser against GoTrue + PostgREST + Postgres: owner creates shop → adds barber & service → barber accepts invite → client books with real availability → barber starts/finishes cut, records payment + tip, rebooks → owner sees revenue, cut time, utilization, rebooking, client |

`npm run test:db` needs a local Postgres (it creates `autocoti_test`); the e2e stack needs Docker.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture, schema, roles & permissions, workflows, KPI definitions, security, edge cases, production readiness, roadmap.
