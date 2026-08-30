import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth, hashToken, parseOrganizers, sessionCookieName } from './auth.js';
import { HttpError, createApi } from './api.js';
import { Store } from './store.js';
import { ValidationError } from './validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const MAX_BODY_BYTES = 128 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'That request was too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data, cookies = []) {
  const body = JSON.stringify(data);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  };
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(status, headers);
  res.end(body);
}

function isSecureRequest(req) {
  if (process.env.CG_FORCE_SECURE_COOKIES === '1') return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') return proto.split(',')[0].trim() === 'https';
  return Boolean(req.socket.encrypted);
}

function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

async function serveStatic(req, res, pathname) {
  const headOnly = req.method === 'HEAD';
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fs.promises.stat(target);
    if (stat.isDirectory()) throw Object.assign(new Error('is a directory'), { code: 'ENOENT' });
    const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    if (headOnly) res.end();
    else fs.createReadStream(target).pipe(res);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

export function createServer({ dataFile, organizers, appName }) {
  const store = new Store(dataFile);
  const auth = new Auth({
    store,
    organizers,
    fallbackPasswordFile: path.join(path.dirname(path.resolve(dataFile)), 'admin-password.txt'),
  });
  const api = createApi({ store, auth, appName });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end('Method not allowed');
        return;
      }
      try {
        await serveStatic(req, res, pathname);
      } catch {
        res.writeHead(500).end('Server error');
      }
      return;
    }

    const cookies = parseCookies(req.headers.cookie ?? '');
    const setCookies = [];
    const secure = isSecureRequest(req);
    const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
    const participantKey = req.headers['x-participant-key'];

    const ctx = {
      method: req.method,
      segments: pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean),
      query: url.searchParams,
      ip: clientKey(req),
      sessionToken: cookies[sessionCookieName] ?? null,
      ownerHash: typeof participantKey === 'string' && participantKey ? hashToken(participantKey) : null,
      body: null,
      organizer: null,
      setSessionCookie(token, maxAge) {
        setCookies.push(`${sessionCookieName}=${token}; Max-Age=${maxAge}; ${cookieFlags}`);
      },
      clearSessionCookie() {
        setCookies.push(`${sessionCookieName}=; Max-Age=0; ${cookieFlags}`);
      },
    };

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Blocks cross-site form posts: a custom header forces a preflight
        // that this server never answers.
        if (req.headers['x-cg-app'] !== '1') {
          throw new HttpError(400, 'Missing application header.');
        }
        const raw = await readBody(req);
        if (raw) {
          try {
            ctx.body = JSON.parse(raw);
          } catch {
            throw new HttpError(400, 'Request body was not valid JSON.');
          }
        }
      }
      ctx.organizer = auth.organizerFor(ctx.sessionToken);
      const result = await api.handle(ctx);
      sendJson(res, result.status, result.data, setCookies);
    } catch (err) {
      const status = err instanceof ValidationError || err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[cg-calendar]', err);
      if (res.writableEnded) return;
      sendJson(res, status, { error: status >= 500 ? 'Something went wrong on the server.' : err.message });
    }
  });

  return { server, store, auth };
}

export function organizersFromEnv(env = process.env) {
  return parseOrganizers(env.CG_ORGANIZERS ?? env.CG_ADMINS ?? '');
}
