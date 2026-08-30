import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eventBadges, groupByDate, shapeEvent, shapeEvents, upcoming } from '../public/lib/model.js';

const ANNA = 'user-anna';
const BOB = 'user-bob';

function event(overrides = {}) {
  return {
    id: 'e1',
    title: 'Community Group',
    date: '2026-09-02',
    startTime: '18:30',
    endTime: '20:30',
    needsHost: true,
    hostLimit: 1,
    allowOtherFood: true,
    foodSlots: [
      { id: 'main', label: 'Main dish', capacity: 1, position: 0 },
      { id: 'sides', label: 'Side dish', capacity: 0, position: 1 },
    ],
    signups: [],
    ...overrides,
  };
}

const signup = (o) => ({ id: 's1', kind: 'food', name: 'Anna', item: 'Lasagna', createdBy: ANNA, ...o });

describe('shaping an event', () => {
  it('splits hosts from food and counts the host spots left', () => {
    const shaped = shapeEvent(
      event({
        hostLimit: 2,
        signups: [
          signup({ id: 'h1', kind: 'host', name: 'Anna', item: '' }),
          signup({ id: 'f1', slotId: 'main' }),
        ],
      }),
    );
    assert.equal(shaped.hosts.length, 1);
    assert.equal(shaped.food.length, 1);
    assert.equal(shaped.hostSpotsLeft, 1);
  });

  it('reports no host spots when the event does not want a host', () => {
    assert.equal(shapeEvent(event({ needsHost: false, hostLimit: 1 })).hostSpotsLeft, 0);
  });

  it('never reports a negative number of spots', () => {
    const shaped = shapeEvent(
      event({
        hostLimit: 1,
        signups: [
          signup({ id: 'h1', kind: 'host', item: '' }),
          signup({ id: 'h2', kind: 'host', item: '', createdBy: BOB }),
        ],
      }),
    );
    assert.equal(shaped.hostSpotsLeft, 0);
  });

  it('closes a slot at capacity but never one with no limit', () => {
    const shaped = shapeEvent(
      event({
        signups: [
          signup({ id: 'f1', slotId: 'main' }),
          signup({ id: 'f2', slotId: 'sides' }),
          signup({ id: 'f3', slotId: 'sides', createdBy: BOB }),
          signup({ id: 'f4', slotId: 'sides', createdBy: BOB }),
        ],
      }),
    );
    const [main, sides] = shaped.foodSlots;
    assert.equal(main.taken, 1);
    assert.equal(main.hasRoom, false);
    assert.equal(sides.taken, 3);
    assert.equal(sides.unlimited, true);
    assert.equal(sides.hasRoom, true, 'a slot with no limit always has room');
  });

  it('collects sign-ups that belong to no slot', () => {
    const shaped = shapeEvent(event({ signups: [signup({ id: 'f1', slotId: null, item: 'Sparkling water' })] }));
    assert.equal(shaped.otherFood.length, 1);
    assert.equal(shaped.foodSlots.every((s) => s.taken === 0), true);
  });

  it('orders food slots by position, not by arrival', () => {
    const shaped = shapeEvent(
      event({
        foodSlots: [
          { id: 'c', label: 'Dessert', capacity: 1, position: 2 },
          { id: 'a', label: 'Main dish', capacity: 1, position: 0 },
          { id: 'b', label: 'Salad', capacity: 1, position: 1 },
        ],
      }),
    );
    assert.deepEqual(shaped.foodSlots.map((s) => s.label), ['Main dish', 'Salad', 'Dessert']);
  });
});

describe('who may change a sign-up', () => {
  const withSignups = event({
    signups: [signup({ id: 'mine', slotId: 'main' }), signup({ id: 'theirs', slotId: 'sides', createdBy: BOB })],
  });

  it('lets people manage their own and nobody else’s', () => {
    const shaped = shapeEvent(withSignups, { userId: ANNA, isOrganizer: false });
    assert.equal(shaped.signups.find((s) => s.id === 'mine').canManage, true);
    assert.equal(shaped.signups.find((s) => s.id === 'theirs').canManage, false);
  });

  it('lets an organizer manage everything', () => {
    const shaped = shapeEvent(withSignups, { userId: 'user-brian', isOrganizer: true });
    assert.equal(shaped.signups.every((s) => s.canManage), true);
  });

  it('gives a viewer with no session nothing to manage', () => {
    const shaped = shapeEvent(withSignups, { userId: null, isOrganizer: false });
    assert.equal(shaped.signups.some((s) => s.canManage), false);
  });

  it('does not treat a missing author as a match for a missing viewer', () => {
    const shaped = shapeEvent(event({ signups: [signup({ id: 'orphan', createdBy: null })] }), {
      userId: null,
      isOrganizer: false,
    });
    assert.equal(shaped.signups[0].canManage, false);
  });
});

describe('badges', () => {
  const badgeText = (e) => eventBadges(shapeEvent(e)).map((b) => b.text);

  it('asks for a host until one signs up', () => {
    assert.equal(badgeText(event()).includes('Needs a host'), true);
    const hosted = event({ signups: [signup({ id: 'h1', kind: 'host', name: 'Anna', item: '' })] });
    assert.equal(badgeText(hosted).includes('Host: Anna'), true);
  });

  it('counts remaining spots across limited slots only', () => {
    assert.equal(badgeText(event()).includes('1 food slot open'), true);
  });

  it('still welcomes food once the limited slots are full', () => {
    const full = event({ signups: [signup({ id: 'f1', slotId: 'main' })] });
    const text = badgeText(full);
    assert.equal(text.includes('More food welcome'), true);
    assert.equal(text.some((t) => t.includes('food slots open')), false);
  });

  it('says food is covered only when nothing is open', () => {
    const covered = event({
      foodSlots: [{ id: 'main', label: 'Main dish', capacity: 1, position: 0 }],
      signups: [signup({ id: 'f1', slotId: 'main' })],
    });
    assert.equal(badgeText(covered).includes('Food covered'), true);
  });

  it('says nothing about food when an event has no slots and nobody brought anything', () => {
    const bare = event({ foodSlots: [], signups: [], needsHost: false });
    assert.deepEqual(badgeText(bare), []);
  });
});

describe('lists', () => {
  it('sorts by date then start time', () => {
    const events = shapeEvents(
      [
        event({ id: 'b', date: '2026-09-02', startTime: '19:00' }),
        event({ id: 'c', date: '2026-09-09', startTime: '09:00' }),
        event({ id: 'a', date: '2026-09-02', startTime: '08:00' }),
      ],
      {},
    );
    assert.deepEqual(events.map((e) => e.id), ['a', 'b', 'c']);
  });

  it('groups events onto their day', () => {
    const grouped = groupByDate(shapeEvents([event({ id: 'a' }), event({ id: 'b' })], {}));
    assert.equal(grouped.get('2026-09-02').length, 2);
  });

  it('keeps today in the upcoming list and drops yesterday', () => {
    const list = shapeEvents(
      [event({ id: 'past', date: '2026-09-01' }), event({ id: 'today', date: '2026-09-02' })],
      {},
    );
    assert.deepEqual(upcoming(list, '2026-09-02').map((e) => e.id), ['today']);
  });
});
