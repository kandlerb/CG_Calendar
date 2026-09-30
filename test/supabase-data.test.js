import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSupabaseData, readAuthRedirect } from '../public/lib/supabase-data.js';

// A stand-in for the Supabase client: just enough of its chained query
// builder and auth API to run the data layer, with the session and the
// database's answers under the test's control.

const session = (id, extra = {}) => ({
  access_token: `token-${id}`,
  user: { id, is_anonymous: false, email: `${id}@example.com`, user_metadata: {}, ...extra },
});

const MEMBER = { display_name: 'Anna', feed_token: 'feed-1', is_organizer: false, removed: false };

const PERMISSION_DENIED = {
  data: null,
  error: { code: '42501', message: 'permission denied for table signups' },
};
const OK = { data: null, error: null };

function fakeClient({
  current = null,
  membership = MEMBER,
  membershipResult = null,
  writes = [],
  rpcs = {},
  auth = {},
  refreshTo,
  events = [],
  contacts = null,
} = {}) {
  const log = [];
  const selects = [];
  const filters = [];
  let active = current;

  const builder = (table) => {
    let op = 'select';
    const finish = () => {
      log.push(`${table}:${op}`);
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
      active = null;
    },
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: active }, error: null }),
      refreshSession: async () => {
        log.push('refresh');
        if (refreshTo !== undefined) active = refreshTo;
        return { data: { session: active }, error: null };
      },
      signOut: async () => {
        log.push('sign out');
        active = null;
        return { error: null };
      },
      signInWithPassword: async ({ email }) => {
        log.push(`sign in ${email}`);
        if (auth.signIn) return auth.signIn();
        active = session('anna');
        return { data: { session: active }, error: null };
      },
      signUp: async ({ email, options }) => {
        log.push(`sign up ${email} as ${options?.data?.display_name}`);
        if (auth.signUp) return auth.signUp();
        active = session('new');
        return { data: { session: active, user: active.user }, error: null };
      },
    },
    from: (table) => builder(table),
    rpc: async (name, args) => {
      log.push(`rpc:${name}`);
      if (name === 'my_membership') return membershipResult ?? { data: active ? membership : null, error: null };
      if (name === 'signup_contacts') return contacts ?? { data: [], error: null };
      if (rpcs[name]) return rpcs[name](args);
      return writes.length ? writes.shift() : OK;
    },
  };
}

const signup = { eventId: 'e1', kind: 'food', slotId: 's1', name: 'Anna', item: 'Lasagna' };

describe('who is looking', () => {
  it('has no viewer before anyone signs in', async () => {
    const data = createSupabaseData(fakeClient());
    assert.equal(await data.init(), null);
  });

  it('lets go of an old anonymous session instead of using it', async () => {
    const client = fakeClient({ current: session('anon', { is_anonymous: true, email: null }) });
    const data = createSupabaseData(client);
    assert.equal(await data.init(), null);
    assert.ok(client.log.includes('sign out'));
  });

  it('knows a member, their name and their feed', async () => {
    const data = createSupabaseData(fakeClient({ current: session('anna') }), {
      feedBase: 'https://x.supabase.co/functions/v1/calendar-feed',
    });
    const viewer = await data.init();
    assert.equal(viewer.isMember, true);
    assert.equal(viewer.name, 'Anna');
    assert.deepEqual(data.feedLinks(), {
      https: 'https://x.supabase.co/functions/v1/calendar-feed?token=feed-1',
      webcal: 'webcal://x.supabase.co/functions/v1/calendar-feed?token=feed-1',
    });
  });

  it('tells a signed-in account that has not joined apart from a member', async () => {
    const data = createSupabaseData(fakeClient({ current: session('stranger'), membership: null }));
    const viewer = await data.init();
    assert.equal(viewer.isMember, false);
    assert.equal(viewer.removed, false);
    assert.equal(data.feedLinks(), null);
  });

  it('knows a removed member is not a member', async () => {
    const data = createSupabaseData(
      fakeClient({ current: session('anna'), membership: { ...MEMBER, removed: true } }),
    );
    const viewer = await data.init();
    assert.equal(viewer.isMember, false);
    assert.equal(viewer.removed, true);
  });

  it('does not mistake a failed membership lookup for "not a member"', async () => {
    const client = fakeClient({
      current: session('anna'),
      membershipResult: { data: null, error: { message: 'Failed to fetch' } },
    });
    const data = createSupabaseData(client);
    await assert.rejects(data.init(), /Could not check who you are signed in as/);
    assert.ok(!client.log.includes('sign out'));
  });

  const cases = [
    [{ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }, /did not match/],
    [{ code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' }, /Confirm your email/],
    [{ code: 'over_request_rate_limit', status: 429, message: 'Request rate limit reached' }, /Too many/],
    [{ status: 0, message: 'Failed to fetch' }, /Could not reach/],
  ];
  for (const [error, expected] of cases) {
    it(`explains a "${error.message}" sign-in failure`, async () => {
      const data = createSupabaseData(fakeClient({ auth: { signIn: () => ({ data: {}, error }) } }));
      await assert.rejects(data.signIn('a@example.com', 'pw'), expected);
    });
  }

  it('turns a failed sign-in into a plain sentence', async () => {
    const data = createSupabaseData(
      fakeClient({
        auth: { signIn: () => ({ data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } }) },
      }),
    );
    await assert.rejects(data.signIn('a@example.com', 'x'), { message: 'That email and password did not match.' });
  });
});

describe('creating an account', () => {
  it('joins the group straight away when Supabase signs the person in', async () => {
    let asked;
    const client = fakeClient({
      rpcs: {
        join_group: (args) => {
          asked = args;
          return { data: 'joined', error: null };
        },
      },
    });
    const data = createSupabaseData(client);
    const result = await data.signUp({ email: 'new@example.com', password: 'pw', displayName: 'New', inviteCode: 'maple' });
    assert.equal(result.joinError, null);
    assert.equal(result.viewer.isMember, true);
    assert.deepEqual(asked, { p_code: 'maple', p_display_name: 'New' });
    assert.ok(client.log.includes('sign up new@example.com as New'));
  });

  it('keeps the new account and says so when the code is wrong', async () => {
    const data = createSupabaseData(
      fakeClient({ membership: null, rpcs: { join_group: () => ({ data: 'wrong_code', error: null }) } }),
    );
    const result = await data.signUp({ email: 'new@example.com', password: 'pw', displayName: 'New', inviteCode: 'nope' });
    assert.match(result.joinError, /invite code isn't right/);
    assert.equal(result.viewer.isMember, false);
  });

  it('asks the person to confirm their email when Supabase does not sign them in', async () => {
    const data = createSupabaseData(
      fakeClient({ auth: { signUp: () => ({ data: { session: null, user: { id: 'new' } }, error: null }) } }),
    );
    const result = await data.signUp({ email: 'new@example.com', password: 'pw', displayName: 'New', inviteCode: 'x' });
    assert.equal(result.confirmEmail, true);
  });

  it('points someone with an account already at signing in', async () => {
    const data = createSupabaseData(
      fakeClient({ auth: { signUp: () => ({ data: {}, error: { code: 'user_already_exists', message: 'User already registered' } }) } }),
    );
    await assert.rejects(
      data.signUp({ email: 'a@example.com', password: 'pw', displayName: 'A', inviteCode: 'x' }),
      /already an account/,
    );
  });
});

describe('links from Supabase emails', () => {
  it('recognises a password reset link', () => {
    assert.deepEqual(readAuthRedirect('#access_token=abc&type=recovery'), { recovery: true, error: null });
  });

  it('explains an expired link', () => {
    const result = readAuthRedirect('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    assert.match(result.error, /expired/);
  });

  it('ignores a link to an event', () => {
    assert.deepEqual(readAuthRedirect('#event=abc'), { recovery: false, error: null });
  });
});

describe('writing with a session', () => {
  it('sends a sign-up straight through when the browser still has its session', async () => {
    const client = fakeClient({ current: session('anna') });
    const data = createSupabaseData(client);
    await data.init();
    await data.addSignup(signup);
    assert.deepEqual(client.log, ['rpc:my_membership', 'signups:insert']);
  });

  it('sends nothing and asks the person to sign in when the session is gone', async () => {
    const client = fakeClient({ current: session('anna') });
    const data = createSupabaseData(client);
    await data.init();
    client.dropSession();
    await assert.rejects(data.addSignup(signup), (err) => err.signedOut === true);
    assert.ok(!client.log.includes('signups:insert'));
    assert.equal(data.viewer(), null);
  });

  it('refreshes the session and tries once more when the database saw no session', async () => {
    const client = fakeClient({ current: session('anna'), writes: [PERMISSION_DENIED, OK] });
    const data = createSupabaseData(client);
    await data.init();
    await data.addSignup(signup);
    assert.deepEqual(client.log, ['rpc:my_membership', 'signups:insert', 'refresh', 'signups:insert']);
  });

  it('gives up after the second refusal and asks the person to sign in', async () => {
    const client = fakeClient({ current: session('anna'), writes: [PERMISSION_DENIED, PERMISSION_DENIED] });
    const data = createSupabaseData(client);
    await data.init();
    await assert.rejects(data.addSignup(signup), (err) => err.signedOut === true);
    assert.equal(client.log.filter((entry) => entry === 'signups:insert').length, 2);
  });

  it('does not retry when the session cannot be refreshed', async () => {
    const client = fakeClient({ current: session('anna'), writes: [PERMISSION_DENIED], refreshTo: null });
    const data = createSupabaseData(client);
    await data.init();
    await assert.rejects(data.deleteSignup('s1'), (err) => err.signedOut === true);
    assert.equal(client.log.filter((entry) => entry === 'signups:delete').length, 1);
  });

  it('still reports a rule that refused the row as such', async () => {
    const client = fakeClient({
      current: session('anna'),
      writes: [{ data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "events"' } }],
    });
    const data = createSupabaseData(client);
    await data.init();
    await assert.rejects(data.deleteEvent('e1'), { message: 'You are not allowed to do that.' });
    assert.ok(!client.log.includes('refresh'), 'a refused row is not a lost session');
  });

  it('sends the host address with a sign-up', async () => {
    let sent;
    const client = fakeClient({ current: session('anna') });
    const original = client.from;
    client.from = (table) => {
      const b = original(table);
      const insert = b.insert;
      b.insert = (row) => {
        sent = row;
        return insert(row);
      };
      return b;
    };
    const data = createSupabaseData(client);
    await data.init();
    await data.addSignup({ eventId: 'e1', kind: 'host', name: 'Anna', address: '12 Oak St' });
    assert.equal(sent.address, '12 Oak St');
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
      { id: 'mine', event_id: 'e1', kind: 'food', name: 'Anna', item: 'Pie', created_by: 'anna' },
      { id: 'theirs', event_id: 'e1', kind: 'food', name: 'Bob', item: 'Chili', created_by: 'someone' },
    ],
  };

  it('never asks the database for the contact column, which it refuses', async () => {
    const client = fakeClient({ current: session('anna'), events: [eventRow] });
    const data = createSupabaseData(client);
    await data.init();
    await data.loadEvents();
    const query = client.selects.find((s) => s.startsWith('events:'));
    assert.ok(query, 'events were selected');
    assert.doesNotMatch(query, /contact/);
    assert.doesNotMatch(query, /signups\(\*\)/);
    assert.match(query, /address/);
  });

  it('fills in only the contact details signup_contacts() hands back', async () => {
    const client = fakeClient({
      current: session('anna'),
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
      current: session('anna'),
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
    const client = fakeClient({ current: session('anna') });
    const data = createSupabaseData(client);
    await data.init();
    await data.loadEvents({ since: '2026-08-01' });
    assert.ok(client.filters.includes('events:event_date>=2026-08-01'));
    assert.ok(client.filters.includes('events:order signups.created_at'));
  });

  it('turns database rows into the shape the page uses, host address included', async () => {
    const client = fakeClient({
      current: session('anna'),
      events: [
        {
          id: 'e1',
          title: 'Dinner',
          description: null,
          location: null,
          event_date: '2026-10-01',
          start_time: '18:30:00',
          end_time: null,
          needs_host: true,
          host_limit: 1,
          allow_other_food: true,
          cancelled: true,
          food_slots: [{ id: 's1', label: 'Main', needed: 2, position: null }],
          signups: [{ id: 'x', event_id: 'e1', kind: 'host', name: 'Ann', address: '12 Oak St', created_by: 'u' }],
        },
      ],
    });
    const data = createSupabaseData(client);
    await data.init();
    const [event] = await data.loadEvents();
    assert.equal(event.startTime, '18:30');
    assert.equal(event.endTime, '');
    assert.equal(event.location, '');
    assert.equal(event.cancelled, true);
    assert.deepEqual(event.foodSlots, [{ id: 's1', label: 'Main', needed: 2, position: 0 }]);
    assert.equal(event.signups[0].address, '12 Oak St');
  });
});
