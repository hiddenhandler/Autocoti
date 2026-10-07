-- =============================================================================
-- Authorization: role defaults, fine-grained permissions, Row Level Security.
--
-- Rules of the road
--   * anon has NO direct table access. Public pages read through
--     SECURITY DEFINER RPCs that only return publishable fields.
--   * Staff read through RLS. Simple catalogue/settings CRUD is allowed
--     directly under RLS; anything with business rules (appointments, money,
--     memberships, walk-ins, waitlist, reviews) is write-only through RPCs.
--   * Financial tables have no INSERT/UPDATE/DELETE policies at all — a
--     barber cannot touch another barber's numbers by changing an id.
-- =============================================================================

-- Default permissions for each role. 'owner' implicitly has everything.
create or replace function app.role_grants(p_role public.staff_role)
returns text[] language sql immutable as $$
  select case p_role
    when 'owner' then array['*']
    when 'manager' then array[
      'shop.view', 'shop.settings', 'staff.manage', 'services.manage', 'schedule.manage_all',
      'calendar.all', 'clients.all', 'payments.view', 'payments.record', 'payments.refund',
      'reports.shop', 'marketing.manage', 'walkins.manage', 'waitlist.manage', 'reviews.manage',
      'notifications.view']
    when 'receptionist' then array[
      'shop.view', 'calendar.all', 'clients.all', 'payments.view', 'payments.record',
      'walkins.manage', 'waitlist.manage']
    when 'barber' then array[
      'shop.view', 'calendar.own', 'clients.own', 'payments.record_own', 'walkins.serve']
  end
$$;

-- Memberships of the current user that apply to a shop (shop-scoped or org-wide).
create or replace function app.shop_memberships(p_shop uuid)
returns setof public.memberships language sql stable security definer set search_path = public, pg_temp as $$
  select m.*
    from public.memberships m
    join public.shops s on s.organization_id = m.organization_id
   where s.id = p_shop
     and m.user_id = auth.uid()
     and m.is_active
     and (m.shop_id is null or m.shop_id = p_shop)
$$;

create or replace function app.is_staff(p_shop uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from app.shop_memberships(p_shop))
$$;

create or replace function app.can(p_shop uuid, p_perm text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m record;
begin
  if p_shop is null or auth.uid() is null then
    return false;
  end if;
  for m in select * from app.shop_memberships(p_shop) loop
    if m.role = 'owner' then return true; end if;
    if m.permissions ? p_perm then
      if (m.permissions ->> p_perm)::boolean then return true; end if;
      continue; -- explicitly revoked for this membership
    end if;
    if p_perm = any (app.role_grants(m.role)) then return true; end if;
  end loop;
  return false;
end $$;

create or replace function app.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = auth.uid() and m.is_active)
$$;

create or replace function app.is_org_owner(p_org uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.memberships m
                  where m.organization_id = p_org and m.user_id = auth.uid() and m.is_active and m.role = 'owner')
$$;

-- Barber records that belong to the current user.
create or replace function app.my_barber_ids()
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select b.id from public.barbers b where b.user_id = auth.uid() and b.deleted_at is null and auth.uid() is not null
$$;

create or replace function app.is_my_barber(p_barber uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_barber is not null and p_barber in (select app.my_barber_ids())
$$;

create or replace function app.barber_shop(p_barber uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select shop_id from public.barbers where id = p_barber
$$;

-- Client records linked to the logged-in customer account.
create or replace function app.is_my_client(p_client uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.clients c where c.id = p_client and c.user_id = auth.uid() and auth.uid() is not null)
$$;

-- Can the current staff user see this client? Full CRM access, or a barber
-- who has (had) an appointment with the client.
create or replace function app.can_access_client(p_client uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.clients c
     where c.id = p_client
       and (app.can(c.shop_id, 'clients.all')
            or exists (select 1 from public.appointments a
                        where a.client_id = c.id and a.barber_id in (select app.my_barber_ids())))
  )
$$;

create or replace function app.can_view_appointment(p_appt uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.appointments a
     where a.id = p_appt
       and (app.can(a.shop_id, 'calendar.all')
            or app.is_my_barber(a.barber_id)
            or app.is_my_client(a.client_id))
  )
$$;

-- Financial visibility for one barber's records.
create or replace function app.can_view_barber_money(p_shop uuid, p_barber uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select app.can(p_shop, 'financials.all_barbers') or app.is_my_barber(p_barber)
$$;

-- Plan feature gating: the single place the app asks "is X included?".
create or replace function app.org_features(p_org uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p.features, '{}'::jsonb) || coalesce(s.feature_overrides, '{}'::jsonb)
    from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id
   where s.organization_id = p_org and s.status in ('trialing', 'active', 'past_due')
$$;

create or replace function app.shop_has_feature(p_shop uuid, p_feature text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((app.org_features(s.organization_id) ->> p_feature)::boolean, false)
    from public.shops s where s.id = p_shop
$$;

grant execute on all functions in schema app to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere & remove anon table access.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

grant select on public.subscription_plans to anon;
create policy plans_read on public.subscription_plans for select to anon, authenticated using (is_public);

-- Profiles ---------------------------------------------------------------
create policy profiles_self on public.profiles for select to authenticated
  using (id = auth.uid() or exists (
    select 1 from public.memberships me join public.memberships them
      on them.organization_id = me.organization_id
     where me.user_id = auth.uid() and me.is_active and them.user_id = profiles.id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Organizations / subscriptions -------------------------------------------
create policy orgs_read on public.organizations for select to authenticated using (app.is_org_member(id));
create policy orgs_update on public.organizations for update to authenticated
  using (app.is_org_owner(id)) with check (app.is_org_owner(id));
create policy subs_read on public.subscriptions for select to authenticated using (app.is_org_member(organization_id));

-- Shops & settings --------------------------------------------------------
create policy shops_read on public.shops for select to authenticated using (app.is_staff(id));
create policy shops_update on public.shops for update to authenticated
  using (app.can(id, 'shop.settings')) with check (app.can(id, 'shop.settings'));

create policy shop_settings_read on public.shop_settings for select to authenticated using (app.is_staff(shop_id));
create policy shop_settings_write on public.shop_settings for update to authenticated
  using (app.can(shop_id, 'shop.settings')) with check (app.can(shop_id, 'shop.settings'));
create policy booking_settings_read on public.booking_settings for select to authenticated using (app.is_staff(shop_id));
create policy booking_settings_write on public.booking_settings for update to authenticated
  using (app.can(shop_id, 'shop.settings')) with check (app.can(shop_id, 'shop.settings'));
create policy business_hours_read on public.business_hours for select to authenticated using (app.is_staff(shop_id));
create policy business_hours_write on public.business_hours for all to authenticated
  using (app.can(shop_id, 'shop.settings')) with check (app.can(shop_id, 'shop.settings'));

-- Memberships & invitations: read only; writes via RPC ---------------------
create policy memberships_read on public.memberships for select to authenticated
  using (user_id = auth.uid()
         or (shop_id is not null and app.can(shop_id, 'staff.manage'))
         or app.is_org_owner(organization_id));
create policy invitations_read on public.invitations for select to authenticated
  using (shop_id is not null and app.can(shop_id, 'staff.manage') or app.is_org_owner(organization_id));

-- Barbers / services / schedule ---------------------------------------------
create policy barbers_read on public.barbers for select to authenticated
  using (app.is_staff(shop_id) or user_id = auth.uid());
create policy barbers_insert on public.barbers for insert to authenticated with check (app.can(shop_id, 'staff.manage'));
create policy barbers_update on public.barbers for update to authenticated
  using (app.can(shop_id, 'staff.manage')) with check (app.can(shop_id, 'staff.manage'));

create policy services_read on public.services for select to authenticated using (app.is_staff(shop_id));
create policy services_write on public.services for all to authenticated
  using (app.can(shop_id, 'services.manage')) with check (app.can(shop_id, 'services.manage'));

create policy barber_services_read on public.barber_services for select to authenticated
  using (app.is_staff(app.barber_shop(barber_id)));
create policy barber_services_write on public.barber_services for all to authenticated
  using (app.can(app.barber_shop(barber_id), 'staff.manage') or app.can(app.barber_shop(barber_id), 'services.manage'))
  with check (app.can(app.barber_shop(barber_id), 'staff.manage') or app.can(app.barber_shop(barber_id), 'services.manage'));

create policy availability_read on public.availability for select to authenticated
  using (app.is_staff(app.barber_shop(barber_id)));
create policy availability_write on public.availability for all to authenticated
  using (app.is_my_barber(barber_id) or app.can(app.barber_shop(barber_id), 'schedule.manage_all'))
  with check (app.is_my_barber(barber_id) or app.can(app.barber_shop(barber_id), 'schedule.manage_all'));

create policy exceptions_read on public.availability_exceptions for select to authenticated using (app.is_staff(shop_id));
create policy exceptions_write on public.availability_exceptions for all to authenticated
  using (app.can(shop_id, 'schedule.manage_all')
         or (barber_id is not null and app.is_my_barber(barber_id) and kind <> 'closure'))
  with check (app.can(shop_id, 'schedule.manage_all')
         or (barber_id is not null and app.is_my_barber(barber_id) and app.barber_shop(barber_id) = shop_id and kind <> 'closure'));

-- Clients ---------------------------------------------------------------------
create policy clients_read on public.clients for select to authenticated
  using (user_id = auth.uid() or app.can_access_client(id));
create policy clients_insert on public.clients for insert to authenticated with check (app.is_staff(shop_id));
create policy clients_update on public.clients for update to authenticated
  using (app.can_access_client(id) or user_id = auth.uid())
  with check (app.can_access_client(id) or user_id = auth.uid());

create policy client_prefs_read on public.client_preferences for select to authenticated
  using (app.can_access_client(client_id) or app.is_my_client(client_id));
create policy client_prefs_write on public.client_preferences for all to authenticated
  using (app.can_access_client(client_id) or app.is_my_client(client_id))
  with check (app.can_access_client(client_id) or app.is_my_client(client_id));

create policy client_notes_read on public.client_notes for select to authenticated
  using (deleted_at is null and (
    author_id = auth.uid()
    or (visibility = 'team' and app.can_access_client(client_id))
    or app.can(shop_id, '*private_notes')));
create policy client_notes_insert on public.client_notes for insert to authenticated
  with check (author_id = auth.uid() and app.is_staff(shop_id) and app.can_access_client(client_id));
create policy client_notes_update on public.client_notes for update to authenticated
  using (author_id = auth.uid() or app.can(shop_id, '*private_notes'))
  with check (author_id = auth.uid() or app.can(shop_id, '*private_notes'));

create policy favorites_own on public.client_favorites for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Appointments: read via RLS, write via RPC -----------------------------------
create policy appointments_read on public.appointments for select to authenticated
  using (deleted_at is null and (
    app.can(shop_id, 'calendar.all') or app.is_my_barber(barber_id) or app.is_my_client(client_id)));
create policy appointment_services_read on public.appointment_services for select to authenticated
  using (app.can_view_appointment(appointment_id));
create policy appointment_history_read on public.appointment_status_history for select to authenticated
  using (app.can_view_appointment(appointment_id));

create policy walk_ins_read on public.walk_ins for select to authenticated using (app.is_staff(shop_id));
create policy waitlist_read on public.waitlist for select to authenticated
  using (app.can(shop_id, 'waitlist.manage') or app.is_my_barber(barber_id) or app.is_my_client(client_id)
         or (barber_id is null and app.is_staff(shop_id)));

-- Money: read-only through RLS --------------------------------------------------
create policy payments_read on public.payments for select to authenticated
  using (app.can(shop_id, 'payments.view') or app.is_my_barber(barber_id) or app.is_my_client(client_id));
create policy payment_items_read on public.payment_items for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id));
create policy refunds_read on public.refunds for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id));
create policy tips_read on public.tips for select to authenticated
  using (app.can_view_barber_money(shop_id, barber_id));
create policy commissions_read on public.commissions for select to authenticated
  using (app.can(shop_id, 'commissions.manage') or app.is_my_barber(barber_id));
create policy earnings_read on public.barber_earnings for select to authenticated
  using (app.can_view_barber_money(shop_id, barber_id));

-- Reviews / notifications ------------------------------------------------------
create policy reviews_read on public.reviews for select to authenticated
  using (app.is_staff(shop_id) or app.is_my_client(client_id));
create policy reviews_moderate on public.reviews for update to authenticated
  using (app.can(shop_id, 'reviews.manage')) with check (app.can(shop_id, 'reviews.manage'));

create policy notification_templates_read on public.notification_templates for select to authenticated
  using (shop_id is null or app.is_staff(shop_id));
create policy notification_templates_write on public.notification_templates for all to authenticated
  using (shop_id is not null and app.can(shop_id, 'shop.settings'))
  with check (shop_id is not null and app.can(shop_id, 'shop.settings'));
create policy notifications_read on public.notifications for select to authenticated
  using (user_id = auth.uid() or app.can(shop_id, 'notifications.view'));

-- Marketing ------------------------------------------------------------------------
create policy promo_read on public.promo_codes for select to authenticated using (app.is_staff(shop_id));
create policy promo_write on public.promo_codes for all to authenticated
  using (app.can(shop_id, 'marketing.manage')) with check (app.can(shop_id, 'marketing.manage'));
create policy gift_cards_read on public.gift_cards for select to authenticated using (app.can(shop_id, 'payments.view'));
create policy gift_card_tx_read on public.gift_card_transactions for select to authenticated
  using (exists (select 1 from public.gift_cards g where g.id = gift_card_id));
create policy membership_plans_read on public.membership_plans for select to authenticated using (app.is_staff(shop_id));
create policy membership_plans_write on public.membership_plans for all to authenticated
  using (app.can(shop_id, 'marketing.manage')) with check (app.can(shop_id, 'marketing.manage'));
create policy client_memberships_read on public.client_memberships for select to authenticated
  using (app.can(shop_id, 'clients.all') or app.is_my_client(client_id));
create policy membership_usage_read on public.membership_usage for select to authenticated
  using (exists (select 1 from public.client_memberships cm where cm.id = client_membership_id));
create policy loyalty_read on public.loyalty_ledger for select to authenticated
  using (app.can(shop_id, 'clients.all') or app.is_my_client(client_id));
create policy referrals_read on public.referrals for select to authenticated using (app.can(shop_id, 'clients.all'));
create policy campaigns_rw on public.campaigns for all to authenticated
  using (app.can(shop_id, 'marketing.manage')) with check (app.can(shop_id, 'marketing.manage'));

create policy snapshots_read on public.analytics_snapshots for select to authenticated
  using (app.can(shop_id, 'reports.shop') or app.is_my_barber(barber_id));
create policy audit_read on public.audit_logs for select to authenticated
  using (shop_id is not null and app.can(shop_id, 'audit.view')
         or organization_id is not null and app.is_org_owner(organization_id));
