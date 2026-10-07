-- Live calendars: stream appointment and walk-in changes (RLS still applies
-- to Realtime subscribers). Guarded so the migration also runs on plain Postgres.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.appointments, public.walk_ins;
  end if;
end $$;
