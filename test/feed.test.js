import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCalendar, escapeText, foldLine } from '../public/lib/feed.js';

const SITE = 'https://calendar.kandlerbaker.com/';
const NOW = new Date(Date.UTC(2026, 8, 30, 12, 0, 0));

function row(overrides = {}) {
  return {
    id: 'evt-1',
    title: 'Community Group',
    description: '',
    location: '',
    event_date: '2026-10-07',
    start_time: '18:30:00',
    end_time: '20:30:00',
    needs_host: false,
    host_limit: 1,
    allow_other_food: true,
    updated_at: '2026-09-29T15:04:05.123+00:00',
    food_slots: [],
    signups: [],
    ...overrides,
  };
}

/** The feed with its folding undone and its text unescaped, one line each. */
function unfolded(ics) {
  return ics.replace(/\r\n /g, '').split('\r\n');
}

function field(ics, name) {
  const line = unfolded(ics).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
  return line?.slice(line.indexOf(':') + 1);
}

const unescape = (value) =>
  value.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

const build = (rows) => buildCalendar(rows, { siteUrl: SITE, now: NOW });
const description = (ics) => unescape(field(ics, 'DESCRIPTION'));

describe('the calendar file', () => {
  it('is a calendar with one event per row, ending every line in CRLF', () => {
    const ics = build([row(), row({ id: 'evt-2' })]);
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.equal(ics.match(/BEGIN:VEVENT/g).length, 2);
    assert.ok(!/[^\r]\n/.test(ics), 'no bare line feeds');
  });

  it('keeps the same UID for an event, so apps update it instead of adding a copy', () => {
    assert.equal(field(build([row()]), 'UID'), 'evt-1@cg-calendar');
  });

  it('includes the time zone the times are in', () => {
    const ics = build([row()]);
    assert.ok(ics.includes('BEGIN:VTIMEZONE\r\nTZID:America/New_York'));
    assert.ok(ics.includes('DTSTART;TZID=America/New_York:20261007T183000'));
    assert.ok(ics.includes('DTEND;TZID=America/New_York:20261007T203000'));
  });

  it('writes the same wall-clock time on either side of the daylight saving change', () => {
    const ics = build([row({ id: 'a', event_date: '2026-10-31' }), row({ id: 'b', event_date: '2026-11-07' })]);
    assert.ok(ics.includes('DTSTART;TZID=America/New_York:20261031T183000'));
    assert.ok(ics.includes('DTSTART;TZID=America/New_York:20261107T183000'));
  });

  it('gives an event with no end time two hours', () => {
    const ics = build([row({ end_time: null })]);
    assert.ok(ics.includes('DTEND;TZID=America/New_York:20261007T203000'));
  });

  it('carries a late event past midnight rather than ending it before it starts', () => {
    const ics = build([row({ start_time: '23:00', end_time: null, event_date: '2026-12-31' })]);
    assert.ok(ics.includes('DTEND;TZID=America/New_York:20270101T010000'));
  });

  it('makes an event with no time an all-day event', () => {
    const ics = build([row({ start_time: null, end_time: null, event_date: '2026-10-31' })]);
    assert.ok(ics.includes('DTSTART;VALUE=DATE:20261031'));
    assert.ok(ics.includes('DTEND;VALUE=DATE:20261101'));
  });

  it('stamps when the event last changed, in UTC', () => {
    assert.equal(field(build([row()]), 'LAST-MODIFIED'), '20260929T150405Z');
    assert.equal(field(build([row()]), 'DTSTAMP'), '20260930T120000Z');
  });

  it('keeps a cancelled event, marked as cancelled', () => {
    const ics = build([row({ cancelled: true })]);
    assert.equal(field(ics, 'STATUS'), 'CANCELLED');
    assert.equal(field(ics, 'SUMMARY'), 'Cancelled: Community Group');
    assert.match(description(ics), /This event is cancelled\./);
  });

  it('asks calendar apps to check hourly', () => {
    assert.ok(build([]).includes('REFRESH-INTERVAL;VALUE=DURATION:PT1H'));
  });
});

describe('where the event is', () => {
  it('uses the location the organizer set', () => {
    const ics = build([row({ location: '12 Oak St, Augusta, GA 30901' })]);
    assert.equal(field(ics, 'LOCATION'), '12 Oak St\\, Augusta\\, GA 30901');
  });

  it("uses the host's address when the event needed a host", () => {
    const ics = build([
      row({
        needs_host: true,
        signups: [{ id: 's', kind: 'host', name: 'Anna', address: '9 Elm Ave, Evans, GA', note: 'Side door', mine: false }],
      }),
    ]);
    assert.equal(unescape(field(ics, 'LOCATION')), '9 Elm Ave, Evans, GA');
  });

  it('leaves the location out when nobody has said where', () => {
    assert.equal(field(build([row({ needs_host: true })]), 'LOCATION'), undefined);
  });
});

describe('the description', () => {
  const slots = [
    { id: 'main', label: 'Main dish', needed: 2, position: 0 },
    { id: 'dessert', label: 'Dessert', needed: 1, position: 1 },
    { id: 'sides', label: 'Sides', needed: 0, position: 2 },
  ];
  const potluck = (signups, extra = {}) =>
    row({ needs_host: true, food_slots: slots, signups, description: 'Kids welcome.', ...extra });

  it('opens with the link to the event, labelled for someone who has not signed up', () => {
    const text = description(build([potluck([])]));
    assert.equal(text.split('\n')[0], `Sign up or see details: ${SITE}#event=evt-1`);
    assert.equal(field(build([potluck([])]), 'URL'), `${SITE}#event=evt-1`);
  });

  it('tells someone who signed up that the link is where to change it', () => {
    const text = description(
      build([potluck([{ id: 'a', kind: 'food', slot_id: 'main', name: 'Brian', item: 'Lasagna', mine: true }])]),
    );
    assert.ok(text.startsWith('See details or change your sign-up: '));
    assert.ok(text.includes("You're bringing: Lasagna."));
  });

  it('says "See details" once nothing is needed', () => {
    const text = description(
      build([
        row({
          food_slots: [{ id: 'main', label: 'Main dish', needed: 1, position: 0 }],
          signups: [{ id: 'a', kind: 'food', slot_id: 'main', name: 'Bob', item: 'Chili', mine: false }],
        }),
      ]),
    );
    assert.ok(text.startsWith('See details: '));
  });

  it("tells the host they're hosting", () => {
    const text = description(build([potluck([{ id: 'h', kind: 'host', name: 'Anna', note: 'Side door', mine: true }])]));
    assert.ok(text.includes("You're hosting."));
    assert.ok(text.includes('Host: Anna — Side door'));
  });

  it('lists who is bringing what, and what is still needed', () => {
    const text = description(
      build([
        potluck([
          { id: 'a', kind: 'food', slot_id: 'main', name: 'Brian', item: 'Lasagna', note: '', mine: false },
          { id: 'b', kind: 'food', slot_id: 'sides', name: 'Bob', item: 'Chili', note: 'mild', mine: false },
          { id: 'c', kind: 'food', slot_id: null, name: 'Carol', item: 'Lemonade', mine: false },
        ]),
      ]),
    );
    assert.ok(text.includes('Host: still needed'));
    assert.ok(text.includes('• Main dish (2 wanted, 1 so far): Brian — Lasagna'));
    assert.ok(text.includes('• Dessert (1 wanted): still needed'));
    assert.ok(text.includes('• Sides: Bob — Chili (mild)'));
    assert.ok(text.includes('• Other food: Carol — Lemonade'));
    assert.ok(text.includes('Still needed: a host and 2 more food sign-ups.'));
    assert.ok(text.endsWith('Kids welcome.'));
  });

  it('says who is not attending, and tells you when it is you', () => {
    const ics = build([row({ absences: [{ id: 'a1', name: 'Bob', mine: false }] })]);
    const text = description(ics);
    assert.ok(text.includes('Not attending: Bob'));
    assert.ok(!text.includes("You said you're not attending."));
    assert.equal(text.split('\n')[0], `See details: ${SITE}#event=evt-1`);

    const mine = description(build([row({ absences: [{ id: 'a1', name: 'Anna', mine: true }] })]));
    assert.ok(mine.includes("You said you're not attending."));
    assert.equal(mine.split('\n')[0], `See details or change your answer: ${SITE}#event=evt-1`);
  });

  it('never includes contact details, even if a row carries them', () => {
    const ics = build([potluck([{ id: 'a', kind: 'host', name: 'Anna', contact: '555-0100', mine: false }])]);
    assert.ok(!ics.includes('555-0100'));
  });
});

describe('text rules', () => {
  it('escapes the characters the format reserves', () => {
    assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  });

  it('keeps titles with commas and new lines intact', () => {
    const ics = build([row({ title: 'Dinner, then games; bring chairs' })]);
    assert.equal(unescape(field(ics, 'SUMMARY')), 'Dinner, then games; bring chairs');
  });

  it('folds long lines at 75 bytes without splitting a character', () => {
    const line = `DESCRIPTION:${'é'.repeat(100)}`;
    const folded = foldLine(line);
    const encoder = new TextEncoder();
    for (const part of folded.split('\r\n')) assert.ok(encoder.encode(part).length <= 75);
    assert.equal(folded.replace(/\r\n /g, ''), line);
    assert.ok(!folded.includes('�'));
  });

  it('leaves short lines alone', () => {
    assert.equal(foldLine('SUMMARY:Dinner'), 'SUMMARY:Dinner');
  });
});
