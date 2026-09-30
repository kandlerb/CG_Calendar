// The calendar in a real browser, on the demo's in-memory data. The demo
// seeds "Community Group — Week 1" (needs a host; Main dish, Side dish with
// Marisol's elote salad, Dessert), "Fall Cookout" (host arranged) and, a week
// ago, "Community Group — Week 0".
import { expect, test } from '@playwright/test';

const DINNER = 'demo-event-dinner';
const COOKOUT = 'demo-event-cookout';
const LAST_WEEK = 'demo-event-last-week';

const dialog = (page) => page.locator('.modal');
const slotGroup = (page, label) =>
  dialog(page).locator('.slot-group').filter({ has: page.locator('.slot-label', { hasText: label }) });

const onDemo = (page) => page.url().includes('/demo.html');

/** Opens an event by its link. Once the page is up, only the hash changes: a
 * reload would reset the demo's in-memory data, organizer sign-in included. */
async function openEvent(page, id) {
  if (onDemo(page)) await page.evaluate((eventId) => (location.hash = `event=${eventId}`), id);
  else await page.goto(`/demo.html#event=${id}`);
  await expect(dialog(page)).toBeVisible();
}

async function signInAsOrganizer(page) {
  if (!onDemo(page)) await page.goto('/demo.html');
  await page.getByRole('button', { name: 'Organizer sign in' }).click();
  await page.getByLabel('Email').fill('org@example.com');
  await page.getByLabel('Password').fill('anything');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#who')).toBeVisible();
}

/** Makes the page believe the tab was hidden and shown again, long after it loaded. */
async function comeBackToTab(page) {
  await page.clock.fastForward('02:00');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  // Keep the "How to use" panel out of the way.
  await page.addInitScript(() => localStorage.setItem('cg_intro_dismissed', '1'));
});

test('a visitor signs up for a food slot and sees it marked as theirs', async ({ page }) => {
  await openEvent(page, DINNER);
  await slotGroup(page, 'Main dish').getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Your name').fill('Jordan');
  await page.getByLabel('What you will bring').fill('Lasagna');
  await page.getByRole('button', { name: 'Add sign-up' }).click();

  const mine = slotGroup(page, 'Main dish').locator('.person.mine');
  await expect(mine).toContainText('Jordan');
  await expect(mine).toContainText('Lasagna');
  await expect(mine.locator('.pill')).toHaveText('You');
  await expect(dialog(page).locator('.yours')).toContainText('Lasagna');
});

test('a name or dish of only spaces is refused with a plain message', async ({ page }) => {
  await openEvent(page, DINNER);
  await slotGroup(page, 'Main dish').getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Your name').fill('   ');
  await page.getByLabel('What you will bring').fill('Pie');
  await page.getByRole('button', { name: 'Add sign-up' }).click();
  await expect(dialog(page).locator('[data-error]')).toHaveText('Enter your name.');
});

test('contact details are shown to organizers but not to other visitors', async ({ page }) => {
  await openEvent(page, DINNER);
  await expect(slotGroup(page, 'Side dish')).toContainText('Marisol');
  await expect(dialog(page)).not.toContainText('marisol@example.com');

  await page.keyboard.press('Escape');
  await signInAsOrganizer(page);
  await openEvent(page, DINNER);
  await expect(slotGroup(page, 'Side dish')).toContainText('marisol@example.com');
});

test('coming back to the tab keeps a half-typed sign-up', async ({ page }) => {
  await openEvent(page, DINNER);
  await slotGroup(page, 'Dessert').getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Your name').fill('Jordan');
  await page.getByLabel('What you will bring').fill('Brownies');

  await comeBackToTab(page);

  await expect(page.getByLabel('What you will bring')).toHaveValue('Brownies');
  await expect(page.getByLabel('Your name')).toHaveValue('Jordan');
});

test('Escape asks before throwing away typed text, and not when nothing was typed', async ({ page }) => {
  await openEvent(page, DINNER);
  // Nothing typed yet: closes straight away.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);

  await openEvent(page, DINNER);
  await slotGroup(page, 'Dessert').getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('What you will bring').fill('Brownies');

  page.once('dialog', (d) => d.dismiss());
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('What you will bring')).toHaveValue('Brownies');

  page.once('dialog', (d) => d.accept());
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test('Cancel discards without asking', async ({ page }) => {
  await signInAsOrganizer(page);
  await page.getByRole('button', { name: '+ New event' }).click();
  await page.getByLabel('Title').fill('Picnic');
  page.once('dialog', () => {
    throw new Error('Cancel should not ask');
  });
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('editing an event with no food slots does not add one back', async ({ page }) => {
  await signInAsOrganizer(page);
  await openEvent(page, COOKOUT);
  await page.getByRole('button', { name: 'Edit event' }).click();
  const rows = dialog(page).locator('[data-slot-row]');
  await expect(rows).toHaveCount(3);
  while ((await rows.count()) > 0) {
    await rows.first().getByRole('button', { name: 'Remove this slot' }).click();
  }
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog(page)).toContainText('No slots are set for this event');

  await page.getByRole('button', { name: 'Edit event' }).click();
  await expect(dialog(page).locator('[data-slot-row]')).toHaveCount(0);
  await page.getByLabel('Title').fill('Fall Cookout (moved)');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog(page)).toContainText('No slots are set for this event');
});

test('an end time before the start time is caught before saving', async ({ page }) => {
  await signInAsOrganizer(page);
  await page.getByRole('button', { name: '+ New event' }).click();
  await page.getByLabel('Title').fill('Backwards');
  await page.getByLabel('Start time').fill('19:00');
  await page.getByLabel('End time').fill('18:00');
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(dialog(page).locator('[data-error]')).toHaveText('The end time is before the start time.');
});

test('text fields stop at the length the database allows', async ({ page }) => {
  await openEvent(page, DINNER);
  await slotGroup(page, 'Main dish').getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Your name').fill('x'.repeat(200));
  await expect(page.getByLabel('Your name')).toHaveValue('x'.repeat(80));
});

test('a link to an event opens it, including one pasted into an open tab', async ({ page }) => {
  await openEvent(page, COOKOUT);
  await expect(dialog(page).locator('#modal-title')).toHaveText('Fall Cookout');

  await page.evaluate((id) => (location.hash = `event=${id}`), DINNER);
  await expect(dialog(page).locator('#modal-title')).toHaveText('Community Group — Week 1');
});

test('a link to an event that is gone says so', async ({ page }) => {
  await page.goto('/demo.html#event=no-such-event');
  await expect(page.locator('#toast')).toHaveText('That event is no longer on the calendar.');
  await expect(dialog(page)).toHaveCount(0);
});

test('closing an event keeps the query string in the address', async ({ page }) => {
  await page.goto(`/demo.html?group=riverside#event=${DINNER}`);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/demo\.html\?group=riverside$/);
});

test('an Upcoming card opens its event from anywhere on it, and its title is the button', async ({ page }) => {
  await page.goto('/demo.html');
  await page.getByRole('button', { name: 'Upcoming' }).click();
  await expect(page.getByRole('button', { name: 'Fall Cookout' })).toBeVisible();
  // The title's button is stretched over the card, so a click on the location
  // line lands on it. `force` clicks at that spot instead of waiting for the
  // location text itself to be clickable.
  await page.locator('.agenda-card', { hasText: 'Fall Cookout' }).locator('.where').click({ force: true });
  await expect(dialog(page).locator('#modal-title')).toHaveText('Fall Cookout');
});

test('a host is shown by name only, and is never asked for an address', async ({ page }) => {
  await openEvent(page, DINNER);
  await dialog(page).getByRole('button', { name: 'Sign up to host' }).click();
  await expect(dialog(page).getByLabel('Address')).toHaveCount(0);
  await expect(dialog(page).locator('form')).toContainText('leave your address out');
  await page.getByLabel('Your name').fill('Jordan');
  await dialog(page).locator('form').getByRole('button', { name: 'Sign up to host' }).click();
  await expect(dialog(page).locator('.modal-head')).toContainText('Hosted by Jordan');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Upcoming' }).click();
  const card = page.locator('.agenda-card').filter({ hasText: 'Week 1' });
  await expect(card).toContainText('Hosted by Jordan');
  await expect(card.locator('.where')).toHaveCount(0);
});

test('a visitor can change what their own sign-up says', async ({ page }) => {
  await openEvent(page, DINNER);
  await slotGroup(page, 'Main dish').getByRole('button', { name: 'Sign up' }).click();
  await page.getByLabel('Your name').fill('Jordan');
  await page.getByLabel('What you will bring').fill('Lasagna');
  await page.getByRole('button', { name: 'Add sign-up' }).click();

  await slotGroup(page, 'Main dish').getByRole('button', { name: "Edit Jordan's sign-up" }).click();
  await expect(page.getByLabel('What you will bring')).toHaveValue('Lasagna');
  await page.getByLabel('What you will bring').fill('Chili');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(slotGroup(page, 'Main dish').locator('.person.mine')).toContainText('Chili');
  // Someone else's sign-up has no Edit for a visitor.
  await expect(slotGroup(page, 'Side dish').getByRole('button', { name: /Edit/ })).toHaveCount(0);
});

test('a past event can be read but not signed up for', async ({ page }) => {
  await page.goto('/demo.html');
  await page.getByRole('button', { name: 'Upcoming' }).click();
  await expect(page.locator('.agenda-card').filter({ hasText: 'Week 0' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show past events' }).click();
  await page.locator('.agenda-card').filter({ hasText: 'Week 0' }).getByRole('button').click();

  await expect(dialog(page).locator('.summary')).toHaveText('This event has passed.');
  await expect(dialog(page).locator('.modal-head')).toContainText('Hosted by The Parkers');
  await expect(dialog(page).locator('[data-open-form]')).toHaveCount(0);
  await expect(dialog(page).locator('[data-cancel-signup]')).toHaveCount(0);
});

test('removing a slot people signed up for asks first', async ({ page }) => {
  await signInAsOrganizer(page);
  await openEvent(page, DINNER);
  await page.getByRole('button', { name: 'Edit event' }).click();
  await dialog(page)
    .locator('[data-slot-row]')
    .filter({ has: page.locator('input[value="Side dish"]') })
    .getByRole('button', { name: 'Remove this slot' })
    .click();

  let message = '';
  page.once('dialog', (d) => {
    message = d.message();
    d.dismiss();
  });
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect(message).toContain('Side dish (Marisol)');
  // Backing out leaves the form open and usable.
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog(page)).toContainText('Other food:');
  await expect(dialog(page)).toContainText('Marisol');
});

test('the month grid explains its colours', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto('/demo.html');
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(page.locator('.legend')).toContainText('Needs a host');
});

test('the Month / Upcoming switch stays in place when the view changes', async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/demo.html');
    const toggle = page.locator('.view-toggle');
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    const inMonth = await toggle.boundingBox();
    await page.getByRole('button', { name: 'Upcoming' }).click();
    const inList = await toggle.boundingBox();
    expect(Math.round(inList.x), `at ${width}px wide`).toBe(Math.round(inMonth.x));
  }
});
