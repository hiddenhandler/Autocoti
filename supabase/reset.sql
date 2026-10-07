-- BarberNGo: wipe a previous (partial or complete) setup so supabase/setup.sql can run again.
-- DESTROYS ALL BARBERNGO DATA in this project. Only use on a project with no real data yet.
-- Paste into Supabase Dashboard -> SQL Editor -> Run, then run setup.sql.
drop trigger if exists on_auth_user_created on auth.users;
drop schema if exists app cascade;
drop schema if exists public cascade;
create schema public;
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
