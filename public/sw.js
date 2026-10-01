// Makes every visit pick up the latest release.
//
// GitHub Pages tells browsers they may reuse the page's files for 10 minutes
// without asking, so a phone could keep showing the old calendar after an
// update. This worker sends every request for the calendar's own files to
// GitHub with "check first": an unchanged file comes back as a quick "not
// modified", a changed one comes back new. It stores nothing itself, and if
// the network is down it falls back to whatever the browser already has.
//
// Requests to anywhere else (Supabase, the font and script CDNs) are left
// alone.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request, { cache: 'no-cache' }).catch(() => fetch(request)));
});
