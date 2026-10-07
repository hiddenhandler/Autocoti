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
