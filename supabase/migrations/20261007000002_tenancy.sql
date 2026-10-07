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
