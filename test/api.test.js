import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServer } from '../src/server.js';

let base;
let server;
let dataDir;

const ORGANIZERS = [{ name: 'brian', password: 'correct-horse-battery' }];

function client(key) {
  return async function call(pathname, { method = 'GET', body, cookie, headers = {} } = {}) {
    const merged = { ...headers };
    if (key) merged['x-participant-key'] = key;
    if (method !== 'GET') merged['x-cg-app'] = '1';
    if (body !== undefined) merged['content-type'] = 'application/json';
    if (cookie) merged.cookie = cookie;
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: merged,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, setCookie: res.headers.getSetCookie?.() ?? [] };
  };
}

const anon = client('participant-key-anna');
const bob = client('participant-key-bob');

async function signIn() {
  const res = await anon('/api/session', {
    method: 'POST',
    body: { name: 'brian', password: 'correct-horse-battery' },
  });
  assert.equal(res.status, 200);
  const cookie = res.setCookie[0].split(';')[0];
  return cookie;
}

function eventPayload(overrides = {}) {
  return {
    title: 'Community group dinner',
    date: '2026-09-12',
    startTime: '18:00',
    endTime: '20:30',
    location: 'TBD',
    needsHost: true,
    hostLimit: 1,
    foodSlots: [
      { label: 'Main dish', capacity: 1 },
      { label: 'Dessert', capacity: 2 },
    ],
    allowOtherFood: true,
    ...overrides,
  };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-calendar-test-'));
  const created = createServer({
    dataFile: path.join(dataDir, 'calendar.json'),
    organizers: ORGANIZERS,
    appName: 'Test Calendar',
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('organizer access control', () => {
  it('refuses event creation for anonymous visitors', async () => {
    const res = await anon('/api/events', { method: 'POST', body: eventPayload() });
    assert.equal(res.status, 403);
  });

  it('refuses a wrong password', async () => {
    const res = await anon('/api/session', { method: 'POST', body: { name: 'brian', password: 'nope' } });
    assert.equal(res.status, 401);
  });

  it('refuses an unknown organizer name', async () => {
    const res = await anon('/api/session', { method: 'POST', body: { name: 'stranger', password: 'nope' } });
    assert.equal(res.status, 401);
  });

  it('rejects mutations without the application header', async () => {
    const res = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(eventPayload()),
    });
    assert.equal(res.status, 400);
  });

  it('lets a signed-in organizer create, edit and delete an event', async () => {
    const cookie = await signIn();
    const created = await anon('/api/events', { method: 'POST', body: eventPayload(), cookie });
    assert.equal(created.status, 201);
    assert.equal(created.data.event.title, 'Community group dinner');
    assert.equal(created.data.event.foodSlots.length, 2);

    const id = created.data.event.id;
    const edited = await anon(`/api/events/${id}`, {
      method: 'PATCH',
      body: { title: 'Potluck dinner', location: "Brian's house" },
      cookie,
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.event.title, 'Potluck dinner');
    assert.equal(edited.data.event.date, '2026-09-12', 'unchanged fields are kept');

    const anonEdit = await anon(`/api/events/${id}`, { method: 'PATCH', body: { title: 'Hijacked' } });
    assert.equal(anonEdit.status, 403);

    const removed = await anon(`/api/events/${id}`, { method: 'DELETE', cookie });
    assert.equal(removed.status, 200);
    const list = await anon('/api/events');
    assert.equal(list.data.events.find((e) => e.id === id), undefined);
  });

  it('validates event fields', async () => {
    const cookie = await signIn();
    const noTitle = await anon('/api/events', { method: 'POST', body: eventPayload({ title: '  ' }), cookie });
    assert.equal(noTitle.status, 400);

    const badDate = await anon('/api/events', { method: 'POST', body: eventPayload({ date: '2026-02-30' }), cookie });
    assert.equal(badDate.status, 400);

    const backwards = await anon('/api/events', {
      method: 'POST',
      body: eventPayload({ startTime: '19:00', endTime: '18:00' }),
      cookie,
    });
    assert.equal(backwards.status, 400);
  });
});

describe('sign-ups', () => {
  let eventId;
  let slots;

  before(async () => {
    const cookie = await signIn();
    const created = await anon('/api/events', { method: 'POST', body: eventPayload({ date: '2026-10-03' }), cookie });
    eventId = created.data.event.id;
    slots = created.data.event.foodSlots;
  });

  it('lets anyone sign up to host and blocks a second host', async () => {
    const first = await anon(`/api/events/${eventId}/signups`, {
      method: 'POST',
      body: { kind: 'host', name: 'Anna', contact: 'anna@example.com' },
    });
    assert.equal(first.status, 201);
    assert.equal(first.data.event.hostSpotsLeft, 0);
    assert.equal(first.data.event.hosts[0].name, 'Anna');

    const second = await bob(`/api/events/${eventId}/signups`, {
      method: 'POST',
      body: { kind: 'host', name: 'Bob' },
    });
    assert.equal(second.status, 409);
  });

  it('enforces food slot capacity and requires an item', async () => {
    const main = slots.find((s) => s.label === 'Main dish');
    const ok = await anon(`/api/events/${eventId}/signups`, {
      method: 'POST',
      body: { kind: 'food', slotId: main.id, name: 'Anna', item: 'Lasagna' },
    });
    assert.equal(ok.status, 201);

    const full = await bob(`/api/events/${eventId}/signups`, {
      method: 'POST',
      body: { kind: 'food', slotId: main.id, name: 'Bob', item: 'Chili' },
    });
    assert.equal(full.status, 409);

    const noItem = await bob(`/api/events/${eventId}/signups`, {
      method: 'POST',
      body: { kind: 'food', name: 'Bob' },
    });
    assert.equal(noItem.status, 400);

    const other = await bob(`/api/events/${eventId}/signups`, {
      method: 'POST',
      body: { kind: 'food', name: 'Bob', item: 'Sparkling water' },
    });
    assert.equal(other.status, 201);
    assert.equal(other.data.signup.slotId, null);
  });

  it('lets people manage only their own sign-up', async () => {
    const mine = await bob(`/api/events/${eventId}/signups`, {
      method: 'POST',
      body: { kind: 'food', name: 'Bob', item: 'Brownies', slotId: slots.find((s) => s.label === 'Dessert').id },
    });
    const signupId = mine.data.signup.id;

    const seenByAnna = await anon(`/api/events/${eventId}`);
    const asAnna = seenByAnna.data.event.food.find((s) => s.id === signupId);
    assert.equal(asAnna.canManage, false, 'other visitors cannot manage it');

    const stolen = await anon(`/api/signups/${signupId}`, { method: 'PATCH', body: { item: 'Nothing' } });
    assert.equal(stolen.status, 403);

    const updated = await bob(`/api/signups/${signupId}`, { method: 'PATCH', body: { item: 'Two pans of brownies' } });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.event.food.find((s) => s.id === signupId).item, 'Two pans of brownies');

    const removed = await bob(`/api/signups/${signupId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
  });

  it('lets an organizer clear out any sign-up', async () => {
    const cookie = await signIn();
    const theirs = await bob(`/api/events/${eventId}/signups`, {
      method: 'POST',
      body: { kind: 'food', name: 'Bob', item: 'Rolls' },
    });
    const res = await anon(`/api/signups/${theirs.data.signup.id}`, { method: 'DELETE', cookie });
    assert.equal(res.status, 200);
  });

  it('keeps sign-ups when an organizer removes the slot they chose', async () => {
    const cookie = await signIn();
    const dessert = slots.find((s) => s.label === 'Dessert');
    const signup = await bob(`/api/events/${eventId}/signups`, {
      method: 'POST',
      body: { kind: 'food', name: 'Bob', item: 'Pie', slotId: dessert.id },
    });
    await anon(`/api/events/${eventId}`, { method: 'PATCH', body: { foodSlots: [] }, cookie });
    const after_ = await bob(`/api/events/${eventId}`);
    const kept = after_.data.event.food.find((s) => s.id === signup.data.signup.id);
    assert.equal(kept.slotId, null);
    assert.equal(kept.item, 'Pie');
  });

  it('never exposes sign-up tokens', async () => {
    const res = await anon(`/api/events/${eventId}`);
    assert.equal(JSON.stringify(res.data).includes('tokenHash'), false);
  });
});

describe('unlimited food slots', () => {
  it('lets any number of people claim a slot with no limit', async () => {
    const cookie = await signIn();
    const created = await anon('/api/events', {
      method: 'POST',
      body: eventPayload({
        title: 'Big potluck',
        date: '2026-11-07',
        foodSlots: [{ label: 'Side dish', capacity: 0 }],
      }),
      cookie,
    });
    const eventId = created.data.event.id;
    const slotId = created.data.event.foodSlots[0].id;
    assert.equal(created.data.event.foodSlots[0].capacity, 0);

    for (const [who, dish] of [
      ['Anna', 'Green beans'],
      ['Bob', 'Roasted potatoes'],
      ['Cleo', 'Corn casserole'],
      ['Dev', 'Rice pilaf'],
    ]) {
      const res = await client(`key-${who}`)(`/api/events/${eventId}/signups`, {
        method: 'POST',
        body: { kind: 'food', slotId, name: who, item: dish },
      });
      assert.equal(res.status, 201, `${who} could sign up`);
    }
    const event = (await anon(`/api/events/${eventId}`)).data.event;
    assert.equal(event.food.length, 4);
    assert.equal(event.foodSlots[0].taken, 4);
  });

  it('accepts as many food slots as an organizer adds', async () => {
    const cookie = await signIn();
    const foodSlots = Array.from({ length: 60 }, (_, i) => ({ label: `Dish ${i + 1}`, capacity: 1 }));
    const created = await anon('/api/events', {
      method: 'POST',
      body: eventPayload({ title: 'Very big potluck', date: '2026-11-14', foodSlots }),
      cookie,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.event.foodSlots.length, 60);
  });

  it('still rejects a negative capacity', async () => {
    const cookie = await signIn();
    const res = await anon('/api/events', {
      method: 'POST',
      body: eventPayload({ date: '2026-11-21', foodSlots: [{ label: 'Salad', capacity: -1 }] }),
      cookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('calendar reading', () => {
  it('filters by date range and sorts by date', async () => {
    const cookie = await signIn();
    await anon('/api/events', { method: 'POST', body: eventPayload({ title: 'Later', date: '2027-01-20' }), cookie });
    await anon('/api/events', { method: 'POST', body: eventPayload({ title: 'Earlier', date: '2027-01-05' }), cookie });
    const res = await anon('/api/events?from=2027-01-01&to=2027-01-31');
    assert.deepEqual(
      res.data.events.map((e) => e.title),
      ['Earlier', 'Later'],
    );
  });

  it('serves the calendar page', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Community Group Calendar/);
  });

  it('does not serve files outside the public folder', async () => {
    const res = await fetch(`${base}/../package.json`);
    assert.equal(res.ok, false);
  });
});
