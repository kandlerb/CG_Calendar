import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSupabaseData } from '../public/lib/supabase-data.js';

// A stand-in for the Supabase client: just enough of its chained query
// builder to run the data layer, with the session and the answers to writes
// under the test's control.

const anonymousSession = (id) => ({ access_token: `token-${id}`, user: { id, is_anonymous: true } });
const organizerSession = (id) => ({
  access_token: `token-${id}`,
  user: { id, is_anonymous: false, email: 'tim@example.com' },
});

const PERMISSION_DENIED = {
  data: null,
  error: { code: '42501', message: 'permission denied for table signups' },
};
const OK = { data: null, error: null };

function fakeClient({
  session = null,
  organizer = false,
  writes = [],
  events = [],
  contacts = null,
  organizerLookup = null,
  passwordResult = null,
} = {}) {
  const log = [];
  const selects = [];
  const filters = [];
  let current = session;
  let anonymousCount = 0;

  const builder = (table) => {
    let op = 'select';
    const finish = () => {
      log.push(`${table}:${op}`);
      if (table === 'organizers' && op === 'select') {
        if (organizerLookup) return organizerLookup;
        const named = organizer && current && !current.user.is_anonymous;
        return { data: named ? { name: 'Tim' } : null, error: null };
      }
      if (table === 'events' && op === 'select') return { data: structuredClone(events), error: null };
      return writes.length ? writes.shift() : OK;
    };
    const b = {
      select: (columns) => (selects.push(`${table}:${columns}`), b),
      eq: () => b,
      gte: (column, value) => (filters.push(`${table}:${column}>=${value}`), b),
      order: (column, options = {}) => (filters.push(`${table}:order ${options.referencedTable ?? table}.${column}`), b),
      insert: () => ((op = 'insert'), b),
      update: () => ((op = 'update'), b),
      delete: () => ((op = 'delete'), b),
      maybeSingle: async () => finish(),
      then: (resolve, reject) => Promise.resolve().then(finish).then(resolve, reject),
    };
    return b;
  };

  return {
    log,
    selects,
    filters,
    dropSession: () => {
      current = null;
    },
    auth: {
      getSession: async () => ({ data: { session: current }, error: null }),
      signInAnonymously: async () => {
        anonymousCount += 1;
        log.push('anonymous sign-in');
        current = anonymousSession(`anon-${anonymousCount}`);
        return { data: { session: current, user: current.user }, error: null };
      },
      signInWithPassword: async () => {
        log.push('password sign-in');
        if (passwordResult) return passwordResult;
        current = organizerSession('org-1');
        return { data: { session: current, user: current.user }, error: null };
      },
      signOut: async () => {
        log.push('sign-out');
        current = null;
        return { error: null };
      },
    },
    from: (table) => builder(table),
    rpc: async (name) => {
      log.push(`rpc:${name}`);
      if (name === 'signup_contacts') return contacts ?? { data: [], error: null };
      return writes.length ? writes.shift() : OK;
    },
  };
}

const signup = { eventId: 'e1', kind: 'food', slotId: 's1', name: 'Anna', item: 'Lasagna' };

describe('writing with a session', () => {
  it('sends a sign-up straight through when the browser still has its session', async () => {
    const client = fakeClient({ session: anonymousSession('anon-0') });
    const data = createSupabaseData(client);
    await data.init();
    await data.addSignup(signup);
    assert.deepEqual(client.log, ['organizers:select', 'signups:insert']);
  });

  it('gets a new anonymous session first when the old one is gone', async () => {
    const client = fakeClient();
    const data = createSupabaseData(client);
    await data.init();
    assert.equal(data.viewer().id, 'anon-1');

    client.dropSession();
    await data.addSignup(signup);

    assert.deepEqual(client.log, [
      'anonymous sign-in',
      'organizers:select',
      'anonymous sign-in',
      'organizers:select',
      'signups:insert',
    ]);
    assert.equal(data.viewer().id, 'anon-2', 'the viewer follows the new session');
  });

  it('tries once more with a fresh session when the database saw no session', async () => {
    // The client claims to have a session, yet the request went out without
    // one: the database refuses it as "anon". That is the bug report.
    const client = fakeClient({ session: anonymousSession('anon-0'), writes: [PERMISSION_DENIED, OK] });
    const data = createSupabaseData(client);
    await data.init();
    await data.addSignup(signup);
    assert.deepEqual(client.log, [
      'organizers:select',
      'signups:insert',
      'anonymous sign-in',
      'organizers:select',
      'signups:insert',
    ]);
  });

  it('gives up after the second refusal with a message that says what to do', async () => {
    const client = fakeClient({
      session: anonymousSession('anon-0'),
      writes: [PERMISSION_DENIED, PERMISSION_DENIED],
    });
    const data = createSupabaseData(client);
    await data.init();
    await assert.rejects(data.addSignup(signup), {
      message: 'Your session ended. Reload the page and try again.',
    });
    assert.equal(client.log.filter((entry) => entry === 'signups:insert').length, 2);
  });

  it('does the same for changing and removing a sign-up', async () => {
    const client = fakeClient();
    const data = createSupabaseData(client);
    await data.init();

    client.dropSession();
    await data.updateSignup('s1', { item: 'Chili' });
    client.dropSession();
    await data.deleteSignup('s1');

    assert.equal(client.log.filter((entry) => entry === 'anonymous sign-in').length, 3);
    assert.ok(client.log.includes('signups:update'));
    assert.ok(client.log.includes('signups:delete'));
  });

  it('asks an organizer to sign in again rather than turning them anonymous', async () => {
    const client = fakeClient({ session: organizerSession('tim'), organizer: true });
    const data = createSupabaseData(client);
    const viewer = await data.init();
    assert.equal(viewer.isOrganizer, true);

    client.dropSession();
    await assert.rejects(data.addSignup(signup), /sign in again/i);
    await assert.rejects(data.saveEvent({ title: 'Dinner', date: '2026-10-01' }, []), /sign in again/i);
    assert.ok(!client.log.includes('anonymous sign-in'), 'no anonymous sign-in was attempted');
    assert.ok(!client.log.includes('signups:insert'), 'nothing was sent without a session');
  });

  it('still reports a rule that refused the row as such', async () => {
    const client = fakeClient({
      session: anonymousSession('anon-0'),
      writes: [{ data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "events"' } }],
    });
    const data = createSupabaseData(client);
    await data.init();
    await assert.rejects(data.deleteEvent('e1'), { message: 'You are not allowed to do that.' });
    assert.ok(!client.log.includes('anonymous sign-in'), 'a refused row is not a lost session');
  });
});

describe('contact details', () => {
  const eventRow = {
    id: 'e1',
    title: 'Dinner',
    event_date: '2026-10-01',
    needs_host: true,
    host_limit: 1,
    allow_other_food: true,
    food_slots: [],
    signups: [
      { id: 'mine', event_id: 'e1', kind: 'food', name: 'Anna', item: 'Pie', created_by: 'anon-1' },
      { id: 'theirs', event_id: 'e1', kind: 'food', name: 'Bob', item: 'Chili', created_by: 'someone' },
    ],
  };

  it('never asks the database for the contact column, which it refuses', async () => {
    const client = fakeClient({ events: [eventRow] });
    const data = createSupabaseData(client);
    await data.init();
    await data.loadEvents();
    const query = client.selects.find((s) => s.startsWith('events:'));
    assert.ok(query, 'events were selected');
    assert.doesNotMatch(query, /contact/);
    assert.doesNotMatch(query, /signups\(\*\)/);
  });

  it('fills in only the contact details signup_contacts() hands back', async () => {
    const client = fakeClient({
      events: [eventRow],
      contacts: { data: [{ signup_id: 'mine', contact: '555-0100' }], error: null },
    });
    const data = createSupabaseData(client);
    await data.init();
    const [event] = await data.loadEvents();
    assert.equal(event.signups.find((s) => s.id === 'mine').contact, '555-0100');
    assert.equal(event.signups.find((s) => s.id === 'theirs').contact, '');
  });

  it('still loads the calendar when the contact lookup fails', async () => {
    const client = fakeClient({
      events: [eventRow],
      contacts: { data: null, error: { message: 'Could not find the function public.signup_contacts' } },
    });
    const data = createSupabaseData(client);
    await data.init();
    const [event] = await data.loadEvents();
    assert.equal(event.signups.length, 2);
    assert.ok(event.signups.every((s) => s.contact === ''));
  });
});

describe('loading events', () => {
  it('asks only for events from the given date on, with sign-ups in the order they were made', async () => {
    const client = fakeClient();
    const data = createSupabaseData(client);
    await data.init();
    await data.loadEvents({ since: '2026-08-01' });
    assert.ok(client.filters.includes('events:event_date>=2026-08-01'));
    assert.ok(client.filters.includes('events:order signups.created_at'));
  });

  it('asks for every event when no date is given', async () => {
    const client = fakeClient();
    const data = createSupabaseData(client);
    await data.init();
    await data.loadEvents();
    assert.ok(!client.filters.some((f) => f.includes('>=')));
  });

  it('turns database rows into the shape the page uses', async () => {
    const client = fakeClient({
      events: [
        {
          id: 'e1',
          title: 'Dinner',
          description: null,
          location: null,
          event_date: '2026-10-01',
          start_time: '18:30:00',
          end_time: null,
          needs_host: false,
          host_limit: 1,
          allow_other_food: true,
          food_slots: [{ id: 's1', label: 'Main', needed: 2, position: null }],
          signups: [{ id: 'x', event_id: 'e1', slot_id: 's1', kind: 'food', name: 'Ann', item: 'Pie', created_by: 'u' }],
        },
      ],
    });
    const data = createSupabaseData(client);
    await data.init();
    const [event] = await data.loadEvents();
    assert.equal(event.date, '2026-10-01');
    assert.equal(event.startTime, '18:30');
    assert.equal(event.endTime, '');
    assert.equal(event.description, '');
    assert.equal(event.location, '');
    assert.equal(event.needsHost, false);
    assert.deepEqual(event.foodSlots, [{ id: 's1', label: 'Main', needed: 2, position: 0 }]);
    assert.equal(event.signups[0].slotId, 's1');
    assert.equal(event.signups[0].createdBy, 'u');
    assert.equal(event.signups[0].note, '');
  });
});

describe('organizer sign-in', () => {
  it('does not mistake a failed organizer lookup for "not an organizer"', async () => {
    const client = fakeClient({
      session: organizerSession('org-1'),
      organizer: true,
      organizerLookup: { data: null, error: { message: 'Failed to fetch' } },
    });
    const data = createSupabaseData(client);
    await assert.rejects(data.init(), /Could not check who you are signed in as/);
    assert.ok(!client.log.includes('sign-out'));
  });

  it('signs a non-organizer back out and says why', async () => {
    const client = fakeClient({ organizer: false });
    const data = createSupabaseData(client);
    await data.init();
    await assert.rejects(data.signIn('a@example.com', 'pw'), /not an organizer/);
    assert.ok(client.log.includes('sign-out'));
    assert.equal(data.viewer().isOrganizer, false);
  });

  it('signs an organizer in', async () => {
    const client = fakeClient({ organizer: true });
    const data = createSupabaseData(client);
    await data.init();
    const viewer = await data.signIn('tim@example.com', 'pw');
    assert.equal(viewer.isOrganizer, true);
    assert.equal(viewer.name, 'Tim');
  });

  const cases = [
    [{ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }, /did not match/],
    [{ code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' }, /not been confirmed/],
    [{ code: 'over_request_rate_limit', status: 429, message: 'Request rate limit reached' }, /Too many/],
    [{ status: 0, message: 'Failed to fetch' }, /Could not reach/],
  ];
  for (const [error, expected] of cases) {
    it(`explains a "${error.message}" failure`, async () => {
      const client = fakeClient({ passwordResult: { data: {}, error } });
      const data = createSupabaseData(client);
      await data.init();
      await assert.rejects(data.signIn('a@example.com', 'pw'), expected);
    });
  }
});
