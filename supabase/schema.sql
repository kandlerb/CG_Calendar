-- CG Calendar — Supabase schema
--
-- Run this once in your project's SQL editor (Supabase dashboard → SQL editor →
-- New query → paste → Run). It is safe to re-run: every statement is guarded.
--
-- What it sets up:
--   * events, food_slots, signups  — the calendar itself
--   * members                      — everyone who joined with the invite code;
--                                    only they can see the calendar
--   * group_settings               — the invite code, readable by organizers only
--   * organizers                   — the only people who may add or change events
--   * row level security           — those rules, enforced by the database, so
--                                    they hold no matter what a browser sends
--   * a sign-up trigger            — a slot belongs to its event, and only as
--                                    many hosts sign up as the event asked for
--   * feed_data()                  — what the calendar-feed Edge Function turns
--                                    into each member's subscription feed

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

-- Where a host is having it. Kept apart from the free-text note so the
-- calendar feed can put it in the address field calendar apps map.
alter table public.signups add column if not exists address text not null default '';
alter table public.signups drop constraint if exists signups_address_check;
alter table public.signups add constraint signups_address_check check (char_length(address) <= 200);

create index if not exists signups_event_idx on public.signups (event_id);
create index if not exists signups_slot_idx on public.signups (slot_id);

-- Everyone who may see the calendar. A row is added by join_group() when
-- someone enters the invite code; an organizer removing a member stamps
-- removed_at rather than deleting the row, so the same account cannot simply
-- join again with the code it already knows.
create table if not exists public.members (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  -- The secret in the member's calendar-feed link. Resetting it turns the old
  -- link off.
  feed_token   uuid not null unique default gen_random_uuid(),
  joined_at    timestamptz not null default now(),
  removed_at   timestamptz
);

-- One row: the invite code. Compared ignoring case and surrounding spaces.
create table if not exists public.group_settings (
  id          boolean primary key default true check (id),
  invite_code text not null check (char_length(btrim(invite_code)) between 6 and 80)
);

-- A random starting code, so a fresh project is never open to a blank or
-- guessable one. Organizers read and change it from the page.
insert into public.group_settings (id, invite_code)
values (true, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
on conflict (id) do nothing;

-- Wrong invite codes, per account, so the code cannot be guessed by trying
-- one after another.
create table if not exists public.join_attempts (
  user_id      uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists join_attempts_user_idx on public.join_attempts (user_id, attempted_at);

-- ---------------------------------------------------------------------------
-- Who is an organizer, and who is a member
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

-- Organizers are always members; they never need the invite code.
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_organizer()
      or exists (
           select 1 from public.members
            where user_id = auth.uid() and removed_at is null
         );
$$;

revoke all on function public.is_member() from public;
grant execute on function public.is_member() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.organizers enable row level security;
alter table public.events     enable row level security;
alter table public.food_slots enable row level security;
alter table public.signups    enable row level security;
alter table public.members        enable row level security;
alter table public.group_settings enable row level security;
alter table public.join_attempts  enable row level security;

-- Table privileges say who may attempt a statement at all; the policies below
-- say which rows it may touch. "anon" is a visitor with no session, and gets
-- nothing: the calendar is for members. Everyone who signs in is
-- "authenticated", and the policies then let members read and sign up.
-- Supabase's default privileges hand every new table in "public" to anon and
-- authenticated, which is wider than the model above: it gives a signed-out
-- visitor INSERT and TRUNCATE, and TRUNCATE is not filtered by row level
-- security. Clear that first, so the grants below are the whole picture.
revoke all on public.organizers, public.events, public.food_slots, public.signups,
  public.members, public.group_settings, public.join_attempts
  from anon, authenticated;

grant select on public.organizers, public.events, public.food_slots, public.signups
  to authenticated;
grant insert, update, delete on public.events, public.food_slots, public.signups
  to authenticated;

-- Your display name is yours to set. The grant names one column, so even with
-- the policy below nobody can repoint their row at a different user_id.
grant update (name) on public.organizers to authenticated;

-- The invite code: organizers read it and change it. Nobody else can see it,
-- signed in or not; join_group() checks a guess without revealing it.
grant select, update (invite_code) on public.group_settings to authenticated;

-- members and join_attempts get no grants at all. Everything about them goes
-- through the functions further down, which check who is asking.

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

drop policy if exists group_settings_organizers on public.group_settings;
create policy group_settings_organizers on public.group_settings
  for all using (public.is_organizer()) with check (public.is_organizer());

-- Events and their food slots: members may read them; only organizers may
-- write them.
drop policy if exists events_read_all on public.events;
drop policy if exists events_read_members on public.events;
create policy events_read_members on public.events
  for select using (public.is_member());

drop policy if exists events_write_organizers on public.events;
create policy events_write_organizers on public.events
  for all using (public.is_organizer()) with check (public.is_organizer());

drop policy if exists food_slots_read_all on public.food_slots;
drop policy if exists food_slots_read_members on public.food_slots;
create policy food_slots_read_members on public.food_slots
  for select using (public.is_member());

drop policy if exists food_slots_write_organizers on public.food_slots;
create policy food_slots_write_organizers on public.food_slots
  for all using (public.is_organizer()) with check (public.is_organizer());

-- Sign-ups: members may read them and add their own. You may change or remove
-- only the ones you created — unless you are an organizer, who may tidy up
-- anyone's. A removed member keeps nothing: not even their own sign-ups.
drop policy if exists signups_read_all on public.signups;
drop policy if exists signups_read_members on public.signups;
create policy signups_read_members on public.signups
  for select using (public.is_member());

drop policy if exists signups_insert_own on public.signups;
create policy signups_insert_own on public.signups
  for insert with check (created_by = auth.uid() and public.is_member());

drop policy if exists signups_update_own on public.signups;
create policy signups_update_own on public.signups
  for update using ((created_by = auth.uid() and public.is_member()) or public.is_organizer())
  with check ((created_by = auth.uid() and public.is_member()) or public.is_organizer());

drop policy if exists signups_delete_own on public.signups;
create policy signups_delete_own on public.signups
  for delete using ((created_by = auth.uid() and public.is_member()) or public.is_organizer());

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

-- ---------------------------------------------------------------------------
-- A sign-up changes what its event says
-- ---------------------------------------------------------------------------
--
-- The calendar feed writes who is bringing what into each event's
-- description, so an event counts as changed whenever a sign-up is added,
-- edited or removed. Calendar apps read that from the feed's LAST-MODIFIED.

create or replace function public.touch_event_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.events set updated_at = now()
   where id = coalesce(new.event_id, old.event_id);
  return null;
end;
$$;

revoke all on function public.touch_event_on_signup() from public, anon, authenticated;

drop trigger if exists signups_touch_event on public.signups;
create trigger signups_touch_event
  after insert or update or delete on public.signups
  for each row execute function public.touch_event_on_signup();

-- ---------------------------------------------------------------------------
-- Joining with the invite code
-- ---------------------------------------------------------------------------

-- Returns 'joined', or 'wrong_code' for a code that does not match. A wrong
-- code is an answer rather than an error so the attempt it records survives:
-- raising would roll the record back with everything else.
create or replace function public.join_group(p_code text, p_display_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_member   public.members%rowtype;
  v_expected text;
  v_name     text := btrim(coalesce(p_display_name, ''));
begin
  if v_user is null then
    raise exception 'Sign in first.';
  end if;
  if exists (select 1 from auth.users where id = v_user and coalesce(is_anonymous, false)) then
    raise exception 'Create an account with your email to join.';
  end if;

  select * into v_member from public.members where user_id = v_user;
  if found then
    if v_member.removed_at is not null then
      raise exception 'This account was removed from the group. Ask an organizer to restore it.';
    end if;
    return 'joined';
  end if;

  if (select count(*) from public.join_attempts
       where user_id = v_user and attempted_at > now() - interval '15 minutes') >= 5 then
    raise exception 'Too many wrong codes. Wait 15 minutes, then try again.';
  end if;

  select invite_code into v_expected from public.group_settings where id;
  if v_expected is null then
    raise exception 'No invite code has been set yet. Ask an organizer.';
  end if;

  if lower(btrim(coalesce(p_code, ''))) <> lower(btrim(v_expected)) then
    insert into public.join_attempts (user_id) values (v_user);
    return 'wrong_code';
  end if;

  if v_name = '' then
    select split_part(email, '@', 1) into v_name from auth.users where id = v_user;
  end if;

  insert into public.members (user_id, display_name) values (v_user, left(v_name, 80));
  delete from public.join_attempts where user_id = v_user;
  return 'joined';
end;
$$;

-- Who you are to the calendar: your name, your feed secret, and whether you
-- are an organizer. Null if you have not joined. An organizer is given a
-- member row the first time they ask, so they get a feed like everyone else.
create or replace function public.my_membership()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_member public.members%rowtype;
  v_org    public.organizers%rowtype;
begin
  if v_user is null then
    return null;
  end if;

  select * into v_org from public.organizers where user_id = v_user;
  select * into v_member from public.members where user_id = v_user;

  if not found and v_org.user_id is not null then
    insert into public.members (user_id, display_name)
    values (v_user, v_org.name)
    returning * into v_member;
  end if;

  if v_member.user_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'display_name', coalesce(nullif(v_org.name, ''), v_member.display_name),
    'feed_token',   v_member.feed_token,
    'is_organizer', v_org.user_id is not null,
    'removed',      v_member.removed_at is not null and v_org.user_id is null
  );
end;
$$;

-- Your own name, as shown in the header and offered on sign-up forms.
create or replace function public.set_display_name(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'Only members can set a name.';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Enter a name up to 80 characters.';
  end if;
  update public.members set display_name = v_name where user_id = auth.uid();
  update public.organizers set name = v_name where user_id = auth.uid();
  return v_name;
end;
$$;

-- A new secret for your feed link; the old link stops working.
create or replace function public.reset_feed_token()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid;
begin
  if not public.is_member() then
    raise exception 'Only members have a calendar feed.';
  end if;
  update public.members set feed_token = gen_random_uuid()
   where user_id = auth.uid()
  returning feed_token into v_token;
  if v_token is null then
    raise exception 'Only members have a calendar feed.';
  end if;
  return v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- Organizers manage the members
-- ---------------------------------------------------------------------------

create or replace function public.list_members()
returns table (
  user_id      uuid,
  display_name text,
  email        text,
  joined_at    timestamptz,
  removed      boolean,
  is_organizer boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_organizer() then
    raise exception 'Only organizers can see the member list.';
  end if;
  -- Organizers are listed whether or not they have opened the page since
  -- becoming one (which is what gives them a member row).
  return query
    select u.id,
           coalesce(nullif(o.name, ''), m.display_name),
           u.email::text,
           coalesce(m.joined_at, o.created_at),
           o.user_id is null and m.removed_at is not null,
           o.user_id is not null
      from auth.users u
      left join public.members m    on m.user_id = u.id
      left join public.organizers o on o.user_id = u.id
     where m.user_id is not null or o.user_id is not null
     order by o.user_id is null and m.removed_at is not null,
              lower(coalesce(nullif(o.name, ''), m.display_name));
end;
$$;

-- Removing someone turns off their calendar and their feed at once; their
-- past sign-ups stay on the events. Restoring undoes it. Organizers are
-- managed from the dashboard, not from here.
create or replace function public.set_member_removed(p_user_id uuid, p_removed boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_organizer() then
    raise exception 'Only organizers can remove members.';
  end if;
  if exists (select 1 from public.organizers where user_id = p_user_id) then
    raise exception 'Organizers cannot be removed here.';
  end if;
  update public.members
     set removed_at = case when p_removed then coalesce(removed_at, now()) end
   where user_id = p_user_id;
  if not found then
    raise exception 'That person is not a member.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The calendar feed
-- ---------------------------------------------------------------------------
--
-- Calendar apps fetch a feed on their own schedule and cannot sign in, so the
-- feed link carries the member's feed_token instead. This hands back
-- everything the feed shows for the member holding that token — or null for
-- a token that is wrong, reset, or belongs to a removed member. Contact
-- details are left out: a feed ends up on Google's and Apple's servers.
--
-- The window is the last three months and everything ahead.
create or replace function public.feed_data(p_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member public.members%rowtype;
begin
  select m.* into v_member
    from public.members m
   where m.feed_token = p_token
     and (m.removed_at is null
          or exists (select 1 from public.organizers o where o.user_id = m.user_id));
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'member', jsonb_build_object('display_name', v_member.display_name),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id,
               'title', e.title,
               'description', e.description,
               'location', e.location,
               'event_date', e.event_date,
               'start_time', e.start_time,
               'end_time', e.end_time,
               'needs_host', e.needs_host,
               'host_limit', e.host_limit,
               'allow_other_food', e.allow_other_food,
               'updated_at', e.updated_at,
               'food_slots', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', f.id, 'label', f.label, 'needed', f.needed, 'position', f.position)
                          order by f.position)
                   from public.food_slots f where f.event_id = e.id), '[]'::jsonb),
               'signups', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'slot_id', s.slot_id, 'kind', s.kind, 'name', s.name,
                          'item', s.item, 'note', s.note, 'address', s.address,
                          'mine', s.created_by = v_member.user_id)
                          order by s.created_at)
                   from public.signups s where s.event_id = e.id), '[]'::jsonb)
             ) order by e.event_date, e.start_time)
        from public.events e
       where e.event_date >= current_date - interval '3 months'
    ), '[]'::jsonb)
  );
end;
$$;

-- Supabase hands every new function to anon and authenticated. Take that
-- back, then give each one to exactly who may call it.
revoke all on function public.join_group(text, text)              from public, anon, authenticated;
revoke all on function public.my_membership()                     from public, anon, authenticated;
revoke all on function public.set_display_name(text)              from public, anon, authenticated;
revoke all on function public.reset_feed_token()                  from public, anon, authenticated;
revoke all on function public.list_members()                      from public, anon, authenticated;
revoke all on function public.set_member_removed(uuid, boolean)   from public, anon, authenticated;
revoke all on function public.feed_data(uuid)                     from public, anon, authenticated;

grant execute on function public.join_group(text, text)            to authenticated;
grant execute on function public.my_membership()                   to authenticated;
grant execute on function public.set_display_name(text)            to authenticated;
grant execute on function public.reset_feed_token()                to authenticated;
grant execute on function public.list_members()                    to authenticated;
grant execute on function public.set_member_removed(uuid, boolean) to authenticated;
-- The feed function calls this with the public key; the token is the check.
grant execute on function public.feed_data(uuid)                   to anon, authenticated;
