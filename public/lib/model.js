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
  };
}

/** Decorates one event with its sign-ups, and with who may change what. */
export function shapeEvent(event, { userId = null, isOrganizer = false } = {}) {
  const signups = (event.signups ?? []).map((signup) => ({
    ...signup,
    canManage: isOrganizer || (Boolean(userId) && signup.createdBy === userId),
  }));
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
  };
}

export function shapeEvents(events, viewer) {
  return events
    .map((event) => shapeEvent(event, viewer))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime).localeCompare(String(b.startTime)));
}

/** The short status labels shown on a chip or card. */
export function eventBadges(event) {
  const badges = [];
  if (event.needsHost) {
    if (event.hostSpotsLeft > 0) {
      badges.push({
        text: event.hostLimit > 1 ? `Needs ${event.hostSpotsLeft} more host(s)` : 'Needs a host',
        warn: true,
      });
    } else {
      badges.push({ text: `Host: ${event.hosts.map((h) => h.name).join(', ')}`, warn: false });
    }
  }

  const openSpots = event.foodSlots.reduce(
    (sum, slot) => sum + (slot.unlimited ? 0 : Math.max(0, slot.capacity - slot.taken)),
    0,
  );
  if (openSpots > 0) {
    badges.push({ text: `${openSpots} food slot${openSpots === 1 ? '' : 's'} open`, warn: true });
  } else if (event.foodSlots.some((slot) => slot.unlimited)) {
    badges.push({ text: 'More food welcome', warn: true });
  } else if (event.foodSlots.length) {
    badges.push({ text: 'Food covered', warn: false });
  }

  if (event.food.length) {
    badges.push({ text: `${event.food.length} bringing food`, warn: false });
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
