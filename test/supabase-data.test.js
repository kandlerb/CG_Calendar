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

function fakeClient({ current = null, membership = MEMBER, writes = [], rpcs = {}, auth = {}, refreshTo } = {}) {
  const log = [];
  let active = current;

  const builder = (table) => {
    let op = 'select';
    const finish = () => {
      log.push(`${table}:${op}`);
      return writes.length ? writes.shift() : OK;
    };
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
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
      if (name === 'my_membership') return { data: active ? membership : null, error: null };
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
