-- Tests for the rules in schema.sql, run against a real PostgreSQL.
--
--   createdb cgtest
--   psql -v ON_ERROR_STOP=1 -d cgtest -f supabase/tests/harness.sql
--   psql -v ON_ERROR_STOP=1 -d cgtest -f supabase/schema.sql
--   psql -v ON_ERROR_STOP=1 -d cgtest -f supabase/tests/schema_test.sql
--
-- Any failure aborts with an error. The last line prints the pass count.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
set client_min_messages = warning;

create or replace function tests_assert(ok boolean, what text)
returns void language plpgsql as $$
begin
  if ok then
    perform set_config('tests.passed', (current_setting('tests.passed', true)::int + 1)::text, false);
    raise notice 'ok    %', what;
  else
    raise exception 'FAILED: %', what;
  end if;
end $$;

-- Becomes the given signed-in user (or a visitor with no session at all).
create or replace function tests_become(who uuid)
returns void language plpgsql as $$
begin
  if who is null then
    perform set_config('request.jwt.claim.sub', '', false);
    execute 'set role anon';
  else
    perform set_config('request.jwt.claim.sub', who::text, false);
    execute 'set role authenticated';
  end if;
end $$;

-- Runs a statement expected to fail, and checks the message.
create or replace function tests_expect_error(stmt text, fragment text, what text)
returns void language plpgsql as $$
declare
  msg text;
begin
  execute stmt;
  perform tests_assert(false, what || ' (statement unexpectedly succeeded)');
exception
  when others then
    msg := sqlerrm;
    perform tests_assert(
      position(lower(fragment) in lower(msg)) > 0,
      what || ' → ' || msg
    );
end $$;

select set_config('tests.passed', '0', false);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'brian@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'anna@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'bob@example.com');

insert into public.organizers (user_id, name)
values ('11111111-1111-1111-1111-111111111111', 'Brian');

\set organizer  '''11111111-1111-1111-1111-111111111111'''
\set anna       '''22222222-2222-2222-2222-222222222222'''
\set bob        '''33333333-3333-3333-3333-333333333333'''
\set second     '''44444444-4444-4444-4444-444444444444'''

-- ---------------------------------------------------------------------------
-- Only organizers may create or change events
-- ---------------------------------------------------------------------------

select tests_become(:anna::uuid);
select tests_expect_error(
  $$select public.save_event('{"title":"Sneaky","event_date":"2026-09-02"}'::jsonb, '[]'::jsonb)$$,
  'Only organizers',
  'a participant cannot create an event');

select tests_expect_error(
  $$insert into public.events (title, event_date) values ('Direct', '2026-09-02')$$,
  'row-level security',
  'a participant cannot insert an event directly');

select tests_become(null);
select tests_expect_error(
  $$insert into public.events (title, event_date) values ('Anon', '2026-09-02')$$,
  'permission denied',
  'a visitor with no session cannot insert an event');

-- The organizer list itself is not public.
select tests_assert(
  (select count(*) from public.organizers) = 0,
  'a visitor cannot read the organizer list');

select tests_become(:anna::uuid);
select tests_assert(
  (select count(*) from public.organizers) = 0,
  'a participant cannot read the organizer list');

-- ---------------------------------------------------------------------------
-- An organizer creates an event with food slots
-- ---------------------------------------------------------------------------

select tests_become(:organizer::uuid);
select public.save_event(
  '{"title":"Community Group","event_date":"2026-09-02","start_time":"18:30","end_time":"20:30",
    "location":"TBD","needs_host":true,"host_limit":1,"allow_other_food":true}'::jsonb,
  '[{"label":"Main dish","needed":1},{"label":"Side dish","needed":0},{"label":"Dessert","needed":2}]'::jsonb
) as event_id \gset

select tests_assert(
  (select count(*) from public.food_slots where event_id = :'event_id'::uuid) = 3,
  'save_event stored three food slots');

select tests_assert(
  (select position from public.food_slots where event_id = :'event_id'::uuid and label = 'Dessert') = 2,
  'food slots keep the order they were given in');

-- Everyone can read the calendar, signed in or not.
select tests_become(null);
select tests_assert((select count(*) from public.events) = 1, 'a visitor can read events');
select tests_assert((select count(*) from public.food_slots) = 3, 'a visitor can read food slots');

-- ---------------------------------------------------------------------------
-- Host sign-ups
-- ---------------------------------------------------------------------------

select tests_become(:anna::uuid);
insert into public.signups (event_id, kind, name) values (:'event_id'::uuid, 'host', 'Anna');
select tests_assert(
  (select count(*) from public.signups where kind = 'host') = 1,
  'a participant can sign up to host');

select tests_become(:bob::uuid);
select tests_expect_error(
  format($$insert into public.signups (event_id, kind, name) values (%L, 'host', 'Bob')$$, :'event_id'),
  'already signed up to host',
  'a second host is refused');

-- ---------------------------------------------------------------------------
-- Food slots ask for a number; they never turn anyone away
-- ---------------------------------------------------------------------------

select id from public.food_slots where event_id = :'event_id'::uuid and label = 'Main dish' \gset main_
select id from public.food_slots where event_id = :'event_id'::uuid and label = 'Side dish' \gset side_

select tests_become(:anna::uuid);
insert into public.signups (event_id, slot_id, kind, name, item, contact)
values (:'event_id'::uuid, :'main_id'::uuid, 'food', 'Anna', 'Lasagna', '555-0100');

-- "Main dish" asked for one person and already has one. A second is still
-- allowed: the number is a minimum, not a cap.
select tests_become(:bob::uuid);
insert into public.signups (event_id, slot_id, kind, name, item)
values (:'event_id'::uuid, :'main_id'::uuid, 'food', 'Bob', 'Chili');
select tests_assert(
  (select count(*) from public.signups where slot_id = :'main_id'::uuid) = 2,
  'a slot takes more people than it asked for');

select tests_assert(
  (select count(*) from public.signups
    where slot_id = :'main_id'::uuid and name = 'Bob' and item = 'Chili') = 1,
  'each person keeps what they said they are bringing');

-- A slot asking for nobody in particular behaves the same way.
insert into public.signups (event_id, slot_id, kind, name, item)
values (:'event_id'::uuid, :'side_id'::uuid, 'food', 'Bob', 'Green beans');
select tests_become(:anna::uuid);
insert into public.signups (event_id, slot_id, kind, name, item)
values (:'event_id'::uuid, :'side_id'::uuid, 'food', 'Anna', 'Roasted potatoes');
select tests_become(:organizer::uuid);
insert into public.signups (event_id, slot_id, kind, name, item)
values (:'event_id'::uuid, :'side_id'::uuid, 'food', 'Brian', 'Corn casserole');
select tests_assert(
  (select count(*) from public.signups where slot_id = :'side_id'::uuid) = 3,
  'a slot with no minimum takes everyone');

-- What is still enforced: the slot has to belong to this event.
select tests_become(:bob::uuid);
select tests_expect_error(
  format($$insert into public.signups (event_id, slot_id, kind, name, item)
           values (%L, gen_random_uuid(), 'food', 'Bob', 'Rolls')$$, :'event_id'),
  'no longer on this event',
  'a sign-up cannot name a slot from another event');

-- Food sign-ups must say what they are bringing.
select tests_become(:bob::uuid);
select tests_expect_error(
  format($$insert into public.signups (event_id, kind, name) values (%L, 'food', 'Bob')$$, :'event_id'),
  'signups_food_needs_item',
  'a food sign-up must name a dish');

-- ---------------------------------------------------------------------------
-- You may only change your own sign-up
-- ---------------------------------------------------------------------------

select id from public.signups where name = 'Anna' and item = 'Lasagna' \gset annas_

select tests_become(:bob::uuid);
update public.signups set item = 'Nothing' where id = :'annas_id'::uuid;
select tests_assert(
  (select item from public.signups where id = :'annas_id'::uuid) = 'Lasagna',
  'one participant cannot edit another''s sign-up');

delete from public.signups where id = :'annas_id'::uuid;
select tests_assert(
  (select count(*) from public.signups where id = :'annas_id'::uuid) = 1,
  'one participant cannot delete another''s sign-up');

select tests_become(:anna::uuid);
update public.signups set item = 'Two pans of lasagna' where id = :'annas_id'::uuid;
select tests_assert(
  (select item from public.signups where id = :'annas_id'::uuid) = 'Two pans of lasagna',
  'a participant can edit their own sign-up');

-- What a sign-up is for was checked when it was added; editing it may change
-- what the person typed, but not move it past those checks. Otherwise a food
-- sign-up could become a second host, or point at another event's slot.
select tests_expect_error(
  format($$update public.signups set kind = 'host' where id = %L$$, :'annas_id'),
  'permission denied',
  'a food sign-up cannot be turned into a host sign-up');

select tests_expect_error(
  format($$update public.signups set event_id = %L where id = %L$$, :'event_id', :'annas_id'),
  'permission denied',
  'a sign-up cannot be moved to another event');

select tests_expect_error(
  format($$update public.signups set slot_id = %L where id = %L$$, :'side_id', :'annas_id'),
  'permission denied',
  'a sign-up cannot be moved to another food slot');

select tests_expect_error(
  format($$update public.signups set created_by = %L where id = %L$$, :bob, :'annas_id'),
  'permission denied',
  'a sign-up cannot be handed to someone else');

update public.signups set contact = '555-0199', note = 'Running late' where id = :'annas_id'::uuid;
select tests_assert(
  (select note from public.signups where id = :'annas_id'::uuid) = 'Running late',
  'a participant can still change their name, contact, dish and note');

-- ---------------------------------------------------------------------------
-- Contact details are not public
-- ---------------------------------------------------------------------------

select tests_become(null);
select tests_expect_error(
  $$select contact from public.signups$$,
  'permission denied',
  'a signed-out visitor cannot read contact details');

select tests_become(:bob::uuid);
select tests_expect_error(
  $$select * from public.signups$$,
  'permission denied',
  'another participant cannot read contact details, even with select *');

select tests_assert(
  (select count(*) from public.signup_contacts()) = 0,
  'another participant gets none of anyone else''s contact details');

select tests_become(:anna::uuid);
select tests_assert(
  (select contact from public.signup_contacts() where signup_id = :'annas_id'::uuid) = '555-0199',
  'a participant can see the contact on their own sign-up');

select tests_become(:organizer::uuid);
select tests_assert(
  (select contact from public.signup_contacts() where signup_id = :'annas_id'::uuid) = '555-0199',
  'an organizer can see everyone''s contact details');

select tests_assert(
  not has_function_privilege('anon', 'public.signup_contacts()', 'execute'),
  'a signed-out visitor cannot call signup_contacts()');

-- Sign-ups are stamped with their author, whatever the browser claims.
select tests_become(:bob::uuid);
select tests_expect_error(
  format($$insert into public.signups (event_id, kind, name, item, created_by)
           values (%L, 'food', 'Bob', 'Rolls', %L)$$, :'event_id', :anna),
  'row-level security',
  'a participant cannot post a sign-up as someone else');

-- An organizer can tidy up anyone's.
select tests_become(:organizer::uuid);
delete from public.signups where id = :'annas_id'::uuid;
select tests_assert(
  (select count(*) from public.signups where id = :'annas_id'::uuid) = 0,
  'an organizer can remove any sign-up');

-- ---------------------------------------------------------------------------
-- Editing an event
-- ---------------------------------------------------------------------------

-- Removing a slot keeps the sign-up, as "something else".
select tests_become(:organizer::uuid);
select public.save_event(
  format('{"id":"%s","title":"Potluck","event_date":"2026-09-02","needs_host":true,
           "host_limit":1,"allow_other_food":true}', :'event_id')::jsonb,
  format('[{"id":"%s","label":"Main dish","needed":1}]', :'main_id')::jsonb
);
select tests_assert(
  (select title from public.events where id = :'event_id'::uuid) = 'Potluck',
  'an organizer can rename an event');
select tests_assert(
  (select count(*) from public.food_slots where event_id = :'event_id'::uuid) = 1,
  'removed food slots are deleted');
select tests_assert(
  (select count(*) from public.signups where name = 'Bob' and item = 'Green beans' and slot_id is null) = 1,
  'a sign-up survives its slot being removed');

select tests_become(:anna::uuid);
select tests_expect_error(
  format($$select public.save_event('{"id":"%s","title":"Hijacked","event_date":"2026-09-02"}'::jsonb, '[]'::jsonb)$$, :'event_id'),
  'Only organizers',
  'a participant cannot edit an existing event');

-- ---------------------------------------------------------------------------
-- Field rules
-- ---------------------------------------------------------------------------

select tests_become(:organizer::uuid);
select tests_expect_error(
  $$select public.save_event('{"title":"","event_date":"2026-09-02"}'::jsonb, '[]'::jsonb)$$,
  'events_title_check',
  'an event needs a title');

select tests_expect_error(
  $$select public.save_event('{"title":"Backwards","event_date":"2026-09-02","start_time":"19:00","end_time":"18:00"}'::jsonb, '[]'::jsonb)$$,
  'events_time_order',
  'an event cannot end before it starts');

select tests_expect_error(
  $$select public.save_event('{"title":"Bad slot","event_date":"2026-09-02"}'::jsonb, '[{"label":"Salad","needed":-1}]'::jsonb)$$,
  'food_slots_needed_check',
  'a food slot cannot need a negative number of people');

-- ---------------------------------------------------------------------------
-- Your own display name
-- ---------------------------------------------------------------------------
--
-- Being an organizer is granted from the dashboard; the label the header shows
-- is not, so each organizer may set their own and nobody else's.

select tests_become(:organizer::uuid);
update public.organizers set name = 'Kandler Baker' where user_id = :organizer::uuid;
select tests_assert(
  (select name from public.organizers where user_id = :organizer::uuid) = 'Kandler Baker',
  'an organizer can rename themselves');

-- A second organizer, to prove the policy is scoped to the caller's own row.
select tests_become(null);
reset role;
insert into auth.users (id, email) values (:second::uuid, 'second@example.com');
insert into public.organizers (user_id, name) values (:second::uuid, 'Timothy');

select tests_become(:organizer::uuid);
update public.organizers set name = 'Hijacked' where user_id = :second::uuid;
select tests_assert(
  (select count(*) from public.organizers where name = 'Hijacked') = 0,
  'an organizer cannot rename another organizer');

select tests_expect_error(
  format($$update public.organizers set user_id = '%s' where user_id = '%s'$$, :second, :organizer),
  'permission denied',
  'an organizer cannot repoint their row at someone else');

select tests_become(:anna::uuid);
update public.organizers set name = 'Sneaky' where user_id = :organizer::uuid;
select tests_assert(
  (select count(*) from public.organizers where name = 'Sneaky') = 0,
  'a participant cannot rename an organizer');

reset role;
delete from public.organizers where user_id = :second::uuid;
delete from auth.users where id = :second::uuid;

-- ---------------------------------------------------------------------------
-- Table privileges
-- ---------------------------------------------------------------------------
--
-- Row level security decides which rows a statement may touch, but TRUNCATE
-- ignores it entirely, so a signed-out visitor must not hold the privilege in
-- the first place. Supabase grants new tables in "public" to anon by default;
-- schema.sql revokes that, and these check it stayed revoked.

select tests_assert(
  has_table_privilege('anon', 'public.events', 'select'),
  'a signed-out visitor can read events');

select tests_assert(
  not has_table_privilege('anon', 'public.events', 'insert'),
  'a signed-out visitor has no INSERT on events');

select tests_assert(
  not has_table_privilege('anon', 'public.signups', 'insert'),
  'a signed-out visitor has no INSERT on sign-ups');

select tests_assert(
  not has_table_privilege('anon', 'public.events', 'truncate'),
  'a signed-out visitor cannot TRUNCATE events');

select tests_assert(
  not has_table_privilege('authenticated', 'public.events', 'truncate'),
  'a signed-in visitor cannot TRUNCATE events');

select tests_assert(
  not has_table_privilege('anon', 'public.organizers', 'insert'),
  'nobody can add themselves to the organizer list');

select tests_assert(
  not has_table_privilege('authenticated', 'public.organizers', 'insert'),
  'a signed-in visitor cannot add themselves as an organizer');

select tests_assert(
  has_table_privilege('authenticated', 'public.signups', 'insert'),
  'a signed-in visitor can still add sign-ups');

-- The guard inside save_event() already refuses non-organizers; anon should
-- not reach the function at all.
select tests_assert(
  not has_function_privilege('anon', 'public.save_event(jsonb,jsonb)', 'execute'),
  'a signed-out visitor cannot call save_event()');

select tests_assert(
  has_function_privilege('authenticated', 'public.save_event(jsonb,jsonb)', 'execute'),
  'a signed-in organizer can call save_event()');

-- A trigger function is never called by hand; PostgreSQL checks the privilege
-- when the trigger is created, not when it fires.
select tests_assert(
  not has_function_privilege('anon', 'public.enforce_signup_rules()', 'execute'),
  'the sign-up trigger function is not on the REST API');

-- ---------------------------------------------------------------------------
-- Cancelling an event
-- ---------------------------------------------------------------------------

select tests_become(:anna::uuid);
update public.events set cancelled = true where id = :'event_id'::uuid;
select tests_assert(
  not (select cancelled from public.events where id = :'event_id'::uuid),
  'a participant cannot cancel an event');

select tests_become(:organizer::uuid);
update public.events set cancelled = true where id = :'event_id'::uuid;
select tests_assert(
  (select cancelled from public.events where id = :'event_id'::uuid),
  'an organizer can cancel an event');

select tests_become(:bob::uuid);
select tests_expect_error(
  format($$insert into public.signups (event_id, kind, name, item) values (%L, 'food', 'Bob', 'Rolls')$$, :'event_id'),
  'has been cancelled',
  'a cancelled event takes no new sign-ups');

-- Saving the event's details does not quietly bring it back.
select tests_become(:organizer::uuid);
select public.save_event(
  format('{"id":"%s","title":"Potluck","event_date":"2026-09-02","needs_host":true,
           "host_limit":1,"allow_other_food":true}', :'event_id')::jsonb,
  format('[{"id":"%s","label":"Main dish","needed":1}]', :'main_id')::jsonb
);
select tests_assert(
  (select cancelled from public.events where id = :'event_id'::uuid),
  'editing a cancelled event keeps it cancelled');

update public.events set cancelled = false where id = :'event_id'::uuid;
select tests_assert(
  not (select cancelled from public.events where id = :'event_id'::uuid),
  'an organizer can restore a cancelled event');

-- Deleting an event takes its slots and sign-ups with it.
delete from public.events where id = :'event_id'::uuid;
select tests_assert((select count(*) from public.signups) = 0, 'deleting an event removes its sign-ups');
select tests_assert((select count(*) from public.food_slots) = 0, 'deleting an event removes its food slots');

reset role;
select 'PASSED: ' || current_setting('tests.passed') || ' assertions' as result;
