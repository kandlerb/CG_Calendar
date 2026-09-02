// Turning stored rows into what the page shows. Kept free of the DOM and of
// the backend so it can be tested on its own.
//
// A food slot's capacity of 0 means no limit. Whether a sign-up is really
// allowed is decided by the database; these helpers only decide what to draw.

export function slotState(slot, signups) {
  const people = signups.filter((s) => s.kind === 'food' && s.slotId === slot.id);
  const unlimited = slot.capacity === 0;
  return {
    ...slot,
    people,
    taken: people.length,
    unlimited,
    hasRoom: unlimited || people.length < slot.capacity,
    spotsLeft: unlimited ? Infinity : Math.max(0, slot.capacity - people.length),
  };
}

/** Decorates one event with its sign-ups, and with who may change what. */
export function shapeEvent(event, { userId = null, isOrganizer = false } = {}) {
  const signups = (event.signups ?? []).map((signup) => {
    // "Mine" is about whose name is on it; "canManage" also lets an organizer
    // tidy up after everyone. The page says "You" for the first and shows a
    // Cancel button for the second.
    const mine = Boolean(userId) && signup.createdBy === userId;
    return { ...signup, isMine: mine, canManage: isOrganizer || mine };
  });
  const slots = [...(event.foodSlots ?? [])]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((slot) => slotState(slot, signups));

  const hosts = signups.filter((s) => s.kind === 'host');
  const food = signups.filter((s) => s.kind === 'food');
  return {
    ...event,
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

/** How many people could still claim a slot that has a limit. */
export function openFoodSpots(event) {
  return event.foodSlots.reduce((sum, slot) => sum + (slot.unlimited ? 0 : slot.spotsLeft), 0);
}

/**
 * One plain sentence at the top of an event, so someone who opens it knows
 * straight away whether there is anything left for them to do.
 */
export function eventSummary(event) {
  const needs = [];
  if (event.needsHost && event.hostSpotsLeft > 0) {
    needs.push(event.hostSpotsLeft === 1 ? 'a host' : `${event.hostSpotsLeft} more hosts`);
  }
  const openSlots = event.foodSlots.filter((slot) => !slot.unlimited && slot.hasRoom).length;
  if (openSlots > 0) needs.push(plural(openSlots, 'food slot'));

  if (needs.length) return { done: false, text: `Still needed: ${joinWords(needs)}.` };
  if (event.foodSlots.some((slot) => slot.unlimited) || event.allowOtherFood) {
    return { done: true, text: 'Everything is covered — extra food is still welcome.' };
  }
  return { done: true, text: 'Everything is covered for this event.' };
}

/** The short status labels shown on a chip or card. */
export function eventBadges(event) {
  const badges = [];
  if (event.needsHost) {
    if (event.hostSpotsLeft > 0) {
      badges.push({
        text: event.hostSpotsLeft === 1 ? 'Needs a host' : `Needs ${event.hostSpotsLeft} more hosts`,
        warn: true,
      });
    } else {
      badges.push({ text: `Hosted by ${event.hosts.map((h) => h.name).join(', ')}`, warn: false });
    }
  }

  const openSpots = openFoodSpots(event);
  if (openSpots > 0) {
    badges.push({ text: `${plural(openSpots, 'food slot')} open`, warn: true });
  } else if (event.foodSlots.some((slot) => slot.unlimited)) {
    badges.push({ text: 'More food welcome', warn: true });
  } else if (event.foodSlots.length) {
    badges.push({ text: 'Food covered', warn: false });
  }

  if (event.food.length) {
    const people = event.food.length === 1 ? '1 person' : `${event.food.length} people`;
    badges.push({ text: `${people} bringing food`, warn: false });
  }
  if (event.mine?.length) {
    badges.push({ text: "You're signed up", warn: false, mine: true });
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

/** The soonest event on or after `todayKey`, or null. Events arrive sorted. */
export function nextEvent(events, todayKey) {
  return upcoming(events, todayKey)[0] ?? null;
}
