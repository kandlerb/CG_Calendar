import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_COOKIE = 'cg_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

export const sessionCookieName = SESSION_COOKIE;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

function passwordMatches(password, stored) {
  const [salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 32);
  const expectedBuf = Buffer.from(expected, 'hex');
  if (expectedBuf.length !== actual.length) return false;
  return timingSafeEqual(actual, expectedBuf);
}

/**
 * Parses `CG_ORGANIZERS`. Accepts either a JSON array of
 * `{ "name": "...", "password": "..." }` objects or the shorthand
 * `name:password` pairs separated by commas or newlines.
 */
export function parseOrganizers(raw) {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed)
      .map((entry) => ({
        name: String(entry.name ?? entry.username ?? '').trim(),
        password: String(entry.password ?? ''),
      }))
      .filter((entry) => entry.name && entry.password);
  }
  return trimmed
    .split(/[\n,]+/)
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf(':');
      if (at === -1) return null;
      return { name: pair.slice(0, at).trim(), password: pair.slice(at + 1) };
    })
    .filter((entry) => entry && entry.name && entry.password);
}

/**
 * Holds the list of people allowed to create and change events, plus their
 * logged-in sessions. Everyone else may read the calendar and sign up.
 */
export class Auth {
  constructor({ store, organizers, fallbackPasswordFile }) {
    this.store = store;
    this.attempts = new Map();
    this.generatedPassword = null;
    this.organizers = organizers.map((o) => ({
      name: o.name,
      passwordHash: hashPassword(o.password),
    }));

    if (this.organizers.length === 0 && fallbackPasswordFile) {
      const password = this.#loadOrCreateFallbackPassword(fallbackPasswordFile);
      this.generatedPassword = password;
      this.organizers.push({ name: 'organizer', passwordHash: hashPassword(password) });
    }
  }

  #loadOrCreateFallbackPassword(file) {
    const resolved = path.resolve(file);
    try {
      const existing = fs.readFileSync(resolved, 'utf8').trim();
      if (existing) return existing;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const password = randomBytes(12).toString('base64url');
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${password}\n`, { mode: 0o600 });
    return password;
  }

  organizerNames() {
    return this.organizers.map((o) => o.name);
  }

  /** Returns the session on success, or an object describing the failure. */
  async login({ name, password, clientKey }) {
    if (this.#throttled(clientKey)) {
      return { error: 'too_many_attempts' };
    }
    const wanted = String(name ?? '').trim().toLowerCase();
    const organizer = this.organizers.find((o) => o.name.toLowerCase() === wanted);
    const ok = organizer && typeof password === 'string' && passwordMatches(password, organizer.passwordHash);
    if (!ok) {
      this.#recordFailure(clientKey);
      return { error: 'invalid_credentials' };
    }
    this.attempts.delete(clientKey);

    const token = newToken();
    this.store.addSession({
      tokenHash: hashToken(token),
      name: organizer.name,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    await this.store.flush();
    return { token, name: organizer.name, maxAge: SESSION_TTL_MS / 1000 };
  }

  async logout(token) {
    if (!token) return;
    this.store.removeSession(hashToken(token));
    await this.store.flush();
  }

  /** The organizer behind this request, or null for an anonymous visitor. */
  organizerFor(token) {
    if (!token) return null;
    const session = this.store.findSession(hashToken(token));
    return session ? { name: session.name } : null;
  }

  #throttled(key) {
    const entry = this.attempts.get(key);
    if (!entry) return false;
    if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
      this.attempts.delete(key);
      return false;
    }
    return entry.count >= LOGIN_MAX_ATTEMPTS;
  }

  #recordFailure(key) {
    const entry = this.attempts.get(key);
    if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
      this.attempts.set(key, { first: Date.now(), count: 1 });
      return;
    }
    entry.count += 1;
  }
}
