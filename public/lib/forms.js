// Turning what someone typed into what gets saved. Kept free of the DOM so it
// can be tested on its own; app.js reads the form and hands the values here.
//
// The database checks all of this again (supabase/schema.sql). Checking here
// first is only so a mistake gets a plain sentence instead of a Postgres
// constraint name.

import { addDays, addMonths, isoDate, normalizeTime, startOfMonth } from './dates.js';

/** The longest each field may be. Mirrors the checks in schema.sql. */
export const LIMITS = {
  title: 120,
  description: 2000,
  location: 200,
  slotLabel: 60,
  name: 80,
  contact: 120,
  item: 140,
  note: 280,
};

/** How far back the page loads events before someone steps into older months. */
export const LOOKBACK_MONTHS = 2;

const text = (value) => String(value ?? '').trim();

function required(value, message) {
  const trimmed = text(value);
  if (!trimmed) throw new Error(message);
  return trimmed;
}

/** A whole number no smaller than `min`; anything else becomes `fallback`. */
function wholeNumber(value, { min, fallback }) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/** Slot rows as typed, minus the blank ones. */
export function cleanSlots(rows) {
  return rows
    .map((row) => ({
      id: row.id || '',
      label: text(row.label),
      needed: wholeNumber(row.needed, { min: 0, fallback: 0 }),
    }))
    .filter((slot) => slot.label);
}

/**
 * The event form's values, checked. `values` is what FormData gives back:
 * strings, with a radio's value under its name.
 */
export function eventFromForm(values, { id = null, allowOtherFood = true } = {}) {
  const needsHost = values.hosting !== 'set';
  const startTime = normalizeTime(values.startTime);
  const endTime = normalizeTime(values.endTime);
  if (!values.date) throw new Error('Choose a date for the event.');
  if (startTime && endTime && endTime < startTime) {
    throw new Error('The end time is before the start time.');
  }
  if (endTime && !startTime) throw new Error('Add a start time, or clear the end time.');
  return {
    id: id || null,
    title: required(values.title, 'Give the event a title.'),
    date: values.date,
    startTime,
    endTime,
    location: needsHost ? '' : text(values.location),
    description: text(values.description),
    needsHost,
    hostLimit: wholeNumber(values.hostLimit, { min: 1, fallback: 1 }),
    allowOtherFood: Boolean(allowOtherFood),
  };
}

/** A sign-up form's values, checked. Blank-looking names and dishes are refused. */
export function signupFromForm(values, { eventId, kind, slotId = null }) {
  return {
    eventId,
    kind,
    slotId: slotId || null,
    name: required(values.name, 'Enter your name.'),
    contact: text(values.contact),
    item: kind === 'food' ? required(values.item, 'Say what you will bring.') : '',
    note: text(values.note),
  };
}

/** What a food slot says about itself under its label. */
export function slotStatus(slot, { past = false } = {}) {
  // Once the event is over nothing is needed; it is just a record.
  if (past) return { text: `${slot.taken} signed up`, tone: 'done' };
  if (slot.noMinimum) {
    return {
      text: slot.taken ? `${slot.taken} signed up · any number welcome` : 'Any number welcome',
      tone: 'open',
    };
  }
  // Past the number asked for, "5 of 2" reads like a mistake; just say how
  // many are coming.
  if (slot.taken > slot.needed) return { text: `${slot.taken} signed up · covered`, tone: 'done' };
  if (slot.met) return { text: `${slot.taken} of ${slot.needed} · covered`, tone: 'done' };
  // "0 of 2. 2 more needed." says the same thing twice.
  if (!slot.taken) return { text: `${slot.needed} needed`, tone: 'open' };
  return { text: `${slot.taken} of ${slot.needed} · ${slot.stillNeeded} more needed`, tone: 'open' };
}

/** The first day the page loads events from, until someone looks further back. */
export function loadWindowStart(today) {
  return isoDate(addMonths(startOfMonth(today), -LOOKBACK_MONTHS));
}

/** The most copies "Repeat weekly" makes in one go. */
export const MAX_REPEAT_WEEKS = 12;

/** How many extra weekly copies the form asked for: 0 up to MAX_REPEAT_WEEKS. */
export function repeatCount(value) {
  return Math.min(MAX_REPEAT_WEEKS, wholeNumber(value, { min: 0, fallback: 0 }));
}

/**
 * The title `weeks` weeks on. A numbered series moves along with it —
 * "Community Group — Week 3" becomes "Week 4" — and anything else stays as is.
 */
export function nextTitle(title, weeks = 1) {
  return String(title ?? '').replace(
    /(\b(?:week|wk|session|part|lesson|night)\s*#?\s*)(\d+)(\s*)$/i,
    (_, label, n, tail) => `${label}${Number(n) + weeks}${tail}`,
  );
}

/**
 * A copy of `event` `weeks` weeks later, ready to save as a new event: same
 * time, host setting and food slots, no sign-ups, and never cancelled.
 */
export function eventCopy(event, weeks = 1) {
  return {
    id: null,
    title: nextTitle(event.title, weeks),
    date: addDays(event.date, 7 * weeks),
    startTime: event.startTime ?? '',
    endTime: event.endTime ?? '',
    location: event.location ?? '',
    description: event.description ?? '',
    needsHost: event.needsHost,
    hostLimit: event.hostLimit,
    allowOtherFood: event.allowOtherFood,
  };
}

/** Food slots to give a copied event: the same ones, as new slots. */
export function slotCopies(slots) {
  return slots.map((slot) => ({ id: '', label: slot.label, needed: slot.needed }));
}

