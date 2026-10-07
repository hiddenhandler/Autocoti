-- =============================================================================
-- BarberNGo — chairs, employee vs chair owner, chair rent, inventory,
-- expenses and finance.
--
--   SHOP → CHAIRS → BARBERS → CUSTOMERS → APPOINTMENTS → PAYMENTS → ANALYTICS
--
-- * A barber is either an EMPLOYEE (the shop controls schedule, services,
--   pricing and pays a commission) or a CHAIR OWNER (an independent business
--   inside the shop: keeps 100% of service revenue, controls own schedule,
--   services and prices, pays chair rent, runs own inventory and expenses).
-- * Chair owners' inventory and expenses are private to them. The shop owner
--   sees shop-level information: chairs, live status, appointments, rent.
-- * Stock only moves through RPCs, so stock_qty always equals the movement log.
-- =============================================================================

create type public.barber_type as enum ('employee', 'chair_owner');

alter table public.barbers
  add column barber_type public.barber_type not null default 'employee',
  -- Live presence set by the barber ("Take a break", "Go offline").
  -- 'auto' = status is derived from schedule + calendar.
  add column presence text not null default 'auto' check (presence in ('auto', 'break', 'offline')),
  add column presence_until timestamptz,
  add column presence_updated_at timestamptz;

alter table public.shop_settings
  add column product_commission_bps int not null default 1000 check (product_commission_bps between 0 and 10000),
  add column barbers_can_set_prices boolean not null default false,       -- employees editing their own prices
  add column employees_manage_schedule boolean not null default true,     -- employees editing their weekly hours
  add column sms_channel text not null default 'whatsapp' check (sms_channel in ('none', 'sms', 'whatsapp')),
  add column queue_almost_ready_minutes int not null default 10 check (queue_almost_ready_minutes between 2 and 60),
  add column rent_due_days int not null default 3 check (rent_due_days between 0 and 31);

-- Services a chair owner created for themselves (NULL = shop service).
alter table public.services add column owner_barber_id uuid references public.barbers (id) on delete cascade;
create index services_owner_barber on public.services (owner_barber_id) where owner_barber_id is not null;

-- ---------------------------------------------------------------------------
-- Chairs
-- ---------------------------------------------------------------------------
create table public.chairs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 40),
  position int not null default 0,
  barber_id uuid references public.barbers (id) on delete set null,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index chairs_barber_unique on public.chairs (barber_id) where barber_id is not null;
create unique index chairs_shop_label on public.chairs (shop_id, lower(label));
create index chairs_shop on public.chairs (shop_id, position);
create trigger chairs_touch before update on public.chairs for each row execute function app.touch_updated_at();

create or replace function app.chairs_check_tenant()
returns trigger language plpgsql as $$
begin
  if new.barber_id is not null and app.barber_shop(new.barber_id) is distinct from new.shop_id then
    perform app.fail('BARBER_NOT_IN_SHOP');
  end if;
  return new;
end $$;
create trigger chairs_check_tenant before insert or update of barber_id, shop_id on public.chairs
  for each row execute function app.chairs_check_tenant();

-- ---------------------------------------------------------------------------
-- Chair rent ledger (chair owners / hybrid barbers)
-- ---------------------------------------------------------------------------
create table public.rent_charges (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid not null references public.barbers (id) on delete cascade,
  chair_id uuid references public.chairs (id) on delete set null,
  period text not null check (period in ('week', 'month')),
  period_start date not null,
  period_end date not null,
  due_date date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  paid_cents bigint not null default 0 check (paid_cents >= 0),
  waived boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (barber_id, period_start, period),
  check (period_end >= period_start)
);
create index rent_charges_shop on public.rent_charges (shop_id, period_start desc);
create trigger rent_charges_touch before update on public.rent_charges for each row execute function app.touch_updated_at();

create table public.rent_payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  rent_charge_id uuid not null references public.rent_charges (id) on delete cascade,
  barber_id uuid not null references public.barbers (id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  method public.payment_method not null default 'cash',
  note text,
  recorded_by uuid references auth.users (id),
  paid_at timestamptz not null default now()
);
create index rent_payments_shop on public.rent_payments (shop_id, paid_at);
create index rent_payments_barber on public.rent_payments (barber_id, paid_at);

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  owner_barber_id uuid references public.barbers (id) on delete cascade, -- NULL = shop inventory
  name text not null check (length(trim(name)) between 1 and 120),
  brand text,
  sku text,
  category text,
  -- retail: sold to clients · backbar: used during services (blades, wax, neck strips)
  kind text not null default 'retail' check (kind in ('retail', 'backbar')),
  unit text not null default 'unit',
  cost_cents bigint not null default 0 check (cost_cents >= 0),
  price_cents bigint not null default 0 check (price_cents >= 0),
  stock_qty int not null default 0,
  low_stock_at int not null default 2 check (low_stock_at >= 0),
  supplier text,
  photo_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index products_shop on public.products (shop_id) where deleted_at is null;
create index products_owner on public.products (owner_barber_id) where owner_barber_id is not null;
create unique index products_sku on public.products (shop_id, coalesce(owner_barber_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(sku))
  where sku is not null and deleted_at is null;
create trigger products_touch before update on public.products for each row execute function app.touch_updated_at();

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  owner_barber_id uuid references public.barbers (id) on delete cascade, -- denormalised from the product (privacy)
  barber_id uuid references public.barbers (id) on delete set null,      -- who sold / used it
  kind text not null check (kind in ('purchase', 'sale', 'use', 'adjustment', 'waste', 'return', 'count')),
  qty_delta int not null,
  stock_after int not null,
  unit_cost_cents bigint,
  unit_price_cents bigint,
  payment_id uuid references public.payments (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index inventory_movements_product on public.inventory_movements (product_id, created_at desc);
create index inventory_movements_shop on public.inventory_movements (shop_id, created_at);

alter table public.payment_items add column product_id uuid references public.products (id) on delete set null;

-- Product sales in the earnings ledger. product_revenue_cents = net sale value,
-- product_cents = the barber's share (100% of their own products, a
-- commission on shop products).
alter table public.barber_earnings
  add column product_revenue_cents bigint not null default 0,
  add column product_cents bigint not null default 0;
alter table public.barber_earnings drop constraint barber_earnings_kind_check;
alter table public.barber_earnings add constraint barber_earnings_kind_check
  check (kind in ('service', 'tip', 'adjustment', 'rent', 'refund', 'product', 'product_own'));

-- ---------------------------------------------------------------------------
-- Expenses (shop or a chair owner's own business)
-- ---------------------------------------------------------------------------
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid references public.barbers (id) on delete cascade, -- NULL = shop expense
  category text not null check (category in (
    'rent', 'utilities', 'supplies', 'products', 'equipment', 'payroll', 'marketing', 'software', 'fees', 'taxes',
    'maintenance', 'education', 'transport', 'other')),
  amount_cents bigint not null check (amount_cents > 0),
  spent_on date not null,
  vendor text,
  note text,
  method public.payment_method not null default 'cash',
  receipt_url text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index expenses_shop on public.expenses (shop_id, spent_on) where deleted_at is null;
create index expenses_barber on public.expenses (barber_id, spent_on) where barber_id is not null and deleted_at is null;
create trigger expenses_touch before update on public.expenses for each row execute function app.touch_updated_at();

create or replace function app.expenses_check_tenant()
returns trigger language plpgsql as $$
begin
  if new.barber_id is not null and app.barber_shop(new.barber_id) is distinct from new.shop_id then
    perform app.fail('BARBER_NOT_IN_SHOP');
  end if;
  return new;
end $$;
create trigger expenses_check_tenant before insert or update of barber_id, shop_id on public.expenses
  for each row execute function app.expenses_check_tenant();

-- ---------------------------------------------------------------------------
-- Permissions: inventory + finance
-- ---------------------------------------------------------------------------
create or replace function app.role_grants(p_role public.staff_role)
returns text[] language sql immutable as $$
  select case p_role
    when 'owner' then array['*']
    when 'manager' then array[
      'shop.view', 'shop.settings', 'staff.manage', 'services.manage', 'schedule.manage_all',
      'calendar.all', 'clients.all', 'payments.view', 'payments.record', 'payments.refund',
      'reports.shop', 'marketing.manage', 'walkins.manage', 'waitlist.manage', 'reviews.manage',
      'notifications.view', 'inventory.manage']
    when 'receptionist' then array[
      'shop.view', 'calendar.all', 'clients.all', 'payments.view', 'payments.record',
      'walkins.manage', 'waitlist.manage', 'inventory.sell']
    when 'barber' then array[
      'shop.view', 'calendar.own', 'clients.own', 'payments.record_own', 'walkins.serve', 'inventory.sell']
  end
$$;

create or replace function app.is_chair_owner(p_barber uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.barbers where id = p_barber and barber_type = 'chair_owner')
$$;

-- Product visibility: shop inventory → shop staff; a chair owner's inventory → that chair owner only.
create or replace function app.can_see_product(p_shop uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_owner is null then app.is_staff(p_shop) else app.is_my_barber(p_owner) end
$$;

create or replace function app.can_manage_product(p_shop uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_owner is null then app.can(p_shop, 'inventory.manage') else app.is_my_barber(p_owner) end
$$;

-- Employees edit their own weekly hours only if the shop allows it.
create or replace function app.can_edit_schedule(p_barber uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select app.can(app.barber_shop(p_barber), 'schedule.manage_all')
      or (app.is_my_barber(p_barber)
          and (app.is_chair_owner(p_barber)
               or coalesce((select employees_manage_schedule from public.shop_settings where shop_id = app.barber_shop(p_barber)), true)))
$$;

drop policy availability_write on public.availability;
create policy availability_write on public.availability for all to authenticated
  using (app.can_edit_schedule(barber_id)) with check (app.can_edit_schedule(barber_id));

create or replace function public.set_weekly_schedule(p_barber_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_auth();
  if not app.can_edit_schedule(p_barber_id) then
    perform app.fail('FORBIDDEN', 'Your shop manages your schedule');
  end if;
  delete from public.availability where barber_id = p_barber_id;
  insert into public.availability (barber_id, weekday, starts_at, ends_at, kind, label)
  select p_barber_id, (r ->> 'weekday')::smallint, (r ->> 'starts_at')::time, (r ->> 'ends_at')::time,
         coalesce(r ->> 'kind', 'work'), r ->> 'label'
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
end $$;

-- Barbers may only pick shop services or their own private services.
create or replace function public.set_barber_services(p_barber_id uuid, p_service_ids uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id);
begin
  perform app.require_auth();
  if not (app.is_my_barber(p_barber_id) or app.can(v_shop, 'staff.manage') or app.can(v_shop, 'services.manage')) then
    perform app.fail('FORBIDDEN');
  end if;
  if exists (select 1 from unnest(p_service_ids) sid where not exists
             (select 1 from public.services s where s.id = sid and s.shop_id = v_shop
                 and (s.owner_barber_id is null or s.owner_barber_id = p_barber_id))) then
    perform app.fail('SERVICE_NOT_IN_SHOP');
  end if;
  update public.barber_services set is_active = (service_id = any (p_service_ids)) where barber_id = p_barber_id;
  insert into public.barber_services (barber_id, service_id)
  select p_barber_id, sid from unnest(p_service_ids) sid
  on conflict (barber_id, service_id) do update set is_active = true;
end $$;

-- A chair owner (or an employee when the shop allows it) sets their own price/duration.
create or replace function public.set_my_service_price(
  p_barber_id uuid, p_service_id uuid, p_price_cents bigint, p_duration_minutes int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id);
begin
  perform app.require_auth();
  if not (app.can(v_shop, 'staff.manage') or app.can(v_shop, 'services.manage')
          or (app.is_my_barber(p_barber_id)
              and (app.is_chair_owner(p_barber_id)
                   or (select barbers_can_set_prices from public.shop_settings where shop_id = v_shop)))) then
    perform app.fail('FORBIDDEN', 'Your shop sets your prices');
  end if;
  if p_price_cents is not null and p_price_cents < 0 then perform app.fail('INVALID_AMOUNT'); end if;
  if not exists (select 1 from public.services s where s.id = p_service_id and s.shop_id = v_shop
                    and (s.owner_barber_id is null or s.owner_barber_id = p_barber_id)) then
    perform app.fail('SERVICE_NOT_IN_SHOP');
  end if;
  insert into public.barber_services (barber_id, service_id, price_cents, duration_minutes, is_active)
  values (p_barber_id, p_service_id, p_price_cents, p_duration_minutes, true)
  on conflict (barber_id, service_id) do update
    set price_cents = excluded.price_cents, duration_minutes = excluded.duration_minutes, is_active = true;
end $$;

-- A chair owner creates / edits a service that only they offer.
create or replace function public.save_my_service(
  p_barber_id uuid, p_service_id uuid, p_name text, p_price_cents bigint, p_duration_minutes int,
  p_description text default null, p_is_public boolean default true, p_is_active boolean default true)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id); v_id uuid := p_service_id;
begin
  perform app.require_auth();
  if not ((app.is_my_barber(p_barber_id) and app.is_chair_owner(p_barber_id)) or app.can(v_shop, 'services.manage')) then
    perform app.fail('FORBIDDEN', 'Only chair owners create their own services');
  end if;
  if v_id is null then
    insert into public.services (shop_id, owner_barber_id, name, description, price_cents, duration_minutes, is_public, is_active)
    values (v_shop, p_barber_id, trim(p_name), p_description, p_price_cents, p_duration_minutes,
            coalesce(p_is_public, true), coalesce(p_is_active, true))
    returning id into v_id;
  else
    update public.services
       set name = trim(p_name), description = p_description, price_cents = p_price_cents, duration_minutes = p_duration_minutes,
           is_public = coalesce(p_is_public, true), is_active = coalesce(p_is_active, true)
     where id = v_id and owner_barber_id = p_barber_id;
    if not found then perform app.fail('NOT_FOUND'); end if;
  end if;
  insert into public.barber_services (barber_id, service_id, is_active) values (p_barber_id, v_id, coalesce(p_is_active, true))
  on conflict (barber_id, service_id) do update set is_active = excluded.is_active, price_cents = null, duration_minutes = null;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Chairs & barber type RPCs
-- ---------------------------------------------------------------------------
-- Employee ⇄ chair owner. Chair owners get a booth-rental plan (keep 100%,
-- pay rent); employees get a commission plan.
create or replace function public.set_barber_type(
  p_barber_id uuid, p_type public.barber_type,
  p_rent_cents bigint default null, p_rent_period text default 'week', p_percent_bps int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid := app.barber_shop(p_barber_id); v_current public.commissions;
begin
  perform app.require(v_shop, 'staff.manage');
  perform app.require(v_shop, 'commissions.manage');
  update public.barbers set barber_type = p_type where id = p_barber_id;
  v_current := app.commission_rule(p_barber_id, now());
  if p_type = 'chair_owner' then
    if p_rent_cents is null or p_rent_cents < 0 then perform app.fail('RENT_REQUIRED'); end if;
    perform public.set_commission(p_barber_id, 'booth_rental', null, null, null, p_rent_cents,
                                  coalesce(p_rent_period, 'week'), 10000);
  else
    perform public.set_commission(p_barber_id, 'percentage',
      coalesce(p_percent_bps, case when v_current.type in ('percentage', 'hybrid') then v_current.percent_bps end, 5000),
      null, null, null, null, coalesce(v_current.tip_share_bps, 10000));
  end if;
end $$;

create or replace function public.save_chair(
  p_shop_id uuid, p_chair_id uuid, p_label text, p_barber_id uuid default null,
  p_is_active boolean default true, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := p_chair_id;
begin
  perform app.require(p_shop_id, 'staff.manage');
  -- A barber sits in one chair: moving them frees the old one.
  if p_barber_id is not null then
    update public.chairs set barber_id = null where barber_id = p_barber_id and id is distinct from v_id;
  end if;
  if v_id is null then
    insert into public.chairs (shop_id, label, barber_id, is_active, notes, position)
    values (p_shop_id, trim(p_label), p_barber_id, coalesce(p_is_active, true), p_notes,
            coalesce((select max(position) + 1 from public.chairs where shop_id = p_shop_id), 1))
    returning id into v_id;
  else
    update public.chairs set label = trim(p_label), barber_id = p_barber_id, is_active = coalesce(p_is_active, true), notes = p_notes
     where id = v_id and shop_id = p_shop_id;
    if not found then perform app.fail('NOT_FOUND'); end if;
  end if;
  return v_id;
exception when unique_violation then
  perform app.fail('CHAIR_LABEL_TAKEN');
end $$;

create or replace function public.delete_chair(p_chair_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_shop uuid;
begin
  select shop_id into v_shop from public.chairs where id = p_chair_id;
  perform app.require(v_shop, 'staff.manage');
  delete from public.chairs where id = p_chair_id;
end $$;

-- ---------------------------------------------------------------------------
-- Rent: charges are generated from the barber's commission plan
-- (booth_rental / hybrid with rent_cents) for each week / month.
-- ---------------------------------------------------------------------------
create or replace function app.sync_rent_charges(p_shop uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text; v_today date; v_due_days int; b record; d date; c public.commissions; v_n int := 0; v_start date;
begin
  select s.timezone, ss.rent_due_days into v_tz, v_due_days
    from public.shops s join public.shop_settings ss on ss.shop_id = s.id where s.id = p_shop;
  v_today := (now() at time zone v_tz)::date;
  for b in
    select br.id, br.created_at, (select ch.id from public.chairs ch where ch.barber_id = br.id) chair_id,
           (select min(cm.effective_from) from public.commissions cm
             where cm.barber_id = br.id and cm.type in ('booth_rental', 'hybrid') and coalesce(cm.rent_cents, 0) > 0) first_rent
      from public.barbers br
     where br.shop_id = p_shop and br.deleted_at is null and br.status <> 'archived'
  loop
    continue when b.first_rent is null;
    v_start := greatest(b.first_rent, v_today - 366);
    -- Candidate period starts: every Monday and every 1st of the month.
    for d in
      select x::date from generate_series(date_trunc('week', v_start)::date, v_today, interval '1 week') x
      union
      select x::date from generate_series(date_trunc('month', v_start)::date, v_today, interval '1 month') x
    loop
      c := app.commission_rule(b.id, app.local_ts(greatest(d, b.first_rent), '12:00', v_tz));
      continue when c.id is null or c.type not in ('booth_rental', 'hybrid') or coalesce(c.rent_cents, 0) <= 0;
      continue when (c.rent_period = 'week' and extract(isodow from d) <> 1)
                 or (c.rent_period = 'month' and extract(day from d) <> 1);
      insert into public.rent_charges (shop_id, barber_id, chair_id, period, period_start, period_end, due_date, amount_cents)
      values (p_shop, b.id, b.chair_id, c.rent_period, d,
              case when c.rent_period = 'week' then d + 6 else (d + interval '1 month')::date - 1 end,
              d + v_due_days, c.rent_cents)
      on conflict (barber_id, period_start, period) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end loop;
  return v_n;
end $$;

create or replace function app.rent_status(r public.rent_charges, p_today date)
returns text language sql immutable as $$
  select case when r.waived then 'waived'
              when r.paid_cents >= r.amount_cents then 'paid'
              when r.due_date < p_today then 'overdue'
              when r.paid_cents > 0 then 'partial'
              else 'due' end
$$;

-- Rent ledger for the shop (finance.manage) or for one barber (that barber).
create or replace function public.rent_ledger(p_shop_id uuid, p_barber_id uuid default null)
returns table (id uuid, barber_id uuid, barber_name text, chair_label text, period text, period_start date, period_end date,
               due_date date, amount_cents bigint, paid_cents bigint, balance_cents bigint, status text, waived boolean, note text)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_today date;
begin
  perform app.require_auth();
  if not (app.can(p_shop_id, 'finance.manage') or (p_barber_id is not null and app.is_my_barber(p_barber_id)
          and app.barber_shop(p_barber_id) = p_shop_id)) then
    perform app.fail('FORBIDDEN');
  end if;
  perform app.sync_rent_charges(p_shop_id);
  select (now() at time zone timezone)::date into v_today from public.shops where id = p_shop_id;
  return query
    select r.id, r.barber_id, b.display_name, ch.label, r.period, r.period_start, r.period_end, r.due_date,
           r.amount_cents, r.paid_cents, case when r.waived then 0 else greatest(r.amount_cents - r.paid_cents, 0) end,
           app.rent_status(r, v_today), r.waived, r.note
      from public.rent_charges r
      join public.barbers b on b.id = r.barber_id
      left join public.chairs ch on ch.id = r.chair_id
     where r.shop_id = p_shop_id and (p_barber_id is null or r.barber_id = p_barber_id)
     order by r.period_start desc, b.display_name;
end $$;

-- The shop records rent it received (cash, transfer…). Overpayment is refused.
create or replace function public.record_rent_payment(
  p_charge_id uuid, p_amount_cents bigint, p_method public.payment_method default 'cash', p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rent_charges;
begin
  select * into r from public.rent_charges where id = p_charge_id for update;
  if r.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(r.shop_id, 'finance.manage');
  if p_amount_cents is null or p_amount_cents <= 0 or r.paid_cents + p_amount_cents > r.amount_cents then
    perform app.fail('INVALID_AMOUNT');
  end if;
  insert into public.rent_payments (shop_id, rent_charge_id, barber_id, amount_cents, method, note, recorded_by)
  values (r.shop_id, r.id, r.barber_id, p_amount_cents, coalesce(p_method, 'cash'), p_note, auth.uid());
  update public.rent_charges set paid_cents = paid_cents + p_amount_cents where id = r.id returning * into r;
  return jsonb_build_object('paid_cents', r.paid_cents, 'balance_cents', r.amount_cents - r.paid_cents);
end $$;

create or replace function public.set_rent_charge(p_charge_id uuid, p_waived boolean default null,
                                                  p_amount_cents bigint default null, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rent_charges;
begin
  select * into r from public.rent_charges where id = p_charge_id for update;
  if r.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(r.shop_id, 'finance.manage');
  if p_amount_cents is not null and (p_amount_cents < r.paid_cents or p_amount_cents < 0) then perform app.fail('INVALID_AMOUNT'); end if;
  update public.rent_charges
     set waived = coalesce(p_waived, waived), amount_cents = coalesce(p_amount_cents, amount_cents), note = coalesce(p_note, note)
   where id = r.id;
end $$;

-- ---------------------------------------------------------------------------
-- Inventory RPCs
-- ---------------------------------------------------------------------------
create or replace function public.save_product(
  p_shop_id uuid, p_product_id uuid, p_name text,
  p_owner_barber_id uuid default null, p_kind text default 'retail', p_brand text default null, p_sku text default null,
  p_category text default null, p_cost_cents bigint default 0, p_price_cents bigint default 0, p_low_stock_at int default 2,
  p_supplier text default null, p_unit text default 'unit', p_is_active boolean default true, p_initial_qty int default 0)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := p_product_id; p public.products;
begin
  perform app.require_auth();
  if p_owner_barber_id is not null and app.barber_shop(p_owner_barber_id) is distinct from p_shop_id then
    perform app.fail('BARBER_NOT_IN_SHOP');
  end if;
  if v_id is null then
    if not app.can_manage_product(p_shop_id, p_owner_barber_id) then perform app.fail('FORBIDDEN'); end if;
    insert into public.products (shop_id, owner_barber_id, name, brand, sku, category, kind, unit, cost_cents, price_cents,
                                 low_stock_at, supplier, is_active)
    values (p_shop_id, p_owner_barber_id, trim(p_name), nullif(trim(p_brand), ''), nullif(trim(p_sku), ''), nullif(trim(p_category), ''),
            coalesce(p_kind, 'retail'), coalesce(nullif(trim(p_unit), ''), 'unit'), coalesce(p_cost_cents, 0), coalesce(p_price_cents, 0),
            coalesce(p_low_stock_at, 2), nullif(trim(p_supplier), ''), coalesce(p_is_active, true))
    returning id into v_id;
    if coalesce(p_initial_qty, 0) > 0 then
      perform public.move_stock(v_id, 'purchase', p_initial_qty, p_cost_cents, 'Opening stock');
    end if;
  else
    select * into p from public.products where id = v_id and deleted_at is null;
    if p.id is null or p.shop_id <> p_shop_id then perform app.fail('NOT_FOUND'); end if;
    if not app.can_manage_product(p.shop_id, p.owner_barber_id) then perform app.fail('FORBIDDEN'); end if;
    update public.products
       set name = trim(p_name), brand = nullif(trim(p_brand), ''), sku = nullif(trim(p_sku), ''), category = nullif(trim(p_category), ''),
           kind = coalesce(p_kind, kind), unit = coalesce(nullif(trim(p_unit), ''), unit), cost_cents = coalesce(p_cost_cents, cost_cents),
           price_cents = coalesce(p_price_cents, price_cents), low_stock_at = coalesce(p_low_stock_at, low_stock_at),
           supplier = nullif(trim(p_supplier), ''), is_active = coalesce(p_is_active, is_active)
     where id = v_id;
  end if;
  return v_id;
exception when unique_violation then
  perform app.fail('SKU_TAKEN');
end $$;

create or replace function public.archive_product(p_product_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.products;
begin
  select * into p from public.products where id = p_product_id;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  if not app.can_manage_product(p.shop_id, p.owner_barber_id) then perform app.fail('FORBIDDEN'); end if;
  update public.products set deleted_at = now(), is_active = false where id = p.id;
end $$;

-- Move stock. purchase (+, updates unit cost) · use / waste (−) · return (+) ·
-- adjustment (±) · count (sets the absolute quantity after a physical count).
-- Any barber may log 'use' of shop back-bar products.
create or replace function public.move_stock(
  p_product_id uuid, p_kind text, p_qty int, p_unit_cost_cents bigint default null, p_note text default null,
  p_appointment_id uuid default null)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.products; v_delta int; v_after int; v_me uuid;
begin
  perform app.require_auth();
  select * into p from public.products where id = p_product_id and deleted_at is null for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  if not (app.can_manage_product(p.shop_id, p.owner_barber_id)
          or (p_kind = 'use' and p.owner_barber_id is null and app.is_staff(p.shop_id))) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_qty is null or (p_kind <> 'adjustment' and p_kind <> 'count' and p_qty <= 0) or (p_kind = 'count' and p_qty < 0) then
    perform app.fail('INVALID_QUANTITY');
  end if;
  v_delta := case p_kind
               when 'purchase' then p_qty when 'return' then p_qty
               when 'use' then -p_qty when 'waste' then -p_qty
               when 'adjustment' then p_qty
               when 'count' then p_qty - p.stock_qty
             end;
  if v_delta is null then perform app.fail('INVALID_KIND'); end if;
  if p.stock_qty + v_delta < 0 then perform app.fail('OUT_OF_STOCK', p.name || ': ' || p.stock_qty || ' left'); end if;
  update public.products
     set stock_qty = stock_qty + v_delta,
         cost_cents = case when p_kind = 'purchase' and p_unit_cost_cents is not null then p_unit_cost_cents else cost_cents end
   where id = p.id returning stock_qty into v_after;
  select b.id into v_me from public.barbers b where b.user_id = auth.uid() and b.shop_id = p.shop_id and b.deleted_at is null limit 1;
  insert into public.inventory_movements (shop_id, product_id, owner_barber_id, barber_id, kind, qty_delta, stock_after,
                                          unit_cost_cents, appointment_id, note, created_by)
  values (p.shop_id, p.id, p.owner_barber_id, v_me, p_kind, v_delta, v_after,
          case when p_kind = 'purchase' then coalesce(p_unit_cost_cents, p.cost_cents) else p.cost_cents end,
          p_appointment_id, p_note, auth.uid());
  return v_after;
end $$;

-- Sell retail products (at the chair or the front desk).
-- p_items: [{"product_id": "...", "quantity": 1, "price_cents": 1500}]  (price defaults to the list price)
-- A barber's own products: 100% to the barber. Shop products: the seller gets
-- the shop's product commission, the shop keeps the rest.
create or replace function public.sell_products(
  p_shop_id uuid, p_items jsonb, p_barber_id uuid default null, p_method public.payment_method default 'cash',
  p_client_id uuid default null, p_appointment_id uuid default null, p_discount_cents bigint default 0)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ss public.shop_settings;
  i record;
  p public.products;
  v_payment uuid;
  v_subtotal bigint := 0;
  v_discount bigint := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax bigint;
  v_total bigint;
  v_shop_rev bigint := 0;   -- shop products
  v_own_rev bigint := 0;    -- seller's own products
  v_ratio numeric;
  v_after int;
  v_comm bigint;
begin
  perform app.require_auth();
  if not (app.can(p_shop_id, 'payments.record')
          or (p_barber_id is not null and app.is_my_barber(p_barber_id) and app.can(p_shop_id, 'payments.record_own'))) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_barber_id is not null and app.barber_shop(p_barber_id) is distinct from p_shop_id then perform app.fail('BARBER_NOT_IN_SHOP'); end if;
  if p_client_id is not null and not exists (select 1 from public.clients where id = p_client_id and shop_id = p_shop_id) then
    perform app.fail('CLIENT_NOT_IN_SHOP');
  end if;
  if p_appointment_id is not null and not exists (select 1 from public.appointments where id = p_appointment_id and shop_id = p_shop_id) then
    perform app.fail('NOT_FOUND');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then perform app.fail('ITEMS_REQUIRED'); end if;
  select * into ss from public.shop_settings where shop_id = p_shop_id;

  insert into public.payments (shop_id, appointment_id, client_id, barber_id, kind, subtotal_cents, discount_cents, tax_cents,
                               tip_cents, total_cents, amount_paid_cents, method, status, provider, recorded_by)
  values (p_shop_id, p_appointment_id,
          coalesce(p_client_id, (select client_id from public.appointments where id = p_appointment_id)),
          p_barber_id, 'product', 0, 0, 0, 0, 0, 0, coalesce(p_method, 'cash'), 'PAID', 'manual', auth.uid())
  returning id into v_payment;

  for i in
    select (x ->> 'product_id')::uuid product_id, greatest(coalesce((x ->> 'quantity')::int, 1), 1) qty,
           (x ->> 'price_cents')::bigint price
      from jsonb_array_elements(p_items) x
  loop
    select * into p from public.products where id = i.product_id and shop_id = p_shop_id and deleted_at is null and is_active for update;
    if p.id is null then perform app.fail('PRODUCT_NOT_FOUND'); end if;
    if p.owner_barber_id is not null and p.owner_barber_id is distinct from p_barber_id then
      perform app.fail('PRODUCT_NOT_YOURS', p.name);
    end if;
    if coalesce(i.price, p.price_cents) < 0 then perform app.fail('INVALID_AMOUNT'); end if;
    if p.stock_qty < i.qty then perform app.fail('OUT_OF_STOCK', p.name || ': ' || p.stock_qty || ' left'); end if;
    update public.products set stock_qty = stock_qty - i.qty where id = p.id returning stock_qty into v_after;
    insert into public.inventory_movements (shop_id, product_id, owner_barber_id, barber_id, kind, qty_delta, stock_after,
                                            unit_cost_cents, unit_price_cents, payment_id, appointment_id, created_by)
    values (p_shop_id, p.id, p.owner_barber_id, p_barber_id, 'sale', -i.qty, v_after, p.cost_cents,
            coalesce(i.price, p.price_cents), v_payment, p_appointment_id, auth.uid());
    insert into public.payment_items (payment_id, product_id, description, quantity, unit_price_cents, total_cents)
    values (v_payment, p.id, p.name, i.qty, coalesce(i.price, p.price_cents), coalesce(i.price, p.price_cents) * i.qty);
    v_subtotal := v_subtotal + coalesce(i.price, p.price_cents) * i.qty;
    if p.owner_barber_id is null then v_shop_rev := v_shop_rev + coalesce(i.price, p.price_cents) * i.qty;
    else v_own_rev := v_own_rev + coalesce(i.price, p.price_cents) * i.qty; end if;
  end loop;

  v_discount := least(v_discount, v_subtotal);
  v_tax := case when ss.prices_include_tax then 0 else round((v_subtotal - v_discount) * ss.tax_rate_bps / 10000.0)::bigint end;
  v_total := v_subtotal - v_discount + v_tax;
  update public.payments
     set subtotal_cents = v_subtotal, discount_cents = v_discount, tax_cents = v_tax, total_cents = v_total, amount_paid_cents = v_total
   where id = v_payment;

  -- Discount is shared pro-rata between shop and own products.
  v_ratio := case when v_subtotal > 0 then (v_subtotal - v_discount)::numeric / v_subtotal else 0 end;
  if p_barber_id is not null and v_own_rev > 0 then
    insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, product_revenue_cents, product_cents, shop_cents)
    values (p_shop_id, p_barber_id, v_payment, p_appointment_id, 'product_own',
            round(v_own_rev * v_ratio)::bigint, round(v_own_rev * v_ratio)::bigint, 0);
  end if;
  if v_shop_rev > 0 and p_barber_id is not null then
    v_comm := round(round(v_shop_rev * v_ratio) * ss.product_commission_bps / 10000.0)::bigint;
    insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, product_revenue_cents, product_cents, shop_cents)
    values (p_shop_id, p_barber_id, v_payment, p_appointment_id, 'product',
            round(v_shop_rev * v_ratio)::bigint, v_comm, round(v_shop_rev * v_ratio)::bigint - v_comm);
  end if;
  return jsonb_build_object('payment_id', v_payment, 'subtotal_cents', v_subtotal, 'discount_cents', v_discount,
                            'tax_cents', v_tax, 'total_cents', v_total);
end $$;

-- Refunds reverse product earnings too; voids put sold products back on the shelf.
create or replace function public.refund_payment(p_payment_id uuid, p_amount_cents bigint, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; v_ratio numeric; e record;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(p.shop_id, 'payments.refund');
  if p.status in ('VOID', 'REFUNDED') then perform app.fail('INVALID_STATUS'); end if;
  if p_amount_cents <= 0 or p.refunded_cents + p_amount_cents > p.amount_paid_cents then perform app.fail('INVALID_AMOUNT'); end if;

  insert into public.refunds (payment_id, amount_cents, reason, refunded_by) values (p.id, p_amount_cents, p_reason, auth.uid());
  update public.payments
     set refunded_cents = refunded_cents + p_amount_cents,
         status = case when refunded_cents + p_amount_cents >= amount_paid_cents then 'REFUNDED' else status end
   where id = p.id;
  update public.appointments set payment_status = 'REFUNDED'
   where id = p.appointment_id and p.kind = 'service' and p.refunded_cents + p_amount_cents >= p.amount_paid_cents;

  v_ratio := p_amount_cents::numeric / nullif(p.total_cents, 0);
  select coalesce(sum(service_revenue_cents), 0) sr, coalesce(sum(commission_cents), 0) cc,
         coalesce(sum(tip_cents), 0) tc, coalesce(sum(shop_cents), 0) sc,
         coalesce(sum(product_revenue_cents), 0) pr, coalesce(sum(product_cents), 0) pc
    into e from public.barber_earnings where payment_id = p.id and kind <> 'refund';
  if p.barber_id is not null then
    insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, service_revenue_cents,
                                        commission_cents, tip_cents, shop_cents, product_revenue_cents, product_cents)
    values (p.shop_id, p.barber_id, p.id, p.appointment_id, 'refund',
            -round(e.sr * v_ratio)::bigint, -round(e.cc * v_ratio)::bigint, -round(e.tc * v_ratio)::bigint, -round(e.sc * v_ratio)::bigint,
            -round(e.pr * v_ratio)::bigint, -round(e.pc * v_ratio)::bigint);
  end if;
end $$;

create or replace function public.void_payment(p_payment_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; m record; v_after int;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  -- A barber can void their own product sale on the same day (wrong item rung up).
  if not (app.can(p.shop_id, 'payments.refund')
          or (p.kind = 'product' and app.is_my_barber(p.barber_id) and p.paid_at > now() - interval '12 hours')) then
    perform app.fail('FORBIDDEN');
  end if;
  if p.status = 'VOID' then return; end if;
  if p.refunded_cents > 0 then perform app.fail('ALREADY_REFUNDED'); end if;
  update public.payments set status = 'VOID', voided_at = now(), notes = concat_ws(' · ', notes, 'Voided: ' || p_reason) where id = p.id;
  delete from public.barber_earnings where payment_id = p.id;
  delete from public.tips where payment_id = p.id;
  delete from public.loyalty_ledger where payment_id = p.id;
  if p.kind = 'service' then
    update public.appointments set payment_status = 'UNPAID' where id = p.appointment_id;
  end if;
  for m in select * from public.inventory_movements where payment_id = p.id and kind = 'sale' loop
    update public.products set stock_qty = stock_qty - m.qty_delta where id = m.product_id returning stock_qty into v_after;
    insert into public.inventory_movements (shop_id, product_id, owner_barber_id, barber_id, kind, qty_delta, stock_after,
                                            unit_cost_cents, payment_id, note, created_by)
    values (m.shop_id, m.product_id, m.owner_barber_id, m.barber_id, 'return', -m.qty_delta, v_after, m.unit_cost_cents,
            p.id, 'Sale voided', auth.uid());
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Finance: money in / money out for the shop, or for one barber's business.
-- Cash basis: inventory purchases count when bought; rent when paid.
-- ---------------------------------------------------------------------------
create or replace function public.finance_summary(p_shop_id uuid, p_from date, p_to date, p_barber_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text; v_from timestamptz; v_to timestamptz; v_today date;
  v_private boolean;      -- may see this barber's private expenses & inventory
  v_in jsonb; v_out jsonb; v_series jsonb; v_extra jsonb;
  v_in_total bigint; v_out_total bigint;
begin
  perform app.require_auth();
  if p_to < p_from or p_to - p_from > 400 then perform app.fail('INVALID_RANGE'); end if;
  select timezone into v_tz from public.shops where id = p_shop_id;
  v_from := app.local_ts(p_from, '00:00', v_tz);
  v_to := app.local_ts(p_to + 1, '00:00', v_tz);
  v_today := (now() at time zone v_tz)::date;
  perform app.sync_rent_charges(p_shop_id);

  if p_barber_id is null then
    -- =============================== SHOP ===============================
    perform app.require(p_shop_id, 'finance.manage');
    with e as (
      select * from public.barber_earnings
       where shop_id = p_shop_id and earned_at >= v_from and earned_at < v_to
    )
    select jsonb_build_object(
      'services_cents', coalesce((select sum(service_revenue_cents) from e where coalesce(commission_snapshot ->> 'type', '') <> 'booth_rental'
                                                                        and kind in ('service', 'refund')), 0)
                        -- refunds of chair-owner tickets are not the shop's money either
                        - coalesce((select sum(e2.service_revenue_cents) from e e2
                                     where e2.kind = 'refund' and exists (select 1 from public.barber_earnings o
                                       where o.payment_id = e2.payment_id and o.kind = 'service'
                                         and o.commission_snapshot ->> 'type' = 'booth_rental')), 0),
      'products_cents', coalesce((select sum(product_revenue_cents) from e where kind = 'product'), 0)
                        + coalesce((select sum(e3.product_revenue_cents) from e e3 where e3.kind = 'refund'
                                     and exists (select 1 from public.barber_earnings o where o.payment_id = e3.payment_id and o.kind = 'product')
                                     and not exists (select 1 from public.barber_earnings o where o.payment_id = e3.payment_id and o.kind = 'product_own')), 0)
                        + coalesce((select sum(p.subtotal_cents - p.discount_cents) from public.payments p
                                     where p.shop_id = p_shop_id and p.kind = 'product' and p.barber_id is null and p.status <> 'VOID'
                                       and p.paid_at >= v_from and p.paid_at < v_to), 0),
      'rent_cents', coalesce((select sum(amount_cents) from public.rent_payments where shop_id = p_shop_id and paid_at >= v_from and paid_at < v_to), 0),
      'fees_cents', coalesce((select sum(subtotal_cents) from public.payments where shop_id = p_shop_id and kind in ('no_show_fee', 'late_cancel_fee')
                                and status <> 'VOID' and paid_at >= v_from and paid_at < v_to), 0),
      'tips_kept_cents', coalesce((select sum(shop_cents) from e where kind = 'tip'), 0)
    ) into v_in;

    with e as (
      select * from public.barber_earnings
       where shop_id = p_shop_id and earned_at >= v_from and earned_at < v_to
    )
    select jsonb_build_object(
      'commissions_cents', coalesce((select sum(commission_cents) from e where coalesce(commission_snapshot ->> 'type', '') <> 'booth_rental'
                                                                        and kind in ('service', 'refund')), 0)
                           - coalesce((select sum(e2.commission_cents) from e e2
                                        where e2.kind = 'refund' and exists (select 1 from public.barber_earnings o
                                          where o.payment_id = e2.payment_id and o.kind = 'service'
                                            and o.commission_snapshot ->> 'type' = 'booth_rental')), 0),
      'product_commissions_cents', coalesce((select sum(product_cents) from e where kind = 'product'), 0),
      'inventory_cents', coalesce((select sum(m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                                    where m.shop_id = p_shop_id and m.owner_barber_id is null and m.kind = 'purchase'
                                      and m.created_at >= v_from and m.created_at < v_to), 0),
      'expenses_cents', coalesce((select sum(amount_cents) from public.expenses where shop_id = p_shop_id and barber_id is null
                                     and deleted_at is null and spent_on between p_from and p_to), 0)
    ) into v_out;

    v_extra := jsonb_build_object(
      'pass_through', jsonb_build_object(
        'chair_owner_services_cents', coalesce((select sum(service_revenue_cents) from public.barber_earnings
                                                 where shop_id = p_shop_id and earned_at >= v_from and earned_at < v_to
                                                   and kind = 'service' and commission_snapshot ->> 'type' = 'booth_rental'), 0),
        'tips_to_barbers_cents', coalesce((select sum(tip_cents) from public.barber_earnings
                                            where shop_id = p_shop_id and earned_at >= v_from and earned_at < v_to), 0)),
      'collected_by_method', (select coalesce(jsonb_object_agg(method, cents), '{}') from (
                                select method, sum(amount_paid_cents - refunded_cents) cents from public.payments
                                 where shop_id = p_shop_id and status <> 'VOID' and paid_at >= v_from and paid_at < v_to
                                 group by method) x),
      'rent', jsonb_build_object(
        'outstanding_cents', coalesce((select sum(greatest(amount_cents - paid_cents, 0)) from public.rent_charges
                                        where shop_id = p_shop_id and not waived and period_start <= v_today), 0),
        'overdue_count', (select count(*) from public.rent_charges r where r.shop_id = p_shop_id and app.rent_status(r, v_today) = 'overdue')),
      'inventory', jsonb_build_object(
        'value_cents', coalesce((select sum(greatest(stock_qty, 0) * cost_cents) from public.products
                                  where shop_id = p_shop_id and owner_barber_id is null and deleted_at is null), 0),
        'retail_value_cents', coalesce((select sum(greatest(stock_qty, 0) * price_cents) from public.products
                                         where shop_id = p_shop_id and owner_barber_id is null and deleted_at is null and kind = 'retail'), 0),
        'low_stock', (select count(*) from public.products where shop_id = p_shop_id and owner_barber_id is null
                        and deleted_at is null and is_active and stock_qty <= low_stock_at),
        'cogs_cents', coalesce((select sum(-m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                                 where m.shop_id = p_shop_id and m.owner_barber_id is null and m.kind in ('sale', 'return')
                                   and m.payment_id is not null and m.created_at >= v_from and m.created_at < v_to), 0)),
      'expenses_by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'cents', cents) order by cents desc), '[]') from (
                                 select category, sum(amount_cents) cents from public.expenses
                                  where shop_id = p_shop_id and barber_id is null and deleted_at is null and spent_on between p_from and p_to
                                  group by category) x),
      -- What each barber earned (payroll) and owes (rent) in the period.
      'barbers', (select coalesce(jsonb_agg(row_to_json(x) order by x.name), '[]') from (
                    select b.id barber_id, b.display_name name, b.barber_type,
                           coalesce(sum(e.service_revenue_cents) filter (where e.kind in ('service', 'refund')), 0) services_cents,
                           coalesce(sum(e.commission_cents), 0) commission_cents,
                           coalesce(sum(e.tip_cents), 0) tips_cents,
                           coalesce(sum(e.product_cents) filter (where e.kind = 'product'), 0) product_commission_cents,
                           case when b.barber_type = 'employee'
                                then coalesce(sum(e.commission_cents), 0) + coalesce(sum(e.tip_cents), 0)
                                     + coalesce(sum(e.product_cents) filter (where e.kind = 'product'), 0) end payout_cents,
                           (select coalesce(sum(rp.amount_cents), 0) from public.rent_payments rp
                             where rp.barber_id = b.id and rp.paid_at >= v_from and rp.paid_at < v_to) rent_paid_cents,
                           (select coalesce(sum(greatest(r.amount_cents - r.paid_cents, 0)), 0) from public.rent_charges r
                             where r.barber_id = b.id and not r.waived and r.period_start <= v_today) rent_balance_cents
                      from public.barbers b
                      left join public.barber_earnings e on e.barber_id = b.id and e.earned_at >= v_from and e.earned_at < v_to
                     where b.shop_id = p_shop_id and b.deleted_at is null
                     group by b.id) x)
    );

    select coalesce(jsonb_agg(jsonb_build_object('date', d, 'in_cents', i, 'out_cents', o) order by d), '[]') into v_series from (
      select g::date d,
             coalesce((select sum(e.service_revenue_cents - e.commission_cents + e.product_revenue_cents - e.product_cents)
                         from public.barber_earnings e
                        where e.shop_id = p_shop_id and e.kind in ('service', 'refund', 'product')
                          and coalesce(e.commission_snapshot ->> 'type', '') <> 'booth_rental'
                          and (e.earned_at at time zone v_tz)::date = g::date), 0)
             + coalesce((select sum(amount_cents) from public.rent_payments rp where rp.shop_id = p_shop_id
                          and (rp.paid_at at time zone v_tz)::date = g::date), 0) i,
             coalesce((select sum(amount_cents) from public.expenses x where x.shop_id = p_shop_id and x.barber_id is null
                          and x.deleted_at is null and x.spent_on = g::date), 0)
             + coalesce((select sum(m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                          where m.shop_id = p_shop_id and m.owner_barber_id is null and m.kind = 'purchase'
                            and (m.created_at at time zone v_tz)::date = g::date), 0) o
        from generate_series(p_from, p_to, interval '1 day') g) s;
  else
    -- ============================ ONE BARBER ============================
    if app.barber_shop(p_barber_id) is distinct from p_shop_id then perform app.fail('BARBER_NOT_IN_SHOP'); end if;
    if not app.can_view_barber_money(p_shop_id, p_barber_id) then perform app.fail('FORBIDDEN'); end if;
    v_private := app.is_my_barber(p_barber_id);

    with e as (
      select * from public.barber_earnings
       where barber_id = p_barber_id and earned_at >= v_from and earned_at < v_to
    )
    select jsonb_build_object(
      'services_cents', coalesce((select sum(commission_cents) from e where kind in ('service', 'refund', 'adjustment')), 0),
      'tips_cents', coalesce((select sum(tip_cents) from e), 0),
      'products_cents', coalesce((select sum(product_cents) from e where kind = 'product_own'), 0)
                        + coalesce((select sum(e2.product_cents) from e e2 where e2.kind = 'refund'
                                     and exists (select 1 from public.barber_earnings o where o.payment_id = e2.payment_id and o.kind = 'product_own')), 0),
      'product_commissions_cents', coalesce((select sum(product_cents) from e where kind = 'product'), 0)
                        + coalesce((select sum(e3.product_cents) from e e3 where e3.kind = 'refund'
                                     and exists (select 1 from public.barber_earnings o where o.payment_id = e3.payment_id and o.kind = 'product')
                                     and not exists (select 1 from public.barber_earnings o where o.payment_id = e3.payment_id and o.kind = 'product_own')), 0),
      'gross_services_cents', coalesce((select sum(service_revenue_cents) from e where kind in ('service', 'refund')), 0)
    ) into v_in;

    select jsonb_build_object(
      'rent_cents', coalesce((select sum(amount_cents) from public.rent_payments where barber_id = p_barber_id
                                 and paid_at >= v_from and paid_at < v_to), 0),
      'inventory_cents', case when v_private then coalesce((select sum(m.qty_delta * coalesce(m.unit_cost_cents, 0))
                                 from public.inventory_movements m where m.owner_barber_id = p_barber_id and m.kind = 'purchase'
                                  and m.created_at >= v_from and m.created_at < v_to), 0) else 0 end,
      'expenses_cents', case when v_private then coalesce((select sum(amount_cents) from public.expenses where barber_id = p_barber_id
                                 and deleted_at is null and spent_on between p_from and p_to), 0) else 0 end
    ) into v_out;

    v_extra := jsonb_build_object(
      'barber_type', (select barber_type from public.barbers where id = p_barber_id),
      'private', v_private,
      'cuts', (select count(*) from public.appointments where barber_id = p_barber_id and status = 'COMPLETED' and kind = 'appointment'
                  and coalesce(completed_at, ends_at) >= v_from and coalesce(completed_at, ends_at) < v_to),
      'rent', jsonb_build_object(
        'charged_cents', coalesce((select sum(amount_cents) from public.rent_charges where barber_id = p_barber_id and not waived
                                     and period_start between p_from and p_to), 0),
        'outstanding_cents', coalesce((select sum(greatest(amount_cents - paid_cents, 0)) from public.rent_charges
                                        where barber_id = p_barber_id and not waived and period_start <= v_today), 0),
        'next_due', (select jsonb_build_object('due_date', r.due_date, 'balance_cents', r.amount_cents - r.paid_cents, 'period_start', r.period_start)
                       from public.rent_charges r where r.barber_id = p_barber_id and not r.waived and r.paid_cents < r.amount_cents
                       order by r.due_date limit 1),
        'plan', (select jsonb_build_object('type', c.type, 'rent_cents', c.rent_cents, 'rent_period', c.rent_period, 'percent_bps', c.percent_bps)
                   from app.commission_rule(p_barber_id, now()) c where c.id is not null)),
      'inventory', case when v_private then jsonb_build_object(
        'value_cents', coalesce((select sum(greatest(stock_qty, 0) * cost_cents) from public.products
                                  where owner_barber_id = p_barber_id and deleted_at is null), 0),
        'low_stock', (select count(*) from public.products where owner_barber_id = p_barber_id and deleted_at is null
                        and is_active and stock_qty <= low_stock_at),
        'cogs_cents', coalesce((select sum(-m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                                 where m.owner_barber_id = p_barber_id and m.kind in ('sale', 'return') and m.payment_id is not null
                                   and m.created_at >= v_from and m.created_at < v_to), 0)) end,
      'expenses_by_category', case when v_private then (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'cents', cents) order by cents desc), '[]') from (
                                 select category, sum(amount_cents) cents from public.expenses
                                  where barber_id = p_barber_id and deleted_at is null and spent_on between p_from and p_to
                                  group by category) x) else '[]'::jsonb end
    );

    select coalesce(jsonb_agg(jsonb_build_object('date', d, 'in_cents', i, 'out_cents', o) order by d), '[]') into v_series from (
      select g::date d,
             coalesce((select sum(e.commission_cents + e.tip_cents + e.product_cents) from public.barber_earnings e
                        where e.barber_id = p_barber_id and (e.earned_at at time zone v_tz)::date = g::date), 0) i,
             coalesce((select sum(amount_cents) from public.rent_payments rp where rp.barber_id = p_barber_id
                          and (rp.paid_at at time zone v_tz)::date = g::date), 0)
             + case when v_private then
                 coalesce((select sum(amount_cents) from public.expenses x where x.barber_id = p_barber_id
                              and x.deleted_at is null and x.spent_on = g::date), 0)
                 + coalesce((select sum(m.qty_delta * coalesce(m.unit_cost_cents, 0)) from public.inventory_movements m
                              where m.owner_barber_id = p_barber_id and m.kind = 'purchase'
                                and (m.created_at at time zone v_tz)::date = g::date), 0)
               else 0 end o
        from generate_series(p_from, p_to, interval '1 day') g) s;
  end if;

  select coalesce(sum(value::bigint), 0) into v_in_total from jsonb_each_text(v_in) where key <> 'gross_services_cents';
  select coalesce(sum(value::bigint), 0) into v_out_total from jsonb_each_text(v_out);
  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz,
                                 'currency', (select currency from public.shop_settings where shop_id = p_shop_id)),
    'scope', case when p_barber_id is null then 'shop' else 'barber' end,
    'money_in', v_in, 'money_out', v_out,
    'total_in_cents', v_in_total, 'total_out_cents', v_out_total, 'net_cents', v_in_total - v_out_total,
    'series', v_series) || v_extra;
end $$;

-- ---------------------------------------------------------------------------
-- Workspaces: expose barber type + the new permissions to the app shell.
-- ---------------------------------------------------------------------------
drop function public.my_workspaces();
create function public.my_workspaces()
returns table (shop_id uuid, shop_name text, shop_slug text, organization_id uuid, role public.staff_role,
               barber_id uuid, barber_type public.barber_type, timezone text, accent_color text, is_published boolean, permissions text[])
language sql stable security definer set search_path = public, pg_temp as $$
  with ms as (
    select s.id as shop_id, s.name, s.slug, s.organization_id, m.role, s.timezone, s.accent_color, s.is_published,
           row_number() over (partition by s.id order by array_position(array['owner','manager','receptionist','barber']::public.staff_role[], m.role)) rn
      from public.memberships m
      join public.shops s on s.organization_id = m.organization_id and (m.shop_id is null or m.shop_id = s.id)
     where m.user_id = auth.uid() and m.is_active and s.deleted_at is null
  )
  select ms.shop_id, ms.name, ms.slug, ms.organization_id, ms.role, b.id, b.barber_type,
         ms.timezone, ms.accent_color, ms.is_published,
         array(select p from unnest(array[
           'shop.settings','staff.manage','services.manage','schedule.manage_all','calendar.all','clients.all',
           'payments.view','payments.record','payments.refund','reports.shop','marketing.manage','walkins.manage',
           'waitlist.manage','reviews.manage','commissions.manage','financials.all_barbers','audit.view',
           'billing','notifications.view','*private_notes','inventory.manage','inventory.sell','finance.manage']) p
                where app.can(ms.shop_id, p))
    from ms
    left join lateral (select b.id, b.barber_type from public.barbers b
                        where b.shop_id = ms.shop_id and b.user_id = auth.uid() and b.deleted_at is null limit 1) b on true
   where rn = 1
   order by ms.name
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security for the new tables
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['chairs', 'rent_charges', 'rent_payments', 'products', 'inventory_movements', 'expenses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

create policy chairs_read on public.chairs for select to authenticated using (app.is_staff(shop_id));
-- chairs are written through save_chair / delete_chair

create policy rent_charges_read on public.rent_charges for select to authenticated
  using (app.can(shop_id, 'finance.manage') or app.is_my_barber(barber_id));
create policy rent_payments_read on public.rent_payments for select to authenticated
  using (app.can(shop_id, 'finance.manage') or app.is_my_barber(barber_id));

create policy products_read on public.products for select to authenticated
  using (app.can_see_product(shop_id, owner_barber_id));
create policy inventory_movements_read on public.inventory_movements for select to authenticated
  using (app.can_see_product(shop_id, owner_barber_id));

create policy expenses_read on public.expenses for select to authenticated
  using (deleted_at is null and case when barber_id is null then app.can(shop_id, 'finance.manage') else app.is_my_barber(barber_id) end);
create policy expenses_insert on public.expenses for insert to authenticated
  with check (created_by = auth.uid()
              and case when barber_id is null then app.can(shop_id, 'finance.manage') else app.is_my_barber(barber_id) end);
create policy expenses_update on public.expenses for update to authenticated
  using (case when barber_id is null then app.can(shop_id, 'finance.manage') else app.is_my_barber(barber_id) end)
  with check (case when barber_id is null then app.can(shop_id, 'finance.manage') else app.is_my_barber(barber_id) end);

-- Audit trail for the money-adjacent tables.
do $$
declare t text;
begin
  foreach t in array array['chairs', 'rent_charges', 'rent_payments', 'products', 'expenses'] loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function app.audit()', t || '_audit', t);
  end loop;
end $$;

grant execute on all functions in schema app to authenticated, anon, service_role;
