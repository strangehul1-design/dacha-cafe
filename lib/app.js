// Сборка приложения: маршруты, страницы, Telegram. Используется и сервером, и тестами.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './db.js';
import { initAuth, readToken } from './auth.js';
import { Telegram } from './telegram.js';
import { Router, HttpError, sendJson, sendText, readJson, parseCookies, RateLimiter, serveFile } from './http.js';
import { buildMenu, findMenuSet } from './menu.js';
import {
  OrderError,
  getSession,
  publicSession,
  addGuest,
  renameGuest,
  createTableOrder,
  requestPayment,
  callWaiter,
  CALL_REASONS,
  createDeliveryOrder,
  deliverySlots,
  deliveryAvailability,
  previewPromo,
  createReservation,
  applyAction,
  closeSession,
  clean,
} from './orders.js';
import { openState } from '../public/js/common/hours.js';
import { registerAdmin } from './admin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApp({ dataDir, env = process.env, apiBase, log = console } = {}) {
  const db = new Db(dataDir || path.join(ROOT, 'data'));

  // Telegram из переменных окружения подставляется, только пока не задан в админке
  const tgCfg = db.settings.telegram;
  if (!tgCfg.token && env.TELEGRAM_BOT_TOKEN) tgCfg.token = env.TELEGRAM_BOT_TOKEN;
  if (!tgCfg.chatId && env.TELEGRAM_CHAT_ID) tgCfg.chatId = env.TELEGRAM_CHAT_ID;
  if (!tgCfg.deliveryChatId && env.TELEGRAM_DELIVERY_CHAT_ID) tgCfg.deliveryChatId = env.TELEGRAM_DELIVERY_CHAT_ID;
  db.saveConfig();

  const generatedPassword = initAuth(db, env);
  const limiter = new RateLimiter();
  const trustProxy = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true';

  const tg = new Telegram(db, {
    apiBase: apiBase || env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    log,
    onAction: (id, action, actor) => doAction(id, action, actor),
  });

  /** Меняет статус и обновляет сообщение в Telegram. Общая точка для кнопок бота и админки. */
  async function doAction(id, action, actor) {
    const entry = db.getEntry(id);
    if (!entry) return { toast: 'Запись не найдена', entry: null };
    try {
      applyAction(db, entry, action, actor);
    } catch (e) {
      if (e instanceof OrderError) {
        if (e.code === 'stale') await tg.refresh(entry);
        return { toast: e.code === 'stale' ? 'Уже обработано' : e.message, entry, error: e };
      }
      throw e;
    }
    await tg.refresh(entry);
    const session = entry.sessionId ? Object.values(db.runtime.sessions).find((s) => s.id === entry.sessionId) : null;
    return { toast: entry.type === 'pay' && entry.status === 'done' && session?.closedAt ? 'Оплачено, стол закрыт' : 'Готово', entry };
  }

  /** Ждём Telegram недолго: гостю важно получить ответ быстро, повторы идут в фоне */
  async function notifyFast(entry) {
    await Promise.race([tg.notify(entry), sleep(4000)]);
    return !!entry.tg?.ok;
  }

  const clientIp = (req) => {
    if (trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  // key по умолчанию — IP. Для столов ключ — сам стол: в кафе все сидят на одном Wi-Fi,
  // значит у всех столов один IP, и лимит «на IP» заблокировал бы весь зал.
  const limit = (ctx, name, max, windowMs, key = ctx.ip) => {
    if (!limiter.take(`${name}|${key}`, max, windowMs)) throw new HttpError(429, 'Слишком много запросов. Подождите минуту и попробуйте снова');
  };

  const publicUrl = (req) => {
    if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    return `${proto}://${req.headers.host}`;
  };

  const findTable = (code) => {
    const c = String(code || '').toLowerCase();
    const table = db.config.tables.find((t) => t.code === c);
    if (!table) throw new HttpError(404, 'Стол не найден. Отсканируйте QR-код на столе ещё раз');
    return table;
  };

  const router = new Router();
  const ctxBase = { db, tg, doAction, limiter, publicUrl, findTable, notifyFast, env };

  /* ───────────── публичный API ───────────── */

  router.get('/api/config', ({ req }) => {
    const s = db.settings;
    const now = new Date();
    const avail = deliveryAvailability(db, now);
    return {
      brand: s.brand,
      contacts: s.contacts,
      hours: s.hours,
      timezone: s.timezone,
      open: openState(s.hours, s.timezone, now),
      delivery: {
        enabled: s.delivery.enabled,
        pickupEnabled: s.delivery.pickupEnabled,
        freeFrom: s.delivery.freeFrom,
        fee: s.delivery.fee,
        minOrder: s.delivery.minOrder,
        eta: s.delivery.eta,
        area: s.delivery.area,
        availability: avail,
      },
      payments: s.payments,
      tips: s.tips,
      banquet: s.banquet,
      halls: db.config.halls,
      lunchDate: s.lunch.date,
      promo: db.config.promos.some((p) => p.active),
      legalSet: !!s.legal,
      serverTime: now.toISOString(),
    };
  });

  router.get('/api/menu', ({ url }) => {
    const mode = url.searchParams.get('mode') === 'delivery' ? 'delivery' : 'table';
    let menuId = null;
    if (mode === 'table' && url.searchParams.get('table')) menuId = findTable(url.searchParams.get('table')).menuId;
    const menu = buildMenu(db, { mode, menuId });
    if (url.searchParams.get('rev') === menu.rev) return { same: true, rev: menu.rev };
    return menu;
  });

  router.get('/api/privacy', () => ({ text: db.settings.legal, brand: db.settings.brand, contacts: db.settings.contacts }));

  // --- доставка
  router.get('/api/delivery/slots', () => ({ slots: deliverySlots(db), availability: deliveryAvailability(db) }));

  router.post('/api/promo', async ({ body, ...ctx }) => {
    limit(ctx, 'promo', 20, 60_000);
    return previewPromo(db, body.code, Number(body.subtotal) || 0);
  });

  router.post('/api/delivery/order', async (ctx) => {
    limit(ctx, 'delivery', 40, 10 * 60_000);
    const { order } = createDeliveryOrder(db, ctx.body);
    const delivered = await notifyFast(order);
    return { ok: true, delivered, order: { num: order.num, token: order.token, status: order.status, total: order.total, when: order.when, fulfil: order.fulfil } };
  });

  router.get('/api/delivery/order/:token', ({ params }) => {
    const o = db.runtime.orders.find((x) => x.type === 'delivery' && x.token === params.token);
    if (!o) throw new HttpError(404, 'Заказ не найден');
    return { num: o.num, status: o.status, fulfil: o.fulfil, when: o.when, total: o.total };
  });

  router.post('/api/reserve', async (ctx) => {
    limit(ctx, 'reserve', 5, 10 * 60_000);
    const { entry } = createReservation(db, ctx.body);
    const delivered = await notifyFast(entry);
    return { ok: true, delivered, num: entry.num };
  });

  /* ───────────── стол по QR ───────────── */

  const emptySession = { id: null, updatedAt: 0, guests: [], orders: [], bill: { total: 0, perGuest: {} }, payment: null, calls: [] };

  router.get('/api/table/:code', ({ params }) => {
    const table = findTable(params.code);
    const hall = db.config.halls.find((h) => h.id === table.hallId);
    const set = findMenuSet(db.config, table.menuId);
    const session = getSession(db, table, { create: false });
    return {
      table: { number: table.number, hall: hall ? { id: hall.id, name: hall.name } : null, menuName: set?.name || '' },
      session: session ? publicSession(db, session) : emptySession,
      payments: db.settings.payments,
      tips: db.settings.tips,
      callReasons: CALL_REASONS,
      brand: db.settings.brand,
      contacts: db.settings.contacts,
    };
  });

  router.post('/api/table/:code/guests', (ctx) => {
    const table = findTable(ctx.params.code);
    limit(ctx, 'guest', 40, 10 * 60_000, table.id);
    const session = getSession(db, table);
    const guest = addGuest(db, session, ctx.body.name);
    return { guest, session: publicSession(db, session) };
  });

  router.put('/api/table/:code/guests/:id', (ctx) => {
    const table = findTable(ctx.params.code);
    limit(ctx, 'guest', 40, 10 * 60_000, table.id);
    const session = getSession(db, table);
    const guest = renameGuest(db, session, ctx.params.id, ctx.body.name);
    return { guest, session: publicSession(db, session) };
  });

  router.post('/api/table/:code/order', async (ctx) => {
    const table = findTable(ctx.params.code);
    limit(ctx, 'table-order', 20, 5 * 60_000, table.id);
    const { order, session, duplicate } = createTableOrder(db, table, ctx.body);
    const delivered = duplicate ? !!order.tg?.ok : await notifyFast(order);
    return { ok: true, delivered, order: { id: order.id, num: order.num, status: order.status, total: order.total }, session: publicSession(db, session) };
  });

  router.post('/api/table/:code/call', async (ctx) => {
    const table = findTable(ctx.params.code);
    limit(ctx, 'call', 12, 5 * 60_000, table.id);
    const { call, session, duplicate } = callWaiter(db, table, ctx.body);
    const delivered = duplicate ? !!call.tg?.ok : await notifyFast(call);
    return { ok: true, delivered, call: { id: call.id, status: call.status, label: call.label }, session: publicSession(db, session) };
  });

  router.post('/api/table/:code/pay', async (ctx) => {
    const table = findTable(ctx.params.code);
    limit(ctx, 'pay', 12, 5 * 60_000, table.id);
    const { payment, replaced, session } = requestPayment(db, table, ctx.body);
    if (replaced) tg.refresh(replaced).catch(() => {});
    const delivered = await notifyFast(payment);
    return { ok: true, delivered, session: publicSession(db, session) };
  });

  router.post('/api/table/:code/pay/cancel', async (ctx) => {
    const table = findTable(ctx.params.code);
    limit(ctx, 'pay', 12, 5 * 60_000, table.id);
    const session = getSession(db, table, { create: false });
    const pay = session?.payId ? db.getEntry(session.payId) : null;
    if (pay && ['requested', 'ack'].includes(pay.status)) {
      applyAction(db, pay, 'cancel', 'гость со стола');
      await tg.refresh(pay);
    }
    return { ok: true, session: session ? publicSession(db, session) : emptySession };
  });

  registerAdmin(router, ctxBase);

  /* ───────────── обработчик запросов ───────────── */

  const SECURITY = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'SAMEORIGIN',
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
  };

  const PAGES = [
    [/^\/(menu)?$/, 'index.html'],
    [/^\/t\/[^/]+\/?$/, 'table.html'],
    [/^\/admin(\/.*)?$/, 'admin.html'],
    [/^\/privacy\/?$/, 'privacy.html'],
  ];

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      if (p.startsWith('/api/')) {
        const method = req.method === 'HEAD' ? 'GET' : req.method;
        const m = router.match(method, p);
        if (!m) throw new HttpError(404, 'Не найдено');
        const ctx = { req, res, url, params: m.params, ip: clientIp(req), body: {}, role: null, ...ctxBase };
        const token = parseCookies(req).dacha_session;
        ctx.role = token ? readToken(db, token) : null;
        if (m.route.opts.role) {
          const allowed = Array.isArray(m.route.opts.role) ? m.route.opts.role : [m.route.opts.role];
          if (!ctx.role) throw new HttpError(401, 'Нужно войти');
          if (!allowed.includes(ctx.role)) throw new HttpError(403, 'Недостаточно прав');
        }
        if (['POST', 'PUT', 'DELETE'].includes(req.method) && !m.route.opts.raw) ctx.body = await readJson(req);
        const out = await m.route.handler(ctx);
        if (!res.writableEnded && out !== undefined) sendJson(res, 200, out);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');

      for (const [re, file] of PAGES) {
        if (re.test(p)) {
          res.setHeader('cache-control', 'no-cache');
          if (serveFile(req, res, PUBLIC, file)) return;
        }
      }
      if (p.startsWith('/uploads/')) {
        if (serveFile(req, res, path.join(db.dir, 'uploads'), p.slice('/uploads/'.length), { immutable: true })) return;
      } else if (serveFile(req, res, PUBLIC, p)) return;

      if (p.includes('.')) throw new HttpError(404, 'Файл не найден');
      // неизвестный путь без расширения — на главную страницу
      if (serveFile(req, res, PUBLIC, 'index.html')) return;
      throw new HttpError(404, 'Не найдено');
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof OrderError) return sendJson(res, e.status, { error: e.message, code: e.code, problems: e.problems });
      if (e instanceof HttpError) {
        if (!p.startsWith('/api/') && e.status === 404) return sendText(res, 404, 'Страница не найдена');
        return sendJson(res, e.status, { error: e.message, ...e.extra });
      }
      log.error?.(`[http] ${req.method} ${p}:`, e);
      sendJson(res, 500, { error: 'Что-то пошло не так. Попробуйте ещё раз' });
    }
  }

  const server = http.createServer(handle);
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;

  const housekeeping = setInterval(() => db.prune(), 30 * 60_000);
  housekeeping.unref();

  return {
    server,
    db,
    tg,
    generatedPassword,
    doAction,
    closeSession: (id) => closeSession(db, id),
    clean,
    async close() {
      tg.stop();
      clearInterval(housekeeping);
      limiter.timer && clearInterval(limiter.timer);
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      db.flush();
    },
  };
}
