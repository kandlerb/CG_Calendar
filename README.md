# CG Calendar

[![Tests](https://github.com/kandlerb/CG_Calendar/actions/workflows/test.yml/badge.svg)](https://github.com/kandlerb/CG_Calendar/actions/workflows/test.yml)

A shareable calendar for a community group. You post the events, then send one
link to the group. Anyone with the link can open an event and either **sign up
to host it** or **say what food they'll bring**. Only the organizers you name
can create, edit, or delete events.

It's a plain website — nothing to install, nothing for your group to sign up
for. The page is static files on **GitHub Pages**; the events and sign-ups live
in **Supabase**, which is free at this size.

## Try it before you set anything up

Open **`demo.html`** on the deployed site (or run `npm run serve` and visit
<http://localhost:8000/demo.html>). The demo runs the entire calendar against
in-memory data with no backend at all — create events, sign up, claim food
slots. Reloading the page starts over.

## Why Supabase is needed

GitHub Pages serves files; it can't remember anything. For everyone in the
group to see the same sign-ups, the data has to live somewhere off the page.
Supabase is that somewhere: a hosted Postgres database with a built-in API. Its
free tier is far more than a community group calendar will ever use.

It also enforces the part that matters. The rules about **who may create
events** live in the database (`supabase/schema.sql`), not in the browser.
Someone poking at the page with developer tools still can't add an event, take
a host spot that is gone, or attach a sign-up to another event's food slot.

## Setting it up

About fifteen minutes, once.

> **This repository is already set up.** Every step below is done for the
> Supabase project `CG_Calendar`: the tables, row level security and sign-up
> trigger from `supabase/schema.sql` are applied, anonymous sign-ins are on,
> Brian and Timothy are organizers, and `public/config.js` holds the project
> URL and publishable key. Step 6 reports 8 of 8 passing.
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

### 3. Turn on anonymous sign-ins

**Authentication → Sign In / Providers → Anonymous sign-ins → enable.**

This is what lets someone sign up without making an account, while still being
able to come back later and change or cancel *their own* sign-up. It is easy to
miss, and the calendar looks fine until someone tries to sign up — every
attempt then fails with:

```
{"code":422,"error_code":"anonymous_provider_disabled","msg":"Anonymous sign-ins are disabled"}
```

`scripts/verify-supabase.mjs` (step 6) checks this for you.

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

Repeat for each person who should be able to manage events. Everyone else in
the group needs no account at all.

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

This asks your project the questions that matter: are the tables there, are
anonymous sign-ins on, and does the database actually refuse to let a visitor
create an event. Add an organizer's email and password to also have it create
a throwaway event, check the sign-up rules hold, and clean up after itself:

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

## Who can do what

| | Anyone with the link | Organizer |
| --- | --- | --- |
| See the calendar and who signed up | yes | yes |
| Sign up to host an event | yes | yes |
| Sign up to bring food | yes | yes |
| Edit or cancel **their own** sign-up | yes | yes |
| Create, edit, or delete events | **no** | yes |
| Remove anyone's sign-up | no | yes |

Organizers sign in with the button in the header, using the email and password
from step 4. Everyone else just opens the link — no account, no password, no
app to install. Their browser quietly holds an anonymous session, which is what
lets them manage the sign-ups they made. If they clear their browser data they
can still see everything; they'd just need an organizer to remove an old
sign-up for them.

## Using it

1. An organizer adds events — title, date, time, place, how many hosts are
   needed, and the food slots to fill. Add as many slots as you like. The
   number beside each slot is **how many people you want for it** — a minimum,
   not a cap. Set it to 0 if any number will do.
2. Send the group the link. "Copy link to this event" inside an event gives a
   link that opens straight to that week.
3. Someone taps **Sign up to host**, leaving a note like the address or where
   to park.
4. Everyone else picks a food slot and types what they're bringing. A slot
   never closes: once it has the number you asked for it shows as covered, and
   anyone who wants to add another side dish still can. Each person's own
   sign-up records what they are bringing, so the list under a slot reads as
   "Anna — Lasagna, Bob — Chili" rather than a bare count.

### What a first-time visitor sees

The page opens with a **How to use this calendar** panel: find the event, open
it, sign up. Closing it is remembered, and the **How to use** button in the
header reopens it.

- **Month** shows the grid; **Upcoming** shows a list, and is what a phone
  opens on. The choice is remembered.
- Each event opens with one line stating what is unfilled, such as *Still
  needed: a host and 2 food slots.*
- Your own sign-ups are marked **You**. The marker is tied to the browser, not
  to an account.
- A month with no events says so and links to the month of the next event.

## Day-to-day

**Adding or removing an organizer** is the SQL in step 4, or
`delete from public.organizers where user_id = (select id from auth.users where email = '…');`

**Backups**: Supabase's dashboard has **Database → Backups**. For a copy you
hold yourself, the table editor exports any table to CSV.

**Cost**: the free tier covers this comfortably. Free projects pause after a
week with no activity and resume from the dashboard — a calendar people check
weekly won't hit that.

## What this is not

The share link is unlisted, not secret. Anyone who has it can read the calendar
and add a sign-up under any name — that's the trade-off that keeps it
frictionless for a community group, but it means the calendar shouldn't hold
anything you'd mind being forwarded. The restriction that *is* enforced is on
events: creating, editing, and deleting them requires an organizer account, and
the database checks that on every request.

## Development

```bash
npm test             # unit tests for the date and model logic (no dependencies)
npm run test:schema  # applies schema.sql to a scratch database and tests the rules
npm run serve        # serves public/ at http://localhost:8000
node scripts/verify-supabase.mjs <url> <anon-key> [email] [password]   # checks a live project
```

`npm run test:schema` needs a PostgreSQL you can reach (`PGHOST`, `PGUSER`,
`PGPASSWORD` as usual). It creates a scratch database, applies the schema, and
checks the security rules hold — that a participant can't create an event,
can't edit someone else's sign-up, can't post as someone else, and can't take a
slot belonging to a different event. CI runs both on every push.

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
supabase/schema.sql    tables, row level security, sign-up rules
supabase/tests/        those rules, tested against a real PostgreSQL
test/                  unit tests for the browser modules
scripts/test-schema.sh runs the schema tests
scripts/verify-supabase.mjs checks a live Supabase project is set up right
```
