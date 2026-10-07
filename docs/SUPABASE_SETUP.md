# Setting up Supabase for Autocoti

## 1. Create the project
1. Go to https://supabase.com/dashboard → **New project**.
2. Pick a name (e.g. `autocoti`), a strong database password (save it), and the region closest to your shops.
3. Wait ~2 minutes for it to provision.

## 2. Create the database (one paste)
1. Dashboard → **SQL Editor** → **New query**.
2. Open [`supabase/setup.sql`](../supabase/setup.sql) from this repo, copy everything, paste, and click **Run**.
3. It should finish with "Success. No rows returned". Check **Table Editor**: you'll see ~45 tables (`shops`, `barbers`, `appointments`, …).

Run it once on a fresh project. (Developers can instead use the CLI: `supabase link --project-ref <ref>` then `supabase db push`.)

## 3. Auth settings
Dashboard → **Authentication → URL Configuration**:
- **Site URL:** where the app is hosted (e.g. `https://app.yourdomain.com`, or `http://localhost:5173` while developing).
- **Redirect URLs:** add the same URL followed by `/**`.

Email confirmation is on by default (recommended). New owners confirm their email, then land in onboarding.

## 4. Connect the app
Dashboard → **Project Settings → API**, then create `.env` in the repo root:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<the "anon" / publishable key>
VITE_APP_URL=http://localhost:5173
```

Then `npm install && npm run dev` and open http://localhost:5173 → **Start free**.

Never put the `service_role` / secret key in `.env` or anywhere in the frontend.

## 5. Optional: Edge Functions (AI assistant, email reminders)
```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase functions deploy assistant dispatch-notifications
npx supabase secrets set ANTHROPIC_API_KEY=... RESEND_API_KEY=... EMAIL_FROM="Your Shop <bookings@yourdomain.com>" APP_URL=https://app.yourdomain.com
```
Then schedule `dispatch-notifications` to run every minute (Dashboard → **Integrations → Cron**, HTTP request to the function URL with header `Authorization: Bearer <service_role key>`).

Without these, the app works fully; booking confirmations and reminders are queued but not emailed, and the AI assistant answers common questions from your data without Claude.
