# CG Calendar

[![Tests](https://github.com/kandlerb/CG_Calendar/actions/workflows/test.yml/badge.svg)](https://github.com/kandlerb/CG_Calendar/actions/workflows/test.yml)

A calendar for a community group. You post the events, then send the group the
link and an **invite code**. Each person creates an account with the code, and
can then open an event and either **sign up to host it** or **say what food
they'll bring**. Only the organizers you name can create, edit, or delete
events.

Every member can also **subscribe to the calendar** from Apple Calendar, Google
Calendar or Outlook. Each event lands in their phone's calendar with the
address, who is hosting, who is bringing what, and a link back to sign up.

It's a plain website — nothing to install. The page is static files on
**GitHub Pages**; the events, accounts and sign-ups live in **Supabase**, which
is free at this size.

## Try it before you set anything up

Open **`demo.html`** on the deployed site (or run `npm run serve` and visit
<http://localhost:8000/demo.html>). The demo runs the entire calendar against
in-memory data with no backend at all — create events, sign up, claim food
slots, sign out and back in, try the invite code (it's `demo`). Reloading the
page starts over.

## Why Supabase is needed

GitHub Pages serves files; it can't remember anything. For everyone in the
group to see the same sign-ups, the data has to live somewhere off the page.
Supabase is that somewhere: a hosted Postgres database with a built-in API. Its
free tier is far more than a community group calendar will ever use.

It also enforces the part that matters. The rules about **who may see the
calendar** and **who may create events** live in the database
(`supabase/schema.sql`), not in the browser. Someone poking at the page with
developer tools still can't read an event without joining, add an event, take
a host spot that is gone, attach a sign-up to another event's food slot, or
read the phone numbers and emails people left for the organizers.

Supabase also runs the one piece of server code: the **calendar-feed** Edge
Function, which serves each member's subscription.

## Setting it up

About fifteen minutes, once.

> **This repository is already set up.** The Supabase project `CG_Calendar`
> has the tables, row level security and functions from `supabase/schema.sql`,
> the `calendar-feed` function is deployed, Brian and Timothy are organizers,
> and `public/config.js` holds the project URL and publishable key. What is
> left is in the dashboard — see **Finishing the switch to accounts** below.
>
> The steps are kept for reference — follow them to point this calendar at a
> different Supabase project, or to add another organizer (step 4).

### 1. Create the Supabase project

Sign up at [supabase.com](https://supabase.com) and create a project. Any
region near your group is fine.

### 2. Create the tables and rules

In the Supabase dashboard, open **SQL editor → New query**, paste in the whole
of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**. It's safe
to run more than once.

It starts the group with a random invite code. Organizers see it, and change
it, from **their name → Invite code and members** on the calendar.

### 3. Set up sign-in

Under **Authentication**:

- **Sign In / Providers → Email**: keep email sign-in on, and turn
  **Confirm email off**. The invite code already decides who gets in; with
  confirmation on, people have to confirm their address before they can enter
  the code. (The calendar copes either way, but it's one more step for them.)
- **Sign In / Providers → Anonymous sign-ins**: **off**. The calendar used to
  rely on them; they can no longer see anything.
- **URL Configuration**: set **Site URL** to the calendar's address (for this
  repository, `https://calendar.kandlerbaker.com/`) and add the same
  address under **Redirect URLs**. Password-reset emails link back there.
- **Emails → SMTP Settings**: connect an email service. Supabase's built-in
  sender only delivers to the members of your Supabase team, so without this
  password-reset emails never reach anyone else. Any SMTP provider works; free
  tiers such as [Resend](https://resend.com) or [Brevo](https://www.brevo.com)
  are plenty. Resend needs a domain you own; Brevo can send from a single
  verified address. Send yourself a reset and check it isn't landing in spam.
- **Emails → Templates → Reset Password**: set the subject to
  `Reset your Community Group Calendar password` and paste in
  `supabase/email-templates/reset-password.html`, so the email looks like the
  calendar rather than Supabase's plain default.

### 4. Add yourself as an organizer

**Authentication → Users → Add user**, with an email and password. Tick
**Auto Confirm User** — without it the account cannot sign in at all until
someone confirms the address, and the failure looks like a wrong password.

Then back in the SQL editor, make that user an organizer:

```sql
insert into public.organizers (user_id, name)
select id, 'Brian' from auth.users where email = 'you@example.com'
on conflict (user_id) do update set name = excluded.name;
```

Repeat for each person who should be able to manage events. Organizers never
need the invite code. Everyone else creates their own account on the page.

### 4b. Deploy the calendar feed

The feed is a Supabase Edge Function in
[`supabase/functions/calendar-feed`](supabase/functions/calendar-feed). With
the [Supabase CLI](https://supabase.com/docs/guides/cli), from the repository
root:

```bash
supabase functions deploy calendar-feed --project-ref <ref> --no-verify-jwt
```

`--no-verify-jwt` matters: calendar apps cannot sign in, so the secret token
in each member's feed link is what the function checks. The function builds
the feed with `public/lib/feed.js`, so deploy from the repository root, where
that file is reachable.

It links events back to `https://calendar.kandlerbaker.com/`. For a
calendar anywhere else, set a `SITE_URL` secret on the function
(**Edge Functions → Secrets**), and `CALENDAR_NAME` to change the name
calendar apps show.

### 5. Point the site at your project

In the dashboard, **Project Settings → API** gives you a **Project URL** and a
publishable key (`sb_publishable_...`, listed as **anon public** on older
projects). Put both in [`public/config.js`](public/config.js):

```js
export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_...';
export const APP_NAME = 'Riverside Community Group';
```

Both are meant to be public — they're visible in the page source of every
Supabase site. What protects your data is the row level security from step 2.
**Never put the `service_role` key here**; it bypasses those rules entirely.

### 6. Check it worked

```bash
node scripts/verify-supabase.mjs https://<ref>.supabase.co <anon-key>
```

This asks your project the questions that matter: are the sign-in settings
right, does a signed-out visitor really see nothing, and is the feed function
deployed. Add an organizer's email and password to also have it create a
throwaway event, check the sign-up rules hold, read the event back through the
organizer's own calendar feed, and clean up after itself:

```bash
node scripts/verify-supabase.mjs https://<ref>.supabase.co <anon-key> you@example.com 'your-password'
```

Every check names what to fix if it fails.

### 7. Turn on GitHub Pages

**Settings → Pages → Source → GitHub Actions.** This one is unavoidably manual:
creating a Pages site needs repository admin rights, which the token workflows
run with does not have. A deploy before this step fails with:

```
Get Pages site failed. Error: Not Found
Create Pages site failed. Error: Resource not accessible by integration
```

Once it's set, push to `main`. The Tests workflow runs every test and, only
if they all pass, its last job publishes `public/` and prints the URL in the
Actions log. That's the link you send your group. (**Actions → Deploy to
GitHub Pages → Run workflow** redeploys by hand, without waiting for tests.)

This calendar lives at `https://calendar.kandlerbaker.com/`: a CNAME record
for `calendar` pointing at `kandlerb.github.io` (in GoDaddy), the same name
under **Settings → Pages → Custom domain**, and **Enforce HTTPS** ticked. The
old `kandlerb.github.io/CG_Calendar/` address redirects there. If you move it
again, also change the Site URL and Redirect URLs in Supabase, the `og:` tags
in `public/index.html`, and `SITE_URL` in the calendar-feed function.

## Finishing the switch to accounts

The calendar used to be open to anyone with the link. The database side of the
switch is done; these are the dashboard settings still to change (step 3 has
the detail):

1. **Confirm email → off.**
2. **Anonymous sign-ins → off.**
3. **Site URL and Redirect URLs →** `https://calendar.kandlerbaker.com/`.
4. **SMTP →** connect an email service, so password resets reach people.

Then run `node scripts/verify-supabase.mjs` with your organizer login and
check everything passes, and send the group the link with the invite code
(on the calendar: **your name → Invite code and members**).

Sign-ups made before the switch stay on their events. The people who made
them were anonymous, so they can't edit them any more; an organizer still can.

## Who can do what

| | Signed out | Member | Organizer |
| --- | --- | --- | --- |
| See the calendar and who signed up | no — sign-in screen only | yes | yes |
| Sign up to host or bring food | no | yes | yes |
| See the phone number or email someone left | — | only their own | yes |
| Edit or remove **their own** sign-up, until the event is over | — | yes, from any device | yes |
| Subscribe from their phone's calendar, or add one event | — | yes | yes |
| Create, edit, duplicate, cancel, or delete events | no | no | yes |
| Tap a phone number to text it, or an email to write | no | no | yes |
| Edit or remove anyone's sign-up | no | no | yes |
| See and change the invite code, remove members | no | no | yes |

People join by creating an account (name, email, password) with the invite
code. Their account is what lets them change their own sign-ups, on any
device. Forgotten passwords are reset by email from the sign-in screen.

Five wrong invite codes in 15 minutes and an account has to wait before trying
again, so the code can't be guessed by trying one after another. Changing the
code only affects new accounts.

Removing a member (**Invite code and members → Remove**) shuts them out of the
calendar and stops their feed at once; their past sign-ups stay. **Restore**
undoes it. Someone who knows the code could make a new account, so change the
code too if that matters.

## The calendar subscription

Each member finds it under the **Subscribe** button at the top of the calendar:

- **Apple Calendar / Outlook**: one tap (a `webcal://` link).
- **Google Calendar**: has to be added once **on a computer** — the Google
  Calendar app on Android and iPhone cannot add a calendar from a link.
  **Add to Google Calendar** opens Google's "add this calendar?" page; failing
  that, copy the link and use **Other calendars → + → From URL**. Once added
  on a computer, it appears in the Google Calendar app on their phone.

Each event in the feed has:

- the time, in America/New_York (an event with no end time lasts 2 hours; one
  with no time is all-day),
- the **location** in the address field calendar apps put on a map — the
  organizer's location, or the host's address if the event needed a host,
- a description that opens with a link to the event on the calendar, then
  what you signed up for, who is hosting, who is bringing what, and what is
  still needed,
- everything from the last three months onward.

Contact details are never put in the feed; it ends up on Google's, Apple's or
Microsoft's servers.

The link is personal. **Reset my link** makes a new one and turns the old one
off. Apple Calendar and Outlook pick up changes within about an hour; Google
Calendar checks on its own schedule, which can take up to a day.

## Weather

Events in the next 16 days show the forecast for their town: the conditions
and temperature at the start time, the day's high and low, and the chance of
rain — in the event, on Upcoming cards, as an icon on the month grid, and in
**Next up**. The town comes from the event's location or the host's address
("…, Evans, GA"); anything without a town in it uses Augusta, GA
(`HOME_TOWN` in `public/lib/weather.js`). Forecasts come from
[Open-Meteo](https://open-meteo.com), which is free for non-commercial use and
needs no key. If it is down, the calendar works the same without the weather.
The subscription feed does not include the weather.

## Live updates

An open calendar updates itself: when anyone adds or changes an event or a
sign-up, everyone else's page reloads the calendar within a second or two, no
refresh needed. It works through one table, `calendar_changes`, whose single
row ticks whenever events, food slots or sign-ups change; pages watch it with
Supabase Realtime and then load the calendar the usual way, so what each
person sees is still decided by the same rules. Only members can watch it.
Running `schema.sql` sets it all up, including adding the table to Realtime.

## On phones

- **Install it.** In Safari, Share → **Add to Home Screen**; in Chrome, ⋮ →
  **Add to Home screen** (or **Install app**). It then opens full-screen from
  its own icon, like an app.
- **Swipe** left or right on the month grid to change months.
- **Link previews.** Pasting the link into a text or group chat shows a card
  with the calendar's name and picture (`public/og-image.png`).

## Using it

1. An organizer adds events — title, date, time, and the food slots to fill.
   For the host, pick one: **still looking for a host**, which lets people
   sign up to host, or **host is arranged**, which shows the location instead
   and asks nobody to host. Add as many food slots as you like. The
   number beside each slot is **how many people you want for it** — a minimum,
   not a cap. Set it to 0 if any number will do.
2. Send the group the link and the invite code. "Copy link to this event"
   inside an event gives a link that opens straight to it — someone who isn't
   signed in yet signs in and lands on that event.
3. If the event is still looking for a host, someone taps **Sign up to
   host**, entering the address (which goes into everyone's calendar feed)
   and a note like where to park.
4. Everyone else picks a food slot and types what they're bringing. A slot
   never closes: once it has the number you asked for it shows as covered, and
   anyone who wants to add another side dish still can. Each person's own
   sign-up records what they are bringing, so the list under a slot reads as
   "Anna — Lasagna, Bob — Chili" rather than a bare count.
5. Anyone can **Edit** or **Remove** their own sign-up through the day of the
   event. After that the event is read-only, except to organizers.

If an organizer removes a food slot that people signed up for, the editor
names them and asks first; their sign-ups are kept, listed under "Other food".

### For organizers

- **Repeat weekly.** A new event can also be added for up to the next 12
  weeks, with the same time, host setting and food slots. A title ending in a
  number counts up: "Week 3" is followed by "Week 4".
- **Duplicate** in an event opens a copy a week later, ready to adjust. Sign-ups
  are not copied.
- **Cancel event** keeps the event on the calendar, crossed out and marked
  cancelled, and stops new sign-ups. Nobody is notified, so tell the group.
  **Restore event** undoes it. **Delete event** removes it for good.
- A phone number someone left is a link that opens a text message to them; an
  email opens a new email.

### What a first-time visitor sees

The page opens on the sign-in screen: **Sign in**, or **Create account** with
the invite code. Once in, a **How to use this calendar** panel explains: find
the event, open it, sign up, subscribe. Closing it is remembered, and the
**How to use** button in the header reopens it.

- **Month** shows the grid; **Upcoming** shows a list, and is what a phone
  opens on. The choice is remembered.
- Each event opens with one line stating what is unfilled, such as *Still
  needed: a host and 2 food slots.*
- Your own sign-ups are marked **You**, on any device you sign in on.
- A month with no events says so and links to the month of the next event.
- In **Month**, a key under the grid explains the chip colours; a lavender
  chip still needs a host.
- The moon/sun button left of the title switches between light and dark. The
  page follows the device's setting until someone picks one, and the choice
  is remembered in that browser.
- **Month** starts with a **Next up** line: the next event that is still on,
  what it needs, and a button to open it.
- **Add to my calendar** in an event downloads it as a calendar file, which a
  phone or computer offers to add. It has the title, time, details and a link
  back, but never a host's address.
- **Upcoming** has **Only my sign-ups** once you have signed up for something,
  and ends with **Show past events**, for checking who brought what.
- The phone number or email on a sign-up is optional and shown only to
  organizers (and to the person who left it). The database enforces that, not
  just the page.

## Day-to-day

**Adding or removing an organizer** is the SQL in step 4, or
`delete from public.organizers where user_id = (select id from auth.users where email = '…');`

**Changing the invite code, or removing a member**: on the calendar, **your
name → Invite code and members**.

**"Permission denied for table …"** in the Supabase logs means a request
arrived with no session, so the database ran it as a signed-out visitor, who
may do nothing at all. The log's hint suggests a `GRANT … TO anon;` — don't:
that would open the calendar to anyone, and the grants in `schema.sql` are
already right. The browser's Supabase client can lose its session and then
quietly sends the public key instead of the member's token. The page checks
before every write, refreshes the session and retries once; if it still fails,
it shows the sign-in screen and reopens the event after.

**Old anonymous users** from before the switch to accounts are still listed
under **Authentication → Users**, one per browser that opened the calendar
back then. They can't see anything now, so they are harmless. If you ever
clear them out, know that deleting a user **also deletes every sign-up they
made** (`signups.created_by … on delete cascade`). Only remove anonymous users
whose events are over, for example:

```sql
delete from auth.users u
 where u.is_anonymous
   and not exists (
     select 1 from public.signups s join public.events e on e.id = s.event_id
      where s.created_by = u.id and e.event_date >= current_date);
```

**Updating the database rules**: re-run the whole of `supabase/schema.sql` in
the SQL editor; it is safe to run again. If a change to the rules comes with a
change to the page, let the new page deploy first, then run the SQL.

**Updates reach phones on the next reload.** GitHub Pages lets browsers keep
the page's files for 10 minutes, which used to hide a new release. `public/sw.js`
is a tiny service worker that makes each visit ask GitHub whether a file
changed; it stores nothing itself. The very first visit after this was added
can still show a copy up to 10 minutes old; every visit after that is current.

**Backups**: Supabase's dashboard has **Database → Backups**. For a copy you
hold yourself, the table editor exports any table to CSV.

**Cost**: the free tier covers this comfortably. Free projects pause after a
week with no activity and resume from the dashboard — a calendar people check
weekly won't hit that.

## What this is not

The invite code keeps the calendar to the people you give it to — but it is a
shared secret, not a guest list. Anyone who has it can make an account, which
is why organizers can see every member and remove them, and change the code.
A member's calendar feed link works for anyone who has it, until it is reset.

## Development

```bash
npm test             # unit tests for the date, model, form and data logic (no dependencies)
npm run test:schema  # applies schema.sql to a scratch database and tests the rules
npm run test:e2e     # drives demo.html in Chromium (npm install first)
npm run serve        # serves public/ at http://localhost:8000
node scripts/verify-supabase.mjs <url> <anon-key> [email] [password]   # checks a live project
```

`npm run test:schema` needs a PostgreSQL you can reach (`PGHOST`, `PGUSER`,
`PGPASSWORD` as usual). It creates a scratch database, applies the schema, and
checks the security rules hold — that a signed-out visitor or an account that
hasn't joined sees nothing, that a wrong invite code is refused and guessing is
throttled, that a removed member loses access and their feed, that a member
can't create an event, edit someone else's sign-up or post as someone else,
and that the feed carries no contact details. CI runs both on every push.

`npm run test:e2e` needs `npm install` and a Playwright Chromium
(`npx playwright install chromium`). It clicks through `demo.html` the way a
visitor and an organizer would: signing up, editing events, following links,
and checking that nothing half-typed is lost.

## Layout

```
public/                the website — this is what GitHub Pages serves
  index.html           the calendar, wired to Supabase
  demo.html            the same app on in-memory data, no backend
  config.js            your Supabase URL and anon key
  app.js               all the page's behaviour
  theme.js             the light / dark toggle, applied before the page draws
  lib/dates.js         calendar maths
  lib/model.js         turning rows into what's on screen
  lib/forms.js         checking what was typed before it is saved; weekly copies
  lib/ics.js           the "Add to my calendar" file
  lib/contact.js       turning a phone number or email into a link
  lib/supabase-data.js everything that talks to Supabase
  lib/demo-data.js     the stand-in used by demo.html
  lib/feed.js          builds the calendar subscription (.ics)
supabase/schema.sql    tables, row level security, sign-up rules, members
supabase/functions/calendar-feed/  the Edge Function that serves each feed
supabase/email-templates/  the password-reset email, to paste into Supabase
supabase/tests/        those rules, tested against a real PostgreSQL
test/                  unit tests for the browser modules
e2e/                   browser tests, run against demo.html
scripts/test-schema.sh runs the schema tests
scripts/verify-supabase.mjs checks a live Supabase project is set up right
```
