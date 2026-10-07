# Autocoti

Booking for barbershops, so clients never have to call their barber to get a spot.

- **Clients (public, no account):** open `/s/<shop>`, pick a barber → service → day → open time, leave name + phone.
  They get a private link (`/b/<token>`) to check the status or cancel.
- **Barbers (login, have a chair):** set services & prices, weekly hours (with split shifts) and time off; choose
  **auto-confirm or approve every request**; work the day from the agenda (accept/decline, start cut, no-show,
  finish & log what they actually charged + tip + payment method); add walk-ins; track earnings and expenses in
  **My money**. Nothing connects to a bank or payment processor — it's what the barber logs.
- **Owner (login):** everything a barber has (if they also cut), plus **Shop insights** (busiest hours/days heatmap,
  average cut time from Start→Done taps, no-show rate, online vs walk-in share, per-barber and per-service stats),
  **Team** (add barbers, mark who has a chair, deactivate) and **Shop settings** (booking link, slot interval,
  minimum notice, how far ahead clients can book). Barber revenue stays private unless each barber opts to share it.

## Run it

```bash
npm install
npm run seed      # optional: demo shop at /s/demo with ~2 months of history
npm run dev       # http://localhost:3000
```

Demo logins (password `demo1234`): `owner@demo.test`, `luis@demo.test` (approves requests), `ana@demo.test`.

Data lives in SQLite at `data/autocoti.db` (override with `DATABASE_PATH`). The schema is created on first start.

```bash
npm test          # booking, availability and stats tests
npm run typecheck
npm run build && npm start
```

## How it's built

Next.js (App Router, server actions) + SQLite via `better-sqlite3` + Tailwind.

- `src/lib/availability.ts` — pure slot calculation (hours − bookings − time off − minimum notice).
- `src/lib/booking.ts` — booking, client cancel, barber actions, walk-ins. The availability re-check and the insert
  run in one transaction, so two clients can't grab the same time. Pending requests hold their slot.
- `src/lib/stats.ts` — barber finances and owner analytics.
- Times are stored as shop-local wall-clock strings (`YYYY-MM-DD HH:MM`) in the shop's time zone.

## Not built yet

- SMS/WhatsApp/email notifications (clients check their status link; barbers see requests on their agenda).
- Password reset by email (owners set a temporary password for barbers; everyone can change theirs in settings).
- Multiple locations per owner.
