// Date helpers. Everything is handled as a local calendar day — an event on
// the 2nd is on the 2nd wherever you open the page, so no timezone maths.

const pad = (n) => String(n).padStart(2, '0');

export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The calendar day a moment fell on where the viewer is. A database timestamp
 * is in UTC, so cutting the date off its text would put an evening sign-up in
 * the Eastern US on the next day. A plain "2026-09-30" is already a day.
 */
export function localDateOf(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? '' : isoDate(moment);
}

export function parseISODate(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addMonths(d, delta) {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

/** The day `days` after the "2026-10-03" key, as a key. */
export function addDays(dateKey, days) {
  const d = parseISODate(dateKey);
  return isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/** "18:30:00" and "18:30" both become "18:30"; anything empty becomes "". */
export function normalizeTime(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  return match ? `${pad(Number(match[1]))}:${match[2]}` : '';
}

export function formatTime(hhmm) {
  const value = normalizeTime(hhmm);
  if (!value) return '';
  const [h, m] = value.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${pad(m)} ${suffix}`;
}

export function formatTimeRange({ startTime, endTime }) {
  if (!startTime) return 'Time TBD';
  return endTime ? `${formatTime(startTime)} – ${formatTime(endTime)}` : formatTime(startTime);
}

/** "Wednesday, October 7" — enough to place a date without the year. */
export function formatShortDate(value) {
  return parseISODate(value).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function formatLongDate(value) {
  return parseISODate(value).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The cells of a month view: whole weeks running Sunday to Saturday, covering
 * every day of the month and nothing more.
 */
export function monthGrid(monthDate) {
  const first = startOfMonth(monthDate);
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
  const start = new Date(first);
  start.setDate(1 - first.getDay());

  return Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7 + day);
      return {
        date,
        key: isoDate(date),
        dayOfMonth: date.getDate(),
        outside: date.getMonth() !== first.getMonth(),
      };
    }),
  );
}
