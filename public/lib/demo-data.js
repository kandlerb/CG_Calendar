// A stand-in for Supabase that keeps everything in memory, used by demo.html
// so the calendar can be clicked through with no backend at all. It applies
// the same host and slot rules the database applies, so the demo behaves
// like the real thing — it just forgets everything on reload.

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;

function pad(n) {
  return String(n).padStart(2, '0');
}

function relativeDate(offsetDays) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function seed() {
  // Fixed ids, so a link to a demo event still opens it after a reload.
  const dinner = 'demo-event-dinner';
  const cookout = 'demo-event-cookout';
  const mainDish = 'demo-slot-main';
  const sides = 'demo-slot-sides';
  const dessert = 'demo-slot-dessert';
  return {
    events: [
      {
        id: dinner,
        title: 'Community Group — Week 1',
        description: 'Study in Philippians, chapter 2. Kids welcome.',
        location: '',
        date: relativeDate(3),
        startTime: '18:30',
        endTime: '20:30',
        needsHost: true,
        hostLimit: 1,
        allowOtherFood: true,
        foodSlots: [
          { id: mainDish, label: 'Main dish', needed: 2, position: 0 },
          { id: sides, label: 'Side dish', needed: 3, position: 1 },
          { id: dessert, label: 'Dessert', needed: 0, position: 2 },
        ],
        signups: [
          {
            id: 'demo-signup-marisol',
            eventId: dinner,
            slotId: sides,
            kind: 'food',
            name: 'Marisol',
            contact: '',
            item: 'Tres leches cake',
            note: '',
            createdBy: 'someone-else',
          },
        ],
      },
      {
        id: cookout,
        title: 'Fall Cookout',
        description: 'Bring lawn games!',
        location: 'Riverside Park, Shelter B',
        date: relativeDate(12),
        startTime: '17:00',
        endTime: '21:00',
        needsHost: false,
        hostLimit: 1,
        allowOtherFood: true,
        foodSlots: [
          { id: 'demo-slot-burgers', label: 'Burgers and buns', needed: 2, position: 0 },
          { id: 'demo-slot-cookout-sides', label: 'Side dish', needed: 4, position: 1 },
          { id: 'demo-slot-drinks', label: 'Drinks', needed: 2, position: 2 },
        ],
        signups: [],
      },
    ],
  };
}

// The demo's invite code. Shown on the demo page so the join flow can be
// tried out.
export const DEMO_INVITE_CODE = 'demo';

export function createDemoData({ buildFeed = null } = {}) {
  const state = seed();
  const me = 'demo-visitor';
  const member = () => ({
    id: me,
    email: 'you@example.com',
    name: 'Demo member',
    isOrganizer: false,
    isMember: true,
    removed: false,
    feedToken: 'demo-feed-token',
  });
  // The demo opens signed in, so the calendar can be looked around at once.
  // Signing out shows the sign-in screen, where any details will do.
  let viewer = member();
  let inviteCode = DEMO_INVITE_CODE;
  const members = [
    { id: 'demo-organizer', name: 'Demo organizer', email: 'organizer@example.com', joinedAt: '2026-01-05', removed: false, isOrganizer: true },
    { id: 'demo-marisol', name: 'Marisol', email: 'marisol@example.com', joinedAt: '2026-02-11', removed: false, isOrganizer: false },
  ];

  const find = (id) => state.events.find((e) => e.id === id);
  const requireMember = () => {
    if (!viewer?.isMember) throw new Error('Sign in and join the group first.');
  };
  const requireOrganizer = () => {
    if (!viewer?.isOrganizer) throw new Error('Only organizers can do that.');
  };
  const checkCode = (code) => {
    if (String(code ?? '').trim().toLowerCase() !== inviteCode.trim().toLowerCase()) {
      throw new Error("That invite code isn't right. Check it with an organizer and try again.");
    }
  };

  return {
    async init() {
      return viewer;
    },
    viewer: () => viewer,
    authRedirect: () => ({ recovery: false, error: null }),

    async signIn(email, password) {
      // The demo has no real accounts; any details sign in as an organizer so
      // the event editor and member list can be tried out.
      if (!email || !password) throw new Error('Enter any email and password to try organizer mode.');
      viewer = { ...member(), id: me, email, name: 'Demo organizer', isOrganizer: true };
      return viewer;
    },

    async signUp({ email, password, displayName, inviteCode: code }) {
      if (!email || !password) throw new Error('Enter an email and a password.');
      viewer = { ...member(), email, name: displayName || email.split('@')[0], isMember: false };
      try {
        checkCode(code);
      } catch (err) {
        return { viewer, confirmEmail: false, joinError: err.message };
      }
      viewer = { ...viewer, isMember: true };
      return { viewer, confirmEmail: false, joinError: null };
    },

    async joinGroup(code, displayName) {
      checkCode(code);
      viewer = { ...viewer, isMember: true, name: displayName || viewer.name };
      return viewer;
    },

    async requestPasswordReset(email) {
      if (!email) throw new Error('Enter your email.');
    },

    async updatePassword() {
      return viewer;
    },

    async signOut() {
      viewer = null;
      return viewer;
    },

    async setName(name) {
      requireMember();
      viewer = { ...viewer, name };
      return viewer;
    },

    /** A downloadable sample of what a member's subscription would contain. */
    feedLinks() {
      if (!viewer?.isMember || !buildFeed) return null;
      return { sample: () => buildFeed(structuredClone(state.events), me) };
    },

    async resetFeedToken() {
      requireMember();
      viewer = { ...viewer, feedToken: `demo-feed-${Date.now()}` };
      return viewer;
    },

    async getInviteCode() {
      requireOrganizer();
      return inviteCode;
    },

    async setInviteCode(code) {
      requireOrganizer();
      if (String(code ?? '').trim().length < 6 && code !== DEMO_INVITE_CODE) {
        throw new Error('Use at least 6 characters.');
      }
      inviteCode = String(code).trim();
      return inviteCode;
    },

    async listMembers() {
      requireOrganizer();
      return structuredClone(members);
    },

    async setMemberRemoved(id, removed) {
      requireOrganizer();
      const target = members.find((m) => m.id === id);
      if (!target) throw new Error('That person is not a member.');
      if (target.isOrganizer) throw new Error('Organizers cannot be removed here.');
      target.removed = removed;
    },

    async loadEvents() {
      requireMember();
      return structuredClone(state.events);
    },

    async saveEvent(event, slots) {
      requireOrganizer();
      const existing = event.id ? find(event.id) : null;
      const target = existing ?? { id: uid(), signups: [] };
      Object.assign(target, {
        title: event.title,
        description: event.description,
        location: event.location,
        date: event.date,
        startTime: event.startTime,
        endTime: event.endTime,
        needsHost: event.needsHost,
        hostLimit: event.hostLimit,
        allowOtherFood: event.allowOtherFood,
        foodSlots: slots.map((slot, position) => ({
          id: slot.id || uid(),
          label: slot.label,
          needed: slot.needed,
          position,
        })),
      });
      // A removed slot leaves its sign-up behind as "something else".
      const kept = new Set(target.foodSlots.map((s) => s.id));
      for (const signup of target.signups) {
        if (signup.slotId && !kept.has(signup.slotId)) signup.slotId = null;
      }
      if (!existing) state.events.push(target);
      return target.id;
    },

    async deleteEvent(id) {
      requireOrganizer();
      state.events = state.events.filter((e) => e.id !== id);
    },

    async addSignup(signup) {
      requireMember();
      const event = find(signup.eventId);
      if (!event) throw new Error('That event no longer exists.');

      if (signup.kind === 'host') {
        const taken = event.signups.filter((s) => s.kind === 'host').length;
        if (taken >= event.hostLimit) throw new Error('Someone already signed up to host this event.');
      } else if (signup.slotId) {
        // A slot asks for a number of people; it never turns anyone away for
        // being late, so there is nothing to refuse here.
        const slot = event.foodSlots.find((s) => s.id === signup.slotId);
        if (!slot) throw new Error('That food slot is no longer on this event.');
      }

      event.signups.push({
        id: uid(),
        eventId: event.id,
        slotId: signup.slotId || null,
        kind: signup.kind,
        name: signup.name,
        contact: signup.contact ?? '',
        item: signup.item ?? '',
        note: signup.note ?? '',
        address: signup.address ?? '',
        createdBy: me,
      });
    },

    async updateSignup(id, patch) {
      for (const event of state.events) {
        const signup = event.signups.find((s) => s.id === id);
        if (signup) Object.assign(signup, patch);
      }
    },

    async deleteSignup(id) {
      for (const event of state.events) {
        event.signups = event.signups.filter((s) => s.id !== id);
      }
    },
  };
}
