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
