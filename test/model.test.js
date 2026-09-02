import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  eventBadges,
  eventSummary,
  groupByDate,
  nextEvent,
  openFoodSpots,
  shapeEvent,
  shapeEvents,
  upcoming,
} from '../public/lib/model.js';

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
    assert.equal(badgeText(hosted).includes('Hosted by Anna'), true);
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

describe('badge wording', () => {
  const badgeText = (e) => eventBadges(shapeEvent(e)).map((b) => b.text);

  it('counts the hosts still wanted rather than saying "host(s)"', () => {
    const text = badgeText(event({ hostLimit: 3 }));
    assert.equal(text.includes('Needs 3 more hosts'), true);
  });

  it('says "1 person" and "2 people", never "1 people"', () => {
    const one = badgeText(event({ signups: [signup({ id: 'f1', slotId: 'main' })] }));
    assert.equal(one.includes('1 person bringing food'), true);
    const two = badgeText(
      event({ signups: [signup({ id: 'f1', slotId: 'main' }), signup({ id: 'f2', slotId: 'sides' })] }),
    );
    assert.equal(two.includes('2 people bringing food'), true);
  });

  it('tells the viewer when one of the sign-ups is their own', () => {
    const shaped = shapeEvent(event({ signups: [signup({ id: 'f1', slotId: 'main' })] }), { userId: ANNA });
    assert.equal(eventBadges(shaped).some((b) => b.mine), true);
    const other = shapeEvent(event({ signups: [signup({ id: 'f1', slotId: 'main' })] }), { userId: BOB });
    assert.equal(eventBadges(other).some((b) => b.mine), false);
  });
});

describe('the one-line summary at the top of an event', () => {
  it('names everything still missing', () => {
    const summary = eventSummary(shapeEvent(event({ hostLimit: 2 })));
    assert.equal(summary.done, false);
    assert.equal(summary.text, 'Still needed: 2 more hosts and 1 food slot.');
  });

  it('does not count a slot with no limit as something missing', () => {
    const summary = eventSummary(
      shapeEvent(event({ needsHost: false, signups: [signup({ id: 'f1', slotId: 'main' })] })),
    );
    assert.equal(summary.done, true);
    assert.match(summary.text, /extra food is still welcome/);
  });

  it('says plainly that nothing is left when every slot has a limit and is full', () => {
    const covered = event({
      needsHost: false,
      allowOtherFood: false,
      foodSlots: [{ id: 'main', label: 'Main dish', capacity: 1, position: 0 }],
      signups: [signup({ id: 'f1', slotId: 'main' })],
    });
    assert.equal(eventSummary(shapeEvent(covered)).text, 'Everything is covered for this event.');
  });
});

describe('counting open food spots', () => {
  it('adds up the room left in limited slots and ignores the rest', () => {
    const shaped = shapeEvent(
      event({
        foodSlots: [
          { id: 'main', label: 'Main dish', capacity: 1, position: 0 },
          { id: 'dessert', label: 'Dessert', capacity: 3, position: 1 },
          { id: 'sides', label: 'Side dish', capacity: 0, position: 2 },
        ],
        signups: [signup({ id: 'f1', slotId: 'dessert' })],
      }),
    );
    assert.equal(openFoodSpots(shaped), 3);
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

  it('finds the soonest event on or after today, and null when there is none', () => {
    const list = shapeEvents(
      [event({ id: 'past', date: '2026-09-01' }), event({ id: 'soon', date: '2026-09-09' })],
      {},
    );
    assert.equal(nextEvent(list, '2026-09-02').id, 'soon');
    assert.equal(nextEvent(list, '2026-10-01'), null);
  });

  it('keeps today in the upcoming list and drops yesterday', () => {
    const list = shapeEvents(
      [event({ id: 'past', date: '2026-09-01' }), event({ id: 'today', date: '2026-09-02' })],
      {},
    );
    assert.deepEqual(upcoming(list, '2026-09-02').map((e) => e.id), ['today']);
  });
});
