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

/** The event a link like "…/#event=<id>" asks to open, or null. */
function eventFromHash(hash) {
  const match = String(hash ?? '').match(/^#event=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function startApp(data, { onError } = {}) {
  const storedView = remembered.read(VIEW_KEY);
  const state = {
    viewer: null,
    // Set while the sign-in screen stands in for the calendar:
    // { mode, notice, values } — see renderGate().
    gate: null,
    // An event link opened before signing in. Held here so the event opens
    // once the person is in, rather than being lost behind the sign-in screen.
    pendingEvent: eventFromHash(location.hash),
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
    gate: document.getElementById('gate'),
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
        <li><strong>Sign up.</strong> Take the host slot if the event still needs one, or pick a food
          slot and enter what you are bringing.</li>
        <li><strong>Add it to your calendar.</strong> Open <strong>your name</strong> at the top and subscribe,
          and every event shows up in your phone's calendar with who is bringing what.</li>
      </ol>
      <p class="hint">
        To change or remove a sign-up, reopen the event. Your sign-ups follow your account, so any device
        you sign in on works.
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
    const viewer = state.viewer;
    const member = Boolean(viewer?.isMember) && !state.gate;
    const organizer = member && Boolean(viewer?.isOrganizer);
    el.who.hidden = !member;
    el.who.textContent = member
      ? `${viewer.name || viewer.email}${organizer ? ' · Organizer' : ''}`
      : '';
    el.who.title = member ? 'Your account, calendar subscription and sign out' : '';
    el.signOut.hidden = !viewer;
    el.newEvent.hidden = !organizer;
    if (el.help) el.help.hidden = Boolean(state.gate);
  }

  function render() {
    renderAuth();
    if (el.gate) el.gate.hidden = !state.gate;
    if (state.gate) {
      for (const node of [el.loading, el.toolbar, el.calendar, el.agenda, el.viewNote, el.intro]) {
        if (node) node.hidden = true;
      }
      renderGate();
      return;
    }
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

  // --- the sign-in screen ----------------------------------------------------
  //
  // Stands in for the calendar until the person is a member: signed out, still
  // to enter the invite code, removed, or back from a password reset link.

  function noticeHtml(notice) {
    if (!notice) return '';
    return `<p class="${notice.tone === 'error' ? 'error' : 'notice'}" role="status">${esc(notice.text)}</p>`;
  }

  function gateTabs(mode) {
    return `<div class="gate-tabs" role="tablist">
      <button type="button" class="btn toggle" role="tab" data-gate="signin"
              aria-selected="${mode === 'signin'}" aria-pressed="${mode === 'signin'}">Sign in</button>
      <button type="button" class="btn toggle" role="tab" data-gate="create"
              aria-selected="${mode === 'create'}" aria-pressed="${mode === 'create'}">Create account</button>
    </div>`;
  }

  function gateHtml({ mode, notice, values = {} }) {
    const email = esc(values.email ?? '');
    const eventNote = state.pendingEvent
      ? '<p class="hint">Sign in and the event you opened will be waiting.</p>'
      : '';

    if (mode === 'recovery') {
      return `<h2>Choose a new password</h2>
        ${noticeHtml(notice)}
        <form class="signup" data-form="gate-recovery">
          <div class="field">
            <label for="gate-new-password">New password</label>
            <input id="gate-new-password" name="password" type="password" autocomplete="new-password"
                   minlength="6" data-autofocus required />
          </div>
          <div class="field">
            <label for="gate-new-password-2">Type it again</label>
            <input id="gate-new-password-2" name="confirm" type="password" autocomplete="new-password"
                   minlength="6" required />
          </div>
          <p class="error" data-error hidden></p>
          <div class="form-actions"><button type="submit" class="btn primary">Save password</button></div>
        </form>`;
    }

    if (mode === 'join') {
      return `<h2>Enter the invite code</h2>
        <p>You're signed in as <strong>${esc(state.viewer?.email ?? '')}</strong>. The calendar is for
          group members — ask an organizer for the group's invite code.</p>
        ${noticeHtml(notice)}
        <form class="signup" data-form="gate-join">
          <div class="field">
            <label for="gate-join-name">Your name</label>
            <input id="gate-join-name" name="name" maxlength="80" autocomplete="name"
                   value="${esc(values.name ?? state.viewer?.name ?? '')}" required />
          </div>
          <div class="field">
            <label for="gate-join-code">Invite code</label>
            <input id="gate-join-code" name="code" autocomplete="off" autocapitalize="none"
                   value="${esc(values.code ?? '')}" data-autofocus required />
          </div>
          <p class="error" data-error hidden></p>
          <div class="form-actions">
            <button type="submit" class="btn primary">Join the group</button>
            <button type="button" class="btn ghost" data-gate-signout>Use a different account</button>
          </div>
        </form>`;
    }

    if (mode === 'removed') {
      return `<h2>This account was removed from the group</h2>
        <p>An organizer removed <strong>${esc(state.viewer?.email ?? 'this account')}</strong>, so the
          calendar and its subscription are turned off for it. If that's a mistake, ask an organizer to
          restore it.</p>
        <div class="form-actions"><button type="button" class="btn" data-gate-signout>Sign out</button></div>`;
    }

    if (mode === 'confirm') {
      return `<h2>Check your email</h2>
        <p>We sent a link to <strong>${email}</strong>. Open it to confirm your address, then sign in —
          you'll be asked for the invite code once more.</p>
        <div class="form-actions"><button type="button" class="btn" data-gate="signin">Back to sign in</button></div>`;
    }

    if (mode === 'forgot') {
      return `<h2>Reset your password</h2>
        <p>Enter your account's email and we'll send a link to choose a new password.</p>
        ${noticeHtml(notice)}
        <form class="signup" data-form="gate-forgot">
          <div class="field">
            <label for="gate-forgot-email">Email</label>
            <input id="gate-forgot-email" name="email" type="email" autocomplete="username"
                   value="${email}" data-autofocus required />
          </div>
          <p class="error" data-error hidden></p>
          <div class="form-actions">
            <button type="submit" class="btn primary">Send reset link</button>
            <button type="button" class="btn ghost" data-gate="signin">Back to sign in</button>
          </div>
        </form>`;
    }

    if (mode === 'create') {
      return `${gateTabs(mode)}
        <p>New here? You'll need the group's <strong>invite code</strong> from an organizer.</p>
        ${eventNote}
        ${noticeHtml(notice)}
        <form class="signup" data-form="gate-create">
          <div class="field">
            <label for="gate-create-name">Your name</label>
            <input id="gate-create-name" name="name" maxlength="80" autocomplete="name"
                   value="${esc(values.name ?? '')}" data-autofocus required />
            <span class="help">How you appear to the group, like "Anna Smith".</span>
          </div>
          <div class="field">
            <label for="gate-create-email">Email</label>
            <input id="gate-create-email" name="email" type="email" autocomplete="username" value="${email}" required />
          </div>
          <div class="field">
            <label for="gate-create-password">Password</label>
            <input id="gate-create-password" name="password" type="password" autocomplete="new-password"
                   minlength="6" required />
            <span class="help">At least 6 characters.</span>
          </div>
          <div class="field">
            <label for="gate-create-code">Invite code</label>
            <input id="gate-create-code" name="code" autocomplete="off" autocapitalize="none"
                   value="${esc(values.code ?? '')}" required />
          </div>
          <p class="error" data-error hidden></p>
          <div class="form-actions"><button type="submit" class="btn primary">Create account</button></div>
        </form>`;
    }

    return `${gateTabs('signin')}
      ${eventNote}
      ${noticeHtml(notice)}
      <form class="signup" data-form="gate-signin">
        <div class="field">
          <label for="gate-email">Email</label>
          <input id="gate-email" name="email" type="email" autocomplete="username" value="${email}"
                 data-autofocus required />
        </div>
        <div class="field">
          <label for="gate-password">Password</label>
          <input id="gate-password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <p class="error" data-error hidden></p>
        <div class="form-actions">
          <button type="submit" class="btn primary">Sign in</button>
          <button type="button" class="btn link" data-gate="forgot">Forgot password?</button>
        </div>
      </form>`;
  }

  function renderGate() {
    if (!el.gate || !state.gate) return;
    el.gate.innerHTML = `<div class="gate-card">${gateHtml(state.gate)}</div>`;
    el.gate.querySelector('[data-autofocus]')?.focus();
  }

  function showGate(mode, { notice = null, values = {} } = {}) {
    state.gate = { mode, notice, values };
    state.loading = false;
    if (state.modal) closeModal();
    render();
  }

  /**
   * Decides what the person sees: the right sign-in step, or the calendar.
   * Called at start-up and after anything that changes who they are.
   */
  async function enter({ notice = null } = {}) {
    const viewer = state.viewer;
    const redirect = data.authRedirect();
    if (viewer && redirect.recovery) return showGate('recovery', { notice });
    if (!viewer) return showGate('signin', { notice: notice ?? (redirect.error ? { tone: 'error', text: redirect.error } : null) });
    if (viewer.removed) return showGate('removed');
    if (!viewer.isMember) return showGate('join', { notice });

    state.gate = null;
    state.loading = true;
    render();
    await reload();
    state.loading = false;
    const pending = state.pendingEvent ? eventById(state.pendingEvent) : null;
    state.pendingEvent = null;
    if (pending) {
      state.cursor = startOfMonth(parseISODate(pending.date));
      history.replaceState(null, '', `#event=${encodeURIComponent(pending.id)}`);
      state.modal = { type: 'event', eventId: pending.id, form: null };
    }
    renderIntro();
    render();
    renderModal();
  }

  /** A write found no session: back to the sign-in screen, keeping the event open. */
  function signedOut(err) {
    if (state.modal?.eventId) state.pendingEvent = state.modal.eventId;
    state.viewer = null;
    showGate('signin', { notice: { tone: 'error', text: err.message } });
  }

  const formValues = (form) =>
    Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v).trim()]));

  async function submitGateForm(form) {
    const kind = form.dataset.form;
    const values = formValues(form);
    if (kind === 'gate-signin') {
      state.viewer = await data.signIn(values.email, String(new FormData(form).get('password') ?? ''));
      await enter();
      if (state.viewer?.isMember) toast(`Signed in as ${state.viewer.name || state.viewer.email}.`);
    } else if (kind === 'gate-create') {
      const result = await data.signUp({
        email: values.email,
        password: new FormData(form).get('password'),
        displayName: values.name,
        inviteCode: values.code,
      });
      if (result.confirmEmail) {
        showGate('confirm', { values: { email: values.email } });
        return;
      }
      state.viewer = result.viewer;
      if (result.joinError) {
        showGate('join', { notice: { tone: 'error', text: result.joinError }, values: { name: values.name } });
        return;
      }
      await enter();
      toast(`Welcome, ${state.viewer.name}!`);
    } else if (kind === 'gate-join') {
      state.viewer = await data.joinGroup(values.code, values.name);
      await enter();
      toast(`Welcome, ${state.viewer.name}!`);
    } else if (kind === 'gate-forgot') {
      await data.requestPasswordReset(values.email);
      showGate('signin', {
        values: { email: values.email },
        notice: {
          tone: 'ok',
          text: `If there's an account for ${values.email}, a reset link is on its way. Check your spam folder too.`,
        },
      });
    } else if (kind === 'gate-recovery') {
      const password = String(new FormData(form).get('password') ?? '');
      if (password !== String(new FormData(form).get('confirm') ?? '')) {
        throw new Error('The two passwords are different.');
      }
      state.viewer = await data.updatePassword(password);
      await enter();
      toast('Password changed.');
    }
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
    if (modal.type === 'account') html = accountModalHtml(modal);
    else if (modal.type === 'group') html = groupModalHtml(modal);
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

  function accountModalHtml(modal) {
    const viewer = state.viewer ?? {};
    const links = data.feedLinks?.() ?? null;
    let feed = '<p class="hint">Your calendar link is not ready yet. Reload the page and try again.</p>';
    if (links?.webcal) {
      feed = `<p class="hint">Subscribe once and every event appears in your phone's calendar, with the
          address, who is hosting, and who is bringing what. It keeps itself up to date.</p>
        <div class="form-actions">
          <a class="btn primary" href="${esc(links.webcal)}">Subscribe in Apple Calendar or Outlook</a>
          <button type="button" class="btn" data-copy-feed>Copy link for Google Calendar</button>
        </div>
        <details class="steps">
          <summary>How to add it to Google Calendar</summary>
          <ol>
            <li>Tap <strong>Copy link for Google Calendar</strong> above.</li>
            <li>On a computer, open <a href="https://calendar.google.com/calendar/r/settings/addbyurl"
                rel="noreferrer noopener" target="_blank">Google Calendar → Add calendar → From URL</a>.</li>
            <li>Paste the link and choose <strong>Add calendar</strong>. It appears on your phone too.</li>
          </ol>
        </details>
        <p class="hint">Changes reach Apple Calendar and Outlook within about an hour. Google Calendar
          checks less often — it can take up to a day. Tapping the link in an event opens it here; the
          first time from inside Outlook you may need to sign in.</p>
        <p class="hint">The link is personal: anyone who has it can see the calendar.
          <button type="button" class="btn link danger" data-reset-feed>Reset my link</button>
          turns off the old one if it got shared.</p>`;
    } else if (links?.sample) {
      feed = `<p class="hint">On the real calendar this is where you subscribe from Apple Calendar,
          Google Calendar or Outlook. The demo can't serve a live feed, but you can download a sample of
          what it contains.</p>
        <div class="form-actions"><button type="button" class="btn" data-download-feed>Download a sample</button></div>`;
    }
    return `
      <div class="modal-head">
        <div>
          <h2 id="modal-title">Your account</h2>
          <p class="when">${esc(viewer.email ?? '')}${viewer.isOrganizer ? ' · Organizer' : ''}</p>
        </div>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      <form class="signup" data-form="rename">
        <div class="field">
          <label for="rename-name">Your name</label>
          <input id="rename-name" name="name" maxlength="80" value="${esc(viewer.name ?? '')}"
                 autocomplete="name" required />
          <span class="help">Shown in the header and filled in when you sign up for something.</span>
        </div>
        <p class="error" data-error hidden></p>
        <div class="form-actions"><button type="submit" class="btn">Save name</button></div>
      </form>
      <div class="section">
        <h3>Add the calendar to your phone</h3>
        ${feed}
      </div>
      ${
        viewer.isOrganizer
          ? `<div class="section">
               <h3>Organizer</h3>
               <p class="hint">The invite code new people need, and who has joined.</p>
               <button type="button" class="btn" data-open-group>Invite code and members</button>
             </div>`
          : ''
      }
      <div class="section footer-actions">
        <div class="form-actions">
          <button type="button" class="btn" data-account-signout>Sign out</button>
          <button type="button" class="btn ghost push-right" data-close>Close</button>
        </div>
      </div>`;
  }

  function memberRowHtml(member) {
    const joined = member.joinedAt ? formatShortDate(String(member.joinedAt).slice(0, 10)) : '';
    return `<div class="slot person">
      <div>
        <span class="slot-label">${esc(member.name)}${
          member.isOrganizer ? '<span class="pill">Organizer</span>' : ''
        }${member.removed ? '<span class="pill muted">Removed</span>' : ''}</span>
        <div class="slot-people">${esc(member.email)}${joined ? ` · joined ${esc(joined)}` : ''}</div>
      </div>
      <div class="slot-actions">
        ${
          member.isOrganizer
            ? ''
            : member.removed
              ? `<button type="button" class="btn small" data-member-restore="${esc(member.id)}">Restore</button>`
              : `<button type="button" class="btn link danger" data-member-remove="${esc(member.id)}"
                   data-member-name="${esc(member.name)}">Remove</button>`
        }
      </div>
    </div>`;
  }

  function groupModalHtml(modal) {
    const body = modal.error
      ? `<p class="error">${esc(modal.error)}</p>`
      : modal.loading
        ? '<p class="hint">Loading…</p>'
        : `<form class="signup" data-form="invite">
             <div class="field">
               <label for="invite-code">Invite code</label>
               <input id="invite-code" name="code" minlength="6" maxlength="80" autocomplete="off"
                      value="${esc(modal.inviteCode ?? '')}" required />
               <span class="help">Share it with people you want in the group, along with the calendar link.
                 Capital letters and spaces around it don't matter.</span>
             </div>
             <p class="error" data-error hidden></p>
             <div class="form-actions">
               <button type="submit" class="btn primary">Save code</button>
               <button type="button" class="btn" data-copy-invite>Copy code</button>
             </div>
             <p class="hint">Changing it only affects new accounts; everyone who already joined stays in.</p>
           </form>
           <div class="section">
             <h3>Members <span class="section-note">${esc(
               String(modal.members.filter((m) => !m.removed).length),
             )} in the group</span></h3>
             <p class="hint">Removing someone turns off their access and their calendar feed straight
               away; their past sign-ups stay. If they know the invite code they could still make a new
               account, so change the code too if that matters.</p>
             ${modal.members.map(memberRowHtml).join('') || '<p class="hint">Nobody has joined yet.</p>'}
           </div>`;
    return `
      <div class="modal-head">
        <div>
          <h2 id="modal-title">Invite code and members</h2>
          <p class="when">Only organizers see this.</p>
        </div>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      ${body}
      <div class="section footer-actions">
        <div class="form-actions">
          <button type="button" class="btn" data-open-account>Back to your account</button>
          <button type="button" class="btn ghost push-right" data-close>Close</button>
        </div>
      </div>`;
  }

  async function openGroup() {
    openModal({ type: 'group', loading: true, members: [] });
    try {
      const [inviteCode, members] = await Promise.all([data.getInviteCode(), data.listMembers()]);
      if (state.modal?.type !== 'group') return;
      state.modal = { type: 'group', loading: false, inviteCode, members };
    } catch (err) {
      if (err.signedOut) throw err;
      if (state.modal?.type !== 'group') return;
      state.modal = { type: 'group', loading: false, error: err.message, members: [] };
    }
    renderModal();
  }

  function signupLine(signup, { nested = false } = {}) {
    const details = [signup.item, signup.note].filter(Boolean).join(' — ');
    return `<div class="slot person${nested ? ' nested' : ''}${signup.isMine ? ' mine' : ''}">
      <div>
        <span class="slot-label">${esc(signup.name)}${
          signup.isMine ? '<span class="pill">You</span>' : ''
        }</span>
        ${details ? `<div class="slot-people">${esc(details)}</div>` : ''}
        ${signup.address ? `<div class="slot-people">${esc(signup.address)}</div>` : ''}
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
          <input id="su-name" name="name" maxlength="80" value="${esc(
            state.viewer?.name || remembered.read(NAME_KEY),
          )}" data-autofocus required />
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
      ${
        kind === 'host'
          ? `<div class="field">
              <label for="su-address">Address <span class="help">(optional)</span></label>
              <input id="su-address" name="address" maxlength="200" autocomplete="street-address"
                     placeholder="e.g. 12 Oak St, Augusta, GA 30901" />
              <span class="help">A full street address shows on the map in everyone's calendar.</span>
            </div>`
          : ''
      }
      <div class="field">
        <label for="su-note">Note <span class="help">(optional)</span></label>
        <input id="su-note" name="note" maxlength="280" placeholder="${esc(
          kind === 'host' ? 'Parking, which door to use…' : 'Gluten free, needs oven space…',
        )}" />
      </div>
      <p class="hint">Everyone in the group can see your sign-up. No email is sent.</p>
      <p class="error" data-error hidden></p>
      <div class="form-actions">
        <button type="submit" class="btn primary">${kind === 'host' ? 'Sign up to host' : 'Add sign-up'}</button>
        <button type="button" class="btn ghost" data-cancel-form>Cancel</button>
      </div>
    </form>`;
  }

  function hostSectionHtml(event, modal) {
    if (!event.needsHost && !event.hosts.length) return '';
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
          <p class="when">Visible to everyone in the group.</p>
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
              <label for="ev-start">Start time</label>
              <input id="ev-start" name="startTime" type="time" value="${esc(event?.startTime ?? '18:00')}" />
            </div>
          </div>
          <div class="row">
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
            <label for="ev-location">Location / address</label>
            <input id="ev-location" name="location" maxlength="200" autocomplete="off"
                   placeholder="e.g. 12 Oak St, Augusta, GA 30901" value="${esc(event?.location ?? '')}" />
            <span class="help">A full street address opens in Maps from people's calendars.</span>
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
    const needsHost = values.hosting === 'needed';
    const id = await data.saveEvent(
      {
        id: form.dataset.eventId || null,
        title: values.title,
        date: values.date,
        startTime: values.startTime ?? '',
        endTime: values.endTime ?? '',
        location: needsHost ? '' : (values.location ?? '').trim(),
        description: values.description ?? '',
        needsHost,
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
      address: (values.address ?? '').trim(),
    });
    state.modal.form = null;
    await refresh();
    toast(form.dataset.kind === 'host' ? 'Signed up to host.' : 'Sign-up added.');
  }

  async function submitRenameForm(form) {
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) throw new Error('Enter a name.');
    state.viewer = await data.setName(name);
    renderAuth();
    toast('Name updated.');
  }

  async function submitInviteForm(form) {
    const code = String(new FormData(form).get('code') ?? '').trim();
    if (code.length < 6) throw new Error('Use at least 6 characters, so the code is hard to guess.');
    const saved = await data.setInviteCode(code);
    if (state.modal?.type === 'group') state.modal.inviteCode = saved;
    renderModal();
    toast('Invite code saved.');
  }

  async function signOutEverywhere() {
    state.viewer = await data.signOut();
    state.events = [];
    closeModal();
    showGate('signin', { notice: { tone: 'ok', text: 'Signed out.' } });
  }

  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied.`);
    } catch {
      window.prompt(`Copy this ${what.toLowerCase()}:`, text);
    }
  }
  const copyLink = copyText;

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
      } else if (target.id === 'who' || target.hasAttribute('data-open-account')) {
        if (state.modal) state.modal = null;
        openModal({ type: 'account' });
      } else if (target.id === 'signout-btn' || target.hasAttribute('data-account-signout') ||
                 target.hasAttribute('data-gate-signout')) {
        await signOutEverywhere();
      } else if (target.dataset.gate) {
        const email = el.gate?.querySelector('[name="email"]')?.value ?? '';
        showGate(target.dataset.gate, { values: { email } });
      } else if (target.hasAttribute('data-open-group')) {
        state.modal = null;
        await openGroup();
      } else if (target.hasAttribute('data-copy-invite')) {
        await copyText(state.modal?.inviteCode ?? '', 'Invite code');
      } else if (target.dataset.memberRemove) {
        if (!window.confirm(`Remove ${target.dataset.memberName || 'this person'} from the group? ` +
            'They lose access to the calendar and their calendar feed stops.')) return;
        await data.setMemberRemoved(target.dataset.memberRemove, true);
        await openGroup();
        toast('Member removed.');
      } else if (target.dataset.memberRestore) {
        await data.setMemberRemoved(target.dataset.memberRestore, false);
        await openGroup();
        toast('Member restored.');
      } else if (target.hasAttribute('data-copy-feed')) {
        const links = data.feedLinks?.();
        if (links?.https) await copyText(links.https, 'Calendar link');
      } else if (target.hasAttribute('data-reset-feed')) {
        if (!window.confirm('Make a new calendar link? The old one stops working, so any calendar ' +
            'subscribed with it — yours included — needs the new link.')) return;
        state.viewer = await data.resetFeedToken();
        renderModal();
        toast('New calendar link made. Subscribe again with it.');
      } else if (target.hasAttribute('data-download-feed')) {
        const text = data.feedLinks?.()?.sample?.();
        if (text) {
          const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
          const link = Object.assign(document.createElement('a'), { href: url, download: 'calendar.ics' });
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
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
      if (err.signedOut) signedOut(err);
      else toast(err.message, 'error');
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
      if (form.dataset.form.startsWith('gate-')) await submitGateForm(form);
      else if (form.dataset.form === 'rename') await submitRenameForm(form);
      else if (form.dataset.form === 'invite') await submitInviteForm(form);
      else if (form.dataset.form === 'event') await submitEventForm(form);
      else await submitSignupForm(form);
      // Forms that stay on screen after saving get their button back.
      if (submit?.isConnected) {
        submit.disabled = false;
        submit.textContent = label;
      }
    } catch (err) {
      if (err.signedOut) {
        signedOut(err);
        return;
      }
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
    if (state.viewChosen || state.gate) return;
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
    if (document.visibilityState === 'visible' && !state.loading && !state.gate && state.viewer) {
      refresh().catch(() => {});
    }
  });

  // --- boot ----------------------------------------------------------------

  return (async () => {
    try {
      state.viewer = await data.init();
      await enter();
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
