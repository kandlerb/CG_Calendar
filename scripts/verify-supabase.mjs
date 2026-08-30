#!/usr/bin/env node
// Checks that a Supabase project is set up correctly for this calendar.
//
//   node scripts/verify-supabase.mjs <project-url> <anon-key>
//   node scripts/verify-supabase.mjs <project-url> <anon-key> <organizer-email> <password>
//
// With just the URL and anon key it checks what a visitor sees, and that the
// database refuses what it should. Add an organizer's login and it also
// creates a throwaway event, exercises the host and capacity rules against
// it, and deletes it again.
//
// Uses plain fetch — no dependencies, nothing installed.

const [url, anonKey, organizerEmail, organizerPassword] = process.argv.slice(2);

if (!url || !anonKey) {
  console.error('usage: node scripts/verify-supabase.mjs <project-url> <anon-key> [organizer-email] [password]');
  process.exit(2);
}

const base = url.replace(/\/+$/, '');
let passed = 0;
let failed = 0;

function ok(what, detail = '') {
  passed += 1;
  console.log(`  ok    ${what}${detail ? ` — ${detail}` : ''}`);
}

function fail(what, detail = '') {
  failed += 1;
  console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`);
}

function check(condition, what, detail = '') {
  if (condition) ok(what, detail);
  else fail(what, detail);
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${token ?? anonKey}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { status: 0, ok: false, data: `could not reach the project (${err.cause?.code ?? err.message})` };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

const errorText = (data) =>
  typeof data === 'string' ? data : (data?.message ?? data?.error_description ?? data?.msg ?? JSON.stringify(data));

// --- reachable ------------------------------------------------------------

console.log(`\nChecking ${base}\n`);
console.log('Visitor (anon key only)');

// Asks the auth service what it is configured for. It needs nothing from
// schema.sql, so it separates "wrong URL or key" from "the tables are
// missing". (The REST root, /rest/v1/, is not usable here — it now answers
// "Secret API key required" even when the publishable key is perfectly good.)
const health = await api('/auth/v1/settings');
if (health.status === 0) {
  fail('the project is reachable', errorText(health.data));
  console.log('\nCheck the project URL — it looks like https://<ref>.supabase.co\n');
  process.exit(1);
}
if (health.status === 401 || health.status === 403) {
  fail('the anon key is accepted', errorText(health.data));
  console.log('\nThe key was rejected. Copy the "anon public" key from Project Settings → API.\n');
  process.exit(1);
}
ok('the project is reachable and the anon key is accepted');

const anonymousEnabled = health.data?.external?.anonymous_users === true;

// --- schema present -------------------------------------------------------

for (const table of ['events', 'food_slots', 'signups']) {
  const res = await api(`/rest/v1/${table}?select=id&limit=1`);
  check(
    res.ok,
    `the ${table} table exists and is readable`,
    res.ok ? '' : `${res.status}: ${errorText(res.data)} — has supabase/schema.sql been run?`,
  );
}

const organizers = await api('/rest/v1/organizers?select=user_id');
check(
  organizers.ok && Array.isArray(organizers.data) && organizers.data.length === 0,
  'the organizer list is not readable by visitors',
  organizers.ok ? '' : `${organizers.status}: ${errorText(organizers.data)}`,
);

// --- anonymous sign-in ----------------------------------------------------

const anonSession = anonymousEnabled
  ? await api('/auth/v1/signup', { method: 'POST', body: {} })
  : null;
const anonToken = anonSession?.data?.access_token;
if (!anonymousEnabled) {
  fail(
    'anonymous sign-ins are enabled',
    'turn them on under Authentication → Sign In / Providers → Anonymous sign-ins. ' +
      'Until then nobody can sign up to host or bring food.',
  );
} else if (!anonToken) {
  fail('anonymous sign-ins are enabled', `${anonSession.status}: ${errorText(anonSession.data)}`);
} else {
  ok('anonymous sign-ins are enabled', 'visitors can sign up for things');
}

// --- the rules hold for a visitor ----------------------------------------

const sneakyInsert = await api('/rest/v1/events', {
  method: 'POST',
  token: anonToken,
  body: { title: 'Verification probe', event_date: '2099-01-01' },
});
check(
  !sneakyInsert.ok,
  'a visitor cannot create an event',
  sneakyInsert.ok ? 'IT SUCCEEDED — row level security is not on. Re-run supabase/schema.sql.' : `refused with ${sneakyInsert.status}`,
);

const sneakyRpc = await api('/rest/v1/rpc/save_event', {
  method: 'POST',
  token: anonToken,
  body: { p_event: { title: 'Verification probe', event_date: '2099-01-01' }, p_slots: [] },
});
check(
  !sneakyRpc.ok,
  'a visitor cannot create an event through save_event()',
  sneakyRpc.ok ? 'IT SUCCEEDED — check the is_organizer() guard in save_event.' : `refused with ${sneakyRpc.status}`,
);

// --- organizer round trip -------------------------------------------------

if (organizerEmail && organizerPassword) {
  console.log('\nOrganizer');
  const login = await api('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: organizerEmail, password: organizerPassword },
  });
  const token = login.data?.access_token;

  if (!token) {
    fail('the organizer can sign in', `${login.status}: ${errorText(login.data)}`);
  } else {
    ok('the organizer can sign in');

    const mine = await api('/rest/v1/organizers?select=name', { token });
    const isOrganizer = Array.isArray(mine.data) && mine.data.length === 1;
    check(isOrganizer, 'that account is listed in public.organizers', isOrganizer ? mine.data[0].name : 'run the insert into public.organizers snippet from the README');

    if (isOrganizer) {
      const created = await api('/rest/v1/rpc/save_event', {
        method: 'POST',
        token,
        body: {
          p_event: {
            title: 'Setup check — safe to delete',
            event_date: '2099-01-01',
            start_time: '18:30',
            needs_host: true,
            host_limit: 1,
            allow_other_food: true,
          },
          p_slots: [
            { label: 'Main dish', capacity: 1 },
            { label: 'Side dish', capacity: 0 },
          ],
        },
      });
      const eventId = created.data;
      check(created.ok && Boolean(eventId), 'the organizer can create an event', created.ok ? '' : errorText(created.data));

      if (eventId) {
        const slots = await api(`/rest/v1/food_slots?event_id=eq.${eventId}&select=id,label,capacity&order=position`, { token });
        check(slots.data?.length === 2, 'its food slots were saved', `${slots.data?.length ?? 0} slot(s)`);
        const main = slots.data?.find((s) => s.label === 'Main dish');
        const sides = slots.data?.find((s) => s.label === 'Side dish');

        const host1 = await api('/rest/v1/signups', {
          method: 'POST',
          token: anonToken,
          body: { event_id: eventId, kind: 'host', name: 'Setup check' },
        });
        check(host1.ok, 'a visitor can sign up to host', host1.ok ? '' : errorText(host1.data));

        const host2 = await api('/rest/v1/signups', {
          method: 'POST',
          token: anonToken,
          body: { event_id: eventId, kind: 'host', name: 'Setup check two' },
        });
        check(!host2.ok, 'a second host is refused', host2.ok ? 'IT SUCCEEDED — the capacity trigger is missing.' : errorText(host2.data));

        if (main) {
          const claim = await api('/rest/v1/signups', {
            method: 'POST',
            token: anonToken,
            body: { event_id: eventId, slot_id: main.id, kind: 'food', name: 'Setup check', item: 'Lasagna' },
          });
          check(claim.ok, 'a visitor can claim a food slot', claim.ok ? '' : errorText(claim.data));

          const double = await api('/rest/v1/signups', {
            method: 'POST',
            token: anonToken,
            body: { event_id: eventId, slot_id: main.id, kind: 'food', name: 'Setup check two', item: 'Chili' },
          });
          check(!double.ok, 'a full food slot is closed', double.ok ? 'IT SUCCEEDED — the capacity trigger is missing.' : errorText(double.data));
        }

        if (sides) {
          const results = [];
          for (const dish of ['Green beans', 'Potatoes', 'Corn']) {
            const res = await api('/rest/v1/signups', {
              method: 'POST',
              token: anonToken,
              body: { event_id: eventId, slot_id: sides.id, kind: 'food', name: 'Setup check', item: dish },
            });
            results.push(res.ok);
          }
          check(results.every(Boolean), 'a slot set to 0 takes everyone', `${results.filter(Boolean).length} of 3 accepted`);
        }

        const cleanup = await api(`/rest/v1/events?id=eq.${eventId}`, { method: 'DELETE', token });
        check(cleanup.ok, 'the test event was cleaned up', cleanup.ok ? '' : `delete it by hand: ${eventId}`);
      }
    }
  }
} else {
  console.log('\n(Pass an organizer email and password to also test creating an event.)');
}

console.log(`\n${failed === 0 ? 'All good' : 'Problems found'}: ${passed} passed, ${failed} failed.\n`);
process.exit(failed === 0 ? 0 : 1);
