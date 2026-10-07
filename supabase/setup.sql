-- BarberNGo: complete database setup for a Supabase project.
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run (run once, on a fresh project).
-- Generated from supabase/migrations/*.sql by scripts/build-setup-sql.sh — do not edit by hand.
-- Runs as one transaction: if anything fails, nothing is created. If a previous attempt left
-- objects behind ("already exists" errors), run supabase/reset.sql first.

begin;

-- ===================== 20261007000001_foundation.sql =====================
-- =============================================================================
-- BarberNGo — foundation: extensions, private schema, enums, shared helpers
-- =============================================================================
-- Conventions
--   * Money is stored as integer cents (bigint) — never floats.
--   * All instants are timestamptz; wall-clock rules (hours, availability) are
--     stored as `time` + weekday and resolved in the shop's IANA timezone, so
--     DST transitions are handled by Postgres' tz database.
--   * Soft deletion via `deleted_at` on business entities that are referenced
--     by history (barbers, services, clients, shops).
--   * The `app` schema is private (not exposed through the API). Everything a
--     browser may call lives in `public` and is guarded by RLS or by explicit
--     permission checks inside SECURITY DEFINER functions.
-- =============================================================================

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.staff_role as enum ('owner', 'manager', 'barber', 'receptionist');

create type public.appointment_status as enum (
  'BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE',
  'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'
);

-- What occupies a slot on the barber's calendar.
create type public.calendar_kind as enum ('appointment', 'block', 'break', 'personal', 'emergency');

create type public.booking_source as enum ('online', 'staff', 'walk_in', 'waitlist', 'rebook', 'phone');

create type public.payment_status as enum ('UNPAID', 'PAID', 'PARTIAL', 'REFUNDED', 'VOID');
create type public.payment_method as enum ('cash', 'card', 'transfer', 'mobile', 'gift_card', 'membership', 'other');

create type public.commission_type as enum ('percentage', 'fixed', 'tiered', 'booth_rental', 'hybrid');

create type public.exception_kind as enum (
  'time_off', 'vacation', 'holiday', 'sick', 'emergency', 'closure', 'extra_hours'
);

create type public.walk_in_status as enum ('waiting', 'called', 'serving', 'done', 'left', 'cancelled');
create type public.waitlist_status as enum ('active', 'notified', 'claimed', 'expired', 'cancelled');

create type public.notification_channel as enum ('email', 'sms', 'push', 'whatsapp', 'in_app');
create type public.notification_status as enum ('queued', 'sending', 'sent', 'failed', 'cancelled', 'skipped');

create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'paused', 'cancelled');

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Normalise phone numbers to digits (keeps a leading +) for de-duplication.
create or replace function app.normalize_phone(p text)
returns text language sql immutable as $$
  select nullif(
    case when p is null then null
         when left(trim(p), 1) = '+' then '+' || regexp_replace(p, '\D', '', 'g')
         else regexp_replace(p, '\D', '', 'g') end, '')
$$;

create or replace function app.slugify(p text)
returns text language sql immutable as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '-', 'g'))
$$;

-- Request metadata forwarded by PostgREST (used by the audit log).
create or replace function app.request_header(p_name text)
returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> p_name
$$;

-- Raise an error with a stable machine-readable code the frontend can map.
create or replace function app.fail(p_code text, p_message text default null)
returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_message, p_code);
end $$;

-- ===================== 20261007000002_tenancy.sql =====================
-- =============================================================================
-- Multi-tenancy: profiles, organizations, shops (locations), memberships,
-- subscription plans & feature gating, shop/booking settings, business hours.
--
-- Hierarchy:  organization (the business / billing account)
--               └── shop (a physical location with its own calendar & staff)
-- A membership with shop_id = NULL applies to every shop in the organization
-- (owners and org-wide managers); otherwise it is scoped to one shop.
-- =============================================================================

-- Profile mirror of auth.users (Supabase convention).
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  avatar_url text,
  locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

create or replace function app.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
          new.raw_user_meta_data ->> 'phone')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------------
-- Subscription plans (feature gating lives in data, never hardcoded in the UI)
-- ---------------------------------------------------------------------------
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  price_cents bigint not null default 0,
  currency text not null default 'USD',
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  -- Limits & feature flags, e.g. {"max_barbers": 1, "waitlist": false, ...}
  features jsonb not null default '{}'::jsonb,
  sort_order int not null default 0,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.subscription_plans (code, name, description, price_cents, sort_order, features) values
  ('starter', 'Starter', 'For the independent barber.', 2900, 1, '{
     "max_barbers": 1, "max_locations": 1, "booking": true, "calendar": true, "clients": true,
     "analytics_basic": true, "analytics_advanced": false, "waitlist": false, "walk_ins": false,
     "commissions": false, "automations": false, "ai_insights": false, "marketing": false,
     "custom_branding": false, "api": false, "exports": false}'),
  ('shop', 'Shop', 'For multi-chair shops.', 7900, 2, '{
     "max_barbers": null, "max_locations": 1, "booking": true, "calendar": true, "clients": true,
     "analytics_basic": true, "analytics_advanced": true, "waitlist": true, "walk_ins": true,
     "commissions": true, "automations": true, "ai_insights": false, "marketing": false,
     "custom_branding": false, "api": false, "exports": true}'),
  ('pro', 'Pro', 'Intelligence, marketing and multiple locations.', 14900, 3, '{
     "max_barbers": null, "max_locations": null, "booking": true, "calendar": true, "clients": true,
     "analytics_basic": true, "analytics_advanced": true, "waitlist": true, "walk_ins": true,
     "commissions": true, "automations": true, "ai_insights": true, "marketing": true,
     "custom_branding": true, "api": true, "exports": true}');

-- ---------------------------------------------------------------------------
-- Organizations & shops
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  owner_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index organizations_owner_idx on public.organizations (owner_id);
create trigger organizations_touch before update on public.organizations
  for each row execute function app.touch_updated_at();

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations (id) on delete cascade,
  plan_id uuid not null references public.subscription_plans (id),
  status public.subscription_status not null default 'trialing',
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at timestamptz,
  -- Provider-agnostic: Stripe/Paddle/etc. references are opaque strings.
  provider text,
  provider_customer_ref text,
  provider_subscription_ref text,
  -- Per-organization overrides of plan features (sales deals, beta access).
  feature_overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function app.touch_updated_at();

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])?$'),
  timezone text not null default 'America/New_York',
  tagline text,
  description text,
  phone text,
  email text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  postal_code text,
  country text default 'US',
  latitude double precision,
  longitude double precision,
  instagram text,
  website text,
  logo_url text,
  cover_url text,
  gallery_urls text[] not null default '{}',
  accent_color text not null default '#1683FF' check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  custom_domain text unique,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index shops_org_idx on public.shops (organization_id) where deleted_at is null;
create trigger shops_touch before update on public.shops
  for each row execute function app.touch_updated_at();

-- Validate timezone names on write so wall-clock math can never fail later.
create or replace function app.validate_shop_timezone()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    perform app.fail('INVALID_TIMEZONE', 'Unknown timezone ' || new.timezone);
  end if;
  return new;
end $$;
create trigger shops_validate_tz before insert or update of timezone on public.shops
  for each row execute function app.validate_shop_timezone();

-- ---------------------------------------------------------------------------
-- Memberships & invitations
-- ---------------------------------------------------------------------------
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  shop_id uuid references public.shops (id) on delete cascade, -- NULL = all shops in org
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.staff_role not null,
  -- Fine-grained grants/revocations on top of the role defaults,
  -- e.g. {"financials.all_barbers": true} for a trusted manager.
  permissions jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index memberships_unique on public.memberships
  (organization_id, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), user_id);
create index memberships_user_idx on public.memberships (user_id) where is_active;
create index memberships_shop_idx on public.memberships (shop_id);
create trigger memberships_touch before update on public.memberships
  for each row execute function app.touch_updated_at();

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  shop_id uuid references public.shops (id) on delete cascade,
  email text not null check (email = lower(email)),
  role public.staff_role not null check (role <> 'owner'),
  barber_id uuid, -- FK added once barbers exists
  token uuid not null unique default gen_random_uuid(),
  invited_by uuid references auth.users (id),
  accepted_by uuid references auth.users (id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now()
);
create index invitations_shop_idx on public.invitations (shop_id);
create index invitations_email_idx on public.invitations (email) where accepted_at is null;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create table public.shop_settings (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  currency text not null default 'USD',
  tax_rate_bps int not null default 0 check (tax_rate_bps between 0 and 5000), -- basis points
  prices_include_tax boolean not null default false,
  tips_enabled boolean not null default true,
  tip_presets_pct int[] not null default '{15,20,25}',
  default_rebook_weeks int not null default 3 check (default_rebook_weeks between 1 and 26),
  -- Retention model: expected days between visits when a client has < 2 visits.
  default_visit_cadence_days int not null default 28,
  reminder_offsets_minutes int[] not null default '{1440,120}',
  review_request_delay_minutes int not null default 60,
  review_requests_enabled boolean not null default true,
  rebooking_reminders_enabled boolean not null default true,
  waitlist_enabled boolean not null default true,
  walk_ins_enabled boolean not null default true,
  notify_staff_on_booking boolean not null default true,
  utilization_target_pct int not null default 85,
  week_starts_on int not null default 1 check (week_starts_on between 0 and 6),
  updated_at timestamptz not null default now()
);
create trigger shop_settings_touch before update on public.shop_settings
  for each row execute function app.touch_updated_at();

create table public.booking_settings (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  online_booking_enabled boolean not null default true,
  allow_any_barber boolean not null default true,
  auto_confirm boolean not null default true,
  min_notice_minutes int not null default 60 check (min_notice_minutes >= 0),
  max_advance_days int not null default 60 check (max_advance_days between 1 and 365),
  buffer_minutes int not null default 0 check (buffer_minutes between 0 and 120),
  -- Granularity of the clock grid for offered start times. The engine also
  -- offers "tight fit" starts directly after existing appointments.
  slot_interval_minutes int not null default 15 check (slot_interval_minutes in (5, 10, 15, 20, 30, 60)),
  cancellation_window_hours int not null default 4 check (cancellation_window_hours >= 0),
  late_cancel_fee_cents bigint not null default 0,
  no_show_fee_cents bigint not null default 0,
  deposit_required boolean not null default false,
  deposit_cents bigint not null default 0,
  card_required boolean not null default false,
  allow_client_reschedule boolean not null default true,
  allow_client_cancel boolean not null default true,
  require_phone boolean not null default true,
  require_email boolean not null default false,
  cancellation_policy_text text,
  waitlist_claim_minutes int not null default 30,
  updated_at timestamptz not null default now()
);
create trigger booking_settings_touch before update on public.booking_settings
  for each row execute function app.touch_updated_at();

create table public.business_hours (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday (Postgres dow)
  opens_at time not null,
  closes_at time not null,
  check (closes_at > opens_at)
);
create index business_hours_shop_idx on public.business_hours (shop_id, weekday);

-- Create settings rows automatically for every new shop.
create or replace function app.init_shop()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.shop_settings (shop_id) values (new.id) on conflict do nothing;
  insert into public.booking_settings (shop_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger shops_init after insert on public.shops
  for each row execute function app.init_shop();

-- ===================== 20261007000003_catalog_schedule_crm.sql =====================
-- =============================================================================
-- Barbers, services, schedules, clients (CRM)
-- =============================================================================

create table public.barbers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null, -- linked staff login
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  slug text not null,
  title text,                        -- e.g. "Fade Specialist"
  bio text,
  specialties text[] not null default '{}',
  photo_url text,
  instagram text,
  color text not null default '#1683FF' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  accepts_online_booking boolean not null default true,
  buffer_minutes int check (buffer_minutes between 0 and 120),   -- NULL = shop default
  max_daily_appointments int check (max_daily_appointments > 0), -- NULL = unlimited
  same_day_booking boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index barbers_shop_slug on public.barbers (shop_id, slug) where deleted_at is null;
create unique index barbers_shop_user on public.barbers (shop_id, user_id) where user_id is not null and deleted_at is null;
create index barbers_user_idx on public.barbers (user_id) where user_id is not null;
create trigger barbers_touch before update on public.barbers
  for each row execute function app.touch_updated_at();

alter table public.invitations
  add constraint invitations_barber_fk foreign key (barber_id) references public.barbers (id) on delete set null;

create table public.services (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  description text,
  category text,
  price_cents bigint not null check (price_cents >= 0),
  duration_minutes int not null check (duration_minutes between 5 and 480),
  is_active boolean not null default true,
  is_public boolean not null default true,   -- bookable online
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index services_shop_idx on public.services (shop_id) where deleted_at is null;
create trigger services_touch before update on public.services
  for each row execute function app.touch_updated_at();

-- Which barber performs which service, with optional price/duration overrides.
create table public.barber_services (
  barber_id uuid not null references public.barbers (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  price_cents bigint check (price_cents >= 0),
  duration_minutes int check (duration_minutes between 5 and 480),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (barber_id, service_id)
);
create index barber_services_service_idx on public.barber_services (service_id);

-- Weekly recurring schedule. kind='work' rows define working windows,
-- kind='break' rows are subtracted (lunch, breaks).
create table public.availability (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barbers (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  starts_at time not null,
  ends_at time not null,
  kind text not null default 'work' check (kind in ('work', 'break')),
  label text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index availability_barber_idx on public.availability (barber_id, weekday);

-- One-off changes. barber_id NULL means shop-wide (e.g. unexpected closure).
-- kind 'extra_hours' ADDS availability (holiday shifts, temporary changes);
-- every other kind removes it.
create table public.availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid references public.barbers (id) on delete cascade,
  kind public.exception_kind not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (kind <> 'closure' or barber_id is null)
);
create index availability_exceptions_lookup on public.availability_exceptions using gist
  (shop_id, tstzrange(starts_at, ends_at));
create index availability_exceptions_barber on public.availability_exceptions (barber_id, starts_at);

-- ---------------------------------------------------------------------------
-- Clients (CRM). Clients are per-shop records; a client may optionally be
-- linked to an auth user (client account) via user_id.
-- ---------------------------------------------------------------------------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  first_name text not null check (length(trim(first_name)) between 1 and 80),
  last_name text,
  phone text,
  phone_normalized text generated always as (app.normalize_phone(phone)) stored,
  email text,
  birthday date,
  tags text[] not null default '{}',
  source text not null default 'online', -- online | walk_in | staff | import | referral
  referral_code text unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  referred_by_client_id uuid references public.clients (id) on delete set null,
  marketing_email_opt_in boolean not null default false,
  marketing_sms_opt_in boolean not null default false,
  merged_into_id uuid references public.clients (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Emails are stored lower-cased so equality and uniqueness are case-insensitive.
create or replace function app.clients_normalize()
returns trigger language plpgsql as $$
begin
  new.email := lower(nullif(trim(new.email), ''));
  new.phone := nullif(trim(new.phone), '');
  new.first_name := trim(new.first_name);
  new.last_name := nullif(trim(new.last_name), '');
  return new;
end $$;
create trigger clients_normalize before insert or update of email, phone, first_name, last_name on public.clients
  for each row execute function app.clients_normalize();

create unique index clients_shop_phone on public.clients (shop_id, phone_normalized)
  where phone_normalized is not null and deleted_at is null and merged_into_id is null;
create unique index clients_shop_email on public.clients (shop_id, email)
  where email is not null and deleted_at is null and merged_into_id is null;
create index clients_shop_idx on public.clients (shop_id) where deleted_at is null;
create index clients_user_idx on public.clients (user_id) where user_id is not null;
create index clients_name_search on public.clients (shop_id, lower(first_name || ' ' || coalesce(last_name, '')));
create trigger clients_touch before update on public.clients
  for each row execute function app.touch_updated_at();

create table public.client_preferences (
  client_id uuid primary key references public.clients (id) on delete cascade,
  preferred_barber_id uuid references public.barbers (id) on delete set null,
  preferred_service_id uuid references public.services (id) on delete set null,
  rebook_interval_days int check (rebook_interval_days between 3 and 365),
  preferred_contact text check (preferred_contact in ('email', 'sms', 'whatsapp', 'push')),
  preferences jsonb not null default '{}'::jsonb, -- free-form: drink, conversation, etc.
  updated_at timestamptz not null default now()
);
create trigger client_preferences_touch before update on public.client_preferences
  for each row execute function app.touch_updated_at();

-- Staff notes about a client ("Low fade, #2 on top, beard shaped naturally").
-- visibility: 'team' = all staff of the shop; 'private' = author + owner only.
create table public.client_notes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  author_id uuid not null references auth.users (id),
  barber_id uuid references public.barbers (id) on delete set null,
  body text not null check (length(trim(body)) between 1 and 4000),
  visibility text not null default 'team' check (visibility in ('team', 'private')),
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index client_notes_client_idx on public.client_notes (client_id) where deleted_at is null;
create trigger client_notes_touch before update on public.client_notes
  for each row execute function app.touch_updated_at();

-- Client-side favourites (a logged in client can favourite barbers).
create table public.client_favorites (
  user_id uuid not null references auth.users (id) on delete cascade,
  barber_id uuid not null references public.barbers (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, barber_id)
);

-- ===================== 20261007000004_appointments_ops.sql =====================
-- =============================================================================
-- Appointments, status history, walk-ins, waitlist
-- =============================================================================

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid not null references public.barbers (id),
  client_id uuid references public.clients (id) on delete set null, -- NULL for blocks
  kind public.calendar_kind not null default 'appointment',
  status public.appointment_status not null default 'BOOKED',
  source public.booking_source not null default 'online',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- Service end + buffer. The exclusion constraint uses this, so buffers can
  -- never be double-booked either. Maintained by trigger.
  buffer_minutes int not null default 0 check (buffer_minutes between 0 and 120),
  blocked_until timestamptz not null,
  title text,                         -- for blocks / personal time
  notes text,                         -- staff-visible booking notes
  client_message text,                -- message the client left when booking
  expected_price_cents bigint not null default 0,
  payment_status public.payment_status not null default 'UNPAID',
  -- Haircut timer
  checked_in_at timestamptz,
  actual_started_at timestamptz,
  actual_finished_at timestamptz,
  actual_duration_seconds int generated always as (
    case when actual_started_at is not null and actual_finished_at is not null
         then greatest(0, extract(epoch from (actual_finished_at - actual_started_at))::int) end
  ) stored,
  completed_at timestamptz,
  -- Cancellation / no-show policy outcome
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id),
  cancelled_by_client boolean,
  cancel_reason text,
  is_late_cancellation boolean not null default false,
  fee_cents bigint not null default 0,
  -- Lineage
  rescheduled_from_id uuid references public.appointments (id),
  rebooked_from_id uuid references public.appointments (id),   -- "Book again" lineage
  walk_in_id uuid,                                              -- FK below
  waitlist_id uuid,                                             -- FK below
  -- Guest self-service (manage link without an account)
  manage_token uuid not null unique default gen_random_uuid(),
  booked_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (ends_at > starts_at),
  check (blocked_until >= ends_at),
  check (kind <> 'appointment' or client_id is not null or status in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')),
  check (actual_finished_at is null or actual_started_at is null or actual_finished_at >= actual_started_at)
);

-- THE double-booking guarantee: two live calendar entries for the same barber
-- can never overlap (including buffers). Concurrent transactions racing for
-- the same slot are serialised by the index; the loser gets 23P01.
alter table public.appointments add constraint appointments_no_overlap
  exclude using gist (barber_id with =, tstzrange(starts_at, blocked_until) with &&)
  where (status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED') and deleted_at is null);

create index appointments_shop_time on public.appointments (shop_id, starts_at) where deleted_at is null;
create index appointments_barber_time on public.appointments (barber_id, starts_at) where deleted_at is null;
create index appointments_client_time on public.appointments (client_id, starts_at desc) where deleted_at is null;
create index appointments_status on public.appointments (shop_id, status) where deleted_at is null;
create index appointments_completed on public.appointments (shop_id, completed_at) where status = 'COMPLETED';

create or replace function app.appointments_before_write()
returns trigger language plpgsql as $$
begin
  new.blocked_until := new.ends_at + make_interval(mins => new.buffer_minutes);
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger appointments_before_write before insert or update on public.appointments
  for each row execute function app.appointments_before_write();

-- Guard the barber/shop relationship (barber must belong to the same shop).
create or replace function app.appointments_check_tenant()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.barbers b where b.id = new.barber_id and b.shop_id = new.shop_id) then
    perform app.fail('BARBER_NOT_IN_SHOP');
  end if;
  if new.client_id is not null and not exists (
    select 1 from public.clients c where c.id = new.client_id and c.shop_id = new.shop_id) then
    perform app.fail('CLIENT_NOT_IN_SHOP');
  end if;
  return new;
end $$;
create trigger appointments_check_tenant before insert or update of barber_id, client_id, shop_id
  on public.appointments for each row execute function app.appointments_check_tenant();

-- Services rendered in an appointment (snapshot of name/price/duration at
-- booking time so later catalogue changes never rewrite history).
create table public.appointment_services (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  service_id uuid references public.services (id) on delete set null,
  name text not null,
  price_cents bigint not null check (price_cents >= 0),
  duration_minutes int not null check (duration_minutes > 0),
  position smallint not null default 0
);
create index appointment_services_appt on public.appointment_services (appointment_id);
create index appointment_services_service on public.appointment_services (service_id);

-- ---------------------------------------------------------------------------
-- Status machine + history
-- ---------------------------------------------------------------------------
create table public.appointment_status_history (
  id bigint generated always as identity primary key,
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  from_status public.appointment_status,
  to_status public.appointment_status not null,
  changed_by uuid references auth.users (id),
  note text,
  changed_at timestamptz not null default now()
);
create index appointment_status_history_appt on public.appointment_status_history (appointment_id, changed_at);

create or replace function app.valid_status_transition(p_from public.appointment_status, p_to public.appointment_status)
returns boolean language sql immutable as $$
  select p_from = p_to or case p_from
    when 'BOOKED'      then p_to in ('CONFIRMED', 'CHECKED_IN', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED')
    when 'CONFIRMED'   then p_to in ('BOOKED', 'CHECKED_IN', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED')
    when 'CHECKED_IN'  then p_to in ('CONFIRMED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW')
    when 'IN_SERVICE'  then p_to in ('CHECKED_IN', 'COMPLETED')
    when 'COMPLETED'   then false
    when 'CANCELLED'   then p_to in ('BOOKED')          -- restore (re-validated by the exclusion constraint)
    when 'NO_SHOW'     then p_to in ('CHECKED_IN', 'BOOKED')
    when 'RESCHEDULED' then false
  end
$$;

create or replace function app.appointments_status_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not app.valid_status_transition(old.status, new.status) then
      perform app.fail('INVALID_STATUS_TRANSITION', old.status || ' -> ' || new.status);
    end if;
    if new.status = 'COMPLETED' and new.completed_at is null then
      new.completed_at := now();
    end if;
    if new.status = 'CANCELLED' and new.cancelled_at is null then
      new.cancelled_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger appointments_status_guard before update on public.appointments
  for each row execute function app.appointments_status_guard();

create or replace function app.appointments_status_log()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.appointment_status_history (appointment_id, from_status, to_status, changed_by)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid());
  end if;
  return null;
end $$;
create trigger appointments_status_log after insert or update of status on public.appointments
  for each row execute function app.appointments_status_log();

-- ---------------------------------------------------------------------------
-- Walk-in queue
-- ---------------------------------------------------------------------------
create table public.walk_ins (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  name text not null check (length(trim(name)) between 1 and 80),
  phone text,
  service_id uuid references public.services (id) on delete set null,
  preferred_barber_id uuid references public.barbers (id) on delete set null, -- NULL = any
  status public.walk_in_status not null default 'waiting',
  quoted_wait_minutes int,
  party_size int not null default 1 check (party_size between 1 and 10),
  notes text,
  appointment_id uuid references public.appointments (id) on delete set null,
  assigned_barber_id uuid references public.barbers (id) on delete set null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  called_at timestamptz,
  served_at timestamptz,
  left_at timestamptz
);
create index walk_ins_queue on public.walk_ins (shop_id, status, created_at);

alter table public.appointments
  add constraint appointments_walk_in_fk foreign key (walk_in_id) references public.walk_ins (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Waitlist
-- ---------------------------------------------------------------------------
create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  barber_id uuid references public.barbers (id) on delete cascade, -- NULL = any barber
  desired_date date not null,
  time_from time not null default '00:00',
  time_to time not null default '23:59',
  status public.waitlist_status not null default 'active',
  -- When a slot opens we offer it (one offer at a time per entry).
  offered_barber_id uuid references public.barbers (id) on delete set null,
  offered_starts_at timestamptz,
  offer_expires_at timestamptz,
  claim_token uuid not null unique default gen_random_uuid(),
  notified_at timestamptz,
  claimed_appointment_id uuid references public.appointments (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (time_to > time_from)
);
create index waitlist_match on public.waitlist (shop_id, desired_date, status);
create trigger waitlist_touch before update on public.waitlist
  for each row execute function app.touch_updated_at();

alter table public.appointments
  add constraint appointments_waitlist_fk foreign key (waitlist_id) references public.waitlist (id) on delete set null;

-- ===================== 20261007000005_money.sql =====================
-- =============================================================================
-- Payments, tips, commissions, barber earnings.
-- The payment row is the financial source of truth. It is provider-agnostic:
-- `provider`/`provider_ref` let Stripe (or anything else) be attached later
-- without touching the rest of the model.
-- Financial tables are written ONLY through SECURITY DEFINER RPCs which
-- enforce permissions and compute amounts server-side.
-- =============================================================================

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  client_id uuid references public.clients (id) on delete set null,
  barber_id uuid references public.barbers (id),
  kind text not null default 'service' check (kind in ('service', 'no_show_fee', 'late_cancel_fee', 'deposit', 'gift_card', 'membership', 'product')),
  subtotal_cents bigint not null check (subtotal_cents >= 0),       -- services before discount
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  tip_cents bigint not null default 0 check (tip_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),             -- subtotal - discount + tax + tip
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  method public.payment_method not null default 'cash',
  status public.payment_status not null default 'PAID',
  promo_code_id uuid,
  gift_card_id uuid,
  provider text,          -- 'manual' | 'stripe' | 'square' | ...
  provider_ref text,
  notes text,
  recorded_by uuid references auth.users (id),
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  check (total_cents = subtotal_cents - discount_cents + tax_cents + tip_cents),
  check (discount_cents <= subtotal_cents),
  check (refunded_cents <= amount_paid_cents)
);
create index payments_shop_time on public.payments (shop_id, paid_at);
create index payments_barber_time on public.payments (barber_id, paid_at);
create index payments_appt on public.payments (appointment_id);
create index payments_client on public.payments (client_id);
create unique index payments_provider_ref on public.payments (provider, provider_ref) where provider_ref is not null;
create trigger payments_touch before update on public.payments
  for each row execute function app.touch_updated_at();

-- Line items (services, products) on a payment.
create table public.payment_items (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  service_id uuid references public.services (id) on delete set null,
  description text not null,
  quantity int not null default 1 check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  total_cents bigint not null check (total_cents >= 0)
);
create index payment_items_payment on public.payment_items (payment_id);
create index payment_items_service on public.payment_items (service_id);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  reason text,
  provider_ref text,
  refunded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index refunds_payment on public.refunds (payment_id);

-- Tips tracked separately from service revenue (one row per tip so tips can be
-- added after the fact, e.g. a card tip settled later, or split).
create table public.tips (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  payment_id uuid references public.payments (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  barber_id uuid not null references public.barbers (id),
  amount_cents bigint not null check (amount_cents > 0),
  method public.payment_method not null default 'cash',
  created_at timestamptz not null default now()
);
create index tips_shop_time on public.tips (shop_id, created_at);
create index tips_barber_time on public.tips (barber_id, created_at);

-- Commission configuration per barber (history kept via effective dates).
--   percentage   : barber gets percent_bps of net service revenue
--   fixed        : barber gets fixed_cents per service performed
--   tiered       : percent depends on month-to-date net service revenue,
--                  tiers = [{"up_to_cents": 300000, "percent_bps": 4000}, {"up_to_cents": null, "percent_bps": 5000}]
--   booth_rental : barber keeps 100% of service revenue and pays rent_cents per rent_period
--   hybrid       : reduced rent + percent_bps
create table public.commissions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid not null references public.barbers (id) on delete cascade,
  type public.commission_type not null default 'percentage',
  percent_bps int check (percent_bps between 0 and 10000),
  fixed_cents bigint check (fixed_cents >= 0),
  tiers jsonb,
  rent_cents bigint check (rent_cents >= 0),
  rent_period text check (rent_period in ('week', 'month')),
  tip_share_bps int not null default 10000 check (tip_share_bps between 0 and 10000), -- barber's share of tips
  effective_from date not null default current_date,
  effective_to date,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (type <> 'percentage' or percent_bps is not null),
  check (type <> 'fixed' or fixed_cents is not null),
  check (type <> 'tiered' or jsonb_typeof(tiers) = 'array'),
  check (type <> 'booth_rental' or rent_cents is not null),
  check (type <> 'hybrid' or (percent_bps is not null and rent_cents is not null))
);
create index commissions_barber on public.commissions (barber_id, effective_from desc);
alter table public.commissions add constraint commissions_no_overlap
  exclude using gist (barber_id with =, daterange(effective_from, effective_to, '[]') with &&);

-- Earnings ledger: one row per payment (or adjustment) per barber.
create table public.barber_earnings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid not null references public.barbers (id),
  payment_id uuid references public.payments (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  kind text not null default 'service' check (kind in ('service', 'tip', 'adjustment', 'rent', 'refund')),
  service_revenue_cents bigint not null default 0,  -- net service revenue attributed
  commission_cents bigint not null default 0,       -- barber's share of service revenue
  tip_cents bigint not null default 0,              -- barber's share of tips
  shop_cents bigint not null default 0,             -- shop's share
  commission_id uuid references public.commissions (id) on delete set null, -- snapshot below keeps history
  commission_snapshot jsonb,
  earned_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index barber_earnings_barber_time on public.barber_earnings (barber_id, earned_at);
create index barber_earnings_shop_time on public.barber_earnings (shop_id, earned_at);
create index barber_earnings_payment on public.barber_earnings (payment_id);

-- ===================== 20261007000006_engagement_marketing_audit.sql =====================
-- =============================================================================
-- Reviews, notifications, marketing, analytics snapshots, audit log
-- =============================================================================

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  appointment_id uuid unique references public.appointments (id) on delete set null,
  client_id uuid references public.clients (id) on delete set null,
  barber_id uuid references public.barbers (id) on delete set null,
  barber_rating smallint check (barber_rating between 1 and 5),
  shop_rating smallint check (shop_rating between 1 and 5),
  comment text check (length(comment) <= 2000),
  is_public boolean not null default true,
  owner_reply text,
  replied_at timestamptz,
  hidden_at timestamptz,
  created_at timestamptz not null default now(),
  check (barber_rating is not null or shop_rating is not null)
);
create index reviews_shop_time on public.reviews (shop_id, created_at desc);
create index reviews_barber on public.reviews (barber_id, created_at desc);

-- Review request token per completed appointment (for guest clients).
alter table public.appointments add column review_token uuid unique default gen_random_uuid();

-- ---------------------------------------------------------------------------
-- Notifications: an outbox. Rows are created by database events; a
-- dispatcher (Edge Function on a schedule) delivers them through channel
-- adapters (email now; SMS / WhatsApp / push later — no schema change).
-- ---------------------------------------------------------------------------
create table public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops (id) on delete cascade, -- NULL = platform default
  event text not null,
  channel public.notification_channel not null,
  subject text,
  body text not null,  -- {{client_first_name}}, {{barber_name}}, {{when}}, {{manage_url}}, ...
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index notification_templates_unique on public.notification_templates
  (coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), event, channel);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  event text not null,
  channel public.notification_channel not null default 'email',
  audience text not null default 'client' check (audience in ('client', 'staff', 'owner')),
  client_id uuid references public.clients (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete cascade,
  waitlist_id uuid references public.waitlist (id) on delete cascade,
  to_address text,
  payload jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null default now(),
  status public.notification_status not null default 'queued',
  attempts int not null default 0,
  last_error text,
  provider_ref text,
  sent_at timestamptz,
  read_at timestamptz,          -- in-app notifications
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index notifications_due on public.notifications (scheduled_for) where status = 'queued';
create index notifications_shop on public.notifications (shop_id, created_at desc);
create index notifications_user_inbox on public.notifications (user_id, created_at desc) where channel = 'in_app';
create index notifications_appt on public.notifications (appointment_id);

insert into public.notification_templates (shop_id, event, channel, subject, body) values
  (null, 'appointment.created', 'email', 'You''re booked at {{shop_name}}',
   'Hey {{client_first_name}} 👋 Your {{service_name}} with {{barber_name}} is confirmed for {{when}}.\n\nNeed to change it? {{manage_url}}'),
  (null, 'appointment.confirmed', 'email', 'Appointment confirmed',
   'Hey {{client_first_name}}, {{barber_name}} confirmed your {{service_name}} on {{when}}.'),
  (null, 'appointment.cancelled', 'email', 'Your appointment was cancelled',
   'Hey {{client_first_name}}, your {{service_name}} on {{when}} was cancelled. Book again any time: {{book_url}}'),
  (null, 'appointment.rescheduled', 'email', 'Your appointment moved',
   'Hey {{client_first_name}}, your {{service_name}} with {{barber_name}} is now {{when}}. {{manage_url}}'),
  (null, 'appointment.reminder', 'email', 'Reminder: {{service_name}} {{relative_when}}',
   'Hey {{client_first_name}} 👋 Your {{service_name}} with {{barber_name}} is {{relative_when}} at {{time}}.\n\nConfirm: {{confirm_url}}\nReschedule or cancel: {{manage_url}}'),
  (null, 'appointment.starting_soon', 'email', '{{barber_name}} is almost ready for you',
   'Hey {{client_first_name}}, your chair is ready in about 15 minutes.'),
  (null, 'barber.running_late', 'email', '{{barber_name}} is running a few minutes late',
   'Hey {{client_first_name}}, {{barber_name}} is running about {{minutes}} minutes behind. Sorry for the wait!'),
  (null, 'waitlist.slot_available', 'email', 'A spot opened with {{barber_name}}',
   'Good news {{client_first_name}}! An appointment opened with {{barber_name}} at {{when}}. First to claim it gets it: {{claim_url}}'),
  (null, 'appointment.no_show', 'email', 'We missed you today',
   'Hey {{client_first_name}}, we missed you for your {{service_name}} at {{time}}. Rebook here: {{book_url}}'),
  (null, 'payment.recorded', 'email', 'Receipt from {{shop_name}}',
   'Thanks {{client_first_name}}! Total paid: {{total}}.'),
  (null, 'review.request', 'email', 'How was your cut?',
   'Hey {{client_first_name}}, how was your cut with {{barber_name}}? Tap to rate: {{review_url}}'),
  (null, 'rebooking.reminder', 'email', 'Time for a fresh cut?',
   'Hey {{client_first_name}}, it''s been {{days}} days since your last cut with {{barber_name}}. Book your next one: {{book_url}}'),
  (null, 'staff.new_booking', 'in_app', 'New booking',
   '{{client_name}} booked {{service_name}} for {{when}}.'),
  (null, 'staff.cancellation', 'in_app', 'Cancellation',
   '{{client_name}} cancelled {{service_name}} on {{when}}.');

-- ---------------------------------------------------------------------------
-- Marketing / acquisition
-- ---------------------------------------------------------------------------
create table public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  code text not null check (code = upper(code) and length(code) between 2 and 32),
  description text,
  discount_type text not null check (discount_type in ('percent', 'amount')),
  discount_value bigint not null check (discount_value > 0), -- bps for percent, cents for amount
  max_redemptions int,
  redemptions int not null default 0,
  per_client_limit int default 1,
  first_visit_only boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (shop_id, code)
);
create or replace function app.promo_normalize()
returns trigger language plpgsql as $$
begin
  new.code := upper(trim(new.code));
  return new;
end $$;
create trigger promo_codes_normalize before insert or update of code on public.promo_codes
  for each row execute function app.promo_normalize();
alter table public.payments add constraint payments_promo_fk foreign key (promo_code_id) references public.promo_codes (id);

create table public.gift_cards (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  initial_cents bigint not null check (initial_cents > 0),
  balance_cents bigint not null check (balance_cents >= 0),
  purchaser_client_id uuid references public.clients (id) on delete set null,
  recipient_name text,
  recipient_email text,
  message text,
  expires_at date,
  status text not null default 'active' check (status in ('active', 'redeemed', 'expired', 'void')),
  issued_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (balance_cents <= initial_cents)
);
create index gift_cards_shop on public.gift_cards (shop_id);
alter table public.payments add constraint payments_gift_card_fk foreign key (gift_card_id) references public.gift_cards (id);

create table public.gift_card_transactions (
  id uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references public.gift_cards (id) on delete cascade,
  payment_id uuid references public.payments (id) on delete set null,
  amount_cents bigint not null, -- negative = redemption, positive = issue/top-up
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.membership_plans (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null,
  description text,
  price_cents bigint not null check (price_cents >= 0),
  billing_interval text not null default 'month' check (billing_interval in ('week', 'month', 'year')),
  included_visits int,              -- NULL = unlimited
  included_service_ids uuid[] not null default '{}',
  discount_bps int not null default 0, -- discount on services beyond the allowance
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.client_memberships (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  plan_id uuid not null references public.membership_plans (id),
  status text not null default 'active' check (status in ('active', 'paused', 'cancelled', 'past_due')),
  current_period_start date not null default current_date,
  current_period_end date not null,
  visits_used int not null default 0,
  provider text,
  provider_ref text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index client_memberships_client on public.client_memberships (client_id);

create table public.membership_usage (
  id uuid primary key default gen_random_uuid(),
  client_membership_id uuid not null references public.client_memberships (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  used_at timestamptz not null default now()
);

create table public.loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  points int not null,              -- positive earn, negative redeem
  reason text not null,             -- 'visit', 'referral', 'birthday', 'redeem', 'adjustment'
  payment_id uuid references public.payments (id) on delete set null,
  created_at timestamptz not null default now()
);
create index loyalty_client on public.loyalty_ledger (client_id);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  referrer_client_id uuid not null references public.clients (id) on delete cascade,
  referred_client_id uuid not null unique references public.clients (id) on delete cascade,
  rewarded_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null,
  type text not null check (type in ('reactivation', 'birthday', 'book_again', 'review_request', 'promo', 'custom')),
  channel public.notification_channel not null default 'email',
  audience jsonb not null default '{}'::jsonb, -- e.g. {"health": ["AT_RISK","LOST"]}
  subject text,
  body text not null,
  promo_code_id uuid references public.promo_codes (id) on delete set null,
  is_automated boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sent', 'active', 'paused')),
  scheduled_for timestamptz,
  sent_count int not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Analytics snapshots (daily rollups for fast long-range reporting)
-- ---------------------------------------------------------------------------
create table public.analytics_snapshots (
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid references public.barbers (id) on delete cascade,
  day date not null,
  metrics jsonb not null,
  computed_at timestamptz not null default now()
);
create unique index analytics_snapshots_key on public.analytics_snapshots
  (shop_id, coalesce(barber_id, '00000000-0000-0000-0000-000000000000'::uuid), day);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid,
  shop_id uuid,
  actor_id uuid,
  actor_role text,
  action text not null,           -- insert | update | delete | rpc name
  entity text not null,           -- table name
  entity_id text,
  changes jsonb,                  -- {"field": [old, new]} for updates
  snapshot jsonb,                 -- full row for insert/delete
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index audit_logs_shop_time on public.audit_logs (shop_id, created_at desc);
create index audit_logs_entity on public.audit_logs (entity, entity_id);

create or replace function app.audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changes jsonb;
  v_shop uuid;
  v_org uuid;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_array(v_old -> key, value))
      into v_changes
      from jsonb_each(v_new)
     where v_old -> key is distinct from value
       and key not in ('updated_at', 'blocked_until');
    if v_changes is null then
      return null; -- nothing meaningful changed
    end if;
  end if;

  v_shop := nullif(coalesce(v_row ->> 'shop_id', case when tg_table_name = 'shops' then v_row ->> 'id' end), '')::uuid;
  if v_shop is null and tg_table_name in ('availability', 'barber_services') then
    select b.shop_id into v_shop from public.barbers b where b.id = (v_row ->> 'barber_id')::uuid;
  end if;
  if v_shop is not null then
    select s.organization_id into v_org from public.shops s where s.id = v_shop;
  else
    v_org := nullif(v_row ->> 'organization_id', '')::uuid;
  end if;

  insert into public.audit_logs (organization_id, shop_id, actor_id, action, entity, entity_id, changes, snapshot, ip, user_agent)
  values (v_org, v_shop, auth.uid(), lower(tg_op), tg_table_name, coalesce(v_row ->> 'id', v_row ->> 'shop_id'),
          v_changes,
          case when tg_op in ('INSERT', 'DELETE') then v_row end,
          coalesce(split_part(app.request_header('x-forwarded-for'), ',', 1), app.request_header('x-real-ip')),
          left(app.request_header('user-agent'), 300));
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'shops', 'shop_settings', 'booking_settings', 'business_hours', 'memberships',
    'barbers', 'services', 'barber_services', 'availability', 'availability_exceptions',
    'appointments', 'payments', 'refunds', 'commissions', 'clients', 'client_notes',
    'promo_codes', 'gift_cards', 'membership_plans', 'client_memberships', 'reviews', 'subscriptions'
  ] loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function app.audit()', t || '_audit', t);
  end loop;
end $$;

-- ===================== 20261007000007_permissions_rls.sql =====================
-- =============================================================================
-- Authorization: role defaults, fine-grained permissions, Row Level Security.
--
-- Rules of the road
--   * anon has NO direct table access. Public pages read through
--     SECURITY DEFINER RPCs that only return publishable fields.
--   * Staff read through RLS. Simple catalogue/settings CRUD is allowed
--     directly under RLS; anything with business rules (appointments, money,
--     memberships, walk-ins, waitlist, reviews) is write-only through RPCs.
--   * Financial tables have no INSERT/UPDATE/DELETE policies at all — a
--     barber cannot touch another barber's numbers by changing an id.
-- =============================================================================

-- Default permissions for each role. 'owner' implicitly has everything.
create or replace function app.role_grants(p_role public.staff_role)
returns text[] language sql immutable as $$
  select case p_role
    when 'owner' then array['*']
    when 'manager' then array[
      'shop.view', 'shop.settings', 'staff.manage', 'services.manage', 'schedule.manage_all',
      'calendar.all', 'clients.all', 'payments.view', 'payments.record', 'payments.refund',
      'reports.shop', 'marketing.manage', 'walkins.manage', 'waitlist.manage', 'reviews.manage',
      'notifications.view']
    when 'receptionist' then array[
      'shop.view', 'calendar.all', 'clients.all', 'payments.view', 'payments.record',
      'walkins.manage', 'waitlist.manage']
    when 'barber' then array[
      'shop.view', 'calendar.own', 'clients.own', 'payments.record_own', 'walkins.serve']
  end
$$;

-- Memberships of the current user that apply to a shop (shop-scoped or org-wide).
create or replace function app.shop_memberships(p_shop uuid)
returns setof public.memberships language sql stable security definer set search_path = public, pg_temp as $$
  select m.*
    from public.memberships m
    join public.shops s on s.organization_id = m.organization_id
   where s.id = p_shop
     and m.user_id = auth.uid()
     and m.is_active
     and (m.shop_id is null or m.shop_id = p_shop)
$$;

create or replace function app.is_staff(p_shop uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from app.shop_memberships(p_shop))
$$;

create or replace function app.can(p_shop uuid, p_perm text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m record;
begin
  if p_shop is null or auth.uid() is null then
    return false;
  end if;
  for m in select * from app.shop_memberships(p_shop) loop
    if m.role = 'owner' then return true; end if;
    if m.permissions ? p_perm then
      if (m.permissions ->> p_perm)::boolean then return true; end if;
      continue; -- explicitly revoked for this membership
    end if;
    if p_perm = any (app.role_grants(m.role)) then return true; end if;
  end loop;
  return false;
end $$;

create or replace function app.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = auth.uid() and m.is_active)
$$;

create or replace function app.is_org_owner(p_org uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = auth.uid() and m.is_active and m.role = 'owner')
$$;

-- Barber records that belong to the current user.
create or replace function app.my_barber_ids()
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select b.id from public.barbers b where b.user_id = auth.uid() and b.deleted_at is null and auth.uid() is not null
$$;

create or replace function app.is_my_barber(p_barber uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_barber is not null and p_barber in (select app.my_barber_ids())
$$;

create or replace function app.barber_shop(p_barber uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select shop_id from public.barbers where id = p_barber
$$;

-- Client records linked to the logged-in customer account.
create or replace function app.is_my_client(p_client uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.clients c where c.id = p_client and c.user_id = auth.uid() and auth.uid() is not null)
$$;

-- Can the current staff user see this client? Full CRM access, or a barber
-- who has (had) an appointment with the client.
create or replace function app.can_access_client(p_client uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.clients c
     where c.id = p_client
       and (app.can(c.shop_id, 'clients.all')
            or exists (select 1 from public.appointments a
                        where a.client_id = c.id and a.barber_id in (select app.my_barber_ids())))
  )
$$;

create or replace function app.can_view_appointment(p_appt uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.appointments a
     where a.id = p_appt
       and (app.can(a.shop_id, 'calendar.all')
            or app.is_my_barber(a.barber_id)
            or app.is_my_client(a.client_id))
  )
$$;

-- Financial visibility for one barber's records.
create or replace function app.can_view_barber_money(p_shop uuid, p_barber uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select app.can(p_shop, 'financials.all_barbers') or app.is_my_barber(p_barber)
$$;

-- Plan feature gating: the single place the app asks "is X included?".
create or replace function app.org_features(p_org uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p.features, '{}'::jsonb) || coalesce(s.feature_overrides, '{}'::jsonb)
    from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id
   where s.organization_id = p_org and s.status in ('trialing', 'active', 'past_due')
$$;

create or replace function app.shop_has_feature(p_shop uuid, p_feature text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((app.org_features(s.organization_id) ->> p_feature)::boolean, false)
    from public.shops s where s.id = p_shop
$$;

grant execute on all functions in schema app to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere & remove anon table access.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

grant select on public.subscription_plans to anon;
create policy plans_read on public.subscription_plans for select to anon, authenticated using (is_public);

-- Profiles ---------------------------------------------------------------
create policy profiles_self on public.profiles for select to authenticated
  using (id = auth.uid() or exists (
    select 1 from public.memberships me join public.memberships them
      on them.organization_id = me.organization_id
     where me.user_id = auth.uid() and me.is_active and them.user_id = profiles.id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Organizations / subscriptions -------------------------------------------
create policy orgs_read on public.organizations for select to authenticated using (app.is_org_member(id));
create policy orgs_update on public.organizations for update to authenticated
  using (app.is_org_owner(id)) with check (app.is_org_owner(id));
create policy subs_read on public.subscriptions for select to authenticated using (app.is_org_member(organization_id));

-- Shops & settings --------------------------------------------------------
create policy shops_read on public.shops for select to authenticated using (app.is_staff(id));
create policy shops_update on public.shops for update to authenticated
  using (app.can(id, 'shop.settings')) with check (app.can(id, 'shop.settings'));

create policy shop_settings_read on public.shop_settings for select to authenticated using (app.is_staff(shop_id));
create policy shop_settings_write on public.shop_settings for update to authenticated
  using (app.can(shop_id, 'shop.settings')) with check (app.can(shop_id, 'shop.settings'));
create policy booking_settings_read on public.booking_settings for select to authenticated using (app.is_staff(shop_id));
create policy booking_settings_write on public.booking_settings for update to authenticated
  using (app.can(shop_id, 'shop.settings')) with check (app.can(shop_id, 'shop.settings'));
create policy business_hours_read on public.business_hours for select to authenticated using (app.is_staff(shop_id));
create policy business_hours_write on public.business_hours for all to authenticated
  using (app.can(shop_id, 'shop.settings')) with check (app.can(shop_id, 'shop.settings'));

-- Memberships & invitations: read only; writes via RPC ---------------------
create policy memberships_read on public.memberships for select to authenticated
  using (user_id = auth.uid()
         or (shop_id is not null and app.can(shop_id, 'staff.manage'))
         or app.is_org_owner(organization_id));
create policy invitations_read on public.invitations for select to authenticated
  using (shop_id is not null and app.can(shop_id, 'staff.manage') or app.is_org_owner(organization_id));

-- Barbers / services / schedule ---------------------------------------------
create policy barbers_read on public.barbers for select to authenticated
  using (app.is_staff(shop_id) or user_id = auth.uid());
create policy barbers_insert on public.barbers for insert to authenticated with check (app.can(shop_id, 'staff.manage'));
create policy barbers_update on public.barbers for update to authenticated
  using (app.can(shop_id, 'staff.manage')) with check (app.can(shop_id, 'staff.manage'));

create policy services_read on public.services for select to authenticated using (app.is_staff(shop_id));
create policy services_write on public.services for all to authenticated
  using (app.can(shop_id, 'services.manage')) with check (app.can(shop_id, 'services.manage'));

create policy barber_services_read on public.barber_services for select to authenticated
  using (app.is_staff(app.barber_shop(barber_id)));
create policy barber_services_write on public.barber_services for all to authenticated
  using (app.can(app.barber_shop(barber_id), 'staff.manage') or app.can(app.barber_shop(barber_id), 'services.manage'))
  with check (app.can(app.barber_shop(barber_id), 'staff.manage') or app.can(app.barber_shop(barber_id), 'services.manage'));

create policy availability_read on public.availability for select to authenticated
  using (app.is_staff(app.barber_shop(barber_id)));
create policy availability_write on public.availability for all to authenticated
  using (app.is_my_barber(barber_id) or app.can(app.barber_shop(barber_id), 'schedule.manage_all'))
  with check (app.is_my_barber(barber_id) or app.can(app.barber_shop(barber_id), 'schedule.manage_all'));

create policy exceptions_read on public.availability_exceptions for select to authenticated using (app.is_staff(shop_id));
create policy exceptions_write on public.availability_exceptions for all to authenticated
  using (app.can(shop_id, 'schedule.manage_all')
         or (barber_id is not null and app.is_my_barber(barber_id) and kind <> 'closure'))
  with check (app.can(shop_id, 'schedule.manage_all')
         or (barber_id is not null and app.is_my_barber(barber_id) and app.barber_shop(barber_id) = shop_id and kind <> 'closure'));

-- Clients ---------------------------------------------------------------------
create policy clients_read on public.clients for select to authenticated
  using (user_id = auth.uid() or app.can_access_client(id));
create policy clients_insert on public.clients for insert to authenticated with check (app.is_staff(shop_id));
create policy clients_update on public.clients for update to authenticated
  using (app.can_access_client(id) or user_id = auth.uid())
  with check (app.can_access_client(id) or user_id = auth.uid());

create policy client_prefs_read on public.client_preferences for select to authenticated
  using (app.can_access_client(client_id) or app.is_my_client(client_id));
create policy client_prefs_write on public.client_preferences for all to authenticated
  using (app.can_access_client(client_id) or app.is_my_client(client_id))
  with check (app.can_access_client(client_id) or app.is_my_client(client_id));

create policy client_notes_read on public.client_notes for select to authenticated
  using (deleted_at is null and (
    author_id = auth.uid()
    or (visibility = 'team' and app.can_access_client(client_id))
    or app.can(shop_id, '*private_notes')));
create policy client_notes_insert on public.client_notes for insert to authenticated
  with check (author_id = auth.uid() and app.is_staff(shop_id) and app.can_access_client(client_id));
create policy client_notes_update on public.client_notes for update to authenticated
  using (author_id = auth.uid() or app.can(shop_id, '*private_notes'))
  with check (author_id = auth.uid() or app.can(shop_id, '*private_notes'));

create policy favorites_own on public.client_favorites for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Appointments: read via RLS, write via RPC -----------------------------------
create policy appointments_read on public.appointments for select to authenticated
  using (deleted_at is null and (
    app.can(shop_id, 'calendar.all') or app.is_my_barber(barber_id) or app.is_my_client(client_id)));
create policy appointment_services_read on public.appointment_services for select to authenticated
  using (app.can_view_appointment(appointment_id));
create policy appointment_history_read on public.appointment_status_history for select to authenticated
  using (app.can_view_appointment(appointment_id));

create policy walk_ins_read on public.walk_ins for select to authenticated using (app.is_staff(shop_id));
create policy waitlist_read on public.waitlist for select to authenticated
  using (app.can(shop_id, 'waitlist.manage') or app.is_my_barber(barber_id) or app.is_my_client(client_id)
         or (barber_id is null and app.is_staff(shop_id)));

-- Money: read-only through RLS --------------------------------------------------
create policy payments_read on public.payments for select to authenticated
  using (app.can(shop_id, 'payments.view') or app.is_my_barber(barber_id) or app.is_my_client(client_id));
create policy payment_items_read on public.payment_items for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id));
create policy refunds_read on public.refunds for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id));
create policy tips_read on public.tips for select to authenticated
  using (app.can_view_barber_money(shop_id, barber_id));
create policy commissions_read on public.commissions for select to authenticated
  using (app.can(shop_id, 'commissions.manage') or app.is_my_barber(barber_id));
create policy earnings_read on public.barber_earnings for select to authenticated
  using (app.can_view_barber_money(shop_id, barber_id));

-- Reviews / notifications ------------------------------------------------------
create policy reviews_read on public.reviews for select to authenticated
  using (app.is_staff(shop_id) or app.is_my_client(client_id));
create policy reviews_moderate on public.reviews for update to authenticated
  using (app.can(shop_id, 'reviews.manage')) with check (app.can(shop_id, 'reviews.manage'));

create policy notification_templates_read on public.notification_templates for select to authenticated
  using (shop_id is null or app.is_staff(shop_id));
create policy notification_templates_write on public.notification_templates for all to authenticated
  using (shop_id is not null and app.can(shop_id, 'shop.settings'))
  with check (shop_id is not null and app.can(shop_id, 'shop.settings'));
create policy notifications_read on public.notifications for select to authenticated
  using (user_id = auth.uid() or app.can(shop_id, 'notifications.view'));

-- Marketing ------------------------------------------------------------------------
create policy promo_read on public.promo_codes for select to authenticated using (app.is_staff(shop_id));
create policy promo_write on public.promo_codes for all to authenticated
  using (app.can(shop_id, 'marketing.manage')) with check (app.can(shop_id, 'marketing.manage'));
create policy gift_cards_read on public.gift_cards for select to authenticated using (app.can(shop_id, 'payments.view'));
create policy gift_card_tx_read on public.gift_card_transactions for select to authenticated
  using (exists (select 1 from public.gift_cards g where g.id = gift_card_id));
create policy membership_plans_read on public.membership_plans for select to authenticated using (app.is_staff(shop_id));
create policy membership_plans_write on public.membership_plans for all to authenticated
  using (app.can(shop_id, 'marketing.manage')) with check (app.can(shop_id, 'marketing.manage'));
create policy client_memberships_read on public.client_memberships for select to authenticated
  using (app.can(shop_id, 'clients.all') or app.is_my_client(client_id));
create policy membership_usage_read on public.membership_usage for select to authenticated
  using (exists (select 1 from public.client_memberships cm where cm.id = client_membership_id));
create policy loyalty_read on public.loyalty_ledger for select to authenticated
  using (app.can(shop_id, 'clients.all') or app.is_my_client(client_id));
create policy referrals_read on public.referrals for select to authenticated using (app.can(shop_id, 'clients.all'));
create policy campaigns_rw on public.campaigns for all to authenticated
  using (app.can(shop_id, 'marketing.manage')) with check (app.can(shop_id, 'marketing.manage'));

create policy snapshots_read on public.analytics_snapshots for select to authenticated
  using (app.can(shop_id, 'reports.shop') or app.is_my_barber(barber_id));
create policy audit_read on public.audit_logs for select to authenticated
  using (shop_id is not null and app.can(shop_id, 'audit.view')
         or organization_id is not null and app.is_org_owner(organization_id));

-- ===================== 20261007000008_availability_engine.sql =====================
-- =============================================================================
-- Availability engine
--
--   open(barber)  = (weekly work windows − breaks) ∪ extra_hours − time off − shop closures
--   busy(barber)  = live calendar entries [starts_at, blocked_until)
--   free          = open − busy
--
-- Candidate start times inside each free interval:
--   1. the start of the interval (tight fit right after the previous client)
--   2. every clock-grid point (slot_interval_minutes) inside the interval
--   3. the latest start that still finishes before the next booking (gap fill)
-- A candidate is offered when [start, start+duration) fits inside `free` and
-- [start, start+duration+buffer) does not collide with `busy`.
-- Wall-clock rules are resolved in the shop timezone, so DST is exact.
-- =============================================================================

create or replace function app.local_ts(p_day date, p_time time, p_tz text)
returns timestamptz language sql immutable as $$
  select (p_day + p_time) at time zone p_tz
$$;

-- Bookable time for one barber in [p_from, p_to).
create or replace function app.barber_open_ranges(p_barber uuid, p_from timestamptz, p_to timestamptz)
returns tstzmultirange language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_shop uuid;
  v_tz text;
  v_first date;
  v_last date;
  v_has_schedule boolean;
  v_work tstzmultirange;
  v_breaks tstzmultirange;
  v_extra tstzmultirange;
  v_off tstzmultirange;
  v_window tstzrange := tstzrange(p_from, p_to);
  v_joined timestamptz;
begin
  select b.shop_id, s.timezone, b.created_at into v_shop, v_tz, v_joined
    from public.barbers b join public.shops s on s.id = b.shop_id
   where b.id = p_barber;
  if v_shop is null then
    return '{}'::tstzmultirange;
  end if;
  -- A chair has no capacity before its barber joined (keeps utilization honest).
  v_joined := date_trunc('day', v_joined at time zone v_tz) at time zone v_tz;
  if v_joined >= p_to then
    return '{}'::tstzmultirange;
  end if;
  v_window := tstzrange(greatest(p_from, v_joined), p_to);

  v_first := (p_from at time zone v_tz)::date - 1;
  v_last  := (p_to at time zone v_tz)::date + 1;

  select exists (select 1 from public.availability where barber_id = p_barber and kind = 'work')
    into v_has_schedule;

  if v_has_schedule then
    select coalesce(range_agg(tstzrange(app.local_ts(d, a.starts_at, v_tz), app.local_ts(d, a.ends_at, v_tz))), '{}')
      into v_work
      from generate_series(v_first, v_last, interval '1 day') g(d0)
      cross join lateral (select g.d0::date as d) dd
      join public.availability a
        on a.barber_id = p_barber and a.kind = 'work' and a.weekday = extract(dow from dd.d);
  else
    -- No personal schedule yet: fall back to the shop's business hours.
    select coalesce(range_agg(tstzrange(app.local_ts(d, h.opens_at, v_tz), app.local_ts(d, h.closes_at, v_tz))), '{}')
      into v_work
      from generate_series(v_first, v_last, interval '1 day') g(d0)
      cross join lateral (select g.d0::date as d) dd
      join public.business_hours h
        on h.shop_id = v_shop and h.weekday = extract(dow from dd.d);
  end if;

  select coalesce(range_agg(tstzrange(app.local_ts(d, a.starts_at, v_tz), app.local_ts(d, a.ends_at, v_tz))), '{}')
    into v_breaks
    from generate_series(v_first, v_last, interval '1 day') g(d0)
    cross join lateral (select g.d0::date as d) dd
    join public.availability a
      on a.barber_id = p_barber and a.kind = 'break' and a.weekday = extract(dow from dd.d);

  select coalesce(range_agg(tstzrange(e.starts_at, e.ends_at)), '{}')
    into v_extra
    from public.availability_exceptions e
   where e.barber_id = p_barber and e.kind = 'extra_hours'
     and tstzrange(e.starts_at, e.ends_at) && v_window;

  select coalesce(range_agg(tstzrange(e.starts_at, e.ends_at)), '{}')
    into v_off
    from public.availability_exceptions e
   where e.shop_id = v_shop and e.kind <> 'extra_hours'
     and (e.barber_id = p_barber or e.barber_id is null)
     and tstzrange(e.starts_at, e.ends_at) && v_window;

  return (((v_work - v_breaks) + v_extra) - v_off) * tstzmultirange(v_window);
end $$;

-- Live calendar occupancy for one barber in a window.
create or replace function app.barber_busy_ranges(p_barber uuid, p_from timestamptz, p_to timestamptz, p_ignore_appointment uuid default null)
returns tstzmultirange language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(range_agg(tstzrange(a.starts_at, a.blocked_until)), '{}')
    from public.appointments a
   where a.barber_id = p_barber
     and a.deleted_at is null
     and a.status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
     and a.starts_at < p_to and a.blocked_until > p_from
     and (p_ignore_appointment is null or a.id <> p_ignore_appointment)
$$;

-- Effective price/duration of a set of services for a barber (NULL if the
-- barber doesn't perform one of them).
create or replace function app.barber_service_quote(p_barber uuid, p_services uuid[])
returns table (duration_minutes int, price_cents bigint) language sql stable security definer set search_path = public, pg_temp as $$
  select sum(coalesce(bs.duration_minutes, s.duration_minutes))::int,
         sum(coalesce(bs.price_cents, s.price_cents))::bigint
    from unnest(p_services) as req(service_id)
    join public.services s on s.id = req.service_id and s.deleted_at is null and s.is_active
    join public.barber_services bs on bs.service_id = s.id and bs.barber_id = p_barber and bs.is_active
  having count(*) = cardinality(p_services)
$$;

-- Core slot computation (internal). p_staff relaxes online-only rules
-- (minimum notice, booking window, online toggle, same-day setting).
create or replace function app.compute_slots(
  p_shop uuid,
  p_services uuid[],
  p_barber uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_staff boolean default false,
  p_ignore_appointment uuid default null
)
returns table (barber_id uuid, starts_at timestamptz, ends_at timestamptz, duration_minutes int, price_cents bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_tz text;
  bk public.booking_settings;
  b record;
  q record;
  v_open tstzmultirange;
  v_busy tstzmultirange;
  v_free tstzmultirange;
  r tstzrange;
  v_dur interval;
  v_buf interval;
  v_step interval;
  v_earliest timestamptz;
  v_latest timestamptz;
  v_day_counts jsonb;
  c timestamptz;
  v_local_day date;
  v_grid timestamptz;
begin
  select s.timezone into v_tz from public.shops s where s.id = p_shop and s.deleted_at is null;
  if v_tz is null or p_services is null or cardinality(p_services) = 0 then
    return;
  end if;
  select * into bk from public.booking_settings where shop_id = p_shop;
  v_step := make_interval(mins => bk.slot_interval_minutes);

  if p_staff then
    v_earliest := greatest(p_from, now() - interval '12 hours');
    v_latest := p_to;
  else
    v_earliest := greatest(p_from, now() + make_interval(mins => bk.min_notice_minutes));
    v_latest := least(p_to, now() + make_interval(days => bk.max_advance_days));
  end if;
  if v_earliest >= v_latest then
    return;
  end if;

  for b in
    select br.* from public.barbers br
     where br.shop_id = p_shop and br.deleted_at is null and br.status = 'active'
       and (p_barber is null or br.id = p_barber)
       and (p_staff or br.accepts_online_booking)
     order by br.sort_order, br.display_name
  loop
    select * into q from app.barber_service_quote(b.id, p_services);
    continue when q.duration_minutes is null;

    v_dur := make_interval(mins => q.duration_minutes);
    v_buf := make_interval(mins => coalesce(b.buffer_minutes, bk.buffer_minutes));
    -- Expand from local midnight so interval starts are real boundaries
    -- (opening time / end of a booking), never the notice cutoff.
    v_open := app.barber_open_ranges(b.id, app.local_ts((v_earliest at time zone v_tz)::date, '00:00', v_tz), v_latest + v_dur);
    v_busy := app.barber_busy_ranges(b.id, v_earliest - interval '1 day', v_latest + interval '1 day', p_ignore_appointment);
    v_free := v_open - v_busy;

    -- Appointments per local day (for the max-daily-appointments rule).
    if b.max_daily_appointments is not null then
      select coalesce(jsonb_object_agg(d, n), '{}') into v_day_counts from (
        select (a.starts_at at time zone v_tz)::date::text as d, count(*) as n
          from public.appointments a
         where a.barber_id = b.id and a.kind = 'appointment' and a.deleted_at is null
           and a.status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
           and a.starts_at >= v_earliest - interval '1 day' and a.starts_at < v_latest + interval '1 day'
           and (p_ignore_appointment is null or a.id <> p_ignore_appointment)
         group by 1) x;
    end if;

    for r in select unnest(v_free) loop
      continue when upper(r) - lower(r) < v_dur;
      return query
      with cands as (
        -- 1) tight fit at the start of the gap (rounded up to the minute)
        select date_trunc('minute', lower(r) + interval '59 seconds') as s
        union
        -- 2) clock grid aligned to local midnight of that day
        select gs from generate_series(
                 date_bin(v_step, lower(r), app.local_ts((lower(r) at time zone v_tz)::date, '00:00', v_tz)) + v_step,
                 upper(r) - v_dur, v_step) gs
        union
        -- 3) gap fill: finish exactly when the next booking starts
        select date_trunc('minute', upper(r) - v_dur - v_buf)
      )
      select b.id, c.s, c.s + v_dur, q.duration_minutes, q.price_cents
        from cands c
       where c.s >= v_earliest and c.s < v_latest
         and c.s >= lower(r)
         and tstzmultirange(tstzrange(c.s, c.s + v_dur)) <@ v_free
         and not (v_busy && tstzrange(c.s, c.s + v_dur + v_buf))
         and (p_staff or b.same_day_booking or (c.s at time zone v_tz)::date > (now() at time zone v_tz)::date)
         and (b.max_daily_appointments is null
              or coalesce((v_day_counts ->> ((c.s at time zone v_tz)::date::text))::int, 0) < b.max_daily_appointments)
       order by c.s;
    end loop;
  end loop;
end $$;

-- Is a specific start time bookable for this barber? (re-validation at booking)
create or replace function app.is_bookable(
  p_shop uuid, p_services uuid[], p_barber uuid, p_start timestamptz,
  p_staff boolean default false, p_ignore_appointment uuid default null)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from app.compute_slots(p_shop, p_services, p_barber, p_start - interval '1 minute',
                                    p_start + interval '1 minute', p_staff, p_ignore_appointment) s
     where s.starts_at = p_start)
$$;

-- ---------------------------------------------------------------------------
-- Public API
-- ---------------------------------------------------------------------------
create or replace function app.shop_is_public_or_staff(p_shop uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.shops s join public.booking_settings bk on bk.shop_id = s.id
                  where s.id = p_shop and s.deleted_at is null and s.is_published and bk.online_booking_enabled)
      or app.is_staff(p_shop)
$$;

-- Available start times for a service, for one barber or all barbers.
-- p_date is a local date in the shop timezone; p_days up to 31.
create or replace function public.get_available_slots(
  p_shop_id uuid,
  p_service_ids uuid[],
  p_date date,
  p_days int default 1,
  p_barber_id uuid default null
)
returns table (barber_id uuid, starts_at timestamptz, ends_at timestamptz, duration_minutes int, price_cents bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_tz text;
  v_staff boolean := app.is_staff(p_shop_id);
begin
  if not app.shop_is_public_or_staff(p_shop_id) then
    perform app.fail('SHOP_NOT_AVAILABLE');
  end if;
  select timezone into v_tz from public.shops where id = p_shop_id;
  -- Online clients may only book public services.
  if not v_staff and exists (select 1 from public.services s where s.id = any (p_service_ids) and not s.is_public) then
    perform app.fail('SERVICE_NOT_BOOKABLE');
  end if;
  return query
    select * from app.compute_slots(
      p_shop_id, p_service_ids, p_barber_id,
      app.local_ts(p_date, '00:00', v_tz),
      app.local_ts(p_date + least(greatest(p_days, 1), 31), '00:00', v_tz),
      v_staff);
end $$;

-- Earliest slot per barber ("First available").
create or replace function public.get_first_available(
  p_shop_id uuid,
  p_service_ids uuid[],
  p_from_date date default null,
  p_days int default 14
)
returns table (barber_id uuid, starts_at timestamptz, ends_at timestamptz, duration_minutes int, price_cents bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct on (s.barber_id) s.*
    from public.get_available_slots(
           p_shop_id, p_service_ids,
           coalesce(p_from_date, (now() at time zone (select timezone from public.shops where id = p_shop_id))::date),
           p_days) s
   order by s.barber_id, s.starts_at
$$;

-- Dates in a range that have at least one free slot (calendar dots).
create or replace function public.get_available_days(
  p_shop_id uuid, p_service_ids uuid[], p_from_date date, p_days int default 14, p_barber_id uuid default null)
returns table (day date, slots int)
language sql stable security definer set search_path = public, pg_temp as $$
  select (s.starts_at at time zone sh.timezone)::date, count(*)::int
    from public.get_available_slots(p_shop_id, p_service_ids, p_from_date, p_days, p_barber_id) s
    cross join (select timezone from public.shops where id = p_shop_id) sh
   group by 1 order by 1
$$;

-- ===================== 20261007000009_rpc_onboarding_staff.sql =====================
-- =============================================================================
-- Onboarding, staff & team management RPCs
-- =============================================================================

create or replace function app.current_email()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select lower(email::text) from auth.users where id = auth.uid()
$$;

create or replace function app.require_auth()
returns uuid language plpgsql stable as $$
begin
  if auth.uid() is null then
    perform app.fail('NOT_AUTHENTICATED');
  end if;
  return auth.uid();
end $$;

create or replace function app.require(p_shop uuid, p_perm text)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_auth();
  if not app.can(p_shop, p_perm) then
    perform app.fail('FORBIDDEN', 'Missing permission ' || p_perm);
  end if;
end $$;

create or replace function app.require_feature(p_shop uuid, p_feature text)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.shop_has_feature(p_shop, p_feature) then
    perform app.fail('PLAN_UPGRADE_REQUIRED', p_feature);
  end if;
end $$;

-- Plan limit: number of active barbers.
create or replace function app.enforce_barber_limit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_max int; v_count int;
begin
  if new.deleted_at is not null or new.status <> 'active' then
    return new;
  end if;
  select (app.org_features(s.organization_id) ->> 'max_barbers')::int into v_max
    from public.shops s where s.id = new.shop_id;
  if v_max is null then
    return new;
  end if;
  select count(*) into v_count from public.barbers
   where shop_id = new.shop_id and deleted_at is null and status = 'active' and id <> new.id;
  if v_count >= v_max then
    perform app.fail('PLAN_LIMIT_BARBERS', 'Your plan allows ' || v_max || ' active barber(s).');
  end if;
  return new;
end $$;
create trigger barbers_plan_limit before insert or update of status, deleted_at on public.barbers
  for each row execute function app.enforce_barber_limit();

create or replace function app.unique_barber_slug(p_shop uuid, p_name text, p_ignore uuid default null)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_base text := coalesce(nullif(app.slugify(p_name), ''), 'barber'); v_slug text := v_base; i int := 1;
begin
  while exists (select 1 from public.barbers where shop_id = p_shop and slug = v_slug and deleted_at is null
                and (p_ignore is null or id <> p_ignore)) loop
    i := i + 1; v_slug := v_base || '-' || i;
  end loop;
  return v_slug;
end $$;

create or replace function app.barbers_default_slug()
returns trigger language plpgsql as $$
begin
  if new.slug is null or new.slug = '' then
    new.slug := app.unique_barber_slug(new.shop_id, new.display_name, new.id);
  end if;
  return new;
end $$;
create trigger barbers_default_slug before insert on public.barbers
  for each row execute function app.barbers_default_slug();

create or replace function public.check_slug_available(p_slug text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_slug ~ '^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])?$'
     and p_slug not in ('app', 'api', 'admin', 'login', 'signup', 'me', 'book', 'www', 'help', 'pricing', 'demo')
     and not exists (select 1 from public.shops where slug = p_slug)
$$;

-- Create an organization + first shop in one step (owner onboarding).
create or replace function public.create_shop(
  p_shop_name text,
  p_slug text,
  p_timezone text default 'America/New_York',
  p_owner_is_barber boolean default true,
  p_owner_display_name text default null,
  p_plan_code text default 'shop',
  p_organization_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := app.require_auth();
  v_org uuid := p_organization_id;
  v_shop uuid;
  v_barber uuid;
  v_plan uuid;
  v_locations int;
  d int;
begin
  if not public.check_slug_available(lower(p_slug)) then
    perform app.fail('SLUG_TAKEN');
  end if;

  if v_org is null then
    select id into v_plan from public.subscription_plans where code = coalesce(p_plan_code, 'shop');
    if v_plan is null then perform app.fail('UNKNOWN_PLAN'); end if;
    insert into public.organizations (name, owner_id) values (p_shop_name, v_uid) returning id into v_org;
    insert into public.subscriptions (organization_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
    values (v_org, v_plan, 'trialing', now() + interval '14 days', now(), now() + interval '14 days');
    insert into public.memberships (organization_id, shop_id, user_id, role) values (v_org, null, v_uid, 'owner');
  else
    -- Additional location for an existing organization.
    if not app.is_org_owner(v_org) then perform app.fail('FORBIDDEN'); end if;
    select count(*) into v_locations from public.shops where organization_id = v_org and deleted_at is null;
    if coalesce((app.org_features(v_org) ->> 'max_locations')::int, 1000000) <= v_locations then
      perform app.fail('PLAN_LIMIT_LOCATIONS');
    end if;
  end if;

  insert into public.shops (organization_id, name, slug, timezone)
  values (v_org, trim(p_shop_name), lower(p_slug), p_timezone) returning id into v_shop;

  -- Sensible default hours: Tue–Sat 9–7, Sun/Mon closed. Editable in settings.
  for d in 2..6 loop
    insert into public.business_hours (shop_id, weekday, opens_at, closes_at) values (v_shop, d, '09:00', '19:00');
  end loop;

  if p_owner_is_barber then
    insert into public.barbers (shop_id, user_id, display_name)
    values (v_shop, v_uid, coalesce(nullif(trim(p_owner_display_name), ''),
                                    (select full_name from public.profiles where id = v_uid), 'Owner'))
    returning id into v_barber;
    insert into public.commissions (shop_id, barber_id, type, percent_bps, created_by)
    values (v_shop, v_barber, 'percentage', 10000, v_uid);
  end if;
  return v_shop;
end $$;

-- Shops the current user works at (for the staff app shell).
create or replace function public.my_workspaces()
returns table (shop_id uuid, shop_name text, shop_slug text, organization_id uuid, role public.staff_role,
               barber_id uuid, timezone text, accent_color text, is_published boolean, permissions text[])
language sql stable security definer set search_path = public, pg_temp as $$
  with ms as (
    select s.id as shop_id, s.name, s.slug, s.organization_id, m.role, s.timezone, s.accent_color, s.is_published,
           row_number() over (partition by s.id order by array_position(array['owner','manager','receptionist','barber']::public.staff_role[], m.role)) rn
      from public.memberships m
      join public.shops s on s.organization_id = m.organization_id and (m.shop_id is null or m.shop_id = s.id)
     where m.user_id = auth.uid() and m.is_active and s.deleted_at is null
  )
  select ms.shop_id, ms.name, ms.slug, ms.organization_id, ms.role,
         (select b.id from public.barbers b where b.shop_id = ms.shop_id and b.user_id = auth.uid() and b.deleted_at is null limit 1),
         ms.timezone, ms.accent_color, ms.is_published,
         array(select p from unnest(array[
           'shop.settings','staff.manage','services.manage','schedule.manage_all','calendar.all','clients.all',
           'payments.view','payments.record','payments.refund','reports.shop','marketing.manage','walkins.manage',
           'waitlist.manage','reviews.manage','commissions.manage','financials.all_barbers','audit.view',
           'billing','notifications.view','*private_notes']) p where app.can(ms.shop_id, p))
    from ms where rn = 1
   order by ms.name
$$;

create or replace function public.shop_features(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_staff(p_shop_id) then perform app.fail('FORBIDDEN'); end if;
  return (select app.org_features(organization_id) from public.shops where id = p_shop_id);
end $$;

-- ---------------------------------------------------------------------------
-- Team
-- ---------------------------------------------------------------------------
create or replace function public.invite_staff(
  p_shop_id uuid, p_email text, p_role public.staff_role, p_barber_id uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid; v_token uuid; v_inv uuid;
begin
  perform app.require(p_shop_id, 'staff.manage');
  if p_role = 'owner' then perform app.fail('FORBIDDEN', 'Ownership cannot be granted by invitation'); end if;
  if p_role = 'manager' and not app.can(p_shop_id, '*') then
    perform app.fail('FORBIDDEN', 'Only the owner can invite managers');
  end if;
  if p_barber_id is not null and app.barber_shop(p_barber_id) is distinct from p_shop_id then
    perform app.fail('BARBER_NOT_IN_SHOP');
  end if;
  select organization_id into v_org from public.shops where id = p_shop_id;
  update public.invitations set revoked_at = now()
   where shop_id = p_shop_id and email = lower(p_email) and accepted_at is null and revoked_at is null;
  insert into public.invitations (organization_id, shop_id, email, role, barber_id, invited_by)
  values (v_org, p_shop_id, lower(trim(p_email)), p_role, p_barber_id, auth.uid())
  returning id, token into v_inv, v_token;
  insert into public.notifications (shop_id, event, channel, audience, to_address, payload)
  values (p_shop_id, 'staff.invitation', 'email', 'staff', lower(trim(p_email)),
          jsonb_build_object('role', p_role, 'invite_url', '/invite/' || v_token,
                             'shop_name', (select name from public.shops where id = p_shop_id)));
  return v_token;
end $$;

create or replace function public.get_invitation(p_token uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('shop_name', s.name, 'role', i.role, 'email', i.email,
                            'expired', i.expires_at < now() or i.revoked_at is not null,
                            'accepted', i.accepted_at is not null)
    from public.invitations i join public.shops s on s.id = i.shop_id
   where i.token = p_token
$$;

create or replace function public.accept_invitation(p_token uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := app.require_auth(); inv public.invitations; v_barber uuid;
begin
  select * into inv from public.invitations where token = p_token for update;
  if inv.id is null or inv.revoked_at is not null or inv.expires_at < now() then
    perform app.fail('INVITATION_INVALID');
  end if;
  if inv.accepted_at is not null then
    perform app.fail('INVITATION_USED');
  end if;
  if lower(inv.email::text) <> app.current_email() then
    perform app.fail('INVITATION_EMAIL_MISMATCH', 'Sign in as ' || inv.email || ' to accept this invitation');
  end if;

  insert into public.memberships (organization_id, shop_id, user_id, role)
  values (inv.organization_id, inv.shop_id, v_uid, inv.role)
  on conflict (organization_id, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), user_id)
  do update set role = excluded.role, is_active = true;

  if inv.role = 'barber' then
    v_barber := inv.barber_id;
    if v_barber is null then
      insert into public.barbers (shop_id, user_id, display_name)
      values (inv.shop_id, v_uid, coalesce((select full_name from public.profiles where id = v_uid), split_part(inv.email::text, '@', 1)))
      returning id into v_barber;
    else
      update public.barbers set user_id = v_uid where id = v_barber and (user_id is null or user_id = v_uid);
    end if;
  end if;

  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = inv.id;
  return inv.shop_id;
end $$;

create or replace function public.list_team(p_shop_id uuid)
returns table (membership_id uuid, user_id uuid, full_name text, email text, role public.staff_role,
               is_active boolean, scope text, barber_id uuid, permissions jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require(p_shop_id, 'staff.manage');
  return query
    select m.id, m.user_id, p.full_name, u.email::text, m.role, m.is_active,
           case when m.shop_id is null then 'organization' else 'shop' end,
           (select b.id from public.barbers b where b.shop_id = p_shop_id and b.user_id = m.user_id and b.deleted_at is null limit 1),
           m.permissions
      from public.memberships m
      join public.shops s on s.organization_id = m.organization_id and s.id = p_shop_id
      left join public.profiles p on p.id = m.user_id
      left join auth.users u on u.id = m.user_id
     where m.shop_id is null or m.shop_id = p_shop_id
     order by m.role, p.full_name;
end $$;

create or replace function public.update_membership(
  p_membership_id uuid, p_role public.staff_role default null, p_is_active boolean default null, p_permissions jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; v_shop uuid;
begin
  select * into m from public.memberships where id = p_membership_id;
  if m.id is null then perform app.fail('NOT_FOUND'); end if;
  v_shop := coalesce(m.shop_id, (select id from public.shops where organization_id = m.organization_id order by created_at limit 1));
  perform app.require(v_shop, 'staff.manage');
  if m.role = 'owner' or p_role = 'owner' then perform app.fail('FORBIDDEN', 'Owner memberships cannot be changed here'); end if;
  if (m.role = 'manager' or p_role = 'manager' or p_permissions is not null) and not app.is_org_owner(m.organization_id) then
    perform app.fail('FORBIDDEN', 'Only the owner can change managers or permissions');
  end if;
  if m.user_id = auth.uid() then perform app.fail('FORBIDDEN', 'You cannot change your own access'); end if;
  update public.memberships
     set role = coalesce(p_role, role), is_active = coalesce(p_is_active, is_active),
         permissions = coalesce(p_permissions, permissions)
   where id = p_membership_id;
end $$;

-- Barber self-service profile & settings (without being able to touch
-- status, linkage or anything owner-controlled).
create or replace function public.update_my_barber_profile(
  p_barber_id uuid, p_title text, p_bio text, p_specialties text[], p_photo_url text, p_instagram text,
  p_buffer_minutes int, p_max_daily_appointments int, p_same_day_booking boolean, p_accepts_online_booking boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_auth();
  if not (app.is_my_barber(p_barber_id) or app.can(app.barber_shop(p_barber_id), 'staff.manage')) then
    perform app.fail('FORBIDDEN');
  end if;
  update public.barbers
     set title = p_title, bio = p_bio, specialties = coalesce(p_specialties, '{}'), photo_url = p_photo_url,
         instagram = p_instagram, buffer_minutes = p_buffer_minutes, max_daily_appointments = p_max_daily_appointments,
         same_day_booking = coalesce(p_same_day_booking, true), accepts_online_booking = coalesce(p_accepts_online_booking, true)
   where id = p_barber_id;
end $$;

-- Barber chooses which services they perform (prices stay owner-controlled).
create or replace function public.set_barber_services(p_barber_id uuid, p_service_ids uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id);
begin
  perform app.require_auth();
  if not (app.is_my_barber(p_barber_id) or app.can(v_shop, 'staff.manage') or app.can(v_shop, 'services.manage')) then
    perform app.fail('FORBIDDEN');
  end if;
  if exists (select 1 from unnest(p_service_ids) sid where not exists
             (select 1 from public.services s where s.id = sid and s.shop_id = v_shop)) then
    perform app.fail('SERVICE_NOT_IN_SHOP');
  end if;
  update public.barber_services set is_active = (service_id = any (p_service_ids)) where barber_id = p_barber_id;
  insert into public.barber_services (barber_id, service_id)
  select p_barber_id, sid from unnest(p_service_ids) sid
  on conflict (barber_id, service_id) do update set is_active = true;
end $$;

-- Replace a barber's weekly schedule atomically.
-- p_rows: [{"weekday":1,"starts_at":"09:00","ends_at":"18:00","kind":"work"}, ...]
create or replace function public.set_weekly_schedule(p_barber_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_auth();
  if not (app.is_my_barber(p_barber_id) or app.can(app.barber_shop(p_barber_id), 'schedule.manage_all')) then
    perform app.fail('FORBIDDEN');
  end if;
  delete from public.availability where barber_id = p_barber_id;
  insert into public.availability (barber_id, weekday, starts_at, ends_at, kind, label)
  select p_barber_id, (r ->> 'weekday')::smallint, (r ->> 'starts_at')::time, (r ->> 'ends_at')::time,
         coalesce(r ->> 'kind', 'work'), r ->> 'label'
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
end $$;

-- Archive (soft-delete) a barber who left. Future appointments are returned
-- so the shop can reassign/cancel them; history stays intact.
create or replace function public.archive_barber(p_barber_id uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id); v_future int;
begin
  perform app.require(v_shop, 'staff.manage');
  select count(*) into v_future from public.appointments
   where barber_id = p_barber_id and starts_at > now() and kind = 'appointment'
     and status in ('BOOKED', 'CONFIRMED') and deleted_at is null;
  update public.barbers set status = 'archived', accepts_online_booking = false where id = p_barber_id;
  update public.memberships m set is_active = false
    from public.barbers b
   where b.id = p_barber_id and m.user_id = b.user_id and m.role = 'barber'
     and (m.shop_id = v_shop or m.shop_id is null);
  return v_future;
end $$;

-- Commission configuration (owner-only by default).
create or replace function public.set_commission(
  p_barber_id uuid, p_type public.commission_type, p_percent_bps int default null, p_fixed_cents bigint default null,
  p_tiers jsonb default null, p_rent_cents bigint default null, p_rent_period text default null, p_tip_share_bps int default 10000)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id); v_id uuid; v_today date;
begin
  perform app.require(v_shop, 'commissions.manage');
  select (now() at time zone timezone)::date into v_today from public.shops where id = v_shop;
  delete from public.commissions where barber_id = p_barber_id and effective_from >= v_today;
  update public.commissions set effective_to = v_today - 1
   where barber_id = p_barber_id and (effective_to is null or effective_to >= v_today);
  insert into public.commissions (shop_id, barber_id, type, percent_bps, fixed_cents, tiers, rent_cents, rent_period,
                                  tip_share_bps, effective_from, created_by)
  values (v_shop, p_barber_id, p_type, p_percent_bps, p_fixed_cents, p_tiers, p_rent_cents, p_rent_period,
          coalesce(p_tip_share_bps, 10000), v_today, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- ===================== 20261007000010_rpc_booking.sql =====================
-- =============================================================================
-- Notifications outbox helpers + public booking, guest self-service, client
-- portal, reviews.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Notification helpers
-- ---------------------------------------------------------------------------
create or replace function app.fmt_when(p_ts timestamptz, p_tz text)
returns text language sql stable as $$
  select trim(to_char(p_ts at time zone p_tz, 'Dy, Mon FMDD "at" FMHH12:MI AM'))
$$;

create or replace function app.appointment_payload(p_appt uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'shop_name', s.name, 'shop_slug', s.slug, 'shop_phone', s.phone,
    'client_first_name', c.first_name, 'client_name', trim(c.first_name || ' ' || coalesce(c.last_name, '')),
    'barber_name', b.display_name,
    'service_name', coalesce((select string_agg(x.name, ' + ' order by x.position) from public.appointment_services x where x.appointment_id = a.id), a.title, 'Appointment'),
    'when', app.fmt_when(a.starts_at, s.timezone),
    'time', trim(to_char(a.starts_at at time zone s.timezone, 'FMHH12:MI AM')),
    'date', to_char(a.starts_at at time zone s.timezone, 'YYYY-MM-DD'),
    'starts_at', a.starts_at,
    'manage_url', '/a/' || a.manage_token,
    'confirm_url', '/a/' || a.manage_token || '?confirm=1',
    'review_url', '/r/' || a.review_token,
    'book_url', '/s/' || s.slug || '/book'
  )
    from public.appointments a
    join public.shops s on s.id = a.shop_id
    join public.barbers b on b.id = a.barber_id
    left join public.clients c on c.id = a.client_id
   where a.id = p_appt
$$;

-- Queue a client-facing notification for an appointment (email if we have one).
create or replace function app.notify_client(
  p_appt uuid, p_event text, p_scheduled_for timestamptz default now(), p_dedupe text default null, p_extra jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a record;
begin
  select ap.shop_id, ap.client_id, c.email, c.user_id into a
    from public.appointments ap left join public.clients c on c.id = ap.client_id
   where ap.id = p_appt;
  if a.client_id is null then return; end if;
  insert into public.notifications (shop_id, event, channel, audience, client_id, user_id, appointment_id, to_address,
                                    payload, scheduled_for, status, dedupe_key)
  values (a.shop_id, p_event, 'email', 'client', a.client_id, a.user_id, p_appt, a.email::text,
          app.appointment_payload(p_appt) || p_extra, p_scheduled_for,
          case when a.email is null then 'skipped' else 'queued' end::public.notification_status, p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

-- In-app notification for the barber + shop managers.
create or replace function app.notify_staff(p_appt uuid, p_event text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid; v_payload jsonb;
begin
  select shop_id into v_shop from public.appointments where id = p_appt;
  if not coalesce((select notify_staff_on_booking from public.shop_settings where shop_id = v_shop), true) then
    return;
  end if;
  v_payload := app.appointment_payload(p_appt);
  insert into public.notifications (shop_id, event, channel, audience, user_id, appointment_id, payload, status, sent_at)
  select distinct v_shop, p_event, 'in_app'::public.notification_channel, 'staff', u.user_id, p_appt, v_payload,
         'sent'::public.notification_status, now()
    from (
      select b.user_id from public.appointments a join public.barbers b on b.id = a.barber_id
       where a.id = p_appt and b.user_id is not null
      union
      select m.user_id from public.memberships m join public.shops s on s.organization_id = m.organization_id
       where s.id = v_shop and m.is_active and m.role in ('owner', 'manager', 'receptionist')
         and (m.shop_id is null or m.shop_id = v_shop)
    ) u
   where u.user_id is distinct from auth.uid();
end $$;

create or replace function app.schedule_reminders(p_appt uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a record; o int;
begin
  select ap.id, ap.starts_at, ss.reminder_offsets_minutes into a
    from public.appointments ap join public.shop_settings ss on ss.shop_id = ap.shop_id
   where ap.id = p_appt;
  foreach o in array coalesce(a.reminder_offsets_minutes, '{}') loop
    if a.starts_at - make_interval(mins => o) > now() then
      perform app.notify_client(p_appt, 'appointment.reminder', a.starts_at - make_interval(mins => o),
        'reminder:' || p_appt || ':' || o || ':' || extract(epoch from a.starts_at)::bigint,
        jsonb_build_object('relative_when', case when o >= 1440 then 'tomorrow' when o >= 60 then 'in ' || (o / 60) || ' hours' else 'in ' || o || ' minutes' end));
    end if;
  end loop;
end $$;

-- Cancel pending reminders when an appointment no longer happens / moves.
create or replace function app.appointments_after_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED', 'COMPLETED')
     and old.status is distinct from new.status
     or new.starts_at is distinct from old.starts_at then
    update public.notifications set status = 'cancelled'
     where appointment_id = new.id and status = 'queued'
       and event in ('appointment.reminder', 'appointment.starting_soon');
  end if;
  if new.starts_at is distinct from old.starts_at and new.status in ('BOOKED', 'CONFIRMED') then
    perform app.schedule_reminders(new.id);
  end if;
  return null;
end $$;
create trigger appointments_after_change after update on public.appointments
  for each row execute function app.appointments_after_change();

-- ---------------------------------------------------------------------------
-- Clients: find or create inside a shop (dedupe by phone, then email)
-- ---------------------------------------------------------------------------
create or replace function app.upsert_client(p_shop uuid, p_client jsonb, p_source text default 'online')
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_phone text := app.normalize_phone(nullif(trim(p_client ->> 'phone'), ''));
  v_email text := lower(nullif(trim(p_client ->> 'email'), ''));
  v_first text := nullif(trim(p_client ->> 'first_name'), '');
  v_uid uuid := auth.uid();
  v_my_email text := app.current_email();
begin
  -- Logged-in client: their own record first.
  if v_uid is not null then
    select id into v_id from public.clients
     where shop_id = p_shop and user_id = v_uid and deleted_at is null and merged_into_id is null limit 1;
  end if;
  if v_id is null and v_phone is not null then
    select id into v_id from public.clients
     where shop_id = p_shop and phone_normalized = v_phone and deleted_at is null and merged_into_id is null;
  end if;
  if v_id is null and v_email is not null then
    select id into v_id from public.clients
     where shop_id = p_shop and email = v_email and deleted_at is null and merged_into_id is null;
  end if;

  if v_id is null then
    if v_first is null then perform app.fail('CLIENT_NAME_REQUIRED'); end if;
    insert into public.clients (shop_id, user_id, first_name, last_name, phone, email, source,
                                marketing_email_opt_in, marketing_sms_opt_in, referred_by_client_id)
    values (p_shop,
            case when v_uid is not null and not app.is_staff(p_shop) then v_uid end,
            v_first, nullif(trim(p_client ->> 'last_name'), ''), nullif(trim(p_client ->> 'phone'), ''), v_email, p_source,
            coalesce((p_client ->> 'marketing_opt_in')::boolean, false),
            coalesce((p_client ->> 'marketing_opt_in')::boolean, false),
            (select id from public.clients where shop_id = p_shop and referral_code = upper(nullif(p_client ->> 'referral_code', ''))))
    returning id into v_id;
    if (p_client ->> 'referral_code') is not null then
      insert into public.referrals (shop_id, referrer_client_id, referred_client_id)
      select p_shop, referred_by_client_id, id from public.clients where id = v_id and referred_by_client_id is not null
      on conflict do nothing;
    end if;
  else
    -- Fill gaps only; never let an anonymous booker overwrite stored data.
    update public.clients c
       set phone = coalesce(c.phone, nullif(trim(p_client ->> 'phone'), '')),
           email = coalesce(c.email, v_email),
           last_name = coalesce(c.last_name, nullif(trim(p_client ->> 'last_name'), '')),
           -- Link the account only when the verified login email matches.
           user_id = coalesce(c.user_id, case when v_uid is not null and v_my_email is not null
                                                   and lower(c.email::text) = v_my_email
                                                   and not app.is_staff(p_shop) then v_uid end),
           marketing_email_opt_in = c.marketing_email_opt_in or coalesce((p_client ->> 'marketing_opt_in')::boolean, false)
     where c.id = v_id;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Public shop page
-- ---------------------------------------------------------------------------
create or replace function public.get_public_shop(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.shops; bk public.booking_settings; v_staff boolean;
begin
  select * into s from public.shops where (slug = lower(p_slug) or custom_domain = lower(p_slug)) and deleted_at is null;
  if s.id is null then return null; end if;
  v_staff := app.is_staff(s.id);
  if not s.is_published and not v_staff then return null; end if;
  select * into bk from public.booking_settings where shop_id = s.id;

  return jsonb_build_object(
    'id', s.id, 'name', s.name, 'slug', s.slug, 'tagline', s.tagline, 'description', s.description,
    'timezone', s.timezone, 'phone', s.phone, 'email', s.email,
    'address', jsonb_build_object('line1', s.address_line1, 'line2', s.address_line2, 'city', s.city,
                                  'region', s.region, 'postal_code', s.postal_code, 'country', s.country),
    'latitude', s.latitude, 'longitude', s.longitude, 'instagram', s.instagram, 'website', s.website,
    'logo_url', s.logo_url, 'cover_url', s.cover_url, 'gallery_urls', to_jsonb(s.gallery_urls),
    'accent_color', s.accent_color, 'is_published', s.is_published, 'is_preview', not s.is_published,
    'currency', (select currency from public.shop_settings where shop_id = s.id),
    'booking', jsonb_build_object(
      'enabled', bk.online_booking_enabled, 'allow_any_barber', bk.allow_any_barber,
      'min_notice_minutes', bk.min_notice_minutes, 'max_advance_days', bk.max_advance_days,
      'cancellation_window_hours', bk.cancellation_window_hours, 'late_cancel_fee_cents', bk.late_cancel_fee_cents,
      'no_show_fee_cents', bk.no_show_fee_cents, 'deposit_required', bk.deposit_required, 'deposit_cents', bk.deposit_cents,
      'require_phone', bk.require_phone, 'require_email', bk.require_email,
      'cancellation_policy_text', bk.cancellation_policy_text,
      'waitlist_enabled', (select waitlist_enabled from public.shop_settings where shop_id = s.id) and app.shop_has_feature(s.id, 'waitlist')),
    'hours', coalesce((select jsonb_agg(jsonb_build_object('weekday', h.weekday, 'opens_at', h.opens_at, 'closes_at', h.closes_at)
                                         order by h.weekday, h.opens_at)
                        from public.business_hours h where h.shop_id = s.id), '[]'),
    'services', coalesce((select jsonb_agg(jsonb_build_object(
                           'id', sv.id, 'name', sv.name, 'description', sv.description, 'category', sv.category,
                           'price_cents', sv.price_cents, 'duration_minutes', sv.duration_minutes,
                           'min_price_cents', (select min(coalesce(bs.price_cents, sv.price_cents)) from public.barber_services bs
                                               join public.barbers b on b.id = bs.barber_id
                                               where bs.service_id = sv.id and bs.is_active and b.status = 'active' and b.deleted_at is null),
                           'max_price_cents', (select max(coalesce(bs.price_cents, sv.price_cents)) from public.barber_services bs
                                               join public.barbers b on b.id = bs.barber_id
                                               where bs.service_id = sv.id and bs.is_active and b.status = 'active' and b.deleted_at is null))
                           order by sv.sort_order, sv.name)
                          from public.services sv
                         where sv.shop_id = s.id and sv.deleted_at is null and sv.is_active and sv.is_public), '[]'),
    'barbers', coalesce((select jsonb_agg(jsonb_build_object(
                           'id', b.id, 'slug', b.slug, 'name', b.display_name, 'title', b.title, 'bio', b.bio,
                           'specialties', to_jsonb(b.specialties), 'photo_url', b.photo_url, 'instagram', b.instagram,
                           'color', b.color,
                           'rating', (select round(avg(r.barber_rating)::numeric, 2) from public.reviews r
                                       where r.barber_id = b.id and r.is_public and r.hidden_at is null and r.barber_rating is not null),
                           'review_count', (select count(*) from public.reviews r
                                             where r.barber_id = b.id and r.is_public and r.hidden_at is null and r.barber_rating is not null),
                           'services', coalesce((select jsonb_agg(jsonb_build_object(
                                          'service_id', bs.service_id,
                                          'price_cents', coalesce(bs.price_cents, sv.price_cents),
                                          'duration_minutes', coalesce(bs.duration_minutes, sv.duration_minutes)))
                                        from public.barber_services bs join public.services sv on sv.id = bs.service_id
                                       where bs.barber_id = b.id and bs.is_active and sv.is_active and sv.is_public and sv.deleted_at is null), '[]'))
                           order by b.sort_order, b.display_name)
                         from public.barbers b
                        where b.shop_id = s.id and b.deleted_at is null and b.status = 'active' and b.accepts_online_booking), '[]'),
    'rating', (select jsonb_build_object('average', round(avg(coalesce(r.shop_rating, r.barber_rating))::numeric, 2), 'count', count(*))
                 from public.reviews r where r.shop_id = s.id and r.is_public and r.hidden_at is null),
    'reviews', coalesce((select jsonb_agg(x) from (
                 select jsonb_build_object('rating', coalesce(r.barber_rating, r.shop_rating), 'comment', r.comment,
                                           'barber_name', b.display_name, 'client_name', c.first_name || coalesce(' ' || left(c.last_name, 1) || '.', ''),
                                           'created_at', r.created_at, 'owner_reply', r.owner_reply) x
                   from public.reviews r
                   left join public.barbers b on b.id = r.barber_id
                   left join public.clients c on c.id = r.client_id
                  where r.shop_id = s.id and r.is_public and r.hidden_at is null and r.comment is not null and length(trim(r.comment)) > 0
                  order by r.created_at desc limit 12) t), '[]')
  );
end $$;

-- ---------------------------------------------------------------------------
-- Booking
-- ---------------------------------------------------------------------------
create or replace function public.book_appointment(
  p_shop_id uuid,
  p_service_ids uuid[],
  p_starts_at timestamptz,
  p_client jsonb,
  p_barber_id uuid default null,          -- NULL = any barber available at that time
  p_message text default null,
  p_rebooked_from uuid default null,
  p_source public.booking_source default 'online'
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_staff boolean := app.is_staff(p_shop_id);
  v_barber uuid := p_barber_id;
  v_client uuid;
  v_appt uuid;
  v_token uuid;
  q record;
  v_buffer int;
  v_tz text;
  bk public.booking_settings;
  v_upcoming int;
  v_source public.booking_source := case when v_staff then coalesce(p_source, 'staff') else
                                       case when p_source in ('online', 'rebook', 'waitlist') then p_source else 'online' end end;
begin
  if not app.shop_is_public_or_staff(p_shop_id) then perform app.fail('SHOP_NOT_AVAILABLE'); end if;
  select * into bk from public.booking_settings where shop_id = p_shop_id;
  select timezone into v_tz from public.shops where id = p_shop_id;

  if not v_staff then
    if bk.require_phone and app.normalize_phone(p_client ->> 'phone') is null then perform app.fail('PHONE_REQUIRED'); end if;
    if bk.require_email and nullif(trim(p_client ->> 'email'), '') is null then perform app.fail('EMAIL_REQUIRED'); end if;
    if exists (select 1 from public.services s where s.id = any (p_service_ids) and not s.is_public) then
      perform app.fail('SERVICE_NOT_BOOKABLE');
    end if;
  end if;

  -- Resolve "any barber": the available barber with the lightest day.
  if v_barber is null then
    if not v_staff and not bk.allow_any_barber then perform app.fail('BARBER_REQUIRED'); end if;
    select s.barber_id into v_barber
      from app.compute_slots(p_shop_id, p_service_ids, null, p_starts_at - interval '1 minute', p_starts_at + interval '1 minute', v_staff) s
     where s.starts_at = p_starts_at
     order by (select count(*) from public.appointments a
                where a.barber_id = s.barber_id and a.status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
                  and (a.starts_at at time zone v_tz)::date = (p_starts_at at time zone v_tz)::date), random()
     limit 1;
    if v_barber is null then perform app.fail('SLOT_TAKEN'); end if;
  elsif not app.is_bookable(p_shop_id, p_service_ids, v_barber, p_starts_at, v_staff) then
    perform app.fail('SLOT_TAKEN');
  end if;

  select * into q from app.barber_service_quote(v_barber, p_service_ids);
  select coalesce(b.buffer_minutes, bk.buffer_minutes) into v_buffer from public.barbers b where b.id = v_barber;

  v_client := app.upsert_client(p_shop_id, p_client, case when v_staff then 'staff' else 'online' end);

  if not v_staff then
    select count(*) into v_upcoming from public.appointments
     where client_id = v_client and starts_at > now() and status in ('BOOKED', 'CONFIRMED') and deleted_at is null;
    if v_upcoming >= 4 then perform app.fail('TOO_MANY_UPCOMING'); end if;
  end if;

  if p_rebooked_from is not null and not exists (
       select 1 from public.appointments where id = p_rebooked_from and client_id = v_client) then
    p_rebooked_from := null;
  end if;

  begin
    insert into public.appointments (shop_id, barber_id, client_id, kind, status, source, starts_at, ends_at, buffer_minutes,
                                     client_message, expected_price_cents, rebooked_from_id, booked_by)
    values (p_shop_id, v_barber, v_client, 'appointment', 'BOOKED',
            case when p_rebooked_from is not null and v_source = 'online' then 'rebook' else v_source end,
            p_starts_at, p_starts_at + make_interval(mins => q.duration_minutes), v_buffer,
            nullif(trim(p_message), ''), q.price_cents, p_rebooked_from, auth.uid())
    returning id, manage_token into v_appt, v_token;
  exception when exclusion_violation then
    perform app.fail('SLOT_TAKEN');
  end;

  insert into public.appointment_services (appointment_id, service_id, name, price_cents, duration_minutes, position)
  select v_appt, s.id, s.name, coalesce(bs.price_cents, s.price_cents), coalesce(bs.duration_minutes, s.duration_minutes), req.ord
    from unnest(p_service_ids) with ordinality req(service_id, ord)
    join public.services s on s.id = req.service_id
    join public.barber_services bs on bs.service_id = s.id and bs.barber_id = v_barber;

  perform app.notify_client(v_appt, 'appointment.created', now(), 'created:' || v_appt);
  perform app.schedule_reminders(v_appt);
  perform app.notify_staff(v_appt, 'staff.new_booking');

  return jsonb_build_object('appointment_id', v_appt, 'manage_token', v_token, 'barber_id', v_barber,
                            'starts_at', p_starts_at, 'client_id', v_client);
end $$;

-- Guest manage page (token = capability).
create or replace function public.get_booking(p_token uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select app.appointment_payload(a.id) || jsonb_build_object(
           'id', a.id, 'status', a.status, 'starts_at', a.starts_at, 'ends_at', a.ends_at,
           'shop_id', a.shop_id, 'barber_id', a.barber_id, 'timezone', s.timezone, 'accent_color', s.accent_color,
           'service_ids', (select jsonb_agg(x.service_id order by x.position) from public.appointment_services x where x.appointment_id = a.id),
           'price_cents', a.expected_price_cents,
           'currency', (select currency from public.shop_settings where shop_id = a.shop_id),
           'address', concat_ws(', ', s.address_line1, s.city, s.region),
           'can_cancel', bk.allow_client_cancel and a.status in ('BOOKED', 'CONFIRMED') and a.starts_at > now(),
           'can_reschedule', bk.allow_client_reschedule and a.status in ('BOOKED', 'CONFIRMED') and a.starts_at > now(),
           'is_late', a.starts_at - now() < make_interval(hours => bk.cancellation_window_hours),
           'cancellation_window_hours', bk.cancellation_window_hours,
           'late_cancel_fee_cents', bk.late_cancel_fee_cents,
           'cancellation_policy_text', bk.cancellation_policy_text,
           'review_token', case when a.status = 'COMPLETED' and not exists (select 1 from public.reviews r where r.appointment_id = a.id) then a.review_token end)
    from public.appointments a
    join public.shops s on s.id = a.shop_id
    join public.booking_settings bk on bk.shop_id = a.shop_id
   where a.manage_token = p_token and a.deleted_at is null
$$;

create or replace function app.cancel_appointment_internal(p_appt uuid, p_reason text, p_by_client boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments; bk public.booking_settings; v_late boolean;
begin
  select * into a from public.appointments where id = p_appt for update;
  if a.status not in ('BOOKED', 'CONFIRMED', 'CHECKED_IN') then perform app.fail('NOT_CANCELLABLE'); end if;
  select * into bk from public.booking_settings where shop_id = a.shop_id;
  v_late := p_by_client and a.starts_at - now() < make_interval(hours => bk.cancellation_window_hours);
  update public.appointments
     set status = 'CANCELLED', cancelled_at = now(), cancelled_by = auth.uid(), cancelled_by_client = p_by_client,
         cancel_reason = nullif(trim(p_reason), ''), is_late_cancellation = v_late,
         fee_cents = case when v_late then bk.late_cancel_fee_cents else 0 end
   where id = p_appt;
  if a.kind = 'appointment' then
    perform app.notify_client(p_appt, 'appointment.cancelled', now(), 'cancelled:' || p_appt);
    perform app.notify_staff(p_appt, 'staff.cancellation');
  end if;
  return jsonb_build_object('late', v_late, 'fee_cents', case when v_late then bk.late_cancel_fee_cents else 0 end);
end $$;

create or replace function public.cancel_booking(p_token uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_shop uuid;
begin
  select id, shop_id into v_id, v_shop from public.appointments where manage_token = p_token and deleted_at is null;
  if v_id is null then perform app.fail('NOT_FOUND'); end if;
  if not (select allow_client_cancel from public.booking_settings where shop_id = v_shop) then
    perform app.fail('CANCEL_DISABLED');
  end if;
  if (select starts_at from public.appointments where id = v_id) <= now() then perform app.fail('NOT_CANCELLABLE'); end if;
  return app.cancel_appointment_internal(v_id, p_reason, true);
end $$;

create or replace function public.confirm_booking(p_token uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.appointments set status = 'CONFIRMED'
   where manage_token = p_token and status = 'BOOKED' and starts_at > now();
end $$;

-- Move an appointment to a new time (and optionally barber). The old row is
-- kept as RESCHEDULED for history; a new row carries the new time.
create or replace function app.reschedule_internal(p_appt uuid, p_new_start timestamptz, p_barber uuid, p_staff boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.appointments;
  v_services uuid[];
  v_barber uuid;
  q record;
  v_buffer int;
  v_new uuid;
  v_token uuid;
begin
  select * into a from public.appointments where id = p_appt for update;
  if a.status not in ('BOOKED', 'CONFIRMED') then perform app.fail('NOT_RESCHEDULABLE'); end if;
  select array_agg(service_id order by position) into v_services
    from public.appointment_services where appointment_id = p_appt and service_id is not null;
  v_barber := coalesce(p_barber, a.barber_id);
  if not app.is_bookable(a.shop_id, v_services, v_barber, p_new_start, p_staff, p_appt) then
    perform app.fail('SLOT_TAKEN');
  end if;

  update public.appointments set status = 'RESCHEDULED' where id = p_appt;
  select * into q from app.barber_service_quote(v_barber, v_services);
  select coalesce(b.buffer_minutes, bk.buffer_minutes) into v_buffer
    from public.barbers b join public.booking_settings bk on bk.shop_id = b.shop_id where b.id = v_barber;

  begin
    insert into public.appointments (shop_id, barber_id, client_id, kind, status, source, starts_at, ends_at, buffer_minutes,
                                     notes, client_message, expected_price_cents, rescheduled_from_id, rebooked_from_id,
                                     booked_by, manage_token)
    values (a.shop_id, v_barber, a.client_id, 'appointment', 'BOOKED', a.source, p_new_start,
            p_new_start + make_interval(mins => q.duration_minutes), v_buffer, a.notes, a.client_message, q.price_cents,
            a.id, a.rebooked_from_id, auth.uid(), gen_random_uuid())
    returning id, manage_token into v_new, v_token;
  exception when exclusion_violation then
    perform app.fail('SLOT_TAKEN');
  end;

  insert into public.appointment_services (appointment_id, service_id, name, price_cents, duration_minutes, position)
  select v_new, s.id, s.name, coalesce(bs.price_cents, s.price_cents), coalesce(bs.duration_minutes, s.duration_minutes), x.position
    from public.appointment_services x
    join public.services s on s.id = x.service_id
    join public.barber_services bs on bs.service_id = s.id and bs.barber_id = v_barber
   where x.appointment_id = p_appt;

  perform app.notify_client(v_new, 'appointment.rescheduled', now(), 'rescheduled:' || v_new);
  perform app.schedule_reminders(v_new);
  perform app.notify_staff(v_new, 'staff.new_booking');
  return jsonb_build_object('appointment_id', v_new, 'manage_token', v_token, 'starts_at', p_new_start, 'barber_id', v_barber);
end $$;

create or replace function public.reschedule_booking(p_token uuid, p_new_start timestamptz, p_barber_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_shop uuid;
begin
  select id, shop_id into v_id, v_shop from public.appointments where manage_token = p_token and deleted_at is null;
  if v_id is null then perform app.fail('NOT_FOUND'); end if;
  if not (select allow_client_reschedule from public.booking_settings where shop_id = v_shop) then
    perform app.fail('RESCHEDULE_DISABLED');
  end if;
  return app.reschedule_internal(v_id, p_new_start, p_barber_id, false);
end $$;

-- ---------------------------------------------------------------------------
-- Client portal (logged-in customers)
-- ---------------------------------------------------------------------------
-- Link existing client records (booked as guest) whose email matches the
-- signed-in, verified account.
create or replace function public.link_my_client_records()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text := app.current_email(); n int;
begin
  perform app.require_auth();
  if v_email is null then return 0; end if;
  update public.clients set user_id = auth.uid()
   where user_id is null and lower(email::text) = v_email and deleted_at is null and merged_into_id is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.my_appointments()
returns table (id uuid, shop_id uuid, shop_name text, shop_slug text, accent_color text, timezone text,
               barber_id uuid, barber_name text, barber_photo_url text, service_ids uuid[], service_name text,
               starts_at timestamptz, ends_at timestamptz, status public.appointment_status,
               price_cents bigint, manage_token uuid, review_token uuid, has_review boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.id, s.id, s.name, s.slug, s.accent_color, s.timezone, b.id, b.display_name, b.photo_url,
         array(select x.service_id from public.appointment_services x where x.appointment_id = a.id order by x.position),
         (select string_agg(x.name, ' + ' order by x.position) from public.appointment_services x where x.appointment_id = a.id),
         a.starts_at, a.ends_at, a.status, a.expected_price_cents, a.manage_token,
         case when a.status = 'COMPLETED' then a.review_token end,
         exists (select 1 from public.reviews r where r.appointment_id = a.id)
    from public.appointments a
    join public.clients c on c.id = a.client_id
    join public.shops s on s.id = a.shop_id
    join public.barbers b on b.id = a.barber_id
   where c.user_id = auth.uid() and auth.uid() is not null and a.deleted_at is null and a.kind = 'appointment'
     and a.status <> 'RESCHEDULED'
   order by a.starts_at desc
   limit 200
$$;

create or replace function public.my_favorite_barbers()
returns table (barber_id uuid, barber_name text, photo_url text, title text, shop_id uuid, shop_name text, shop_slug text, barber_slug text, timezone text)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.display_name, b.photo_url, b.title, s.id, s.name, s.slug, b.slug, s.timezone
    from public.client_favorites f
    join public.barbers b on b.id = f.barber_id and b.deleted_at is null and b.status = 'active'
    join public.shops s on s.id = b.shop_id and s.is_published
   where f.user_id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------
create or replace function public.get_review_context(p_token uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select app.appointment_payload(a.id) || jsonb_build_object(
           'status', a.status, 'accent_color', s.accent_color,
           'already_reviewed', exists (select 1 from public.reviews r where r.appointment_id = a.id))
    from public.appointments a join public.shops s on s.id = a.shop_id
   where a.review_token = p_token
$$;

create or replace function public.submit_review(
  p_token uuid, p_barber_rating int, p_shop_rating int default null, p_comment text default null, p_is_public boolean default true)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments;
begin
  select * into a from public.appointments where review_token = p_token;
  if a.id is null then perform app.fail('NOT_FOUND'); end if;
  if a.status <> 'COMPLETED' then perform app.fail('NOT_COMPLETED'); end if;
  if p_barber_rating is null and p_shop_rating is null then perform app.fail('RATING_REQUIRED'); end if;
  begin
    insert into public.reviews (shop_id, appointment_id, client_id, barber_id, barber_rating, shop_rating, comment, is_public)
    values (a.shop_id, a.id, a.client_id, a.barber_id, p_barber_rating, p_shop_rating, nullif(trim(p_comment), ''), coalesce(p_is_public, true));
  exception when unique_violation then
    perform app.fail('ALREADY_REVIEWED');
  end;
end $$;

-- ===================== 20261007000011_rpc_operations.sql =====================
-- =============================================================================
-- Staff operations: calendar management, haircut timer, walk-in queue,
-- waitlist, emergency unavailability.
-- =============================================================================

-- Can the current user operate on this barber's calendar?
create or replace function app.can_manage_barber_calendar(p_barber uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_my_barber(p_barber) or app.can(app.barber_shop(p_barber), 'calendar.all')
$$;

create or replace function app.require_appointment_access(p_appt uuid)
returns public.appointments language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments;
begin
  perform app.require_auth();
  select * into a from public.appointments where id = p_appt and deleted_at is null for update;
  if a.id is null then perform app.fail('NOT_FOUND'); end if;
  if not app.can_manage_barber_calendar(a.barber_id) then perform app.fail('FORBIDDEN'); end if;
  return a;
end $$;

-- ---------------------------------------------------------------------------
-- Calendar
-- ---------------------------------------------------------------------------
-- Staff booking (phone/in-person). p_force allows times outside the normal
-- rules (e.g. before opening) but never an overlap.
create or replace function public.staff_create_appointment(
  p_shop_id uuid, p_barber_id uuid, p_service_ids uuid[], p_starts_at timestamptz,
  p_client_id uuid default null, p_client jsonb default null, p_notes text default null,
  p_source public.booking_source default 'staff', p_force boolean default false, p_rebooked_from uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client uuid := p_client_id; v_res jsonb; q record; v_buffer int; v_appt uuid;
begin
  perform app.require_auth();
  if app.barber_shop(p_barber_id) is distinct from p_shop_id then perform app.fail('BARBER_NOT_IN_SHOP'); end if;
  if not app.can_manage_barber_calendar(p_barber_id) then perform app.fail('FORBIDDEN'); end if;
  if v_client is null then
    if p_client is null then perform app.fail('CLIENT_REQUIRED'); end if;
    v_client := app.upsert_client(p_shop_id, p_client, 'staff');
  elsif not exists (select 1 from public.clients where id = v_client and shop_id = p_shop_id) then
    perform app.fail('CLIENT_NOT_IN_SHOP');
  end if;

  if not p_force and not app.is_bookable(p_shop_id, p_service_ids, p_barber_id, p_starts_at, true) then
    perform app.fail('SLOT_TAKEN');
  end if;
  select * into q from app.barber_service_quote(p_barber_id, p_service_ids);
  if q.duration_minutes is null then perform app.fail('SERVICE_NOT_OFFERED'); end if;
  select coalesce(b.buffer_minutes, bk.buffer_minutes) into v_buffer
    from public.barbers b join public.booking_settings bk on bk.shop_id = b.shop_id where b.id = p_barber_id;

  begin
    insert into public.appointments (shop_id, barber_id, client_id, kind, status, source, starts_at, ends_at,
                                     buffer_minutes, notes, expected_price_cents, booked_by, rebooked_from_id)
    values (p_shop_id, p_barber_id, v_client, 'appointment', 'BOOKED',
            case when p_rebooked_from is not null then 'rebook' else coalesce(p_source, 'staff') end, p_starts_at,
            p_starts_at + make_interval(mins => q.duration_minutes), v_buffer, p_notes, q.price_cents, auth.uid(),
            (select id from public.appointments where id = p_rebooked_from and client_id = v_client))
    returning id into v_appt;
  exception when exclusion_violation then
    perform app.fail('SLOT_TAKEN');
  end;
  insert into public.appointment_services (appointment_id, service_id, name, price_cents, duration_minutes, position)
  select v_appt, s.id, s.name, coalesce(bs.price_cents, s.price_cents), coalesce(bs.duration_minutes, s.duration_minutes), req.ord
    from unnest(p_service_ids) with ordinality req(service_id, ord)
    join public.services s on s.id = req.service_id
    join public.barber_services bs on bs.service_id = s.id and bs.barber_id = p_barber_id;
  perform app.notify_client(v_appt, 'appointment.created', now(), 'created:' || v_appt);
  perform app.schedule_reminders(v_appt);
  perform app.notify_staff(v_appt, 'staff.new_booking');
  return jsonb_build_object('appointment_id', v_appt, 'client_id', v_client);
end $$;

-- Block time / break / personal / emergency on the calendar.
create or replace function public.create_calendar_block(
  p_barber_id uuid, p_kind public.calendar_kind, p_starts_at timestamptz, p_ends_at timestamptz, p_title text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform app.require_auth();
  if p_kind = 'appointment' then perform app.fail('INVALID_KIND'); end if;
  if not app.can_manage_barber_calendar(p_barber_id) then perform app.fail('FORBIDDEN'); end if;
  begin
    insert into public.appointments (shop_id, barber_id, kind, status, source, starts_at, ends_at, title, booked_by)
    values (app.barber_shop(p_barber_id), p_barber_id, p_kind, 'BOOKED', 'staff', p_starts_at, p_ends_at,
            coalesce(nullif(trim(p_title), ''), initcap(p_kind::text)), auth.uid())
    returning id into v_id;
  exception when exclusion_violation then
    perform app.fail('OVERLAPS_EXISTING');
  end;
  return v_id;
end $$;

-- Drag & drop / edit: move in place (same row; audit log keeps history).
create or replace function public.move_appointment(
  p_appointment_id uuid, p_new_start timestamptz, p_new_barber_id uuid default null, p_force boolean default false,
  p_new_end timestamptz default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments; v_barber uuid; v_services uuid[]; v_len interval; q record;
begin
  a := app.require_appointment_access(p_appointment_id);
  v_barber := coalesce(p_new_barber_id, a.barber_id);
  if v_barber <> a.barber_id and not app.can_manage_barber_calendar(v_barber) then perform app.fail('FORBIDDEN'); end if;
  if app.barber_shop(v_barber) <> a.shop_id then perform app.fail('BARBER_NOT_IN_SHOP'); end if;
  if a.status not in ('BOOKED', 'CONFIRMED', 'CHECKED_IN') then perform app.fail('NOT_MOVABLE'); end if;

  v_len := coalesce(p_new_end - p_new_start, a.ends_at - a.starts_at);
  if a.kind = 'appointment' then
    select array_agg(service_id order by position) into v_services
      from public.appointment_services where appointment_id = a.id and service_id is not null;
    if v_barber <> a.barber_id then
      select * into q from app.barber_service_quote(v_barber, v_services);
      if q.duration_minutes is null then perform app.fail('SERVICE_NOT_OFFERED'); end if;
      if p_new_end is null then v_len := make_interval(mins => q.duration_minutes); end if;
    end if;
    if not p_force and not app.is_bookable(a.shop_id, v_services, v_barber, p_new_start, true, a.id) then
      perform app.fail('SLOT_TAKEN');
    end if;
  end if;

  begin
    update public.appointments set starts_at = p_new_start, ends_at = p_new_start + v_len, barber_id = v_barber
     where id = a.id;
  exception when exclusion_violation then
    perform app.fail('SLOT_TAKEN');
  end;
  if a.kind = 'appointment' and (p_new_start <> a.starts_at or v_barber <> a.barber_id) then
    perform app.notify_client(a.id, 'appointment.rescheduled', now(), 'moved:' || a.id || ':' || extract(epoch from p_new_start)::bigint);
  end if;
end $$;

create or replace function public.staff_reschedule(p_appointment_id uuid, p_new_start timestamptz, p_barber_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_appointment_access(p_appointment_id);
  return app.reschedule_internal(p_appointment_id, p_new_start, p_barber_id, true);
end $$;

create or replace function public.update_appointment_notes(p_appointment_id uuid, p_notes text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_appointment_access(p_appointment_id);
  update public.appointments set notes = p_notes where id = p_appointment_id;
end $$;

-- Generic status change used by the calendar (confirm, check-in, no-show,
-- cancel, restore). Timer transitions have dedicated functions below.
create or replace function public.set_appointment_status(
  p_appointment_id uuid, p_status public.appointment_status, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments; bk public.booking_settings; v_res jsonb := '{}'::jsonb;
begin
  a := app.require_appointment_access(p_appointment_id);
  select * into bk from public.booking_settings where shop_id = a.shop_id;
  case p_status
    when 'CANCELLED' then
      if a.kind <> 'appointment' then
        update public.appointments set deleted_at = now() where id = a.id; -- removing a block
        return '{}'::jsonb;
      end if;
      return app.cancel_appointment_internal(a.id, p_reason, false);
    when 'NO_SHOW' then
      if a.starts_at > now() then perform app.fail('NOT_STARTED_YET'); end if;
      update public.appointments set status = 'NO_SHOW', fee_cents = bk.no_show_fee_cents, cancel_reason = p_reason
       where id = a.id;
      perform app.notify_client(a.id, 'appointment.no_show', now(), 'noshow:' || a.id);
      v_res := jsonb_build_object('fee_cents', bk.no_show_fee_cents);
    when 'CHECKED_IN' then
      update public.appointments set status = 'CHECKED_IN', checked_in_at = coalesce(checked_in_at, now()) where id = a.id;
    when 'CONFIRMED', 'BOOKED' then
      begin
        update public.appointments set status = p_status, cancelled_at = null, cancel_reason = null,
               is_late_cancellation = false, fee_cents = 0 where id = a.id;
      exception when exclusion_violation then
        perform app.fail('SLOT_TAKEN', 'That time has been taken since this appointment was cancelled');
      end;
    else
      perform app.fail('USE_TIMER_ACTIONS');
  end case;
  return v_res;
end $$;

-- Emergency / sudden unavailability: create a time-off exception and report
-- (optionally cancel) the affected appointments.
create or replace function public.mark_barber_unavailable(
  p_barber_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_kind public.exception_kind default 'emergency',
  p_note text default null, p_cancel_affected boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id); v_ids uuid[]; i uuid;
begin
  perform app.require_auth();
  if not (app.is_my_barber(p_barber_id) or app.can(v_shop, 'schedule.manage_all')) then perform app.fail('FORBIDDEN'); end if;
  if p_kind in ('extra_hours', 'closure') then perform app.fail('INVALID_KIND'); end if;
  insert into public.availability_exceptions (shop_id, barber_id, kind, starts_at, ends_at, note, created_by)
  values (v_shop, p_barber_id, p_kind, p_starts_at, p_ends_at, p_note, auth.uid());
  select array_agg(id order by starts_at) into v_ids from public.appointments
   where barber_id = p_barber_id and kind = 'appointment' and status in ('BOOKED', 'CONFIRMED')
     and starts_at < p_ends_at and ends_at > p_starts_at and deleted_at is null;
  if p_cancel_affected and v_ids is not null then
    foreach i in array v_ids loop
      perform app.cancel_appointment_internal(i, coalesce(p_note, 'Barber unavailable'), false);
    end loop;
  end if;
  return jsonb_build_object('affected', coalesce(to_jsonb(v_ids), '[]'::jsonb), 'cancelled', p_cancel_affected);
end $$;

-- Shop-wide closure (weather, power cut...).
create or replace function public.close_shop(p_shop_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ids uuid[];
begin
  perform app.require(p_shop_id, 'schedule.manage_all');
  insert into public.availability_exceptions (shop_id, barber_id, kind, starts_at, ends_at, note, created_by)
  values (p_shop_id, null, 'closure', p_starts_at, p_ends_at, p_note, auth.uid());
  select array_agg(id order by starts_at) into v_ids from public.appointments
   where shop_id = p_shop_id and kind = 'appointment' and status in ('BOOKED', 'CONFIRMED')
     and starts_at < p_ends_at and ends_at > p_starts_at and deleted_at is null;
  return jsonb_build_object('affected', coalesce(to_jsonb(v_ids), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Haircut timer
-- ---------------------------------------------------------------------------
create or replace function public.start_cut(p_appointment_id uuid)
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments; v_other uuid;
begin
  a := app.require_appointment_access(p_appointment_id);
  if a.kind <> 'appointment' then perform app.fail('INVALID_KIND'); end if;
  if a.status not in ('BOOKED', 'CONFIRMED', 'CHECKED_IN') then perform app.fail('INVALID_STATUS_TRANSITION'); end if;
  select id into v_other from public.appointments
   where barber_id = a.barber_id and status = 'IN_SERVICE' and id <> a.id and deleted_at is null limit 1;
  if v_other is not null then perform app.fail('BARBER_BUSY', v_other::text); end if;
  update public.appointments
     set status = 'IN_SERVICE', actual_started_at = now(), checked_in_at = coalesce(checked_in_at, now())
   where id = a.id;
  update public.walk_ins set status = 'serving', served_at = coalesce(served_at, now()) where appointment_id = a.id;
  return now();
end $$;

-- Undo an accidental START.
create or replace function public.undo_start_cut(p_appointment_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments;
begin
  a := app.require_appointment_access(p_appointment_id);
  if a.status <> 'IN_SERVICE' then perform app.fail('INVALID_STATUS_TRANSITION'); end if;
  update public.appointments set status = 'CHECKED_IN', actual_started_at = null where id = a.id;
end $$;

-- FINISH CUT: stops the timer and completes the appointment. Payment is
-- recorded separately (record_payment), so a missing payment is visible as
-- "completed · unpaid" instead of blocking the barber.
create or replace function public.finish_cut(p_appointment_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments; ss public.shop_settings; v_now timestamptz := now();
begin
  a := app.require_appointment_access(p_appointment_id);
  if a.kind <> 'appointment' then perform app.fail('INVALID_KIND'); end if;
  if a.status not in ('IN_SERVICE', 'CHECKED_IN', 'CONFIRMED', 'BOOKED') then perform app.fail('INVALID_STATUS_TRANSITION'); end if;
  select * into ss from public.shop_settings where shop_id = a.shop_id;
  update public.appointments
     set status = 'COMPLETED', completed_at = v_now,
         actual_finished_at = case when actual_started_at is not null then v_now end
   where id = a.id;
  update public.walk_ins set status = 'done' where appointment_id = a.id;
  if ss.review_requests_enabled then
    perform app.notify_client(a.id, 'review.request', v_now + make_interval(mins => ss.review_request_delay_minutes), 'review:' || a.id);
  end if;
  return jsonb_build_object(
    'actual_seconds', case when a.actual_started_at is not null then extract(epoch from v_now - a.actual_started_at)::int end,
    'scheduled_minutes', extract(epoch from a.ends_at - a.starts_at)::int / 60,
    'rebook_weeks', coalesce((select ceil(cp.rebook_interval_days / 7.0)::int from public.client_preferences cp where cp.client_id = a.client_id),
                             ss.default_rebook_weeks));
end $$;

-- ---------------------------------------------------------------------------
-- Walk-in queue
-- ---------------------------------------------------------------------------
-- Live queue with estimated waits. Simulation: each barber's "next free"
-- moment comes from the real slot engine (respecting upcoming bookings);
-- waiting walk-ins are assigned FIFO to the earliest compatible barber.
create or replace function public.walk_in_queue(p_shop_id uuid)
returns table (id uuid, name text, phone text, service_id uuid, service_name text, preferred_barber_id uuid,
               status public.walk_in_status, created_at timestamptz, queue_position int,
               estimated_start timestamptz, estimated_wait_minutes int, likely_barber_id uuid, client_id uuid, notes text)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  w record;
  v_cursor jsonb := '{}'::jsonb;   -- barber_id -> next free timestamptz
  v_best_barber uuid;
  v_best_start timestamptz;
  s record;
  v_pos int := 0;
  v_dur int;
begin
  perform app.require_auth();
  if not app.is_staff(p_shop_id) then perform app.fail('FORBIDDEN'); end if;
  for w in
    select wi.*, sv.name as service_name, sv.duration_minutes
      from public.walk_ins wi left join public.services sv on sv.id = wi.service_id
     where wi.shop_id = p_shop_id and wi.status in ('waiting', 'called')
       and wi.created_at > now() - interval '18 hours'
     order by wi.created_at
  loop
    v_pos := v_pos + 1;
    v_best_barber := null; v_best_start := null;
    if w.service_id is not null then
      for s in
        select distinct on (cs.barber_id) cs.barber_id, cs.starts_at
          from app.compute_slots(p_shop_id, array[w.service_id], w.preferred_barber_id, now(), now() + interval '12 hours', true) cs
         where cs.starts_at >= coalesce((v_cursor ->> cs.barber_id::text)::timestamptz, now() - interval '1 minute')
         order by cs.barber_id, cs.starts_at
      loop
        if v_best_start is null or s.starts_at < v_best_start then
          v_best_start := s.starts_at; v_best_barber := s.barber_id;
        end if;
      end loop;
    end if;
    if v_best_barber is not null then
      v_dur := coalesce((select duration_minutes from app.barber_service_quote(v_best_barber, array[w.service_id])), w.duration_minutes, 30);
      v_cursor := v_cursor || jsonb_build_object(v_best_barber::text, v_best_start + make_interval(mins => v_dur));
    end if;
    id := w.id; name := w.name; phone := w.phone; service_id := w.service_id; service_name := w.service_name;
    preferred_barber_id := w.preferred_barber_id; status := w.status; created_at := w.created_at; queue_position := v_pos;
    estimated_start := v_best_start;
    estimated_wait_minutes := case when v_best_start is not null then greatest(0, ceil(extract(epoch from v_best_start - now()) / 60))::int end;
    likely_barber_id := v_best_barber; client_id := w.client_id; notes := w.notes;
    return next;
  end loop;
end $$;

create or replace function public.add_walk_in(
  p_shop_id uuid, p_name text, p_phone text default null, p_service_id uuid default null,
  p_preferred_barber_id uuid default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_client uuid; v_wait int;
begin
  perform app.require_auth();
  if not (app.can(p_shop_id, 'walkins.manage') or app.can(p_shop_id, 'walkins.serve')) then perform app.fail('FORBIDDEN'); end if;
  perform app.require_feature(p_shop_id, 'walk_ins');
  if p_preferred_barber_id is not null and app.barber_shop(p_preferred_barber_id) <> p_shop_id then
    perform app.fail('BARBER_NOT_IN_SHOP');
  end if;
  if app.normalize_phone(p_phone) is not null then
    v_client := app.upsert_client(p_shop_id, jsonb_build_object(
      'first_name', split_part(trim(p_name), ' ', 1),
      'last_name', nullif(substr(trim(p_name), length(split_part(trim(p_name), ' ', 1)) + 2), ''),
      'phone', p_phone), 'walk_in');
  end if;
  insert into public.walk_ins (shop_id, client_id, name, phone, service_id, preferred_barber_id, notes, created_by)
  values (p_shop_id, v_client, trim(p_name), p_phone, p_service_id, p_preferred_barber_id, p_notes, auth.uid())
  returning id into v_id;
  select q.estimated_wait_minutes into v_wait from public.walk_in_queue(p_shop_id) q where q.id = v_id;
  update public.walk_ins set quoted_wait_minutes = v_wait where id = v_id;
  return jsonb_build_object('id', v_id, 'estimated_wait_minutes', v_wait);
end $$;

-- NEXT CLIENT: take the first compatible walk-in (or a specific one) and
-- put them into the barber's chair right now.
create or replace function public.call_next_walk_in(p_barber_id uuid, p_walk_in_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_shop uuid := app.barber_shop(p_barber_id);
  w public.walk_ins;
  q record;
  v_appt uuid;
  v_client uuid;
  v_start timestamptz := date_trunc('minute', now());
  v_next timestamptz;
begin
  perform app.require_auth();
  if not app.can_manage_barber_calendar(p_barber_id) then perform app.fail('FORBIDDEN'); end if;
  select * into w from public.walk_ins
   where shop_id = v_shop and status in ('waiting', 'called')
     and (p_walk_in_id is null or id = p_walk_in_id)
     and (preferred_barber_id is null or preferred_barber_id = p_barber_id)
   order by created_at limit 1 for update skip locked;
  if w.id is null then perform app.fail('QUEUE_EMPTY'); end if;
  if w.service_id is null then perform app.fail('SERVICE_REQUIRED'); end if;
  select * into q from app.barber_service_quote(p_barber_id, array[w.service_id]);
  if q.duration_minutes is null then perform app.fail('SERVICE_NOT_OFFERED'); end if;

  v_client := w.client_id;
  if v_client is null then
    v_client := app.upsert_client(v_shop, jsonb_build_object('first_name', w.name), 'walk_in');
  end if;

  begin
    insert into public.appointments (shop_id, barber_id, client_id, kind, status, source, starts_at, ends_at,
                                     expected_price_cents, walk_in_id, checked_in_at, booked_by)
    values (v_shop, p_barber_id, v_client, 'appointment', 'CHECKED_IN', 'walk_in', v_start,
            v_start + make_interval(mins => q.duration_minutes), q.price_cents, w.id, w.created_at, auth.uid())
    returning id into v_appt;
  exception when exclusion_violation then
    select min(starts_at) into v_next from public.appointments
     where barber_id = p_barber_id and starts_at >= v_start and status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED') and deleted_at is null;
    perform app.fail('NOT_ENOUGH_TIME', coalesce('Next booking starts at ' || v_next::text, 'Barber is busy'));
  end;
  insert into public.appointment_services (appointment_id, service_id, name, price_cents, duration_minutes)
  select v_appt, s.id, s.name, q.price_cents, q.duration_minutes from public.services s where s.id = w.service_id;
  update public.walk_ins
     set status = 'serving', called_at = coalesce(called_at, now()), appointment_id = v_appt,
         assigned_barber_id = p_barber_id, client_id = v_client
   where id = w.id;
  return jsonb_build_object('appointment_id', v_appt, 'walk_in_id', w.id, 'client_id', v_client);
end $$;

create or replace function public.update_walk_in(p_walk_in_id uuid, p_status public.walk_in_status)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid;
begin
  select shop_id into v_shop from public.walk_ins where id = p_walk_in_id;
  perform app.require_auth();
  if not (app.can(v_shop, 'walkins.manage') or app.can(v_shop, 'walkins.serve')) then perform app.fail('FORBIDDEN'); end if;
  if p_status not in ('called', 'left', 'cancelled', 'waiting') then perform app.fail('INVALID_STATUS'); end if;
  update public.walk_ins
     set status = p_status,
         called_at = case when p_status = 'called' then now() else called_at end,
         left_at = case when p_status in ('left', 'cancelled') then now() else left_at end
   where id = p_walk_in_id;
end $$;

-- ---------------------------------------------------------------------------
-- Waitlist
-- ---------------------------------------------------------------------------
create or replace function public.join_waitlist(
  p_shop_id uuid, p_service_id uuid, p_date date, p_client jsonb,
  p_barber_id uuid default null, p_time_from time default '00:00', p_time_to time default '23:59')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client uuid; v_id uuid; v_token uuid;
begin
  if not app.shop_is_public_or_staff(p_shop_id) then perform app.fail('SHOP_NOT_AVAILABLE'); end if;
  perform app.require_feature(p_shop_id, 'waitlist');
  if not (select waitlist_enabled from public.shop_settings where shop_id = p_shop_id) then perform app.fail('WAITLIST_DISABLED'); end if;
  if p_date < (now() at time zone (select timezone from public.shops where id = p_shop_id))::date then
    perform app.fail('DATE_IN_PAST');
  end if;
  if app.normalize_phone(p_client ->> 'phone') is null and nullif(p_client ->> 'email', '') is null then
    perform app.fail('CONTACT_REQUIRED');
  end if;
  v_client := app.upsert_client(p_shop_id, p_client, 'online');
  insert into public.waitlist (shop_id, client_id, service_id, barber_id, desired_date, time_from, time_to)
  values (p_shop_id, v_client, p_service_id, p_barber_id, p_date, coalesce(p_time_from, '00:00'), coalesce(p_time_to, '23:59'))
  returning id, claim_token into v_id, v_token;
  return jsonb_build_object('id', v_id, 'token', v_token);
end $$;

-- Offer a newly opened slot to matching waitlist entries (FIFO). Every
-- notified client gets the same link; the first valid claim wins (the
-- exclusion constraint guarantees only one booking succeeds).
create or replace function app.offer_openings(p_shop uuid, p_barber uuid, p_from timestamptz, p_to timestamptz)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  w record;
  s record;
  n int := 0;
  v_claim_minutes int;
begin
  if not app.shop_has_feature(p_shop, 'waitlist') then return 0; end if;
  select timezone into v_tz from public.shops where id = p_shop;
  select waitlist_claim_minutes into v_claim_minutes from public.booking_settings where shop_id = p_shop;
  for w in
    select * from public.waitlist
     where shop_id = p_shop and status = 'active'
       and desired_date = (p_from at time zone v_tz)::date
       and (barber_id is null or barber_id = p_barber)
     order by created_at
     limit 5
  loop
    select cs.barber_id, cs.starts_at into s
      from app.compute_slots(p_shop, array[w.service_id], p_barber, greatest(p_from - interval '30 minutes', now()), p_to + interval '30 minutes', false) cs
     where (cs.starts_at at time zone v_tz)::time >= w.time_from
       and (cs.starts_at at time zone v_tz)::time <= w.time_to
     order by cs.starts_at limit 1;
    continue when s.starts_at is null;
    update public.waitlist
       set status = 'notified', offered_barber_id = s.barber_id, offered_starts_at = s.starts_at,
           offer_expires_at = now() + make_interval(mins => v_claim_minutes), notified_at = now()
     where id = w.id;
    insert into public.notifications (shop_id, event, channel, audience, client_id, waitlist_id, to_address, payload, status, dedupe_key)
    select p_shop, 'waitlist.slot_available', 'email', 'client', c.id, w.id, c.email::text,
           jsonb_build_object('client_first_name', c.first_name, 'barber_name', b.display_name,
                              'when', app.fmt_when(s.starts_at, v_tz), 'claim_url', '/w/' || w.claim_token,
                              'shop_name', (select name from public.shops where id = p_shop)),
           case when c.email is null then 'skipped'::public.notification_status else 'queued' end,
           'waitlist:' || w.id || ':' || extract(epoch from s.starts_at)::bigint
      from public.clients c, public.barbers b
     where c.id = w.client_id and b.id = s.barber_id
    on conflict (dedupe_key) do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function app.appointments_waitlist_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status in ('CANCELLED', 'RESCHEDULED') and old.status not in ('CANCELLED', 'RESCHEDULED')
     and new.starts_at > now() then
    perform app.offer_openings(new.shop_id, new.barber_id, new.starts_at, new.blocked_until);
  end if;
  return null;
end $$;
create trigger appointments_waitlist after update of status on public.appointments
  for each row execute function app.appointments_waitlist_trigger();

create or replace function public.get_waitlist_offer(p_token uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'status', w.status, 'shop_name', s.name, 'shop_slug', s.slug, 'accent_color', s.accent_color, 'timezone', s.timezone,
    'service_name', sv.name, 'barber_name', b.display_name, 'offered_starts_at', w.offered_starts_at,
    'offer_expires_at', w.offer_expires_at, 'desired_date', w.desired_date,
    'claimed_manage_token', (select manage_token from public.appointments where id = w.claimed_appointment_id))
    from public.waitlist w
    join public.shops s on s.id = w.shop_id
    join public.services sv on sv.id = w.service_id
    left join public.barbers b on b.id = w.offered_barber_id
   where w.claim_token = p_token
$$;

create or replace function public.claim_waitlist_slot(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.waitlist; c public.clients; v_res jsonb;
begin
  select * into w from public.waitlist where claim_token = p_token for update;
  if w.id is null then perform app.fail('NOT_FOUND'); end if;
  if w.status <> 'notified' or w.offer_expires_at < now() then perform app.fail('OFFER_EXPIRED'); end if;
  select * into c from public.clients where id = w.client_id;
  begin
    v_res := public.book_appointment(w.shop_id, array[w.service_id], w.offered_starts_at,
               jsonb_build_object('first_name', c.first_name, 'last_name', c.last_name, 'phone', c.phone, 'email', c.email),
               w.offered_barber_id, null, null, 'waitlist');
  exception when others then
    if sqlerrm = 'SLOT_TAKEN' then
      -- Someone else was faster. Put this entry back in line (returning,
      -- not raising, so the update is committed).
      update public.waitlist set status = 'active', offered_starts_at = null, offered_barber_id = null where id = w.id;
      return jsonb_build_object('error', 'SLOT_TAKEN', 'message', 'Someone else claimed this slot first. You are still on the waitlist.');
    end if;
    raise;
  end;
  update public.waitlist set status = 'claimed', claimed_appointment_id = (v_res ->> 'appointment_id')::uuid where id = w.id;
  update public.appointments set waitlist_id = w.id where id = (v_res ->> 'appointment_id')::uuid;
  return v_res;
end $$;

create or replace function public.cancel_waitlist(p_token uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.waitlist set status = 'cancelled' where claim_token = p_token and status in ('active', 'notified')
$$;

-- Staff: book a waitlisted client directly into a slot.
create or replace function public.book_from_waitlist(p_waitlist_id uuid, p_barber_id uuid, p_starts_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.waitlist; v_res jsonb;
begin
  select * into w from public.waitlist where id = p_waitlist_id for update;
  if w.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(w.shop_id, 'waitlist.manage');
  v_res := public.staff_create_appointment(w.shop_id, p_barber_id, array[w.service_id], p_starts_at, w.client_id, null, null, 'waitlist');
  update public.waitlist set status = 'claimed', claimed_appointment_id = (v_res ->> 'appointment_id')::uuid where id = w.id;
  return v_res;
end $$;

-- ===================== 20261007000012_rpc_money.sql =====================
-- =============================================================================
-- Checkout, payments, tips, commissions, refunds.
-- All amounts are computed server-side; the client only sends what was
-- charged per line, discount, tip and method.
-- =============================================================================

-- Active commission rule for a barber at a point in time.
create or replace function app.commission_rule(p_barber uuid, p_at timestamptz)
returns public.commissions language sql stable security definer set search_path = public, pg_temp as $$
  select c.* from public.commissions c
    join public.shops s on s.id = c.shop_id
   where c.barber_id = p_barber
     and c.effective_from <= (p_at at time zone s.timezone)::date
     and (c.effective_to is null or c.effective_to >= (p_at at time zone s.timezone)::date)
   order by c.effective_from desc limit 1
$$;

-- Barber's share of a net service amount. Tiered rules are marginal on
-- month-to-date net service revenue (so crossing a tier mid-ticket is exact).
create or replace function app.compute_commission(p_barber uuid, p_net_cents bigint, p_service_count int, p_at timestamptz)
returns table (commission_cents bigint, commission_id uuid, snapshot jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.commissions := app.commission_rule(p_barber, p_at);
  v_tz text;
  v_mtd bigint;
  v_remaining bigint := p_net_cents;
  v_cursor bigint;
  v_total numeric := 0;
  t jsonb;
  v_cap bigint;
  v_portion bigint;
begin
  if c.id is null then
    -- No rule configured: everything stays with the shop until the owner sets one.
    return query select 0::bigint, null::uuid, jsonb_build_object('type', 'none');
    return;
  end if;
  case c.type
    when 'percentage' then
      v_total := p_net_cents * c.percent_bps / 10000.0;
    when 'fixed' then
      v_total := least(p_net_cents, c.fixed_cents * greatest(p_service_count, 1));
    when 'booth_rental' then
      v_total := p_net_cents;
    when 'hybrid' then
      v_total := p_net_cents * c.percent_bps / 10000.0;
    when 'tiered' then
      select s.timezone into v_tz from public.shops s where s.id = c.shop_id;
      select coalesce(sum(e.service_revenue_cents), 0) into v_mtd
        from public.barber_earnings e
       where e.barber_id = p_barber
         and e.earned_at >= (date_trunc('month', p_at at time zone v_tz) at time zone v_tz)
         and e.earned_at < p_at;
      v_cursor := v_mtd;
      for t in select * from jsonb_array_elements(c.tiers) order by coalesce((value ->> 'up_to_cents')::bigint, 9223372036854775807) loop
        exit when v_remaining <= 0;
        v_cap := (t ->> 'up_to_cents')::bigint;
        if v_cap is not null and v_cursor >= v_cap then continue; end if;
        v_portion := case when v_cap is null then v_remaining else least(v_remaining, v_cap - v_cursor) end;
        v_total := v_total + v_portion * (t ->> 'percent_bps')::int / 10000.0;
        v_remaining := v_remaining - v_portion;
        v_cursor := v_cursor + v_portion;
      end loop;
  end case;
  return query select round(v_total)::bigint, c.id, to_jsonb(c);
end $$;

-- Record what was charged (COMPLETE APPOINTMENT → checkout sheet).
-- p_items: [{"service_id": "...", "description": "Haircut", "price_cents": 3500, "quantity": 1}]
create or replace function public.record_payment(
  p_appointment_id uuid,
  p_items jsonb,
  p_tip_cents bigint default 0,
  p_discount_cents bigint default 0,
  p_method public.payment_method default 'cash',
  p_amount_paid_cents bigint default null,     -- NULL = paid in full
  p_notes text default null,
  p_promo_code text default null,
  p_tip_method public.payment_method default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.appointments;
  ss public.shop_settings;
  v_subtotal bigint;
  v_discount bigint := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax bigint;
  v_tip bigint := greatest(coalesce(p_tip_cents, 0), 0);
  v_total bigint;
  v_paid bigint;
  v_status public.payment_status;
  v_payment uuid;
  v_promo public.promo_codes;
  v_net bigint;
  cm record;
  v_tip_share bigint;
  v_count int;
begin
  perform app.require_auth();
  select * into a from public.appointments where id = p_appointment_id and deleted_at is null for update;
  if a.id is null then perform app.fail('NOT_FOUND'); end if;
  if not (app.can(a.shop_id, 'payments.record') or (app.is_my_barber(a.barber_id) and app.can(a.shop_id, 'payments.record_own'))) then
    perform app.fail('FORBIDDEN');
  end if;
  if a.kind <> 'appointment' then perform app.fail('INVALID_KIND'); end if;
  if a.status in ('CANCELLED', 'RESCHEDULED') then perform app.fail('APPOINTMENT_NOT_ACTIVE'); end if;
  if exists (select 1 from public.payments where appointment_id = a.id and kind = 'service' and status in ('PAID', 'PARTIAL')) then
    perform app.fail('ALREADY_PAID');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then perform app.fail('ITEMS_REQUIRED'); end if;
  if exists (select 1 from jsonb_array_elements(p_items) i
              where coalesce((i ->> 'price_cents')::bigint, -1) < 0 or coalesce((i ->> 'quantity')::int, 1) < 1) then
    perform app.fail('INVALID_AMOUNT');
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) i
              where i ? 'service_id' and nullif(i ->> 'service_id', '') is not null
                and not exists (select 1 from public.services s where s.id = (i ->> 'service_id')::uuid and s.shop_id = a.shop_id)) then
    perform app.fail('SERVICE_NOT_IN_SHOP');
  end if;

  select * into ss from public.shop_settings where shop_id = a.shop_id;
  select sum((i ->> 'price_cents')::bigint * coalesce((i ->> 'quantity')::int, 1)), sum(coalesce((i ->> 'quantity')::int, 1))
    into v_subtotal, v_count from jsonb_array_elements(p_items) i;

  if p_promo_code is not null and length(trim(p_promo_code)) > 0 then
    select * into v_promo from public.promo_codes
     where shop_id = a.shop_id and code = upper(trim(p_promo_code)) and is_active
       and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
       and (max_redemptions is null or redemptions < max_redemptions)
     for update;
    if v_promo.id is null then perform app.fail('PROMO_INVALID'); end if;
    if v_promo.first_visit_only and exists (select 1 from public.appointments x
         where x.client_id = a.client_id and x.status = 'COMPLETED' and x.id <> a.id) then
      perform app.fail('PROMO_FIRST_VISIT_ONLY');
    end if;
    v_discount := v_discount + case when v_promo.discount_type = 'percent'
                                    then round(v_subtotal * v_promo.discount_value / 10000.0)::bigint
                                    else v_promo.discount_value end;
    update public.promo_codes set redemptions = redemptions + 1 where id = v_promo.id;
  end if;
  v_discount := least(v_discount, v_subtotal);
  v_net := v_subtotal - v_discount;
  if not ss.tips_enabled then v_tip := 0; end if;

  v_tax := case when ss.prices_include_tax then 0 else round(v_net * ss.tax_rate_bps / 10000.0)::bigint end;
  v_total := v_net + v_tax + v_tip;
  v_paid := coalesce(p_amount_paid_cents, v_total);
  if v_paid < 0 or v_paid > v_total then perform app.fail('INVALID_AMOUNT'); end if;
  v_status := case when v_paid >= v_total then 'PAID' when v_paid = 0 then 'UNPAID' else 'PARTIAL' end;

  insert into public.payments (shop_id, appointment_id, client_id, barber_id, kind, subtotal_cents, discount_cents, tax_cents,
                               tip_cents, total_cents, amount_paid_cents, method, status, promo_code_id, provider, notes, recorded_by)
  values (a.shop_id, a.id, a.client_id, a.barber_id, 'service', v_subtotal, v_discount, v_tax, v_tip, v_total, v_paid,
          p_method, v_status, v_promo.id, 'manual', p_notes, auth.uid())
  returning id into v_payment;

  insert into public.payment_items (payment_id, service_id, description, quantity, unit_price_cents, total_cents)
  select v_payment, nullif(i ->> 'service_id', '')::uuid, coalesce(nullif(i ->> 'description', ''), 'Service'),
         coalesce((i ->> 'quantity')::int, 1), (i ->> 'price_cents')::bigint,
         (i ->> 'price_cents')::bigint * coalesce((i ->> 'quantity')::int, 1)
    from jsonb_array_elements(p_items) i;

  select * into cm from app.compute_commission(a.barber_id, v_net, v_count, now());
  v_tip_share := 0;
  if v_tip > 0 then
    insert into public.tips (shop_id, payment_id, appointment_id, barber_id, amount_cents, method)
    values (a.shop_id, v_payment, a.id, a.barber_id, v_tip, coalesce(p_tip_method, p_method));
    v_tip_share := round(v_tip * coalesce((cm.snapshot ->> 'tip_share_bps')::int, 10000) / 10000.0)::bigint;
  end if;

  insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, service_revenue_cents,
                                      commission_cents, tip_cents, shop_cents, commission_id, commission_snapshot)
  values (a.shop_id, a.barber_id, v_payment, a.id, 'service', v_net, cm.commission_cents, v_tip_share,
          v_net - cm.commission_cents + (v_tip - v_tip_share), cm.commission_id, cm.snapshot);

  -- Completing payment completes the appointment (and stops a running timer).
  update public.appointments
     set payment_status = v_status,
         status = case when status in ('COMPLETED', 'NO_SHOW') then status else 'COMPLETED' end,
         actual_finished_at = case when status = 'IN_SERVICE' then now() else actual_finished_at end,
         expected_price_cents = v_subtotal
   where id = a.id;

  -- Loyalty: 1 point per whole currency unit of net service revenue.
  if a.client_id is not null and v_net > 0 then
    insert into public.loyalty_ledger (shop_id, client_id, points, reason, payment_id)
    values (a.shop_id, a.client_id, (v_net / 100)::int, 'visit', v_payment);
  end if;

  if (select email from public.clients where id = a.client_id) is not null then
    perform app.notify_client(a.id, 'payment.recorded', now(), 'receipt:' || v_payment,
      jsonb_build_object('total', to_char(v_total / 100.0, 'FM999999990.00')));
  end if;

  return jsonb_build_object('payment_id', v_payment, 'subtotal_cents', v_subtotal, 'discount_cents', v_discount,
                            'tax_cents', v_tax, 'tip_cents', v_tip, 'total_cents', v_total, 'status', v_status,
                            'commission_cents', cm.commission_cents);
end $$;

-- Collect the remainder of a PARTIAL / UNPAID payment.
create or replace function public.settle_payment(p_payment_id uuid, p_amount_cents bigint, p_method public.payment_method default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; v_paid bigint;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  if not (app.can(p.shop_id, 'payments.record') or (app.is_my_barber(p.barber_id) and app.can(p.shop_id, 'payments.record_own'))) then
    perform app.fail('FORBIDDEN');
  end if;
  if p.status not in ('PARTIAL', 'UNPAID') then perform app.fail('INVALID_STATUS'); end if;
  v_paid := p.amount_paid_cents + p_amount_cents;
  if p_amount_cents <= 0 or v_paid > p.total_cents then perform app.fail('INVALID_AMOUNT'); end if;
  update public.payments
     set amount_paid_cents = v_paid, status = (case when v_paid = p.total_cents then 'PAID' else 'PARTIAL' end)::public.payment_status,
         method = coalesce(p_method, method)
   where id = p.id;
  update public.appointments set payment_status = (case when v_paid = p.total_cents then 'PAID' else 'PARTIAL' end)::public.payment_status
   where id = p.appointment_id;
end $$;

-- Add a tip after checkout (e.g. card tip settled later).
create or replace function public.add_tip(p_payment_id uuid, p_amount_cents bigint, p_method public.payment_method default 'card')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; v_share bigint; v_bps int;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  if not (app.can(p.shop_id, 'payments.record') or (app.is_my_barber(p.barber_id) and app.can(p.shop_id, 'payments.record_own'))) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_amount_cents <= 0 then perform app.fail('INVALID_AMOUNT'); end if;
  if p.status in ('VOID', 'REFUNDED') then perform app.fail('INVALID_STATUS'); end if;
  update public.payments set tip_cents = tip_cents + p_amount_cents, total_cents = total_cents + p_amount_cents,
         amount_paid_cents = amount_paid_cents + p_amount_cents where id = p.id;
  insert into public.tips (shop_id, payment_id, appointment_id, barber_id, amount_cents, method)
  values (p.shop_id, p.id, p.appointment_id, p.barber_id, p_amount_cents, p_method);
  v_bps := coalesce((app.commission_rule(p.barber_id, now())).tip_share_bps, 10000);
  v_share := round(p_amount_cents * v_bps / 10000.0)::bigint;
  insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, tip_cents, shop_cents)
  values (p.shop_id, p.barber_id, p.id, p.appointment_id, 'tip', v_share, p_amount_cents - v_share);
end $$;

-- Refund (full or partial). Earnings are reversed proportionally.
create or replace function public.refund_payment(p_payment_id uuid, p_amount_cents bigint, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; v_ratio numeric; e record;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(p.shop_id, 'payments.refund');
  if p.status in ('VOID', 'REFUNDED') then perform app.fail('INVALID_STATUS'); end if;
  if p_amount_cents <= 0 or p.refunded_cents + p_amount_cents > p.amount_paid_cents then perform app.fail('INVALID_AMOUNT'); end if;

  insert into public.refunds (payment_id, amount_cents, reason, refunded_by) values (p.id, p_amount_cents, p_reason, auth.uid());
  update public.payments
     set refunded_cents = refunded_cents + p_amount_cents,
         status = case when refunded_cents + p_amount_cents >= amount_paid_cents then 'REFUNDED' else status end
   where id = p.id;
  update public.appointments set payment_status = 'REFUNDED'
   where id = p.appointment_id and p.refunded_cents + p_amount_cents >= p.amount_paid_cents;

  v_ratio := p_amount_cents::numeric / nullif(p.total_cents, 0);
  select coalesce(sum(service_revenue_cents), 0) sr, coalesce(sum(commission_cents), 0) cc,
         coalesce(sum(tip_cents), 0) tc, coalesce(sum(shop_cents), 0) sc
    into e from public.barber_earnings where payment_id = p.id;
  insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, service_revenue_cents,
                                      commission_cents, tip_cents, shop_cents)
  values (p.shop_id, p.barber_id, p.id, p.appointment_id, 'refund',
          -round(e.sr * v_ratio)::bigint, -round(e.cc * v_ratio)::bigint, -round(e.tc * v_ratio)::bigint, -round(e.sc * v_ratio)::bigint);
end $$;

-- Void a mistaken payment entirely (reverses earnings, tips, loyalty).
create or replace function public.void_payment(p_payment_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(p.shop_id, 'payments.refund');
  if p.status = 'VOID' then return; end if;
  if p.refunded_cents > 0 then perform app.fail('ALREADY_REFUNDED'); end if;
  update public.payments set status = 'VOID', voided_at = now(), notes = concat_ws(' · ', notes, 'Voided: ' || p_reason) where id = p.id;
  delete from public.barber_earnings where payment_id = p.id;
  delete from public.tips where payment_id = p.id;
  delete from public.loyalty_ledger where payment_id = p.id;
  update public.appointments set payment_status = 'UNPAID' where id = p.appointment_id;
end $$;

-- Charge a no-show / late-cancellation fee that the policy assessed.
create or replace function public.charge_policy_fee(p_appointment_id uuid, p_method public.payment_method default 'card', p_waive boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments; v_payment uuid;
begin
  select * into a from public.appointments where id = p_appointment_id for update;
  if a.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(a.shop_id, 'payments.record');
  if a.fee_cents <= 0 then perform app.fail('NO_FEE'); end if;
  if p_waive then
    update public.appointments set fee_cents = 0 where id = a.id;
    return jsonb_build_object('waived', true);
  end if;
  insert into public.payments (shop_id, appointment_id, client_id, barber_id, kind, subtotal_cents, total_cents,
                               amount_paid_cents, method, status, provider, recorded_by)
  values (a.shop_id, a.id, a.client_id, a.barber_id,
          case when a.status = 'NO_SHOW' then 'no_show_fee' else 'late_cancel_fee' end,
          a.fee_cents, a.fee_cents, a.fee_cents, p_method, 'PAID', 'manual', auth.uid())
  returning id into v_payment;
  update public.appointments set payment_status = 'PAID' where id = a.id;
  return jsonb_build_object('payment_id', v_payment);
end $$;

-- Gift cards ---------------------------------------------------------------
create or replace function public.issue_gift_card(
  p_shop_id uuid, p_amount_cents bigint, p_recipient_name text default null, p_recipient_email text default null,
  p_message text default null, p_expires_at date default null, p_method public.payment_method default 'card')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.gift_cards; v_payment uuid;
begin
  perform app.require(p_shop_id, 'payments.record');
  perform app.require_feature(p_shop_id, 'marketing');
  if p_amount_cents <= 0 then perform app.fail('INVALID_AMOUNT'); end if;
  insert into public.gift_cards (shop_id, initial_cents, balance_cents, recipient_name, recipient_email, message, expires_at, issued_by)
  values (p_shop_id, p_amount_cents, p_amount_cents, p_recipient_name, p_recipient_email, p_message, p_expires_at, auth.uid())
  returning * into g;
  insert into public.payments (shop_id, kind, subtotal_cents, total_cents, amount_paid_cents, method, status, provider, recorded_by, gift_card_id)
  values (p_shop_id, 'gift_card', p_amount_cents, p_amount_cents, p_amount_cents, p_method, 'PAID', 'manual', auth.uid(), g.id)
  returning id into v_payment;
  insert into public.gift_card_transactions (gift_card_id, payment_id, amount_cents, created_by) values (g.id, v_payment, p_amount_cents, auth.uid());
  return jsonb_build_object('id', g.id, 'code', g.code);
end $$;

create or replace function public.redeem_gift_card(p_shop_id uuid, p_code text, p_amount_cents bigint, p_payment_id uuid default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.gift_cards;
begin
  perform app.require(p_shop_id, 'payments.record');
  select * into g from public.gift_cards where shop_id = p_shop_id and code = upper(trim(p_code)) for update;
  if g.id is null or g.status <> 'active' or (g.expires_at is not null and g.expires_at < current_date) then
    perform app.fail('GIFT_CARD_INVALID');
  end if;
  if p_amount_cents <= 0 or p_amount_cents > g.balance_cents then perform app.fail('INSUFFICIENT_BALANCE'); end if;
  update public.gift_cards set balance_cents = balance_cents - p_amount_cents,
         status = case when balance_cents - p_amount_cents = 0 then 'redeemed' else status end
   where id = g.id;
  insert into public.gift_card_transactions (gift_card_id, payment_id, amount_cents, created_by)
  values (g.id, p_payment_id, -p_amount_cents, auth.uid());
  return g.balance_cents - p_amount_cents;
end $$;

-- ===================== 20261007000013_analytics_crm.sql =====================
-- =============================================================================
-- Analytics, KPIs, CRM / retention, search, funnel tracking, periodic jobs.
-- Every number is computed from real rows. Nothing here invents data: when
-- there is nothing to measure the value is NULL and the UI shows an empty state.
-- =============================================================================

create or replace function app.mr_minutes(p tstzmultirange)
returns numeric language sql immutable as $$
  select coalesce(sum(extract(epoch from upper(r) - lower(r))) / 60.0, 0) from unnest(p) r
$$;

create or replace function app.pct(p_num numeric, p_den numeric)
returns numeric language sql immutable as $$
  select case when coalesce(p_den, 0) = 0 then null else round(100.0 * p_num / p_den, 1) end
$$;

-- Booking funnel (anonymous page analytics for conversion).
create table public.funnel_events (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  session_id text not null check (length(session_id) between 8 and 64),
  step text not null check (step in ('view', 'service', 'barber', 'time', 'details', 'booked')),
  created_at timestamptz not null default now()
);
create index funnel_events_shop_time on public.funnel_events (shop_id, created_at);
alter table public.funnel_events enable row level security;
revoke all on public.funnel_events from anon;
create policy funnel_read on public.funnel_events for select to authenticated using (app.can(shop_id, 'reports.shop'));

create or replace function public.track_booking_event(p_shop_id uuid, p_session_id text, p_step text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- one row per session+step per day keeps this cheap and spam-resistant
  if not exists (select 1 from public.funnel_events where shop_id = p_shop_id and session_id = p_session_id
                  and step = p_step and created_at > now() - interval '1 day') then
    insert into public.funnel_events (shop_id, session_id, step) values (p_shop_id, p_session_id, p_step);
  end if;
exception when others then
  null; -- analytics must never break booking
end $$;

-- ---------------------------------------------------------------------------
-- Client health (retention model)
-- ---------------------------------------------------------------------------
create or replace function app.client_health_rows(p_shop uuid)
returns table (client_id uuid, visits int, first_visit timestamptz, last_visit timestamptz, next_appointment timestamptz,
               avg_gap_days numeric, cadence_days int, days_since_last int, total_spent_cents bigint, avg_ticket_cents bigint,
               no_shows int, cancellations int, late_cancellations int, health text, is_due boolean,
               preferred_barber_id uuid, favorite_barber_id uuid, favorite_service text)
language sql stable security definer set search_path = public, pg_temp as $$
  with ss as (select default_visit_cadence_days d from public.shop_settings where shop_id = p_shop),
  appts as (
    select a.client_id, a.starts_at, a.status, a.is_late_cancellation, a.barber_id, a.id
      from public.appointments a
     where a.shop_id = p_shop and a.kind = 'appointment' and a.deleted_at is null and a.client_id is not null
  ),
  visits as (
    select client_id, starts_at, lag(starts_at) over (partition by client_id order by starts_at) prev
      from appts where status = 'COMPLETED'
  ),
  v as (
    select client_id, count(*)::int n, min(starts_at) first_v, max(starts_at) last_v,
           avg(extract(epoch from starts_at - prev) / 86400.0) filter (where prev is not null) gap
      from visits group by client_id
  ),
  money as (
    select p.client_id, sum(p.subtotal_cents - p.discount_cents) spent, count(*) tickets
      from public.payments p
     where p.shop_id = p_shop and p.kind = 'service' and p.status not in ('VOID')
     group by p.client_id
  ),
  fav_b as (
    select distinct on (client_id) client_id, barber_id from appts where status = 'COMPLETED'
     group by client_id, barber_id order by client_id, count(*) desc
  ),
  fav_s as (
    select distinct on (a.client_id) a.client_id, x.name
      from appts a join public.appointment_services x on x.appointment_id = a.id
     where a.status = 'COMPLETED'
     group by a.client_id, x.name order by a.client_id, count(*) desc
  )
  select c.id,
         coalesce(v.n, 0),
         v.first_v, v.last_v,
         (select min(a.starts_at) from appts a where a.client_id = c.id and a.status in ('BOOKED', 'CONFIRMED', 'CHECKED_IN') and a.starts_at > now()),
         round(v.gap::numeric, 1),
         x.cadence,
         case when v.last_v is not null then (extract(epoch from now() - v.last_v) / 86400)::int end,
         coalesce(m.spent, 0)::bigint,
         case when m.tickets > 0 then (m.spent / m.tickets)::bigint end,
         (select count(*) from appts a where a.client_id = c.id and a.status = 'NO_SHOW')::int,
         (select count(*) from appts a where a.client_id = c.id and a.status = 'CANCELLED')::int,
         (select count(*) from appts a where a.client_id = c.id and a.status = 'CANCELLED' and a.is_late_cancellation)::int,
         h.health,
         h.health in ('AT_RISK', 'LOST') or (v.n >= 1 and h.has_next = false and extract(epoch from now() - v.last_v) / 86400 > x.cadence),
         cp.preferred_barber_id,
         fb.barber_id,
         fs.name
    from public.clients c
    cross join ss
    left join v on v.client_id = c.id
    left join money m on m.client_id = c.id
    left join public.client_preferences cp on cp.client_id = c.id
    left join fav_b fb on fb.client_id = c.id
    left join fav_s fs on fs.client_id = c.id
    cross join lateral (
      select coalesce(cp.rebook_interval_days,
                      case when v.n >= 2 then greatest(7, round(v.gap))::int end,
                      ss.d) as cadence
    ) x
    cross join lateral (
      select exists (select 1 from appts a where a.client_id = c.id and a.status in ('BOOKED', 'CONFIRMED', 'CHECKED_IN') and a.starts_at > now()) as has_next
    ) nx
    cross join lateral (
      select nx.has_next,
             case
               when coalesce(v.n, 0) = 0 then 'NEW'
               when nx.has_next then case when v.n = 1 then 'NEW' else 'ACTIVE' end
               when v.n = 1 and extract(epoch from now() - v.last_v) / 86400 <= x.cadence * 1.5 then 'NEW'
               when extract(epoch from now() - v.last_v) / 86400 <= x.cadence * 1.25 then 'ACTIVE'
               when extract(epoch from now() - v.last_v) / 86400 <= x.cadence * 2.5 then 'AT_RISK'
               else 'LOST'
             end as health
    ) h
   where c.shop_id = p_shop and c.deleted_at is null and c.merged_into_id is null
$$;

-- CRM list (RLS-equivalent filtering: barbers only see their clients).
create or replace function public.list_clients(
  p_shop_id uuid, p_search text default null, p_health text default null, p_limit int default 50, p_offset int default 0,
  p_sort text default 'last_visit')
returns table (id uuid, first_name text, last_name text, phone text, email text, tags text[], visits int,
               last_visit timestamptz, next_appointment timestamptz, total_spent_cents bigint, avg_ticket_cents bigint,
               no_shows int, cancellations int, health text, is_due boolean, cadence_days int, days_since_last int,
               favorite_barber_id uuid, created_at timestamptz, total_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_all boolean := app.can(p_shop_id, 'clients.all'); v_money boolean := app.can(p_shop_id, 'payments.view');
begin
  if not app.is_staff(p_shop_id) then perform app.fail('FORBIDDEN'); end if;
  return query
    select c.id, c.first_name, c.last_name, c.phone, c.email::text, c.tags, h.visits, h.last_visit, h.next_appointment,
           case when v_money then h.total_spent_cents end, case when v_money then h.avg_ticket_cents end,
           h.no_shows, h.cancellations, h.health, h.is_due, h.cadence_days, h.days_since_last, h.favorite_barber_id,
           c.created_at, count(*) over ()
      from app.client_health_rows(p_shop_id) h
      join public.clients c on c.id = h.client_id
     where (v_all or exists (select 1 from public.appointments a where a.client_id = c.id and a.barber_id in (select app.my_barber_ids())))
       and (p_health is null or h.health = p_health or (p_health = 'DUE' and h.is_due))
       and (p_search is null or length(trim(p_search)) = 0
            or lower(c.first_name || ' ' || coalesce(c.last_name, '')) like '%' || lower(trim(p_search)) || '%'
            or c.email::text ilike '%' || trim(p_search) || '%'
            or c.phone_normalized like '%' || app.normalize_phone(p_search) || '%')
     order by case when p_sort = 'name' then lower(c.first_name || coalesce(c.last_name, '')) end,
              case when p_sort = 'spent' then h.total_spent_cents end desc nulls last,
              case when p_sort = 'visits' then h.visits end desc,
              h.last_visit desc nulls last, c.created_at desc
     limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0);
end $$;

create or replace function public.get_client_profile(p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.clients; v_money boolean; v_all_appts boolean; h record;
begin
  perform app.require_auth();
  select * into c from public.clients where id = p_client_id;
  if c.id is null or not app.can_access_client(c.id) then perform app.fail('FORBIDDEN'); end if;
  v_money := app.can(c.shop_id, 'payments.view');
  v_all_appts := app.can(c.shop_id, 'clients.all');
  select * into h from app.client_health_rows(c.shop_id) x where x.client_id = c.id;
  return jsonb_build_object(
    'client', to_jsonb(c) - 'referred_by_client_id',
    'stats', jsonb_build_object('visits', h.visits, 'first_visit', h.first_visit, 'last_visit', h.last_visit,
             'next_appointment', h.next_appointment, 'avg_gap_days', h.avg_gap_days, 'cadence_days', h.cadence_days,
             'days_since_last', h.days_since_last,
             'total_spent_cents', case when v_money then h.total_spent_cents end,
             'avg_ticket_cents', case when v_money then h.avg_ticket_cents end,
             'no_shows', h.no_shows, 'cancellations', h.cancellations, 'late_cancellations', h.late_cancellations,
             'health', h.health, 'is_due', h.is_due, 'favorite_service', h.favorite_service,
             'favorite_barber', (select display_name from public.barbers where id = h.favorite_barber_id),
             'loyalty_points', (select coalesce(sum(points), 0) from public.loyalty_ledger where client_id = c.id)),
    'preferences', (select to_jsonb(cp) from public.client_preferences cp where cp.client_id = c.id),
    'appointments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'starts_at', a.starts_at, 'status', a.status, 'barber_id', a.barber_id, 'barber_name', b.display_name,
        'services', (select string_agg(x.name, ' + ' order by x.position) from public.appointment_services x where x.appointment_id = a.id),
        'price_cents', case when v_money or app.is_my_barber(a.barber_id) then a.expected_price_cents end,
        'payment_status', a.payment_status, 'actual_duration_seconds', a.actual_duration_seconds, 'notes', a.notes)
        order by a.starts_at desc)
      from public.appointments a join public.barbers b on b.id = a.barber_id
     where a.client_id = c.id and a.kind = 'appointment' and a.deleted_at is null and a.status <> 'RESCHEDULED'
       and (v_all_appts or app.is_my_barber(a.barber_id))), '[]'),
    'notes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'body', n.body, 'visibility', n.visibility, 'is_pinned', n.is_pinned, 'created_at', n.created_at,
        'author_id', n.author_id, 'author_name', p.full_name, 'barber_name', b.display_name, 'mine', n.author_id = auth.uid())
        order by n.is_pinned desc, n.created_at desc)
      from public.client_notes n
      left join public.profiles p on p.id = n.author_id
      left join public.barbers b on b.id = n.barber_id
     where n.client_id = c.id and n.deleted_at is null
       and (n.author_id = auth.uid() or n.visibility = 'team' or app.can(c.shop_id, '*private_notes'))), '[]'),
    'memberships', coalesce((select jsonb_agg(jsonb_build_object('plan', mp.name, 'status', cm.status, 'visits_used', cm.visits_used,
        'included_visits', mp.included_visits, 'period_end', cm.current_period_end))
      from public.client_memberships cm join public.membership_plans mp on mp.id = cm.plan_id where cm.client_id = c.id), '[]')
  );
end $$;

-- Duplicate clients: merge `p_merge_id` into `p_keep_id`.
create or replace function public.merge_clients(p_keep_id uuid, p_merge_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare k public.clients; m public.clients;
begin
  select * into k from public.clients where id = p_keep_id;
  select * into m from public.clients where id = p_merge_id;
  if k.id is null or m.id is null or k.shop_id <> m.shop_id or k.id = m.id then perform app.fail('INVALID_MERGE'); end if;
  perform app.require(k.shop_id, 'clients.all');
  update public.appointments set client_id = k.id where client_id = m.id;
  update public.payments set client_id = k.id where client_id = m.id;
  update public.client_notes set client_id = k.id where client_id = m.id;
  update public.waitlist set client_id = k.id where client_id = m.id;
  update public.walk_ins set client_id = k.id where client_id = m.id;
  update public.reviews set client_id = k.id where client_id = m.id;
  update public.loyalty_ledger set client_id = k.id where client_id = m.id;
  update public.client_memberships set client_id = k.id where client_id = m.id;
  update public.notifications set client_id = k.id where client_id = m.id;
  update public.clients set merged_into_id = k.id, deleted_at = now() where id = m.id;
  update public.clients
     set phone = coalesce(k.phone, m.phone), email = coalesce(k.email, m.email), last_name = coalesce(k.last_name, m.last_name),
         birthday = coalesce(k.birthday, m.birthday), user_id = coalesce(k.user_id, m.user_id),
         tags = array(select distinct unnest(k.tags || m.tags))
   where id = k.id;
end $$;

-- ---------------------------------------------------------------------------
-- Core metrics for one period (used for current + comparison periods)
-- ---------------------------------------------------------------------------
create or replace function app.core_metrics(p_shop uuid, p_from timestamptz, p_to timestamptz, p_barber uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_net bigint; v_tickets int; v_tips bigint; v_refunds bigint;
  v_total int; v_completed int; v_cancelled int; v_noshow int;
  v_available numeric := 0; v_booked numeric := 0; b record; v_open tstzmultirange;
  v_rebooked int; v_new int; v_served int;
begin
  select coalesce(sum(subtotal_cents - discount_cents) filter (where kind = 'service'), 0),
         count(*) filter (where kind = 'service')
    into v_net, v_tickets
    from public.payments
   where shop_id = p_shop and paid_at >= p_from and paid_at < p_to and status <> 'VOID'
     and (p_barber is null or barber_id = p_barber);
  select coalesce(sum(r.amount_cents), 0) into v_refunds
    from public.refunds r join public.payments p on p.id = r.payment_id
   where p.shop_id = p_shop and r.created_at >= p_from and r.created_at < p_to and (p_barber is null or p.barber_id = p_barber);
  select coalesce(sum(amount_cents), 0) into v_tips from public.tips
   where shop_id = p_shop and created_at >= p_from and created_at < p_to and (p_barber is null or barber_id = p_barber);

  select count(*) filter (where status <> 'RESCHEDULED'),
         count(*) filter (where status = 'COMPLETED'),
         count(*) filter (where status = 'CANCELLED'),
         count(*) filter (where status = 'NO_SHOW')
    into v_total, v_completed, v_cancelled, v_noshow
    from public.appointments
   where shop_id = p_shop and kind = 'appointment' and deleted_at is null
     and starts_at >= p_from and starts_at < p_to and (p_barber is null or barber_id = p_barber);

  for b in select id from public.barbers where shop_id = p_shop and deleted_at is null and (p_barber is null or id = p_barber) loop
    v_open := app.barber_open_ranges(b.id, p_from, p_to);
    v_available := v_available + app.mr_minutes(v_open);
    v_booked := v_booked + app.mr_minutes(v_open * coalesce((
      select range_agg(tstzrange(a.starts_at, a.ends_at)) from public.appointments a
       where a.barber_id = b.id and a.kind = 'appointment' and a.deleted_at is null
         and a.status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
         and a.starts_at < p_to and a.ends_at > p_from), '{}'));
  end loop;

  select count(*) filter (where exists (
           select 1 from public.appointments n
            where n.client_id = a.client_id and n.id <> a.id and n.kind = 'appointment' and n.starts_at > a.starts_at
              and (n.rebooked_from_id = a.id
                   or n.created_at between a.starts_at - interval '30 minutes'
                                       and coalesce(a.actual_finished_at, a.completed_at, a.ends_at) + interval '24 hours'))),
         count(distinct a.client_id)
    into v_rebooked, v_served
    from public.appointments a
   where a.shop_id = p_shop and a.status = 'COMPLETED' and a.kind = 'appointment'
     and a.starts_at >= p_from and a.starts_at < p_to and (p_barber is null or a.barber_id = p_barber);

  select count(*) into v_new from (
    select a.client_id, min(a.starts_at) f from public.appointments a
     where a.shop_id = p_shop and a.status = 'COMPLETED' and a.kind = 'appointment' and a.client_id is not null
     group by a.client_id having min(a.starts_at) >= p_from and min(a.starts_at) < p_to) x
   where p_barber is null or exists (select 1 from public.appointments a2 where a2.client_id = x.client_id
                                      and a2.starts_at = x.f and a2.barber_id = p_barber);

  return jsonb_build_object(
    'net_revenue_cents', v_net - v_refunds, 'tickets', v_tickets, 'tips_cents', v_tips,
    'avg_ticket_cents', case when v_tickets > 0 then v_net / v_tickets end,
    'bookings', v_total, 'completed', v_completed, 'cancelled', v_cancelled, 'no_shows', v_noshow,
    'cancellation_rate', app.pct(v_cancelled, v_total), 'no_show_rate', app.pct(v_noshow, v_total),
    'available_minutes', round(v_available), 'booked_minutes', round(v_booked),
    'utilization', app.pct(v_booked, v_available),
    'rebooking_rate', app.pct(v_rebooked, v_completed), 'rebooked', v_rebooked,
    'clients_served', v_served, 'new_clients', v_new, 'returning_clients', greatest(v_served - v_new, 0));
end $$;

-- ---------------------------------------------------------------------------
-- Full analytics report for a date range (local dates, inclusive)
-- ---------------------------------------------------------------------------
create or replace function public.shop_analytics(p_shop_id uuid, p_from date, p_to date, p_barber_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_days int := (p_to - p_from) + 1;
  v_prev_from timestamptz;
  v_money_all boolean;
  v_result jsonb;
  v_core jsonb;
  v_prev jsonb;
  v_util jsonb;
  v_heat jsonb;
  b record;
  v_open tstzmultirange;
  v_booked tstzmultirange;
  v_blocked tstzmultirange;
  v_rows jsonb := '[]'::jsonb;
begin
  perform app.require_auth();
  if p_barber_id is null then
    perform app.require(p_shop_id, 'reports.shop');
  elsif not (app.can(p_shop_id, 'reports.shop') or app.is_my_barber(p_barber_id)) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_barber_id is not null and app.barber_shop(p_barber_id) <> p_shop_id then perform app.fail('BARBER_NOT_IN_SHOP'); end if;
  if v_days < 1 or v_days > 400 then perform app.fail('INVALID_RANGE'); end if;

  select timezone into v_tz from public.shops where id = p_shop_id;
  v_from := app.local_ts(p_from, '00:00', v_tz);
  v_to := app.local_ts(p_to + 1, '00:00', v_tz);
  v_prev_from := app.local_ts(p_from - v_days, '00:00', v_tz);
  v_money_all := app.can(p_shop_id, 'financials.all_barbers');

  v_core := app.core_metrics(p_shop_id, v_from, v_to, p_barber_id);
  v_prev := app.core_metrics(p_shop_id, v_prev_from, v_from, p_barber_id);

  -- Utilization per barber + heatmap of (weekday, hour) load.
  create temp table if not exists _util (barber_id uuid, open tstzmultirange, booked tstzmultirange, blocked tstzmultirange) on commit drop;
  truncate _util;
  for b in select id from public.barbers where shop_id = p_shop_id and deleted_at is null
            and (p_barber_id is null or id = p_barber_id) loop
    v_open := app.barber_open_ranges(b.id, v_from, v_to);
    select coalesce(range_agg(tstzrange(a.starts_at, a.ends_at)) filter (where a.kind = 'appointment'), '{}'),
           coalesce(range_agg(tstzrange(a.starts_at, a.ends_at)) filter (where a.kind <> 'appointment'), '{}')
      into v_booked, v_blocked
      from public.appointments a
     where a.barber_id = b.id and a.deleted_at is null and a.status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
       and a.starts_at < v_to and a.ends_at > v_from;
    insert into _util values (b.id, v_open, v_open * v_booked, (v_open * v_blocked) - v_booked);
  end loop;

  select jsonb_build_object(
           'available_minutes', round(sum(app.mr_minutes(open))),
           'booked_minutes', round(sum(app.mr_minutes(booked))),
           'blocked_minutes', round(sum(app.mr_minutes(blocked))),
           'idle_minutes', round(sum(app.mr_minutes(open) - app.mr_minutes(booked) - app.mr_minutes(blocked))),
           'utilization', app.pct(sum(app.mr_minutes(booked)), sum(app.mr_minutes(open))),
           'target', (select utilization_target_pct from public.shop_settings where shop_id = p_shop_id),
           'actual_service_minutes', (select round(coalesce(sum(actual_duration_seconds), 0) / 60.0)
                                        from public.appointments where shop_id = p_shop_id and status = 'COMPLETED'
                                         and starts_at >= v_from and starts_at < v_to and (p_barber_id is null or barber_id = p_barber_id)))
    into v_util from _util;

  with hours as (
    select tstzrange(app.local_ts(d::date, make_time(h, 0, 0), v_tz), app.local_ts(d::date, make_time(h, 0, 0), v_tz) + interval '1 hour') hr,
           extract(dow from d)::int dow, h
      from generate_series(p_from, p_to, interval '1 day') d, generate_series(0, 23) h
  ),
  cells as (
    select hours.dow, hours.h,
           sum((select coalesce(sum(extract(epoch from upper(x) - lower(x))), 0) from unnest(u.open * tstzmultirange(hours.hr)) x)) / 60.0 avail,
           sum((select coalesce(sum(extract(epoch from upper(x) - lower(x))), 0) from unnest(u.booked * tstzmultirange(hours.hr)) x)) / 60.0 booked
      from hours cross join _util u
     where u.open && hours.hr
     group by hours.dow, hours.h
  )
  select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'hour', h, 'available_minutes', round(avail), 'booked_minutes', round(booked),
                                               'utilization', app.pct(booked, avail)) order by dow, h), '[]')
    into v_heat from cells where avail > 0;

  -- Per-barber performance
      select coalesce(jsonb_agg(row order by (row ->> 'net_revenue_cents')::bigint desc nulls last), '[]') into v_rows from (
      select jsonb_build_object(
        'barber_id', br.id, 'name', br.display_name, 'color', br.color, 'photo_url', br.photo_url, 'status', br.status,
        'can_view_money', v_money_all or app.is_my_barber(br.id),
        'cuts', m.completed, 'bookings', m.total, 'no_shows', m.no_shows, 'cancelled', m.cancelled,
        'no_show_rate', app.pct(m.no_shows, m.total),
        'avg_cut_minutes', m.avg_cut, 'avg_scheduled_minutes', m.avg_sched,
        'clients_served', m.served, 'new_clients', m.new_clients, 'returning_clients', greatest(m.served - m.new_clients, 0),
        'rebooking_rate', app.pct(m.rebooked, m.completed),
        'utilization', app.pct(app.mr_minutes(u.booked), app.mr_minutes(u.open)),
        'available_hours', round(app.mr_minutes(u.open) / 60.0, 1),
        'net_revenue_cents', case when v_money_all or app.is_my_barber(br.id) then f.net end,
        'tips_cents', case when v_money_all or app.is_my_barber(br.id) then f.tips end,
        'avg_ticket_cents', case when (v_money_all or app.is_my_barber(br.id)) and f.tickets > 0 then f.net / f.tickets end,
        'commission_cents', case when v_money_all or app.is_my_barber(br.id) then f.commission end,
        'revenue_per_hour_cents', case when (v_money_all or app.is_my_barber(br.id)) and app.mr_minutes(u.open) > 0
                                       then round(f.net / (app.mr_minutes(u.open) / 60.0)) end,
        'revenue_per_day_cents', case when (v_money_all or app.is_my_barber(br.id)) and m.days_worked > 0 then f.net / m.days_worked end,
        'service_mix', m.mix) as row
      from public.barbers br
      join _util u on u.barber_id = br.id
      cross join lateral (
        select count(*) filter (where a.status <> 'RESCHEDULED') total,
               count(*) filter (where a.status = 'COMPLETED') completed,
               count(*) filter (where a.status = 'NO_SHOW') no_shows,
               count(*) filter (where a.status = 'CANCELLED') cancelled,
               round(avg(a.actual_duration_seconds) filter (where a.status = 'COMPLETED' and a.actual_duration_seconds >= 60) / 60.0, 1) avg_cut,
               round(avg(extract(epoch from a.ends_at - a.starts_at)) filter (where a.status = 'COMPLETED' and a.actual_duration_seconds >= 60) / 60.0, 1) avg_sched,
               count(distinct a.client_id) filter (where a.status = 'COMPLETED') served,
               count(distinct (a.starts_at at time zone v_tz)::date) filter (where a.status = 'COMPLETED') days_worked,
               count(*) filter (where a.status = 'COMPLETED' and exists (
                 select 1 from public.appointments n where n.client_id = a.client_id and n.id <> a.id and n.starts_at > a.starts_at
                   and n.kind = 'appointment'
                   and (n.rebooked_from_id = a.id or n.created_at between a.starts_at - interval '30 minutes'
                        and coalesce(a.actual_finished_at, a.completed_at, a.ends_at) + interval '24 hours'))) rebooked,
               (select count(*) from (select x.client_id from public.appointments x
                  where x.shop_id = p_shop_id and x.status = 'COMPLETED' and x.client_id is not null
                  group by x.client_id
                 having min(x.starts_at) >= v_from and min(x.starts_at) < v_to
                    and (array_agg(x.barber_id order by x.starts_at))[1] = br.id) nc) new_clients,
               (select coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'count', s.n) order by s.n desc), '[]') from (
                  select x.name, count(*) n from public.appointments a2 join public.appointment_services x on x.appointment_id = a2.id
                   where a2.barber_id = br.id and a2.status = 'COMPLETED' and a2.starts_at >= v_from and a2.starts_at < v_to
                   group by x.name order by n desc limit 6) s) mix
          from public.appointments a
         where a.barber_id = br.id and a.kind = 'appointment' and a.deleted_at is null
           and a.starts_at >= v_from and a.starts_at < v_to
      ) m
      cross join lateral (
        select coalesce(sum(e.service_revenue_cents), 0) net, coalesce(sum(e.commission_cents), 0) commission,
               coalesce(sum(e.tip_cents) , 0) tips_share,
               (select coalesce(sum(t.amount_cents), 0) from public.tips t where t.barber_id = br.id and t.created_at >= v_from and t.created_at < v_to) tips,
               (select count(*) from public.payments p where p.barber_id = br.id and p.kind = 'service' and p.status <> 'VOID'
                   and p.paid_at >= v_from and p.paid_at < v_to) tickets
          from public.barber_earnings e
         where e.barber_id = br.id and e.earned_at >= v_from and e.earned_at < v_to
      ) f
    ) t;

  v_result := jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days, 'timezone', v_tz,
                                 'currency', (select currency from public.shop_settings where shop_id = p_shop_id),
                                 'barber_id', p_barber_id),
    'summary', v_core,
    'previous', v_prev,
    'revenue', (
      select jsonb_build_object(
        'gross_cents', coalesce(sum(p.subtotal_cents) filter (where p.kind = 'service'), 0),
        'discount_cents', coalesce(sum(p.discount_cents), 0),
        'net_service_cents', coalesce(sum(p.subtotal_cents - p.discount_cents) filter (where p.kind = 'service'), 0),
        'fees_cents', coalesce(sum(p.subtotal_cents) filter (where p.kind in ('no_show_fee', 'late_cancel_fee')), 0),
        'gift_card_sales_cents', coalesce(sum(p.subtotal_cents) filter (where p.kind = 'gift_card'), 0),
        'tax_cents', coalesce(sum(p.tax_cents), 0),
        'tips_cents', (v_core ->> 'tips_cents')::bigint,
        'refunds_cents', (select coalesce(sum(r.amount_cents), 0) from public.refunds r join public.payments p2 on p2.id = r.payment_id
                           where p2.shop_id = p_shop_id and r.created_at >= v_from and r.created_at < v_to
                             and (p_barber_id is null or p2.barber_id = p_barber_id)),
        'collected_cents', coalesce(sum(p.amount_paid_cents), 0),
        'outstanding_cents', coalesce(sum(p.total_cents - p.amount_paid_cents) filter (where p.status in ('PARTIAL', 'UNPAID')), 0),
        'tickets', count(*) filter (where p.kind = 'service'),
        'commission_cents', (select coalesce(sum(e.commission_cents), 0) from public.barber_earnings e
                              where e.shop_id = p_shop_id and e.earned_at >= v_from and e.earned_at < v_to
                                and (p_barber_id is null or e.barber_id = p_barber_id)),
        'by_method', (select coalesce(jsonb_object_agg(method, cents), '{}') from (
                        select p3.method, sum(p3.amount_paid_cents) cents from public.payments p3
                         where p3.shop_id = p_shop_id and p3.paid_at >= v_from and p3.paid_at < v_to and p3.status <> 'VOID'
                           and (p_barber_id is null or p3.barber_id = p_barber_id) group by p3.method) mm),
        'by_service', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', n, 'revenue_cents', cents) order by cents desc), '[]') from (
                        select coalesce(s.name, pi.description) name, sum(pi.quantity) n, sum(pi.total_cents) cents
                          from public.payment_items pi join public.payments p4 on p4.id = pi.payment_id
                          left join public.services s on s.id = pi.service_id
                         where p4.shop_id = p_shop_id and p4.paid_at >= v_from and p4.paid_at < v_to and p4.status <> 'VOID'
                           and (p_barber_id is null or p4.barber_id = p_barber_id)
                         group by 1) sv),
        'unpaid_completed', (select count(*) from public.appointments a where a.shop_id = p_shop_id and a.status = 'COMPLETED'
                               and a.kind = 'appointment' and a.payment_status = 'UNPAID'
                               and a.starts_at >= v_from and a.starts_at < v_to and (p_barber_id is null or a.barber_id = p_barber_id)))
        from public.payments p
       where p.shop_id = p_shop_id and p.paid_at >= v_from and p.paid_at < v_to and p.status <> 'VOID'
         and (p_barber_id is null or p.barber_id = p_barber_id)),
    'bookings', (
      select jsonb_build_object(
        'total', count(*) filter (where status <> 'RESCHEDULED'),
        'completed', count(*) filter (where status = 'COMPLETED'),
        'cancelled', count(*) filter (where status = 'CANCELLED'),
        'late_cancellations', count(*) filter (where status = 'CANCELLED' and is_late_cancellation),
        'no_shows', count(*) filter (where status = 'NO_SHOW'),
        'rescheduled', count(*) filter (where status = 'RESCHEDULED'),
        'upcoming', count(*) filter (where status in ('BOOKED', 'CONFIRMED') and starts_at > now()),
        'walk_ins', count(*) filter (where source = 'walk_in' and status <> 'RESCHEDULED'),
        'online', count(*) filter (where source in ('online', 'rebook', 'waitlist') and status <> 'RESCHEDULED'),
        'staff', count(*) filter (where source in ('staff', 'phone') and status <> 'RESCHEDULED'),
        'from_waitlist', count(*) filter (where source = 'waitlist' and status <> 'RESCHEDULED'),
        'avg_lead_time_hours', round((avg(extract(epoch from starts_at - created_at)) filter (where source <> 'walk_in' and status <> 'RESCHEDULED') / 3600.0)::numeric, 1),
        'cancellation_rate', app.pct(count(*) filter (where status = 'CANCELLED'), count(*) filter (where status <> 'RESCHEDULED')),
        'no_show_rate', app.pct(count(*) filter (where status = 'NO_SHOW'), count(*) filter (where status <> 'RESCHEDULED')),
        'peak_hours', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'count', n) order by h), '[]') from (
                         select extract(hour from a.starts_at at time zone v_tz)::int h, count(*) n from public.appointments a
                          where a.shop_id = p_shop_id and a.kind = 'appointment' and a.deleted_at is null
                            and a.status not in ('CANCELLED', 'RESCHEDULED')
                            and a.starts_at >= v_from and a.starts_at < v_to and (p_barber_id is null or a.barber_id = p_barber_id)
                          group by 1) ph),
        'peak_days', (select coalesce(jsonb_agg(jsonb_build_object('dow', d, 'count', n) order by d), '[]') from (
                         select extract(dow from a.starts_at at time zone v_tz)::int d, count(*) n from public.appointments a
                          where a.shop_id = p_shop_id and a.kind = 'appointment' and a.deleted_at is null
                            and a.status not in ('CANCELLED', 'RESCHEDULED')
                            and a.starts_at >= v_from and a.starts_at < v_to and (p_barber_id is null or a.barber_id = p_barber_id)
                          group by 1) pd),
        'funnel', (select jsonb_object_agg(step, n) from (
                     select step, count(distinct session_id) n from public.funnel_events
                      where shop_id = p_shop_id and created_at >= v_from and created_at < v_to group by step) fe))
        from public.appointments
       where shop_id = p_shop_id and kind = 'appointment' and deleted_at is null
         and starts_at >= v_from and starts_at < v_to and (p_barber_id is null or barber_id = p_barber_id)),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'date', d::date,
               'revenue_cents', (select coalesce(sum(p.subtotal_cents - p.discount_cents), 0) from public.payments p
                                  where p.shop_id = p_shop_id and p.kind = 'service' and p.status <> 'VOID'
                                    and p.paid_at >= app.local_ts(d::date, '00:00', v_tz) and p.paid_at < app.local_ts(d::date + 1, '00:00', v_tz)
                                    and (p_barber_id is null or p.barber_id = p_barber_id)),
               'tips_cents', (select coalesce(sum(t.amount_cents), 0) from public.tips t
                               where t.shop_id = p_shop_id and t.created_at >= app.local_ts(d::date, '00:00', v_tz)
                                 and t.created_at < app.local_ts(d::date + 1, '00:00', v_tz) and (p_barber_id is null or t.barber_id = p_barber_id)),
               'bookings', (select count(*) from public.appointments a where a.shop_id = p_shop_id and a.kind = 'appointment'
                             and a.deleted_at is null and a.status not in ('CANCELLED', 'RESCHEDULED')
                             and a.starts_at >= app.local_ts(d::date, '00:00', v_tz) and a.starts_at < app.local_ts(d::date + 1, '00:00', v_tz)
                             and (p_barber_id is null or a.barber_id = p_barber_id)),
               'completed', (select count(*) from public.appointments a where a.shop_id = p_shop_id and a.status = 'COMPLETED'
                             and a.starts_at >= app.local_ts(d::date, '00:00', v_tz) and a.starts_at < app.local_ts(d::date + 1, '00:00', v_tz)
                             and (p_barber_id is null or a.barber_id = p_barber_id)),
               'new_clients', (select count(*) from (select a.client_id from public.appointments a
                                 where a.shop_id = p_shop_id and a.status = 'COMPLETED' and a.client_id is not null
                                   and (p_barber_id is null or a.barber_id = p_barber_id)
                                 group by a.client_id
                                having min(a.starts_at) >= app.local_ts(d::date, '00:00', v_tz)
                                   and min(a.starts_at) < app.local_ts(d::date + 1, '00:00', v_tz)) nc)
             ) order by d), '[]')
        from generate_series(p_from, p_to, interval '1 day') d),
    'cut_time', (
      with c as (
        select a.*, (a.actual_duration_seconds / 60.0) actual_min, extract(epoch from a.ends_at - a.starts_at) / 60.0 sched_min,
               (select x.name from public.appointment_services x where x.appointment_id = a.id order by x.position limit 1) svc,
               br.display_name bname
          from public.appointments a join public.barbers br on br.id = a.barber_id
         where a.shop_id = p_shop_id and a.status = 'COMPLETED' and a.actual_duration_seconds >= 60
           and a.starts_at >= v_from and a.starts_at < v_to and (p_barber_id is null or a.barber_id = p_barber_id)
      )
      select jsonb_build_object(
        'count', (select count(*) from c),
        'avg_actual_minutes', (select round(avg(actual_min), 1) from c),
        'avg_scheduled_minutes', (select round(avg(sched_min), 1) from c),
        'efficiency', (select app.pct(avg(sched_min), avg(actual_min)) from c),
        'finished_early', (select count(*) from c where actual_min < sched_min - 2),
        'ran_over', (select count(*) from c where actual_min > sched_min + 2),
        'by_barber', (select coalesce(jsonb_agg(jsonb_build_object('barber_id', barber_id, 'name', bname, 'avg_minutes', m, 'scheduled_minutes', s, 'count', n) order by m), '[]')
                        from (select barber_id, bname, round(avg(actual_min), 1) m, round(avg(sched_min), 1) s, count(*) n from c group by 1, 2) x),
        'by_service', (select coalesce(jsonb_agg(jsonb_build_object('name', svc, 'avg_minutes', m, 'scheduled_minutes', s, 'count', n) order by n desc), '[]')
                         from (select svc, round(avg(actual_min), 1) m, round(avg(sched_min), 1) s, count(*) n from c group by 1) x),
        'by_weekday', (select coalesce(jsonb_agg(jsonb_build_object('dow', d, 'avg_minutes', m, 'count', n) order by d), '[]')
                         from (select extract(dow from starts_at at time zone v_tz)::int d, round(avg(actual_min), 1) m, count(*) n from c group by 1) x),
        'by_hour', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'avg_minutes', m, 'count', n) order by h), '[]')
                      from (select extract(hour from actual_started_at at time zone v_tz)::int h, round(avg(actual_min), 1) m, count(*) n from c group by 1) x))),
    'utilization', v_util,
    'heatmap', v_heat,
    'barbers', v_rows,
    'clients', jsonb_build_object(
        'served', v_core -> 'clients_served', 'new', v_core -> 'new_clients', 'returning', v_core -> 'returning_clients',
        'rebooking_rate', v_core -> 'rebooking_rate',
        'health', (select coalesce(jsonb_object_agg(health, n), '{}') from (
                     select h.health, count(*) n from app.client_health_rows(p_shop_id) h
                      where p_barber_id is null or h.favorite_barber_id = p_barber_id group by 1) hh),
        'due', (select count(*) from app.client_health_rows(p_shop_id) h
                 where h.is_due and h.next_appointment is null and (p_barber_id is null or h.favorite_barber_id = p_barber_id))),
    'reviews', (
      select jsonb_build_object(
        'average', round(avg(coalesce(r.barber_rating, r.shop_rating))::numeric, 2),
        'count', count(*),
        'all_time_average', (select round(avg(coalesce(r2.barber_rating, r2.shop_rating))::numeric, 2) from public.reviews r2
                              where r2.shop_id = p_shop_id and r2.hidden_at is null and (p_barber_id is null or r2.barber_id = p_barber_id)),
        'distribution', (select coalesce(jsonb_object_agg(star, n), '{}') from (
                           select coalesce(r3.barber_rating, r3.shop_rating) star, count(*) n from public.reviews r3
                            where r3.shop_id = p_shop_id and r3.created_at >= v_from and r3.created_at < v_to
                              and (p_barber_id is null or r3.barber_id = p_barber_id) group by 1) dd),
        'trend', (select coalesce(jsonb_agg(jsonb_build_object('week', w, 'average', a, 'count', n) order by w), '[]') from (
                    select date_trunc('week', r4.created_at at time zone v_tz)::date w, round(avg(coalesce(r4.barber_rating, r4.shop_rating))::numeric, 2) a, count(*) n
                      from public.reviews r4 where r4.shop_id = p_shop_id and r4.created_at >= v_from and r4.created_at < v_to
                       and (p_barber_id is null or r4.barber_id = p_barber_id) group by 1) tt),
        'recent', (select coalesce(jsonb_agg(x), '[]') from (
                     select jsonb_build_object('id', r5.id, 'rating', coalesce(r5.barber_rating, r5.shop_rating), 'comment', r5.comment,
                                               'barber_name', bb.display_name, 'client_name', cc.first_name, 'created_at', r5.created_at,
                                               'owner_reply', r5.owner_reply, 'hidden', r5.hidden_at is not null) x
                       from public.reviews r5 left join public.barbers bb on bb.id = r5.barber_id left join public.clients cc on cc.id = r5.client_id
                      where r5.shop_id = p_shop_id and (p_barber_id is null or r5.barber_id = p_barber_id)
                      order by r5.created_at desc limit 8) rr))
        from public.reviews r
       where r.shop_id = p_shop_id and r.created_at >= v_from and r.created_at < v_to and r.hidden_at is null
         and (p_barber_id is null or r.barber_id = p_barber_id))
  );
  return v_result;
end $$;

-- Owner home "ACTIONS" panel.
create or replace function public.owner_actions(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_tz text; v_today date;
begin
  perform app.require(p_shop_id, 'reports.shop');
  select timezone into v_tz from public.shops where id = p_shop_id;
  v_today := (now() at time zone v_tz)::date;
  return jsonb_build_object(
    'follow_up_clients', (select count(*) from app.client_health_rows(p_shop_id) h where h.is_due and h.next_appointment is null and h.visits > 0),
    'at_risk_clients', (select count(*) from app.client_health_rows(p_shop_id) h where h.health = 'AT_RISK'),
    'waitlist_bookable', (select count(*) from public.waitlist w
                           where w.shop_id = p_shop_id and w.status = 'active' and w.desired_date between v_today and v_today + 1
                             and exists (select 1 from app.compute_slots(p_shop_id, array[w.service_id], w.barber_id,
                                           greatest(now(), app.local_ts(w.desired_date, w.time_from, v_tz)),
                                           app.local_ts(w.desired_date, w.time_to, v_tz), true))),
    'waitlist_active', (select count(*) from public.waitlist w where w.shop_id = p_shop_id and w.status in ('active', 'notified') and w.desired_date >= v_today),
    'unpaid_completed', (select count(*) from public.appointments a where a.shop_id = p_shop_id and a.status = 'COMPLETED'
                          and a.kind = 'appointment' and a.payment_status = 'UNPAID' and a.starts_at > now() - interval '14 days'),
    'stale_open_appointments', (select count(*) from public.appointments a where a.shop_id = p_shop_id and a.kind = 'appointment'
                                 and a.status in ('BOOKED', 'CONFIRMED', 'CHECKED_IN') and a.ends_at < now() - interval '1 hour'
                                 and a.starts_at > now() - interval '14 days' and a.deleted_at is null),
    'pending_fees', (select count(*) from public.appointments a where a.shop_id = p_shop_id and a.fee_cents > 0
                      and not exists (select 1 from public.payments p where p.appointment_id = a.id and p.kind in ('no_show_fee', 'late_cancel_fee'))),
    'walk_ins_waiting', (select count(*) from public.walk_ins w where w.shop_id = p_shop_id and w.status = 'waiting' and w.created_at > now() - interval '12 hours'),
    'under_capacity_barbers', (
      select coalesce(jsonb_agg(jsonb_build_object('barber_id', id, 'name', display_name, 'utilization', u, 'free_hours', fh)), '[]') from (
        select b.id, b.display_name,
               app.pct(app.mr_minutes(o.open * coalesce((select range_agg(tstzrange(a.starts_at, a.ends_at)) from public.appointments a
                          where a.barber_id = b.id and a.kind = 'appointment' and a.status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED') and a.deleted_at is null
                            and a.starts_at < app.local_ts(v_today + 1, '00:00', v_tz) and a.ends_at > app.local_ts(v_today, '00:00', v_tz)), '{}')),
                       app.mr_minutes(o.open)) u,
               round(app.mr_minutes(o.open) / 60.0, 1) fh
          from public.barbers b
          cross join lateral (select app.barber_open_ranges(b.id, app.local_ts(v_today, '00:00', v_tz), app.local_ts(v_today + 1, '00:00', v_tz)) open) o
         where b.shop_id = p_shop_id and b.status = 'active' and b.deleted_at is null) x
       where fh >= 2 and coalesce(u, 0) < 50),
    'unread_notifications', (select count(*) from public.notifications n where n.user_id = auth.uid() and n.channel = 'in_app' and n.read_at is null)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Global search (command palette). Runs as the caller so RLS applies.
-- ---------------------------------------------------------------------------
create or replace function public.global_search(p_shop_id uuid, p_query text)
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare q text := lower(trim(p_query)); v_phone text := app.normalize_phone(p_query);
begin
  if q is null or length(q) < 2 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(r) from (
    (select jsonb_build_object('type', 'client', 'id', c.id, 'title', trim(c.first_name || ' ' || coalesce(c.last_name, '')),
                               'subtitle', concat_ws(' · ', c.phone, c.email::text)) r
       from public.clients c
      where c.shop_id = p_shop_id and c.deleted_at is null and c.merged_into_id is null
        and (lower(c.first_name || ' ' || coalesce(c.last_name, '')) like '%' || q || '%'
             or c.email::text ilike '%' || q || '%'
             or (length(coalesce(v_phone, '')) >= 3 and c.phone_normalized like '%' || v_phone || '%'))
      limit 8)
    union all
    (select jsonb_build_object('type', 'barber', 'id', b.id, 'title', b.display_name, 'subtitle', coalesce(b.title, 'Barber'))
       from public.barbers b where b.shop_id = p_shop_id and b.deleted_at is null and lower(b.display_name) like '%' || q || '%' limit 5)
    union all
    (select jsonb_build_object('type', 'service', 'id', s.id, 'title', s.name, 'subtitle', (s.price_cents / 100.0)::text || ' · ' || s.duration_minutes || ' min')
       from public.services s where s.shop_id = p_shop_id and s.deleted_at is null and lower(s.name) like '%' || q || '%' limit 5)
    union all
    (select jsonb_build_object('type', 'appointment', 'id', a.id, 'title', trim(c.first_name || ' ' || coalesce(c.last_name, '')) || ' — ' || b.display_name,
                               'subtitle', a.status || ' · ' || app.fmt_when(a.starts_at, s.timezone), 'starts_at', a.starts_at)
       from public.appointments a join public.clients c on c.id = a.client_id join public.barbers b on b.id = a.barber_id
       join public.shops s on s.id = a.shop_id
      where a.shop_id = p_shop_id and a.deleted_at is null and a.status <> 'RESCHEDULED'
        and (lower(c.first_name || ' ' || coalesce(c.last_name, '')) like '%' || q || '%'
             or (length(coalesce(v_phone, '')) >= 3 and c.phone_normalized like '%' || v_phone || '%'))
      order by abs(extract(epoch from a.starts_at - now())) limit 6)
    union all
    (select jsonb_build_object('type', 'payment', 'id', p.id, 'title', 'Payment ' || upper(left(p.id::text, 8)),
                               'subtitle', to_char(p.total_cents / 100.0, 'FM999990.00') || ' · ' || p.method || ' · ' || p.status, 'appointment_id', p.appointment_id)
       from public.payments p where p.shop_id = p_shop_id and (p.id::text like q || '%' or to_char(p.total_cents / 100.0, 'FM999990.00') = q) limit 5)
  ) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Notification dispatch support (service_role only) + periodic jobs
-- ---------------------------------------------------------------------------
create or replace function public.claim_due_notifications(p_limit int default 50)
returns setof public.notifications language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'service_role') then
    perform app.fail('FORBIDDEN');
  end if;
  return query
    update public.notifications n set status = 'sending', attempts = attempts + 1
     where n.id in (select id from public.notifications
                     where status = 'queued' and scheduled_for <= now() and channel <> 'in_app'
                     order by scheduled_for limit p_limit for update skip locked)
    returning n.*;
end $$;

create or replace function public.complete_notification(p_id uuid, p_ok boolean, p_error text default null, p_provider_ref text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'service_role') then
    perform app.fail('FORBIDDEN');
  end if;
  update public.notifications
     set status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
         sent_at = case when p_ok then now() end, last_error = p_error, provider_ref = p_provider_ref,
         scheduled_for = case when p_ok then scheduled_for else now() + make_interval(mins => 5 * attempts) end
   where id = p_id;
end $$;

create or replace function public.notification_template(p_shop_id uuid, p_event text, p_channel public.notification_channel)
returns public.notification_templates language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.notification_templates
   where event = p_event and channel = p_channel and is_active and (shop_id = p_shop_id or shop_id is null)
   order by shop_id nulls last limit 1
$$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids))
$$;

-- Runs every few minutes from the dispatcher.
create or replace function public.run_periodic_jobs()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_expired int; v_old int; v_rebook int := 0; s record; h record; v_snap int := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'service_role') then
    perform app.fail('FORBIDDEN');
  end if;
  -- Waitlist: lapsed offers go back to the queue; past dates expire.
  update public.waitlist set status = 'active', offered_starts_at = null, offered_barber_id = null
   where status = 'notified' and offer_expires_at < now();
  get diagnostics v_expired = row_count;
  update public.waitlist w set status = 'expired'
    from public.shops sh
   where sh.id = w.shop_id and w.status in ('active', 'notified') and w.desired_date < (now() at time zone sh.timezone)::date;
  get diagnostics v_old = row_count;

  -- Rebooking reminders for opted-in clients who are due and have nothing booked.
  for s in select ss.shop_id from public.shop_settings ss join public.shops sh on sh.id = ss.shop_id
            where ss.rebooking_reminders_enabled and sh.deleted_at is null loop
    for h in select x.*, c.email, c.first_name from app.client_health_rows(s.shop_id) x join public.clients c on c.id = x.client_id
              where x.is_due and x.next_appointment is null and x.visits > 0 and c.email is not null and c.marketing_email_opt_in
                and x.days_since_last between x.cadence_days and x.cadence_days * 3 loop
      insert into public.notifications (shop_id, event, channel, audience, client_id, to_address, payload, dedupe_key)
      values (s.shop_id, 'rebooking.reminder', 'email', 'client', h.client_id, h.email::text,
              jsonb_build_object('client_first_name', h.first_name, 'days', h.days_since_last,
                                 'barber_name', coalesce((select display_name from public.barbers where id = h.favorite_barber_id), 'us'),
                                 'book_url', '/s/' || (select slug from public.shops where id = s.shop_id) || '/book',
                                 'shop_name', (select name from public.shops where id = s.shop_id)),
              'rebook:' || h.client_id || ':' || to_char(h.last_visit, 'YYYYMMDD'))
      on conflict (dedupe_key) do nothing;
      if found then v_rebook := v_rebook + 1; end if;
    end loop;
  end loop;

  -- Daily analytics snapshot for yesterday (fast long-range reporting).
  for s in select sh.id, sh.timezone from public.shops sh where sh.deleted_at is null loop
    insert into public.analytics_snapshots (shop_id, barber_id, day, metrics)
    select s.id, null, (now() at time zone s.timezone)::date - 1,
           app.core_metrics(s.id, app.local_ts((now() at time zone s.timezone)::date - 1, '00:00', s.timezone),
                            app.local_ts((now() at time zone s.timezone)::date, '00:00', s.timezone))
     where not exists (select 1 from public.analytics_snapshots x where x.shop_id = s.id and x.barber_id is null
                        and x.day = (now() at time zone s.timezone)::date - 1);
    if found then v_snap := v_snap + 1; end if;
  end loop;

  return jsonb_build_object('offers_expired', v_expired, 'waitlist_expired', v_old, 'rebooking_reminders', v_rebook, 'snapshots', v_snap);
end $$;

-- Lock down service-only functions.
revoke execute on function public.claim_due_notifications(int) from public, anon, authenticated;
revoke execute on function public.complete_notification(uuid, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.run_periodic_jobs() from public, anon, authenticated;
grant execute on function public.claim_due_notifications(int) to service_role;
grant execute on function public.complete_notification(uuid, boolean, text, text) to service_role;
grant execute on function public.run_periodic_jobs() to service_role;

-- ===================== 20261007000014_marketing_rpc.sql =====================
-- =============================================================================
-- Marketing RPCs: campaigns (win-back, birthday, book-again, promo), memberships
-- Campaigns only reach clients who opted in to marketing (consent), dedupe
-- per client per campaign, and go through the same notification outbox.
-- =============================================================================

create or replace function app.campaign_audience(p_shop uuid, p_audience jsonb)
returns table (client_id uuid, email text, first_name text, days_since int, favorite_barber uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.email::text, c.first_name, h.days_since_last, h.favorite_barber_id
    from app.client_health_rows(p_shop) h
    join public.clients c on c.id = h.client_id
   where c.email is not null and c.marketing_email_opt_in
     and (
       (p_audience ? 'health' and h.health = any (array(select jsonb_array_elements_text(p_audience -> 'health'))))
       or (coalesce((p_audience ->> 'due')::boolean, false) and h.is_due and h.next_appointment is null and h.visits > 0)
       or (coalesce((p_audience ->> 'birthday_month')::boolean, false) and extract(month from c.birthday) = extract(month from now()))
       or (coalesce((p_audience ->> 'all')::boolean, false))
     )
     and (not (p_audience ? 'min_days_away') or h.days_since_last >= (p_audience ->> 'min_days_away')::int)
$$;

create or replace function public.preview_campaign_audience(p_shop_id uuid, p_audience jsonb)
returns int language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require(p_shop_id, 'marketing.manage');
  return (select count(*) from app.campaign_audience(p_shop_id, p_audience));
end $$;

create or replace function public.send_campaign(p_campaign_id uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare cp public.campaigns; s public.shops; n int;
begin
  select * into cp from public.campaigns where id = p_campaign_id for update;
  if cp.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(cp.shop_id, 'marketing.manage');
  perform app.require_feature(cp.shop_id, 'marketing');
  select * into s from public.shops where id = cp.shop_id;
  insert into public.notifications (shop_id, event, channel, audience, client_id, to_address, payload, dedupe_key, scheduled_for)
  select cp.shop_id, 'campaign', cp.channel, 'client', a.client_id, a.email,
         jsonb_build_object('subject', cp.subject, 'body', cp.body, 'client_first_name', a.first_name, 'shop_name', s.name,
                            'days', a.days_since, 'book_url', '/s/' || s.slug || '/book',
                            'promo_code', (select code from public.promo_codes where id = cp.promo_code_id),
                            'barber_name', coalesce((select display_name from public.barbers where id = a.favorite_barber), s.name)),
         'campaign:' || cp.id || ':' || a.client_id, coalesce(cp.scheduled_for, now())
    from app.campaign_audience(cp.shop_id, cp.audience) a
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;
  update public.campaigns set status = 'sent', sent_count = sent_count + n where id = cp.id;
  return n;
end $$;

create or replace function public.assign_membership(p_client_id uuid, p_plan_id uuid, p_method public.payment_method default 'card')
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.clients; mp public.membership_plans; v_id uuid;
begin
  select * into c from public.clients where id = p_client_id;
  select * into mp from public.membership_plans where id = p_plan_id and shop_id = c.shop_id and is_active;
  if c.id is null or mp.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(c.shop_id, 'payments.record');
  insert into public.client_memberships (shop_id, client_id, plan_id, current_period_end)
  values (c.shop_id, c.id, mp.id, current_date + case mp.billing_interval when 'week' then 7 when 'year' then 365 else 30 end)
  returning id into v_id;
  insert into public.payments (shop_id, client_id, kind, subtotal_cents, total_cents, amount_paid_cents, method, status, provider, recorded_by)
  values (c.shop_id, c.id, 'membership', mp.price_cents, mp.price_cents, mp.price_cents, p_method, 'PAID', 'manual', auth.uid());
  return v_id;
end $$;

create or replace function public.update_client_membership(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.client_memberships;
begin
  select * into m from public.client_memberships where id = p_id;
  if m.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(m.shop_id, 'clients.all');
  if p_status not in ('active', 'paused', 'cancelled') then perform app.fail('INVALID_STATUS'); end if;
  update public.client_memberships set status = p_status, cancelled_at = case when p_status = 'cancelled' then now() end where id = p_id;
end $$;

insert into public.notification_templates (shop_id, event, channel, subject, body) values
  (null, 'campaign', 'email', '{{subject}}', '{{body}}'),
  (null, 'staff.invitation', 'email', 'You''re invited to join {{shop_name}} on BarberNGo', 'You''ve been invited to join {{shop_name}} as {{role}}. Accept here: {{invite_url}}');

-- ===================== 20261007000015_realtime.sql =====================
-- Live calendars: stream appointment and walk-in changes (RLS still applies
-- to Realtime subscribers). Guarded so the migration also runs on plain Postgres.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.appointments, public.walk_ins;
  end if;
end $$;

-- ===================== 20261007000016_chairs_inventory_finance.sql =====================
-- =============================================================================
-- BarberNGo — chairs, employee vs chair owner, chair rent, inventory,
-- expenses and finance.
--
--   SHOP → CHAIRS → BARBERS → CUSTOMERS → APPOINTMENTS → PAYMENTS → ANALYTICS
--
-- * A barber is either an EMPLOYEE (the shop controls schedule, services,
--   pricing and pays a commission) or a CHAIR OWNER (an independent business
--   inside the shop: keeps 100% of service revenue, controls own schedule,
--   services and prices, pays chair rent, runs own inventory and expenses).
-- * Chair owners' inventory and expenses are private to them. The shop owner
--   sees shop-level information: chairs, live status, appointments, rent.
-- * Stock only moves through RPCs, so stock_qty always equals the movement log.
-- =============================================================================

create type public.barber_type as enum ('employee', 'chair_owner');

alter table public.barbers
  add column barber_type public.barber_type not null default 'employee',
  -- Live presence set by the barber ("Take a break", "Go offline").
  -- 'auto' = status is derived from schedule + calendar.
  add column presence text not null default 'auto' check (presence in ('auto', 'break', 'offline')),
  add column presence_until timestamptz,
  add column presence_updated_at timestamptz;

alter table public.shop_settings
  add column product_commission_bps int not null default 1000 check (product_commission_bps between 0 and 10000),
  add column barbers_can_set_prices boolean not null default false,       -- employees editing their own prices
  add column employees_manage_schedule boolean not null default true,     -- employees editing their weekly hours
  add column sms_channel text not null default 'whatsapp' check (sms_channel in ('none', 'sms', 'whatsapp')),
  add column queue_almost_ready_minutes int not null default 10 check (queue_almost_ready_minutes between 2 and 60),
  add column rent_due_days int not null default 3 check (rent_due_days between 0 and 31);

-- Services a chair owner created for themselves (NULL = shop service).
alter table public.services add column owner_barber_id uuid references public.barbers (id) on delete cascade;
create index services_owner_barber on public.services (owner_barber_id) where owner_barber_id is not null;

-- ---------------------------------------------------------------------------
-- Chairs
-- ---------------------------------------------------------------------------
create table public.chairs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 40),
  position int not null default 0,
  barber_id uuid references public.barbers (id) on delete set null,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index chairs_barber_unique on public.chairs (barber_id) where barber_id is not null;
create unique index chairs_shop_label on public.chairs (shop_id, lower(label));
create index chairs_shop on public.chairs (shop_id, position);
create trigger chairs_touch before update on public.chairs for each row execute function app.touch_updated_at();

create or replace function app.chairs_check_tenant()
returns trigger language plpgsql as $$
begin
  if new.barber_id is not null and app.barber_shop(new.barber_id) is distinct from new.shop_id then
    perform app.fail('BARBER_NOT_IN_SHOP');
  end if;
  return new;
end $$;
create trigger chairs_check_tenant before insert or update of barber_id, shop_id on public.chairs
  for each row execute function app.chairs_check_tenant();

-- ---------------------------------------------------------------------------
-- Chair rent ledger (chair owners / hybrid barbers)
-- ---------------------------------------------------------------------------
create table public.rent_charges (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid not null references public.barbers (id) on delete cascade,
  chair_id uuid references public.chairs (id) on delete set null,
  period text not null check (period in ('week', 'month')),
  period_start date not null,
  period_end date not null,
  due_date date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  paid_cents bigint not null default 0 check (paid_cents >= 0),
  waived boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (barber_id, period_start, period),
  check (period_end >= period_start)
);
create index rent_charges_shop on public.rent_charges (shop_id, period_start desc);
create trigger rent_charges_touch before update on public.rent_charges for each row execute function app.touch_updated_at();

create table public.rent_payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  rent_charge_id uuid not null references public.rent_charges (id) on delete cascade,
  barber_id uuid not null references public.barbers (id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  method public.payment_method not null default 'cash',
  note text,
  recorded_by uuid references auth.users (id),
  paid_at timestamptz not null default now()
);
create index rent_payments_shop on public.rent_payments (shop_id, paid_at);
create index rent_payments_barber on public.rent_payments (barber_id, paid_at);

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  owner_barber_id uuid references public.barbers (id) on delete cascade, -- NULL = shop inventory
  name text not null check (length(trim(name)) between 1 and 120),
  brand text,
  sku text,
  category text,
  -- retail: sold to clients · backbar: used during services (blades, wax, neck strips)
  kind text not null default 'retail' check (kind in ('retail', 'backbar')),
  unit text not null default 'unit',
  cost_cents bigint not null default 0 check (cost_cents >= 0),
  price_cents bigint not null default 0 check (price_cents >= 0),
  stock_qty int not null default 0,
  low_stock_at int not null default 2 check (low_stock_at >= 0),
  supplier text,
  photo_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index products_shop on public.products (shop_id) where deleted_at is null;
create index products_owner on public.products (owner_barber_id) where owner_barber_id is not null;
create unique index products_sku on public.products (shop_id, coalesce(owner_barber_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(sku))
  where sku is not null and deleted_at is null;
create trigger products_touch before update on public.products for each row execute function app.touch_updated_at();

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  owner_barber_id uuid references public.barbers (id) on delete cascade, -- denormalised from the product (privacy)
  barber_id uuid references public.barbers (id) on delete set null,      -- who sold / used it
  kind text not null check (kind in ('purchase', 'sale', 'use', 'adjustment', 'waste', 'return', 'count')),
  qty_delta int not null,
  stock_after int not null,
  unit_cost_cents bigint,
  unit_price_cents bigint,
  payment_id uuid references public.payments (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index inventory_movements_product on public.inventory_movements (product_id, created_at desc);
create index inventory_movements_shop on public.inventory_movements (shop_id, created_at);

alter table public.payment_items add column product_id uuid references public.products (id) on delete set null;

-- Product sales in the earnings ledger. product_revenue_cents = net sale value,
-- product_cents = the barber's share (100% of their own products, a
-- commission on shop products).
alter table public.barber_earnings
  add column product_revenue_cents bigint not null default 0,
  add column product_cents bigint not null default 0;
alter table public.barber_earnings drop constraint barber_earnings_kind_check;
alter table public.barber_earnings add constraint barber_earnings_kind_check
  check (kind in ('service', 'tip', 'adjustment', 'rent', 'refund', 'product', 'product_own'));

-- ---------------------------------------------------------------------------
-- Expenses (shop or a chair owner's own business)
-- ---------------------------------------------------------------------------
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid references public.barbers (id) on delete cascade, -- NULL = shop expense
  category text not null check (category in (
    'rent', 'utilities', 'supplies', 'products', 'equipment', 'payroll', 'marketing', 'software', 'fees', 'taxes',
    'maintenance', 'education', 'transport', 'other')),
  amount_cents bigint not null check (amount_cents > 0),
  spent_on date not null,
  vendor text,
  note text,
  method public.payment_method not null default 'cash',
  receipt_url text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index expenses_shop on public.expenses (shop_id, spent_on) where deleted_at is null;
create index expenses_barber on public.expenses (barber_id, spent_on) where barber_id is not null and deleted_at is null;
create trigger expenses_touch before update on public.expenses for each row execute function app.touch_updated_at();

create or replace function app.expenses_check_tenant()
returns trigger language plpgsql as $$
begin
  if new.barber_id is not null and app.barber_shop(new.barber_id) is distinct from new.shop_id then
    perform app.fail('BARBER_NOT_IN_SHOP');
  end if;
  return new;
end $$;
create trigger expenses_check_tenant before insert or update of barber_id, shop_id on public.expenses
  for each row execute function app.expenses_check_tenant();

-- ---------------------------------------------------------------------------
-- Permissions: inventory + finance
-- ---------------------------------------------------------------------------
create or replace function app.role_grants(p_role public.staff_role)
returns text[] language sql immutable as $$
  select case p_role
    when 'owner' then array['*']
    when 'manager' then array[
      'shop.view', 'shop.settings', 'staff.manage', 'services.manage', 'schedule.manage_all',
      'calendar.all', 'clients.all', 'payments.view', 'payments.record', 'payments.refund',
      'reports.shop', 'marketing.manage', 'walkins.manage', 'waitlist.manage', 'reviews.manage',
      'notifications.view', 'inventory.manage']
    when 'receptionist' then array[
      'shop.view', 'calendar.all', 'clients.all', 'payments.view', 'payments.record',
      'walkins.manage', 'waitlist.manage', 'inventory.sell']
    when 'barber' then array[
      'shop.view', 'calendar.own', 'clients.own', 'payments.record_own', 'walkins.serve', 'inventory.sell']
  end
$$;

create or replace function app.is_chair_owner(p_barber uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.barbers where id = p_barber and barber_type = 'chair_owner')
$$;

-- Product visibility: shop inventory → shop staff; a chair owner's inventory → that chair owner only.
create or replace function app.can_see_product(p_shop uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_owner is null then app.is_staff(p_shop) else app.is_my_barber(p_owner) end
$$;

create or replace function app.can_manage_product(p_shop uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_owner is null then app.can(p_shop, 'inventory.manage') else app.is_my_barber(p_owner) end
$$;

-- Employees edit their own weekly hours only if the shop allows it.
create or replace function app.can_edit_schedule(p_barber uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select app.can(app.barber_shop(p_barber), 'schedule.manage_all')
      or (app.is_my_barber(p_barber)
          and (app.is_chair_owner(p_barber)
               or coalesce((select employees_manage_schedule from public.shop_settings where shop_id = app.barber_shop(p_barber)), true)))
$$;

drop policy availability_write on public.availability;
create policy availability_write on public.availability for all to authenticated
  using (app.can_edit_schedule(barber_id)) with check (app.can_edit_schedule(barber_id));

create or replace function public.set_weekly_schedule(p_barber_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_auth();
  if not app.can_edit_schedule(p_barber_id) then
    perform app.fail('FORBIDDEN', 'Your shop manages your schedule');
  end if;
  delete from public.availability where barber_id = p_barber_id;
  insert into public.availability (barber_id, weekday, starts_at, ends_at, kind, label)
  select p_barber_id, (r ->> 'weekday')::smallint, (r ->> 'starts_at')::time, (r ->> 'ends_at')::time,
         coalesce(r ->> 'kind', 'work'), r ->> 'label'
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
end $$;

-- Barbers may only pick shop services or their own private services.
create or replace function public.set_barber_services(p_barber_id uuid, p_service_ids uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id);
begin
  perform app.require_auth();
  if not (app.is_my_barber(p_barber_id) or app.can(v_shop, 'staff.manage') or app.can(v_shop, 'services.manage')) then
    perform app.fail('FORBIDDEN');
  end if;
  if exists (select 1 from unnest(p_service_ids) sid where not exists
             (select 1 from public.services s where s.id = sid and s.shop_id = v_shop
                 and (s.owner_barber_id is null or s.owner_barber_id = p_barber_id))) then
    perform app.fail('SERVICE_NOT_IN_SHOP');
  end if;
  update public.barber_services set is_active = (service_id = any (p_service_ids)) where barber_id = p_barber_id;
  insert into public.barber_services (barber_id, service_id)
  select p_barber_id, sid from unnest(p_service_ids) sid
  on conflict (barber_id, service_id) do update set is_active = true;
end $$;

-- A chair owner (or an employee when the shop allows it) sets their own price/duration.
create or replace function public.set_my_service_price(
  p_barber_id uuid, p_service_id uuid, p_price_cents bigint, p_duration_minutes int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id);
begin
  perform app.require_auth();
  if not (app.can(v_shop, 'staff.manage') or app.can(v_shop, 'services.manage')
          or (app.is_my_barber(p_barber_id)
              and (app.is_chair_owner(p_barber_id)
                   or (select barbers_can_set_prices from public.shop_settings where shop_id = v_shop)))) then
    perform app.fail('FORBIDDEN', 'Your shop sets your prices');
  end if;
  if p_price_cents is not null and p_price_cents < 0 then perform app.fail('INVALID_AMOUNT'); end if;
  if not exists (select 1 from public.services s where s.id = p_service_id and s.shop_id = v_shop
                    and (s.owner_barber_id is null or s.owner_barber_id = p_barber_id)) then
    perform app.fail('SERVICE_NOT_IN_SHOP');
  end if;
  insert into public.barber_services (barber_id, service_id, price_cents, duration_minutes, is_active)
  values (p_barber_id, p_service_id, p_price_cents, p_duration_minutes, true)
  on conflict (barber_id, service_id) do update
    set price_cents = excluded.price_cents, duration_minutes = excluded.duration_minutes, is_active = true;
end $$;

-- A chair owner creates / edits a service that only they offer.
create or replace function public.save_my_service(
  p_barber_id uuid, p_service_id uuid, p_name text, p_price_cents bigint, p_duration_minutes int,
  p_description text default null, p_is_public boolean default true, p_is_active boolean default true)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id); v_id uuid := p_service_id;
begin
  perform app.require_auth();
  if not ((app.is_my_barber(p_barber_id) and app.is_chair_owner(p_barber_id)) or app.can(v_shop, 'services.manage')) then
    perform app.fail('FORBIDDEN', 'Only chair owners create their own services');
  end if;
  if v_id is null then
    insert into public.services (shop_id, owner_barber_id, name, description, price_cents, duration_minutes, is_public, is_active)
    values (v_shop, p_barber_id, trim(p_name), p_description, p_price_cents, p_duration_minutes,
            coalesce(p_is_public, true), coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.services
       set name = trim(p_name), description = p_description, price_cents = p_price_cents, duration_minutes = p_duration_minutes,
           is_public = coalesce(p_is_public, true), is_active = coalesce(p_is_active, true)
     where id = v_id and owner_barber_id = p_barber_id;
    if not found then perform app.fail('NOT_FOUND'); end if;
  end if;
  insert into public.barber_services (barber_id, service_id, is_active) values (p_barber_id, v_id, coalesce(p_is_active, true))
  on conflict (barber_id, service_id) do update set is_active = excluded.is_active, price_cents = null, duration_minutes = null;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Chairs & barber type RPCs
-- ---------------------------------------------------------------------------
-- Employee ⇄ chair owner. Chair owners get a booth-rental plan (keep 100%,
-- pay rent); employees get a commission plan.
create or replace function public.set_barber_type(
  p_barber_id uuid, p_type public.barber_type,
  p_rent_cents bigint default null, p_rent_period text default 'week', p_percent_bps int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id); v_current public.commissions;
begin
  perform app.require(v_shop, 'staff.manage');
  perform app.require(v_shop, 'commissions.manage');
  update public.barbers set barber_type = p_type where id = p_barber_id;
  v_current := app.commission_rule(p_barber_id, now());
  if p_type = 'chair_owner' then
    if p_rent_cents is null or p_rent_cents < 0 then perform app.fail('RENT_REQUIRED'); end if;
    perform public.set_commission(p_barber_id, 'booth_rental', null, null, null, p_rent_cents,
                                  coalesce(p_rent_period, 'week'), 10000);
  else
    perform public.set_commission(p_barber_id, 'percentage',
      coalesce(p_percent_bps, case when v_current.type in ('percentage', 'hybrid') then v_current.percent_bps end, 5000),
      null, null, null, null, coalesce(v_current.tip_share_bps, 10000));
  end if;
end $$;

create or replace function public.save_chair(
  p_shop_id uuid, p_chair_id uuid, p_label text, p_barber_id uuid default null,
  p_is_active boolean default true, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := p_chair_id;
begin
  perform app.require(p_shop_id, 'staff.manage');
  -- A barber sits in one chair: moving them frees the old one.
  if p_barber_id is not null then
    update public.chairs set barber_id = null where barber_id = p_barber_id and id is distinct from v_id;
  end if;
  if v_id is null then
    insert into public.chairs (shop_id, label, barber_id, is_active, notes, position)
    values (p_shop_id, trim(p_label), p_barber_id, coalesce(p_is_active, true), p_notes,
            coalesce((select max(position) + 1 from public.chairs where shop_id = p_shop_id), 1))
    returning id into v_id;
  else
    update public.chairs set label = trim(p_label), barber_id = p_barber_id, is_active = coalesce(p_is_active, true), notes = p_notes
     where id = v_id and shop_id = p_shop_id;
    if not found then perform app.fail('NOT_FOUND'); end if;
  end if;
  return v_id;
exception when unique_violation then
  perform app.fail('CHAIR_LABEL_TAKEN');
end $$;

create or replace function public.delete_chair(p_chair_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid;
begin
  select shop_id into v_shop from public.chairs where id = p_chair_id;
  perform app.require(v_shop, 'staff.manage');
  delete from public.chairs where id = p_chair_id;
end $$;

-- ---------------------------------------------------------------------------
-- Rent: charges are generated from the barber's commission plan
-- (booth_rental / hybrid with rent_cents) for each week / month.
-- ---------------------------------------------------------------------------
create or replace function app.sync_rent_charges(p_shop uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text; v_today date; v_due_days int; b record; d date; c public.commissions; v_n int := 0; v_start date;
begin
  select s.timezone, ss.rent_due_days into v_tz, v_due_days
    from public.shops s join public.shop_settings ss on ss.shop_id = s.id where s.id = p_shop;
  v_today := (now() at time zone v_tz)::date;
  for b in
    select br.id, br.created_at, (select ch.id from public.chairs ch where ch.barber_id = br.id) chair_id,
           (select min(cm.effective_from) from public.commissions cm
             where cm.barber_id = br.id and cm.type in ('booth_rental', 'hybrid') and coalesce(cm.rent_cents, 0) > 0) first_rent
      from public.barbers br
     where br.shop_id = p_shop and br.deleted_at is null and br.status <> 'archived'
  loop
    continue when b.first_rent is null;
    v_start := greatest(b.first_rent, v_today - 366);
    -- Candidate period starts: every Monday and every 1st of the month.
    for d in
      select x::date from generate_series(date_trunc('week', v_start)::date, v_today, interval '1 week') x
      union
      select x::date from generate_series(date_trunc('month', v_start)::date, v_today, interval '1 month') x
    loop
      c := app.commission_rule(b.id, app.local_ts(greatest(d, b.first_rent), '12:00', v_tz));
      continue when c.id is null or c.type not in ('booth_rental', 'hybrid') or coalesce(c.rent_cents, 0) <= 0;
      continue when (c.rent_period = 'week' and extract(isodow from d) <> 1)
                 or (c.rent_period = 'month' and extract(day from d) <> 1);
      insert into public.rent_charges (shop_id, barber_id, chair_id, period, period_start, period_end, due_date, amount_cents)
      values (p_shop, b.id, b.chair_id, c.rent_period, d,
              case when c.rent_period = 'week' then d + 6 else (d + interval '1 month')::date - 1 end,
              d + v_due_days, c.rent_cents)
      on conflict (barber_id, period_start, period) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end loop;
  return v_n;
end $$;

create or replace function app.rent_status(r public.rent_charges, p_today date)
returns text language sql immutable as $$
  select case when r.waived then 'waived'
              when r.paid_cents >= r.amount_cents then 'paid'
              when r.due_date < p_today then 'overdue'
              when r.paid_cents > 0 then 'partial'
              else 'due' end
$$;

-- Rent ledger for the shop (finance.manage) or for one barber (that barber).
create or replace function public.rent_ledger(p_shop_id uuid, p_barber_id uuid default null)
returns table (id uuid, barber_id uuid, barber_name text, chair_label text, period text, period_start date, period_end date,
               due_date date, amount_cents bigint, paid_cents bigint, balance_cents bigint, status text, waived boolean, note text)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_today date;
begin
  perform app.require_auth();
  if not (app.can(p_shop_id, 'finance.manage') or (p_barber_id is not null and app.is_my_barber(p_barber_id)
          and app.barber_shop(p_barber_id) = p_shop_id)) then
    perform app.fail('FORBIDDEN');
  end if;
  perform app.sync_rent_charges(p_shop_id);
  select (now() at time zone timezone)::date into v_today from public.shops where id = p_shop_id;
  return query
    select r.id, r.barber_id, b.display_name, ch.label, r.period, r.period_start, r.period_end, r.due_date,
           r.amount_cents, r.paid_cents, case when r.waived then 0 else greatest(r.amount_cents - r.paid_cents, 0) end,
           app.rent_status(r, v_today), r.waived, r.note
      from public.rent_charges r
      join public.barbers b on b.id = r.barber_id
      left join public.chairs ch on ch.id = r.chair_id
     where r.shop_id = p_shop_id and (p_barber_id is null or r.barber_id = p_barber_id)
     order by r.period_start desc, b.display_name;
end $$;

-- The shop records rent it received (cash, transfer…). Overpayment is refused.
create or replace function public.record_rent_payment(
  p_charge_id uuid, p_amount_cents bigint, p_method public.payment_method default 'cash', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rent_charges;
begin
  select * into r from public.rent_charges where id = p_charge_id for update;
  if r.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(r.shop_id, 'finance.manage');
  if p_amount_cents is null or p_amount_cents <= 0 or r.paid_cents + p_amount_cents > r.amount_cents then
    perform app.fail('INVALID_AMOUNT');
  end if;
  insert into public.rent_payments (shop_id, rent_charge_id, barber_id, amount_cents, method, note, recorded_by)
  values (r.shop_id, r.id, r.barber_id, p_amount_cents, coalesce(p_method, 'cash'), p_note, auth.uid());
  update public.rent_charges set paid_cents = paid_cents + p_amount_cents where id = r.id returning * into r;
  return jsonb_build_object('paid_cents', r.paid_cents, 'balance_cents', r.amount_cents - r.paid_cents);
end $$;

create or replace function public.set_rent_charge(p_charge_id uuid, p_waived boolean default null,
                                                  p_amount_cents bigint default null, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rent_charges;
begin
  select * into r from public.rent_charges where id = p_charge_id for update;
  if r.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(r.shop_id, 'finance.manage');
  if p_amount_cents is not null and (p_amount_cents < r.paid_cents or p_amount_cents < 0) then perform app.fail('INVALID_AMOUNT'); end if;
  update public.rent_charges
     set waived = coalesce(p_waived, waived), amount_cents = coalesce(p_amount_cents, amount_cents), note = coalesce(p_note, note)
   where id = r.id;
end $$;

-- ---------------------------------------------------------------------------
-- Inventory RPCs
-- ---------------------------------------------------------------------------
create or replace function public.save_product(
  p_shop_id uuid, p_product_id uuid, p_name text,
  p_owner_barber_id uuid default null, p_kind text default 'retail', p_brand text default null, p_sku text default null,
  p_category text default null, p_cost_cents bigint default 0, p_price_cents bigint default 0, p_low_stock_at int default 2,
  p_supplier text default null, p_unit text default 'unit', p_is_active boolean default true, p_initial_qty int default 0)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := p_product_id; p public.products;
begin
  perform app.require_auth();
  if p_owner_barber_id is not null and app.barber_shop(p_owner_barber_id) is distinct from p_shop_id then
    perform app.fail('BARBER_NOT_IN_SHOP');
  end if;
  if v_id is null then
    if not app.can_manage_product(p_shop_id, p_owner_barber_id) then perform app.fail('FORBIDDEN'); end if;
    insert into public.products (shop_id, owner_barber_id, name, brand, sku, category, kind, unit, cost_cents, price_cents,
                                 low_stock_at, supplier, is_active)
    values (p_shop_id, p_owner_barber_id, trim(p_name), nullif(trim(p_brand), ''), nullif(trim(p_sku), ''), nullif(trim(p_category), ''),
            coalesce(p_kind, 'retail'), coalesce(nullif(trim(p_unit), ''), 'unit'), coalesce(p_cost_cents, 0), coalesce(p_price_cents, 0),
            coalesce(p_low_stock_at, 2), nullif(trim(p_supplier), ''), coalesce(p_is_active, true))
    returning id into v_id;
    if coalesce(p_initial_qty, 0) > 0 then
      perform public.move_stock(v_id, 'purchase', p_initial_qty, p_cost_cents, 'Opening stock');
    end if;
  else
    select * into p from public.products where id = v_id and deleted_at is null;
    if p.id is null or p.shop_id <> p_shop_id then perform app.fail('NOT_FOUND'); end if;
    if not app.can_manage_product(p.shop_id, p.owner_barber_id) then perform app.fail('FORBIDDEN'); end if;
    update public.products
       set name = trim(p_name), brand = nullif(trim(p_brand), ''), sku = nullif(trim(p_sku), ''), category = nullif(trim(p_category), ''),
           kind = coalesce(p_kind, kind), unit = coalesce(nullif(trim(p_unit), ''), unit), cost_cents = coalesce(p_cost_cents, cost_cents),
           price_cents = coalesce(p_price_cents, price_cents), low_stock_at = coalesce(p_low_stock_at, low_stock_at),
           supplier = nullif(trim(p_supplier), ''), is_active = coalesce(p_is_active, is_active)
     where id = v_id;
  end if;
  return v_id;
exception when unique_violation then
  perform app.fail('SKU_TAKEN');
end $$;

create or replace function public.archive_product(p_product_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.products;
begin
  select * into p from public.products where id = p_product_id;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  if not app.can_manage_product(p.shop_id, p.owner_barber_id) then perform app.fail('FORBIDDEN'); end if;
  update public.products set deleted_at = now(), is_active = false where id = p.id;
end $$;

-- Move stock. purchase (+, updates unit cost) · use / waste (−) · return (+) ·
-- adjustment (±) · count (sets the absolute quantity after a physical count).
-- Any barber may log 'use' of shop back-bar products.
create or replace function public.move_stock(
  p_product_id uuid, p_kind text, p_qty int, p_unit_cost_cents bigint default null, p_note text default null,
  p_appointment_id uuid default null)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.products; v_delta int; v_after int; v_me uuid;
begin
  perform app.require_auth();
  select * into p from public.products where id = p_product_id and deleted_at is null for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  if not (app.can_manage_product(p.shop_id, p.owner_barber_id)
          or (p_kind = 'use' and p.owner_barber_id is null and app.is_staff(p.shop_id))) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_qty is null or (p_kind <> 'adjustment' and p_kind <> 'count' and p_qty <= 0) or (p_kind = 'count' and p_qty < 0) then
    perform app.fail('INVALID_QUANTITY');
  end if;
  v_delta := case p_kind
               when 'purchase' then p_qty when 'return' then p_qty
               when 'use' then -p_qty when 'waste' then -p_qty
               when 'adjustment' then p_qty
               when 'count' then p_qty - p.stock_qty
             end;
  if v_delta is null then perform app.fail('INVALID_KIND'); end if;
  if p.stock_qty + v_delta < 0 then perform app.fail('OUT_OF_STOCK', p.name || ': ' || p.stock_qty || ' left'); end if;
  update public.products
     set stock_qty = stock_qty + v_delta,
         cost_cents = case when p_kind = 'purchase' and p_unit_cost_cents is not null then p_unit_cost_cents else cost_cents end
   where id = p.id returning stock_qty into v_after;
  select b.id into v_me from public.barbers b where b.user_id = auth.uid() and b.shop_id = p.shop_id and b.deleted_at is null limit 1;
  insert into public.inventory_movements (shop_id, product_id, owner_barber_id, barber_id, kind, qty_delta, stock_after,
                                          unit_cost_cents, appointment_id, note, created_by)
  values (p.shop_id, p.id, p.owner_barber_id, v_me, p_kind, v_delta, v_after,
          case when p_kind = 'purchase' then coalesce(p_unit_cost_cents, p.cost_cents) else p.cost_cents end,
          p_appointment_id, p_note, auth.uid());
  return v_after;
end $$;

-- Sell retail products (at the chair or the front desk).
-- p_items: [{"product_id": "...", "quantity": 1, "price_cents": 1500}]  (price defaults to the list price)
-- A barber's own products: 100% to the barber. Shop products: the seller gets
-- the shop's product commission, the shop keeps the rest.
create or replace function public.sell_products(
  p_shop_id uuid, p_items jsonb, p_barber_id uuid default null, p_method public.payment_method default 'cash',
  p_client_id uuid default null, p_appointment_id uuid default null, p_discount_cents bigint default 0)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ss public.shop_settings;
  i record;
  p public.products;
  v_payment uuid;
  v_subtotal bigint := 0;
  v_discount bigint := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax bigint;
  v_total bigint;
  v_shop_rev bigint := 0;   -- shop products
  v_own_rev bigint := 0;    -- seller's own products
  v_ratio numeric;
  v_after int;
  v_comm bigint;
begin
  perform app.require_auth();
  if not (app.can(p_shop_id, 'payments.record')
          or (p_barber_id is not null and app.is_my_barber(p_barber_id) and app.can(p_shop_id, 'payments.record_own'))) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_barber_id is not null and app.barber_shop(p_barber_id) is distinct from p_shop_id then perform app.fail('BARBER_NOT_IN_SHOP'); end if;
  if p_client_id is not null and not exists (select 1 from public.clients where id = p_client_id and shop_id = p_shop_id) then
    perform app.fail('CLIENT_NOT_IN_SHOP');
  end if;
  if p_appointment_id is not null and not exists (select 1 from public.appointments where id = p_appointment_id and shop_id = p_shop_id) then
    perform app.fail('NOT_FOUND');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then perform app.fail('ITEMS_REQUIRED'); end if;
  select * into ss from public.shop_settings where shop_id = p_shop_id;

  insert into public.payments (shop_id, appointment_id, client_id, barber_id, kind, subtotal_cents, discount_cents, tax_cents,
                               tip_cents, total_cents, amount_paid_cents, method, status, provider, recorded_by)
  values (p_shop_id, p_appointment_id,
          coalesce(p_client_id, (select client_id from public.appointments where id = p_appointment_id)),
          p_barber_id, 'product', 0, 0, 0, 0, 0, 0, coalesce(p_method, 'cash'), 'PAID', 'manual', auth.uid())
  returning id into v_payment;

  for i in
    select (x ->> 'product_id')::uuid product_id, greatest(coalesce((x ->> 'quantity')::int, 1), 1) qty,
           (x ->> 'price_cents')::bigint price
      from jsonb_array_elements(p_items) x
  loop
    select * into p from public.products where id = i.product_id and shop_id = p_shop_id and deleted_at is null and is_active for update;
    if p.id is null then perform app.fail('PRODUCT_NOT_FOUND'); end if;
    if p.owner_barber_id is not null and p.owner_barber_id is distinct from p_barber_id then
      perform app.fail('PRODUCT_NOT_YOURS', p.name);
    end if;
    if coalesce(i.price, p.price_cents) < 0 then perform app.fail('INVALID_AMOUNT'); end if;
    if p.stock_qty < i.qty then perform app.fail('OUT_OF_STOCK', p.name || ': ' || p.stock_qty || ' left'); end if;
    update public.products set stock_qty = stock_qty - i.qty where id = p.id returning stock_qty into v_after;
    insert into public.inventory_movements (shop_id, product_id, owner_barber_id, barber_id, kind, qty_delta, stock_after,
                                            unit_cost_cents, unit_price_cents, payment_id, appointment_id, created_by)
    values (p_shop_id, p.id, p.owner_barber_id, p_barber_id, 'sale', -i.qty, v_after, p.cost_cents,
            coalesce(i.price, p.price_cents), v_payment, p_appointment_id, auth.uid());
    insert into public.payment_items (payment_id, product_id, description, quantity, unit_price_cents, total_cents)
    values (v_payment, p.id, p.name, i.qty, coalesce(i.price, p.price_cents), coalesce(i.price, p.price_cents) * i.qty);
    v_subtotal := v_subtotal + coalesce(i.price, p.price_cents) * i.qty;
    if p.owner_barber_id is null then v_shop_rev := v_shop_rev + coalesce(i.price, p.price_cents) * i.qty;
    else v_own_rev := v_own_rev + coalesce(i.price, p.price_cents) * i.qty; end if;
  end loop;

  v_discount := least(v_discount, v_subtotal);
  v_tax := case when ss.prices_include_tax then 0 else round((v_subtotal - v_discount) * ss.tax_rate_bps / 10000.0)::bigint end;
  v_total := v_subtotal - v_discount + v_tax;
  update public.payments
     set subtotal_cents = v_subtotal, discount_cents = v_discount, tax_cents = v_tax, total_cents = v_total, amount_paid_cents = v_total
   where id = v_payment;

  -- Discount is shared pro-rata between shop and own products.
  v_ratio := case when v_subtotal > 0 then (v_subtotal - v_discount)::numeric / v_subtotal else 0 end;
  if p_barber_id is not null and v_own_rev > 0 then
    insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, product_revenue_cents, product_cents, shop_cents)
    values (p_shop_id, p_barber_id, v_payment, p_appointment_id, 'product_own',
            round(v_own_rev * v_ratio)::bigint, round(v_own_rev * v_ratio)::bigint, 0);
  end if;
  if v_shop_rev > 0 and p_barber_id is not null then
    v_comm := round(round(v_shop_rev * v_ratio) * ss.product_commission_bps / 10000.0)::bigint;
    insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, product_revenue_cents, product_cents, shop_cents)
    values (p_shop_id, p_barber_id, v_payment, p_appointment_id, 'product',
            round(v_shop_rev * v_ratio)::bigint, v_comm, round(v_shop_rev * v_ratio)::bigint - v_comm);
  end if;
  return jsonb_build_object('payment_id', v_payment, 'subtotal_cents', v_subtotal, 'discount_cents', v_discount,
                            'tax_cents', v_tax, 'total_cents', v_total);
end $$;

-- Refunds reverse product earnings too; voids put sold products back on the shelf.
create or replace function public.refund_payment(p_payment_id uuid, p_amount_cents bigint, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; v_ratio numeric; e record;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(p.shop_id, 'payments.refund');
  if p.status in ('VOID', 'REFUNDED') then perform app.fail('INVALID_STATUS'); end if;
  if p_amount_cents <= 0 or p.refunded_cents + p_amount_cents > p.amount_paid_cents then perform app.fail('INVALID_AMOUNT'); end if;

  insert into public.refunds (payment_id, amount_cents, reason, refunded_by) values (p.id, p_amount_cents, p_reason, auth.uid());
  update public.payments
     set refunded_cents = refunded_cents + p_amount_cents,
         status = case when refunded_cents + p_amount_cents >= amount_paid_cents then 'REFUNDED' else status end
   where id = p.id;
  update public.appointments set payment_status = 'REFUNDED'
   where id = p.appointment_id and p.kind = 'service' and p.refunded_cents + p_amount_cents >= p.amount_paid_cents;

  v_ratio := p_amount_cents::numeric / nullif(p.total_cents, 0);
  select coalesce(sum(service_revenue_cents), 0) sr, coalesce(sum(commission_cents), 0) cc,
         coalesce(sum(tip_cents), 0) tc, coalesce(sum(shop_cents), 0) sc,
         coalesce(sum(product_revenue_cents), 0) pr, coalesce(sum(product_cents), 0) pc
    into e from public.barber_earnings where payment_id = p.id and kind <> 'refund';
  if p.barber_id is not null then
    insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, service_revenue_cents,
                                        commission_cents, tip_cents, shop_cents, product_revenue_cents, product_cents)
    values (p.shop_id, p.barber_id, p.id, p.appointment_id, 'refund',
            -round(e.sr * v_ratio)::bigint, -round(e.cc * v_ratio)::bigint, -round(e.tc * v_ratio)::bigint, -round(e.sc * v_ratio)::bigint,
            -round(e.pr * v_ratio)::bigint, -round(e.pc * v_ratio)::bigint);
  end if;
end $$;

create or replace function public.void_payment(p_payment_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; m record; v_after int;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  -- A barber can void their own product sale on the same day (wrong item rung up).
  if not (app.can(p.shop_id, 'payments.refund')
          or (p.kind = 'product' and app.is_my_barber(p.barber_id) and p.paid_at > now() - interval '12 hours')) then
    perform app.fail('FORBIDDEN');
  end if;
  if p.status = 'VOID' then return; end if;
  if p.refunded_cents > 0 then perform app.fail('ALREADY_REFUNDED'); end if;
  update public.payments set status = 'VOID', voided_at = now(), notes = concat_ws(' · ', notes, 'Voided: ' || p_reason) where id = p.id;
  delete from public.barber_earnings where payment_id = p.id;
  delete from public.tips where payment_id = p.id;
  delete from public.loyalty_ledger where payment_id = p.id;
  if p.kind = 'service' then
    update public.appointments set payment_status = 'UNPAID' where id = p.appointment_id;
  end if;
  for m in select * from public.inventory_movements where payment_id = p.id and kind = 'sale' loop
    update public.products set stock_qty = stock_qty - m.qty_delta where id = m.product_id returning stock_qty into v_after;
    insert into public.inventory_movements (shop_id, product_id, owner_barber_id, barber_id, kind, qty_delta, stock_after,
                                            unit_cost_cents, payment_id, note, created_by)
    values (m.shop_id, m.product_id, m.owner_barber_id, m.barber_id, 'return', -m.qty_delta, v_after, m.unit_cost_cents,
            p.id, 'Sale voided', auth.uid());
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Finance: money in / money out for the shop, or for one barber's business.
-- Cash basis: inventory purchases count when bought; rent when paid.
-- ---------------------------------------------------------------------------
create or replace function public.finance_summary(p_shop_id uuid, p_from date, p_to date, p_barber_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text; v_from timestamptz; v_to timestamptz; v_today date;
  v_private boolean;      -- may see this barber's private expenses & inventory
  v_in jsonb; v_out jsonb; v_series jsonb; v_extra jsonb;
  v_in_total bigint; v_out_total bigint;
begin
  perform app.require_auth();
  if p_to < p_from or p_to - p_from > 400 then perform app.fail('INVALID_RANGE'); end if;
  select timezone into v_tz from public.shops where id = p_shop_id;
  v_from := app.local_ts(p_from, '00:00', v_tz);
  v_to := app.local_ts(p_to + 1, '00:00', v_tz);
  v_today := (now() at time zone v_tz)::date;
  perform app.sync_rent_charges(p_shop_id);

  if p_barber_id is null then
    -- =============================== SHOP ===============================
    perform app.require(p_shop_id, 'finance.manage');
    with e as (
      select * from public.barber_earnings
       where shop_id = p_shop_id and earned_at >= v_from and earned_at < v_to
    )
    select jsonb_build_object(
      'services_cents', coalesce((select sum(service_revenue_cents) from e where coalesce(commission_snapshot ->> 'type', '') <> 'booth_rental'
                                                                        and kind in ('service', 'refund')), 0)
                        -- refunds of chair-owner tickets are not the shop's money either
                        - coalesce((select sum(e2.service_revenue_cents) from e e2
                                     where e2.kind = 'refund' and exists (select 1 from public.barber_earnings o
                                       where o.payment_id = e2.payment_id and o.kind = 'service'
                                         and o.commission_snapshot ->> 'type' = 'booth_rental')), 0),
      'products_cents', coalesce((select sum(product_revenue_cents) from e where kind = 'product'), 0)
                        + coalesce((select sum(e3.product_revenue_cents) from e e3 where e3.kind = 'refund'
                                     and exists (select 1 from public.barber_earnings o where o.payment_id = e3.payment_id and o.kind = 'product')
                                     and not exists (select 1 from public.barber_earnings o where o.payment_id = e3.payment_id and o.kind = 'product_own')), 0)
                        + coalesce((select sum(p.subtotal_cents - p.discount_cents) from public.payments p
                                     where p.shop_id = p_shop_id and p.kind = 'product' and p.barber_id is null and p.status <> 'VOID'
                                       and p.paid_at >= v_from and p.paid_at < v_to), 0),
      'rent_cents', coalesce((select sum(amount_cents) from public.rent_payments where shop_id = p_shop_id and paid_at >= v_from and paid_at < v_to), 0),
      'fees_cents', coalesce((select sum(subtotal_cents) from public.payments where shop_id = p_shop_id and kind in ('no_show_fee', 'late_cancel_fee')
                                and status <> 'VOID' and paid_at >= v_from and paid_at < v_to), 0),
      'tips_kept_cents', coalesce((select sum(shop_cents) from e where kind = 'tip'), 0)
    ) into v_in;

    with e as (
      select * from public.barber_earnings
       where shop_id = p_shop_id and earned_at >= v_from and earned_at < v_to
    )
    select jsonb_build_object(
      'commissions_cents', coalesce((select sum(commission_cents) from e where coalesce(commission_snapshot ->> 'type', '') <> 'booth_rental'
                                                                        and kind in ('service', 'refund')), 0)
                           - coalesce((select sum(e2.commission_cents) from e e2
                                        where e2.kind = 'refund' and exists (select 1 from public.barber_earnings o
                                          where o.payment_id = e2.payment_id and o.kind = 'service'
                                            and o.commission_snapshot ->> 'type' = 'booth_rental')), 0),
      'product_commissions_cents', coalesce((select sum(product_cents) from e where kind = 'product'), 0),
      'inventory_cents', coalesce((select sum(m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                                    where m.shop_id = p_shop_id and m.owner_barber_id is null and m.kind = 'purchase'
                                      and m.created_at >= v_from and m.created_at < v_to), 0),
      'expenses_cents', coalesce((select sum(amount_cents) from public.expenses where shop_id = p_shop_id and barber_id is null
                                     and deleted_at is null and spent_on between p_from and p_to), 0)
    ) into v_out;

    v_extra := jsonb_build_object(
      'pass_through', jsonb_build_object(
        'chair_owner_services_cents', coalesce((select sum(service_revenue_cents) from public.barber_earnings
                                                 where shop_id = p_shop_id and earned_at >= v_from and earned_at < v_to
                                                   and kind = 'service' and commission_snapshot ->> 'type' = 'booth_rental'), 0),
        'tips_to_barbers_cents', coalesce((select sum(tip_cents) from public.barber_earnings
                                            where shop_id = p_shop_id and earned_at >= v_from and earned_at < v_to), 0)),
      'collected_by_method', (select coalesce(jsonb_object_agg(method, cents), '{}') from (
                                select method, sum(amount_paid_cents - refunded_cents) cents from public.payments
                                 where shop_id = p_shop_id and status <> 'VOID' and paid_at >= v_from and paid_at < v_to
                                 group by method) x),
      'rent', jsonb_build_object(
        'outstanding_cents', coalesce((select sum(greatest(amount_cents - paid_cents, 0)) from public.rent_charges
                                        where shop_id = p_shop_id and not waived and period_start <= v_today), 0),
        'overdue_count', (select count(*) from public.rent_charges r where r.shop_id = p_shop_id and app.rent_status(r, v_today) = 'overdue')),
      'inventory', jsonb_build_object(
        'value_cents', coalesce((select sum(greatest(stock_qty, 0) * cost_cents) from public.products
                                  where shop_id = p_shop_id and owner_barber_id is null and deleted_at is null), 0),
        'retail_value_cents', coalesce((select sum(greatest(stock_qty, 0) * price_cents) from public.products
                                         where shop_id = p_shop_id and owner_barber_id is null and deleted_at is null and kind = 'retail'), 0),
        'low_stock', (select count(*) from public.products where shop_id = p_shop_id and owner_barber_id is null
                        and deleted_at is null and is_active and stock_qty <= low_stock_at),
        'cogs_cents', coalesce((select sum(-m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                                 where m.shop_id = p_shop_id and m.owner_barber_id is null and m.kind in ('sale', 'return')
                                   and m.payment_id is not null and m.created_at >= v_from and m.created_at < v_to), 0)),
      'expenses_by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'cents', cents) order by cents desc), '[]') from (
                                 select category, sum(amount_cents) cents from public.expenses
                                  where shop_id = p_shop_id and barber_id is null and deleted_at is null and spent_on between p_from and p_to
                                  group by category) x),
      -- What each barber earned (payroll) and owes (rent) in the period.
      'barbers', (select coalesce(jsonb_agg(row_to_json(x) order by x.name), '[]') from (
                    select b.id barber_id, b.display_name name, b.barber_type,
                           coalesce(sum(e.service_revenue_cents) filter (where e.kind in ('service', 'refund')), 0) services_cents,
                           coalesce(sum(e.commission_cents), 0) commission_cents,
                           coalesce(sum(e.tip_cents), 0) tips_cents,
                           coalesce(sum(e.product_cents) filter (where e.kind = 'product'), 0) product_commission_cents,
                           case when b.barber_type = 'employee'
                                then coalesce(sum(e.commission_cents), 0) + coalesce(sum(e.tip_cents), 0)
                                     + coalesce(sum(e.product_cents) filter (where e.kind = 'product'), 0) end payout_cents,
                           (select coalesce(sum(rp.amount_cents), 0) from public.rent_payments rp
                             where rp.barber_id = b.id and rp.paid_at >= v_from and rp.paid_at < v_to) rent_paid_cents,
                           (select coalesce(sum(greatest(r.amount_cents - r.paid_cents, 0)), 0) from public.rent_charges r
                             where r.barber_id = b.id and not r.waived and r.period_start <= v_today) rent_balance_cents
                      from public.barbers b
                      left join public.barber_earnings e on e.barber_id = b.id and e.earned_at >= v_from and e.earned_at < v_to
                     where b.shop_id = p_shop_id and b.deleted_at is null
                     group by b.id) x)
    );

    select coalesce(jsonb_agg(jsonb_build_object('date', d, 'in_cents', i, 'out_cents', o) order by d), '[]') into v_series from (
      select g::date d,
             coalesce((select sum(e.service_revenue_cents - e.commission_cents + e.product_revenue_cents - e.product_cents)
                         from public.barber_earnings e
                        where e.shop_id = p_shop_id and e.kind in ('service', 'refund', 'product')
                          and coalesce(e.commission_snapshot ->> 'type', '') <> 'booth_rental'
                          and (e.earned_at at time zone v_tz)::date = g::date), 0)
             + coalesce((select sum(amount_cents) from public.rent_payments rp where rp.shop_id = p_shop_id
                          and (rp.paid_at at time zone v_tz)::date = g::date), 0) i,
             coalesce((select sum(amount_cents) from public.expenses x where x.shop_id = p_shop_id and x.barber_id is null
                          and x.deleted_at is null and x.spent_on = g::date), 0)
             + coalesce((select sum(m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                          where m.shop_id = p_shop_id and m.owner_barber_id is null and m.kind = 'purchase'
                            and (m.created_at at time zone v_tz)::date = g::date), 0) o
        from generate_series(p_from, p_to, interval '1 day') g) s;
  else
    -- ============================ ONE BARBER ============================
    if app.barber_shop(p_barber_id) is distinct from p_shop_id then perform app.fail('BARBER_NOT_IN_SHOP'); end if;
    if not app.can_view_barber_money(p_shop_id, p_barber_id) then perform app.fail('FORBIDDEN'); end if;
    v_private := app.is_my_barber(p_barber_id);

    with e as (
      select * from public.barber_earnings
       where barber_id = p_barber_id and earned_at >= v_from and earned_at < v_to
    )
    select jsonb_build_object(
      'services_cents', coalesce((select sum(commission_cents) from e where kind in ('service', 'refund', 'adjustment')), 0),
      'tips_cents', coalesce((select sum(tip_cents) from e), 0),
      'products_cents', coalesce((select sum(product_cents) from e where kind = 'product_own'), 0)
                        + coalesce((select sum(e2.product_cents) from e e2 where e2.kind = 'refund'
                                     and exists (select 1 from public.barber_earnings o where o.payment_id = e2.payment_id and o.kind = 'product_own')), 0),
      'product_commissions_cents', coalesce((select sum(product_cents) from e where kind = 'product'), 0)
                        + coalesce((select sum(e3.product_cents) from e e3 where e3.kind = 'refund'
                                     and exists (select 1 from public.barber_earnings o where o.payment_id = e3.payment_id and o.kind = 'product')
                                     and not exists (select 1 from public.barber_earnings o where o.payment_id = e3.payment_id and o.kind = 'product_own')), 0),
      'gross_services_cents', coalesce((select sum(service_revenue_cents) from e where kind in ('service', 'refund')), 0)
    ) into v_in;

    select jsonb_build_object(
      'rent_cents', coalesce((select sum(amount_cents) from public.rent_payments where barber_id = p_barber_id
                                 and paid_at >= v_from and paid_at < v_to), 0),
      'inventory_cents', case when v_private then coalesce((select sum(m.qty_delta * coalesce(m.unit_cost_cents, 0))
                                 from public.inventory_movements m where m.owner_barber_id = p_barber_id and m.kind = 'purchase'
                                  and m.created_at >= v_from and m.created_at < v_to), 0) else 0 end,
      'expenses_cents', case when v_private then coalesce((select sum(amount_cents) from public.expenses where barber_id = p_barber_id
                                 and deleted_at is null and spent_on between p_from and p_to), 0) else 0 end
    ) into v_out;

    v_extra := jsonb_build_object(
      'barber_type', (select barber_type from public.barbers where id = p_barber_id),
      'private', v_private,
      'cuts', (select count(*) from public.appointments where barber_id = p_barber_id and status = 'COMPLETED' and kind = 'appointment'
                  and coalesce(completed_at, ends_at) >= v_from and coalesce(completed_at, ends_at) < v_to),
      'rent', jsonb_build_object(
        'charged_cents', coalesce((select sum(amount_cents) from public.rent_charges where barber_id = p_barber_id and not waived
                                     and period_start between p_from and p_to), 0),
        'outstanding_cents', coalesce((select sum(greatest(amount_cents - paid_cents, 0)) from public.rent_charges
                                        where barber_id = p_barber_id and not waived and period_start <= v_today), 0),
        'next_due', (select jsonb_build_object('due_date', r.due_date, 'balance_cents', r.amount_cents - r.paid_cents, 'period_start', r.period_start)
                       from public.rent_charges r where r.barber_id = p_barber_id and not r.waived and r.paid_cents < r.amount_cents
                       order by r.due_date limit 1),
        'plan', (select jsonb_build_object('type', c.type, 'rent_cents', c.rent_cents, 'rent_period', c.rent_period, 'percent_bps', c.percent_bps)
                   from app.commission_rule(p_barber_id, now()) c where c.id is not null)),
      'inventory', case when v_private then jsonb_build_object(
        'value_cents', coalesce((select sum(greatest(stock_qty, 0) * cost_cents) from public.products
                                  where owner_barber_id = p_barber_id and deleted_at is null), 0),
        'low_stock', (select count(*) from public.products where owner_barber_id = p_barber_id and deleted_at is null
                        and is_active and stock_qty <= low_stock_at),
        'cogs_cents', coalesce((select sum(-m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                                 where m.owner_barber_id = p_barber_id and m.kind in ('sale', 'return') and m.payment_id is not null
                                   and m.created_at >= v_from and m.created_at < v_to), 0)) end,
      'expenses_by_category', case when v_private then (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'cents', cents) order by cents desc), '[]') from (
                                 select category, sum(amount_cents) cents from public.expenses
                                  where barber_id = p_barber_id and deleted_at is null and spent_on between p_from and p_to
                                  group by category) x) else '[]'::jsonb end
    );

    select coalesce(jsonb_agg(jsonb_build_object('date', d, 'in_cents', i, 'out_cents', o) order by d), '[]') into v_series from (
      select g::date d,
             coalesce((select sum(e.commission_cents + e.tip_cents + e.product_cents) from public.barber_earnings e
                        where e.barber_id = p_barber_id and (e.earned_at at time zone v_tz)::date = g::date), 0) i,
             coalesce((select sum(amount_cents) from public.rent_payments rp where rp.barber_id = p_barber_id
                          and (rp.paid_at at time zone v_tz)::date = g::date), 0)
             + case when v_private then
                 coalesce((select sum(amount_cents) from public.expenses x where x.barber_id = p_barber_id
                              and x.deleted_at is null and x.spent_on = g::date), 0)
                 + coalesce((select sum(m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                              where m.owner_barber_id = p_barber_id and m.kind = 'purchase'
                                and (m.created_at at time zone v_tz)::date = g::date), 0)
               else 0 end o
        from generate_series(p_from, p_to, interval '1 day') g) s;
  end if;

  select coalesce(sum(value::bigint), 0) into v_in_total from jsonb_each_text(v_in) where key <> 'gross_services_cents';
  select coalesce(sum(value::bigint), 0) into v_out_total from jsonb_each_text(v_out);
  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz,
                                 'currency', (select currency from public.shop_settings where shop_id = p_shop_id)),
    'scope', case when p_barber_id is null then 'shop' else 'barber' end,
    'money_in', v_in, 'money_out', v_out,
    'total_in_cents', v_in_total, 'total_out_cents', v_out_total, 'net_cents', v_in_total - v_out_total,
    'series', v_series) || v_extra;
end $$;

-- ---------------------------------------------------------------------------
-- Workspaces: expose barber type + the new permissions to the app shell.
-- ---------------------------------------------------------------------------
drop function public.my_workspaces();
create function public.my_workspaces()
returns table (shop_id uuid, shop_name text, shop_slug text, organization_id uuid, role public.staff_role,
               barber_id uuid, barber_type public.barber_type, timezone text, accent_color text, is_published boolean, permissions text[])
language sql stable security definer set search_path = public, pg_temp as $$
  with ms as (
    select s.id as shop_id, s.name, s.slug, s.organization_id, m.role, s.timezone, s.accent_color, s.is_published,
           row_number() over (partition by s.id order by array_position(array['owner','manager','receptionist','barber']::public.staff_role[], m.role)) rn
      from public.memberships m
      join public.shops s on s.organization_id = m.organization_id and (m.shop_id is null or m.shop_id = s.id)
     where m.user_id = auth.uid() and m.is_active and s.deleted_at is null
  )
  select ms.shop_id, ms.name, ms.slug, ms.organization_id, ms.role, b.id, b.barber_type,
         ms.timezone, ms.accent_color, ms.is_published,
         array(select p from unnest(array[
           'shop.settings','staff.manage','services.manage','schedule.manage_all','calendar.all','clients.all',
           'payments.view','payments.record','payments.refund','reports.shop','marketing.manage','walkins.manage',
           'waitlist.manage','reviews.manage','commissions.manage','financials.all_barbers','audit.view',
           'billing','notifications.view','*private_notes','inventory.manage','inventory.sell','finance.manage']) p
                where app.can(ms.shop_id, p))
    from ms
    left join lateral (select b.id, b.barber_type from public.barbers b
                        where b.shop_id = ms.shop_id and b.user_id = auth.uid() and b.deleted_at is null limit 1) b on true
   where rn = 1
   order by ms.name
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security for the new tables
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['chairs', 'rent_charges', 'rent_payments', 'products', 'inventory_movements', 'expenses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

create policy chairs_read on public.chairs for select to authenticated using (app.is_staff(shop_id));
-- chairs are written through save_chair / delete_chair

create policy rent_charges_read on public.rent_charges for select to authenticated
  using (app.can(shop_id, 'finance.manage') or app.is_my_barber(barber_id));
create policy rent_payments_read on public.rent_payments for select to authenticated
  using (app.can(shop_id, 'finance.manage') or app.is_my_barber(barber_id));

create policy products_read on public.products for select to authenticated
  using (app.can_see_product(shop_id, owner_barber_id));
create policy inventory_movements_read on public.inventory_movements for select to authenticated
  using (app.can_see_product(shop_id, owner_barber_id));

create policy expenses_read on public.expenses for select to authenticated
  using (deleted_at is null and case when barber_id is null then app.can(shop_id, 'finance.manage') else app.is_my_barber(barber_id) end);
create policy expenses_insert on public.expenses for insert to authenticated
  with check (created_by = auth.uid()
              and case when barber_id is null then app.can(shop_id, 'finance.manage') else app.is_my_barber(barber_id) end);
create policy expenses_update on public.expenses for update to authenticated
  using (case when barber_id is null then app.can(shop_id, 'finance.manage') else app.is_my_barber(barber_id) end)
  with check (case when barber_id is null then app.can(shop_id, 'finance.manage') else app.is_my_barber(barber_id) end);

-- Audit trail for the money-adjacent tables.
do $$
declare t text;
begin
  foreach t in array array['chairs', 'rent_charges', 'rent_payments', 'products', 'expenses'] loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function app.audit()', t || '_audit', t);
  end loop;
end $$;

grant execute on all functions in schema app to authenticated, anon, service_role;

-- ===================== 20261007000017_live_queue_smart_time.sql =====================
-- =============================================================================
-- BarberNGo — live barber status, chair board, public walk-in queue,
-- smart (learned) service times, live appointment page, WhatsApp/SMS
-- notifications and operations metrics (wait time, on-time %).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Finishing early frees the chair: a completed appointment occupies the
-- calendar only until the cut actually ended (+ buffer), so the next client
-- can be booked or seated straight away.
-- ---------------------------------------------------------------------------
alter table public.appointments add column released_at timestamptz, add column occupied_until timestamptz;

create or replace function app.appointments_before_write()
returns trigger language plpgsql as $$
begin
  new.blocked_until := new.ends_at + make_interval(mins => new.buffer_minutes);
  if new.status = 'COMPLETED' and new.released_at is null and (tg_op = 'INSERT' or old.status is distinct from 'COMPLETED') then
    -- Rounded down: the next client may take the chair in the minute the cut ended.
    new.released_at := date_trunc('minute', coalesce(new.actual_finished_at, now())) + make_interval(mins => new.buffer_minutes);
  end if;
  new.occupied_until := case when new.released_at is null then new.blocked_until
                             else greatest(least(new.blocked_until, new.released_at), new.starts_at) end; -- empty range when done before its slot
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;

update public.appointments set occupied_until = blocked_until;
alter table public.appointments alter column occupied_until set not null;
alter table public.appointments drop constraint appointments_no_overlap;
alter table public.appointments add constraint appointments_no_overlap
  exclude using gist (barber_id with =, tstzrange(starts_at, occupied_until) with &&)
  where (status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED') and deleted_at is null);

create or replace function app.barber_busy_ranges(p_barber uuid, p_from timestamptz, p_to timestamptz, p_ignore_appointment uuid default null)
returns tstzmultirange language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(range_agg(tstzrange(a.starts_at, a.occupied_until)), '{}')
    from public.appointments a
   where a.barber_id = p_barber
     and a.deleted_at is null
     and a.status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
     and a.starts_at < p_to and a.occupied_until > p_from
     and (p_ignore_appointment is null or a.id <> p_ignore_appointment)
$$;

-- ---------------------------------------------------------------------------
-- Smart service time: each barber's real average per service
-- ---------------------------------------------------------------------------
alter table public.booking_settings add column smart_durations boolean not null default true;

-- Average of the barber's last 20 timed single-service cuts (≥ 5 needed),
-- rounded UP to 5 minutes so a learned duration never makes the barber late.
create or replace function app.learned_minutes(p_barber uuid, p_service uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select case when count(*) >= 5 then (ceil(avg(m) / 5.0) * 5)::int end
    from (
      select a.actual_duration_seconds / 60.0 as m
        from public.appointments a
       where a.barber_id = p_barber and a.status = 'COMPLETED' and a.kind = 'appointment' and a.deleted_at is null
         and a.actual_duration_seconds >= 60
         and a.actual_duration_seconds <= 3 * extract(epoch from (a.ends_at - a.starts_at))
         and a.completed_at > now() - interval '180 days'
         and (select array_agg(x.service_id) from public.appointment_services x where x.appointment_id = a.id) = array[p_service]
       order by a.actual_started_at desc nulls last
       limit 20) t
$$;

-- Effective price/duration of services for a barber. Duration precedence:
-- explicit per-barber override › learned average (clamped to 60–150% of the
-- service default, when smart durations are on) › service default.
create or replace function app.barber_service_quote(p_barber uuid, p_services uuid[])
returns table (duration_minutes int, price_cents bigint) language sql stable security definer set search_path = public, pg_temp as $$
  select sum(coalesce(bs.duration_minutes,
                      case when l.lm is not null
                           then greatest(5, least(round(s.duration_minutes * 1.5)::int, greatest(round(s.duration_minutes * 0.6)::int, l.lm))) end,
                      s.duration_minutes))::int,
         sum(coalesce(bs.price_cents, s.price_cents))::bigint
    from unnest(p_services) as req(service_id)
    join public.services s on s.id = req.service_id and s.deleted_at is null and s.is_active
    join public.barber_services bs on bs.service_id = s.id and bs.barber_id = p_barber and bs.is_active
    join public.booking_settings bk on bk.shop_id = s.shop_id
    left join lateral (select app.learned_minutes(p_barber, s.id) as lm where bk.smart_durations and bs.duration_minutes is null) l on true
  having count(*) = cardinality(p_services)
$$;

-- Per barber × service timing table (analytics + "Kevin got slower" insights).
create or replace function public.service_time_stats(p_shop_id uuid, p_barber_id uuid default null)
returns table (barber_id uuid, barber_name text, service_id uuid, service_name text, default_minutes int, booked_minutes int,
               learned_minutes int, avg_30d numeric, avg_prev_30d numeric, samples_30d int, samples_total int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  perform app.require_auth();
  if not (app.can(p_shop_id, 'reports.shop') or (p_barber_id is not null and app.is_my_barber(p_barber_id))) then
    perform app.fail('FORBIDDEN');
  end if;
  return query
    with cuts as (
      select a.barber_id, x.service_id, a.actual_duration_seconds / 60.0 m, a.completed_at
        from public.appointments a
        join public.appointment_services x on x.appointment_id = a.id
       where a.shop_id = p_shop_id and a.status = 'COMPLETED' and a.kind = 'appointment' and a.actual_duration_seconds >= 60
         and a.completed_at > now() - interval '60 days'
         and (select count(*) from public.appointment_services y where y.appointment_id = a.id) = 1
         and (p_barber_id is null or a.barber_id = p_barber_id)
    )
    select b.id, b.display_name, s.id, s.name, s.duration_minutes,
           (select q.duration_minutes from app.barber_service_quote(b.id, array[s.id]) q),
           app.learned_minutes(b.id, s.id),
           round(avg(c.m) filter (where c.completed_at > now() - interval '30 days'), 1),
           round(avg(c.m) filter (where c.completed_at <= now() - interval '30 days'), 1),
           (count(c.m) filter (where c.completed_at > now() - interval '30 days'))::int,
           count(c.m)::int
      from public.barber_services bs
      join public.barbers b on b.id = bs.barber_id and b.deleted_at is null and b.status = 'active'
      join public.services s on s.id = bs.service_id and s.deleted_at is null and s.is_active
      left join cuts c on c.barber_id = b.id and c.service_id = s.id
     where b.shop_id = p_shop_id and bs.is_active and (p_barber_id is null or b.id = p_barber_id)
     group by b.id, b.display_name, s.id, s.name, s.duration_minutes, s.sort_order
     order by b.display_name, s.sort_order, s.name;
end $$;

-- ---------------------------------------------------------------------------
-- Walk-in queue: shared simulation (staff + public views), public tickets
-- ---------------------------------------------------------------------------
alter table public.walk_ins
  add column public_token uuid not null unique default gen_random_uuid(),
  add column channel text not null default 'staff' check (channel in ('staff', 'online')),
  add column almost_ready_notified_at timestamptz;

alter table public.notifications add column walk_in_id uuid references public.walk_ins (id) on delete cascade;

-- Queue simulation without permission checks (internal).
create or replace function app.walk_in_queue_rows(p_shop_id uuid)
returns table (id uuid, name text, phone text, service_id uuid, service_name text, preferred_barber_id uuid,
               status public.walk_in_status, created_at timestamptz, queue_position int,
               estimated_start timestamptz, estimated_wait_minutes int, likely_barber_id uuid, client_id uuid, notes text, channel text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  w record;
  v_cursor jsonb := '{}'::jsonb;   -- barber_id -> next free timestamptz
  v_best_barber uuid;
  v_best_start timestamptz;
  s record;
  v_pos int := 0;
  v_dur int;
begin
  for w in
    select wi.*, sv.name as service_name, sv.duration_minutes
      from public.walk_ins wi left join public.services sv on sv.id = wi.service_id
     where wi.shop_id = p_shop_id and wi.status in ('waiting', 'called')
       and wi.created_at > now() - interval '18 hours'
     order by wi.created_at
  loop
    v_pos := v_pos + 1;
    v_best_barber := null; v_best_start := null;
    if w.service_id is not null then
      for s in
        select distinct on (cs.barber_id) cs.barber_id, cs.starts_at
          from app.compute_slots(p_shop_id, array[w.service_id], w.preferred_barber_id, now(), now() + interval '12 hours', true) cs
          join public.barbers br on br.id = cs.barber_id
         where cs.starts_at >= coalesce((v_cursor ->> cs.barber_id::text)::timestamptz, now() - interval '1 minute')
           and br.presence <> 'offline'
         order by cs.barber_id, cs.starts_at
      loop
        if v_best_start is null or s.starts_at < v_best_start then
          v_best_start := s.starts_at; v_best_barber := s.barber_id;
        end if;
      end loop;
    end if;
    if v_best_barber is not null then
      v_dur := coalesce((select duration_minutes from app.barber_service_quote(v_best_barber, array[w.service_id])), w.duration_minutes, 30);
      v_cursor := v_cursor || jsonb_build_object(v_best_barber::text, v_best_start + make_interval(mins => v_dur));
    end if;
    id := w.id; name := w.name; phone := w.phone; service_id := w.service_id; service_name := w.service_name;
    preferred_barber_id := w.preferred_barber_id; status := w.status; created_at := w.created_at; queue_position := v_pos;
    estimated_start := v_best_start;
    estimated_wait_minutes := case when v_best_start is not null then greatest(0, ceil(extract(epoch from v_best_start - now()) / 60))::int end;
    likely_barber_id := v_best_barber; client_id := w.client_id; notes := w.notes; channel := w.channel;
    return next;
  end loop;
end $$;

drop function public.walk_in_queue(uuid);
create function public.walk_in_queue(p_shop_id uuid)
returns table (id uuid, name text, phone text, service_id uuid, service_name text, preferred_barber_id uuid,
               status public.walk_in_status, created_at timestamptz, queue_position int,
               estimated_start timestamptz, estimated_wait_minutes int, likely_barber_id uuid, client_id uuid, notes text, channel text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_auth();
  if not app.is_staff(p_shop_id) then perform app.fail('FORBIDDEN'); end if;
  return query select * from app.walk_in_queue_rows(p_shop_id);
end $$;

-- Queue a WhatsApp/SMS (shop setting) + email (if known) to a walk-in.
create or replace function app.notify_walk_in(p_walk_in uuid, p_event text, p_extra jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare w record; v_payload jsonb;
begin
  select wi.id, wi.shop_id, wi.name, wi.phone, wi.client_id, wi.public_token, c.email, c.user_id, ss.sms_channel,
         s.name shop_name, s.slug shop_slug, b.display_name barber_name
    into w
    from public.walk_ins wi
    join public.shops s on s.id = wi.shop_id
    join public.shop_settings ss on ss.shop_id = wi.shop_id
    left join public.clients c on c.id = wi.client_id
    left join public.barbers b on b.id = coalesce(wi.assigned_barber_id, wi.preferred_barber_id)
   where wi.id = p_walk_in;
  if w.id is null then return; end if;
  v_payload := jsonb_build_object('client_first_name', split_part(w.name, ' ', 1), 'shop_name', w.shop_name,
                                  'barber_name', coalesce(w.barber_name, 'your barber'),
                                  'ticket_url', '/q/' || w.public_token, 'book_url', '/shop/' || w.shop_slug) || p_extra;
  if w.sms_channel <> 'none' and app.normalize_phone(w.phone) is not null then
    insert into public.notifications (shop_id, event, channel, audience, client_id, user_id, walk_in_id, to_address, payload, dedupe_key)
    values (w.shop_id, p_event, w.sms_channel::public.notification_channel, 'client', w.client_id, w.user_id, w.id,
            app.normalize_phone(w.phone), v_payload, p_event || ':' || w.id || ':m')
    on conflict (dedupe_key) do nothing;
  end if;
  if w.email is not null then
    insert into public.notifications (shop_id, event, channel, audience, client_id, user_id, walk_in_id, to_address, payload, dedupe_key)
    values (w.shop_id, p_event, 'email', 'client', w.client_id, w.user_id, w.id, w.email, v_payload, p_event || ':' || w.id || ':e')
    on conflict (dedupe_key) do nothing;
  end if;
end $$;

-- "You're almost up": notify waiting walk-ins whose estimate dropped under the threshold.
create or replace function app.notify_queue_progress(p_shop uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_threshold int; v_n int := 0;
begin
  if not exists (select 1 from public.walk_ins where shop_id = p_shop and status = 'waiting'
                   and almost_ready_notified_at is null and created_at > now() - interval '18 hours') then
    return 0;
  end if;
  select queue_almost_ready_minutes into v_threshold from public.shop_settings where shop_id = p_shop;
  for r in select q.* from app.walk_in_queue_rows(p_shop) q
             join public.walk_ins w on w.id = q.id
            where q.status = 'waiting' and w.almost_ready_notified_at is null
              and q.estimated_wait_minutes is not null and q.estimated_wait_minutes <= v_threshold loop
    perform app.notify_walk_in(r.id, 'queue.almost_ready', jsonb_build_object('wait', r.estimated_wait_minutes));
    update public.walk_ins set almost_ready_notified_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function app.walk_ins_after_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status is distinct from old.status and new.status in ('called', 'serving') and old.status = 'waiting' then
    perform app.notify_walk_in(new.id, 'queue.your_turn');
  end if;
  if new.status is distinct from old.status and old.status in ('waiting', 'called') then
    perform app.notify_queue_progress(new.shop_id);
  end if;
  return null;
end $$;
create trigger walk_ins_after_change after update of status on public.walk_ins
  for each row execute function app.walk_ins_after_change();

-- A chair frees up → people further back in the queue move closer.
create or replace function app.appointments_queue_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status is distinct from old.status and new.status in ('COMPLETED', 'CANCELLED', 'NO_SHOW') then
    perform app.notify_queue_progress(new.shop_id);
  end if;
  return null;
end $$;
create trigger appointments_queue_progress after update of status on public.appointments
  for each row execute function app.appointments_queue_trigger();

-- Customer joins the walk-in queue from the shop page / QR code (no account).
create or replace function public.join_walk_in_queue(
  p_shop_id uuid, p_name text, p_phone text, p_service_id uuid, p_barber_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_token uuid; v_client uuid; v_waiting int; r record;
begin
  if not exists (select 1 from public.shops s join public.shop_settings ss on ss.shop_id = s.id
                  where s.id = p_shop_id and s.deleted_at is null and s.is_published and ss.walk_ins_enabled)
     or not app.shop_has_feature(p_shop_id, 'walk_ins') then
    perform app.fail('QUEUE_CLOSED');
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then perform app.fail('NAME_REQUIRED'); end if;
  if app.normalize_phone(p_phone) is null or length(app.normalize_phone(p_phone)) < 7 then perform app.fail('PHONE_REQUIRED'); end if;
  if not exists (select 1 from public.services s where s.id = p_service_id and s.shop_id = p_shop_id
                   and s.is_active and s.is_public and s.deleted_at is null) then
    perform app.fail('SERVICE_NOT_BOOKABLE');
  end if;
  if p_barber_id is not null and not exists (
       select 1 from public.barber_services bs join public.barbers b on b.id = bs.barber_id
        where bs.barber_id = p_barber_id and bs.service_id = p_service_id and bs.is_active
          and b.shop_id = p_shop_id and b.status = 'active' and b.deleted_at is null) then
    perform app.fail('SERVICE_NOT_OFFERED');
  end if;
  -- Idempotent per phone: rejoining returns the existing ticket.
  select w.id, w.public_token into v_id, v_token from public.walk_ins w
   where w.shop_id = p_shop_id and w.status in ('waiting', 'called') and w.created_at > now() - interval '12 hours'
     and app.normalize_phone(w.phone) = app.normalize_phone(p_phone)
   limit 1;
  if v_id is null then
    select count(*) into v_waiting from public.walk_ins
     where shop_id = p_shop_id and status in ('waiting', 'called') and created_at > now() - interval '12 hours';
    if v_waiting >= 40 then perform app.fail('QUEUE_FULL'); end if;
    -- Opening hours: don't take people when nobody can serve them today.
    if not exists (select 1 from app.compute_slots(p_shop_id, array[p_service_id], p_barber_id, now(), now() + interval '12 hours', true)) then
      perform app.fail('NO_CAPACITY_TODAY');
    end if;
    v_client := app.upsert_client(p_shop_id, jsonb_build_object(
      'first_name', split_part(trim(p_name), ' ', 1),
      'last_name', nullif(substr(trim(p_name), length(split_part(trim(p_name), ' ', 1)) + 2), ''),
      'phone', p_phone), 'walk_in');
    insert into public.walk_ins (shop_id, client_id, name, phone, service_id, preferred_barber_id, channel)
    values (p_shop_id, v_client, trim(p_name), p_phone, p_service_id, p_barber_id, 'online')
    returning id, public_token into v_id, v_token;
    select * into r from app.walk_in_queue_rows(p_shop_id) q where q.id = v_id;
    update public.walk_ins set quoted_wait_minutes = r.estimated_wait_minutes where id = v_id;
    perform app.notify_walk_in(v_id, 'queue.joined', jsonb_build_object('position', r.queue_position, 'wait', r.estimated_wait_minutes));
  end if;
  return jsonb_build_object('token', v_token, 'walk_in_id', v_id);
end $$;

-- Live ticket for the customer (token = capability).
create or replace function public.get_walk_in_ticket(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.walk_ins; s public.shops; v_threshold int; v_wait int; v_pos int; v_start timestamptz; v_likely uuid; v_appt record;
begin
  select * into w from public.walk_ins where public_token = p_token;
  if w.id is null then return null; end if;
  select * into s from public.shops where id = w.shop_id;
  select queue_almost_ready_minutes into v_threshold from public.shop_settings where shop_id = w.shop_id;
  if w.status in ('waiting', 'called') then
    select q.estimated_wait_minutes, q.queue_position, q.estimated_start, q.likely_barber_id
      into v_wait, v_pos, v_start, v_likely
      from app.walk_in_queue_rows(w.shop_id) q where q.id = w.id;
    if w.status = 'waiting' and w.almost_ready_notified_at is null and v_wait is not null and v_wait <= v_threshold then
      perform app.notify_walk_in(w.id, 'queue.almost_ready', jsonb_build_object('wait', v_wait));
      update public.walk_ins set almost_ready_notified_at = now() where id = w.id;
    end if;
  end if;
  select a.status, a.actual_started_at, a.ends_at, a.starts_at into v_appt from public.appointments a where a.id = w.appointment_id;
  return jsonb_build_object(
    'id', w.id, 'status', w.status, 'name', split_part(w.name, ' ', 1), 'created_at', w.created_at,
    'position', v_pos, 'ahead', greatest(coalesce(v_pos, 1) - 1, 0),
    'estimated_wait_minutes', v_wait,
    'wait_low', case when v_wait is not null then greatest(0, v_wait - greatest(5, v_wait / 5)) end,
    'wait_high', case when v_wait is not null then v_wait + greatest(5, v_wait / 5) end,
    'estimated_start', v_start,
    'almost_ready', v_wait is not null and v_wait <= v_threshold,
    'service_name', (select name from public.services where id = w.service_id),
    'preferred_barber', (select display_name from public.barbers where id = w.preferred_barber_id),
    'likely_barber', (select display_name from public.barbers where id = coalesce(w.assigned_barber_id, v_likely)),
    'appointment', case when v_appt.status is not null then jsonb_build_object('status', v_appt.status, 'actual_started_at', v_appt.actual_started_at,
                                                                               'scheduled_minutes', extract(epoch from v_appt.ends_at - v_appt.starts_at)::int / 60) end,
    'avg_service_minutes', (select duration_minutes from public.services where id = w.service_id),
    'shop', jsonb_build_object('name', s.name, 'slug', s.slug, 'accent_color', s.accent_color, 'timezone', s.timezone, 'phone', s.phone,
                               'address', concat_ws(', ', s.address_line1, s.city)));
end $$;

create or replace function public.leave_walk_in_queue(p_token uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.walk_ins set status = 'left', left_at = now()
   where public_token = p_token and status in ('waiting', 'called');
end $$;

-- ---------------------------------------------------------------------------
-- Live barber status
--   CUTTING  · a cut is running (est. finish from the learned duration)
--   BOOKED   · a booked client's slot covers now (not started yet)
--   BREAK    · barber on break / lunch gap / blocked time
--   QUEUE    · free, but walk-ins are waiting for this barber
--   AVAILABLE· free right now
--   OFFLINE  · went offline, hasn't started yet, or done for today
--   NOT_WORKING · no hours today
-- ---------------------------------------------------------------------------
create or replace function app.barber_live(p_barber uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  b public.barbers; v_tz text; v_now timestamptz := now(); v_day date;
  v_open tstzmultirange; v_start_today timestamptz; v_end_today timestamptz;
  cur record; v_blk timestamptz; v_appt timestamptz;
  v_status text; v_until timestamptz; v_note text;
  v_queue int; v_avg int; v_dur int; v_wait int; v_next timestamptz; v_svc uuid; v_svc_dur int;
begin
  select * into b from public.barbers where id = p_barber;
  if b.id is null then return null; end if;
  select timezone into v_tz from public.shops where id = b.shop_id;
  v_day := (v_now at time zone v_tz)::date;
  v_open := app.barber_open_ranges(p_barber, app.local_ts(v_day, '00:00', v_tz), app.local_ts(v_day + 1, '00:00', v_tz));
  if not isempty(v_open) then
    v_start_today := lower(v_open); v_end_today := upper(v_open);
  end if;

  select round(avg(t.actual_duration_seconds) / 60.0)::int into v_avg
    from (select a.actual_duration_seconds from public.appointments a
           where a.barber_id = p_barber and a.status = 'COMPLETED' and a.actual_duration_seconds >= 60
           order by a.actual_started_at desc nulls last limit 50) t;

  select count(*) into v_queue from public.walk_ins w
   where w.shop_id = b.shop_id and w.status in ('waiting', 'called') and w.preferred_barber_id = p_barber
     and w.created_at > v_now - interval '18 hours';

  select bs.service_id, coalesce(bs.duration_minutes, s.duration_minutes) into v_svc, v_svc_dur
    from public.barber_services bs join public.services s on s.id = bs.service_id
   where bs.barber_id = p_barber and bs.is_active and s.is_active and s.is_public and s.deleted_at is null
   order by coalesce(bs.duration_minutes, s.duration_minutes), s.sort_order limit 1;

  select a.id, a.actual_started_at, a.starts_at, a.ends_at,
         (select array_agg(x.service_id order by x.position) from public.appointment_services x where x.appointment_id = a.id) svcs,
         (select string_agg(x.name, ' + ' order by x.position) from public.appointment_services x where x.appointment_id = a.id) svc_name
    into cur
    from public.appointments a
   where a.barber_id = p_barber and a.status = 'IN_SERVICE' and a.deleted_at is null
   order by a.actual_started_at desc nulls last limit 1;

  if cur.id is not null then
    v_status := 'CUTTING';
    v_dur := coalesce((select q.duration_minutes from app.barber_service_quote(p_barber, cur.svcs) q),
                      (extract(epoch from cur.ends_at - cur.starts_at) / 60)::int);
    v_until := greatest(coalesce(cur.actual_started_at, cur.starts_at) + make_interval(mins => v_dur), v_now + interval '2 minutes');
  elsif b.presence = 'offline' then
    v_status := 'OFFLINE'; v_note := 'offline';
  elsif b.presence = 'break' and (b.presence_until is null or b.presence_until > v_now) then
    v_status := 'BREAK'; v_until := b.presence_until;
  elsif isempty(v_open) then
    v_status := 'NOT_WORKING';
  elsif not (v_open @> v_now) then
    if v_end_today <= v_now then
      v_status := 'OFFLINE'; v_note := 'done';
    elsif v_start_today > v_now then
      v_status := 'OFFLINE'; v_note := 'starts'; v_until := v_start_today;
    else
      v_status := 'BREAK';
      select min(lower(r)) into v_until from unnest(v_open) r where lower(r) > v_now;
    end if;
  else
    select a.ends_at into v_blk from public.appointments a
     where a.barber_id = p_barber and a.deleted_at is null and a.kind <> 'appointment'
       and a.status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED') and a.starts_at <= v_now and a.ends_at > v_now
     order by a.ends_at desc limit 1;
    if v_blk is not null then
      v_status := 'BREAK'; v_until := v_blk;
    else
      select a.blocked_until into v_appt from public.appointments a
       where a.barber_id = p_barber and a.deleted_at is null and a.kind = 'appointment'
         and a.status in ('BOOKED', 'CONFIRMED', 'CHECKED_IN') and a.starts_at <= v_now and a.blocked_until > v_now
       order by a.starts_at limit 1;
      if v_appt is not null then
        v_status := 'BOOKED'; v_until := v_appt;
      elsif v_queue > 0 then
        v_status := 'QUEUE';
      else
        v_status := 'AVAILABLE';
        -- Free now, but is there room for even the quickest service before the next booking?
        if v_svc is not null and not exists (
             select 1 from app.compute_slots(b.shop_id, array[v_svc], p_barber, v_now - interval '1 minute', v_now + interval '20 minutes', true)) then
          v_status := 'BOOKED';
          select min(a.starts_at) into v_until from public.appointments a
           where a.barber_id = p_barber and a.deleted_at is null and a.starts_at > v_now
             and a.status not in ('CANCELLED', 'NO_SHOW', 'RESCHEDULED');
        end if;
      end if;
    end if;
  end if;

  -- Walk-in wait for this barber: time until free + queued clients.
  v_wait := greatest(0, ceil(extract(epoch from coalesce(v_until, v_now) - v_now) / 60))::int
            * (case when v_status in ('CUTTING', 'BOOKED', 'BREAK') then 1 else 0 end)
            + v_queue * coalesce(v_avg, v_svc_dur, 30);

  -- Next bookable start (online rules) for the quickest service.
  if v_svc is not null and b.status = 'active' and b.accepts_online_booking then
    select min(cs.starts_at) into v_next
      from app.compute_slots(b.shop_id, array[v_svc], p_barber, v_now, app.local_ts(v_day + 1, '00:00', v_tz), false) cs;
    if v_next is null then
      select min(cs.starts_at) into v_next
        from app.compute_slots(b.shop_id, array[v_svc], p_barber, app.local_ts(v_day + 1, '00:00', v_tz), v_now + interval '14 days', false) cs;
    end if;
  end if;

  return jsonb_build_object(
    'barber_id', p_barber, 'status', v_status, 'until', v_until, 'note', v_note, 'presence', b.presence,
    'current', case when cur.id is not null then jsonb_build_object(
                 'started_at', cur.actual_started_at, 'estimated_finish', v_until, 'service', cur.svc_name,
                 'target_minutes', v_dur) end,
    'queue_count', v_queue, 'estimated_wait_minutes', v_wait,
    'avg_cut_minutes', v_avg, 'next_available', v_next,
    'works_today', not isempty(v_open), 'day_starts', v_start_today, 'day_ends', v_end_today);
end $$;

create or replace function app.shop_open_now(p_shop uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.business_hours h join public.shops s on s.id = h.shop_id
     where h.shop_id = p_shop
       and h.weekday = extract(dow from (now() at time zone s.timezone))
       and (now() at time zone s.timezone)::time >= h.opens_at
       and (now() at time zone s.timezone)::time < h.closes_at)
    and not exists (select 1 from public.availability_exceptions e
                     where e.shop_id = p_shop and e.kind = 'closure' and e.barber_id is null
                       and now() >= e.starts_at and now() < e.ends_at)
$$;

-- Walk-in summary for "Current estimated wait".
create or replace function app.walk_in_summary(p_shop uuid, p_live jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_waiting int; v_last int; v_avg int; v_working int; v_min int;
begin
  select count(*), max(q.estimated_wait_minutes) into v_waiting, v_last from app.walk_in_queue_rows(p_shop) q where q.status = 'waiting';
  select round(avg(a.actual_duration_seconds) / 60.0)::int into v_avg from public.appointments a
   where a.shop_id = p_shop and a.status = 'COMPLETED' and a.actual_duration_seconds >= 60 and a.completed_at > now() - interval '30 days';
  v_avg := coalesce(v_avg, (select round(avg(duration_minutes))::int from public.services where shop_id = p_shop and is_active and deleted_at is null), 30);
  select count(*), min(case when x ->> 'status' = 'AVAILABLE' then 0
                            when x ->> 'status' in ('CUTTING', 'BOOKED', 'BREAK', 'QUEUE') then (x ->> 'estimated_wait_minutes')::int end)
    into v_working, v_min
    from jsonb_array_elements(p_live) x where x ->> 'status' in ('AVAILABLE', 'CUTTING', 'BOOKED', 'BREAK', 'QUEUE');
  return jsonb_build_object(
    'enabled', coalesce((select walk_ins_enabled from public.shop_settings where shop_id = p_shop), false)
               and app.shop_has_feature(p_shop, 'walk_ins'),
    'waiting', v_waiting,
    'avg_service_minutes', v_avg,
    'barbers_working', v_working,
    'estimated_wait_minutes', case when v_working = 0 then null
                                   when v_waiting = 0 then coalesce(v_min, 0)
                                   else coalesce(v_last, 0) + ceil(v_avg::numeric / greatest(v_working, 1))::int end);
end $$;

-- Public, live view of the shop (polled by the booking page).
create or replace function public.get_shop_live(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.shops; v_barbers jsonb;
begin
  select * into s from public.shops where (slug = lower(p_slug) or custom_domain = lower(p_slug)) and deleted_at is null;
  if s.id is null or not (s.is_published or app.is_staff(s.id)) then return null; end if;
  select coalesce(jsonb_agg(app.barber_live(b.id) || jsonb_build_object(
           'name', b.display_name, 'slug', b.slug, 'title', b.title, 'photo_url', b.photo_url, 'color', b.color,
           'chair', (select ch.label from public.chairs ch where ch.barber_id = b.id and ch.is_active))
           order by b.sort_order, b.display_name), '[]')
    into v_barbers
    from public.barbers b
   where b.shop_id = s.id and b.deleted_at is null and b.status = 'active' and b.accepts_online_booking;
  return jsonb_build_object('now', now(), 'open_now', app.shop_open_now(s.id), 'barbers', v_barbers,
                            'walk_ins', app.walk_in_summary(s.id, v_barbers));
end $$;

-- Staff chair board: every chair, who's in it, and their live status.
create or replace function public.shop_live_board(p_shop_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_live jsonb; v_chairs jsonb;
begin
  perform app.require_auth();
  if not app.is_staff(p_shop_id) then perform app.fail('FORBIDDEN'); end if;
  select coalesce(jsonb_agg(app.barber_live(b.id) || jsonb_build_object(
           'name', b.display_name, 'photo_url', b.photo_url, 'color', b.color, 'barber_type', b.barber_type,
           'chair_id', (select ch.id from public.chairs ch where ch.barber_id = b.id))
           order by b.sort_order, b.display_name), '[]')
    into v_live
    from public.barbers b where b.shop_id = p_shop_id and b.deleted_at is null and b.status = 'active';
  select coalesce(jsonb_agg(jsonb_build_object('id', ch.id, 'label', ch.label, 'position', ch.position, 'is_active', ch.is_active,
                                               'notes', ch.notes, 'barber_id', ch.barber_id,
                                               'barber', (select x from jsonb_array_elements(v_live) x where (x ->> 'barber_id')::uuid = ch.barber_id))
                            order by ch.position, ch.label), '[]')
    into v_chairs from public.chairs ch where ch.shop_id = p_shop_id;
  return jsonb_build_object(
    'now', now(), 'open_now', app.shop_open_now(p_shop_id),
    'chairs', v_chairs, 'barbers', v_live,
    'counts', jsonb_build_object(
      'working', (select count(*) from jsonb_array_elements(v_live) x where x ->> 'status' in ('AVAILABLE', 'CUTTING', 'BOOKED', 'BREAK', 'QUEUE')),
      'available', (select count(*) from jsonb_array_elements(v_live) x where x ->> 'status' in ('AVAILABLE', 'QUEUE')),
      'cutting', (select count(*) from jsonb_array_elements(v_live) x where x ->> 'status' in ('CUTTING', 'BOOKED')),
      'on_break', (select count(*) from jsonb_array_elements(v_live) x where x ->> 'status' = 'BREAK'),
      'off', (select count(*) from jsonb_array_elements(v_live) x where x ->> 'status' in ('OFFLINE', 'NOT_WORKING'))),
    'walk_ins', app.walk_in_summary(p_shop_id, v_live));
end $$;

-- Barber taps "Break", "Offline" or "Back".
create or replace function public.set_my_presence(p_barber_id uuid, p_presence text, p_minutes int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_auth();
  if not app.can_manage_barber_calendar(p_barber_id) then perform app.fail('FORBIDDEN'); end if;
  if p_presence not in ('auto', 'break', 'offline') then perform app.fail('INVALID_STATUS'); end if;
  update public.barbers
     set presence = p_presence,
         presence_until = case when p_presence = 'break' and p_minutes is not null then now() + make_interval(mins => p_minutes) end,
         presence_updated_at = now()
   where id = p_barber_id;
end $$;

-- ---------------------------------------------------------------------------
-- Live appointment page: timer, estimated finish, barber status, rebook hint.
-- ---------------------------------------------------------------------------
create or replace function public.get_booking(p_token uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select app.appointment_payload(a.id) || jsonb_build_object(
           'id', a.id, 'status', a.status, 'starts_at', a.starts_at, 'ends_at', a.ends_at,
           'shop_id', a.shop_id, 'barber_id', a.barber_id, 'timezone', s.timezone, 'accent_color', s.accent_color,
           'service_ids', (select jsonb_agg(x.service_id order by x.position) from public.appointment_services x where x.appointment_id = a.id),
           'price_cents', a.expected_price_cents,
           'currency', (select currency from public.shop_settings where shop_id = a.shop_id),
           'address', concat_ws(', ', s.address_line1, s.city, s.region),
           'can_cancel', bk.allow_client_cancel and a.status in ('BOOKED', 'CONFIRMED') and a.starts_at > now(),
           'can_reschedule', bk.allow_client_reschedule and a.status in ('BOOKED', 'CONFIRMED') and a.starts_at > now(),
           'is_late', a.starts_at - now() < make_interval(hours => bk.cancellation_window_hours),
           'cancellation_window_hours', bk.cancellation_window_hours,
           'late_cancel_fee_cents', bk.late_cancel_fee_cents,
           'cancellation_policy_text', bk.cancellation_policy_text,
           'review_token', case when a.status = 'COMPLETED' and not exists (select 1 from public.reviews r where r.appointment_id = a.id) then a.review_token end,
           -- live
           'duration_minutes', (extract(epoch from a.ends_at - a.starts_at) / 60)::int,
           'checked_in_at', a.checked_in_at, 'actual_started_at', a.actual_started_at,
           'actual_finished_at', a.actual_finished_at, 'completed_at', a.completed_at,
           'estimated_finish', case when a.status = 'IN_SERVICE' and a.actual_started_at is not null
                                    then a.actual_started_at + (a.ends_at - a.starts_at) end,
           'barber_photo_url', b.photo_url, 'barber_slug', b.slug,
           'barber_live', case when a.status in ('BOOKED', 'CONFIRMED', 'CHECKED_IN') and a.starts_at < now() + interval '3 hours'
                               then app.barber_live(a.barber_id) end,
           'rebook_weeks', coalesce((select ceil(cp.rebook_interval_days / 7.0)::int from public.client_preferences cp where cp.client_id = a.client_id),
                                    (select case when count(*) >= 2 then round(extract(epoch from max(x.starts_at) - min(x.starts_at)) / 86400.0 / 7 / (count(*) - 1))::int end
                                       from public.appointments x where x.client_id = a.client_id and x.status = 'COMPLETED'),
                                    (select default_rebook_weeks from public.shop_settings where shop_id = a.shop_id)))
    from public.appointments a
    join public.shops s on s.id = a.shop_id
    join public.barbers b on b.id = a.barber_id
    join public.booking_settings bk on bk.shop_id = a.shop_id
   where a.manage_token = p_token and a.deleted_at is null
$$;

-- ---------------------------------------------------------------------------
-- Operations metrics: wait time, on-time %, walk-ins, product sales.
-- ---------------------------------------------------------------------------
create or replace function public.shop_operations(p_shop_id uuid, p_from date, p_to date, p_barber_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_tz text; v_from timestamptz; v_to timestamptz;
begin
  perform app.require_auth();
  if not (app.can(p_shop_id, 'reports.shop') or (p_barber_id is not null and app.is_my_barber(p_barber_id))) then
    perform app.fail('FORBIDDEN');
  end if;
  select timezone into v_tz from public.shops where id = p_shop_id;
  v_from := app.local_ts(p_from, '00:00', v_tz);
  v_to := app.local_ts(p_to + 1, '00:00', v_tz);
  return (
    with appts as (
      select a.* from public.appointments a
       where a.shop_id = p_shop_id and a.kind = 'appointment' and a.deleted_at is null
         and a.starts_at >= v_from and a.starts_at < v_to and (p_barber_id is null or a.barber_id = p_barber_id)
    ), waits as (
      -- booked clients: start − max(booked time, arrival); walk-ins: seated − joined
      select greatest(0, extract(epoch from a.actual_started_at - greatest(a.starts_at, coalesce(a.checked_in_at, a.starts_at))) / 60) w
        from appts a where a.source <> 'walk_in' and a.actual_started_at is not null
      union all
      select greatest(0, extract(epoch from coalesce(w.served_at, w.called_at) - w.created_at) / 60)
        from public.walk_ins w
       where w.shop_id = p_shop_id and w.created_at >= v_from and w.created_at < v_to and coalesce(w.served_at, w.called_at) is not null
         and (p_barber_id is null or w.assigned_barber_id = p_barber_id)
    )
    select jsonb_build_object(
      'walk_ins', (select count(*) from public.walk_ins w where w.shop_id = p_shop_id and w.created_at >= v_from and w.created_at < v_to
                     and (p_barber_id is null or w.assigned_barber_id = p_barber_id)),
      'walk_ins_served', (select count(*) from appts where source = 'walk_in' and status = 'COMPLETED'),
      'walk_ins_left', (select count(*) from public.walk_ins w where w.shop_id = p_shop_id and w.created_at >= v_from and w.created_at < v_to
                          and w.status in ('left', 'cancelled') and p_barber_id is null),
      'avg_wait_minutes', (select round(avg(w)::numeric, 1) from waits),
      'on_time_pct', app.pct((select count(*) from appts where source <> 'walk_in' and actual_started_at is not null
                                and actual_started_at <= starts_at + interval '5 minutes'),
                             (select count(*) from appts where source <> 'walk_in' and actual_started_at is not null)),
      'timed_cuts', (select count(*) from appts where actual_duration_seconds >= 60),
      'product_sales_cents', (select coalesce(sum(p.subtotal_cents - p.discount_cents - p.refunded_cents), 0) from public.payments p
                               where p.shop_id = p_shop_id and p.kind = 'product' and p.status <> 'VOID'
                                 and p.paid_at >= v_from and p.paid_at < v_to and (p_barber_id is null or p.barber_id = p_barber_id)),
      'products_sold', (select coalesce(sum(-m.qty_delta), 0) from public.inventory_movements m
                         where m.shop_id = p_shop_id and m.kind = 'sale' and m.created_at >= v_from and m.created_at < v_to
                           and (p_barber_id is null or m.barber_id = p_barber_id)
                           and (m.owner_barber_id is null or app.is_my_barber(m.owner_barber_id)))
    ));
end $$;

-- ---------------------------------------------------------------------------
-- Notifications: WhatsApp / SMS alongside email; channel templates fall back
-- to the email text.
-- ---------------------------------------------------------------------------
create or replace function app.notify_client(
  p_appt uuid, p_event text, p_scheduled_for timestamptz default now(), p_dedupe text default null, p_extra jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare a record; v_payload jsonb;
begin
  select ap.shop_id, ap.client_id, c.email, c.user_id, c.phone, ss.sms_channel into a
    from public.appointments ap
    left join public.clients c on c.id = ap.client_id
    join public.shop_settings ss on ss.shop_id = ap.shop_id
   where ap.id = p_appt;
  if a.client_id is null then return; end if;
  v_payload := app.appointment_payload(p_appt) || p_extra;
  insert into public.notifications (shop_id, event, channel, audience, client_id, user_id, appointment_id, to_address,
                                    payload, scheduled_for, status, dedupe_key)
  values (a.shop_id, p_event, 'email', 'client', a.client_id, a.user_id, p_appt, a.email::text,
          v_payload, p_scheduled_for,
          case when a.email is null then 'skipped' else 'queued' end::public.notification_status, p_dedupe)
  on conflict (dedupe_key) do nothing;
  if a.sms_channel <> 'none' and app.normalize_phone(a.phone) is not null and p_event <> 'payment.recorded' then
    insert into public.notifications (shop_id, event, channel, audience, client_id, user_id, appointment_id, to_address,
                                      payload, scheduled_for, dedupe_key)
    values (a.shop_id, p_event, a.sms_channel::public.notification_channel, 'client', a.client_id, a.user_id, p_appt,
            app.normalize_phone(a.phone), v_payload, p_scheduled_for, p_dedupe || ':m')
    on conflict (dedupe_key) do nothing;
  end if;
end $$;

create or replace function public.notification_template(p_shop_id uuid, p_event text, p_channel public.notification_channel)
returns public.notification_templates language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.notification_templates
   where event = p_event and is_active and (shop_id = p_shop_id or shop_id is null)
     and (channel = p_channel or (p_channel in ('sms', 'whatsapp', 'push') and channel = 'email'))
   order by (channel = p_channel) desc, shop_id nulls last limit 1
$$;

insert into public.notification_templates (shop_id, event, channel, subject, body) values
  (null, 'queue.joined', 'email', 'You''re in line at {{shop_name}}',
   'Hey {{client_first_name}} 👋 You''re #{{position}} in line at {{shop_name}}. Estimated wait: about {{wait}} min. Follow your spot live: {{ticket_url}}'),
  (null, 'queue.almost_ready', 'email', 'You''re almost up at {{shop_name}}',
   'You''re almost up, {{client_first_name}}! Estimated wait: {{wait}} minutes. Head over to {{shop_name}} now. {{ticket_url}}'),
  (null, 'queue.your_turn', 'email', 'It''s your turn at {{shop_name}}',
   '{{client_first_name}}, it''s your turn! {{barber_name}} is ready for you at {{shop_name}}.')
on conflict do nothing;

-- Shop links in notifications point at the new public URL.
create or replace function app.appointment_payload(p_appt uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'shop_name', s.name, 'shop_slug', s.slug, 'shop_phone', s.phone,
    'client_first_name', c.first_name, 'client_name', trim(c.first_name || ' ' || coalesce(c.last_name, '')),
    'barber_name', b.display_name,
    'service_name', coalesce((select string_agg(x.name, ' + ' order by x.position) from public.appointment_services x where x.appointment_id = a.id), a.title, 'Appointment'),
    'when', app.fmt_when(a.starts_at, s.timezone),
    'time', trim(to_char(a.starts_at at time zone s.timezone, 'FMHH12:MI AM')),
    'date', to_char(a.starts_at at time zone s.timezone, 'YYYY-MM-DD'),
    'starts_at', a.starts_at,
    'manage_url', '/a/' || a.manage_token,
    'confirm_url', '/a/' || a.manage_token || '?confirm=1',
    'review_url', '/r/' || a.review_token,
    'book_url', '/shop/' || s.slug || '/book'
  )
    from public.appointments a
    join public.shops s on s.id = a.shop_id
    join public.barbers b on b.id = a.barber_id
    left join public.clients c on c.id = a.client_id
   where a.id = p_appt
$$;

-- Realtime: chair board and presence changes stream to staff screens.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.chairs, public.barbers;
  end if;
end $$;

grant execute on all functions in schema app to authenticated, anon, service_role;

commit;
