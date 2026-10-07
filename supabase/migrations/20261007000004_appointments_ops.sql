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
