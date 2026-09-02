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
  shapeEvents,
  upcoming,
} from './lib/model.js';

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
    expandedDay: null,
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
    const raw = await data.loadEvents();
    state.viewer = data.viewer();
    state.events = shapeEvents(raw, {
      userId: state.viewer?.id ?? null,
      isOrganizer: Boolean(state.viewer?.isOrganizer),
    });
  }

  const eventById = (id) => state.events.find((e) => e.id === id);

  async function refresh({ keepModal = true } = {}) {
    await reload();
    render();
    if (keepModal) renderModal();
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
        <li><strong>Sign up.</strong> Take the host slot, or pick a food slot and enter what you are
          bringing. No account is required.</li>
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
    const wanted = event.needsHost && event.hostSpotsLeft > 0;
    const time = event.startTime ? formatTime(event.startTime) : 'TBD';
    // A cell is only so wide, so the row is one line and the detail moves into
    // the tooltip and the dot colour.
    const tip = [`${event.title}, ${time}`, wanted ? 'Needs a host.' : '']
      .filter(Boolean)
      .join(' ');
    return `<button type="button" class="chip${wanted ? ' needs-host' : ''}${
      event.mine.length ? ' mine' : ''
    }" data-event="${esc(event.id)}" title="${esc(tip)}">
      <span class="dot" aria-hidden="true"></span>
      <span class="chip-time">${esc(time)}</span>
      <span class="chip-title">${esc(event.title)}</span>
    </button>`;
  }

  function renderMonth() {
    const byDate = groupByDate(state.events);
    const todayKey = isoDate(new Date());
    let html = `<div class="weekdays" role="row">${WEEKDAYS.map(
      (d) => `<div role="columnheader"><abbr title="${d.full}">${d.short}</abbr></div>`,
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
    el.calendar.innerHTML = html;
  }

  function renderAgenda() {
    const list = upcoming(state.events, isoDate(new Date()));
    if (!list.length) {
      el.agenda.innerHTML = `<p class="empty">
        <strong>No upcoming events.</strong><br />
        ${
          state.viewer?.isOrganizer
            ? 'Use “+ New event” to add one.'
            : 'Only an organizer can add them.'
        }
      </p>`;
      return;
    }
    el.agenda.innerHTML = list
      .map(
        (event) => `<button type="button" class="agenda-card" data-event="${esc(event.id)}">
          <p class="when">${esc(formatLongDate(event.date))} · ${esc(formatTimeRange(event))}</p>
          <h3>${esc(event.title)}</h3>
          ${event.location ? `<p class="where">${esc(event.location)}</p>` : ''}
          ${badgeHtml(eventBadges(event))}
          <span class="agenda-cue">Open to sign up →</span>
        </button>`,
      )
      .join('');
  }

  // --- modals --------------------------------------------------------------

  let returnFocusTo = null;

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
    state.modal = modal;
    renderModal();
  }

  function closeModal() {
    state.modal = null;
    el.modalRoot.hidden = true;
    el.modalRoot.innerHTML = '';
    document.body.classList.remove('modal-open');
    if (location.hash.startsWith('#event=')) history.replaceState(null, '', location.pathname);
    // Without this the keyboard lands back at the top of the page every time.
    const back = returnFocusTo?.node?.isConnected
      ? returnFocusTo.node
      : returnFocusTo?.selector
        ? document.querySelector(returnFocusTo.selector)
        : null;
    back?.focus();
    returnFocusTo = null;
  }

  function renderModal() {
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
          <button type="button" class="btn ghost" data-close>Cancel</button>
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
          <input id="rename-name" name="name" maxlength="80" value="${esc(current)}"
                 placeholder="${esc(state.viewer?.email ?? '')}" data-autofocus required />
        </div>
        <p class="error" data-error hidden></p>
        <div class="form-actions">
          <button type="submit" class="btn primary">Save</button>
          <button type="button" class="btn ghost" data-close>Cancel</button>
        </div>
      </form>`;
  }

  function signupLine(signup, { nested = false } = {}) {
    const details = [signup.item, signup.note].filter(Boolean).join(' — ');
    return `<div class="slot person${nested ? ' nested' : ''}${signup.isMine ? ' mine' : ''}">
      <div>
        <span class="slot-label">${esc(signup.name)}${
          signup.isMine ? '<span class="pill">You</span>' : ''
        }</span>
        ${details ? `<div class="slot-people">${esc(details)}</div>` : ''}
        ${signup.contact ? `<div class="slot-people">${esc(signup.contact)}</div>` : ''}
      </div>
      <div class="slot-actions">
        ${
          signup.canManage
            ? `<button type="button" class="btn link danger" data-cancel-signup="${esc(
                signup.id,
              )}" data-signup-name="${esc(signup.name)}">Remove</button>`
            : ''
        }
      </div>
    </div>`;
  }

  function signupFormHtml({ kind, slotId = '', slotLabel = '', needsItem }) {
    return `<form class="signup boxed" data-form="signup" data-kind="${esc(kind)}" data-slot="${esc(slotId)}">
      <p class="form-title">${
        kind === 'host'
          ? 'Sign up to host'
          : slotLabel
            ? `Signing up for <strong>${esc(slotLabel)}</strong>`
            : 'Food outside the listed slots'
      }</p>
      <div class="row">
        <div class="field">
          <label for="su-name">Your name</label>
          <input id="su-name" name="name" value="${esc(remembered.read(NAME_KEY))}" data-autofocus required />
        </div>
        <div class="field">
          <label for="su-contact">Phone or email <span class="help">(optional)</span></label>
          <input id="su-contact" name="contact" value="${esc(remembered.read(CONTACT_KEY))}" />
        </div>
      </div>
      ${
        needsItem
          ? `<div class="field">
              <label for="su-item">What you will bring</label>
              <input id="su-item" name="item" placeholder="e.g. chicken enchiladas for 12" required />
            </div>`
          : ''
      }
      <div class="field">
        <label for="su-note">Note <span class="help">(optional)</span></label>
        <input id="su-note" name="note" placeholder="${esc(
          kind === 'host' ? 'Address, parking notes…' : 'Gluten free, needs oven space…',
        )}" />
      </div>
      <p class="hint">Your name and note are visible to anyone with the link. No email is sent.</p>
      <p class="error" data-error hidden></p>
      <div class="form-actions">
        <button type="submit" class="btn primary">${kind === 'host' ? 'Sign up to host' : 'Add sign-up'}</button>
        <button type="button" class="btn ghost" data-cancel-form>Cancel</button>
      </div>
    </form>`;
  }

  function hostSectionHtml(event, modal) {
    if (!event.needsHost) return '';
    const formOpen = modal.form?.kind === 'host';
    const spotsLeft = event.hostSpotsLeft;
    return `<div class="section">
      <h3>Host <span class="section-note">${
        spotsLeft > 0
          ? esc(spotsLeft === 1 ? 'unfilled' : `${spotsLeft} more needed`)
          : 'filled'
      }</span></h3>
      ${
        event.hosts.length
          ? event.hosts.map((h) => signupLine(h)).join('')
          : '<p class="hint">The host provides the location. No one has signed up.</p>'
      }
      ${
        spotsLeft > 0 && !formOpen
          ? `<button type="button" class="btn primary" data-open-form="host">Sign up to host${
              event.hostLimit > 1 ? ` (${spotsLeft} left)` : ''
            }</button>`
          : ''
      }
      ${formOpen ? signupFormHtml({ kind: 'host', needsItem: false }) : ''}
    </div>`;
  }

  function slotStatus(slot) {
    if (slot.noMinimum) return { text: `${slot.taken} signed up. No number set.`, tone: 'open' };
    // Past the number asked for, "5 of 2" reads like a mistake; just say how
    // many are coming.
    if (slot.taken > slot.needed) return { text: `${slot.taken} signed up. Covered.`, tone: 'done' };
    if (slot.met) return { text: `${slot.taken} of ${slot.needed}. Covered.`, tone: 'done' };
    return { text: `${slot.taken} of ${slot.needed}. ${slot.stillNeeded} more needed.`, tone: 'open' };
  }

  function foodSectionHtml(event, modal) {
    const form = modal.form?.kind === 'food' ? modal.form : null;
    const slots = event.foodSlots
      .map((slot) => {
        const openForm = form && form.slotId === slot.id;
        const status = slotStatus(slot);
        return `<div class="slot-group">
          <div class="slot${status.tone === 'done' ? ' filled' : ''}">
            <div>
              <span class="slot-label">${esc(slot.label)}</span>
              <div class="slot-people ${status.tone}">${esc(status.text)}</div>
            </div>
            <div class="slot-actions">
              ${
                openForm
                  ? ''
                  : `<button type="button" class="btn${slot.met ? '' : ' primary'}" data-open-form="food"
                       data-slot="${esc(slot.id)}" data-slot-label="${esc(
                         slot.label,
                       )}">Sign up</button>`
              }
            </div>
          </div>
          ${slot.people.map((p) => signupLine(p, { nested: true })).join('')}
          ${openForm ? signupFormHtml({ kind: 'food', slotId: slot.id, slotLabel: slot.label, needsItem: true }) : ''}
        </div>`;
      })
      .join('');

    const otherFormOpen = form && !form.slotId;
    return `<div class="section">
      <h3>Food <span class="section-note">${
        event.foodSlots.length
          ? esc(
              foodStillNeeded(event) > 0
                ? `${foodStillNeeded(event)} more needed`
                : 'every slot covered',
            )
          : ''
      }</span></h3>
      ${
        event.foodSlots.length
          ? `<p class="hint">Sign up for a slot and enter what you are bringing. The number is how many
               people the organizer wants; a slot never closes, so you can always add to one.</p>${slots}`
          : '<p class="hint">No slots are set for this event. Bring anything.</p>'
      }
      ${
        event.otherFood.length
          ? `<p class="hint">Other food:</p>${event.otherFood.map((p) => signupLine(p)).join('')}`
          : ''
      }
      ${
        event.allowOtherFood && !otherFormOpen
          ? '<button type="button" class="btn" data-open-form="food">Add other food</button>'
          : ''
      }
      ${otherFormOpen ? signupFormHtml({ kind: 'food', needsItem: true }) : ''}
    </div>`;
  }

  function eventModalHtml(event, modal) {
    const summary = eventSummary(event);
    return `
      <div class="modal-head">
        <div>
          <h2 id="modal-title">${esc(event.title)}</h2>
          <p class="when">${esc(formatLongDate(event.date))} · ${esc(formatTimeRange(event))}</p>
          ${event.location ? `<p class="when">${esc(event.location)}</p>` : ''}
        </div>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      <p class="summary${summary.done ? ' done' : ''}">${esc(summary.text)}</p>
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
      <input name="slot-label" placeholder="e.g. Main dish" aria-label="What people bring" value="${esc(
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
    const slots = editing && event.foodSlots.length ? event.foodSlots : [{ label: 'Main dish', needed: 1, id: '' }];
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
            <input id="ev-title" name="title" placeholder="e.g. Community Group — Week 3" value="${esc(
              event?.title ?? '',
            )}" data-autofocus required />
          </div>
          <div class="row">
            <div class="field">
              <label for="ev-date">Date</label>
              <input id="ev-date" name="date" type="date" value="${esc(
                event?.date ?? presetDate ?? isoDate(new Date()),
              )}" required />
            </div>
            <div class="field">
              <label for="ev-location">Location <span class="help">(optional)</span></label>
              <input id="ev-location" name="location" placeholder="Blank until a host signs up" value="${esc(
                event?.location ?? '',
              )}" />
            </div>
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
            <textarea id="ev-description" name="description" placeholder="Topic, whether kids are welcome, other details">${esc(
              event?.description ?? '',
            )}</textarea>
          </div>
        </fieldset>

        <fieldset>
          <legend>Host</legend>
          <div class="checkbox">
            <input id="ev-needs-host" name="needsHost" type="checkbox" data-toggles="host-limit" ${
              needsHost ? 'checked' : ''
            } />
            <label for="ev-needs-host">This event needs a host</label>
          </div>
          <div class="field indented" data-toggle-target="host-limit" ${needsHost ? '' : 'hidden'}>
            <label for="ev-host-limit">How many hosts</label>
            <input id="ev-host-limit" name="hostLimit" type="number" min="1" value="${esc(
              event?.hostLimit || 1,
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
          <button type="button" class="btn ghost" data-close>Cancel</button>
        </div>
      </form>`;
  }

  // --- form handling -------------------------------------------------------

  function collectSlots(form) {
    return [...form.querySelectorAll('[data-slot-row]')]
      .map((row) => ({
        id: row.querySelector('[name="slot-id"]').value,
        label: row.querySelector('[name="slot-label"]').value.trim(),
        needed: Math.max(0, Number(row.querySelector('[name="slot-needed"]').value) || 0),
      }))
      .filter((slot) => slot.label);
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

  async function submitEventForm(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    const id = await data.saveEvent(
      {
        id: form.dataset.eventId || null,
        title: values.title,
        date: values.date,
        startTime: values.startTime ?? '',
        endTime: values.endTime ?? '',
        location: values.location ?? '',
        description: values.description ?? '',
        needsHost: form.querySelector('[name="needsHost"]').checked,
        hostLimit: Math.max(1, Number(values.hostLimit) || 1),
        allowOtherFood: form.querySelector('[name="allowOtherFood"]').checked,
      },
      collectSlots(form),
    );
    await reload();
    render();
    openModal({ type: 'event', eventId: id, form: null });
    toast(form.dataset.eventId ? 'Event updated.' : 'Event created.');
  }

  async function submitSignupForm(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    remembered.write(NAME_KEY, values.name?.trim());
    remembered.write(CONTACT_KEY, values.contact?.trim() ?? '');
    await data.addSignup({
      eventId: state.modal.eventId,
      kind: form.dataset.kind,
      slotId: form.dataset.slot || null,
      name: values.name,
      contact: values.contact ?? '',
      item: values.item ?? '',
      note: values.note ?? '',
    });
    state.modal.form = null;
    await refresh();
    toast(form.dataset.kind === 'host' ? 'Signed up to host.' : 'Sign-up added.');
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
      } else if (target.id === 'today') {
        state.cursor = startOfMonth(new Date());
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
      } else if (target.dataset.expandDay) {
        state.expandedDay = target.dataset.expandDay;
        render();
      } else if (target.dataset.newOn) {
        openModal({ type: 'eventForm', eventId: null, date: target.dataset.newOn });
      } else if (target.dataset.event) {
        history.replaceState(null, '', `#event=${target.dataset.event}`);
        openModal({ type: 'event', eventId: target.dataset.event, form: null });
      } else if (target.hasAttribute('data-close')) {
        closeModal();
      } else if (target.dataset.openForm) {
        state.modal.form = { kind: target.dataset.openForm, slotId: target.dataset.slot || null };
        renderModal();
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

  // "How many hosts" only means something once the event wants a host.
  document.addEventListener('change', (domEvent) => {
    const toggles = domEvent.target.dataset?.toggles;
    if (!toggles) return;
    const target = domEvent.target.closest('form')?.querySelector(`[data-toggle-target="${toggles}"]`);
    if (target) target.hidden = !domEvent.target.checked;
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
      if (form.dataset.form === 'login') await submitLoginForm(form);
      else if (form.dataset.form === 'rename') await submitRenameForm(form);
      else if (form.dataset.form === 'event') await submitEventForm(form);
      else await submitSignupForm(form);
    } catch (err) {
      showFormError(form, err.message);
      if (submit) {
        submit.disabled = false;
        submit.textContent = label;
      }
    }
  });

  el.modalRoot.addEventListener('click', (domEvent) => {
    if (domEvent.target === el.modalRoot) closeModal();
  });

  document.addEventListener('keydown', (domEvent) => {
    if (domEvent.key === 'Escape' && state.modal) closeModal();
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

  // Someone else may have taken the last main dish while this tab sat open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.loading) refresh().catch(() => {});
  });

  // --- boot ----------------------------------------------------------------

  return (async () => {
    try {
      state.viewer = await data.init();
      await reload();
      state.loading = false;
      const deepLink = location.hash.match(/^#event=(.+)$/);
      if (deepLink) {
        const event = eventById(decodeURIComponent(deepLink[1]));
        if (event) {
          state.cursor = startOfMonth(parseISODate(event.date));
          state.modal = { type: 'event', eventId: event.id, form: null };
        }
      }
      renderIntro();
      render();
      renderModal();
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
