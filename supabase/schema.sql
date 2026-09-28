-- CG Calendar — Supabase schema
--
-- Run this once in your project's SQL editor (Supabase dashboard → SQL editor →
-- New query → paste → Run). It is safe to re-run: every statement is guarded.
--
-- What it sets up:
--   * events, food_slots, signups  — the calendar itself
--   * organizers                   — the only people who may add or change events
--   * row level security           — those rules, enforced by the database, so
--                                    they hold no matter what a browser sends
--   * a sign-up trigger            — a slot belongs to its event, and only as
--                                    many hosts sign up as the event asked for

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.organizers (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (char_length(title) between 1 and 120),
  description      text not null default '' check (char_length(description) <= 2000),
  location         text not null default '' check (char_length(location) <= 200),
  event_date       date not null,
  start_time       time,
  end_time         time,
  needs_host       boolean not null default true,
  host_limit       integer not null default 1 check (host_limit >= 0),
  allow_other_food boolean not null default true,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint events_time_order check (
    start_time is null or end_time is null or end_time >= start_time
  )
);

create index if not exists events_date_idx on public.events (event_date);

create table if not exists public.food_slots (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  label    text not null check (char_length(label) between 1 and 60),
  -- How many people the organizer wants for this slot. A minimum, not a cap:
  -- more may always sign up. 0 means no particular number is wanted.
  needed   integer not null default 1,
  position integer not null default 0
);

-- Slots used to be capacities that closed when full. A project created before
-- that changed still has the old column; rename it rather than lose the data.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'food_slots' and column_name = 'capacity'
  ) and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'food_slots' and column_name = 'needed'
  ) then
    alter table public.food_slots rename column capacity to needed;
  end if;
end $$;

-- Named explicitly, because renaming a column does not rename its constraint.
alter table public.food_slots drop constraint if exists food_slots_capacity_check;
alter table public.food_slots drop constraint if exists food_slots_needed_check;
alter table public.food_slots add constraint food_slots_needed_check check (needed >= 0);

create index if not exists food_slots_event_idx on public.food_slots (event_id);

create table if not exists public.signups (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  -- When an organizer removes a slot, the sign-up survives as "something else".
  slot_id    uuid references public.food_slots (id) on delete set null,
  kind       text not null check (kind in ('host', 'food')),
  name       text not null check (char_length(name) between 1 and 80),
  contact    text not null default '' check (char_length(contact) <= 120),
  item       text not null default '' check (char_length(item) <= 140),
  note       text not null default '' check (char_length(note) <= 280),
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint signups_food_needs_item check (kind = 'host' or char_length(item) > 0)
);

create index if not exists signups_event_idx on public.signups (event_id);
create index if not exists signups_slot_idx on public.signups (slot_id);

-- ---------------------------------------------------------------------------
-- Who is an organizer
-- ---------------------------------------------------------------------------

-- security definer so the policies below can consult the organizer list
-- without every visitor being able to read it.
create or replace function public.is_organizer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.organizers where user_id = auth.uid());
$$;

revoke all on function public.is_organizer() from public;
grant execute on function public.is_organizer() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.organizers enable row level security;
alter table public.events     enable row level security;
alter table public.food_slots enable row level security;
alter table public.signups    enable row level security;

-- Table privileges say who may attempt a statement at all; the policies below
-- say which rows it may touch. "anon" is a visitor with no session, so it can
-- only read; everyone who signs in (including anonymous sign-ins) is
-- "authenticated" and may add sign-ups.
-- Supabase's default privileges hand every new table in "public" to anon and
-- authenticated, which is wider than the model above: it gives a signed-out
-- visitor INSERT and TRUNCATE, and TRUNCATE is not filtered by row level
-- security. Clear that first, so the grants below are the whole picture.
revoke all on public.organizers, public.events, public.food_slots, public.signups
  from anon, authenticated;

grant select on public.organizers, public.events, public.food_slots
  to anon, authenticated;
grant insert, update, delete on public.events, public.food_slots
  to authenticated;

-- Sign-ups are granted column by column.
--
-- Reading: everything but "contact". A phone number or email is for the
-- organizers, not for everyone who has the link; signup_contacts() below hands
-- it out to the people allowed to see it.
--
-- Changing: only what a person typed. The sign-up rules run when a sign-up is
-- added, so if "kind", "event_id" or "slot_id" could be changed afterwards, a
-- food sign-up could turn itself into a second host, move to an event that
-- needs no host, or point at another event's food slot. Nothing in the app
-- moves a sign-up; cancelling and signing up again goes back through the rules.
grant select (id, event_id, slot_id, kind, name, item, note, created_by, created_at)
  on public.signups to anon, authenticated;
grant insert, delete on public.signups to authenticated;
grant update (name, contact, item, note) on public.signups to authenticated;

-- Your display name is yours to set. The grant names one column, so even with
-- the policy below nobody can repoint their row at a different user_id.
grant update (name) on public.organizers to authenticated;

-- Organizers: you may see your own row, and nothing else. Membership is
-- managed from the dashboard, not from the app; your display name is not.
drop policy if exists organizers_read_self on public.organizers;
create policy organizers_read_self on public.organizers
  for select using (user_id = auth.uid());

-- Being an organizer is granted from the dashboard, but what the header calls
-- you is only a label — so you may change your own, and nobody else's.
drop policy if exists organizers_rename_self on public.organizers;
create policy organizers_rename_self on public.organizers
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Events and their food slots: anyone with the link may read them; only
-- organizers may write them.
drop policy if exists events_read_all on public.events;
create policy events_read_all on public.events
  for select using (true);

drop policy if exists events_write_organizers on public.events;
create policy events_write_organizers on public.events
  for all using (public.is_organizer()) with check (public.is_organizer());

drop policy if exists food_slots_read_all on public.food_slots;
create policy food_slots_read_all on public.food_slots
  for select using (true);

drop policy if exists food_slots_write_organizers on public.food_slots;
create policy food_slots_write_organizers on public.food_slots
  for all using (public.is_organizer()) with check (public.is_organizer());

-- Sign-ups: anyone may read them and add their own. You may change or remove
-- only the ones you created — unless you are an organizer, who may tidy up
-- anyone's.
drop policy if exists signups_read_all on public.signups;
create policy signups_read_all on public.signups
  for select using (true);

drop policy if exists signups_insert_own on public.signups;
create policy signups_insert_own on public.signups
  for insert with check (created_by = auth.uid());

drop policy if exists signups_update_own on public.signups;
create policy signups_update_own on public.signups
  for update using (created_by = auth.uid() or public.is_organizer())
  with check (created_by = auth.uid() or public.is_organizer());

drop policy if exists signups_delete_own on public.signups;
create policy signups_delete_own on public.signups
  for delete using (created_by = auth.uid() or public.is_organizer());

-- ---------------------------------------------------------------------------
-- Contact details
-- ---------------------------------------------------------------------------

-- The "contact" column cannot be read directly (see the grants above). This
-- returns it for your own sign-ups, and for everyone's if you are an organizer.
create or replace function public.signup_contacts()
returns table (signup_id uuid, contact text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.contact
    from public.signups s
   where s.contact <> ''
     and (s.created_by = auth.uid() or public.is_organizer());
$$;

revoke all on function public.signup_contacts() from public, anon, authenticated;
grant execute on function public.signup_contacts() to authenticated;

-- ---------------------------------------------------------------------------
-- Sign-up rules the database enforces
-- ---------------------------------------------------------------------------
--
-- A food slot states how many people are wanted, not how many are allowed, so
-- nothing here turns a food sign-up away for being late. A host is different:
-- an event has one house, so host_limit is a real cap.

drop trigger if exists signups_capacity on public.signups;
drop function if exists public.enforce_signup_capacity();

create or replace function public.enforce_signup_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.events%rowtype;
  v_slot  public.food_slots%rowtype;
  v_taken integer;
begin
  -- Locking the event row serializes sign-ups for the same event, so two
  -- people clicking at the same moment cannot both take the last spot.
  select * into v_event from public.events where id = new.event_id for update;
  if not found then
    raise exception 'That event no longer exists.';
  end if;

  if new.kind = 'host' then
    if not v_event.needs_host then
      raise exception 'This event does not need a host.';
    end if;
    select count(*) into v_taken
      from public.signups
     where event_id = new.event_id and kind = 'host' and id is distinct from new.id;
    if v_taken >= v_event.host_limit then
      raise exception 'Someone already signed up to host this event.';
    end if;
    new.slot_id := null;
  else
    if new.slot_id is null then
      if not v_event.allow_other_food then
        raise exception 'Please choose one of the listed food slots.';
      end if;
    else
      select * into v_slot
        from public.food_slots
       where id = new.slot_id and event_id = new.event_id;
      if not found then
        raise exception 'That food slot is no longer on this event.';
      end if;
      -- Reaching the number wanted does not close the slot; extra food is
      -- always welcome, and the count on screen simply passes the minimum.
    end if;
  end if;

  return new;
end;
$$;

-- Nothing calls this by hand; the trigger machinery checks the privilege when
-- the trigger is created, not when it fires. Revoking keeps it off the REST API.
revoke all on function public.enforce_signup_rules() from public, anon, authenticated;

drop trigger if exists signups_rules on public.signups;
create trigger signups_rules
  before insert on public.signups
  for each row execute function public.enforce_signup_rules();

-- ---------------------------------------------------------------------------
-- Saving an event and its food slots together
-- ---------------------------------------------------------------------------

-- One transaction, so an event never ends up half-saved. Runs as the caller,
-- so the organizer-only policies above still apply.
create or replace function public.save_event(p_event jsonb, p_slots jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id       uuid := nullif(p_event->>'id', '')::uuid;
  v_keep     uuid[];
  v_slot     jsonb;
  v_slot_id  uuid;
  v_position integer := 0;
begin
  if not public.is_organizer() then
    raise exception 'Only organizers can create or change events.';
  end if;

  if v_id is null then
    insert into public.events (
      title, description, location, event_date, start_time, end_time,
      needs_host, host_limit, allow_other_food, created_by
    )
    values (
      p_event->>'title',
      coalesce(p_event->>'description', ''),
      coalesce(p_event->>'location', ''),
      (p_event->>'event_date')::date,
      nullif(p_event->>'start_time', '')::time,
      nullif(p_event->>'end_time', '')::time,
      coalesce((p_event->>'needs_host')::boolean, true),
      coalesce((p_event->>'host_limit')::integer, 1),
      coalesce((p_event->>'allow_other_food')::boolean, true),
      auth.uid()
    )
    returning id into v_id;
  else
    update public.events set
      title            = p_event->>'title',
      description      = coalesce(p_event->>'description', ''),
      location         = coalesce(p_event->>'location', ''),
      event_date       = (p_event->>'event_date')::date,
      start_time       = nullif(p_event->>'start_time', '')::time,
      end_time         = nullif(p_event->>'end_time', '')::time,
      needs_host       = coalesce((p_event->>'needs_host')::boolean, true),
      host_limit       = coalesce((p_event->>'host_limit')::integer, 1),
      allow_other_food = coalesce((p_event->>'allow_other_food')::boolean, true),
      updated_at       = now()
    where id = v_id;
    if not found then
      raise exception 'That event no longer exists.';
    end if;
  end if;

  v_keep := array[]::uuid[];
  for v_slot in select * from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb))
  loop
    v_slot_id := nullif(v_slot->>'id', '')::uuid;
    if v_slot_id is null then
      insert into public.food_slots (event_id, label, needed, position)
      values (v_id, v_slot->>'label', coalesce((v_slot->>'needed')::integer, 1), v_position)
      returning id into v_slot_id;
    else
      update public.food_slots set
        label    = v_slot->>'label',
        needed   = coalesce((v_slot->>'needed')::integer, 1),
        position = v_position
      where id = v_slot_id and event_id = v_id;
    end if;
    v_keep := v_keep || v_slot_id;
    v_position := v_position + 1;
  end loop;

  delete from public.food_slots where event_id = v_id and not (id = any (v_keep));

  return v_id;
end;
$$;

revoke all on function public.save_event(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_event(jsonb, jsonb) to authenticated;
