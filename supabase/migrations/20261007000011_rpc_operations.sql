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
  p_source public.booking_source default 'staff', p_force boolean default false)
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
                                     buffer_minutes, notes, expected_price_cents, booked_by)
    values (p_shop_id, p_barber_id, v_client, 'appointment', 'BOOKED', coalesce(p_source, 'staff'), p_starts_at,
            p_starts_at + make_interval(mins => q.duration_minutes), v_buffer, p_notes, q.price_cents, auth.uid())
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
