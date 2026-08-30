# CG Calendar

A shareable calendar for a community group. You post the events, then send one
link to the group. Anyone with the link can open an event and either **sign up
to host it** or **say what food they'll bring**. Only the organizers you name
can create, edit, or delete events.

No accounts for participants, no database server, no build step — it's plain
Node.js with a JSON data file, so it runs anywhere Node runs.

## Quick start

```bash
CG_ORGANIZERS="brian:pick-a-long-passphrase" npm start
# open http://localhost:3000
```

That's the whole install: the app has no npm dependencies.

Run the tests with `npm test`.

## Who can do what

| | Anyone with the link | Organizer |
| --- | --- | --- |
| See the calendar and who signed up | yes | yes |
| Sign up to host an event | yes | yes |
| Sign up to bring food | yes | yes |
| Edit or cancel **their own** sign-up | yes | yes |
| Create, edit, or delete events | **no** | yes |
| Remove anyone's sign-up | no | yes |

Organizers are set with the `CG_ORGANIZERS` environment variable:

```bash
CG_ORGANIZERS="brian:long-passphrase-one,jamie:long-passphrase-two"
```

Names and passwords are separated by a colon; entries by commas or newlines
(so avoid commas inside passwords — or use the JSON form:
`CG_ORGANIZERS='[{"name":"brian","password":"…"}]'`). Passwords are never
written to disk in the clear; they are hashed with scrypt at startup and
compared in constant time. Organizers sign in from the button in the header and
stay signed in for 30 days.

If you start the server without `CG_ORGANIZERS`, it creates a single organizer
named `organizer` with a random password, prints it once, and saves it to
`data/admin-password.txt`. That's fine for trying it out; set `CG_ORGANIZERS`
for real use.

Participants don't sign in at all. Their browser keeps a random key in
`localStorage`, which is what lets them come back and edit or cancel the
sign-up they made. If they clear their browser data they can still see
everything — they just need an organizer to remove an old sign-up for them.

## How the group uses it

1. An organizer signs in and adds events — title, date, time, place, how many
   hosts are needed, and the food slots they want filled (Main dish, Dessert,
   Drinks, …). Add as many slots as you like — there's no cap. The number
   beside each slot is how many people can claim it; **set it to 0 and the slot
   never closes**, so any number of people can bring a side dish. You can also
   let people bring something outside the listed slots entirely.
2. You send the group the link (**Copy share link** in the header). "Copy link
   to this event" inside an event gives a link that opens straight to it.
3. Someone clicks the event and taps **Sign up to host**, leaving their name and
   a note like an address or parking instructions.
4. Everyone else clicks a food slot and says what they're bringing. A slot with
   a limit closes once it's full, so two people can't both claim "Main dish" —
   and if they try at the same moment, the second one gets a clear message
   rather than a silent overwrite. A slot set to 0 stays open and just collects
   names.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `CG_ORGANIZERS` | — | Who may create and change events (see above) |
| `CG_APP_NAME` | `Community Group Calendar` | Title shown in the header |
| `CG_DATA_FILE` | `./data/calendar.json` | Where events and sign-ups are stored |
| `CG_FORCE_SECURE_COOKIES` | `0` | Set to `1` behind an HTTPS proxy that doesn't send `X-Forwarded-Proto` |

Copy `.env.example` if your host reads a `.env` file; otherwise set these in
your host's dashboard.

## Deploying

The app is one process and one file of state, so most hosts work:

- **Render / Railway / Fly.io / a small VPS**: build command none, start command
  `npm start`, and set the environment variables above.
- **Attach a persistent disk** and point `CG_DATA_FILE` at it (e.g.
  `/data/calendar.json`). On hosts with ephemeral filesystems, everything is
  lost on redeploy without one.
- **Serve it over HTTPS.** Organizer passwords and session cookies travel over
  the connection; the session cookie is marked `Secure` automatically when the
  server sees an HTTPS request.

Backing up is `cp data/calendar.json somewhere-safe.json`. Restoring is the
reverse, with the server stopped.

## Data model

`data/calendar.json` holds three lists: `events`, `signups`, and organizer
`sessions`. An event looks like this:

```json
{
  "id": "…",
  "title": "Community Group — Week 1",
  "date": "2026-09-02",
  "startTime": "18:30",
  "endTime": "20:30",
  "location": "Brian's house",
  "description": "Study in Philippians 2.",
  "needsHost": true,
  "hostLimit": 1,
  "foodSlots": [
    { "id": "…", "label": "Main dish", "capacity": 1 },
    { "id": "…", "label": "Side dish", "capacity": 0 }
  ],
  "allowOtherFood": true
}
```

A slot's `capacity` is how many people may claim it; `0` means no limit. There
is no cap on how many slots an event can have.

Sign-ups store the participant's name, optional contact, what they're bringing,
and a hash of their browser key. The key hash is never sent back to browsers.

## HTTP API

Everything the page does is available directly. Mutating requests need the
`X-CG-App: 1` header (which blocks cross-site form posts), and participants
identify themselves with `X-Participant-Key`.

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/api/config` | anyone |
| `POST` / `DELETE` | `/api/session` | sign in / sign out |
| `GET` | `/api/events?from=&to=` | anyone |
| `POST` `PATCH` `DELETE` | `/api/events[/:id]` | organizers only |
| `GET` | `/api/events/:id` | anyone |
| `POST` | `/api/events/:id/signups` | anyone |
| `PATCH` / `DELETE` | `/api/signups/:id` | the person who signed up, or an organizer |

## What this is not

The share link is unlisted, not secret — anyone who has it can read the
calendar and add a sign-up under any name. That matches how a community group
actually works, but it means the calendar shouldn't hold anything you wouldn't
want forwarded. The restriction that is enforced is the one on **events**:
creating, editing, and deleting them requires an organizer session, checked on
the server for every request.

## Layout

```
server.js          entry point: reads env, starts the server
src/server.js      HTTP plumbing, static files, cookies, CSRF header check
src/api.js         the endpoints above, plus capacity and permission rules
src/auth.js        organizer accounts, password hashing, sessions
src/store.js       the JSON file store
src/validate.js    input validation
public/            the calendar page (no framework, no build step)
test/api.test.js   API and permission tests
```
