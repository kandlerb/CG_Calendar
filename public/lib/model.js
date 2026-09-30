// Turning stored rows into what the page shows. Kept free of the DOM and of
// the backend so it can be tested on its own.
//
// A food slot's `needed` is how many people the organizer wants, not a cap:
// a slot never closes, so anyone can still add to it once the number is met.
// `needed` of 0 means no particular number was asked for.

export function slotState(slot, signups) {
  const people = signups.filter((s) => s.kind === 'food' && s.slotId === slot.id);
  const needed = Number.isInteger(slot.needed) ? slot.needed : 0;
  const noMinimum = needed === 0;
  return {
    ...slot,
    needed,
    people,
    taken: people.length,
    noMinimum,
    stillNeeded: noMinimum ? 0 : Math.max(0, needed - people.length),
    met: noMinimum || people.length >= needed,
  };
}

/**
 * Decorates one event with its sign-ups, and with who may change what.
 * `todayKey` ("2026-09-02") marks events before it as past; without it no
 * event is treated as past.
 */
export function shapeEvent(event, { userId = null, isOrganizer = false, todayKey = null } = {}) {
  const past = Boolean(todayKey) && event.date < todayKey;
  const signups = (event.signups ?? []).map((signup) => {
    // "Mine" is about whose name is on it; "canManage" also lets an organizer
    // tidy up after everyone. The page says "You" for the first and shows
    // Edit and Remove for the second. Once an event is over its sign-ups are
    // a record, so only an organizer may still change them.
    const mine = Boolean(userId) && signup.createdBy === userId;
    return { ...signup, isMine: mine, canManage: isOrganizer || (mine && !past) };
  });
  const slots = [...(event.foodSlots ?? [])]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((slot) => slotState(slot, signups));

  const hosts = signups.filter((s) => s.kind === 'host');
  const food = signups.filter((s) => s.kind === 'food');
  return {
    ...event,
    past,
    signups,
    hosts,
    food,
    otherFood: food.filter((s) => !s.slotId),
    foodSlots: slots,
    hostSpotsLeft: Math.max(0, (event.needsHost ? event.hostLimit : 0) - hosts.length),
    mine: signups.filter((s) => s.isMine),
  };
}

export function shapeEvents(events, viewer) {
  return events
    .map((event) => shapeEvent(event, viewer))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime).localeCompare(String(b.startTime)));
}

/** "a host", "a host and 2 food slots", "a host, 2 food slots and drinks". */
function joinWords(parts) {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** How many more people the slots are still asking for, across the event. */
export function foodStillNeeded(event) {
  return event.foodSlots.reduce((sum, slot) => sum + slot.stillNeeded, 0);
}

/**
 * One plain sentence at the top of an event, so someone who opens it knows
 * straight away whether there is anything left for them to do.
 */
export function eventSummary(event) {
  if (event.past) return { done: true, past: true, text: 'This event has passed.' };
  const needs = [];
  if (event.needsHost && event.hostSpotsLeft > 0) {
    needs.push(event.hostSpotsLeft === 1 ? 'a host' : `${event.hostSpotsLeft} more hosts`);
  }
  const short = foodStillNeeded(event);
  if (short > 0) needs.push(plural(short, 'more food sign-up'));

  if (needs.length) return { done: false, text: `Still needed: ${joinWords(needs)}.` };
  return { done: true, text: 'Every slot has the number it asked for. More food is still welcome.' };
}

/** The short status labels shown on a chip or card. */
export function eventBadges(event) {
  const badges = [];
  if (event.past) {
    // Nothing is still needed from an event that is over.
    badges.push({ text: 'Past event', warn: false });
    if (event.mine?.length) badges.push({ text: 'You signed up', warn: false, mine: true });
    return badges;
  }
  // An event whose host is arranged by the organizer has no host badge; the
  // location on the card says where it is.
  if (event.needsHost && event.hostSpotsLeft > 0) {
    badges.push({
      text: event.hostSpotsLeft === 1 ? 'Needs a host' : `Needs ${event.hostSpotsLeft} more hosts`,
      warn: true,
    });
  } else if (event.hosts.length) {
    badges.push({ text: `Hosted by ${event.hosts.map((h) => h.name).join(', ')}`, warn: false });
  }

  const short = foodStillNeeded(event);
  if (short > 0) {
    badges.push({ text: `${plural(short, 'more food sign-up')} needed`, warn: true });
  } else if (event.foodSlots.length) {
    badges.push({ text: 'Food covered', warn: false });
  }

  if (event.mine?.length) {
    badges.push({ text: 'You signed up', warn: false, mine: true });
  }
  return badges;
}

export function groupByDate(events) {
  const byDate = new Map();
  for (const event of events) {
    if (!byDate.has(event.date)) byDate.set(event.date, []);
    byDate.get(event.date).push(event);
  }
  return byDate;
}

export function upcoming(events, todayKey) {
  return events.filter((event) => event.date >= todayKey);
}

/** Events before `todayKey`, most recent first. */
export function past(events, todayKey) {
  return events.filter((event) => event.date < todayKey).reverse();
}

/** The soonest event on or after `todayKey`, or null. Events arrive sorted. */
export function nextEvent(events, todayKey) {
  return upcoming(events, todayKey)[0] ?? null;
}
