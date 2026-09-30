// The calendar page. All storage goes through the `data` object handed to
// startApp(), which is either Supabase (index.html) or an in-memory stand-in
// (demo.html).

import {
  addMonths,
  formatLongDate,
  formatShortDate,
  formatTime,
  formatTimeRange,
  isoDate,
  monthGrid,
  parseISODate,
  startOfMonth,
} from './lib/dates.js';
import {
  eventBadges,
  eventSummary,
  foodStillNeeded,
  groupByDate,
  nextEvent,
  past,
  shapeEvents,
  upcoming,
} from './lib/model.js';
import { LIMITS, cleanSlots, eventFromForm, loadWindowStart, signupFromForm, slotStatus } from './lib/forms.js';

const WEEKDAYS = [
  { short: 'Sun', full: 'Sunday' },
  { short: 'Mon', full: 'Monday' },
  { short: 'Tue', full: 'Tuesday' },
  { short: 'Wed', full: 'Wednesday' },
  { short: 'Thu', full: 'Thursday' },
  { short: 'Fri', full: 'Friday' },
  { short: 'Sat', full: 'Saturday' },
];
const FOOD_PRESETS = ['Main dish', 'Side dish', 'Salad', 'Bread', 'Dessert', 'Drinks', 'Paper goods'];

// A day cell only has room for so much before the row grows unreadable.
const CHIPS_PER_DAY = 3;

const NAME_KEY = 'cg_name';
const CONTACT_KEY = 'cg_contact';
const VIEW_KEY = 'cg_view';
const INTRO_KEY = 'cg_intro_dismissed';

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const remembered = {
  read(key, fallback = '') {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      if (value !== undefined && value !== null) localStorage.setItem(key, value);
    } catch {
      /* private browsing — the field just will not be pre-filled next time */
    }
  },
};

export function startApp(data, { onError } = {}) {
  const storedView = remembered.read(VIEW_KEY);
  const state = {
    viewer: null,
    events: [],
    loading: true,
    // Someone who has picked a view keeps it. Everyone else gets the one that
    // fits their screen — a month grid is unusable on a phone.
    view: storedView === 'month' || storedView === 'list' ? storedView : window.innerWidth < 720 ? 'list' : 'month',
    viewChosen: Boolean(storedView),
    cursor: startOfMonth(new Date()),
    // Old events are only fetched once someone steps back far enough to see
    // them; see loadEarlierIfNeeded().
    since: loadWindowStart(new Date()),
    loadedAt: 0,
    expandedDay: null,
    showPast: false,
    modal: null,
  };

  const el = {
    loading: document.getElementById('loading'),
    intro: document.getElementById('intro'),
    viewNote: document.getElementById('view-note'),
    toolbar: document.querySelector('.toolbar'),
    calendar: document.getElementById('calendar'),
    agenda: document.getElementById('agenda'),
    period: document.getElementById('period'),
    periodNav: document.querySelector('.period-nav'),
    modalRoot: document.getElementById('modal-root'),
    toast: document.getElementById('toast'),
    who: document.getElementById('who'),
    signIn: document.getElementById('signin-btn'),
    signOut: document.getElementById('signout-btn'),
    newEvent: document.getElementById('new-event-btn'),
    help: document.getElementById('help-btn'),
    divider: document.querySelector('.topbar-divider'),
  };

  let toastTimer;
  function toast(message, tone = 'ok') {
    el.toast.textContent = message;
    el.toast.className = `toast ${tone}`;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, tone === 'error' ? 6000 : 3600);
  }

  // --- data ----------------------------------------------------------------

  async function reload() {
    const raw = await data.loadEvents({ since: state.since });
    state.loadedAt = Date.now();
    state.viewer = data.viewer();
    state.events = shapeEvents(raw, {
      userId: state.viewer?.id ?? null,
      isOrganizer: Boolean(state.viewer?.isOrganizer),
      todayKey: isoDate(new Date()),
    });
  }

  const eventById = (id) => state.events.find((e) => e.id === id);

  async function refresh({ keepModal = true } = {}) {
    await reload();
    render();
    if (keepModal) renderModal();
  }

  /** Stepping back past what has been loaded fetches the older events. */
  async function loadEarlierIfNeeded() {
    const monthKey = isoDate(state.cursor);
    if (!state.since || monthKey >= state.since) return;
    state.since = monthKey;
    await reload();
    render();
  }

  /**
   * Finds an event a link points at. A link to an old event may be outside
   * what was loaded, so look at everything once before giving up.
   */
  async function findLinkedEvent(id) {
    if (eventById(id) || !state.since) return eventById(id) ?? null;
    state.since = null;
    await reload();
    return eventById(id) ?? null;
  }

  // --- the "how this works" panel ------------------------------------------

  function renderIntro() {
    if (!el.intro) return;
    const organizer = Boolean(state.viewer?.isOrganizer);
    el.intro.innerHTML = `
      <div class="intro-head">
        <h2>How to use this calendar</h2>
        <button type="button" class="close" data-dismiss-intro aria-label="Hide these instructions">&times;</button>
      </div>
      <ol class="intro-steps">
        <li><strong>Find the event.</strong> Use <strong>Month</strong> for the grid or <strong>Upcoming</strong>
          for a list.</li>
        <li><strong>Open the event.</strong> It shows the time, the location, the host, and which food slots
          are unfilled.</li>
        <li><strong>Sign up.</strong> Take the host slot if the event still needs one, or pick a food
          slot and enter what you are bringing. No account is required.</li>
      </ol>
      <p class="hint">
        To change or remove a sign-up, reopen the event. Sign-ups are identified by this browser, not by an
        account, so use the same browser each time.
      </p>
      ${
        organizer
          ? `<p class="hint organizer-hint"><strong>Organizer controls.</strong> <strong>+ New event</strong>
             creates an event. <strong>Edit event</strong> changes its date, host count and food slots.</p>`
          : ''
      }`;
    el.intro.hidden = remembered.read(INTRO_KEY) === '1';
    el.help?.setAttribute('aria-expanded', String(!el.intro.hidden));
  }

  function toggleIntro() {
    if (!el.intro) return;
    // The calendar may have failed to load before renderIntro() ever ran, and
    // an empty green box is worse than no box.
    if (!el.intro.innerHTML.trim()) {
      const wasHidden = el.intro.hidden;
      renderIntro();
      el.intro.hidden = wasHidden;
    }
    const showing = !el.intro.hidden;
    el.intro.hidden = showing;
    remembered.write(INTRO_KEY, showing ? '1' : '0');
    if (!showing) el.intro.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.help?.setAttribute('aria-expanded', String(!showing));
  }

  // --- chrome --------------------------------------------------------------

  function renderAuth() {
    const organizer = Boolean(state.viewer?.isOrganizer);
    el.who.hidden = !organizer;
    el.who.textContent = organizer ? `Organizer: ${state.viewer.name || state.viewer.email}` : '';
    el.who.title = organizer ? 'Change how your name appears here' : '';
    el.signOut.hidden = !organizer;
    el.newEvent.hidden = !organizer;
    el.signIn.hidden = organizer;
    if (el.divider) el.divider.hidden = !organizer;
  }

  function render() {
    renderAuth();
    if (el.loading) el.loading.hidden = !state.loading;
    if (el.toolbar) el.toolbar.hidden = state.loading;
    if (state.loading) {
      el.calendar.hidden = true;
      el.agenda.hidden = true;
      if (el.viewNote) el.viewNote.hidden = true;
      return;
    }

    el.period.textContent = state.cursor.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    const monthView = state.view === 'month';
    el.calendar.hidden = !monthView;
    el.agenda.hidden = monthView;
    el.periodNav.hidden = !monthView;
    for (const button of document.querySelectorAll('.btn.toggle')) {
      button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
    }
    if (monthView) renderMonth();
    else renderAgenda();
    renderViewNote();
  }

  /**
   * The line above the calendar. An empty month used to be a wall of blank
   * squares with nothing to say why, which reads as a broken page.
   */
  function renderViewNote() {
    if (!el.viewNote) return;
    const todayKey = isoDate(new Date());
    const soonest = nextEvent(state.events, todayKey);
    const organizerHint = state.viewer?.isOrganizer
      ? ' Use <strong>+ New event</strong> to add one.'
      : ' Only an organizer can add them.';

    if (!state.events.length) {
      el.viewNote.className = 'view-note';
      el.viewNote.innerHTML = `No events on the calendar.${organizerHint}`;
      el.viewNote.hidden = false;
      return;
    }

    if (state.view !== 'month') {
      el.viewNote.hidden = true;
      return;
    }

    const monthKey = `${state.cursor.getFullYear()}-${String(state.cursor.getMonth() + 1).padStart(2, '0')}`;
    if (state.events.some((event) => event.date.startsWith(monthKey))) {
      el.viewNote.hidden = true;
      return;
    }

    const month = state.cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    el.viewNote.className = 'view-note';
    el.viewNote.innerHTML = soonest
      ? `No events in ${esc(month)}. Next event: <strong>${esc(formatShortDate(soonest.date))}</strong>.
         <button type="button" class="btn link" data-goto-event="${esc(soonest.id)}">Go to that month</button>`
      : `No events in ${esc(month)} and none upcoming.${organizerHint}`;
    el.viewNote.hidden = false;
  }

  function badgeHtml(badges) {
    if (!badges.length) return '';
    return `<div class="badges">${badges
      .map(
        (b) =>
          `<span class="badge${b.warn ? ' warn' : ''}${b.mine ? ' mine' : ''}">${esc(b.text)}</span>`,
      )
      .join('')}</div>`;
  }

  function chipHtml(event) {
    const wanted = !event.past && event.needsHost && event.hostSpotsLeft > 0;
    const time = event.startTime ? formatTime(event.startTime) : 'TBD';
    // A cell is only so wide, so the row is one line; the dot colour carries
    // the host status, and the key under the grid says what it means.
    const status = [
      event.past ? 'Past event.' : '',
      wanted ? 'Needs a host.' : '',
      event.mine.length ? 'You signed up.' : '',
    ].filter(Boolean);
    const tip = [`${event.title}, ${time}`, event.where, ...status].filter(Boolean).join('. ');
    return `<button type="button" class="chip${wanted ? ' needs-host' : ''}${
      event.mine.length ? ' mine' : ''
    }${event.past ? ' past' : ''}" data-event="${esc(event.id)}" title="${esc(tip)}">
      <span class="dot" aria-hidden="true"></span>
      <span class="chip-time">${esc(time)}</span>
      <span class="chip-title">${esc(event.title)}</span>
      ${status.length ? `<span class="sr-only">${esc(status.join(' '))}</span>` : ''}
    </button>`;
  }

  function renderMonth() {
    const byDate = groupByDate(state.events);
    const todayKey = isoDate(new Date());
    let html = `<div class="weekdays">${WEEKDAYS.map(
      (d) => `<div><abbr title="${d.full}">${d.short}</abbr></div>`,
    ).join('')}</div>`;

    const canAdd = Boolean(state.viewer?.isOrganizer);
    for (const week of monthGrid(state.cursor)) {
      html += '<div class="weeks-row">';
      for (const cell of week) {
        const events = byDate.get(cell.key) ?? [];
        const expanded = state.expandedDay === cell.key;
        const shown = expanded ? events : events.slice(0, CHIPS_PER_DAY);
        const hidden = events.length - shown.length;
        const isToday = cell.key === todayKey;
        html += `<div class="day${cell.outside ? ' outside' : ''}${isToday ? ' today' : ''}">
          <span class="day-number"${isToday ? ' aria-current="date"' : ''}>${cell.dayOfMonth}${
            isToday ? '<span class="sr-only"> (today)</span>' : ''
          }</span>
          ${shown.map((event) => chipHtml(event)).join('')}
          ${
            hidden > 0
              ? `<button type="button" class="more" data-expand-day="${esc(cell.key)}">+${hidden} more</button>`
              : ''
          }
          ${
            canAdd
              ? `<button type="button" class="day-add" data-new-on="${esc(cell.key)}"
                   aria-label="Add an event on ${esc(formatShortDate(cell.key))}"><span
                   aria-hidden="true">+</span></button>`
              : ''
          }
        </div>`;
      }
      html += '</div>';
    }
    // A touch screen has no tooltip, so the dot colours need a key.
    html += `<div class="legend" aria-hidden="true">
      <span><span class="swatch needs-host"><span class="dot"></span></span>Needs a host</span>
      <span><span class="swatch"><span class="dot"></span></span>Host set</span>
      <span><span class="swatch mine"></span>You signed up</span>
    </div>`;
    el.calendar.innerHTML = html;
  }

  // The title is the button; its ::after stretches over the whole card so
  // the card still opens from anywhere, without a heading, paragraphs and
  // badges all being read out as one button's name.
  function agendaCardHtml(event) {
    return `<article class="agenda-card${event.past ? ' past' : ''}">
      <p class="when">${esc(formatLongDate(event.date))} · ${esc(formatTimeRange(event))}</p>
      <h3><button type="button" class="agenda-open" data-event="${esc(event.id)}">${esc(event.title)}</button></h3>
      ${event.where ? `<p class="where">${esc(event.where)}</p>` : ''}
      ${badgeHtml(eventBadges(event))}
      <span class="agenda-cue" aria-hidden="true">${event.past ? 'See who came →' : 'Open to sign up →'}</span>
    </article>`;
  }

  function renderAgenda() {
    const todayKey = isoDate(new Date());
    const list = upcoming(state.events, todayKey);
    const earlier = past(state.events, todayKey);
    const cards = list.length
      ? list.map(agendaCardHtml).join('')
      : `<p class="empty">
          <strong>No upcoming events.</strong><br />
          ${
            state.viewer?.isOrganizer
              ? 'Use “+ New event” to add one.'
              : 'Only an organizer can add them.'
          }
        </p>`;
    // Past events stay out of the way, but someone checking who brought what
    // last week should not have to switch to the month grid to find it. Older
    // months may not be loaded yet, so the button is offered either way.
    const canLoadMore = Boolean(state.since);
    const pastPart =
      earlier.length || canLoadMore
        ? `<button type="button" class="btn link past-toggle" data-toggle-past aria-expanded="${state.showPast}">${
            state.showPast ? 'Hide past events' : 'Show past events'
          }</button>
           ${
             state.showPast
               ? `<h2 class="agenda-heading">Past events</h2>${
                   earlier.length
                     ? earlier.map(agendaCardHtml).join('')
                     : '<p class="empty">No past events.</p>'
                 }`
               : ''
           }`
        : '';
    el.agenda.innerHTML = cards + pastPart;
  }

  // --- modals --------------------------------------------------------------

  let returnFocusTo = null;

  // What the dialog's forms held when they were drawn, to tell whether
  // closing it would throw away something the person typed.
  let modalSnapshot = '';
  function formSnapshot() {
    return [...el.modalRoot.querySelectorAll('form')]
      .map((form) => JSON.stringify([...new FormData(form).entries()]))
      .join('|');
  }

  /**
   * Escape, the backdrop and the × all close the dialog. If that would lose
   * what someone typed, ask first. The Cancel buttons are an explicit choice
   * to discard, so they close without asking.
   */
  function requestClose() {
    if (!state.modal) return;
    if (formSnapshot() !== modalSnapshot && !window.confirm('Discard what you have typed?')) return;
    closeModal();
  }

  /**
   * Where to put the keyboard when the dialog closes. A sign-up redraws the
   * whole month, so holding the element alone is not enough — the node that
   * opened the dialog is gone by then. Remember how to find it again too.
   */
  function focusAnchor(node) {
    if (!node || node === document.body) return null;
    const escape = window.CSS?.escape ?? ((v) => v);
    if (node.id) return { node, selector: `#${escape(node.id)}` };
    if (node.dataset?.event) return { node, selector: `[data-event="${escape(node.dataset.event)}"]` };
    return { node, selector: null };
  }

  function openModal(modal) {
    if (!state.modal) returnFocusTo = focusAnchor(document.activeElement);
    // A message about the last thing done should not sit over the next form.
    clearTimeout(toastTimer);
    el.toast.hidden = true;
    state.modal = modal;
    renderModal();
  }

  function closeModal() {
    state.modal = null;
    el.modalRoot.hidden = true;
    el.modalRoot.innerHTML = '';
    document.body.classList.remove('modal-open');
    if (location.hash.startsWith('#event=')) history.replaceState(null, '', location.pathname + location.search);
    // Without this the keyboard lands back at the top of the page every time.
    const back = returnFocusTo?.node?.isConnected
      ? returnFocusTo.node
      : returnFocusTo?.selector
        ? document.querySelector(returnFocusTo.selector)
        : null;
    back?.focus();
    returnFocusTo = null;
  }

  function renderModal({ focus = true } = {}) {
    const modal = state.modal;
    if (!modal) {
      closeModal();
      return;
    }
    let html = '';
    if (modal.type === 'login') html = loginModalHtml();
    else if (modal.type === 'rename') html = renameModalHtml();
    else if (modal.type === 'eventForm')
      html = eventFormHtml(modal.eventId ? eventById(modal.eventId) : null, modal.date);
    else {
      const event = eventById(modal.eventId);
      if (!event) {
        closeModal();
        return;
      }
      html = eventModalHtml(event, modal);
    }
    el.modalRoot.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">${html}</div>`;
    el.modalRoot.hidden = false;
    document.body.classList.add('modal-open');
    modalSnapshot = formSnapshot();
    if (!focus) return;
    const focusTarget = el.modalRoot.querySelector('[data-autofocus]') ?? el.modalRoot.querySelector('.close');
    focusTarget?.focus();
  }

  /** Keeps Tab inside the dialog, which is what makes it a dialog. */
  function trapFocus(domEvent) {
    if (domEvent.key !== 'Tab' || !state.modal) return;
    const focusable = [
      ...el.modalRoot.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
      ),
    ].filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (domEvent.shiftKey && document.activeElement === first) {
      domEvent.preventDefault();
      last.focus();
    } else if (!domEvent.shiftKey && document.activeElement === last) {
      domEvent.preventDefault();
      first.focus();
    }
  }

  function loginModalHtml() {
    return `
      <div class="modal-head">
        <div>
          <h2 id="modal-title">Organizer sign in</h2>
          <p class="when">Required for organizers only. Signing up for an event does not need an account.</p>
        </div>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      <form class="signup" data-form="login">
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" autocomplete="username" data-autofocus required />
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <p class="error" data-error hidden></p>
        <div class="form-actions">
          <button type="submit" class="btn primary">Sign in</button>
          <button type="button" class="btn ghost" data-close data-discard>Cancel</button>
        </div>
      </form>`;
  }

  function renameModalHtml() {
    const current = state.viewer?.name ?? '';
    return `
      <div class="modal-head">
        <div>
          <h2 id="modal-title">Your name</h2>
          <p class="when">How you appear in the header. Only you can change it.</p>
        </div>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      <form class="signup" data-form="rename">
        <div class="field">
          <label for="rename-name">Name</label>
          <input id="rename-name" name="name" maxlength="${LIMITS.name}" value="${esc(current)}"
                 placeholder="${esc(state.viewer?.email ?? '')}" data-autofocus required />
        </div>
        <p class="error" data-error hidden></p>
        <div class="form-actions">
          <button type="submit" class="btn primary">Save</button>
          <button type="button" class="btn ghost" data-close data-discard>Cancel</button>
        </div>
      </form>`;
  }

  function signupLine(signup, { nested = false, modal = null, slotLabel = '' } = {}) {
    // Editing happens in place: the line becomes the form.
    if (modal?.form?.editId === signup.id) {
      return signupFormHtml({ kind: signup.kind, slotId: signup.slotId ?? '', slotLabel, signup });
    }
    const details = [signup.item, signup.note].filter(Boolean).join(' — ');
    // Only organizers, and the person who left it, are ever sent a contact.
    const contactNote = state.viewer?.isOrganizer ? '' : ' (only organizers see this)';
    return `<div class="slot person${nested ? ' nested' : ''}${signup.isMine ? ' mine' : ''}">
      <div>
        <span class="slot-label">${esc(signup.name)}${
          signup.isMine ? '<span class="pill">You</span>' : ''
        }</span>
        ${details ? `<div class="slot-people">${esc(details)}</div>` : ''}
        ${
          signup.contact
            ? `<div class="slot-people contact">${esc(signup.contact)}${esc(contactNote)}</div>`
            : ''
        }
      </div>
      <div class="slot-actions">
        ${
          signup.canManage
            ? `<button type="button" class="btn link" data-edit-signup="${esc(signup.id)}"
                 aria-label="Edit ${esc(signup.name)}'s sign-up">Edit</button>
               <button type="button" class="btn link danger" data-cancel-signup="${esc(
                 signup.id,
               )}" data-signup-name="${esc(signup.name)}">Remove</button>`
            : ''
        }
      </div>
    </div>`;
  }

  /**
   * The sign-up form, for a new sign-up or, given `signup`, for changing one.
   * An edit changes what a sign-up says, never which slot or role it is for;
   * the database allows no more than that.
   */
  function signupFormHtml({ kind, slotId = '', slotLabel = '', signup = null }) {
    const editing = Boolean(signup);
    const host = kind === 'host';
    const value = (field, key) => esc(editing ? signup[field] : key ? remembered.read(key) : '');
    const title = editing
      ? host
        ? 'Change your host sign-up'
        : `Change what you are bringing${slotLabel ? ` for <strong>${esc(slotLabel)}</strong>` : ''}`
      : host
        ? 'Sign up to host'
        : slotLabel
          ? `Signing up for <strong>${esc(slotLabel)}</strong>`
          : 'Food outside the listed slots';
    return `<form class="signup boxed" data-form="signup" data-kind="${esc(kind)}" data-slot="${esc(
      slotId,
    )}" data-edit-id="${esc(signup?.id ?? '')}">
      <p class="form-title">${title}</p>
      <div class="row">
        <div class="field">
          <label for="su-name">Your name</label>
          <input id="su-name" name="name" maxlength="${LIMITS.name}" autocomplete="name"
                 value="${value('name', NAME_KEY)}" data-autofocus required />
        </div>
        <div class="field">
          <label for="su-contact">Phone or email <span class="help">(optional, organizers only)</span></label>
          <input id="su-contact" name="contact" maxlength="${LIMITS.contact}"
                 value="${value('contact', CONTACT_KEY)}" />
        </div>
      </div>
      <div class="field">
        <label for="su-item">${host ? 'Address' : 'What you will bring'}</label>
        <input id="su-item" name="item" maxlength="${LIMITS.item}" value="${value('item')}"
               ${host ? 'autocomplete="street-address"' : ''} placeholder="${
                 host ? 'e.g. 12 Elm St, Augusta' : 'e.g. chicken enchiladas for 12'
               }" required />
      </div>
      <div class="field">
        <label for="su-note">Note <span class="help">(optional)</span></label>
        <input id="su-note" name="note" maxlength="${LIMITS.note}" value="${value('note')}" placeholder="${
          host ? 'Parking, gate code, pets…' : 'Gluten free, needs oven space…'
        }" />
      </div>
      <p class="hint">${
        host ? 'Your name, the address' : 'Your name, what you bring'
      } and your note are visible to anyone with the link. Your phone or email is shown only to the
        organizers. No email is sent.</p>
      <p class="error" data-error hidden></p>
      <div class="form-actions">
        <button type="submit" class="btn primary">${
          editing ? 'Save changes' : host ? 'Sign up to host' : 'Add sign-up'
        }</button>
        <button type="button" class="btn ghost" data-cancel-form>Cancel</button>
      </div>
    </form>`;
  }

  function hostSectionHtml(event, modal) {
    if (!event.needsHost && !event.hosts.length) return '';
    const formOpen = modal.form?.kind === 'host' && !modal.form.editId;
    const spotsLeft = event.past ? 0 : event.hostSpotsLeft;
    // Worded like the badge on the card, so the two read as the same thing.
    const note = event.past
      ? ''
      : spotsLeft > 0
        ? spotsLeft === 1 && !event.hosts.length
          ? 'Needs a host'
          : `Needs ${spotsLeft} more`
        : 'Filled';
    return `<div class="section">
      <h3>Host ${note ? `<span class="section-note${spotsLeft > 0 ? ' warn' : ''}">${esc(note)}</span>` : ''}</h3>
      ${
        event.hosts.length
          ? event.hosts.map((h) => signupLine(h, { modal })).join('')
          : `<p class="hint">${
              event.past
                ? 'Nobody signed up to host.'
                : 'Nobody has signed up to host yet. The host gives the address when they sign up.'
            }</p>`
      }
      ${
        spotsLeft > 0 && !formOpen
          ? `<button type="button" class="btn primary" data-open-form="host">Sign up to host${
              event.hostLimit > 1 ? ` (${spotsLeft} left)` : ''
            }</button>`
          : ''
      }
      ${formOpen ? signupFormHtml({ kind: 'host' }) : ''}
    </div>`;
  }

  function foodSectionHtml(event, modal) {
    const form = modal.form?.kind === 'food' && !modal.form.editId ? modal.form : null;
    const slots = event.foodSlots
      .map((slot) => {
        const openForm = form && form.slotId === slot.id;
        const status = slotStatus(slot, { past: event.past });
        return `<div class="slot-group">
          <div class="slot${status.tone === 'done' ? ' filled' : ''}">
            <div>
              <span class="slot-label">${esc(slot.label)}</span>
              <div class="slot-people ${status.tone}">${esc(status.text)}</div>
            </div>
            <div class="slot-actions">
              ${
                openForm || event.past
                  ? ''
                  : `<button type="button" class="btn${slot.met ? '' : ' primary'}" data-open-form="food"
                       data-slot="${esc(slot.id)}" data-slot-label="${esc(slot.label)}"
                       aria-label="Sign up for ${esc(slot.label)}">Sign up</button>`
              }
            </div>
          </div>
          ${slot.people.map((p) => signupLine(p, { nested: true, modal, slotLabel: slot.label })).join('')}
          ${openForm ? signupFormHtml({ kind: 'food', slotId: slot.id, slotLabel: slot.label }) : ''}
        </div>`;
      })
      .join('');

    if (event.past && !event.foodSlots.length && !event.otherFood.length) return '';
    const otherFormOpen = form && !form.slotId;
    const short = foodStillNeeded(event);
    const note =
      event.past || !event.foodSlots.length ? '' : short > 0 ? `${short} more needed` : 'Every slot covered';
    const intro = event.past
      ? ''
      : event.foodSlots.length
        ? `<p class="hint">Pick a slot and say what you are bringing. The number is how many people the
             organizer wants; a slot never closes, so you can always add to one.</p>`
        : '<p class="hint">No slots are set for this event. Bring anything.</p>';
    return `<div class="section">
      <h3>Food ${note ? `<span class="section-note${short > 0 ? ' warn' : ''}">${esc(note)}</span>` : ''}</h3>
      ${intro}${slots}
      ${
        event.otherFood.length
          ? `<p class="hint">Other food:</p>${event.otherFood.map((p) => signupLine(p, { modal })).join('')}`
          : ''
      }
      ${
        event.allowOtherFood && !otherFormOpen && !event.past
          ? '<button type="button" class="btn" data-open-form="food">Add other food</button>'
          : ''
      }
      ${otherFormOpen ? signupFormHtml({ kind: 'food' }) : ''}
    </div>`;
  }

  function eventModalHtml(event, modal) {
    const summary = eventSummary(event);
    return `
      <div class="modal-head">
        <div>
          <h2 id="modal-title">${esc(event.title)}</h2>
          <p class="when">${esc(formatLongDate(event.date))} · ${esc(formatTimeRange(event))}</p>
          ${
            event.where
              ? `<p class="where">${esc(event.where)}${
                  event.hosts.length
                    ? ` <span class="muted">· hosted by ${esc(event.hosts.map((h) => h.name).join(', '))}</span>`
                    : ''
                }</p>`
              : event.needsHost && !event.past
                ? '<p class="when">Location: the host gives it when they sign up.</p>'
                : ''
          }
        </div>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      <p class="summary${summary.done ? ' done' : ''}${summary.past ? ' past' : ''}">${esc(summary.text)}</p>
      ${event.description ? `<p class="description">${esc(event.description)}</p>` : ''}
      ${
        event.mine.length
          ? `<p class="yours">Your sign-ups: ${esc(
              event.mine.map((s) => (s.kind === 'host' ? 'host' : s.item || 'food')).join(', '),
            )}.</p>`
          : ''
      }
      ${hostSectionHtml(event, modal)}
      ${foodSectionHtml(event, modal)}
      <div class="section footer-actions">
        <div class="form-actions">
          <button type="button" class="btn" data-copy-event="${esc(event.id)}">Copy link to this event</button>
          ${
            state.viewer?.isOrganizer
              ? `<button type="button" class="btn" data-edit-event="${esc(event.id)}">Edit event</button>
                 <button type="button" class="btn link danger" data-delete-event="${esc(
                   event.id,
                 )}">Delete event</button>`
              : ''
          }
          <button type="button" class="btn ghost push-right" data-close>Close</button>
        </div>
      </div>`;
  }

  function slotEditorRow(slot = { label: '', needed: 1, id: '' }) {
    return `<div class="slot-editor-row" data-slot-row>
      <input name="slot-label" maxlength="${LIMITS.slotLabel}" placeholder="e.g. Main dish" aria-label="What people bring" value="${esc(
        slot.label,
      )}" />
      <input name="slot-needed" type="number" min="0" value="${esc(
        Number.isInteger(slot.needed) ? slot.needed : 1,
      )}" aria-label="How many people are needed for this — 0 for no minimum" />
      <input type="hidden" name="slot-id" value="${esc(slot.id ?? '')}" />
      <button type="button" class="btn link danger" data-remove-slot aria-label="Remove this slot">Remove</button>
    </div>`;
  }

  function eventFormHtml(event, presetDate) {
    const editing = Boolean(event);
    // A new event starts with one slot to show how it works. An event being
    // edited keeps exactly the slots it has — none, if the organizer removed them.
    const slots = editing ? event.foodSlots : [{ label: 'Main dish', needed: 1, id: '' }];
    const needsHost = event ? event.needsHost : true;
    return `
      <div class="modal-head">
        <div>
          <h2 id="modal-title">${editing ? 'Edit event' : 'New event'}</h2>
          <p class="when">Visible to anyone with the link.</p>
        </div>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      <form class="signup" data-form="event" data-event-id="${esc(event?.id ?? '')}">
        <fieldset>
          <legend>What and when</legend>
          <div class="field">
            <label for="ev-title">Title</label>
            <input id="ev-title" name="title" maxlength="${LIMITS.title}" placeholder="e.g. Community Group — Week 3" value="${esc(
              event?.title ?? '',
            )}" data-autofocus required />
          </div>
          <div class="field narrow">
            <label for="ev-date">Date</label>
            <input id="ev-date" name="date" type="date" value="${esc(
              event?.date ?? presetDate ?? isoDate(new Date()),
            )}" required />
          </div>
          <div class="row">
            <div class="field">
              <label for="ev-start">Start time</label>
              <input id="ev-start" name="startTime" type="time" value="${esc(event?.startTime ?? '18:00')}" />
            </div>
            <div class="field">
              <label for="ev-end">End time <span class="help">(optional)</span></label>
              <input id="ev-end" name="endTime" type="time" value="${esc(event?.endTime ?? '')}" />
            </div>
          </div>
          <div class="field">
            <label for="ev-description">Details <span class="help">(optional)</span></label>
            <textarea id="ev-description" name="description" maxlength="${LIMITS.description}" placeholder="Topic, whether kids are welcome, other details">${esc(
              event?.description ?? '',
            )}</textarea>
          </div>
        </fieldset>

        <fieldset>
          <legend>Host</legend>
          <p class="hint">
            Either someone still needs to volunteer, or you already know where it is. Picking a
            location means nobody is asked to host.
          </p>
          <div class="checkbox">
            <input id="ev-host-needed" name="hosting" type="radio" value="needed" ${
              needsHost ? 'checked' : ''
            } />
            <label for="ev-host-needed">Still looking for a host — people can sign up to host it</label>
          </div>
          <div class="field indented" data-show-when="hosting=needed" ${needsHost ? '' : 'hidden'}>
            <label for="ev-host-limit">How many hosts</label>
            <input id="ev-host-limit" name="hostLimit" type="number" min="1" value="${esc(
              event?.hostLimit || 1,
            )}" />
            <span class="help">The host enters the address when they sign up.</span>
          </div>
          <div class="checkbox">
            <input id="ev-host-set" name="hosting" type="radio" value="set" ${
              needsHost ? '' : 'checked'
            } />
            <label for="ev-host-set">Host is arranged — show the location instead</label>
          </div>
          <div class="field indented wide" data-show-when="hosting=set" ${needsHost ? 'hidden' : ''}>
            <label for="ev-location">Location</label>
            <input id="ev-location" name="location" maxlength="${LIMITS.location}" placeholder="e.g. the Smiths' home" value="${esc(
              event?.location ?? '',
            )}" />
          </div>
        </fieldset>

        <fieldset>
          <legend>Food</legend>
          <p class="hint">
            People sign up for a slot and enter what they are bringing. The number is the
            <strong>minimum you want</strong> — more people can always add to a slot, and it never closes.
            Set it to 0 if any number will do.
          </p>
          <div class="slot-editor-head"><span>What to bring</span><span>How many needed</span><span></span></div>
          <div class="slot-editor" data-slot-editor>${slots.map((s) => slotEditorRow(s)).join('')}</div>
          <div class="form-actions">
            <button type="button" class="btn" data-add-slot>+ Add slot</button>
          </div>
          <p class="hint preset-label">Quick add:</p>
          <div class="form-actions presets">
            ${FOOD_PRESETS.map(
              (p) => `<button type="button" class="btn small" data-preset="${esc(p)}">${esc(p)}</button>`,
            ).join('')}
          </div>
          <div class="checkbox">
            <input id="ev-other-food" name="allowOtherFood" type="checkbox" ${
              event ? (event.allowOtherFood ? 'checked' : '') : 'checked'
            } />
            <label for="ev-other-food">Allow food outside these slots</label>
          </div>
        </fieldset>

        <p class="error" data-error hidden></p>
        <div class="form-actions">
          <button type="submit" class="btn primary">${editing ? 'Save changes' : 'Create event'}</button>
          <button type="button" class="btn ghost" data-close data-discard>Cancel</button>
        </div>
      </form>`;
  }

  // --- form handling -------------------------------------------------------

  function collectSlots(form) {
    return cleanSlots(
      [...form.querySelectorAll('[data-slot-row]')].map((row) => ({
        id: row.querySelector('[name="slot-id"]').value,
        label: row.querySelector('[name="slot-label"]').value,
        needed: row.querySelector('[name="slot-needed"]').value,
      })),
    );
  }

  function showFormError(form, message) {
    const target = form.querySelector('[data-error]');
    if (!target) {
      toast(message, 'error');
      return;
    }
    target.textContent = message;
    target.hidden = false;
    target.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Removing a slot keeps its sign-ups, as "Other food" — the database does
   * that on its own, so say so before it happens rather than after.
   */
  function confirmSlotRemoval(form, slots) {
    const existing = form.dataset.eventId ? eventById(form.dataset.eventId) : null;
    if (!existing) return true;
    const kept = new Set(slots.map((slot) => slot.id).filter(Boolean));
    const affected = existing.foodSlots.filter((slot) => !kept.has(slot.id) && slot.people.length);
    if (!affected.length) return true;
    const list = affected
      .map((slot) => `${slot.label} (${slot.people.map((p) => p.name).join(', ')})`)
      .join('; ');
    const people = affected.reduce((sum, slot) => sum + slot.people.length, 0);
    return window.confirm(
      `You removed ${affected.length === 1 ? 'a slot' : 'slots'} people signed up for: ${list}.\n\n` +
        `${people === 1 ? 'That sign-up is' : `Those ${people} sign-ups are`} kept and moved to "Other food". ` +
        'Save anyway?',
    );
  }

  /** Returns false when the organizer backs out, so the form stays as it was. */
  async function submitEventForm(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    const event = eventFromForm(values, {
      id: form.dataset.eventId,
      allowOtherFood: form.querySelector('[name="allowOtherFood"]').checked,
    });
    const slots = collectSlots(form);
    if (!confirmSlotRemoval(form, slots)) return false;
    // An earlier month may not have been loaded; saving into it should still
    // show the event afterwards.
    if (state.since && event.date < state.since) state.since = event.date;
    const id = await data.saveEvent(event, slots);
    await reload();
    render();
    openModal({ type: 'event', eventId: id, form: null });
    toast(form.dataset.eventId ? 'Event updated.' : 'Event created.');
  }

  async function submitSignupForm(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    // Held on to, because the dialog may be closed while the save is running.
    const modal = state.modal;
    const signup = signupFromForm(values, {
      eventId: modal.eventId,
      kind: form.dataset.kind,
      slotId: form.dataset.slot,
    });
    const editId = form.dataset.editId;
    const editing = editId ? state.events.flatMap((e) => e.signups).find((s) => s.id === editId) : null;
    // Pre-fill next time with your own details, not with someone an organizer
    // was correcting.
    if (!editing || editing.isMine) {
      remembered.write(NAME_KEY, signup.name);
      remembered.write(CONTACT_KEY, signup.contact);
    }
    if (editId) {
      const { name, contact, item, note } = signup;
      await data.updateSignup(editId, { name, contact, item, note });
    } else {
      await data.addSignup(signup);
    }
    modal.form = null;
    await refresh();
    toast(editId ? 'Sign-up updated.' : form.dataset.kind === 'host' ? 'Signed up to host.' : 'Sign-up added.');
  }

  async function submitLoginForm(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    const viewer = await data.signIn(values.email, values.password);
    state.viewer = viewer;
    closeModal();
    await refresh({ keepModal: false });
    renderIntro();
    toast(`Signed in as ${viewer.name || viewer.email}.`);
  }

  async function submitRenameForm(form) {
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) throw new Error('Enter a name.');
    state.viewer = await data.setName(name);
    closeModal();
    render();
    renderIntro();
    toast('Name updated.');
  }

  async function copyLink(url, what) {
    try {
      await navigator.clipboard.writeText(url);
      toast(`${what} copied.`);
    } catch {
      window.prompt('Copy this link:', url);
    }
  }

  // --- wiring --------------------------------------------------------------

  document.addEventListener('click', async (domEvent) => {
    const target = domEvent.target.closest('button');
    if (!target) return;
    try {
      if (target.dataset.view) {
        state.view = target.dataset.view;
        state.viewChosen = true;
        remembered.write(VIEW_KEY, state.view);
        render();
      } else if (target.id === 'prev' || target.id === 'next') {
        state.cursor = addMonths(state.cursor, target.id === 'prev' ? -1 : 1);
        state.expandedDay = null;
        render();
        await loadEarlierIfNeeded();
      } else if (target.id === 'today') {
        state.cursor = startOfMonth(new Date());
        state.expandedDay = null;
        render();
      } else if (target.id === 'help-btn') {
        toggleIntro();
      } else if (target.hasAttribute('data-dismiss-intro')) {
        el.intro.hidden = true;
        remembered.write(INTRO_KEY, '1');
        el.help?.setAttribute('aria-expanded', 'false');
      } else if (target.id === 'share-btn') {
        await copyLink(location.origin + location.pathname, 'Calendar link');
      } else if (target.id === 'signin-btn') {
        openModal({ type: 'login' });
      } else if (target.id === 'who') {
        openModal({ type: 'rename' });
      } else if (target.id === 'signout-btn') {
        state.viewer = await data.signOut();
        closeModal();
        await refresh({ keepModal: false });
        renderIntro();
        toast('Signed out.');
      } else if (target.id === 'new-event-btn') {
        openModal({ type: 'eventForm', eventId: null });
      } else if (target.dataset.gotoEvent) {
        const event = eventById(target.dataset.gotoEvent);
        if (event) {
          state.cursor = startOfMonth(parseISODate(event.date));
          render();
        }
      } else if (target.hasAttribute('data-toggle-past')) {
        state.showPast = !state.showPast;
        render();
        // Older months are only loaded on demand; showing the past is a demand.
        if (state.showPast && state.since) {
          state.since = null;
          await reload();
          render();
        }
      } else if (target.dataset.expandDay) {
        state.expandedDay = target.dataset.expandDay;
        render();
      } else if (target.dataset.newOn) {
        openModal({ type: 'eventForm', eventId: null, date: target.dataset.newOn });
      } else if (target.dataset.event) {
        history.replaceState(null, '', `#event=${target.dataset.event}`);
        openModal({ type: 'event', eventId: target.dataset.event, form: null });
      } else if (target.hasAttribute('data-close')) {
        if (target.hasAttribute('data-discard')) closeModal();
        else requestClose();
      } else if (target.dataset.openForm) {
        state.modal.form = { kind: target.dataset.openForm, slotId: target.dataset.slot || null };
        renderModal();
      } else if (target.dataset.editSignup) {
        const signup = eventById(state.modal.eventId)?.signups.find((s) => s.id === target.dataset.editSignup);
        if (signup) {
          state.modal.form = { kind: signup.kind, slotId: signup.slotId || null, editId: signup.id };
          renderModal();
        }
      } else if (target.hasAttribute('data-cancel-form')) {
        state.modal.form = null;
        renderModal();
      } else if (target.dataset.copyEvent) {
        await copyLink(`${location.origin}${location.pathname}#event=${target.dataset.copyEvent}`, 'Event link');
      } else if (target.dataset.editEvent) {
        openModal({ type: 'eventForm', eventId: target.dataset.editEvent });
      } else if (target.dataset.deleteEvent) {
        const event = eventById(target.dataset.deleteEvent);
        const people = event?.signups.length ?? 0;
        if (
          !window.confirm(
            `Delete “${event?.title ?? 'this event'}”?` +
              (people ? ` ${people} sign-up${people === 1 ? '' : 's'} will be deleted with it.` : '') +
              ' This cannot be undone.',
          )
        ) {
          return;
        }
        await data.deleteEvent(target.dataset.deleteEvent);
        closeModal();
        await refresh({ keepModal: false });
        toast('Event deleted.');
      } else if (target.dataset.cancelSignup) {
        const name = target.dataset.signupName || 'this';
        if (!window.confirm(`Remove ${name} from this event?`)) return;
        await data.deleteSignup(target.dataset.cancelSignup);
        await refresh();
        toast('Sign-up removed.');
      } else if (target.hasAttribute('data-add-slot')) {
        const editor = target.closest('form').querySelector('[data-slot-editor]');
        editor.insertAdjacentHTML('beforeend', slotEditorRow());
        editor.lastElementChild.querySelector('[name="slot-label"]').focus();
      } else if (target.dataset.preset) {
        const editor = target.closest('form').querySelector('[data-slot-editor]');
        const existing = [...editor.querySelectorAll('[name="slot-label"]')];
        const match = existing.find(
          (input) => input.value.trim().toLowerCase() === target.dataset.preset.toLowerCase(),
        );
        if (match) {
          match.focus();
          return;
        }
        const blank = existing.find((input) => !input.value.trim());
        if (blank) blank.value = target.dataset.preset;
        else editor.insertAdjacentHTML('beforeend', slotEditorRow({ label: target.dataset.preset, needed: 1, id: '' }));
      } else if (target.hasAttribute('data-remove-slot')) {
        target.closest('[data-slot-row]').remove();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Parts of a form marked data-show-when="field=value" only apply to one
  // answer — "How many hosts" for a wanted host, "Location" for an arranged one.
  document.addEventListener('change', (domEvent) => {
    const form = domEvent.target.closest?.('form');
    if (!form) return;
    for (const part of form.querySelectorAll('[data-show-when]')) {
      const [name, value] = part.dataset.showWhen.split('=');
      part.hidden = form.elements[name]?.value !== value;
    }
  });

  document.addEventListener('submit', async (domEvent) => {
    const form = domEvent.target;
    if (!form.dataset.form) return;
    domEvent.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const label = submit?.textContent;
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Saving…';
    }
    try {
      let done = true;
      if (form.dataset.form === 'login') await submitLoginForm(form);
      else if (form.dataset.form === 'rename') await submitRenameForm(form);
      else if (form.dataset.form === 'event') done = (await submitEventForm(form)) !== false;
      else await submitSignupForm(form);
      if (!done && submit) {
        submit.disabled = false;
        submit.textContent = label;
      }
    } catch (err) {
      showFormError(form, err.message);
      if (submit) {
        submit.disabled = false;
        submit.textContent = label;
      }
    }
  });

  el.modalRoot.addEventListener('click', (domEvent) => {
    if (domEvent.target === el.modalRoot) requestClose();
  });

  document.addEventListener('keydown', (domEvent) => {
    if (domEvent.key === 'Escape' && state.modal) requestClose();
    else trapFocus(domEvent);
  });

  // Someone who has not picked a view should still get the readable one after
  // rotating a tablet or dragging a window wider.
  let resizeTimer;
  window.addEventListener('resize', () => {
    if (state.viewChosen) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const wanted = window.innerWidth < 720 ? 'list' : 'month';
      if (wanted !== state.view) {
        state.view = wanted;
        render();
      }
    }, 150);
  });

  // Someone else may have signed up while this tab sat open. A quick glance at
  // another app is not worth a reload, so only refresh after a while.
  const STALE_AFTER_MS = 30_000;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || state.loading) return;
    if (Date.now() - state.loadedAt < STALE_AFTER_MS) return;
    try {
      await reload();
      render();
      // Redrawing the dialog would wipe anything half-typed — someone who
      // switched apps to look up their address comes back to an empty form.
      // A dialog with no form in it is safe to bring up to date.
      const modal = state.modal;
      if (modal?.type === 'event' && !modal.form) renderModal({ focus: false });
    } catch {
      /* the next action will surface the problem */
    }
  });

  // A link to another event pasted into this tab changes only the hash.
  window.addEventListener('hashchange', () => {
    openLinkedEvent().catch((err) => toast(err.message, 'error'));
  });

  async function openLinkedEvent() {
    const deepLink = location.hash.match(/^#event=(.+)$/);
    if (!deepLink) return;
    const event = await findLinkedEvent(decodeURIComponent(deepLink[1]));
    if (!event) {
      history.replaceState(null, '', location.pathname + location.search);
      render();
      toast('That event is no longer on the calendar.', 'error');
      return;
    }
    state.cursor = startOfMonth(parseISODate(event.date));
    render();
    openModal({ type: 'event', eventId: event.id, form: null });
  }

  // --- boot ----------------------------------------------------------------

  return (async () => {
    try {
      state.viewer = await data.init();
      await reload();
      state.loading = false;
      renderIntro();
      render();
      await openLinkedEvent();
    } catch (err) {
      state.loading = false;
      if (onError) onError(err);
      else {
        if (el.loading) el.loading.hidden = true;
        el.calendar.hidden = false;
        el.calendar.innerHTML = `<p class="empty"><strong>Could not load the calendar.</strong><br />${esc(
          err.message,
        )}</p>`;
      }
    }
  })();
}
