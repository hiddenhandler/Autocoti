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
