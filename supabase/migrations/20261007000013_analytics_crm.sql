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
