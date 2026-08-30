import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = { version: 1, events: [], signups: [], sessions: [] };

/**
 * Tiny JSON-file store. A community group's calendar is a few hundred rows at
 * most, so the whole state lives in memory and is flushed to disk atomically
 * after every mutation.
 */
export class Store {
  constructor(file) {
    this.file = path.resolve(file);
    this.state = this.#read();
    this.#writing = null;
    this.#pending = false;
  }

  #writing;
  #pending;

  #read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...structuredClone(EMPTY), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`Could not read ${this.file}: ${err.message}`);
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      return structuredClone(EMPTY);
    }
  }

  /** Persist the current state. Writes are serialized and coalesced. */
  async flush() {
    if (this.#writing) {
      this.#pending = true;
      return this.#writing;
    }
    this.#writing = this.#write().finally(() => {
      this.#writing = null;
      if (this.#pending) {
        this.#pending = false;
        this.flush();
      }
    });
    return this.#writing;
  }

  async #write() {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const body = JSON.stringify(this.state, null, 2);
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(tmp, body, 'utf8');
    await fs.promises.rename(tmp, this.file);
  }

  // --- events -------------------------------------------------------------

  get events() {
    return this.state.events;
  }

  findEvent(id) {
    return this.state.events.find((e) => e.id === id);
  }

  addEvent(event) {
    this.state.events.push(event);
    return event;
  }

  removeEvent(id) {
    const before = this.state.events.length;
    this.state.events = this.state.events.filter((e) => e.id !== id);
    this.state.signups = this.state.signups.filter((s) => s.eventId !== id);
    return this.state.events.length !== before;
  }

  // --- sign-ups -----------------------------------------------------------

  get signups() {
    return this.state.signups;
  }

  signupsFor(eventId) {
    return this.state.signups.filter((s) => s.eventId === eventId);
  }

  findSignup(id) {
    return this.state.signups.find((s) => s.id === id);
  }

  addSignup(signup) {
    this.state.signups.push(signup);
    return signup;
  }

  removeSignup(id) {
    const before = this.state.signups.length;
    this.state.signups = this.state.signups.filter((s) => s.id !== id);
    return this.state.signups.length !== before;
  }

  // --- sessions -----------------------------------------------------------

  findSession(tokenHash) {
    const now = Date.now();
    const session = this.state.sessions.find((s) => s.tokenHash === tokenHash);
    if (!session) return undefined;
    if (session.expiresAt <= now) {
      this.removeSession(tokenHash);
      return undefined;
    }
    return session;
  }

  addSession(session) {
    this.state.sessions = this.state.sessions.filter((s) => s.expiresAt > Date.now());
    this.state.sessions.push(session);
    return session;
  }

  removeSession(tokenHash) {
    this.state.sessions = this.state.sessions.filter((s) => s.tokenHash !== tokenHash);
  }
}
