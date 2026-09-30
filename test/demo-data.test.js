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

  it('lets a member set their own display name', async () => {
    const viewer = await data.setName('Anna Smith');
    assert.equal(viewer.name, 'Anna Smith');
  });

  it('starts as a signed-in member, not an organizer', () => {
    assert.equal(data.viewer().isMember, true);
    assert.equal(data.viewer().isOrganizer, false);
  });

  it('shows nothing once signed out', async () => {
    await data.signOut();
    assert.equal(data.viewer(), null);
    await assert.rejects(() => data.loadEvents(), /join the group/);
  });

  it('joins a new account with the right invite code, ignoring case', async () => {
    await data.signOut();
    const result = await data.signUp({ email: 'new@example.com', password: 'pw', displayName: 'New', inviteCode: ' DEMO ' });
    assert.equal(result.joinError, null);
    assert.equal(result.viewer.isMember, true);
    assert.equal(result.viewer.name, 'New');
  });

  it('keeps a new account out until the invite code is right', async () => {
    await data.signOut();
    const result = await data.signUp({ email: 'new@example.com', password: 'pw', displayName: 'New', inviteCode: 'nope' });
    assert.match(result.joinError, /invite code/);
    assert.equal(data.viewer().isMember, false);
    await assert.rejects(() => data.loadEvents(), /join the group/);
    await data.joinGroup('demo', 'New');
    assert.equal(data.viewer().isMember, true);
  });

  it('keeps event editing for organizers', async () => {
    await assert.rejects(() => data.saveEvent({ title: 'Mine', date: '2026-10-01' }, []), /organizers/);
    await assert.rejects(() => data.getInviteCode(), /organizers/);
  });

  it('lets an organizer change the code and remove a member, but not another organizer', async () => {
    await data.signIn('org@example.com', 'pw');
    await data.setInviteCode('new-code-2026');
    assert.equal(await data.getInviteCode(), 'new-code-2026');
    const members = await data.listMembers();
    const marisol = members.find((m) => m.name === 'Marisol');
    await data.setMemberRemoved(marisol.id, true);
    assert.equal((await data.listMembers()).find((m) => m.id === marisol.id).removed, true);
    const organizer = members.find((m) => m.isOrganizer);
    await assert.rejects(() => data.setMemberRemoved(organizer.id, true), /Organizers cannot/);
  });

  it('keeps a host address apart from the note', async () => {
    const event = await firstEvent();
    await data.addSignup({ eventId: event.id, kind: 'host', name: 'Anna', note: 'Side door', address: '12 Oak St' });
    const host = (await firstEvent()).signups.find((s) => s.kind === 'host');
    assert.equal(host.address, '12 Oak St');
    assert.equal(host.note, 'Side door');
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
    await data.signIn('demo@example.com', 'anything');
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
