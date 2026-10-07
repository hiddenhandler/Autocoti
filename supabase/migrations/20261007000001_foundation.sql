-- =============================================================================
-- Autocoti — foundation: extensions, private schema, enums, shared helpers
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
