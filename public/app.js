// The calendar page. All storage goes through the `data` object handed to
// startApp(), which is either Supabase (index.html) or an in-memory stand-in
// (demo.html).

import {
  addMonths,
  formatLongDate,
  formatTime,
  formatTimeRange,
  isoDate,
  monthGrid,
  parseISODate,
  startOfMonth,
} from './lib/dates.js';
import { eventBadges, groupByDate, shapeEvents, upcoming } from './lib/model.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FOOD_PRESETS = ['Main dish', 'Side dish', 'Salad', 'Bread', 'Dessert', 'Drinks', 'Paper goods'];

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
  const state = {
    viewer: null,
    events: [],
    view: window.innerWidth < 720 ? 'list' : 'month',
    cursor: startOfMonth(new Date()),
    modal: null,
  };

  const el = {
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
  };

  let toastTimer;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 3600);
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

  // --- chrome --------------------------------------------------------------

  function renderAuth() {
    const organizer = Boolean(state.viewer?.isOrganizer);
    el.who.hidden = !organizer;
    el.who.textContent = organizer ? `Organizer: ${state.viewer.name || state.viewer.email}` : '';
    el.signOut.hidden = !organizer;
    el.newEvent.hidden = !organizer;
    el.signIn.hidden = organizer;
  }

  function render() {
    renderAuth();
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
  }

  function badgeHtml(badges) {
    if (!badges.length) return '';
    return `<div class="badges">${badges
      .map((b) => `<span class="badge${b.warn ? ' warn' : ''}">${esc(b.text)}</span>`)
      .join('')}</div>`;
  }

  function renderMonth() {
    const byDate = groupByDate(state.events);
    const todayKey = isoDate(new Date());
    let html = `<div class="weekdays">${WEEKDAYS.map((d) => `<div>${d}</div>`).join('')}</div>`;

    for (const week of monthGrid(state.cursor)) {
      html += '<div class="weeks-row">';
      for (const cell of week) {
        const events = byDate.get(cell.key) ?? [];
        html += `<div class="day${cell.outside ? ' outside' : ''}${cell.key === todayKey ? ' today' : ''}">
          <span class="day-number">${cell.dayOfMonth}</span>
          ${events
            .map(
              (event) => `<button type="button" class="chip${
                event.needsHost && event.hostSpotsLeft > 0 ? ' needs-host' : ''
              }" data-event="${esc(event.id)}">
                <strong>${esc(event.title)}</strong>
                <span class="chip-meta">${esc(event.startTime ? formatTime(event.startTime) : 'Time TBD')}${
                  event.needsHost && event.hostSpotsLeft > 0 ? ' · needs host' : ''
                }</span>
              </button>`,
            )
            .join('')}
        </div>`;
      }
      html += '</div>';
    }
    el.calendar.innerHTML = html;
  }

  function renderAgenda() {
    const list = upcoming(state.events, isoDate(new Date()));
    if (!list.length) {
      el.agenda.innerHTML = `<p class="empty">No upcoming events yet.${
        state.viewer?.isOrganizer ? ' Use “New event” to add the first one.' : ''
      }</p>`;
      return;
    }
    el.agenda.innerHTML = list
      .map(
        (event) => `<button type="button" class="agenda-card" data-event="${esc(event.id)}">
          <p class="when">${esc(formatLongDate(event.date))} · ${esc(formatTimeRange(event))}</p>
          <h3>${esc(event.title)}</h3>
          ${event.location ? `<p class="when">${esc(event.location)}</p>` : ''}
          ${badgeHtml(eventBadges(event))}
        </button>`,
      )
      .join('');
  }

  // --- modals --------------------------------------------------------------

  function openModal(modal) {
    state.modal = modal;
    renderModal();
  }

  function closeModal() {
    state.modal = null;
    el.modalRoot.hidden = true;
    el.modalRoot.innerHTML = '';
    if (location.hash.startsWith('#event=')) history.replaceState(null, '', location.pathname);
  }

  function renderModal() {
    const modal = state.modal;
    if (!modal) {
      closeModal();
      return;
    }
    let html = '';
    if (modal.type === 'login') html = loginModalHtml();
    else if (modal.type === 'eventForm') html = eventFormHtml(modal.eventId ? eventById(modal.eventId) : null);
    else {
      const event = eventById(modal.eventId);
      if (!event) {
        closeModal();
        return;
      }
      html = eventModalHtml(event, modal);
    }
    el.modalRoot.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    el.modalRoot.hidden = false;
    el.modalRoot.querySelector('[data-autofocus]')?.focus();
  }

  function loginModalHtml() {
    return `
      <div class="modal-head">
        <div><h2>Organizer sign in</h2><p class="when">Only organizers can add or change events.</p></div>
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

  function signupLine(signup, { nested = false } = {}) {
    const details = [signup.item, signup.note].filter(Boolean).join(' — ');
    return `<div class="slot person${nested ? ' nested' : ''}">
      <div>
        <span class="slot-label">${esc(signup.name)}</span>
        ${details ? `<div class="slot-people">${esc(details)}</div>` : ''}
        ${signup.contact ? `<div class="slot-people">${esc(signup.contact)}</div>` : ''}
      </div>
      <div class="slot-actions">
        ${
          signup.canManage
            ? `<button type="button" class="btn link danger" data-cancel-signup="${esc(signup.id)}">Cancel</button>`
            : ''
        }
      </div>
    </div>`;
  }

  function signupFormHtml({ kind, slotId = '', slotLabel = '', needsItem }) {
    return `<form class="signup" data-form="signup" data-kind="${esc(kind)}" data-slot="${esc(slotId)}">
      ${slotLabel ? `<p class="hint">Signing up for <strong>${esc(slotLabel)}</strong></p>` : ''}
      <div class="row">
        <div class="field">
          <label for="su-name">Your name</label>
          <input id="su-name" name="name" value="${esc(remembered.read('cg_name'))}" data-autofocus required />
        </div>
        <div class="field">
          <label for="su-contact">Phone or email <span class="help">(optional)</span></label>
          <input id="su-contact" name="contact" value="${esc(remembered.read('cg_contact'))}" />
        </div>
      </div>
      ${
        needsItem
          ? `<div class="field">
              <label for="su-item">What will you bring?</label>
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
      <p class="error" data-error hidden></p>
      <div class="form-actions">
        <button type="submit" class="btn primary">${kind === 'host' ? 'Sign up to host' : "I'll bring this"}</button>
        <button type="button" class="btn ghost" data-cancel-form>Cancel</button>
      </div>
    </form>`;
  }

  function hostSectionHtml(event, modal) {
    if (!event.needsHost) return '';
    const formOpen = modal.form?.kind === 'host';
    return `<div class="section">
      <h3>Host</h3>
      ${
        event.hosts.length
          ? event.hosts.map((h) => signupLine(h)).join('')
          : '<p class="hint">Nobody has offered to host yet.</p>'
      }
      ${
        event.hostSpotsLeft > 0 && !formOpen
          ? `<button type="button" class="btn primary" data-open-form="host">Sign up to host${
              event.hostLimit > 1 ? ` (${event.hostSpotsLeft} left)` : ''
            }</button>`
          : ''
      }
      ${formOpen ? signupFormHtml({ kind: 'host', needsItem: false }) : ''}
    </div>`;
  }

  function foodSectionHtml(event, modal) {
    const form = modal.form?.kind === 'food' ? modal.form : null;
    const slots = event.foodSlots
      .map((slot) => {
        const openForm = form && form.slotId === slot.id;
        return `<div>
          <div class="slot">
            <div>
              <span class="slot-label">${esc(slot.label)}</span>
              <div class="slot-people ${slot.hasRoom ? '' : 'taken'}">${
                slot.unlimited
                  ? `${slot.taken} signed up — anyone can add`
                  : slot.hasRoom
                    ? `${slot.taken} of ${slot.capacity} filled`
                    : 'covered'
              }</div>
            </div>
            <div class="slot-actions">
              ${
                slot.hasRoom && !openForm
                  ? `<button type="button" class="btn" data-open-form="food" data-slot="${esc(
                      slot.id,
                    )}" data-slot-label="${esc(slot.label)}">I'll bring this</button>`
                  : ''
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
      <h3>Food</h3>
      ${event.foodSlots.length ? slots : '<p class="hint">No specific food slots — bring whatever you like.</p>'}
      ${
        event.otherFood.length
          ? `<p class="hint">Also coming:</p>${event.otherFood.map((p) => signupLine(p)).join('')}`
          : ''
      }
      ${
        event.allowOtherFood && !otherFormOpen
          ? '<button type="button" class="btn" data-open-form="food">Bring something else</button>'
          : ''
      }
      ${otherFormOpen ? signupFormHtml({ kind: 'food', needsItem: true }) : ''}
    </div>`;
  }

  function eventModalHtml(event, modal) {
    return `
      <div class="modal-head">
        <div>
          <h2>${esc(event.title)}</h2>
          <p class="when">${esc(formatLongDate(event.date))} · ${esc(formatTimeRange(event))}</p>
          ${event.location ? `<p class="when">${esc(event.location)}</p>` : ''}
        </div>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      ${event.description ? `<p class="description">${esc(event.description)}</p>` : ''}
      ${badgeHtml(eventBadges(event))}
      ${hostSectionHtml(event, modal)}
      ${foodSectionHtml(event, modal)}
      <div class="section">
        <div class="form-actions">
          <button type="button" class="btn link" data-copy-event="${esc(event.id)}">Copy link to this event</button>
          ${
            state.viewer?.isOrganizer
              ? `<button type="button" class="btn" data-edit-event="${esc(event.id)}">Edit event</button>
                 <button type="button" class="btn danger" data-delete-event="${esc(event.id)}">Delete event</button>`
              : ''
          }
        </div>
      </div>`;
  }

  function slotEditorRow(slot = { label: '', capacity: 1, id: '' }) {
    return `<div class="slot-editor-row" data-slot-row>
      <input name="slot-label" placeholder="e.g. Main dish" value="${esc(slot.label)}" />
      <input name="slot-capacity" type="number" min="0" value="${esc(
        Number.isInteger(slot.capacity) ? slot.capacity : 1,
      )}" aria-label="How many people can bring this — 0 for no limit" />
      <input type="hidden" name="slot-id" value="${esc(slot.id ?? '')}" />
      <button type="button" class="btn link danger" data-remove-slot>Remove</button>
    </div>`;
  }

  function eventFormHtml(event) {
    const editing = Boolean(event);
    const slots = editing && event.foodSlots.length ? event.foodSlots : [{ label: 'Main dish', capacity: 1, id: '' }];
    return `
      <div class="modal-head">
        <h2>${editing ? 'Edit event' : 'New event'}</h2>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      <form class="signup" data-form="event" data-event-id="${esc(event?.id ?? '')}">
        <div class="field">
          <label for="ev-title">Title</label>
          <input id="ev-title" name="title" value="${esc(event?.title ?? '')}" data-autofocus required />
        </div>
        <div class="row">
          <div class="field">
            <label for="ev-date">Date</label>
            <input id="ev-date" name="date" type="date" value="${esc(event?.date ?? isoDate(new Date()))}" required />
          </div>
          <div class="field">
            <label for="ev-location">Location <span class="help">(optional)</span></label>
            <input id="ev-location" name="location" value="${esc(event?.location ?? '')}" />
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
          <textarea id="ev-description" name="description">${esc(event?.description ?? '')}</textarea>
        </div>
        <div class="checkbox">
          <input id="ev-needs-host" name="needsHost" type="checkbox" ${
            event ? (event.needsHost ? 'checked' : '') : 'checked'
          } />
          <label for="ev-needs-host">This event needs a host</label>
        </div>
        <div class="field">
          <label for="ev-host-limit">How many hosts</label>
          <input id="ev-host-limit" name="hostLimit" type="number" min="1" value="${esc(event?.hostLimit || 1)}" />
        </div>
        <div class="field">
          <label>Food slots <span class="help">People pick one of these and say what they'll bring. Add as many as
            you like; the number beside each is how many people can claim it — set it to 0 for no limit.</span></label>
          <div class="slot-editor" data-slot-editor>${slots.map((s) => slotEditorRow(s)).join('')}</div>
          <div class="form-actions">
            <button type="button" class="btn" data-add-slot>+ Add slot</button>
            ${FOOD_PRESETS.map(
              (p) => `<button type="button" class="btn link" data-preset="${esc(p)}">${esc(p)}</button>`,
            ).join('')}
          </div>
        </div>
        <div class="checkbox">
          <input id="ev-other-food" name="allowOtherFood" type="checkbox" ${
            event ? (event.allowOtherFood ? 'checked' : '') : 'checked'
          } />
          <label for="ev-other-food">Let people bring something outside these slots</label>
        </div>
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
        capacity: Math.max(0, Number(row.querySelector('[name="slot-capacity"]').value) || 0),
      }))
      .filter((slot) => slot.label);
  }

  function showFormError(form, message) {
    const target = form.querySelector('[data-error]');
    if (!target) {
      toast(message);
      return;
    }
    target.textContent = message;
    target.hidden = false;
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
    remembered.write('cg_name', values.name?.trim());
    remembered.write('cg_contact', values.contact?.trim() ?? '');
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
    toast(form.dataset.kind === 'host' ? "You're signed up to host." : 'Thanks — added to the list.');
  }

  async function submitLoginForm(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    const viewer = await data.signIn(values.email, values.password);
    state.viewer = viewer;
    closeModal();
    await refresh({ keepModal: false });
    toast(`Signed in as ${viewer.name || viewer.email}.`);
  }

  async function copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied.');
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
        render();
      } else if (target.id === 'prev' || target.id === 'next') {
        state.cursor = addMonths(state.cursor, target.id === 'prev' ? -1 : 1);
        render();
      } else if (target.id === 'today') {
        state.cursor = startOfMonth(new Date());
        render();
      } else if (target.id === 'share-btn') {
        await copyLink(location.origin + location.pathname);
      } else if (target.id === 'signin-btn') {
        openModal({ type: 'login' });
      } else if (target.id === 'signout-btn') {
        state.viewer = await data.signOut();
        closeModal();
        await refresh({ keepModal: false });
        toast('Signed out.');
      } else if (target.id === 'new-event-btn') {
        openModal({ type: 'eventForm', eventId: null });
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
        await copyLink(`${location.origin}${location.pathname}#event=${target.dataset.copyEvent}`);
      } else if (target.dataset.editEvent) {
        openModal({ type: 'eventForm', eventId: target.dataset.editEvent });
      } else if (target.dataset.deleteEvent) {
        if (!window.confirm('Delete this event and everyone who signed up for it?')) return;
        await data.deleteEvent(target.dataset.deleteEvent);
        closeModal();
        await refresh({ keepModal: false });
        toast('Event deleted.');
      } else if (target.dataset.cancelSignup) {
        if (!window.confirm('Remove this sign-up?')) return;
        await data.deleteSignup(target.dataset.cancelSignup);
        await refresh();
        toast('Sign-up removed.');
      } else if (target.hasAttribute('data-add-slot')) {
        target.closest('form').querySelector('[data-slot-editor]').insertAdjacentHTML('beforeend', slotEditorRow());
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
        else editor.insertAdjacentHTML('beforeend', slotEditorRow({ label: target.dataset.preset, capacity: 1, id: '' }));
      } else if (target.hasAttribute('data-remove-slot')) {
        target.closest('[data-slot-row]').remove();
      }
    } catch (err) {
      toast(err.message);
    }
  });

  document.addEventListener('submit', async (domEvent) => {
    const form = domEvent.target;
    if (!form.dataset.form) return;
    domEvent.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      if (form.dataset.form === 'login') await submitLoginForm(form);
      else if (form.dataset.form === 'event') await submitEventForm(form);
      else await submitSignupForm(form);
    } catch (err) {
      showFormError(form, err.message);
      if (submit) submit.disabled = false;
    }
  });

  el.modalRoot.addEventListener('click', (domEvent) => {
    if (domEvent.target === el.modalRoot) closeModal();
  });

  document.addEventListener('keydown', (domEvent) => {
    if (domEvent.key === 'Escape' && state.modal) closeModal();
  });

  // Someone else may have taken the last main dish while this tab sat open.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh().catch(() => {});
  });

  // --- boot ----------------------------------------------------------------

  return (async () => {
    try {
      state.viewer = await data.init();
      await reload();
      const deepLink = location.hash.match(/^#event=(.+)$/);
      if (deepLink) {
        const event = eventById(decodeURIComponent(deepLink[1]));
        if (event) {
          state.cursor = startOfMonth(parseISODate(event.date));
          state.modal = { type: 'event', eventId: event.id, form: null };
        }
      }
      render();
      renderModal();
    } catch (err) {
      if (onError) onError(err);
      else el.calendar.innerHTML = `<p class="empty">Could not load the calendar: ${esc(err.message)}</p>`;
    }
  })();
}
