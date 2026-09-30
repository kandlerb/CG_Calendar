import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eventToIcs, icsFileName } from '../public/lib/ics.js';

const NOW = new Date(Date.UTC(2026, 8, 30, 18, 0, 0));
const base = {
  id: 'e1',
  title: 'Community Group — Week 1',
  date: '2026-10-03',
  startTime: '18:30',
  endTime: '20:30',
  location: '',
  description: '',
};
const lines = (ics) => ics.split('\r\n');

describe('the calendar file for an event', () => {
  it('is a complete calendar with one event, in CRLF lines', () => {
    const ics = eventToIcs(base, { now: NOW });
    assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2.0\r\n/);
    assert.ok(ics.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n'));
    assert.ok(lines(ics).includes('UID:e1@cg-calendar'));
    assert.ok(lines(ics).includes('DTSTAMP:20260930T180000Z'));
  });

  it('uses the start and end time as local, floating times', () => {
    const ics = lines(eventToIcs(base, { now: NOW }));
    assert.ok(ics.includes('DTSTART:20261003T183000'));
    assert.ok(ics.includes('DTEND:20261003T203000'));
  });

  it('puts an event with no end time down for two hours', () => {
    const ics = lines(eventToIcs({ ...base, endTime: '' }, { now: NOW }));
    assert.ok(ics.includes('DTEND:20261003T203000'));
  });

  it('carries a late start past midnight into the next day', () => {
    const ics = lines(eventToIcs({ ...base, startTime: '23:00', endTime: '' }, { now: NOW }));
    assert.ok(ics.includes('DTEND:20261004T010000'));
  });

  it('makes an event with no time an all-day entry', () => {
    const ics = lines(eventToIcs({ ...base, startTime: '', endTime: '' }, { now: NOW }));
    assert.ok(ics.includes('DTSTART;VALUE=DATE:20261003'));
    assert.ok(ics.includes('DTEND;VALUE=DATE:20261004'));
  });

  it('escapes commas, semicolons and line breaks in text', () => {
    const ics = eventToIcs(
      { ...base, location: 'Riverside Park, Shelter B', description: 'Bring chairs; snacks.\nSee you!' },
      { now: NOW },
    );
    assert.ok(lines(ics).includes('LOCATION:Riverside Park\\, Shelter B'));
    assert.ok(lines(ics).includes(String.raw`DESCRIPTION:Bring chairs\; snacks.\nSee you!`));
  });

  it('adds the link back to the event', () => {
    const ics = eventToIcs(base, { now: NOW, url: 'https://example.com/#event=e1' });
    assert.ok(lines(ics).includes('URL:https://example.com/#event=e1'));
  });

  it('leaves out a location that was never set', () => {
    assert.doesNotMatch(eventToIcs(base, { now: NOW }), /LOCATION/);
  });

  it('folds long lines at 75 characters', () => {
    const ics = eventToIcs({ ...base, description: 'x'.repeat(200) }, { now: NOW });
    for (const line of lines(ics)) assert.ok(line.length <= 75, `too long: ${line.length}`);
    assert.match(ics, /\r\n x/);
  });
});

describe('the calendar file name', () => {
  it('is the title, made safe', () => {
    assert.equal(icsFileName(base), 'community-group-week-1.ics');
    assert.equal(icsFileName({ title: '!!!' }), 'event.ics');
  });
});
