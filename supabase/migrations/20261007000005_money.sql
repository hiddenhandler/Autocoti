-- =============================================================================
-- Payments, tips, commissions, barber earnings.
-- The payment row is the financial source of truth. It is provider-agnostic:
-- `provider`/`provider_ref` let Stripe (or anything else) be attached later
-- without touching the rest of the model.
-- Financial tables are written ONLY through SECURITY DEFINER RPCs which
-- enforce permissions and compute amounts server-side.
-- =============================================================================

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  client_id uuid references public.clients (id) on delete set null,
  barber_id uuid references public.barbers (id),
  kind text not null default 'service' check (kind in ('service', 'no_show_fee', 'late_cancel_fee', 'deposit', 'gift_card', 'membership', 'product')),
  subtotal_cents bigint not null check (subtotal_cents >= 0),       -- services before discount
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  tip_cents bigint not null default 0 check (tip_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),             -- subtotal - discount + tax + tip
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  method public.payment_method not null default 'cash',
  status public.payment_status not null default 'PAID',
  promo_code_id uuid,
  gift_card_id uuid,
  provider text,          -- 'manual' | 'stripe' | 'square' | ...
  provider_ref text,
  notes text,
  recorded_by uuid references auth.users (id),
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  check (total_cents = subtotal_cents - discount_cents + tax_cents + tip_cents),
  check (discount_cents <= subtotal_cents),
  check (refunded_cents <= amount_paid_cents)
);
create index payments_shop_time on public.payments (shop_id, paid_at);
create index payments_barber_time on public.payments (barber_id, paid_at);
create index payments_appt on public.payments (appointment_id);
create index payments_client on public.payments (client_id);
create unique index payments_provider_ref on public.payments (provider, provider_ref) where provider_ref is not null;
create trigger payments_touch before update on public.payments
  for each row execute function app.touch_updated_at();

-- Line items (services, products) on a payment.
create table public.payment_items (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  service_id uuid references public.services (id) on delete set null,
  description text not null,
  quantity int not null default 1 check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  total_cents bigint not null check (total_cents >= 0)
);
create index payment_items_payment on public.payment_items (payment_id);
create index payment_items_service on public.payment_items (service_id);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  reason text,
  provider_ref text,
  refunded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index refunds_payment on public.refunds (payment_id);

-- Tips tracked separately from service revenue (one row per tip so tips can be
-- added after the fact, e.g. a card tip settled later, or split).
create table public.tips (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  payment_id uuid references public.payments (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  barber_id uuid not null references public.barbers (id),
  amount_cents bigint not null check (amount_cents > 0),
  method public.payment_method not null default 'cash',
  created_at timestamptz not null default now()
);
create index tips_shop_time on public.tips (shop_id, created_at);
create index tips_barber_time on public.tips (barber_id, created_at);

-- Commission configuration per barber (history kept via effective dates).
--   percentage   : barber gets percent_bps of net service revenue
--   fixed        : barber gets fixed_cents per service performed
--   tiered       : percent depends on month-to-date net service revenue,
--                  tiers = [{"up_to_cents": 300000, "percent_bps": 4000}, {"up_to_cents": null, "percent_bps": 5000}]
--   booth_rental : barber keeps 100% of service revenue and pays rent_cents per rent_period
--   hybrid       : reduced rent + percent_bps
create table public.commissions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid not null references public.barbers (id) on delete cascade,
  type public.commission_type not null default 'percentage',
  percent_bps int check (percent_bps between 0 and 10000),
  fixed_cents bigint check (fixed_cents >= 0),
  tiers jsonb,
  rent_cents bigint check (rent_cents >= 0),
  rent_period text check (rent_period in ('week', 'month')),
  tip_share_bps int not null default 10000 check (tip_share_bps between 0 and 10000), -- barber's share of tips
  effective_from date not null default current_date,
  effective_to date,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check (type <> 'percentage' or percent_bps is not null),
  check (type <> 'fixed' or fixed_cents is not null),
  check (type <> 'tiered' or jsonb_typeof(tiers) = 'array'),
  check (type <> 'booth_rental' or rent_cents is not null),
  check (type <> 'hybrid' or (percent_bps is not null and rent_cents is not null))
);
create index commissions_barber on public.commissions (barber_id, effective_from desc);
alter table public.commissions add constraint commissions_no_overlap
  exclude using gist (barber_id with =, daterange(effective_from, effective_to, '[]') with &&);

-- Earnings ledger: one row per payment (or adjustment) per barber.
create table public.barber_earnings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  barber_id uuid not null references public.barbers (id),
  payment_id uuid references public.payments (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  kind text not null default 'service' check (kind in ('service', 'tip', 'adjustment', 'rent', 'refund')),
  service_revenue_cents bigint not null default 0,  -- net service revenue attributed
  commission_cents bigint not null default 0,       -- barber's share of service revenue
  tip_cents bigint not null default 0,              -- barber's share of tips
  shop_cents bigint not null default 0,             -- shop's share
  commission_id uuid references public.commissions (id) on delete set null, -- snapshot below keeps history
  commission_snapshot jsonb,
  earned_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index barber_earnings_barber_time on public.barber_earnings (barber_id, earned_at);
create index barber_earnings_shop_time on public.barber_earnings (shop_id, earned_at);
create index barber_earnings_payment on public.barber_earnings (payment_id);
