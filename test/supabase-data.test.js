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

function fakeClient({ session = null, organizer = false, writes = [] } = {}) {
  const log = [];
  let current = session;
  let anonymousCount = 0;

  const builder = (table) => {
    let op = 'select';
    const finish = () => {
      log.push(`${table}:${op}`);
      if (table === 'organizers' && op === 'select') {
        const named = organizer && current && !current.user.is_anonymous;
        return { data: named ? { name: 'Tim' } : null, error: null };
      }
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
    },
    from: (table) => builder(table),
    rpc: async (name) => {
      log.push(`rpc:${name}`);
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
