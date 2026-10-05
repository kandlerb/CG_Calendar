// Builds a member's calendar feed: the iCalendar (.ics) text that Apple
// Calendar, Google Calendar and Outlook subscribe to. The calendar-feed Edge
// Function serves it; the demo page uses it to show a sample. Kept free of the
// DOM and of Supabase so it can be tested on its own.
//
// Events are stored as a plain date and time with no zone — "6:30 PM on the
// 7th" means 6:30 PM where the group meets. The feed says which zone that is,
// so a phone set to another zone still shows the right moment.

import { eventSummary, shapeEvent } from './model.js';

export const TIME_ZONE = 'America/New_York';

// How long an event with a start but no end is shown as lasting.
export const DEFAULT_DURATION_MINUTES = 120;

// Calendar apps need the zone's rules spelled out, not just its name. These
// are the US rules in force since 2007.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${TIME_ZONE}`,
  `X-LIC-LOCATION:${TIME_ZONE}`,
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

const pad = (n) => String(n).padStart(2, '0');

/** Text values escape backslashes, commas, semicolons and line breaks. */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Lines longer than 75 bytes are folded: broken, with the rest continued on
 * lines that start with a space. Bytes, not characters — and never through the
 * middle of a character, or "é" arrives as two pieces of garbage.
 */
export function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74; // the leading space counts
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** "2026-10-07" + "18:30" → "20261007T183000". */
function localStamp(date, time) {
  return `${date.replace(/-/g, '')}T${time.slice(0, 2)}${time.slice(3, 5)}00`;
}

/** A local date and time moved by some minutes, crossing midnight if need be. */
function addMinutes(date, time, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d, hh, mm + minutes));
  return {
    date: `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`,
    time: `${pad(moved.getUTCHours())}:${pad(moved.getUTCMinutes())}`,
  };
}

function nextDay(date) {
  return addMinutes(date, '00:00', 24 * 60).date;
}

function utcStamp(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

const hhmm = (value) => {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})/);
  return match ? `${pad(Number(match[1]))}:${match[2]}` : '';
};

/** A row from feed_data() in the shape model.js works with. */
export function toFeedEvent(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    location: row.location ?? '',
    date: row.event_date,
    startTime: hhmm(row.start_time),
    endTime: hhmm(row.end_time),
    needsHost: row.needs_host,
    hostLimit: row.host_limit,
    allowOtherFood: row.allow_other_food,
    cancelled: Boolean(row.cancelled),
    updatedAt: row.updated_at ?? null,
    foodSlots: (row.food_slots ?? []).map((slot) => ({
      id: slot.id,
      label: slot.label,
      needed: slot.needed,
      position: slot.position ?? 0,
    })),
    signups: (row.signups ?? []).map((signup) => ({
      id: signup.id,
      slotId: signup.slot_id,
      kind: signup.kind,
      name: signup.name,
      item: signup.item ?? '',
      note: signup.note ?? '',
      address: signup.address ?? '',
      // The feed never learns who created what, only whether it was you.
      createdBy: signup.mine ? 'me' : 'someone',
    })),
    absences: (row.absences ?? []).map((absence) => ({
      id: absence.id,
      name: absence.name,
      userId: absence.mine ? 'me' : 'someone',
    })),
  };
}

/** Where the event is: the organizer's location, else the host's address. */
export function eventLocation(event) {
  if (event.location) return event.location;
  const host = (event.hosts ?? event.signups?.filter((s) => s.kind === 'host') ?? []).find((h) => h.address);
  return host?.address ?? '';
}

export function eventLink(siteUrl, eventId) {
  return `${String(siteUrl).split('#')[0]}#event=${encodeURIComponent(eventId)}`;
}

function person(signup) {
  const what = [signup.item, signup.note ? `(${signup.note})` : ''].filter(Boolean).join(' ');
  return what ? `${signup.name} — ${what}` : signup.name;
}

/**
 * The description, written fresh on every fetch. The link comes first: it is
 * what shows in the short preview a phone gives when an event is tapped.
 */
export function describeEvent(event, siteUrl) {
  const summary = eventSummary(event);
  const label = event.mine.length
    ? 'See details or change your sign-up'
    : event.notAttending
      ? 'See details or change your answer'
      : summary.done
        ? 'See details'
        : 'Sign up or see details';
  const lines = [`${label}: ${eventLink(siteUrl, event.id)}`, ''];

  const yours = [];
  if (event.mine.some((s) => s.kind === 'host')) yours.push("You're hosting.");
  const bringing = event.mine.filter((s) => s.kind === 'food').map((s) => s.item);
  if (bringing.length) yours.push(`You're bringing: ${bringing.join(', ')}.`);
  if (event.notAttending) yours.push("You said you're not attending.");
  lines.push(...yours, summary.text);

  if (event.needsHost || event.hosts.length) {
    lines.push('');
    if (event.hosts.length) {
      for (const host of event.hosts) {
        lines.push(`Host: ${host.name}${host.note ? ` — ${host.note}` : ''}`);
      }
    }
    if (event.hostSpotsLeft > 0) lines.push('Host: still needed');
  }

  if (event.foodSlots.length || event.otherFood.length) {
    lines.push('', 'Food:');
    for (const slot of event.foodSlots) {
      const people = slot.people.map(person).join('; ');
      let head = slot.label;
      if (!slot.noMinimum) {
        head += slot.taken ? ` (${slot.needed} wanted, ${slot.taken} so far)` : ` (${slot.needed} wanted)`;
      }
      lines.push(`• ${head}: ${people || (slot.noMinimum ? 'nobody yet' : 'still needed')}`);
    }
    if (event.otherFood.length) {
      lines.push(`• Other food: ${event.otherFood.map(person).join('; ')}`);
    }
  }

  if (event.absences?.length) {
    lines.push('', `Not attending: ${event.absences.map((a) => a.name).join(', ')}`);
  }

  if (event.description) lines.push('', event.description);
  return lines.join('\n');
}

function eventLines(event, { siteUrl, now }) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.id}@cg-calendar`,
    `DTSTAMP:${utcStamp(now)}`,
  ];
  const modified = event.updatedAt ? utcStamp(event.updatedAt) : null;
  if (modified) lines.push(`LAST-MODIFIED:${modified}`);

  if (event.startTime) {
    const end =
      event.endTime && event.endTime > event.startTime
        ? { date: event.date, time: event.endTime }
        : addMinutes(event.date, event.startTime, DEFAULT_DURATION_MINUTES);
    lines.push(
      `DTSTART;TZID=${TIME_ZONE}:${localStamp(event.date, event.startTime)}`,
      `DTEND;TZID=${TIME_ZONE}:${localStamp(end.date, end.time)}`,
    );
  } else {
    // No time set: an all-day event. DTEND is the day after, exclusive.
    lines.push(
      `DTSTART;VALUE=DATE:${event.date.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${nextDay(event.date).replace(/-/g, '')}`,
    );
  }

  // A cancelled event stays in the feed, marked, so it disappears from
  // nobody's calendar without explanation.
  if (event.cancelled) lines.push('STATUS:CANCELLED');
  lines.push(`SUMMARY:${escapeText(event.cancelled ? `Cancelled: ${event.title}` : event.title)}`);
  const location = eventLocation(event);
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  lines.push(
    `DESCRIPTION:${escapeText(describeEvent(event, siteUrl))}`,
    `URL:${eventLink(siteUrl, event.id)}`,
    'END:VEVENT',
  );
  return lines;
}

/**
 * The whole feed. `rows` are feed_data()'s events; `now` is when it was made.
 * Lines end in CRLF, as the format requires.
 */
export function buildCalendar(rows, { siteUrl, calendarName = 'Community Group Calendar', now = new Date() }) {
  const events = rows.map((row) => shapeEvent(toFeedEvent(row), { userId: 'me' }));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CG Calendar//Member feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${TIME_ZONE}`,
    // Asks for an hourly refresh. Apple and Outlook generally honour it;
    // Google fetches on its own schedule regardless.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...VTIMEZONE,
    ...events.flatMap((event) => eventLines(event, { siteUrl, now })),
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
