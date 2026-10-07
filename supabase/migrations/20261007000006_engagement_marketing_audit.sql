-- =============================================================================
-- Reviews, notifications, marketing, analytics snapshots, audit log
-- =============================================================================

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  appointment_id uuid unique references public.appointments (id) on delete set null,
  client_id uuid references public.clients (id) on delete set null,
  barber_id uuid references public.barbers (id) on delete set null,
  barber_rating smallint check (barber_rating between 1 and 5),
  shop_rating smallint check (shop_rating between 1 and 5),
  comment text check (length(comment) <= 2000),
  is_public boolean not null default true,
  owner_reply text,
  replied_at timestamptz,
  hidden_at timestamptz,
  created_at timestamptz not null default now(),
  check (barber_rating is not null or shop_rating is not null)
);
create index reviews_shop_time on public.reviews (shop_id, created_at desc);
create index reviews_barber on public.reviews (barber_id, created_at desc);

-- Review request token per completed appointment (for guest clients).
alter table public.appointments add column review_token uuid unique default gen_random_uuid();

-- ---------------------------------------------------------------------------
-- Notifications: an outbox. Rows are created by database events; a
-- dispatcher (Edge Function on a schedule) delivers them through channel
-- adapters (email now; SMS / WhatsApp / push later — no schema change).
-- ---------------------------------------------------------------------------
create table public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops (id) on delete cascade, -- NULL = platform default
  event text not null,
  channel public.notification_channel not null,
  subject text,
  body text not null,  -- {{client_first_name}}, {{barber_name}}, {{when}}, {{manage_url}}, ...
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index notification_templates_unique on public.notification_templates
  (coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), event, channel);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  event text not null,
  channel public.notification_channel not null default 'email',
  audience text not null default 'client' check (audience in ('client', 'staff', 'owner')),
  client_id uuid references public.clients (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete cascade,
  waitlist_id uuid references public.waitlist (id) on delete cascade,
  to_address text,
  payload jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null default now(),
  status public.notification_status not null default 'queued',
  attempts int not null default 0,
  last_error text,
  provider_ref text,
  sent_at timestamptz,
  read_at timestamptz,          -- in-app notifications
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index notifications_due on public.notifications (scheduled_for) where status = 'queued';
create index notifications_shop on public.notifications (shop_id, created_at desc);
create index notifications_user_inbox on public.notifications (user_id, created_at desc) where channel = 'in_app';
create index notifications_appt on public.notifications (appointment_id);

insert into public.notification_templates (shop_id, event, channel, subject, body) values
  (null, 'appointment.created', 'email', 'You''re booked at {{shop_name}}',
   'Hey {{client_first_name}} 👋 Your {{service_name}} with {{barber_name}} is confirmed for {{when}}.\n\nNeed to change it? {{manage_url}}'),
  (null, 'appointment.confirmed', 'email', 'Appointment confirmed',
   'Hey {{client_first_name}}, {{barber_name}} confirmed your {{service_name}} on {{when}}.'),
  (null, 'appointment.cancelled', 'email', 'Your appointment was cancelled',
   'Hey {{client_first_name}}, your {{service_name}} on {{when}} was cancelled. Book again any time: {{book_url}}'),
  (null, 'appointment.rescheduled', 'email', 'Your appointment moved',
   'Hey {{client_first_name}}, your {{service_name}} with {{barber_name}} is now {{when}}. {{manage_url}}'),
  (null, 'appointment.reminder', 'email', 'Reminder: {{service_name}} {{relative_when}}',
   'Hey {{client_first_name}} 👋 Your {{service_name}} with {{barber_name}} is {{relative_when}} at {{time}}.\n\nConfirm: {{confirm_url}}\nReschedule or cancel: {{manage_url}}'),
  (null, 'appointment.starting_soon', 'email', '{{barber_name}} is almost ready for you',
   'Hey {{client_first_name}}, your chair is ready in about 15 minutes.'),
  (null, 'barber.running_late', 'email', '{{barber_name}} is running a few minutes late',
   'Hey {{client_first_name}}, {{barber_name}} is running about {{minutes}} minutes behind. Sorry for the wait!'),
  (null, 'waitlist.slot_available', 'email', 'A spot opened with {{barber_name}}',
   'Good news {{client_first_name}}! An appointment opened with {{barber_name}} at {{when}}. First to claim it gets it: {{claim_url}}'),
  (null, 'appointment.no_show', 'email', 'We missed you today',
   'Hey {{client_first_name}}, we missed you for your {{service_name}} at {{time}}. Rebook here: {{book_url}}'),
  (null, 'payment.recorded', 'email', 'Receipt from {{shop_name}}',
   'Thanks {{client_first_name}}! Total paid: {{total}}.'),
  (null, 'review.request', 'email', 'How was your cut?',
   'Hey {{client_first_name}}, how was your cut with {{barber_name}}? Tap to rate: {{review_url}}'),
  (null, 'rebooking.reminder', 'email', 'Time for a fresh cut?',
   'Hey {{client_first_name}}, it''s been {{days}} days since your last cut with {{barber_name}}. Book your next one: {{book_url}}'),
  (null, 'staff.new_booking', 'in_app', 'New booking',
   '{{client_name}} booked {{service_name}} for {{when}}.'),
  (null, 'staff.cancellation', 'in_app', 'Cancellation',
   '{{client_name}} cancelled {{service_name}} on {{when}}.');

-- ---------------------------------------------------------------------------
-- Marketing / acquisition
-- ---------------------------------------------------------------------------
create table public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  code text not null check (code = upper(code) and length(code) between 2 and 32),
  description text,
  discount_type text not null check (discount_type in ('percent', 'amount')),
  discount_value bigint not null check (discount_value > 0), -- bps for percent, cents for amount
  max_redemptions int,
  redemptions int not null default 0,
  per_client_limit int default 1,
  first_visit_only boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (shop_id, code)
);
create or replace function app.promo_normalize()
returns trigger language plpgsql as $$
begin
  new.code := upper(trim(new.code));
  return new;
end $$;
create trigger promo_codes_normalize before insert or update of code on public.promo_codes
  for each row execute function app.promo_normalize();
alter table public.payments add constraint payments_promo_fk foreign key (promo_code_id) references public.promo_codes (id);

create table public.gift_cards (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  initial_cents bigint not null check (initial_cents > 0),
  balance_cents bigint not null check (balance_cents >= 0),
  purchaser_client_id uuid references public.clients (id) on delete set null,
  recipient_name text,
  recipient_email text,
  message text,
  expires_at date,
  status text not null default 'active' check (status in ('active', 'redeemed', 'expired', 'void')),
  issued_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (balance_cents <= initial_cents)
);
create index gift_cards_shop on public.gift_cards (shop_id);
alter table public.payments add constraint payments_gift_card_fk foreign key (gift_card_id) references public.gift_cards (id);

create table public.gift_card_transactions (
  id uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references public.gift_cards (id) on delete cascade,
  payment_id uuid references public.payments (id) on delete set null,
  amount_cents bigint not null, -- negative = redemption, positive = issue/top-up
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.membership_plans (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null,
  description text,
  price_cents bigint not null check (price_cents >= 0),
  billing_interval text not null default 'month' check (billing_interval in ('week', 'month', 'year')),
  included_visits int,              -- NULL = unlimited
  included_service_ids uuid[] not null default '{}',
  discount_bps int not null default 0, -- discount on services beyond the allowance
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.client_memberships (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  plan_id uuid not null references public.membership_plans (id),
  status text not null default 'active' check (status in ('active', 'paused', 'cancelled', 'past_due')),
  current_period_start date not null default current_date,
  current_period_end date not null,
  visits_used int not null default 0,
  provider text,
  provider_ref text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index client_memberships_client on public.client_memberships (client_id);

create table public.membership_usage (
  id uuid primary key default gen_random_uuid(),
  client_membership_id uuid not null references public.client_memberships (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  used_at timestamptz not null default now()
);

create table public.loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  points int not null,              -- positive earn, negative redeem
  reason text not null,             -- 'visit', 'referral', 'birthday', 'redeem', 'adjustment'
  payment_id uuid references public.payments (id) on delete set null,
  created_at timestamptz not null default now()
);
create index loyalty_client on public.loyalty_ledger (client_id);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  referrer_client_id uuid not null references public.clients (id) on delete cascade,
  referred_client_id uuid not null unique references public.clients (id) on delete cascade,
  rewarded_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null,
  type text not null check (type in ('reactivation', 'birthday', 'book_again', 'review_request', 'promo', 'custom')),
  channel public.notification_channel not null default 'email',
  audience jsonb not null default '{}'::jsonb, -- e.g. {"health": ["AT_RISK","LOST"]}
  subject text,
  body text not null,
  promo_code_id uuid references public.promo_codes (id) on delete set null,
  is_automated boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sent', 'active', 'paused')),
  scheduled_for timestamptz,
  sent_count int not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Analytics snapshots (daily rollups for fast long-range reporting)
-- ---------------------------------------------------------------------------
create table public.analytics_snapshots (
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid references public.barbers (id) on delete cascade,
  day date not null,
  metrics jsonb not null,
  computed_at timestamptz not null default now()
);
create unique index analytics_snapshots_key on public.analytics_snapshots
  (shop_id, coalesce(barber_id, '00000000-0000-0000-0000-000000000000'::uuid), day);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid,
  shop_id uuid,
  actor_id uuid,
  actor_role text,
  action text not null,           -- insert | update | delete | rpc name
  entity text not null,           -- table name
  entity_id text,
  changes jsonb,                  -- {"field": [old, new]} for updates
  snapshot jsonb,                 -- full row for insert/delete
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index audit_logs_shop_time on public.audit_logs (shop_id, created_at desc);
create index audit_logs_entity on public.audit_logs (entity, entity_id);

create or replace function app.audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changes jsonb;
  v_shop uuid;
  v_org uuid;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_array(v_old -> key, value))
      into v_changes
      from jsonb_each(v_new)
     where v_old -> key is distinct from value
       and key not in ('updated_at', 'blocked_until');
    if v_changes is null then
      return null; -- nothing meaningful changed
    end if;
  end if;

  v_shop := nullif(coalesce(v_row ->> 'shop_id', case when tg_table_name = 'shops' then v_row ->> 'id' end), '')::uuid;
  if v_shop is null and tg_table_name in ('availability', 'barber_services') then
    select b.shop_id into v_shop from public.barbers b where b.id = (v_row ->> 'barber_id')::uuid;
  end if;
  if v_shop is not null then
    select s.organization_id into v_org from public.shops s where s.id = v_shop;
  else
    v_org := nullif(v_row ->> 'organization_id', '')::uuid;
  end if;

  insert into public.audit_logs (organization_id, shop_id, actor_id, action, entity, entity_id, changes, snapshot, ip, user_agent)
  values (v_org, v_shop, auth.uid(), lower(tg_op), tg_table_name, coalesce(v_row ->> 'id', v_row ->> 'shop_id'),
          v_changes,
          case when tg_op in ('INSERT', 'DELETE') then v_row end,
          coalesce(split_part(app.request_header('x-forwarded-for'), ',', 1), app.request_header('x-real-ip')),
          left(app.request_header('user-agent'), 300));
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'shops', 'shop_settings', 'booking_settings', 'business_hours', 'memberships',
    'barbers', 'services', 'barber_services', 'availability', 'availability_exceptions',
    'appointments', 'payments', 'refunds', 'commissions', 'clients', 'client_notes',
    'promo_codes', 'gift_cards', 'membership_plans', 'client_memberships', 'reviews', 'subscriptions'
  ] loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function app.audit()', t || '_audit', t);
  end loop;
end $$;
