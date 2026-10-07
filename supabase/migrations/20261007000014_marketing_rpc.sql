-- =============================================================================
-- Marketing RPCs: campaigns (win-back, birthday, book-again, promo), memberships
-- Campaigns only reach clients who opted in to marketing (consent), dedupe
-- per client per campaign, and go through the same notification outbox.
-- =============================================================================

create or replace function app.campaign_audience(p_shop uuid, p_audience jsonb)
returns table (client_id uuid, email text, first_name text, days_since int, favorite_barber uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.email::text, c.first_name, h.days_since_last, h.favorite_barber_id
    from app.client_health_rows(p_shop) h
    join public.clients c on c.id = h.client_id
   where c.email is not null and c.marketing_email_opt_in
     and (
       (p_audience ? 'health' and h.health = any (array(select jsonb_array_elements_text(p_audience -> 'health'))))
       or (coalesce((p_audience ->> 'due')::boolean, false) and h.is_due and h.next_appointment is null and h.visits > 0)
       or (coalesce((p_audience ->> 'birthday_month')::boolean, false) and extract(month from c.birthday) = extract(month from now()))
       or (coalesce((p_audience ->> 'all')::boolean, false))
     )
     and (not (p_audience ? 'min_days_away') or h.days_since_last >= (p_audience ->> 'min_days_away')::int)
$$;

create or replace function public.preview_campaign_audience(p_shop_id uuid, p_audience jsonb)
returns int language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require(p_shop_id, 'marketing.manage');
  return (select count(*) from app.campaign_audience(p_shop_id, p_audience));
end $$;

create or replace function public.send_campaign(p_campaign_id uuid)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare cp public.campaigns; s public.shops; n int;
begin
  select * into cp from public.campaigns where id = p_campaign_id for update;
  if cp.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(cp.shop_id, 'marketing.manage');
  perform app.require_feature(cp.shop_id, 'marketing');
  select * into s from public.shops where id = cp.shop_id;
  insert into public.notifications (shop_id, event, channel, audience, client_id, to_address, payload, dedupe_key, scheduled_for)
  select cp.shop_id, 'campaign', cp.channel, 'client', a.client_id, a.email,
         jsonb_build_object('subject', cp.subject, 'body', cp.body, 'client_first_name', a.first_name, 'shop_name', s.name,
                            'days', a.days_since, 'book_url', '/s/' || s.slug || '/book',
                            'promo_code', (select code from public.promo_codes where id = cp.promo_code_id),
                            'barber_name', coalesce((select display_name from public.barbers where id = a.favorite_barber), s.name)),
         'campaign:' || cp.id || ':' || a.client_id, coalesce(cp.scheduled_for, now())
    from app.campaign_audience(cp.shop_id, cp.audience) a
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;
  update public.campaigns set status = 'sent', sent_count = sent_count + n where id = cp.id;
  return n;
end $$;

create or replace function public.assign_membership(p_client_id uuid, p_plan_id uuid, p_method public.payment_method default 'card')
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.clients; mp public.membership_plans; v_id uuid;
begin
  select * into c from public.clients where id = p_client_id;
  select * into mp from public.membership_plans where id = p_plan_id and shop_id = c.shop_id and is_active;
  if c.id is null or mp.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(c.shop_id, 'payments.record');
  insert into public.client_memberships (shop_id, client_id, plan_id, current_period_end)
  values (c.shop_id, c.id, mp.id, current_date + case mp.billing_interval when 'week' then 7 when 'year' then 365 else 30 end)
  returning id into v_id;
  insert into public.payments (shop_id, client_id, kind, subtotal_cents, total_cents, amount_paid_cents, method, status, provider, recorded_by)
  values (c.shop_id, c.id, 'membership', mp.price_cents, mp.price_cents, mp.price_cents, p_method, 'PAID', 'manual', auth.uid());
  return v_id;
end $$;

create or replace function public.update_client_membership(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.client_memberships;
begin
  select * into m from public.client_memberships where id = p_id;
  if m.id is null then perform app.fail('NOT_FOUND'); end if;
  perform app.require(m.shop_id, 'clients.all');
  if p_status not in ('active', 'paused', 'cancelled') then perform app.fail('INVALID_STATUS'); end if;
  update public.client_memberships set status = p_status, cancelled_at = case when p_status = 'cancelled' then now() end where id = p_id;
end $$;

insert into public.notification_templates (shop_id, event, channel, subject, body) values
  (null, 'campaign', 'email', '{{subject}}', '{{body}}'),
  (null, 'staff.invitation', 'email', 'You''re invited to join {{shop_name}} on Autocoti', 'You''ve been invited to join {{shop_name}} as {{role}}. Accept here: {{invite_url}}');
