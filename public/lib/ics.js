// An .ics file for one event, so it can be added to a phone or computer
// calendar. Kept free of the DOM so it can be tested on its own.
//
// Times are "floating" (no timezone): an event at 6:30 PM is at 6:30 PM
// wherever the calendar is, which matches how the page treats dates.

import { parseISODate } from './dates.js';

const pad = (n) => String(n).padStart(2, '0');

const dateStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const localStamp = (d) => `${dateStamp(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const utcStamp = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
  `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** Text values escape backslashes, commas, semicolons and line breaks. */
function text(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/[,;]/g, (c) => `\\${c}`)
    .replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 characters continue on the next line after a space. */
function fold(line) {
  const parts = [];
  for (let rest = line; rest.length; rest = rest.slice(parts.length === 1 ? 75 : 74)) {
    parts.push(rest.slice(0, parts.length ? 74 : 75));
  }
  return parts.join('\r\n ');
}

function at(dateKey, hhmm) {
  const day = parseISODate(dateKey);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

/** How long an event with a start time but no end time is put down for. */
export const DEFAULT_HOURS = 2;

/**
 * The calendar file for `event` (a shaped event, or anything with the same
 * fields). `url` links back to the event; `now` stamps the file.
 */
export function eventToIcs(event, { url = '', now = new Date() } = {}) {
  let when;
  if (event.startTime) {
    const start = at(event.date, event.startTime);
    const end = event.endTime
      ? at(event.date, event.endTime)
      : new Date(start.getTime() + DEFAULT_HOURS * 3_600_000);
    when = [`DTSTART:${localStamp(start)}`, `DTEND:${localStamp(end)}`];
  } else {
    // No time set: an all-day entry, which ends (exclusively) the next day.
    const day = parseISODate(event.date);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    when = [`DTSTART;VALUE=DATE:${dateStamp(day)}`, `DTEND;VALUE=DATE:${dateStamp(next)}`];
  }
  const description = [event.description, url].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CG Calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${event.id}@cg-calendar`,
    `DTSTAMP:${utcStamp(now)}`,
    ...when,
    `SUMMARY:${text(event.title)}`,
    event.location ? `LOCATION:${text(event.location)}` : '',
    description ? `DESCRIPTION:${text(description)}` : '',
    url ? `URL:${url}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** A file name a phone will accept: "community-group-week-1.ics". */
export function icsFileName(event) {
  const slug = String(event.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'event'}.ics`;
}
