-- BarberNGo brand: Electric Blue is the default accent for new shops and barbers,
-- and platform notification copy names the product. Existing shop/barber colours
-- are the owner's choice and are left untouched.
alter table public.shops alter column accent_color set default '#1683FF';
alter table public.barbers alter column color set default '#1683FF';

update public.notification_templates
   set subject = replace(subject, 'on Autocoti', 'on BarberNGo'), updated_at = now()
 where shop_id is null and subject like '%Autocoti%';
