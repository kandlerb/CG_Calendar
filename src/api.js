import { randomUUID } from 'node:crypto';
import { hashToken, newToken } from './auth.js';
import { ValidationError, bool, date, int, str, time } from './validate.js';

const MAX_FOOD_SLOTS = 24;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = (what) => new HttpError(404, `${what} was not found.`);
const forbidden = (message) => new HttpError(403, message);

function normalizeFoodSlots(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ValidationError('Food slots must be a list.');
  if (input.length > MAX_FOOD_SLOTS) {
    throw new ValidationError(`An event can have at most ${MAX_FOOD_SLOTS} food slots.`);
  }
  return input.map((slot) => ({
    id: str(slot.id, 'Food slot id', { max: 64 }) || randomUUID(),
    label: str(slot.label, 'Food slot label', { required: true, max: 60 }),
    capacity: int(slot.capacity, 'Food slot capacity', { min: 1, max: 50, fallback: 1 }),
  }));
}

function buildEvent(body, { existing, organizerName }) {
  const now = new Date().toISOString();
  const slots = normalizeFoodSlots(body.foodSlots ?? existing?.foodSlots);
  const needsHost = bool(body.needsHost, existing ? existing.needsHost : true);
  return {
    id: existing?.id ?? randomUUID(),
    title: str(body.title ?? existing?.title, 'Title', { required: true, max: 120 }),
    description: str(body.description ?? existing?.description, 'Description', { max: 2000 }),
    location: str(body.location ?? existing?.location, 'Location', { max: 200 }),
    date: date(body.date ?? existing?.date, 'Date'),
    startTime: time(body.startTime ?? existing?.startTime, 'Start time'),
    endTime: time(body.endTime ?? existing?.endTime, 'End time'),
    needsHost,
    hostLimit: needsHost
      ? int(body.hostLimit ?? existing?.hostLimit, 'Number of hosts', { min: 1, max: 20, fallback: 1 })
      : 0,
    foodSlots: slots,
    allowOtherFood: bool(body.allowOtherFood, existing ? existing.allowOtherFood : true),
    createdBy: existing?.createdBy ?? organizerName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    updatedBy: organizerName,
  };
}

function checkTimeOrder(event) {
  if (event.startTime && event.endTime && event.endTime < event.startTime) {
    throw new ValidationError('End time must be after start time.');
  }
}

function publicSignup(signup, { canManage }) {
  return {
    id: signup.id,
    eventId: signup.eventId,
    kind: signup.kind,
    name: signup.name,
    contact: signup.contact,
    slotId: signup.slotId,
    item: signup.item,
    note: signup.note,
    createdAt: signup.createdAt,
    canManage,
  };
}

/** Shapes an event plus its sign-ups for the browser. */
function publicEvent(event, signups, { ownerHash, isOrganizer }) {
  const visible = signups.map((s) =>
    publicSignup(s, { canManage: isOrganizer || (Boolean(ownerHash) && s.tokenHash === ownerHash) }),
  );
  const hosts = visible.filter((s) => s.kind === 'host');
  const food = visible.filter((s) => s.kind === 'food');
  return {
    ...event,
    hosts,
    food,
    hostSpotsLeft: Math.max(0, event.hostLimit - hosts.length),
    foodSlots: event.foodSlots.map((slot) => ({
      ...slot,
      taken: food.filter((s) => s.slotId === slot.id).length,
    })),
  };
}

export function createApi({ store, auth, appName }) {
  async function handle(ctx) {
    const { method, segments } = ctx;
    const [head, ...rest] = segments;

    if (head === 'config' && method === 'GET') return config(ctx);
    if (head === 'session') {
      if (method === 'POST') return login(ctx);
      if (method === 'DELETE') return logout(ctx);
    }
    if (head === 'events') return events(ctx, rest);
    if (head === 'signups' && rest.length === 1) return signupById(ctx, rest[0]);

    throw notFound('That endpoint');
  }

  function config(ctx) {
    return {
      status: 200,
      data: {
        appName,
        organizer: ctx.organizer ? ctx.organizer.name : null,
        organizerNames: auth.organizerNames(),
      },
    };
  }

  async function login(ctx) {
    const result = await auth.login({
      name: str(ctx.body?.name, 'Name', { required: true, max: 80 }),
      password: ctx.body?.password,
      clientKey: ctx.ip,
    });
    if (result.error === 'too_many_attempts') {
      throw new HttpError(429, 'Too many sign-in attempts. Try again in a few minutes.');
    }
    if (result.error) {
      throw new HttpError(401, 'That organizer name and password did not match.');
    }
    ctx.setSessionCookie(result.token, result.maxAge);
    return { status: 200, data: { organizer: result.name } };
  }

  async function logout(ctx) {
    await auth.logout(ctx.sessionToken);
    ctx.clearSessionCookie();
    return { status: 200, data: { organizer: null } };
  }

  function requireOrganizer(ctx) {
    if (!ctx.organizer) {
      throw forbidden('Only organizers can create or change events. Sign in first.');
    }
    return ctx.organizer;
  }

  async function events(ctx, rest) {
    const { method } = ctx;

    if (rest.length === 0) {
      if (method === 'GET') return listEvents(ctx);
      if (method === 'POST') return createEvent(ctx);
      throw new HttpError(405, 'Method not allowed.');
    }

    const event = store.findEvent(rest[0]);
    if (!event) throw notFound('That event');

    if (rest.length === 1) {
      if (method === 'GET') {
        return { status: 200, data: { event: decorate(ctx, event) } };
      }
      if (method === 'PATCH' || method === 'PUT') return updateEvent(ctx, event);
      if (method === 'DELETE') return deleteEvent(ctx, event);
      throw new HttpError(405, 'Method not allowed.');
    }

    if (rest.length === 2 && rest[1] === 'signups' && method === 'POST') {
      return createSignup(ctx, event);
    }
    throw notFound('That endpoint');
  }

  function decorate(ctx, event) {
    return publicEvent(event, store.signupsFor(event.id), {
      ownerHash: ctx.ownerHash,
      isOrganizer: Boolean(ctx.organizer),
    });
  }

  function listEvents(ctx) {
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    const list = store.events
      .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
      .map((e) => decorate(ctx, e));
    return { status: 200, data: { events: list } };
  }

  async function createEvent(ctx) {
    const organizer = requireOrganizer(ctx);
    const event = buildEvent(ctx.body ?? {}, { existing: null, organizerName: organizer.name });
    checkTimeOrder(event);
    store.addEvent(event);
    await store.flush();
    return { status: 201, data: { event: decorate(ctx, event) } };
  }

  async function updateEvent(ctx, existing) {
    const organizer = requireOrganizer(ctx);
    const updated = buildEvent(ctx.body ?? {}, { existing, organizerName: organizer.name });
    checkTimeOrder(updated);
    dropSignupsForRemovedSlots(updated);
    Object.assign(existing, updated);
    await store.flush();
    return { status: 200, data: { event: decorate(ctx, existing) } };
  }

  /** Food sign-ups whose slot an organizer deleted fall back to "something else". */
  function dropSignupsForRemovedSlots(event) {
    const ids = new Set(event.foodSlots.map((s) => s.id));
    for (const signup of store.signupsFor(event.id)) {
      if (signup.kind === 'food' && signup.slotId && !ids.has(signup.slotId)) {
        signup.slotId = null;
      }
    }
  }

  async function deleteEvent(ctx, event) {
    requireOrganizer(ctx);
    store.removeEvent(event.id);
    await store.flush();
    return { status: 200, data: { deleted: event.id } };
  }

  async function createSignup(ctx, event) {
    const body = ctx.body ?? {};
    const kind = str(body.kind, 'Sign-up kind', { required: true, max: 10 });
    if (kind !== 'host' && kind !== 'food') {
      throw new ValidationError('Sign-up kind must be "host" or "food".');
    }
    const existing = store.signupsFor(event.id);
    const name = str(body.name, 'Your name', { required: true, max: 80 });
    let slotId = null;
    let item = '';

    if (kind === 'host') {
      if (!event.needsHost) throw new ValidationError('This event does not need a host.');
      if (existing.filter((s) => s.kind === 'host').length >= event.hostLimit) {
        throw new HttpError(409, 'Someone already signed up to host this event.');
      }
    } else {
      slotId = str(body.slotId, 'Food slot', { max: 64 }) || null;
      if (slotId) {
        const slot = event.foodSlots.find((s) => s.id === slotId);
        if (!slot) throw new ValidationError('That food slot is no longer on this event.');
        const taken = existing.filter((s) => s.kind === 'food' && s.slotId === slotId).length;
        if (taken >= slot.capacity) {
          throw new HttpError(409, `"${slot.label}" is already covered.`);
        }
      } else if (!event.allowOtherFood) {
        throw new ValidationError('Please choose one of the listed food slots.');
      }
      item = str(body.item, 'What you are bringing', { required: true, max: 140 });
    }

    // The browser keeps one participant key so people can edit or cancel
    // their own sign-ups later without creating an account.
    const issuedKey = ctx.ownerHash ? null : newToken();
    if (issuedKey) ctx.ownerHash = hashToken(issuedKey);
    const signup = {
      id: randomUUID(),
      eventId: event.id,
      kind,
      name,
      contact: str(body.contact, 'Contact', { max: 120 }),
      slotId,
      item,
      note: str(body.note, 'Note', { max: 280 }),
      tokenHash: ctx.ownerHash,
      createdAt: new Date().toISOString(),
    };
    store.addSignup(signup);
    await store.flush();
    return {
      status: 201,
      data: {
        participantKey: issuedKey,
        signup: publicSignup(signup, { canManage: true }),
        event: decorate(ctx, event),
      },
    };
  }

  async function signupById(ctx, id) {
    const signup = store.findSignup(id);
    if (!signup) throw notFound('That sign-up');
    const owns = Boolean(ctx.ownerHash) && signup.tokenHash === ctx.ownerHash;
    if (!owns && !ctx.organizer) {
      throw forbidden('Only the person who signed up (or an organizer) can change this.');
    }
    const event = store.findEvent(signup.eventId);

    if (ctx.method === 'DELETE') {
      store.removeSignup(id);
      await store.flush();
      return { status: 200, data: { deleted: id, event: event ? decorate(ctx, event) : null } };
    }

    if (ctx.method === 'PATCH') {
      const body = ctx.body ?? {};
      if (body.name !== undefined) signup.name = str(body.name, 'Your name', { required: true, max: 80 });
      if (body.contact !== undefined) signup.contact = str(body.contact, 'Contact', { max: 120 });
      if (body.note !== undefined) signup.note = str(body.note, 'Note', { max: 280 });
      if (signup.kind === 'food' && body.item !== undefined) {
        signup.item = str(body.item, 'What you are bringing', { required: true, max: 140 });
      }
      await store.flush();
      return { status: 200, data: { event: event ? decorate(ctx, event) : null } };
    }

    throw new HttpError(405, 'Method not allowed.');
  }

  return { handle };
}

export { HttpError };
