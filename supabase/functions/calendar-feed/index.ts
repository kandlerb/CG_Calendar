// The calendar feed members subscribe to from Apple Calendar, Google Calendar
// or Outlook:
//
//   https://<ref>.supabase.co/functions/v1/calendar-feed?token=<feed token>
//
// Calendar apps cannot sign in, so this function is deployed with JWT
// verification off and the token in the link is the whole check: feed_data()
// in supabase/schema.sql returns nothing for a token that is wrong, has been
// reset, or belongs to a removed member. It is called with the public key, so
// this function holds no secrets.
//
// The feed itself is built by public/lib/feed.js, the same module the unit
// tests cover.

import { buildCalendar } from '../../../public/lib/feed.js';

// Where "Sign up or see details" links point. Set SITE_URL on the function to
// move the calendar somewhere else.
const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://calendar.kandlerbaker.com/';
const CALENDAR_NAME = Deno.env.get('CALENDAR_NAME') ?? 'Community Group Calendar';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const PUBLIC_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound() {
  // The same answer for every bad link, so it says nothing about which
  // tokens exist.
  return new Response('This calendar link is not valid. Get a new one from your account on the calendar.\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const url = new URL(req.url);
  // Some apps keep the ".ics" a person adds to make the link look familiar.
  const token = (url.searchParams.get('token') ?? '').replace(/\.ics$/i, '').trim();
  if (!TOKEN_SHAPE.test(token)) return notFound();

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/feed_data`, {
    method: 'POST',
    headers: {
      apikey: PUBLIC_KEY,
      authorization: `Bearer ${PUBLIC_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ p_token: token }),
  });
  if (!res.ok) {
    console.error('feed_data failed', res.status, await res.text());
    return new Response('The calendar is not available right now. Try again later.\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '600' },
    });
  }

  const data = await res.json();
  if (!data) return notFound();

  const body = buildCalendar(data.events ?? [], { siteUrl: SITE_URL, calendarName: CALENDAR_NAME });
  return new Response(req.method === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="calendar.ics"',
      // Personal and always current: nothing in between should keep a copy.
      'cache-control': 'private, no-store',
    },
  });
});
