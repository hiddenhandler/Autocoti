-- =============================================================================
-- Checkout, payments, tips, commissions, refunds.
-- All amounts are computed server-side; the client only sends what was
-- charged per line, discount, tip and method.
-- =============================================================================

-- Active commission rule for a barber at a point in time.
create or replace function app.commission_rule(p_barber uuid, p_at timestamptz)
returns public.commissions language sql stable security definer set search_path = public, pg_temp as $$
  select c.* from public.commissions c
    join public.shops s on s.id = c.shop_id
   where c.barber_id = p_barber
     and c.effective_from <= (p_at at time zone s.timezone)::date
     and (c.effective_to is null or c.effective_to >= (p_at at time zone s.timezone)::date)
   order by c.effective_from desc limit 1
$$;

-- Barber's share of a net service amount. Tiered rules are marginal on
-- month-to-date net service revenue (so crossing a tier mid-ticket is exact).
create or replace function app.compute_commission(p_barber uuid, p_net_cents bigint, p_service_count int, p_at timestamptz)
returns table (commission_cents bigint, commission_id uuid, snapshot jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.commissions := app.commission_rule(p_barber, p_at);
  v_tz text;
  v_mtd bigint;
  v_remaining bigint := p_net_cents;
  v_cursor bigint;
  v_total numeric := 0;
  t jsonb;
  v_cap bigint;
  v_portion bigint;
begin
  if c.id is null then
    -- No rule configured: everything stays with the shop until the owner sets one.
    return query select 0::bigint, null::uuid, jsonb_build_object('type', 'none');
    return;
  end if;
  case c.type
    when 'percentage' then
      v_total := p_net_cents * c.percent_bps / 10000.0;
    when 'fixed' then
      v_total := least(p_net_cents, c.fixed_cents * greatest(p_service_count, 1));
    when 'booth_rental' then
      v_total := p_net_cents;
    when 'hybrid' then
      v_total := p_net_cents * c.percent_bps / 10000.0;
    when 'tiered' then
      select s.timezone into v_tz from public.shops s where s.id = c.shop_id;
      select coalesce(sum(e.service_revenue_cents), 0) into v_mtd
        from public.barber_earnings e
       where e.barber_id = p_barber
         and e.earned_at >= (date_trunc('month', p_at at time zone v_tz) at time zone v_tz)
         and e.earned_at < p_at;
      v_cursor := v_mtd;
      for t in select * from jsonb_array_elements(c.tiers) order by coalesce((value ->> 'up_to_cents')::bigint, 9223372036854775807) loop
        exit when v_remaining <= 0;
        v_cap := (t ->> 'up_to_cents')::bigint;
        if v_cap is not null and v_cursor >= v_cap then continue; end if;
        v_portion := case when v_cap is null then v_remaining else least(v_remaining, v_cap - v_cursor) end;
        v_total := v_total + v_portion * (t ->> 'percent_bps')::int / 10000.0;
        v_remaining := v_remaining - v_portion;
        v_cursor := v_cursor + v_portion;
      end loop;
  end case;
  return query select round(v_total)::bigint, c.id, to_jsonb(c);
end $$;

-- Record what was charged (COMPLETE APPOINTMENT → checkout sheet).
-- p_items: [{"service_id": "...", "description": "Haircut", "price_cents": 3500, "quantity": 1}]
create or replace function public.record_payment(
  p_appointment_id uuid,
  p_items jsonb,
  p_tip_cents bigint default 0,
  p_discount_cents bigint default 0,
  p_method public.payment_method default 'cash',
  p_amount_paid_cents bigint default null,     -- NULL = paid in full
  p_notes text default null,
  p_promo_code text default null,
  p_tip_method public.payment_method default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.appointments;
  ss public.shop_settings;
  v_subtotal bigint;
  v_discount bigint := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax bigint;
  v_tip bigint := greatest(coalesce(p_tip_cents, 0), 0);
  v_total bigint;
  v_paid bigint;
  v_status public.payment_status;
  v_payment uuid;
  v_promo public.promo_codes;
  v_net bigint;
  cm record;
  v_tip_share bigint;
  v_count int;
begin
  perform app.require_auth();
  select * into a from public.appointments where id = p_appointment_id and deleted_at is null for update;
  if a.id is null then perform app.fail('NOT_FOUND'); end if;
  if not (app.can(a.shop_id, 'payments.record') or (app.is_my_barber(a.barber_id) and app.can(a.shop_id, 'payments.record_own'))) then
    perform app.fail('FORBIDDEN');
  end if;
  if a.kind <> 'appointment' then perform app.fail('INVALID_KIND'); end if;
  if a.status in ('CANCELLED', 'RESCHEDULED') then perform app.fail('APPOINTMENT_NOT_ACTIVE'); end if;
  if exists (select 1 from public.payments where appointment_id = a.id and kind = 'service' and status in ('PAID', 'PARTIAL')) then
    perform app.fail('ALREADY_PAID');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then perform app.fail('ITEMS_REQUIRED'); end if;
  if exists (select 1 from jsonb_array_elements(p_items) i
              where coalesce((i ->> 'price_cents')::bigint, -1) < 0 or coalesce((i ->> 'quantity')::int, 1) < 1) then
    perform app.fail('INVALID_AMOUNT');
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) i
              where i ? 'service_id' and nullif(i ->> 'service_id', '') is not null
                and not exists (select 1 from public.services s where s.id = (i ->> 'service_id')::uuid and s.shop_id = a.shop_id)) then
    perform app.fail('SERVICE_NOT_IN_SHOP');
  end if;

  select * into ss from public.shop_settings where shop_id = a.shop_id;
  select sum((i ->> 'price_cents')::bigint * coalesce((i ->> 'quantity')::int, 1)), sum(coalesce((i ->> 'quantity')::int, 1))
    into v_subtotal, v_count from jsonb_array_elements(p_items) i;

  if p_promo_code is not null and length(trim(p_promo_code)) > 0 then
    select * into v_promo from public.promo_codes
     where shop_id = a.shop_id and code = upper(trim(p_promo_code)) and is_active
       and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
       and (max_redemptions is null or redemptions < max_redemptions)
     for update;
    if v_promo.id is null then perform app.fail('PROMO_INVALID'); end if;
    if v_promo.first_visit_only and exists (select 1 from public.appointments x
         where x.client_id = a.client_id and x.status = 'COMPLETED' and x.id <> a.id) then
      perform app.fail('PROMO_FIRST_VISIT_ONLY');
    end if;
    v_discount := v_discount + case when v_promo.discount_type = 'percent'
                                    then round(v_subtotal * v_promo.discount_value / 10000.0)::bigint
                                    else v_promo.discount_value end;
    update public.promo_codes set redemptions = redemptions + 1 where id = v_promo.id;
  end if;
  v_discount := least(v_discount, v_subtotal);
  v_net := v_subtotal - v_discount;
  if not ss.tips_enabled then v_tip := 0; end if;

  v_tax := case when ss.prices_include_tax then 0 else round(v_net * ss.tax_rate_bps / 10000.0)::bigint end;
  v_total := v_net + v_tax + v_tip;
  v_paid := coalesce(p_amount_paid_cents, v_total);
  if v_paid < 0 or v_paid > v_total then perform app.fail('INVALID_AMOUNT'); end if;
  v_status := case when v_paid >= v_total then 'PAID' when v_paid = 0 then 'UNPAID' else 'PARTIAL' end;

  insert into public.payments (shop_id, appointment_id, client_id, barber_id, kind, subtotal_cents, discount_cents, tax_cents,
                               tip_cents, total_cents, amount_paid_cents, method, status, promo_code_id, provider, notes, recorded_by)
  values (a.shop_id, a.id, a.client_id, a.barber_id, 'service', v_subtotal, v_discount, v_tax, v_tip, v_total, v_paid,
          p_method, v_status, v_promo.id, 'manual', p_notes, auth.uid())
  returning id into v_payment;

  insert into public.payment_items (payment_id, service_id, description, quantity, unit_price_cents, total_cents)
  select v_payment, nullif(i ->> 'service_id', '')::uuid, coalesce(nullif(i ->> 'description', ''), 'Service'),
         coalesce((i ->> 'quantity')::int, 1), (i ->> 'price_cents')::bigint,
         (i ->> 'price_cents')::bigint * coalesce((i ->> 'quantity')::int, 1)
    from jsonb_array_elements(p_items) i;

  select * into cm from app.compute_commission(a.barber_id, v_net, v_count, now());
  v_tip_share := 0;
  if v_tip > 0 then
    insert into public.tips (shop_id, payment_id, appointment_id, barber_id, amount_cents, method)
    values (a.shop_id, v_payment, a.id, a.barber_id, v_tip, coalesce(p_tip_method, p_method));
    v_tip_share := round(v_tip * coalesce((cm.snapshot ->> 'tip_share_bps')::int, 10000) / 10000.0)::bigint;
  end if;

  insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, service_revenue_cents,
                                      commission_cents, tip_cents, shop_cents, commission_id, commission_snapshot)
  values (a.shop_id, a.barber_id, v_payment, a.id, 'service', v_net, cm.commission_cents, v_tip_share,
          v_net - cm.commission_cents + (v_tip - v_tip_share), cm.commission_id, cm.snapshot);

  -- Completing payment completes the appointment (and stops a running timer).
  update public.appointments
     set payment_status = v_status,
         status = case when status in ('COMPLETED', 'NO_SHOW') then status else 'COMPLETED' end,
         actual_finished_at = case when status = 'IN_SERVICE' then now() else actual_finished_at end,
         expected_price_cents = v_subtotal
   where id = a.id;

  -- Loyalty: 1 point per whole currency unit of net service revenue.
  if a.client_id is not null and v_net > 0 then
    insert into public.loyalty_ledger (shop_id, client_id, points, reason, payment_id)
    values (a.shop_id, a.client_id, (v_net / 100)::int, 'visit', v_payment);
  end if;

  if (select email from public.clients where id = a.client_id) is not null then
    perform app.notify_client(a.id, 'payment.recorded', now(), 'receipt:' || v_payment,
      jsonb_build_object('total', to_char(v_total / 100.0, 'FM999999990.00')));
  end if;

  return jsonb_build_object('payment_id', v_payment, 'subtotal_cents', v_subtotal, 'discount_cents', v_discount,
                            'tax_cents', v_tax, 'tip_cents', v_tip, 'total_cents', v_total, 'status', v_status,
                            'commission_cents', cm.commission_cents);
end $$;

-- Collect the remainder of a PARTIAL / UNPAID payment.
create or replace function public.settle_payment(p_payment_id uuid, p_amount_cents bigint, p_method public.payment_method default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; v_paid bigint;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  if not (app.can(p.shop_id, 'payments.record') or (app.is_my_barber(p.barber_id) and app.can(p.shop_id, 'payments.record_own'))) then
    perform app.fail('FORBIDDEN');
  end if;
  if p.status not in ('PARTIAL', 'UNPAID') then perform app.fail('INVALID_STATUS'); end if;
  v_paid := p.amount_paid_cents + p_amount_cents;
  if p_amount_cents <= 0 or v_paid > p.total_cents then perform app.fail('INVALID_AMOUNT'); end if;
  update public.payments
     set amount_paid_cents = v_paid, status = (case when v_paid = p.total_cents then 'PAID' else 'PARTIAL' end)::public.payment_status,
         method = coalesce(p_method, method)
   where id = p.id;
  update public.appointments set payment_status = (case when v_paid = p.total_cents then 'PAID' else 'PARTIAL' end)::public.payment_status
   where id = p.appointment_id;
end $$;

-- Add a tip after checkout (e.g. card tip settled later).
create or replace function public.add_tip(p_payment_id uuid, p_amount_cents bigint, p_method public.payment_method default 'card')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments; v_share bigint; v_bps int;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  if not (app.can(p.shop_id, 'payments.record') or (app.is_my_barber(p.barber_id) and app.can(p.shop_id, 'payments.record_own'))) then
    perform app.fail('FORBIDDEN');
  end if;
  if p_amount_cents <= 0 then perform app.fail('INVALID_AMOUNT'); end if;
  if p.status in ('VOID', 'REFUNDED') then perform app.fail('INVALID_STATUS'); end if;
  update public.payments set tip_cents = tip_cents + p_amount_cents, total_cents = total_cents + p_amount_cents,
         amount_paid_cents = amount_paid_cents + p_amount_cents where id = p.id;
  insert into public.tips (shop_id, payment_id, appointment_id, barber_id, amount_cents, method)
  values (p.shop_id, p.id, p.appointment_id, p.barber_id, p_amount_cents, p_method);
  v_bps := coalesce((app.commission_rule(p.barber_id, now())).tip_share_bps, 10000);
  v_share := round(p_amount_cents * v_bps / 10000.0)::bigint;
  insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, tip_cents, shop_cents)
  values (p.shop_id, p.barber_id, p.id, p.appointment_id, 'tip', v_share, p_amount_cents - v_share);
end $$;

-- Refund (full or partial). Earnings are reversed proportionally.
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
   where id = p.appointment_id and p.refunded_cents + p_amount_cents >= p.amount_paid_cents;

  v_ratio := p_amount_cents::numeric / nullif(p.total_cents, 0);
  select coalesce(sum(service_revenue_cents), 0) sr, coalesce(sum(commission_cents), 0) cc,
         coalesce(sum(tip_cents), 0) tc, coalesce(sum(shop_cents), 0) sc
    into e from public.barber_earnings where payment_id = p.id;
  insert into public.barber_earnings (shop_id, barber_id, payment_id, appointment_id, kind, service_revenue_cents,
                                      commission_cents, tip_cents, shop_cents)
  values (p.shop_id, p.barber_id, p.id, p.appointment_id, 'refund',
          -round(e.sr * v_ratio)::bigint, -round(e.cc * v_ratio)::bigint, -round(e.tc * v_ratio)::bigint, -round(e.sc * v_ratio)::bigint);
end $$;

-- Void a mistaken payment entirely (reverses earnings, tips, loyalty).
create or replace function public.void_payment(p_payment_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.payments;
begin
  select * into p from public.payments where id = p_payment_id for update;
  if p.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(p.shop_id, 'payments.refund');
  if p.status = 'VOID' then return; end if;
  if p.refunded_cents > 0 then perform app.fail('ALREADY_REFUNDED'); end if;
  update public.payments set status = 'VOID', voided_at = now(), notes = concat_ws(' · ', notes, 'Voided: ' || p_reason) where id = p.id;
  delete from public.barber_earnings where payment_id = p.id;
  delete from public.tips where payment_id = p.id;
  delete from public.loyalty_ledger where payment_id = p.id;
  update public.appointments set payment_status = 'UNPAID' where id = p.appointment_id;
end $$;

-- Charge a no-show / late-cancellation fee that the policy assessed.
create or replace function public.charge_policy_fee(p_appointment_id uuid, p_method public.payment_method default 'card', p_waive boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.appointments; v_payment uuid;
begin
  select * into a from public.appointments where id = p_appointment_id for update;
  if a.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(a.shop_id, 'payments.record');
  if a.fee_cents <= 0 then perform app.fail('NO_FEE'); end if;
  if p_waive then
    update public.appointments set fee_cents = 0 where id = a.id;
    return jsonb_build_object('waived', true);
  end if;
  insert into public.payments (shop_id, appointment_id, client_id, barber_id, kind, subtotal_cents, total_cents,
                               amount_paid_cents, method, status, provider, recorded_by)
  values (a.shop_id, a.id, a.client_id, a.barber_id,
          case when a.status = 'NO_SHOW' then 'no_show_fee' else 'late_cancel_fee' end,
          a.fee_cents, a.fee_cents, a.fee_cents, p_method, 'PAID', 'manual', auth.uid())
  returning id into v_payment;
  update public.appointments set payment_status = 'PAID' where id = a.id;
  return jsonb_build_object('payment_id', v_payment);
end $$;

-- Gift cards ---------------------------------------------------------------
create or replace function public.issue_gift_card(
  p_shop_id uuid, p_amount_cents bigint, p_recipient_name text default null, p_recipient_email text default null,
  p_message text default null, p_expires_at date default null, p_method public.payment_method default 'card')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.gift_cards; v_payment uuid;
begin
  perform app.require(p_shop_id, 'payments.record');
  perform app.require_feature(p_shop_id, 'marketing');
  if p_amount_cents <= 0 then perform app.fail('INVALID_AMOUNT'); end if;
  insert into public.gift_cards (shop_id, initial_cents, balance_cents, recipient_name, recipient_email, message, expires_at, issued_by)
  values (p_shop_id, p_amount_cents, p_amount_cents, p_recipient_name, p_recipient_email, p_message, p_expires_at, auth.uid())
  returning * into g;
  insert into public.payments (shop_id, kind, subtotal_cents, total_cents, amount_paid_cents, method, status, provider, recorded_by, gift_card_id)
  values (p_shop_id, 'gift_card', p_amount_cents, p_amount_cents, p_amount_cents, p_method, 'PAID', 'manual', auth.uid(), g.id)
  returning id into v_payment;
  insert into public.gift_card_transactions (gift_card_id, payment_id, amount_cents, created_by) values (g.id, v_payment, p_amount_cents, auth.uid());
  return jsonb_build_object('id', g.id, 'code', g.code);
end $$;

create or replace function public.redeem_gift_card(p_shop_id uuid, p_code text, p_amount_cents bigint, p_payment_id uuid default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare g public.gift_cards;
begin
  perform app.require(p_shop_id, 'payments.record');
  select * into g from public.gift_cards where shop_id = p_shop_id and code = upper(trim(p_code)) for update;
  if g.id is null or g.status <> 'active' or (g.expires_at is not null and g.expires_at < current_date) then
    perform app.fail('GIFT_CARD_INVALID');
  end if;
  if p_amount_cents <= 0 or p_amount_cents > g.balance_cents then perform app.fail('INSUFFICIENT_BALANCE'); end if;
  update public.gift_cards set balance_cents = balance_cents - p_amount_cents,
         status = case when balance_cents - p_amount_cents = 0 then 'redeemed' else status end
   where id = g.id;
  insert into public.gift_card_transactions (gift_card_id, payment_id, amount_cents, created_by)
  values (g.id, p_payment_id, -p_amount_cents, auth.uid());
  return g.balance_cents - p_amount_cents;
end $$;
