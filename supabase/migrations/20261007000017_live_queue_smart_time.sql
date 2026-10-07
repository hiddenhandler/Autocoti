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
