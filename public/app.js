const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FOOD_PRESETS = ['Main dish', 'Side dish', 'Salad', 'Bread', 'Dessert', 'Drinks', 'Paper goods'];

const state = {
  appName: 'Community Group Calendar',
  organizer: null,
  events: [],
  view: window.innerWidth < 720 ? 'list' : 'month',
  cursor: startOfMonth(new Date()),
  modal: null,
};

const el = {
  appName: document.getElementById('app-name'),
  calendar: document.getElementById('calendar'),
  agenda: document.getElementById('agenda'),
  period: document.getElementById('period'),
  modalRoot: document.getElementById('modal-root'),
  toast: document.getElementById('toast'),
  who: document.getElementById('who'),
  signIn: document.getElementById('signin-btn'),
  signOut: document.getElementById('signout-btn'),
  newEvent: document.getElementById('new-event-btn'),
  share: document.getElementById('share-btn'),
};

// --- small helpers ---------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseISODate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function formatTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${pad(m)} ${suffix}`;
}

function formatTimeRange(event) {
  if (!event.startTime) return 'Time TBD';
  return event.endTime ? `${formatTime(event.startTime)} – ${formatTime(event.endTime)}` : formatTime(event.startTime);
}

function formatLongDate(value) {
  return parseISODate(value).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function participantKey() {
  let key = localStorage.getItem('cg_participant_key');
  if (!key) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem('cg_participant_key', key);
  }
  return key;
}

const remembered = {
  get name() {
    return localStorage.getItem('cg_name') ?? '';
  },
  get contact() {
    return localStorage.getItem('cg_contact') ?? '';
  },
  remember(name, contact) {
    if (name) localStorage.setItem('cg_name', name);
    if (contact !== undefined) localStorage.setItem('cg_contact', contact);
  },
};

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3200);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-participant-key': participantKey() };
  if (method !== 'GET') headers['x-cg-app'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// --- data ------------------------------------------------------------------

async function loadConfig() {
  const data = await api('/config');
  state.appName = data.appName;
  state.organizer = data.organizer;
  document.title = data.appName;
  el.appName.textContent = data.appName;
  renderAuth();
}

async function loadEvents() {
  const data = await api('/events');
  state.events = data.events;
}

function eventById(id) {
  return state.events.find((e) => e.id === id);
}

async function refresh({ keepModal = true } = {}) {
  await loadEvents();
  render();
  if (keepModal) renderModal();
}

// --- rendering: chrome -----------------------------------------------------

function renderAuth() {
  const signedIn = Boolean(state.organizer);
  el.who.hidden = !signedIn;
  el.who.textContent = signedIn ? `Organizer: ${state.organizer}` : '';
  el.signOut.hidden = !signedIn;
  el.newEvent.hidden = !signedIn;
  el.signIn.hidden = signedIn;
}

function render() {
  el.period.textContent = state.cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const monthView = state.view === 'month';
  el.calendar.hidden = !monthView;
  el.agenda.hidden = monthView;
  document.querySelector('.period-nav').hidden = !monthView;
  for (const button of document.querySelectorAll('.btn.toggle')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }
  if (monthView) renderMonth();
  else renderAgenda();
}

function eventBadges(event) {
  const badges = [];
  if (event.needsHost) {
    badges.push(
      event.hostSpotsLeft > 0
        ? { text: event.hostLimit > 1 ? `Needs ${event.hostSpotsLeft} host(s)` : 'Needs a host', warn: true }
        : { text: `Host: ${event.hosts.map((h) => h.name).join(', ')}`, warn: false },
    );
  }
  const open = event.foodSlots.reduce((sum, slot) => sum + Math.max(0, slot.capacity - slot.taken), 0);
  if (open > 0) badges.push({ text: `${open} food slot${open === 1 ? '' : 's'} open`, warn: true });
  else if (event.foodSlots.length) badges.push({ text: 'Food covered', warn: false });
  if (event.food.length) badges.push({ text: `${event.food.length} bringing food`, warn: false });
  return badges;
}

function badgeHtml(badges) {
  if (!badges.length) return '';
  return `<div class="badges">${badges
    .map((b) => `<span class="badge${b.warn ? ' warn' : ''}">${esc(b.text)}</span>`)
    .join('')}</div>`;
}

function renderMonth() {
  const first = startOfMonth(state.cursor);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
  const todayKey = isoDate(new Date());

  const byDate = new Map();
  for (const event of state.events) {
    if (!byDate.has(event.date)) byDate.set(event.date, []);
    byDate.get(event.date).push(event);
  }

  let html = `<div class="weekdays">${WEEKDAYS.map((d) => `<div>${d}</div>`).join('')}</div>`;
  for (let week = 0; week < weeks; week += 1) {
    html += '<div class="weeks-row">';
    for (let day = 0; day < 7; day += 1) {
      const cursor = new Date(gridStart);
      cursor.setDate(gridStart.getDate() + week * 7 + day);
      const key = isoDate(cursor);
      const outside = cursor.getMonth() !== first.getMonth();
      const events = byDate.get(key) ?? [];
      html += `<div class="day${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}">
        <span class="day-number">${cursor.getDate()}</span>
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
  const todayKey = isoDate(new Date());
  const upcoming = state.events.filter((e) => e.date >= todayKey);
  if (!upcoming.length) {
    el.agenda.innerHTML = `<p class="empty">No upcoming events yet.${
      state.organizer ? ' Use “New event” to add the first one.' : ''
    }</p>`;
    return;
  }
  el.agenda.innerHTML = upcoming
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

// --- rendering: modals -----------------------------------------------------

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
  else if (modal.type === 'event') {
    const event = eventById(modal.eventId);
    if (!event) {
      closeModal();
      return;
    }
    html = eventModalHtml(event, modal);
  }
  el.modalRoot.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  el.modalRoot.hidden = false;
  const focusTarget = el.modalRoot.querySelector('[data-autofocus]');
  if (focusTarget) focusTarget.focus();
}

function loginModalHtml() {
  return `
    <div class="modal-head">
      <div><h2>Organizer sign in</h2><p class="when">Only organizers can add or change events.</p></div>
      <button type="button" class="close" data-close aria-label="Close">&times;</button>
    </div>
    <form class="signup" data-form="login">
      <div class="field">
        <label for="login-name">Organizer name</label>
        <input id="login-name" name="name" autocomplete="username" data-autofocus required />
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
        <input id="su-name" name="name" value="${esc(remembered.name)}" data-autofocus required />
      </div>
      <div class="field">
        <label for="su-contact">Phone or email <span class="help">(optional)</span></label>
        <input id="su-contact" name="contact" value="${esc(remembered.contact)}" />
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
      <input id="su-note" name="note" placeholder="${esc(kind === 'host' ? 'Address, parking notes…' : 'Gluten free, needs oven space…')}" />
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
  const open = event.hostSpotsLeft > 0;
  const formOpen = modal.form?.kind === 'host';
  return `<div class="section">
    <h3>Host</h3>
    ${
      event.hosts.length
        ? event.hosts.map((h) => signupLine(h)).join('')
        : '<p class="hint">Nobody has offered to host yet.</p>'
    }
    ${
      open && !formOpen
        ? `<button type="button" class="btn primary" data-open-form="host">Sign up to host${
            event.hostLimit > 1 ? ` (${event.hostSpotsLeft} left)` : ''
          }</button>`
        : ''
    }
    ${formOpen ? signupFormHtml({ kind: 'host', needsItem: false }) : ''}
  </div>`;
}

function foodSectionHtml(event, modal) {
  const bySlot = new Map();
  for (const signup of event.food) {
    const key = signup.slotId ?? 'other';
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(signup);
  }
  const form = modal.form?.kind === 'food' ? modal.form : null;

  const slots = event.foodSlots
    .map((slot) => {
      const people = bySlot.get(slot.id) ?? [];
      const room = slot.capacity - people.length;
      const openForm = form && form.slotId === slot.id;
      return `<div>
        <div class="slot">
          <div>
            <span class="slot-label">${esc(slot.label)}</span>
            <div class="slot-people ${room > 0 ? '' : 'taken'}">${
              room > 0 ? `${people.length} of ${slot.capacity} filled` : 'covered'
            }</div>
          </div>
          <div class="slot-actions">
            ${
              room > 0 && !openForm
                ? `<button type="button" class="btn" data-open-form="food" data-slot="${esc(slot.id)}" data-slot-label="${esc(
                    slot.label,
                  )}">I'll bring this</button>`
                : ''
            }
          </div>
        </div>
        ${people.map((p) => signupLine(p, { nested: true })).join('')}
        ${openForm ? signupFormHtml({ kind: 'food', slotId: slot.id, slotLabel: slot.label, needsItem: true }) : ''}
      </div>`;
    })
    .join('');

  const others = bySlot.get('other') ?? [];
  const otherFormOpen = form && !form.slotId;
  return `<div class="section">
    <h3>Food</h3>
    ${event.foodSlots.length ? slots : '<p class="hint">No specific food slots — bring whatever you like.</p>'}
    ${others.length ? `<p class="hint">Also coming:</p>${others.map((p) => signupLine(p)).join('')}` : ''}
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
          state.organizer
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
    <input name="slot-capacity" type="number" min="1" max="50" value="${esc(slot.capacity || 1)}" aria-label="How many people" />
    <input type="hidden" name="slot-id" value="${esc(slot.id)}" />
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
        <input id="ev-needs-host" name="needsHost" type="checkbox" ${event ? (event.needsHost ? 'checked' : '') : 'checked'} />
        <label for="ev-needs-host">This event needs a host</label>
      </div>
      <div class="field">
        <label for="ev-host-limit">How many hosts</label>
        <input id="ev-host-limit" name="hostLimit" type="number" min="1" max="20" value="${esc(event?.hostLimit || 1)}" />
      </div>
      <div class="field">
        <label>Food slots <span class="help">People pick one of these and say what they'll bring.</span></label>
        <div class="slot-editor" data-slot-editor>${slots.map((s) => slotEditorRow(s)).join('')}</div>
        <div class="form-actions">
          <button type="button" class="btn" data-add-slot>+ Add slot</button>
          ${FOOD_PRESETS.map((p) => `<button type="button" class="btn link" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}
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

// --- actions ---------------------------------------------------------------

function collectSlots(form) {
  return [...form.querySelectorAll('[data-slot-row]')]
    .map((row) => ({
      id: row.querySelector('[name="slot-id"]').value,
      label: row.querySelector('[name="slot-label"]').value.trim(),
      capacity: Number(row.querySelector('[name="slot-capacity"]').value || 1),
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
  const data = Object.fromEntries(new FormData(form).entries());
  const payload = {
    title: data.title,
    date: data.date,
    startTime: data.startTime ?? '',
    endTime: data.endTime ?? '',
    location: data.location ?? '',
    description: data.description ?? '',
    needsHost: form.querySelector('[name="needsHost"]').checked,
    hostLimit: Number(data.hostLimit || 1),
    allowOtherFood: form.querySelector('[name="allowOtherFood"]').checked,
    foodSlots: collectSlots(form),
  };
  const id = form.dataset.eventId;
  const result = id
    ? await api(`/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload })
    : await api('/events', { method: 'POST', body: payload });
  await loadEvents();
  render();
  openModal({ type: 'event', eventId: result.event.id, form: null });
  toast(id ? 'Event updated.' : 'Event created.');
}

async function submitSignupForm(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const eventId = state.modal.eventId;
  remembered.remember(data.name?.trim(), data.contact?.trim() ?? '');
  await api(`/events/${encodeURIComponent(eventId)}/signups`, {
    method: 'POST',
    body: {
      kind: form.dataset.kind,
      slotId: form.dataset.slot || null,
      name: data.name,
      contact: data.contact ?? '',
      item: data.item ?? '',
      note: data.note ?? '',
    },
  });
  state.modal.form = null;
  await refresh();
  toast(form.dataset.kind === 'host' ? "You're signed up to host." : 'Thanks — added to the list.');
}

async function submitLoginForm(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const result = await api('/session', { method: 'POST', body: { name: data.name, password: data.password } });
  state.organizer = result.organizer;
  renderAuth();
  closeModal();
  await refresh({ keepModal: false });
  toast(`Signed in as ${result.organizer}.`);
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied.');
  } catch {
    window.prompt('Copy this link:', url);
  }
}

// --- events ----------------------------------------------------------------

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;

  try {
    if (target.dataset.view) {
      state.view = target.dataset.view;
      render();
      return;
    }
    if (target.id === 'prev' || target.id === 'next') {
      const delta = target.id === 'prev' ? -1 : 1;
      state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + delta, 1);
      render();
      return;
    }
    if (target.id === 'today') {
      state.cursor = startOfMonth(new Date());
      render();
      return;
    }
    if (target.id === 'share-btn') {
      await copyLink(location.origin + location.pathname);
      return;
    }
    if (target.id === 'signin-btn') {
      openModal({ type: 'login' });
      return;
    }
    if (target.id === 'signout-btn') {
      await api('/session', { method: 'DELETE' });
      state.organizer = null;
      renderAuth();
      await refresh({ keepModal: false });
      toast('Signed out.');
      return;
    }
    if (target.id === 'new-event-btn') {
      openModal({ type: 'eventForm', eventId: null });
      return;
    }
    if (target.dataset.event) {
      history.replaceState(null, '', `#event=${target.dataset.event}`);
      openModal({ type: 'event', eventId: target.dataset.event, form: null });
      return;
    }
    if (target.hasAttribute('data-close')) {
      closeModal();
      return;
    }
    if (target.dataset.openForm) {
      state.modal.form = { kind: target.dataset.openForm, slotId: target.dataset.slot || null };
      renderModal();
      return;
    }
    if (target.hasAttribute('data-cancel-form')) {
      state.modal.form = null;
      renderModal();
      return;
    }
    if (target.dataset.copyEvent) {
      await copyLink(`${location.origin}${location.pathname}#event=${target.dataset.copyEvent}`);
      return;
    }
    if (target.dataset.editEvent) {
      openModal({ type: 'eventForm', eventId: target.dataset.editEvent });
      return;
    }
    if (target.dataset.deleteEvent) {
      if (!window.confirm('Delete this event and everyone who signed up for it?')) return;
      await api(`/events/${encodeURIComponent(target.dataset.deleteEvent)}`, { method: 'DELETE' });
      closeModal();
      await refresh({ keepModal: false });
      toast('Event deleted.');
      return;
    }
    if (target.dataset.cancelSignup) {
      if (!window.confirm('Remove this sign-up?')) return;
      await api(`/signups/${encodeURIComponent(target.dataset.cancelSignup)}`, { method: 'DELETE' });
      await refresh();
      toast('Sign-up removed.');
      return;
    }
    if (target.hasAttribute('data-add-slot')) {
      target.closest('form').querySelector('[data-slot-editor]').insertAdjacentHTML('beforeend', slotEditorRow());
      return;
    }
    if (target.dataset.preset) {
      const editor = target.closest('form').querySelector('[data-slot-editor]');
      const existing = [...editor.querySelectorAll('[name="slot-label"]')];
      const match = existing.find((input) => input.value.trim().toLowerCase() === target.dataset.preset.toLowerCase());
      if (match) {
        match.focus();
        return;
      }
      const blank = existing.find((input) => !input.value.trim());
      if (blank) blank.value = target.dataset.preset;
      else editor.insertAdjacentHTML('beforeend', slotEditorRow({ label: target.dataset.preset, capacity: 1, id: '' }));
      return;
    }
    if (target.hasAttribute('data-remove-slot')) {
      target.closest('[data-slot-row]').remove();
      return;
    }
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.dataset.form) return;
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (form.dataset.form === 'login') await submitLoginForm(form);
    else if (form.dataset.form === 'event') await submitEventForm(form);
    else if (form.dataset.form === 'signup') await submitSignupForm(form);
  } catch (err) {
    showFormError(form, err.message);
    if (submit) submit.disabled = false;
  }
});

el.modalRoot.addEventListener('click', (event) => {
  if (event.target === el.modalRoot) closeModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.modal) closeModal();
});

// --- boot ------------------------------------------------------------------

async function start() {
  try {
    await loadConfig();
    await loadEvents();
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
    el.calendar.innerHTML = `<p class="empty">Could not load the calendar: ${esc(err.message)}</p>`;
  }
}

start();
