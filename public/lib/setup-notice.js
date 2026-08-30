// Shown instead of the calendar when public/config.js has not been filled in
// yet, so a freshly deployed site explains itself rather than looking broken.

export function setupNotice() {
  for (const id of ['share-btn', 'new-event-btn', 'signin-btn']) {
    const button = document.getElementById(id);
    if (button) button.hidden = true;
  }
  document.querySelector('.toolbar')?.setAttribute('hidden', '');
  document.getElementById('agenda')?.setAttribute('hidden', '');

  document.getElementById('calendar').outerHTML = `
    <section class="setup">
      <h2>Almost there — connect a Supabase project</h2>
      <p>
        This calendar is a static site, so it needs somewhere to keep the events and
        sign-ups. That is Supabase, and it is free for a group this size.
      </p>
      <ol>
        <li>Create a project at <a href="https://supabase.com" rel="noreferrer noopener">supabase.com</a>.</li>
        <li>Open <strong>SQL editor</strong>, paste in <code>supabase/schema.sql</code> from this repository, and run it.</li>
        <li>Under <strong>Authentication → Sign In / Providers</strong>, turn on <strong>Anonymous sign-ins</strong>.</li>
        <li>Add an organizer: <strong>Authentication → Users → Add user</strong>, then run the
          <code>insert into public.organizers …</code> snippet from the README.</li>
        <li>Copy the project URL and anon key from <strong>Project Settings → API</strong> into
          <code>public/config.js</code>, then commit and push.</li>
      </ol>
      <p class="hint">
        The full walkthrough is in the README. Want to look around first?
        <a href="./demo.html">Open the demo</a> — it runs with no backend at all.
      </p>
    </section>`;
}

/**
 * Shown when the page cannot start at all — most often because the Supabase
 * library could not be fetched from the CDN. Without this the page would sit
 * blank with the failure only visible in the browser console.
 */
export function fatalNotice(error) {
  const target = document.getElementById('calendar');
  if (!target) return;
  document.querySelector('.toolbar')?.setAttribute('hidden', '');
  document.getElementById('agenda')?.setAttribute('hidden', '');
  for (const id of ['new-event-btn', 'signin-btn', 'signout-btn']) {
    document.getElementById(id)?.setAttribute('hidden', '');
  }
  const detail = error?.message ?? String(error ?? '');
  target.outerHTML = `
    <section class="setup">
      <h2>The calendar could not load</h2>
      <p>
        This usually means the browser could not reach one of the services the page
        needs — the Supabase library on the CDN, or the Supabase project itself.
      </p>
      <ol>
        <li>Check your internet connection and reload.</li>
        <li>If you are on a network that blocks CDNs, or running an aggressive
          content blocker, try another network or disable the blocker for this page.</li>
        <li>If it keeps happening, the details below will tell an organizer what broke.</li>
      </ol>
      <p class="hint">Meanwhile, <a href="./demo.html">the demo</a> runs entirely offline.</p>
      <pre class="fatal-detail">${detail.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>
    </section>`;
}
