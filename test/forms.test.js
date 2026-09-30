import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  LIMITS,
  cleanSlots,
  eventFromForm,
  loadWindowStart,
  signupFromForm,
  slotStatus,
  eventCopy,
  nextTitle,
  repeatCount,
  slotCopies,
} from '../public/lib/forms.js';
import { slotState } from '../public/lib/model.js';

const eventValues = (overrides = {}) => ({
  title: 'Dinner',
  date: '2026-10-01',
  startTime: '18:00',
  endTime: '',
  hosting: 'needed',
  hostLimit: '1',
  location: '',
  description: '',
  ...overrides,
});

describe('the event form', () => {
  it('trims what was typed', () => {
    const event = eventFromForm(eventValues({ title: '  Dinner  ', description: ' Bring chairs \n' }));
    assert.equal(event.title, 'Dinner');
    assert.equal(event.description, 'Bring chairs');
  });

  it('refuses a title of only spaces', () => {
    assert.throws(() => eventFromForm(eventValues({ title: '   ' })), /title/);
  });

  it('refuses an end time before the start time', () => {
    assert.throws(() => eventFromForm(eventValues({ startTime: '19:00', endTime: '18:00' })), /before the start/);
  });

  it('accepts an end time equal to or after the start time', () => {
    assert.equal(eventFromForm(eventValues({ startTime: '18:00', endTime: '18:00' })).endTime, '18:00');
    assert.equal(eventFromForm(eventValues({ startTime: '09:30', endTime: '10:00' })).endTime, '10:00');
  });

  it('asks for a start time when only an end time is given', () => {
    assert.throws(() => eventFromForm(eventValues({ startTime: '', endTime: '20:00' })), /start time/);
  });

  it('keeps the location only when the host is arranged', () => {
    assert.equal(eventFromForm(eventValues({ hosting: 'needed', location: 'Park' })).location, '');
    const arranged = eventFromForm(eventValues({ hosting: 'set', location: ' Park ' }));
    assert.equal(arranged.location, 'Park');
    assert.equal(arranged.needsHost, false);
  });

  it('never asks for fewer than one host', () => {
    assert.equal(eventFromForm(eventValues({ hostLimit: '0' })).hostLimit, 1);
    assert.equal(eventFromForm(eventValues({ hostLimit: '' })).hostLimit, 1);
    assert.equal(eventFromForm(eventValues({ hostLimit: '3' })).hostLimit, 3);
  });

  it('treats an empty id as a new event', () => {
    assert.equal(eventFromForm(eventValues(), { id: '' }).id, null);
    assert.equal(eventFromForm(eventValues(), { id: 'e1' }).id, 'e1');
  });
});

describe('food slots in the event form', () => {
  it('drops blank rows and trims labels', () => {
    const slots = cleanSlots([
      { id: '', label: ' Main ', needed: '2' },
      { id: '', label: '   ', needed: '1' },
      { id: 's1', label: 'Dessert', needed: '0' },
    ]);
    assert.deepEqual(slots, [
      { id: '', label: 'Main', needed: 2 },
      { id: 's1', label: 'Dessert', needed: 0 },
    ]);
  });

  it('turns a missing, negative or fractional number into 0', () => {
    const needed = cleanSlots([
      { label: 'A', needed: '' },
      { label: 'B', needed: '-2' },
      { label: 'C', needed: '1.5' },
    ]).map((s) => s.needed);
    assert.deepEqual(needed, [0, 0, 0]);
  });
});

describe('the sign-up form', () => {
  const base = { eventId: 'e1', kind: 'food', slotId: 's1' };

  it('trims what was typed', () => {
    const signup = signupFromForm({ name: ' Anna ', item: ' Pie ', contact: ' 555 ', note: '' }, base);
    assert.deepEqual(signup, {
      eventId: 'e1',
      kind: 'food',
      slotId: 's1',
      name: 'Anna',
      contact: '555',
      item: 'Pie',
      note: '',
      address: '',
    });
  });

  it('refuses a name of only spaces', () => {
    assert.throws(() => signupFromForm({ name: '  ', item: 'Pie' }, base), /name/);
  });

  it('refuses a food sign-up that brings nothing', () => {
    assert.throws(() => signupFromForm({ name: 'Anna', item: '   ' }, base), /bring/);
  });

  it('does not ask a host what they are bringing', () => {
    const host = signupFromForm({ name: 'Anna' }, { eventId: 'e1', kind: 'host' });
    assert.equal(host.item, '');
    assert.equal(host.slotId, null);
  });

  it("keeps a host's address, trimmed, and ignores one on a food sign-up", () => {
    const host = signupFromForm({ name: 'Anna', address: ' 12 Oak St ' }, { eventId: 'e1', kind: 'host' });
    assert.equal(host.address, '12 Oak St');
    const food = signupFromForm({ name: 'Anna', item: 'Pie', address: '12 Oak St' }, base);
    assert.equal(food.address, '');
  });
});

describe('what a slot says about itself', () => {
  const people = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'food', slotId: 's', name: `P${i}` }));
  const status = (needed, taken) => slotStatus(slotState({ id: 's', label: 'Main', needed }, people(taken))).text;

  it('counts toward the number wanted', () => {
    assert.equal(status(3, 1), '1 of 3 · 2 more needed');
  });

  it('does not repeat itself before anyone has signed up', () => {
    assert.equal(status(2, 0), '2 needed');
  });

  it('says covered once the number is met', () => {
    assert.equal(status(2, 2), '2 of 2 · covered');
  });

  it('does not say "5 of 2" once past the number', () => {
    assert.equal(status(2, 5), '5 signed up · covered');
  });

  it('welcomes any number when none was set', () => {
    assert.equal(status(0, 0), 'Any number welcome');
    assert.equal(status(0, 4), '4 signed up · any number welcome');
  });

  it('only counts once the event is over', () => {
    const slot = slotState({ id: 's', label: 'Main', needed: 3 }, people(1));
    assert.deepEqual(slotStatus(slot, { past: true }), { text: '1 signed up', tone: 'done' });
  });
});

describe('the loading window', () => {
  it('starts at the first of the month two months back', () => {
    assert.equal(loadWindowStart(new Date(2026, 9, 17)), '2026-08-01');
  });

  it('crosses into the previous year', () => {
    assert.equal(loadWindowStart(new Date(2026, 0, 5)), '2025-11-01');
  });
});

describe('field limits', () => {
  // The page's maxlength attributes come from LIMITS. If schema.sql changes a
  // limit and LIMITS does not follow, people get a Postgres error again.
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const columns = {
    title: 'title',
    description: 'description',
    location: 'location',
    slotLabel: 'label',
    name: 'name',
    contact: 'contact',
    item: 'item',
    note: 'note',
  };

  for (const [key, column] of Object.entries(columns)) {
    it(`matches schema.sql for ${column}`, () => {
      const pattern = new RegExp(
        `\\b${column}\\b[^\\n]*char_length\\(${column}\\) (?:between 1 and|<=) (\\d+)`,
        'g',
      );
      const limits = [...schema.matchAll(pattern)].map((m) => Number(m[1]));
      assert.ok(limits.length, `no length check for ${column} in schema.sql`);
      assert.ok(limits.includes(LIMITS[key]), `${column}: schema says ${limits}, LIMITS says ${LIMITS[key]}`);
    });
  }
});

describe('repeating an event', () => {
  const source = {
    id: 'e1',
    title: 'Community Group — Week 3',
    date: '2026-10-03',
    startTime: '18:30',
    endTime: '20:30',
    location: '',
    description: 'Philippians 2',
    needsHost: true,
    hostLimit: 1,
    allowOtherFood: true,
    cancelled: true,
  };

  it('moves a numbered title along with the weeks', () => {
    assert.equal(nextTitle('Community Group — Week 3'), 'Community Group — Week 4');
    assert.equal(nextTitle('Week 9', 3), 'Week 12');
    assert.equal(nextTitle('Session #2'), 'Session #3');
  });

  it('leaves a title with no series number alone', () => {
    assert.equal(nextTitle('Fall Cookout 2026'), 'Fall Cookout 2026');
    assert.equal(nextTitle('Potluck'), 'Potluck');
  });

  it('copies an event a number of weeks on, as a new event that is not cancelled', () => {
    const copy = eventCopy(source, 2);
    assert.equal(copy.id, null);
    assert.equal(copy.date, '2026-10-17');
    assert.equal(copy.title, 'Community Group — Week 5');
    assert.equal(copy.startTime, '18:30');
    assert.equal(copy.description, 'Philippians 2');
    assert.equal('cancelled' in copy, false);
  });

  it('crosses month and year ends', () => {
    assert.equal(eventCopy({ ...source, date: '2026-12-26' }, 1).date, '2027-01-02');
  });

  it('copies food slots as new slots', () => {
    assert.deepEqual(slotCopies([{ id: 's1', label: 'Main dish', needed: 2, people: [1] }]), [
      { id: '', label: 'Main dish', needed: 2 },
    ]);
  });

  it('makes between 0 and 12 extra copies', () => {
    assert.deepEqual(['', '-2', '3', '40', 'x'].map(repeatCount), [0, 0, 3, 12, 0]);
  });
});
