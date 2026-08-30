-- Enough of Supabase's platform to run schema.sql against a plain PostgreSQL:
-- the auth schema, auth.uid(), and the anon / authenticated roles.
-- Used by the schema tests. Supabase projects already provide all of this.

create extension if not exists pgcrypto;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Supabase reads the caller's id out of their JWT; here it comes from a
-- session setting the tests set with set_config().
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

grant usage on schema public, auth to anon, authenticated;
grant select on auth.users to anon, authenticated;

-- Supabase hands every table and function later created in "public" to anon
-- and authenticated. schema.sql revokes what it does not want, so the tests
-- have to start from the same over-wide grant or they would prove nothing.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
