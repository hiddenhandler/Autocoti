-- =============================================================================
-- BarberNGo — system owner (platform admin) console
--
-- Three roles run the business: SYSTEM OWNER (BarberNGo itself) → BARBERSHOP
-- OWNERS and independent CHAIR OWNERS (each an organization with a plan) →
-- their barbers and clients. The system owner can:
--   * create accounts (a claimable invitation that provisions org + plan + shop)
--   * give, sell or gift plan months (memberships) and change plans/status
--   * keep a platform cash ledger (payments, refunds, gifts, adjustments)
--   * see platform-wide numbers: MRR, accounts, chair owners, clients, and the
--     money flowing through every shop (GMV, tips) month by month.
-- Nothing here is reachable by shop staff or clients: every function checks
-- app.is_platform_admin() and the tables have RLS with no policies.
-- =============================================================================

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.subscriptions add column if not exists is_comp boolean not null default false;

create type public.platform_entry_kind as enum ('payment', 'refund', 'gift', 'adjustment');

create table public.platform_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete set null,
  kind public.platform_entry_kind not null,
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  months int check (months is null or months between 0 and 60),
  plan_code text,
  method text,
  note text,
  occurred_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index platform_ledger_org_idx on public.platform_ledger (organization_id, occurred_at desc);
create index platform_ledger_time_idx on public.platform_ledger (occurred_at desc);

create table public.account_invites (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name text,
  kind text not null check (kind in ('shop_owner', 'chair_owner')),
  shop_name text not null check (length(trim(shop_name)) between 1 and 120),
  timezone text not null default 'America/New_York',
  plan_code text not null,
  comp_months int not null default 0 check (comp_months between 0 and 36),
  note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz,
  claimed_by uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,
  organization_id uuid references public.organizations (id) on delete set null
);
create index account_invites_email_idx on public.account_invites (email) where claimed_at is null and revoked_at is null;

-- Locked down: only the SECURITY DEFINER functions below touch these tables.
alter table public.platform_admins enable row level security;
alter table public.platform_ledger enable row level security;
alter table public.account_invites enable row level security;
revoke all on public.platform_admins, public.platform_ledger, public.account_invites from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create or replace function app.is_platform_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists (select 1 from public.platform_admins where user_id = auth.uid() and is_active)
$$;

create or replace function app.require_platform_admin()
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform_admin() then perform app.fail('FORBIDDEN'); end if;
end $$;

create or replace function public.am_platform_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_platform_admin()
$$;

-- Monthly price of a plan (yearly plans spread over 12 months).
create or replace function app.plan_monthly_cents(p_plan public.subscription_plans)
returns bigint language sql immutable set search_path = public, pg_temp as $$
  select case when p_plan.billing_interval = 'year' then round(p_plan.price_cents / 12.0)::bigint else p_plan.price_cents end
$$;

-- First free slug based on a name: "fade-factory", "fade-factory-2", ...
create or replace function app.free_slug(p_name text)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare base text := left(nullif(app.slugify(p_name), ''), 50); cand text; n int := 1;
begin
  if base is null or length(base) < 3 then base := 'shop-' || substr(md5(random()::text), 1, 6); end if;
  cand := base;
  while not public.check_slug_available(cand) loop
    n := n + 1;
    cand := base || '-' || n;
  end loop;
  return cand;
end $$;

-- ---------------------------------------------------------------------------
-- Overview & cash flow
-- ---------------------------------------------------------------------------
create or replace function public.admin_overview(p_months int default 12)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_months int := greatest(1, least(coalesce(p_months, 12), 36)); v_from date;
begin
  perform app.require_platform_admin();
  v_from := (date_trunc('month', now()) - make_interval(months => v_months - 1))::date;
  return jsonb_build_object(
    'counts', jsonb_build_object(
      'accounts', (select count(*) from public.organizations where deleted_at is null),
      'shops', (select count(*) from public.shops where deleted_at is null),
      'shop_owners', (select count(distinct o.owner_id) from public.organizations o where o.deleted_at is null),
      'chair_owners', (select count(*) from public.barbers where barber_type = 'chair_owner' and deleted_at is null),
      'barbers', (select count(*) from public.barbers where deleted_at is null),
      'clients', (select count(*) from public.clients where deleted_at is null and merged_into_id is null),
      'pending_invites', (select count(*) from public.account_invites where claimed_at is null and revoked_at is null and expires_at > now())
    ),
    'subscriptions', jsonb_build_object(
      'mrr_cents', (select coalesce(sum(app.plan_monthly_cents(p)), 0) from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id
                     join public.organizations o on o.id = s.organization_id and o.deleted_at is null
                    where s.status in ('active', 'past_due') and not s.is_comp),
      'active', (select count(*) from public.subscriptions where status = 'active' and not is_comp),
      'comped', (select count(*) from public.subscriptions where status = 'active' and is_comp),
      'trialing', (select count(*) from public.subscriptions where status = 'trialing'),
      'past_due', (select count(*) from public.subscriptions where status = 'past_due'),
      'cancelled', (select count(*) from public.subscriptions where status in ('cancelled', 'paused')),
      'trials_ending_7d', (select count(*) from public.subscriptions where status = 'trialing' and trial_ends_at between now() and now() + interval '7 days'),
      'by_plan', (select coalesce(jsonb_agg(x order by x.sort_order), '[]') from (
                   select p.code, p.name, p.sort_order, count(s.id) as accounts,
                          count(s.id) filter (where s.status = 'active' and not s.is_comp) as paying,
                          coalesce(sum(app.plan_monthly_cents(p)) filter (where s.status in ('active', 'past_due') and not s.is_comp), 0) as mrr_cents
                     from public.subscription_plans p left join public.subscriptions s on s.plan_id = p.id
                    group by p.code, p.name, p.sort_order) x)
    ),
    'cashflow', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'month', to_char(m, 'YYYY-MM'),
        'platform_in_cents', (select coalesce(sum(amount_cents), 0) from public.platform_ledger where kind = 'payment' and date_trunc('month', occurred_at) = m),
        'platform_refunds_cents', (select coalesce(sum(amount_cents), 0) from public.platform_ledger where kind = 'refund' and date_trunc('month', occurred_at) = m),
        'gifted_months', (select coalesce(sum(months), 0) from public.platform_ledger where kind = 'gift' and date_trunc('month', occurred_at) = m),
        'gmv_cents', (select coalesce(sum(amount_paid_cents - refunded_cents), 0) from public.payments
                       where voided_at is null and status in ('PAID', 'PARTIAL', 'REFUNDED') and date_trunc('month', coalesce(paid_at, created_at)) = m),
        'tips_cents', (select coalesce(sum(amount_cents), 0) from public.tips where date_trunc('month', created_at) = m),
        'new_accounts', (select count(*) from public.organizations where date_trunc('month', created_at) = m),
        'new_clients', (select count(*) from public.clients where deleted_at is null and date_trunc('month', created_at) = m)
      ) order by m), '[]')
      from generate_series(v_from::timestamptz, date_trunc('month', now()), interval '1 month') m
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Accounts (organizations) and people
-- ---------------------------------------------------------------------------
create or replace function public.admin_accounts(p_search text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare q text := nullif(lower(trim(coalesce(p_search, ''))), '');
begin
  perform app.require_platform_admin();
  return (
    select coalesce(jsonb_agg(row order by (row ->> 'created_at') desc), '[]') from (
      select jsonb_build_object(
        'id', o.id, 'name', o.name, 'created_at', o.created_at,
        'owner', jsonb_build_object('id', u.id, 'email', u.email, 'full_name', pr.full_name, 'last_sign_in_at', u.last_sign_in_at),
        'kind', case when exists (select 1 from public.shops s join public.barbers b on b.shop_id = s.id
                                   where s.organization_id = o.id and b.user_id = o.owner_id and b.barber_type = 'chair_owner')
                     then 'chair_owner' else 'shop_owner' end,
        'plan', jsonb_build_object('code', p.code, 'name', p.name, 'price_cents', p.price_cents, 'interval', p.billing_interval),
        'subscription', jsonb_build_object('status', sub.status, 'is_comp', sub.is_comp, 'trial_ends_at', sub.trial_ends_at,
                                           'current_period_end', sub.current_period_end),
        'shops', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'is_published', s.is_published) order by s.created_at), '[]')
                    from public.shops s where s.organization_id = o.id and s.deleted_at is null),
        'barbers', (select count(*) from public.barbers b join public.shops s on s.id = b.shop_id where s.organization_id = o.id and b.deleted_at is null),
        'chair_owners', (select count(*) from public.barbers b join public.shops s on s.id = b.shop_id
                          where s.organization_id = o.id and b.deleted_at is null and b.barber_type = 'chair_owner'),
        'clients', (select count(*) from public.clients c join public.shops s on s.id = c.shop_id
                     where s.organization_id = o.id and c.deleted_at is null and c.merged_into_id is null),
        'gmv_30d_cents', (select coalesce(sum(pm.amount_paid_cents - pm.refunded_cents), 0) from public.payments pm join public.shops s on s.id = pm.shop_id
                           where s.organization_id = o.id and pm.voided_at is null and pm.status in ('PAID', 'PARTIAL', 'REFUNDED')
                             and coalesce(pm.paid_at, pm.created_at) > now() - interval '30 days'),
        'paid_total_cents', (select coalesce(sum(case when kind = 'payment' then amount_cents when kind = 'refund' then -amount_cents else 0 end), 0)
                               from public.platform_ledger l where l.organization_id = o.id)
      ) as row
      from public.organizations o
      join auth.users u on u.id = o.owner_id
      left join public.profiles pr on pr.id = o.owner_id
      left join public.subscriptions sub on sub.organization_id = o.id
      left join public.subscription_plans p on p.id = sub.plan_id
      where o.deleted_at is null
        and (q is null or lower(o.name) like '%' || q || '%' or lower(u.email) like '%' || q || '%'
             or lower(coalesce(pr.full_name, '')) like '%' || q || '%'
             or exists (select 1 from public.shops s where s.organization_id = o.id and (s.slug like '%' || q || '%' or lower(s.name) like '%' || q || '%')))
      limit 500
    ) t
  );
end $$;

-- Everyone with a login, with what they are in the system.
create or replace function public.admin_people(p_search text default null, p_role text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare q text := nullif(lower(trim(coalesce(p_search, ''))), '');
begin
  perform app.require_platform_admin();
  return (
    select coalesce(jsonb_agg(x order by x ->> 'created_at' desc), '[]') from (
      select jsonb_build_object(
        'id', u.id, 'email', u.email, 'full_name', pr.full_name, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
        'roles', r.roles,
        'shops', (select coalesce(jsonb_agg(distinct s.name), '[]') from public.memberships m
                   join public.shops s on s.organization_id = m.organization_id and (m.shop_id is null or m.shop_id = s.id)
                  where m.user_id = u.id and m.is_active and s.deleted_at is null)
      ) as x
      from auth.users u
      left join public.profiles pr on pr.id = u.id
      cross join lateral (
        select array_remove(array[
          case when exists (select 1 from public.platform_admins a where a.user_id = u.id and a.is_active) then 'system_owner' end,
          case when exists (select 1 from public.organizations o where o.owner_id = u.id and o.deleted_at is null) then 'shop_owner' end,
          case when exists (select 1 from public.barbers b where b.user_id = u.id and b.deleted_at is null and b.barber_type = 'chair_owner') then 'chair_owner' end,
          case when exists (select 1 from public.barbers b where b.user_id = u.id and b.deleted_at is null and b.barber_type = 'employee') then 'barber' end,
          case when exists (select 1 from public.memberships m where m.user_id = u.id and m.is_active and m.role in ('manager', 'receptionist')) then 'staff' end,
          case when exists (select 1 from public.clients c where c.user_id = u.id and c.deleted_at is null) then 'client' end
        ], null) as roles
      ) r
      where (q is null or lower(u.email) like '%' || q || '%' or lower(coalesce(pr.full_name, '')) like '%' || q || '%')
        and (p_role is null or p_role = any (r.roles) or (p_role = 'none' and cardinality(r.roles) = 0))
      limit 500
    ) t
  );
end $$;

-- ---------------------------------------------------------------------------
-- Memberships (plans): change, gift months, sell months, ledger
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_subscription(p_org uuid, p_plan_code text, p_status public.subscription_status, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_plan uuid;
begin
  perform app.require_platform_admin();
  select id into v_plan from public.subscription_plans where code = p_plan_code;
  if v_plan is null then perform app.fail('UNKNOWN_PLAN'); end if;
  insert into public.subscriptions (organization_id, plan_id, status)
  values (p_org, v_plan, p_status)
  on conflict (organization_id) do update
    set plan_id = excluded.plan_id, status = excluded.status,
        is_comp = case when excluded.status = 'active' then public.subscriptions.is_comp else false end,
        cancel_at = case when excluded.status = 'cancelled' then now() else null end,
        updated_at = now();
  insert into public.platform_ledger (organization_id, kind, plan_code, note, created_by)
  values (p_org, 'adjustment', p_plan_code, coalesce(nullif(trim(p_note), ''), 'Plan/status set to ' || p_plan_code || ' / ' || p_status), auth.uid());
end $$;

-- Add months of a plan. p_gift = true → free (comped); otherwise a sale for p_amount_cents.
create or replace function public.admin_grant_months(
  p_org uuid, p_plan_code text, p_months int, p_gift boolean,
  p_amount_cents bigint default 0, p_method text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_plan uuid; v_end timestamptz; v_start timestamptz;
begin
  perform app.require_platform_admin();
  if p_months is null or p_months < 1 or p_months > 36 then perform app.fail('INVALID_MONTHS'); end if;
  if not p_gift and coalesce(p_amount_cents, 0) <= 0 then perform app.fail('AMOUNT_REQUIRED'); end if;
  select id into v_plan from public.subscription_plans where code = p_plan_code;
  if v_plan is null then perform app.fail('UNKNOWN_PLAN'); end if;
  if not exists (select 1 from public.organizations where id = p_org and deleted_at is null) then perform app.fail('NOT_FOUND'); end if;

  -- Extend from the later of now and the current paid-through date.
  select greatest(now(), coalesce(case when status = 'active' then current_period_end end, now())),
         case when status = 'active' and current_period_end > now() then current_period_start else now() end
    into v_end, v_start
    from public.subscriptions where organization_id = p_org;
  v_end := coalesce(v_end, now()) + make_interval(months => p_months);

  insert into public.subscriptions (organization_id, plan_id, status, is_comp, current_period_start, current_period_end)
  values (p_org, v_plan, 'active', p_gift, coalesce(v_start, now()), v_end)
  on conflict (organization_id) do update
    set plan_id = excluded.plan_id, status = 'active', is_comp = excluded.is_comp,
        current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
        trial_ends_at = null, cancel_at = null, updated_at = now();

  insert into public.platform_ledger (organization_id, kind, amount_cents, months, plan_code, method, note, created_by)
  values (p_org, case when p_gift then 'gift' else 'payment' end::public.platform_entry_kind,
          case when p_gift then 0 else p_amount_cents end, p_months, p_plan_code, nullif(trim(coalesce(p_method, '')), ''),
          nullif(trim(coalesce(p_note, '')), ''), auth.uid());
  return jsonb_build_object('current_period_end', v_end, 'is_comp', p_gift);
end $$;

create or replace function public.admin_record_entry(
  p_org uuid, p_kind public.platform_entry_kind, p_amount_cents bigint,
  p_method text default null, p_note text default null, p_occurred_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform app.require_platform_admin();
  if p_kind = 'gift' then perform app.fail('USE_GRANT_MONTHS'); end if;
  if coalesce(p_amount_cents, 0) < 0 then perform app.fail('INVALID_AMOUNT'); end if;
  insert into public.platform_ledger (organization_id, kind, amount_cents, method, note, occurred_at, created_by)
  values (p_org, p_kind, coalesce(p_amount_cents, 0), nullif(trim(coalesce(p_method, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
          coalesce(p_occurred_at, now()), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.admin_ledger(p_org uuid default null, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_platform_admin();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'organization_id', l.organization_id, 'account', o.name, 'kind', l.kind, 'amount_cents', l.amount_cents,
      'months', l.months, 'plan_code', l.plan_code, 'method', l.method, 'note', l.note, 'occurred_at', l.occurred_at,
      'by', coalesce(pr.full_name, u.email)
    ) order by l.occurred_at desc), '[]')
    from (select * from public.platform_ledger where p_org is null or organization_id = p_org
           order by occurred_at desc limit greatest(1, least(coalesce(p_limit, 200), 1000))) l
    left join public.organizations o on o.id = l.organization_id
    left join auth.users u on u.id = l.created_by
    left join public.profiles pr on pr.id = l.created_by
  );
end $$;

-- ---------------------------------------------------------------------------
-- Creating accounts: a claimable invitation
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_account(
  p_email text, p_full_name text, p_kind text, p_shop_name text,
  p_plan_code text default 'shop', p_comp_months int default 0,
  p_timezone text default 'America/New_York', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text := lower(trim(p_email)); v_token uuid; v_id uuid;
begin
  perform app.require_platform_admin();
  if p_kind not in ('shop_owner', 'chair_owner') then perform app.fail('INVALID_KIND'); end if;
  if not exists (select 1 from public.subscription_plans where code = p_plan_code) then perform app.fail('UNKNOWN_PLAN'); end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then perform app.fail('INVALID_TIMEZONE'); end if;
  update public.account_invites set revoked_at = now()
   where email = v_email and claimed_at is null and revoked_at is null;
  insert into public.account_invites (email, full_name, kind, shop_name, timezone, plan_code, comp_months, note, created_by)
  values (v_email, nullif(trim(p_full_name), ''), p_kind, trim(p_shop_name), p_timezone, p_plan_code,
          coalesce(p_comp_months, 0), nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning id, token into v_id, v_token;
  return jsonb_build_object('id', v_id, 'token', v_token, 'claim_url', '/claim/' || v_token);
end $$;

create or replace function public.admin_invites()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_platform_admin();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'token', i.token, 'email', i.email, 'full_name', i.full_name, 'kind', i.kind, 'shop_name', i.shop_name,
      'plan_code', i.plan_code, 'comp_months', i.comp_months, 'created_at', i.created_at, 'expires_at', i.expires_at,
      'status', case when i.claimed_at is not null then 'claimed' when i.revoked_at is not null then 'revoked'
                     when i.expires_at < now() then 'expired' else 'pending' end,
      'claimed_at', i.claimed_at, 'organization_id', i.organization_id
    ) order by i.created_at desc), '[]')
    from (select * from public.account_invites order by created_at desc limit 300) i
  );
end $$;

create or replace function public.admin_revoke_invite(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_platform_admin();
  update public.account_invites set revoked_at = now() where id = p_id and claimed_at is null;
end $$;

-- Public: what an account invitation offers (no email shown in full to strangers).
create or replace function public.get_account_invite(p_token uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'email_hint', regexp_replace(i.email, '^(.)[^@]*', '\1•••'),
    'full_name', i.full_name, 'kind', i.kind, 'shop_name', i.shop_name,
    'plan_name', p.name, 'comp_months', i.comp_months,
    'status', case when i.claimed_at is not null then 'claimed' when i.revoked_at is not null or i.expires_at < now() then 'expired' else 'pending' end)
  from public.account_invites i join public.subscription_plans p on p.code = i.plan_code
  where i.token = p_token
$$;

-- The invited person (signed in with the invited email) activates their account.
create or replace function public.claim_account_invite(p_token uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := app.require_auth();
  v_email text := (select lower(email) from auth.users where id = v_uid);
  i public.account_invites;
  v_plan uuid; v_org uuid; v_shop uuid; v_barber uuid; d int;
begin
  select * into i from public.account_invites where token = p_token for update;
  if i.id is null then perform app.fail('NOT_FOUND'); end if;
  if i.claimed_at is not null then perform app.fail('ALREADY_CLAIMED'); end if;
  if i.revoked_at is not null or i.expires_at < now() then perform app.fail('INVITATION_EXPIRED'); end if;
  if v_email is distinct from i.email then perform app.fail('EMAIL_MISMATCH'); end if;
  select id into v_plan from public.subscription_plans where code = i.plan_code;

  if i.full_name is not null then
    update public.profiles set full_name = coalesce(nullif(full_name, ''), i.full_name) where id = v_uid;
  end if;

  insert into public.organizations (name, owner_id) values (i.shop_name, v_uid) returning id into v_org;
  if i.comp_months > 0 then
    insert into public.subscriptions (organization_id, plan_id, status, is_comp, current_period_start, current_period_end)
    values (v_org, v_plan, 'active', true, now(), now() + make_interval(months => i.comp_months));
    insert into public.platform_ledger (organization_id, kind, months, plan_code, note, created_by)
    values (v_org, 'gift', i.comp_months, i.plan_code, 'Gifted with account invitation', i.created_by);
  else
    insert into public.subscriptions (organization_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
    values (v_org, v_plan, 'trialing', now() + interval '14 days', now(), now() + interval '14 days');
  end if;
  insert into public.memberships (organization_id, shop_id, user_id, role) values (v_org, null, v_uid, 'owner');

  insert into public.shops (organization_id, name, slug, timezone)
  values (v_org, i.shop_name, app.free_slug(i.shop_name), i.timezone) returning id into v_shop;
  for d in 2..6 loop
    insert into public.business_hours (shop_id, weekday, opens_at, closes_at) values (v_shop, d, '09:00', '19:00');
  end loop;

  -- A chair owner cuts in their own chair and keeps 100%.
  if i.kind = 'chair_owner' then
    insert into public.barbers (shop_id, user_id, display_name, barber_type)
    values (v_shop, v_uid, coalesce(i.full_name, (select full_name from public.profiles where id = v_uid), 'Chair owner'), 'chair_owner')
    returning id into v_barber;
    insert into public.commissions (shop_id, barber_id, type, percent_bps, created_by)
    values (v_shop, v_barber, 'percentage', 10000, v_uid);
  end if;

  update public.account_invites set claimed_by = v_uid, claimed_at = now(), organization_id = v_org where id = i.id;
  return v_shop;
end $$;

-- Grant / revoke system owner access for another login (by email).
create or replace function public.admin_set_platform_admin(p_email text, p_on boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid;
begin
  perform app.require_platform_admin();
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then perform app.fail('NOT_FOUND', 'No account with that email yet'); end if;
  if not p_on and v_user = auth.uid() then perform app.fail('FORBIDDEN', 'You cannot remove yourself'); end if;
  -- Access is switched off, never deleted, so the history of who had it stays.
  insert into public.platform_admins (user_id, is_active) values (v_user, p_on)
  on conflict (user_id) do update set is_active = excluded.is_active;
end $$;

revoke execute on function public.admin_overview(int), public.admin_accounts(text), public.admin_people(text, text),
  public.admin_update_subscription(uuid, text, public.subscription_status, text),
  public.admin_grant_months(uuid, text, int, boolean, bigint, text, text),
  public.admin_record_entry(uuid, public.platform_entry_kind, bigint, text, text, timestamptz),
  public.admin_ledger(uuid, int), public.admin_create_account(text, text, text, text, text, int, text, text),
  public.admin_invites(), public.admin_revoke_invite(uuid), public.claim_account_invite(uuid),
  public.admin_set_platform_admin(text, boolean), public.am_platform_admin()
  from public, anon;
grant execute on function public.admin_overview(int), public.admin_accounts(text), public.admin_people(text, text),
  public.admin_update_subscription(uuid, text, public.subscription_status, text),
  public.admin_grant_months(uuid, text, int, boolean, bigint, text, text),
  public.admin_record_entry(uuid, public.platform_entry_kind, bigint, text, text, timestamptz),
  public.admin_ledger(uuid, int), public.admin_create_account(text, text, text, text, text, int, text, text),
  public.admin_invites(), public.admin_revoke_invite(uuid), public.claim_account_invite(uuid),
  public.admin_set_platform_admin(text, boolean), public.am_platform_admin()
  to authenticated;
grant execute on function public.get_account_invite(uuid) to anon, authenticated;
grant execute on function app.is_platform_admin(), app.require_platform_admin(), app.plan_monthly_cents(public.subscription_plans), app.free_slug(text)
  to authenticated, service_role;
