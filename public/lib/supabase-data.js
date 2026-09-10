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
      needed: slot.needed,
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

/**
 * "permission denied for table …". Never a rules problem: the grants in
 * schema.sql give every signed-in visitor the privileges the app uses, and a
 * rule that fails says "violates row-level security" instead (the two share
 * SQLSTATE 42501, so the message is what tells them apart). It means the
 * request went out with no session, so the database ran it as "anon" — a
 * signed-out visitor, who may only read. The Supabase client does that
 * quietly: whenever it cannot produce a session it sends the public key in
 * place of the user's token rather than failing.
 */
function isPermissionDenied(error) {
  return /permission denied for (?:table|function|schema)/i.test(error?.message ?? '');
}

/** Supabase errors are readable enough to show, once the noise is trimmed. */
function describe(error) {
  const message = error?.message ?? 'Something went wrong.';
  const match = message.match(/(?:new row|row) violates row-level security/i);
  if (match) return 'You are not allowed to do that.';
  if (isPermissionDenied(error)) return 'Your session ended. Reload the page and try again.';
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

  async function signInAnonymously() {
    const result = await client.auth.signInAnonymously();
    if (result.error) {
      // Two very different causes, and sending someone to check a setting
      // that is already correct wastes their time.
      const disabled =
        result.error.code === 'anonymous_provider_disabled' ||
        /anonymous sign-ins are disabled/i.test(result.error.message ?? '');
      throw new Error(
        disabled
          ? 'Anonymous sign-ins are turned off for this Supabase project, so nobody can ' +
            'sign up. An organizer can enable them under Authentication → Sign In / Providers.'
          : `Could not reach the Supabase project: ${result.error.message}. ` +
            'Check your connection and reload.',
      );
    }
    return result.data.session;
  }

  /**
   * Replaces whatever session the browser holds. A visitor's anonymous
   * identity is disposable — a new one signs up just as well, and only the
   * "You" marker on earlier sign-ups is lost. An organizer's is not: turning
   * them anonymous would quietly take their powers away, so they sign in again.
   */
  async function startFreshSession() {
    if (viewer && !viewer.anonymous) {
      throw new Error('Your organizer sign-in has expired. Sign in again to continue.');
    }
    return refreshViewer(await signInAnonymously());
  }

  /**
   * Every write goes through here. The Supabase client will not say when it
   * has lost the session — it sends the public key instead and the database
   * answers "permission denied" — so check before sending, and if the
   * database still saw no session, replace it and send once more.
   */
  async function write(send) {
    const { data } = await client.auth.getSession();
    if (!data?.session) await startFreshSession();
    const first = await send();
    if (!isPermissionDenied(first?.error)) return unwrap(first);
    await startFreshSession();
    return unwrap(await send());
  }

  return {
    /**
     * Everyone gets a session — organizers by signing in, everyone else
     * anonymously — so the database can tell sign-ups apart and let people
     * edit their own.
     */
    async init() {
      const { data } = await client.auth.getSession();
      return refreshViewer(data.session ?? (await signInAnonymously()));
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

    /**
     * Your own display name. The column grant and the rename policy in
     * schema.sql are what actually confine this to your row.
     */
    async setName(name) {
      const rows = await write(() =>
        client.from('organizers').update({ name }).eq('user_id', viewer.id).select('name'),
      );
      if (!rows?.length) throw new Error('Could not save that name.');
      viewer = { ...viewer, name: rows[0].name };
      return viewer;
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
      return write(() =>
        client.rpc('save_event', {
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
            needed: slot.needed,
          })),
        }),
      );
    },

    async deleteEvent(id) {
      await write(() => client.from('events').delete().eq('id', id));
    },

    async addSignup(signup) {
      await write(() =>
        client.from('signups').insert({
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
      await write(() => client.from('signups').update(patch).eq('id', id));
    },

    async deleteSignup(id) {
      await write(() => client.from('signups').delete().eq('id', id));
    },
  };
}
