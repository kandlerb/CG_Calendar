// Everything that talks to Supabase. The rest of the app only sees the small
// interface at the bottom of this file, which the demo data source also
// implements.
//
// Nothing here is a security boundary: the rules live in the database (see
// supabase/schema.sql). A browser that skips this file entirely still cannot
// create an event unless its user is an organizer.

import { normalizeTime } from './dates.js';

function toEvent(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    location: row.location ?? '',
    date: row.event_date,
    startTime: normalizeTime(row.start_time),
    endTime: normalizeTime(row.end_time),
    needsHost: row.needs_host,
    hostLimit: row.host_limit,
    allowOtherFood: row.allow_other_food,
    foodSlots: (row.food_slots ?? []).map((slot) => ({
      id: slot.id,
      label: slot.label,
      capacity: slot.capacity,
      position: slot.position ?? 0,
    })),
    signups: (row.signups ?? []).map((signup) => ({
      id: signup.id,
      eventId: signup.event_id,
      slotId: signup.slot_id,
      kind: signup.kind,
      name: signup.name,
      contact: signup.contact ?? '',
      item: signup.item ?? '',
      note: signup.note ?? '',
      createdBy: signup.created_by,
    })),
  };
}

/** Supabase errors are readable enough to show, once the noise is trimmed. */
function describe(error) {
  const message = error?.message ?? 'Something went wrong.';
  const match = message.match(/(?:new row|row) violates row-level security/i);
  if (match) return 'You are not allowed to do that.';
  return message
    .replace(/^.*\bERROR:\s*/i, '')
    .replace(/\s*\(SQLSTATE.*\)$/i, '')
    .trim();
}

function unwrap({ data, error }) {
  if (error) throw new Error(describe(error));
  return data;
}

export function createSupabaseData(client) {
  let viewer = null;

  async function refreshViewer(session) {
    if (!session?.user) {
      viewer = null;
      return viewer;
    }
    const { data } = await client
      .from('organizers')
      .select('name')
      .eq('user_id', session.user.id)
      .maybeSingle();
    viewer = {
      id: session.user.id,
      email: session.user.email ?? '',
      isOrganizer: Boolean(data),
      name: data?.name ?? '',
      anonymous: session.user.is_anonymous ?? !session.user.email,
    };
    return viewer;
  }

  return {
    /**
     * Everyone gets a session — organizers by signing in, everyone else
     * anonymously — so the database can tell sign-ups apart and let people
     * edit their own.
     */
    async init() {
      const { data } = await client.auth.getSession();
      let session = data.session;
      if (!session) {
        const result = await client.auth.signInAnonymously();
        if (result.error) {
          throw new Error(
            `Could not start a session: ${result.error.message}. ` +
              'Check that anonymous sign-ins are enabled for this Supabase project.',
          );
        }
        session = result.data.session;
      }
      return refreshViewer(session);
    },

    viewer: () => viewer,

    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error('That email and password did not match.');
      const next = await refreshViewer(data.session);
      if (!next.isOrganizer) {
        await client.auth.signOut();
        await this.init();
        throw new Error('That account is signed in, but it is not an organizer on this calendar.');
      }
      return next;
    },

    async signOut() {
      await client.auth.signOut();
      return this.init();
    },

    async loadEvents() {
      const rows = unwrap(
        await client
          .from('events')
          .select('*, food_slots(*), signups(*)')
          .order('event_date', { ascending: true }),
      );
      return rows.map(toEvent);
    },

    async saveEvent(event, slots) {
      return unwrap(
        await client.rpc('save_event', {
          p_event: {
            id: event.id ?? null,
            title: event.title,
            description: event.description,
            location: event.location,
            event_date: event.date,
            start_time: event.startTime || null,
            end_time: event.endTime || null,
            needs_host: event.needsHost,
            host_limit: event.hostLimit,
            allow_other_food: event.allowOtherFood,
          },
          p_slots: slots.map((slot) => ({
            id: slot.id || null,
            label: slot.label,
            capacity: slot.capacity,
          })),
        }),
      );
    },

    async deleteEvent(id) {
      unwrap(await client.from('events').delete().eq('id', id));
    },

    async addSignup(signup) {
      unwrap(
        await client.from('signups').insert({
          event_id: signup.eventId,
          slot_id: signup.slotId || null,
          kind: signup.kind,
          name: signup.name,
          contact: signup.contact ?? '',
          item: signup.item ?? '',
          note: signup.note ?? '',
        }),
      );
    },

    async updateSignup(id, patch) {
      unwrap(await client.from('signups').update(patch).eq('id', id));
    },

    async deleteSignup(id) {
      unwrap(await client.from('signups').delete().eq('id', id));
    },
  };
}
