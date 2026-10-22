// Мини-обвязка над node:http: маршрутизатор, JSON, cookie, ограничение частоты, статика.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    this.routes.push({ method, re, keys, handler, opts });
    return this;
  }

  get(p, h, o) {
    return this.add('GET', p, h, o);
  }

  post(p, h, o) {
    return this.add('POST', p, h, o);
  }

  put(p, h, o) {
    return this.add('PUT', p, h, o);
  }

  delete(p, h, o) {
    return this.add('DELETE', p, h, o);
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return null;
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(text);
}

export async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name, value, { maxAge, secure, path: p = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${p}; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (secure) c += '; Secure';
  return c;
}

export class RateLimiter {
  constructor() {
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  /** true — запрос разрешён */
  take(key, max, windowMs) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const [k, arr] of this.hits) {
      const fresh = arr.filter((t) => now - t < 3_600_000);
      if (fresh.length) this.hits.set(k, fresh);
      else this.hits.delete(k);
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Отдаёт файл из root. Возвращает false, если файла нет. */
export function serveFile(req, res, root, relPath, { immutable = false } = {}) {
  const full = path.resolve(root, '.' + path.posix.normalize('/' + relPath));
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) return false;
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  const etag = '"' + createHash('sha1').update(`${st.size}-${st.mtimeMs}`).digest('hex').slice(0, 16) + '"';
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    etag,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : ext === '.woff2' || ext === '.svg' || ext === '.png' || ext === '.jpg' ? 'public, max-age=86400' : 'no-cache',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(full).pipe(res);
  return true;
}
