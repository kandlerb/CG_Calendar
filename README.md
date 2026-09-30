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
a host spot that is gone, or attach a sign-up to another event's food slot.

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
  repository, `https://kandlerb.github.io/CG_Calendar/`) and add the same
  address under **Redirect URLs**. Password-reset emails link back there.
- **Emails → SMTP Settings**: connect an email service. Supabase's built-in
  sender only delivers to the members of your Supabase team, so without this
  password-reset emails never reach anyone else. Any SMTP provider works; free
  tiers such as [Resend](https://resend.com) or [Brevo](https://www.brevo.com)
  are plenty. Resend needs a domain you own; Brevo can send from a single
  verified address. Send yourself a reset and check it isn't landing in spam.

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

It links events back to `https://kandlerb.github.io/CG_Calendar/`. For a
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

Once it's set, push to `main` (or re-run the deploy workflow). It publishes
`public/` and prints the URL in the Actions log — usually
`https://kandlerb.github.io/CG_Calendar/`. That's the link you send your
group.

## Finishing the switch to accounts

The calendar used to be open to anyone with the link. The database side of the
switch is done; these are the dashboard settings still to change (step 3 has
the detail):

1. **Confirm email → off.**
2. **Anonymous sign-ins → off.**
3. **Site URL and Redirect URLs →** `https://kandlerb.github.io/CG_Calendar/`.
4. **SMTP →** connect an email service, so password resets reach people.

Then run `node scripts/verify-supabase.mjs` with your organizer login and
check everything passes, and send the group the link with the invite code
(on the calendar: **your name → Invite code and members**).

Sign-ups made before the switch stay on their events. The people who made
them were anonymous, so they can't edit them any more; an organizer still can.

## Who can do what

| | Signed out | Member | Organizer |
| --- | --- | --- | --- |
| See the calendar | no — sign-in screen only | yes | yes |
| Sign up to host or bring food | no | yes | yes |
| Edit or cancel **their own** sign-up | — | yes, from any device | yes |
| Subscribe from their phone's calendar | — | yes | yes |
| Remove anyone's sign-up | no | no | yes |
| Create, edit, or delete events | no | no | yes |
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

Each member finds it under **their name → Add the calendar to your phone**:

- **Apple Calendar / Outlook**: one tap (a `webcal://` link).
- **Google Calendar**: copy the link, then **Other calendars → From URL** on a
  computer. It shows up on their phone as well.

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
npm test             # unit tests for the date and model logic (no dependencies)
npm run test:schema  # applies schema.sql to a scratch database and tests the rules
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

## Layout

```
public/                the website — this is what GitHub Pages serves
  index.html           the calendar, wired to Supabase
  demo.html            the same app on in-memory data, no backend
  config.js            your Supabase URL and anon key
  app.js               all the page's behaviour
  lib/dates.js         calendar maths
  lib/model.js         turning rows into what's on screen
  lib/supabase-data.js everything that talks to Supabase
  lib/demo-data.js     the stand-in used by demo.html
  lib/feed.js          builds the calendar subscription (.ics)
supabase/schema.sql    tables, row level security, sign-up rules, members
supabase/functions/calendar-feed/  the Edge Function that serves each feed
supabase/tests/        those rules, tested against a real PostgreSQL
test/                  unit tests for the browser modules
scripts/test-schema.sh runs the schema tests
scripts/verify-supabase.mjs checks a live Supabase project is set up right
```
