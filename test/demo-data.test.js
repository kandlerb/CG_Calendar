// The demo data source stands in for the database on demo.html, so it has to
// refuse the same things the database refuses. (The real rules are tested in
// supabase/tests/schema_test.sql, against PostgreSQL.)
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createDemoData } from '../public/lib/demo-data.js';

let data;
beforeEach(async () => {
  data = createDemoData();
  await data.init();
});

async function firstEvent() {
  const [event] = await data.loadEvents();
  return event;
}

describe('demo data source', () => {
  it('starts as a visitor, not an organizer', () => {
    assert.equal(data.viewer().isOrganizer, false);
  });

  it('refuses a second host', async () => {
    const event = await firstEvent();
    await data.addSignup({ eventId: event.id, kind: 'host', name: 'Anna' });
    await assert.rejects(
      () => data.addSignup({ eventId: event.id, kind: 'host', name: 'Bob' }),
      /already signed up to host/,
    );
  });

  it('refuses a full food slot but not one with no limit', async () => {
    const event = await firstEvent();
    const main = event.foodSlots.find((s) => s.label === 'Main dish');
    const sides = event.foodSlots.find((s) => s.label === 'Side dish');

    await data.addSignup({ eventId: event.id, slotId: main.id, kind: 'food', name: 'Anna', item: 'Lasagna' });
    await assert.rejects(
      () => data.addSignup({ eventId: event.id, slotId: main.id, kind: 'food', name: 'Bob', item: 'Chili' }),
      /already covered/,
    );

    for (const who of ['Bob', 'Cleo', 'Dev']) {
      await data.addSignup({ eventId: event.id, slotId: sides.id, kind: 'food', name: who, item: 'Something' });
    }
    const after = await firstEvent();
    assert.equal(after.signups.filter((s) => s.slotId === sides.id).length, 4);
  });

  it('keeps a sign-up when its slot is removed', async () => {
    const event = await firstEvent();
    const dessert = event.foodSlots.find((s) => s.label === 'Dessert');
    await data.addSignup({ eventId: event.id, slotId: dessert.id, kind: 'food', name: 'Anna', item: 'Pie' });

    await data.signIn('demo@example.com', 'anything');
    await data.saveEvent({ ...event, id: event.id }, event.foodSlots.filter((s) => s.id !== dessert.id));

    const after = await firstEvent();
    const kept = after.signups.find((s) => s.item === 'Pie');
    assert.equal(kept.slotId, null, 'the sign-up survives without a slot');
    assert.equal(after.foodSlots.some((s) => s.label === 'Dessert'), false);
  });

  it('creates an event and gives its slots positions in order', async () => {
    await data.signIn('demo@example.com', 'anything');
    const id = await data.saveEvent(
      { title: 'Potluck', date: '2026-12-05', startTime: '17:00', endTime: '', needsHost: true, hostLimit: 1, allowOtherFood: true, description: '', location: '' },
      [{ label: 'Main dish', capacity: 1 }, { label: 'Dessert', capacity: 2 }],
    );
    const created = (await data.loadEvents()).find((e) => e.id === id);
    assert.equal(created.title, 'Potluck');
    assert.deepEqual(created.foodSlots.map((s) => s.position), [0, 1]);
  });

  it('removes an event with everything on it', async () => {
    const event = await firstEvent();
    await data.deleteEvent(event.id);
    assert.equal((await data.loadEvents()).some((e) => e.id === event.id), false);
  });

  it('hands out copies, so callers cannot edit the store by accident', async () => {
    const event = await firstEvent();
    event.title = 'Mutated';
    assert.notEqual((await firstEvent()).title, 'Mutated');
  });
});
