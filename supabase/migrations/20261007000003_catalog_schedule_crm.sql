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
  color text not null default '#C8A25C' check (color ~ '^#[0-9A-Fa-f]{6}$'),
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
