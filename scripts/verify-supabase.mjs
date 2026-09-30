#!/usr/bin/env node
// Checks that a Supabase project is set up correctly for this calendar.
//
//   node scripts/verify-supabase.mjs <project-url> <anon-key>
//   node scripts/verify-supabase.mjs <project-url> <anon-key> <organizer-email> <password>
//
// With just the URL and anon key it checks that a signed-out visitor sees
// nothing, that the auth settings match the calendar, and that the feed
// function is deployed. Add an organizer's login and it also creates a
// throwaway event, exercises the host and sign-up rules against it, reads it
// back through the organizer's own calendar feed, and deletes it again.
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
const autoconfirm = health.data?.mailer_autoconfirm === true;

// --- auth settings --------------------------------------------------------

check(
  !anonymousEnabled,
  'anonymous sign-ins are off',
  anonymousEnabled
    ? 'turn them off under Authentication → Sign In / Providers → Anonymous sign-ins. ' +
      'They can no longer see anything, so they only add clutter to the user list.'
    : '',
);
check(
  health.data?.disable_signup !== true,
  'new accounts can be created',
  health.data?.disable_signup ? 'turn on "Allow new users to sign up" under Authentication → Sign In / Providers' : '',
);
check(
  autoconfirm,
  'new accounts do not wait for a confirmation email',
  autoconfirm
    ? ''
    : 'turn off "Confirm email" under Authentication → Sign In / Providers → Email. The invite code ' +
      'already decides who gets in; with it on, people must confirm before they can enter the code.',
);

// --- a signed-out visitor sees nothing -------------------------------------

for (const table of ['events', 'food_slots', 'signups']) {
  const res = await api(`/rest/v1/${table}?select=id&limit=1`);
  const refused = !res.ok && /permission denied/i.test(errorText(res.data));
  const missing = /does not exist|could not find/i.test(errorText(res.data));
  check(
    refused,
    `a signed-out visitor cannot read ${table}`,
    refused
      ? ''
      : missing
        ? `${res.status}: ${errorText(res.data)} — has supabase/schema.sql been run?`
        : res.ok
          ? 'IT SUCCEEDED — re-run supabase/schema.sql so only members can read the calendar.'
          : `${res.status}: ${errorText(res.data)}`,
  );
}

// Contact details are for organizers; the grants in schema.sql leave the
// column out of what a visitor may read, so asking for it is refused outright.
const contacts = await api('/rest/v1/signups?select=contact&limit=1');
check(
  !contacts.ok,
  'contact details are hidden from visitors',
  contacts.ok ? 'THEY ARE READABLE — re-run supabase/schema.sql.' : `refused with ${contacts.status}`,
);

const organizers = await api('/rest/v1/organizers?select=user_id');
check(
  !organizers.ok || (Array.isArray(organizers.data) && organizers.data.length === 0),
  'the organizer list is not readable by visitors',
  organizers.ok ? '' : `refused with ${organizers.status}`,
);

const settings = await api('/rest/v1/group_settings?select=invite_code');
check(
  !settings.ok || (Array.isArray(settings.data) && settings.data.length === 0),
  'the invite code is not readable by visitors',
  settings.ok && settings.data?.length ? 'IT IS READABLE — re-run supabase/schema.sql.' : '',
);

const sneakyJoin = await api('/rest/v1/rpc/join_group', {
  method: 'POST',
  body: { p_code: 'guess', p_display_name: 'Verification probe' },
});
check(
  !sneakyJoin.ok && sneakyJoin.status !== 404,
  'a signed-out visitor cannot try invite codes',
  sneakyJoin.status === 404
    ? 'join_group() is missing — re-run supabase/schema.sql'
    : sneakyJoin.ok
      ? 'IT SUCCEEDED — re-run supabase/schema.sql.'
      : `refused with ${sneakyJoin.status}`,
);

const sneakyInsert = await api('/rest/v1/events', {
  method: 'POST',
  body: { title: 'Verification probe', event_date: '2099-01-01' },
});
check(
  !sneakyInsert.ok,
  'a visitor cannot create an event',
  sneakyInsert.ok ? 'IT SUCCEEDED — row level security is not on. Re-run supabase/schema.sql.' : `refused with ${sneakyInsert.status}`,
);

const sneakyRpc = await api('/rest/v1/rpc/save_event', {
  method: 'POST',
  body: { p_event: { title: 'Verification probe', event_date: '2099-01-01' }, p_slots: [] },
});
check(
  !sneakyRpc.ok,
  'a visitor cannot create an event through save_event()',
  sneakyRpc.ok ? 'IT SUCCEEDED — check the is_organizer() guard in save_event.' : `refused with ${sneakyRpc.status}`,
);

// --- the calendar feed ----------------------------------------------------

async function fetchFeed(token) {
  try {
    const res = await fetch(`${base}/functions/v1/calendar-feed?token=${token}`);
    return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
  } catch (err) {
    return { status: 0, type: '', text: err.message };
  }
}

const badFeed = await fetchFeed('00000000-0000-0000-0000-000000000000');
check(
  badFeed.status === 404 && /not valid/i.test(badFeed.text),
  'the calendar-feed function is deployed and turns away a made-up link',
  badFeed.status === 404 && /not valid/i.test(badFeed.text)
    ? ''
    : badFeed.status === 401
      ? 'it is asking for a login — redeploy it with JWT verification off (--no-verify-jwt)'
      : `${badFeed.status}: ${badFeed.text.slice(0, 120)} — deploy supabase/functions/calendar-feed`,
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

    const mine = await api('/rest/v1/rpc/my_membership', { method: 'POST', token, body: {} });
    const isOrganizer = mine.data?.is_organizer === true;
    check(isOrganizer, 'that account is listed in public.organizers', isOrganizer ? mine.data.display_name : 'run the insert into public.organizers snippet from the README');
    const feedToken = mine.data?.feed_token;

    const code = await api('/rest/v1/group_settings?select=invite_code', { token });
    check(
      code.ok && code.data?.length === 1,
      'the organizer can read the invite code',
      code.ok ? (code.data?.length ? '' : 'no invite code row — re-run supabase/schema.sql') : errorText(code.data),
    );

    if (isOrganizer) {
      const created = await api('/rest/v1/rpc/save_event', {
        method: 'POST',
        token,
        body: {
          p_event: {
            title: 'Setup check — safe to delete',
            event_date: '2099-01-01',
            location: '1 Setup Check Way, Augusta, GA',
            start_time: '18:30',
            needs_host: true,
            host_limit: 1,
            allow_other_food: true,
          },
          p_slots: [
            { label: 'Main dish', needed: 1 },
            { label: 'Side dish', needed: 0 },
          ],
        },
      });
      const eventId = created.data;
      check(created.ok && Boolean(eventId), 'the organizer can create an event', created.ok ? '' : errorText(created.data));

      if (eventId) {
        const slots = await api(`/rest/v1/food_slots?event_id=eq.${eventId}&select=id,label,needed&order=position`, { token });
        check(slots.data?.length === 2, 'its food slots were saved', `${slots.data?.length ?? 0} slot(s)`);
        const main = slots.data?.find((s) => s.label === 'Main dish');
        const sides = slots.data?.find((s) => s.label === 'Side dish');

        const host1 = await api('/rest/v1/signups', {
          method: 'POST',
          token,
          body: { event_id: eventId, kind: 'host', name: 'Setup check' },
        });
        check(host1.ok, 'a member can sign up to host', host1.ok ? '' : errorText(host1.data));

        const host2 = await api('/rest/v1/signups', {
          method: 'POST',
          token,
          body: { event_id: eventId, kind: 'host', name: 'Setup check two' },
        });
        check(
          !host2.ok,
          'a second host is refused',
          host2.ok ? 'IT SUCCEEDED — the sign-up trigger is missing.' : errorText(host2.data),
        );

        if (main) {
          // select=id, because returning the whole row would include contact.
          const claim = await api('/rest/v1/signups?select=id', {
            method: 'POST',
            token,
            headers: { prefer: 'return=representation' },
            body: {
              event_id: eventId,
              slot_id: main.id,
              kind: 'food',
              name: 'Setup check',
              item: 'Lasagna',
              contact: 'setup-check@example.com',
            },
          });
          check(claim.ok, 'a member can sign up for a food slot', claim.ok ? '' : errorText(claim.data));
          const claimId = claim.data?.[0]?.id;

          if (claimId) {
            // The sign-up rules run when a sign-up is added. If one could be
            // edited into a host afterwards, the one-host limit would mean nothing.
            const promote = await api(`/rest/v1/signups?id=eq.${claimId}`, {
              method: 'PATCH',
              token,
              body: { kind: 'host' },
            });
            check(
              !promote.ok,
              'a food sign-up cannot be edited into a host sign-up',
              promote.ok ? 'IT SUCCEEDED — re-run supabase/schema.sql to narrow the update grant.' : `refused with ${promote.status}`,
            );

            const seen = await api('/rest/v1/rpc/signup_contacts', { method: 'POST', token, body: {} });
            check(
              seen.ok && seen.data?.some((row) => row.signup_id === claimId && row.contact === 'setup-check@example.com'),
              'the organizer can see contact details',
              seen.ok ? '' : errorText(seen.data),
            );
          }

          // The number on a slot is a minimum, so this second person belongs.
          const extra = await api('/rest/v1/signups', {
            method: 'POST',
            token,
            body: { event_id: eventId, slot_id: main.id, kind: 'food', name: 'Setup check two', item: 'Chili' },
          });
          check(
            extra.ok,
            'a slot still takes people once it has the number it asked for',
            extra.ok ? '' : errorText(extra.data),
          );

          const stored = await api(
            `/rest/v1/signups?slot_id=eq.${main.id}&select=name,item&order=created_at`,
            { token },
          );
          check(
            stored.data?.some((row) => row.item === 'Lasagna') && stored.data?.some((row) => row.item === 'Chili'),
            'each person keeps what they said they are bringing',
            (stored.data ?? []).map((r) => `${r.name}: ${r.item}`).join(', ') || 'nothing stored',
          );

          const wrongEvent = await api('/rest/v1/signups', {
            method: 'POST',
            token,
            body: {
              event_id: eventId,
              slot_id: '00000000-0000-0000-0000-000000000000',
              kind: 'food',
              name: 'Setup check three',
              item: 'Rolls',
            },
          });
          check(
            !wrongEvent.ok,
            'a slot from another event is refused',
            wrongEvent.ok ? 'IT SUCCEEDED — the sign-up trigger is missing.' : errorText(wrongEvent.data),
          );
        }

        if (sides) {
          const results = [];
          for (const dish of ['Green beans', 'Potatoes', 'Corn']) {
            const res = await api('/rest/v1/signups', {
              method: 'POST',
              token,
              body: { event_id: eventId, slot_id: sides.id, kind: 'food', name: 'Setup check', item: dish },
            });
            results.push(res.ok);
          }
          check(
            results.every(Boolean),
            'a slot with no minimum takes everyone',
            `${results.filter(Boolean).length} of 3 accepted`,
          );
        }

        if (feedToken) {
          const feed = await fetchFeed(feedToken);
          check(
            feed.status === 200 && feed.type.startsWith('text/calendar') && feed.text.includes('Setup check'),
            "the organizer's calendar feed includes the new event",
            feed.status === 200 ? '' : `${feed.status}: ${feed.text.slice(0, 120)}`,
          );
          check(
            feed.text.includes('LOCATION:1 Setup Check Way\\, Augusta\\, GA'),
            'the feed puts the location in the address field',
          );
          check(
            feed.text.includes('#event=') && feed.text.includes('DESCRIPTION:'),
            'the feed links each event back to the calendar',
          );
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
