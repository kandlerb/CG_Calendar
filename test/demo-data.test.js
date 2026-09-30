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
  it('lets an organizer set their own display name', async () => {
    await data.signIn('someone@example.com', 'anything');
    const viewer = await data.setName('Kandler Baker');
    assert.equal(viewer.name, 'Kandler Baker');
    assert.equal(data.viewer().name, 'Kandler Baker');
  });

  it('has no display name to set until you are an organizer', async () => {
    await assert.rejects(() => data.setName('Nobody'), /organizers/i);
  });

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

  it('takes more sign-ups than a slot asked for, because the number is a minimum', async () => {
    const event = await firstEvent();
    const main = event.foodSlots.find((s) => s.label === 'Main dish');
    assert.equal(main.needed, 2, 'the seeded main dish asks for two');

    for (const who of ['Anna', 'Bob', 'Cleo']) {
      await data.addSignup({ eventId: event.id, slotId: main.id, kind: 'food', name: who, item: `${who}'s dish` });
    }
    const after = await firstEvent();
    assert.equal(after.signups.filter((s) => s.slotId === main.id).length, 3);
  });

  it('keeps what each person said they are bringing', async () => {
    const event = await firstEvent();
    const main = event.foodSlots.find((s) => s.label === 'Main dish');
    await data.addSignup({ eventId: event.id, slotId: main.id, kind: 'food', name: 'Anna', item: 'Lasagna' });
    await data.addSignup({ eventId: event.id, slotId: main.id, kind: 'food', name: 'Bob', item: 'Chili' });

    const after = await firstEvent();
    assert.deepEqual(
      after.signups.filter((s) => s.slotId === main.id).map((s) => `${s.name}: ${s.item}`),
      ['Anna: Lasagna', 'Bob: Chili'],
    );
  });

  it('still refuses a slot that is not on the event', async () => {
    const event = await firstEvent();
    await assert.rejects(
      () => data.addSignup({ eventId: event.id, slotId: 'not-a-slot', kind: 'food', name: 'Anna', item: 'X' }),
      /no longer on this event/,
    );
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
      [{ label: 'Main dish', needed: 1 }, { label: 'Dessert', needed: 2 }],
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

  it('shows a contact only to the person who signed up and to organizers', async () => {
    const event = await firstEvent();
    await data.addSignup({ eventId: event.id, kind: 'food', name: 'Me', item: 'Pie', contact: '555-0100' });
    const mine = (await firstEvent()).signups.find((s) => s.name === 'Me');
    assert.equal(mine.contact, '555-0100');

    // Marisol's sign-up was made in another browser, and she left an email.
    const others = (await firstEvent()).signups.find((s) => s.name === 'Marisol');
    assert.equal(others.contact, '');

    await data.signIn('org@example.com', 'x');
    const all = await firstEvent();
    assert.equal(all.signups.find((s) => s.name === 'Marisol').contact, 'marisol@example.com');
  });

  it('refuses a host on an event whose host is already arranged, as the database does', async () => {
    const cookout = (await data.loadEvents()).find((e) => !e.needsHost);
    await assert.rejects(
      data.addSignup({ eventId: cookout.id, kind: 'host', name: 'Me' }),
      /does not need a host/,
    );
  });

  it('refuses food outside the slots when the organizer has turned that off', async () => {
    await data.signIn('org@example.com', 'x');
    const id = await data.saveEvent(
      { title: 'Slots only', date: '2030-01-01', needsHost: false, hostLimit: 1, allowOtherFood: false },
      [{ label: 'Main', needed: 1 }],
    );
    await assert.rejects(
      data.addSignup({ eventId: id, kind: 'food', name: 'Me', item: 'Chips' }),
      /listed food slots/,
    );
  });

  it('loads only events from the given date on', async () => {
    const all = await data.loadEvents();
    const later = all[1].date;
    const some = await data.loadEvents({ since: later });
    assert.deepEqual(some.map((e) => e.date), [later]);
  });

  it('lets you edit what your sign-up says, but not what it is for', async () => {
    const event = await firstEvent();
    const main = event.foodSlots.find((s) => s.label === 'Main dish');
    await data.addSignup({ eventId: event.id, slotId: main.id, kind: 'food', name: 'Anna', item: 'Lasagna' });
    const mine = (await firstEvent()).signups.find((s) => s.name === 'Anna');
    await data.updateSignup(mine.id, { item: 'Chili', kind: 'host', slotId: null });
    const after = (await firstEvent()).signups.find((s) => s.id === mine.id);
    assert.deepEqual([after.item, after.kind, after.slotId], ['Chili', 'food', main.id]);
  });

  it('refuses to let a visitor edit someone else\'s sign-up', async () => {
    const marisol = (await firstEvent()).signups.find((s) => s.name === 'Marisol');
    await assert.rejects(() => data.updateSignup(marisol.id, { item: 'Nothing' }), /not allowed/);
  });
});
