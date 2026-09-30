// Everything that talks to Supabase. The rest of the app only sees the small
// interface at the bottom of this file, which the demo data source also
// implements.
//
// Nothing here is a security boundary: the rules live in the database (see
// supabase/schema.sql). A browser that skips this file entirely still cannot
// read the calendar without joining, or create an event without being an
// organizer.

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
      address: signup.address ?? '',
      createdBy: signup.created_by,
    })),
  };
}

/**
 * "permission denied for table …". Never a rules problem: the grants in
 * schema.sql give every signed-in member the privileges the app uses, and a
 * rule that fails says "violates row-level security" instead (the two share
 * SQLSTATE 42501, so the message is what tells them apart). It means the
 * request went out with no session, so the database ran it as a signed-out
 * visitor. The Supabase client does that quietly: whenever it cannot produce
 * a session it sends the public key in place of the user's token.
 */
function isPermissionDenied(error) {
  return /permission denied for (?:table|function|schema)/i.test(error?.message ?? '');
}

/** Raised when a write needs a session and there is none; the page shows sign-in. */
export function signedOutError() {
  const error = new Error('You have been signed out. Sign in again to continue.');
  error.signedOut = true;
  return error;
}

/** Supabase errors are readable enough to show, once the noise is trimmed. */
function describe(error) {
  const message = error?.message ?? 'Something went wrong.';
  if (/(?:new row|row) violates row-level security/i.test(message)) return 'You are not allowed to do that.';
  return message
    .replace(/^.*\bERROR:\s*/i, '')
    .replace(/\s*\(SQLSTATE.*\)$/i, '')
    .trim();
}

function unwrap({ data, error }) {
  if (error) throw new Error(describe(error));
  return data;
}

/** What an auth error means for the person looking at the form. */
function describeAuth(error, fallback) {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) {
    return 'That email and password did not match.';
  }
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) {
    return 'Confirm your email first — open the link in the message we sent you, then sign in.';
  }
  if (code === 'user_already_exists' || /already registered/i.test(message)) {
    return 'There is already an account with that email. Sign in instead, or reset the password.';
  }
  if (code === 'weak_password' || /password should be/i.test(message)) {
    return message || 'Choose a longer password.';
  }
  if (code === 'over_email_send_rate_limit' || /rate limit/i.test(message)) {
    return 'Too many emails have been sent just now. Wait a few minutes and try again.';
  }
  if (/invalid email|unable to validate email/i.test(message)) return 'That email address does not look right.';
  return message || fallback;
}

/**
 * What the page was opened with after following a link in a Supabase email:
 * a password reset, or an expired link. Read from the address before the
 * Supabase client clears it.
 */
export function readAuthRedirect(hash) {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  const errorText = params.get('error_description');
  return {
    recovery: params.get('type') === 'recovery',
    error: errorText
      ? /expired|invalid/i.test(errorText)
        ? 'That link has expired or was already used. Request a new one.'
        : errorText
      : null,
  };
}

/**
 * @param client   a supabase-js client
 * @param options  siteUrl: where email links should return to;
 *                 feedBase: the calendar-feed function's URL;
 *                 initialHash: location.hash as the page opened.
 */
export function createSupabaseData(client, { siteUrl = '', feedBase = '', initialHash = '' } = {}) {
  let viewer = null;
  const redirect = readAuthRedirect(initialHash);

  // A reset link signs the person in and marks the session as a recovery;
  // the page must ask for a new password before anything else.
  client.auth.onAuthStateChange?.((event) => {
    if (event === 'PASSWORD_RECOVERY') redirect.recovery = true;
  });

  async function refreshViewer(session) {
    if (!session?.user) {
      viewer = null;
      return viewer;
    }
    const { data, error } = await client.rpc('my_membership');
    if (error && isPermissionDenied(error)) {
      viewer = null;
      return viewer;
    }
    const membership = error ? null : data;
    const user = session.user;
    viewer = {
      id: user.id,
      email: user.email ?? '',
      name: membership?.display_name || user.user_metadata?.display_name || '',
      isOrganizer: Boolean(membership?.is_organizer),
      isMember: Boolean(membership) && !membership.removed,
      removed: Boolean(membership?.removed),
      feedToken: membership?.feed_token ?? null,
    };
    return viewer;
  }

  /**
   * Every write goes through here. The Supabase client will not say when it
   * has lost the session — it sends the public key instead and the database
   * answers "permission denied" — so check before sending, and if the
   * database still saw no session, refresh it and send once more.
   */
  async function write(send) {
    const { data } = await client.auth.getSession();
    if (!data?.session) {
      viewer = null;
      throw signedOutError();
    }
    const first = await send();
    if (!isPermissionDenied(first?.error)) return unwrap(first);
    const refreshed = await client.auth.refreshSession?.();
    if (!refreshed?.data?.session) {
      viewer = null;
      throw signedOutError();
    }
    const second = await send();
    if (isPermissionDenied(second?.error)) throw signedOutError();
    return unwrap(second);
  }

  async function join(code, displayName) {
    const result = await write(() =>
      client.rpc('join_group', { p_code: code ?? '', p_display_name: displayName ?? '' }),
    );
    if (result !== 'joined') {
      throw new Error("That invite code isn't right. Check it with an organizer and try again.");
    }
    const { data } = await client.auth.getSession();
    return refreshViewer(data.session);
  }

  return {
    async init() {
      const { data } = await client.auth.getSession();
      let session = data?.session ?? null;
      // Anonymous sessions belong to the calendar's old no-account sign-ups.
      // They can see nothing now, so let them go and show the sign-in screen.
      if (session?.user?.is_anonymous) {
        await client.auth.signOut();
        session = null;
      }
      return refreshViewer(session);
    },

    viewer: () => viewer,

    /** { recovery, error } from an email link the page was opened with. */
    authRedirect: () => ({ ...redirect }),

    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(describeAuth(error, 'Could not sign in.'));
      return refreshViewer(data.session);
    },

    /**
     * Creates the account and, when Supabase signs the person straight in,
     * joins the group with their code. If the project asks for email
     * confirmation there is no session yet: they confirm, sign in, and are
     * asked for the code then.
     */
    async signUp({ email, password, displayName, inviteCode }) {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName }, emailRedirectTo: siteUrl || undefined },
      });
      if (error) throw new Error(describeAuth(error, 'Could not create the account.'));
      if (!data.session) return { viewer: null, confirmEmail: true, joinError: null };
      await refreshViewer(data.session);
      try {
        return { viewer: await join(inviteCode, displayName), confirmEmail: false, joinError: null };
      } catch (err) {
        return { viewer, confirmEmail: false, joinError: err.message };
      }
    },

    joinGroup: (code, displayName) => join(code, displayName),

    async requestPasswordReset(email) {
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: siteUrl || undefined,
      });
      if (error) throw new Error(describeAuth(error, 'Could not send the reset email.'));
    },

    async updatePassword(password) {
      const { data, error } = await client.auth.updateUser({ password });
      if (error) throw new Error(describeAuth(error, 'Could not change the password.'));
      redirect.recovery = false;
      const session = (await client.auth.getSession()).data?.session;
      return refreshViewer(session ?? (data?.user ? { user: data.user } : null));
    },

    async signOut() {
      await client.auth.signOut();
      viewer = null;
      return viewer;
    },

    /** Your own display name; set_display_name() confines it to your row. */
    async setName(name) {
      const saved = await write(() => client.rpc('set_display_name', { p_name: name }));
      viewer = { ...viewer, name: saved };
      return viewer;
    },

    /** Links to this member's feed, or null before they have one. */
    feedLinks() {
      if (!viewer?.feedToken || !feedBase) return null;
      const https = `${feedBase}?token=${viewer.feedToken}`;
      return { https, webcal: https.replace(/^https?:/, 'webcal:') };
    },

    async resetFeedToken() {
      const token = await write(() => client.rpc('reset_feed_token'));
      viewer = { ...viewer, feedToken: token };
      return viewer;
    },

    // --- organizers --------------------------------------------------------

    async getInviteCode() {
      const row = unwrap(await client.from('group_settings').select('invite_code').maybeSingle());
      return row?.invite_code ?? '';
    },

    async setInviteCode(code) {
      const rows = await write(() =>
        client.from('group_settings').update({ invite_code: code }).eq('id', true).select('invite_code'),
      );
      if (!rows?.length) throw new Error('Only organizers can change the invite code.');
      return rows[0].invite_code;
    },

    async listMembers() {
      const rows = await write(() => client.rpc('list_members'));
      return (rows ?? []).map((row) => ({
        id: row.user_id,
        name: row.display_name,
        email: row.email ?? '',
        joinedAt: row.joined_at,
        removed: row.removed,
        isOrganizer: row.is_organizer,
      }));
    },

    async setMemberRemoved(userId, removed) {
      await write(() => client.rpc('set_member_removed', { p_user_id: userId, p_removed: removed }));
    },

    // --- the calendar ------------------------------------------------------

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
          address: signup.address ?? '',
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
