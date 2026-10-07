# BarberNGo — architecture & product reference

> BarberNGo additions (migrations `…16_chairs_inventory_finance.sql`, `…17_live_queue_smart_time.sql`) are summarised in §12.

## 1. System audit (starting point)

The repository contained only a README: no code, schema, auth or UI. There were no legacy issues to fix, so the system was designed greenfield around the spec's priorities: database-enforced correctness first, then the three role experiences.

## 2. Architecture

```
Browser / PWA / (Capacitor iOS·Android)
  React SPA (Vite) ── route-level code splitting, TanStack Query cache, Realtime invalidation
        │  supabase-js (JWT)
        ▼
Supabase
  ├─ Auth (GoTrue)            users, sessions, magic links
  ├─ PostgREST                table reads under RLS + RPC calls
  ├─ Postgres 16              schema, RLS, SECURITY DEFINER RPCs, availability engine, analytics
  ├─ Realtime                 appointments / walk-ins change feed → live calendars
  └─ Edge Functions
       ├─ assistant           Claude tool-use loop over shop_analytics / list_clients (caller's JWT)
       └─ dispatch-notifications   outbox → channel adapters (email now; SMS/WhatsApp/push later)
```

**Why the logic lives in Postgres.** Double booking, money, permissions and KPIs must be identical for every client and impossible to bypass from a browser. They are enforced by constraints, RLS and RPCs, so they hold for web, PWA, native wrappers and any future API.

### Frontend layout

| Path | Contents |
|---|---|
| `src/pages/marketing` | SaaS landing page |
| `src/pages/public` | Shop page, booking flow, barber profile, manage booking, review, waitlist claim |
| `src/pages/client` | Client app (Home / Book / Appointments / Profile bottom nav) |
| `src/pages/staff` | Owner/manager/receptionist/barber app (role-filtered sidebar + barber bottom nav) |
| `src/components` | Design system (`ui`), charts, appointment workflow sheets, schedule editors, command palette |
| `src/lib` | Supabase client, auth/workspace context, timezone math, formatting, insights engine, assistant |

## 3. Database schema

Migrations: `supabase/migrations/2026100700000{1..14}_*.sql`.

| Domain | Tables |
|---|---|
| Tenancy | `profiles` (Supabase convention for *users*), `organizations`, `shops` (= locations), `memberships`, `invitations`, `subscription_plans`, `subscriptions` |
| Settings | `shop_settings`, `booking_settings`, `business_hours` |
| Catalogue & schedule | `barbers`, `services`, `barber_services` (per-barber price/duration), `availability` (weekly work + breaks), `availability_exceptions` (vacation, sick, holiday, closure, extra hours) |
| Operations | `appointments` (+ blocks/breaks/personal/emergency via `kind`), `appointment_services` (price snapshot), `appointment_status_history`, `walk_ins`, `waitlist` |
| Money | `payments`, `payment_items`, `refunds`, `tips`, `commissions` (rules, effective-dated), `barber_earnings` (ledger) |
| CRM | `clients`, `client_preferences`, `client_notes`, `client_favorites` |
| Engagement | `reviews`, `notifications` (outbox), `notification_templates`, `funnel_events` |
| Growth | `promo_codes`, `gift_cards`, `gift_card_transactions`, `membership_plans`, `client_memberships`, `membership_usage`, `loyalty_ledger`, `referrals`, `campaigns` |
| Reporting & audit | `analytics_snapshots`, `audit_logs` |

Conventions: money is integer cents; instants are `timestamptz`; wall-clock rules are `time` + weekday resolved in the shop's IANA timezone; business entities are soft-deleted (`deleted_at`); every table has the indexes its hot queries need.

**No double booking, by construction:**

```sql
exclude using gist (barber_id with =, tstzrange(starts_at, blocked_until) with &&)
  where (status not in ('CANCELLED','NO_SHOW','RESCHEDULED') and deleted_at is null)
```

`blocked_until = ends_at + buffer`, so buffers can't be double-booked either. Concurrent requests for the same slot are serialised by the index; the loser gets `SLOT_TAKEN` (tested with 6 parallel requests).

## 4. Roles & permissions

Membership is per organisation (all locations) or per shop. Role defaults live in `app.role_grants()`; an owner can grant or revoke individual permissions per membership (e.g. let a manager see barber earnings).

| Permission | Owner | Manager | Receptionist | Barber |
|---|---|---|---|---|
| Calendar: all barbers | ✓ | ✓ | ✓ | own only |
| Clients: full CRM | ✓ | ✓ | ✓ | clients they served |
| Record payments | ✓ | ✓ | ✓ | own appointments |
| Refunds / voids | ✓ | ✓ | — | — |
| Shop reports | ✓ | ✓ | — | own analytics only |
| Individual barber earnings | ✓ | grantable | — | own only |
| Commissions | ✓ | grantable | — | view own |
| Services, staff, schedules of others | ✓ | ✓ | — | own schedule |
| Settings / marketing | ✓ | ✓ | — | — |
| Audit log, billing, managers | ✓ | — | — | — |
| Clients (customers) | own appointments, profile, favourites via RPCs | | | |

Enforcement: anon has **no** table privileges at all. Staff reads go through RLS. Writes with business rules (appointments, money, memberships, walk-ins, waitlist, reviews) exist only as `SECURITY DEFINER` RPCs that re-check permission and compute amounts server-side, and financial tables have no write policies. A barber cannot alter another barber's numbers by changing an id; the security tests prove it.

## 5. Main workflows

- **Booking:** `get_available_slots` / `get_first_available` / `get_available_days` → `book_appointment` re-validates the exact start through the engine, dedupes the client by phone and email, inserts behind the exclusion constraint, then queues confirmation, reminders (24 h + 2 h by default) and a staff notification.
- **Availability engine** (`app.compute_slots`): `open = (work − breaks) ∪ extra_hours − time off − closures`; `free = open − busy`. Candidate starts are (a) right after the previous booking, (b) the clock grid, and (c) the latest start that finishes exactly when the next booking begins. Min notice, max advance, same-day rule, max-per-day and per-barber durations, prices and buffers all apply. DST-exact.
- **Guest self-service:** the manage token powers confirm, reschedule (atomic: old row → RESCHEDULED and new row in one transaction) and cancel, with the late-cancel fee policy applied.
- **Haircut timer:** `start_cut` → IN_SERVICE (one cut per barber at a time) → `finish_cut` → COMPLETED with actual vs booked duration stored → checkout sheet (`record_payment`: items, tip, discount/promo, tax, method, partial) → rebook sheet (`staff_create_appointment` with `rebooked_from`).
- **Walk-ins:** `walk_in_queue` simulates FIFO assignment over each barber's real free slots to quote waits; `call_next_walk_in` seats the client (refused if a booking is too close).
- **Waitlist:** a cancellation trigger offers the opening to matching entries; every notified client can claim, the first valid claim wins, and the rest stay in line.
- **Emergencies & closures:** `mark_barber_unavailable` / `close_shop` remove availability and list affected appointments (optionally cancelling and notifying them).
- **Notifications:** the outbox has a dedupe key per event; reminders are cancelled automatically when an appointment moves or is cancelled.

## 6. KPI definitions

| KPI | Definition |
|---|---|
| Net revenue | Σ(subtotal − discount) of service payments by `paid_at` − refunds in period (tips and tax excluded) |
| Average ticket | net service revenue ÷ service payments |
| Tips | Σ `tips.amount_cents` (separate from revenue) |
| Commission | Σ `barber_earnings.commission_cents` (percentage, fixed, marginal tiered on month-to-date, booth rental, hybrid) |
| Cancellation / no-show rate | cancelled (no-show) ÷ bookings in period (excluding RESCHEDULED rows) |
| Average cut time | mean actual duration of completed cuts timed ≥ 60 s; efficiency = booked ÷ actual |
| Chair utilization | booked appointment minutes inside open time ÷ open minutes (open counted from the day the barber joined); also blocked, idle and actual-service minutes plus a weekday × hour heatmap |
| Rebooking rate | completed appointments whose client booked a later appointment from 30 min before the cut until 24 h after it, or via "Book again" (`rebooked_from_id`) ÷ completed |
| New / returning | first-ever completed visit in period / served clients with earlier visits |
| Client health | cadence = preference ▸ average gap (≥ 2 visits) ▸ shop default. NEW (≤ 1 visit, recent) · ACTIVE (≤ 1.25 × cadence or booked) · AT_RISK (≤ 2.5 ×) · LOST (> 2.5 ×) |
| Booking conversion | distinct sessions reaching `booked` ÷ sessions viewing the booking page |

Each report also returns the previous equal-length period for deltas. Empty periods return `null` and render as explicit empty states; numbers are never fabricated.

**Smart insights** (`src/lib/insights.ts`): peak-capacity windows, over- or under-long service durations with capacity gain, revenue per available hour vs the shop average, under-used chairs, no-show and cancellation spikes, low rebooking, at-risk clients, revenue drivers, quiet hours, and missing payments. Each rule has a minimum-data threshold.

**AI assistant:** common questions are parsed deterministically, answered from fetched data, and work offline from the LLM. Open-ended questions go to Claude, which can only call the same RPCs with the caller's JWT, and its system prompt forbids stating numbers that are not in tool results. Pro plan.

## 7. Security implementation

- RLS on every table; anon table access revoked; organisation, shop and barber isolation; client privacy (barbers only see clients they've served; private notes visible to the author and owner only).
- `SECURITY DEFINER` functions pin `search_path`; service-only functions (`claim_due_notifications`, `run_periodic_jobs`) are revoked from `PUBLIC`.
- Invitations are bound to the invited email; managers cannot invite managers, change permissions, or touch the owner.
- Plan limits (barbers, locations, features) are enforced in the database.
- Audit log triggers on 22 tables record actor, diff, IP and user agent (from PostgREST request headers).
- CSV exports neutralise spreadsheet formula injection.
- Guest booking links are capability tokens (`manage_token`, `review_token`, `claim_token`); online bookers are capped at 4 upcoming appointments.

## 8. Edge cases handled

Concurrent booking of the same slot, a slot taken while the client is on the details step (UI returns to times with fresh data), barber edits availability mid-booking (the booking re-validates), cancellations (reminders cancelled, waitlist offered), reschedules (atomic, history kept), service price or duration changes (snapshots keep history), barber leaves (archived, history intact, future appointments reported), no-shows (fee policy), walk-in arriving during a booked block (refused with the next booking time), missing payments ("completed · unpaid" surfaced on dashboard and payments), barber finishing early or late (timer data, "running long" insight), shop closing unexpectedly (closure + affected list), timezone and DST (shop-timezone wall clock everywhere), multiple locations (org-wide memberships, location switcher), duplicate clients (phone/email dedupe + merge), offline (service-worker app shell; data never cached).

## 9. Production readiness

**Ready:** schema, RLS, RPCs, availability engine, all three experiences, analytics, insights, notifications outbox, tests (unit, DB, browser E2E).

**Before launch, configure:**
1. Supabase project: run the migrations, deploy the functions, set secrets, and schedule the dispatcher.
2. Email provider (Resend adapter included) and a verified sender domain.
3. Billing: connect Stripe to `subscriptions` (the provider fields are ready) and add a checkout page; plan changes are currently manual.
4. Image uploads: photo and logo fields take URLs; wire Supabase Storage for uploads.
5. Rate limiting / bot protection on public booking (e.g. Cloudflare Turnstile) beyond the per-client cap.

**Known gaps / remaining issues**
- No online card capture, deposits or card-on-file yet (the policy settings are stored and shown, and the payments model is provider-agnostic).
- SMS, WhatsApp and push adapters are stubs in the dispatcher (email is implemented).
- The analytics RPC computes on the fly; `analytics_snapshots` is filled daily, but long-range reports don't read from it yet (fine to roughly 400 days per shop).
- Memberships aren't yet consumed automatically at checkout (usage table ready); loyalty points accrue but there is no redemption UI.

## 10. App Store readiness

The PWA is installable (manifest, maskable icons, service worker, standalone display, safe-area insets, bottom navigation). `capacitor.config.ts` is in place: `npm run build && npx cap add ios android && npx cap sync`. Native push will need FCM/APNs plus a `push` adapter in the dispatcher; Sign in with Apple is needed if social login is added.

## 11. Recommended next features

1. Stripe Connect: deposits, card on file, no-show fee capture, tap-to-pay, payouts per barber.
2. SMS and WhatsApp reminders (Twilio / Meta Cloud API adapters).
3. Product sales and inventory (retail pomade, etc.) with commission on products.
4. Payroll export: commission and booth-rent statements per pay period.
5. Google / Instagram "Book" button integrations and Reserve with Google.
6. Dynamic pricing for peak/off-peak windows, driven by the utilization heatmap.
7. Multi-location comparison dashboard (data model ready; UI shows one location at a time).
8. Client mobile app with saved cards and one-tap "same as last time".


## 12. BarberNGo: chairs, chair owners, inventory, finance, live status

| Area | Tables / RPCs | Rules |
|---|---|---|
| Chairs | `chairs`, `save_chair`, `delete_chair`, `shop_live_board` | One barber per chair (moving frees the old chair). |
| Employee vs chair owner | `barbers.barber_type`, `set_barber_type`, `set_my_service_price`, `save_my_service`, `app.can_edit_schedule` | Chair owner ⇒ booth-rental plan (keeps 100%), controls own prices/services/hours. Employees follow `shop_settings.barbers_can_set_prices` / `employees_manage_schedule`. |
| Chair rent | `rent_charges`, `rent_payments`, `rent_ledger`, `record_rent_payment`, `set_rent_charge` | Charges generated idempotently per week/month from the effective-dated commission plan; due after `rent_due_days`; overpayment refused; only `finance.manage` records payments. |
| Inventory | `products`, `inventory_movements`, `save_product`, `move_stock`, `sell_products`, `archive_product` | Stock moves only through RPCs (purchase, use, waste, return, adjustment, count, sale), never negative. `owner_barber_id` = a chair owner's private stock, invisible to the shop owner. Sales: own products 100% to the barber (`product_own`), shop products pay `product_commission_bps` (`product`). Voids restock. Product revenue never counts as service revenue. |
| Expenses | `expenses` (RLS CRUD) | Shop expenses need `finance.manage`; a chair owner's are private to them. |
| Finance | `finance_summary(shop, from, to, barber?)` | Cash basis. Shop: services (employees) + product sales + rent collected + fees + tips kept − commissions − product commissions − inventory purchases − expenses; plus payouts per barber, rent outstanding, inventory value/COGS, pass-through. Barber: their share + tips + products − rent − inventory − expenses (private parts only for the barber). |
| Live status | `app.barber_live`, `get_shop_live` (public), `set_my_presence` | CUTTING · BOOKED · BREAK · QUEUE · AVAILABLE · OFFLINE · NOT_WORKING from the timer, calendar, schedule gaps, blocks, presence and queue. Public pages poll every 10–15 s (anon has no Realtime access by design); staff screens use Realtime + polling. |
| Walk-in queue | `join_walk_in_queue`, `get_walk_in_ticket`, `leave_walk_in_queue`, `app.walk_in_queue_rows` | No account; idempotent per phone; capacity check; notifications `queue.joined`, `queue.almost_ready` (threshold setting), `queue.your_turn`. |
| Smart service time | `app.learned_minutes`, `app.barber_service_quote`, `service_time_stats`, `booking_settings.smart_durations` | Override › learned (60–150% of default) › default. |
| Early finish | `appointments.released_at` / `occupied_until` | The no-overlap constraint and the engine use `occupied_until`, so a chair is free the minute a cut completes. |
| Operations | `shop_operations` | Average wait, on-time %, walk-ins (served / left), timed cuts, product sales. |
| Notifications | `shop_settings.sms_channel` | Every client message is also queued on WhatsApp/SMS (Twilio adapter); channel templates fall back to the email text. |
