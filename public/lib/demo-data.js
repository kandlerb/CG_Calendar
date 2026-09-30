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
  const lastWeek = 'demo-event-last-week';
  return {
    events: [
      {
        id: dinner,
        title: 'Community Group — Week 1',
        description: 'Study in Philippians, chapter 2.',
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
            contact: 'marisol@example.com',
            item: 'Elote salad',
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
      // Already happened, so the demo shows how a past event reads.
      {
        id: lastWeek,
        title: 'Community Group — Week 0',
        description: 'Kickoff night.',
        location: '',
        date: relativeDate(-7),
        startTime: '18:30',
        endTime: '20:30',
        needsHost: true,
        hostLimit: 1,
        allowOtherFood: true,
        foodSlots: [{ id: 'demo-slot-week0-main', label: 'Main dish', needed: 1, position: 0 }],
        signups: [
          {
            id: 'demo-signup-week0-host',
            eventId: lastWeek,
            slotId: null,
            kind: 'host',
            name: 'The Parkers',
            contact: '',
            item: '',
            note: '',
            createdBy: 'someone-else',
          },
          {
            id: 'demo-signup-week0-main',
            eventId: lastWeek,
            slotId: 'demo-slot-week0-main',
            kind: 'food',
            name: 'Dev',
            contact: '',
            item: 'Pulled pork',
            note: '',
            createdBy: 'someone-else',
          },
        ],
      },
    ],
  };
}

export function createDemoData() {
  const state = seed();
  const me = 'demo-visitor';
  let viewer = { id: me, isOrganizer: false, name: '', anonymous: true, email: '' };

  const find = (id) => state.events.find((e) => e.id === id);

  return {
    async init() {
      return viewer;
    },
    viewer: () => viewer,

    async signIn(email, password) {
      // The demo has no accounts; any details unlock organizer mode so the
      // event editor can be tried out.
      if (!email || !password) throw new Error('Enter anything to try organizer mode.');
      viewer = { ...viewer, isOrganizer: true, name: 'Demo organizer', email, anonymous: false };
      return viewer;
    },

    async signOut() {
      viewer = { id: me, isOrganizer: false, name: '', anonymous: true, email: '' };
      return viewer;
    },

    async setName(name) {
      if (!viewer.isOrganizer) throw new Error('Only organizers have a display name.');
      viewer = { ...viewer, name };
      return viewer;
    },

    async loadEvents({ since = null } = {}) {
      // Like the database, only organizers and the person who signed up see
      // a sign-up's contact details.
      const events = structuredClone(state.events.filter((e) => !since || e.date >= since));
      for (const event of events) {
        for (const signup of event.signups) {
          if (!viewer.isOrganizer && signup.createdBy !== viewer.id) signup.contact = '';
        }
      }
      return events;
    },

    async saveEvent(event, slots) {
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
      state.events = state.events.filter((e) => e.id !== id);
    },

    async addSignup(signup) {
      const event = find(signup.eventId);
      if (!event) throw new Error('That event no longer exists.');

      if (signup.kind === 'host') {
        if (!event.needsHost) throw new Error('This event does not need a host.');
        const taken = event.signups.filter((s) => s.kind === 'host').length;
        if (taken >= event.hostLimit) throw new Error('Someone already signed up to host this event.');
      } else if (signup.slotId) {
        // A slot asks for a number of people; it never turns anyone away for
        // being late, so there is nothing to refuse here.
        const slot = event.foodSlots.find((s) => s.id === signup.slotId);
        if (!slot) throw new Error('That food slot is no longer on this event.');
      } else if (!event.allowOtherFood) {
        throw new Error('Please choose one of the listed food slots.');
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
        createdBy: me,
      });
    },

    async updateSignup(id, patch) {
      // Only what a sign-up says can change, as in the database.
      const allowed = ['name', 'contact', 'item', 'note'];
      for (const event of state.events) {
        const signup = event.signups.find((s) => s.id === id);
        if (!signup) continue;
        if (!viewer.isOrganizer && signup.createdBy !== me) throw new Error('You are not allowed to do that.');
        for (const key of allowed) if (key in patch) signup[key] = patch[key];
      }
    },

    async deleteSignup(id) {
      for (const event of state.events) {
        event.signups = event.signups.filter((s) => s.id !== id);
      }
    },
  };
}
