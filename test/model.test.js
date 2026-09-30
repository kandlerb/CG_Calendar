import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  eventBadges,
  eventSummary,
  foodStillNeeded,
  groupByDate,
  nextEvent,
  shapeEvent,
  past,
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
      { id: 'main', label: 'Main dish', needed: 1, position: 0 },
      { id: 'sides', label: 'Side dish', needed: 0, position: 1 },
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

  it('tracks a slot against the number wanted without ever closing it', () => {
    const shaped = shapeEvent(
      event({
        foodSlots: [
          { id: 'main', label: 'Main dish', needed: 2, position: 0 },
          { id: 'sides', label: 'Side dish', needed: 0, position: 1 },
        ],
        signups: [
          signup({ id: 'f1', slotId: 'main' }),
          signup({ id: 'f2', slotId: 'sides' }),
          signup({ id: 'f3', slotId: 'sides', createdBy: BOB }),
        ],
      }),
    );
    const [main, sides] = shaped.foodSlots;
    assert.equal(main.taken, 1);
    assert.equal(main.stillNeeded, 1);
    assert.equal(main.met, false);
    assert.equal(sides.taken, 2);
    assert.equal(sides.noMinimum, true);
    assert.equal(sides.stillNeeded, 0, 'a slot with no minimum is never short');
    assert.equal(sides.met, true);
  });

  it('counts a slot as met once the number is reached, and past it', () => {
    const slots = [{ id: 'main', label: 'Main dish', needed: 2, position: 0 }];
    const withCount = (n) =>
      shapeEvent(
        event({
          foodSlots: slots,
          signups: Array.from({ length: n }, (_, i) => signup({ id: `f${i}`, slotId: 'main' })),
        }),
      ).foodSlots[0];
    assert.deepEqual(
      [withCount(1), withCount(2), withCount(4)].map((s) => [s.met, s.stillNeeded]),
      [
        [false, 1],
        [true, 0],
        [true, 0],
      ],
    );
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
          { id: 'c', label: 'Dessert', needed: 1, position: 2 },
          { id: 'a', label: 'Main dish', needed: 1, position: 0 },
          { id: 'b', label: 'Salad', needed: 1, position: 1 },
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

  it('shows no host badge when the organizer has already arranged the host', () => {
    const arranged = event({ needsHost: false, location: "The Smiths' home" });
    assert.equal(badgeText(arranged).some((t) => /host/i.test(t)), false);
  });

  it('still credits a host who signed up before the organizer arranged one', () => {
    const settled = event({
      needsHost: false,
      signups: [signup({ id: 'h1', kind: 'host', name: 'Anna', item: '' })],
    });
    assert.equal(badgeText(settled).includes('Hosted by Anna'), true);
  });

  it('counts how many more sign-ups the slots are asking for', () => {
    assert.equal(badgeText(event()).includes('1 more food sign-up needed'), true);
  });

  it('says food is covered once every minimum is met', () => {
    const covered = event({ signups: [signup({ id: 'f1', slotId: 'main' })] });
    const text = badgeText(covered);
    assert.equal(text.includes('Food covered'), true);
    assert.equal(text.some((t) => t.includes('needed')), false);
  });

  it('does not count a slot with no minimum as short', () => {
    const onlyOpen = event({
      needsHost: false,
      foodSlots: [{ id: 'sides', label: 'Side dish', needed: 0, position: 0 }],
      signups: [],
    });
    assert.equal(badgeText(onlyOpen).includes('Food covered'), true);
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

  it('gives one food badge, not a shortfall and a head count side by side', () => {
    const text = badgeText(event({ signups: [signup({ id: 'f1', slotId: 'sides' })] }));
    assert.deepEqual(
      text.filter((t) => /food/i.test(t)),
      ['1 more food sign-up needed'],
    );
  });

  it('tells the viewer when one of the sign-ups is their own', () => {
    const shaped = shapeEvent(event({ signups: [signup({ id: 'f1', slotId: 'main' })] }), { userId: ANNA });
    assert.equal(eventBadges(shaped).some((b) => b.mine), true);
    const other = shapeEvent(event({ signups: [signup({ id: 'f1', slotId: 'main' })] }), { userId: BOB });
    assert.equal(eventBadges(other).some((b) => b.mine), false);
  });
});

describe('the one-line summary at the top of an event', () => {
  it('names everything still missing, counting people rather than slots', () => {
    const summary = eventSummary(
      shapeEvent(
        event({
          hostLimit: 2,
          foodSlots: [{ id: 'main', label: 'Main dish', needed: 3, position: 0 }],
        }),
      ),
    );
    assert.equal(summary.done, false);
    assert.equal(summary.text, 'Still needed: 2 more hosts and 3 more food sign-ups.');
  });

  it('uses the singular for the last sign-up wanted', () => {
    const summary = eventSummary(
      shapeEvent(
        event({
          needsHost: false,
          foodSlots: [{ id: 'main', label: 'Main dish', needed: 2, position: 0 }],
          signups: [signup({ id: 'f1', slotId: 'main' })],
        }),
      ),
    );
    assert.equal(summary.text, 'Still needed: 1 more food sign-up.');
  });

  it('does not count a slot with no minimum as something missing', () => {
    const summary = eventSummary(
      shapeEvent(event({ needsHost: false, signups: [signup({ id: 'f1', slotId: 'main' })] })),
    );
    assert.equal(summary.done, true);
    assert.match(summary.text, /More food is still welcome/);
  });
});

describe('counting what the slots still ask for', () => {
  it('adds up the shortfall and ignores slots with no minimum or already met', () => {
    const shaped = shapeEvent(
      event({
        foodSlots: [
          { id: 'main', label: 'Main dish', needed: 1, position: 0 },
          { id: 'dessert', label: 'Dessert', needed: 3, position: 1 },
          { id: 'sides', label: 'Side dish', needed: 0, position: 2 },
        ],
        signups: [signup({ id: 'f1', slotId: 'dessert' }), signup({ id: 'f2', slotId: 'sides' })],
      }),
    );
    assert.equal(foodStillNeeded(shaped), 3, '1 for the main dish and 2 more desserts');
  });

  it('never goes negative when more people sign up than were asked for', () => {
    const shaped = shapeEvent(
      event({
        needsHost: false,
        foodSlots: [{ id: 'main', label: 'Main dish', needed: 1, position: 0 }],
        signups: [signup({ id: 'f1', slotId: 'main' }), signup({ id: 'f2', slotId: 'main' })],
      }),
    );
    assert.equal(foodStillNeeded(shaped), 0);
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

describe('events that are over', () => {
  const today = '2026-09-10';
  const over = event({ date: '2026-09-02', signups: [signup({ id: 'mine', slotId: 'main' })] });

  it('is only decided when the caller says what today is', () => {
    assert.equal(shapeEvent(over).past, false);
    assert.equal(shapeEvent(over, { todayKey: today }).past, true);
    assert.equal(shapeEvent(event({ date: today }), { todayKey: today }).past, false, 'today is not past');
  });

  it('stops a participant changing their sign-up, but not an organizer', () => {
    assert.equal(shapeEvent(over, { userId: ANNA, todayKey: today }).signups[0].canManage, false);
    assert.equal(shapeEvent(over, { userId: 'x', isOrganizer: true, todayKey: today }).signups[0].canManage, true);
  });

  it('asks for nothing', () => {
    const shaped = shapeEvent(over, { userId: ANNA, todayKey: today });
    assert.equal(eventSummary(shaped).text, 'This event has passed.');
    assert.deepEqual(eventBadges(shaped).map((b) => b.text), ['Past event', 'You signed up']);
  });

  it('lists past events most recent first', () => {
    const list = shapeEvents(
      [event({ id: 'a', date: '2026-08-01' }), event({ id: 'b', date: '2026-09-01' }), event({ id: 'c', date: today })],
      {},
    );
    assert.deepEqual(past(list, today).map((e) => e.id), ['b', 'a']);
  });
});
