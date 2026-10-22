// API админ-панели. Роли: admin (всё) и kitchen (только стоп-лист).
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { HttpError, cookieHeader, readBody } from './http.js';
import { checkLogin, signToken, hashPassword } from './auth.js';
import { clean, allowedActions, closeSession, sessionBill, findSessionById, OrderError } from './orders.js';
import { randomCode } from './seed.js';
import { DAY_KEYS } from '../public/js/common/hours.js';

const ADMIN = { role: 'admin' };
const STAFF = { role: ['admin', 'kitchen'] };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clone = (v) => JSON.parse(JSON.stringify(v));

const bool = (v) => v === true || v === 'true' || v === 1;

function int(v, min, max, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${what}: допустимо от ${min} до ${max}`);
  return Math.round(n);
}

function imageUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.length > 500 || !/^(https?:\/\/|\/uploads\/)/.test(s)) throw new HttpError(400, 'Ссылка на фото должна начинаться с https:// или быть загруженным файлом');
  return s;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('::ffff:');
}

/** Скачиваем только с публичных адресов: админка не должна становиться лазейкой во внутреннюю сеть сервера */
async function isPublicHost(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
  if (net.isIP(hostname)) return !isPrivateIp(hostname);
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

async function downloadImage(url, dir) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || !(await isPublicHost(u.hostname))) throw new Error('адрес недоступен');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: 'error', headers: { 'user-agent': 'dacha-cafe-image-saver' } });
    if (!res.ok) throw new Error(`ответ ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) throw new Error('файл больше 8 МБ');
    const ext = sniffImage(buf);
    if (!ext) throw new Error('это не картинка');
    const name = createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext;
    fs.writeFileSync(path.join(dir, name), buf);
    return '/uploads/' + name;
  } finally {
    clearTimeout(timer);
  }
}

function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  return null;
}

function sanitizeOptions(db, raw) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 6) throw new HttpError(400, 'Не больше 6 групп вариантов у блюда');
  return raw.map((g) => {
    const group = {
      id: clean(g.id, 20) || db.newId('g'),
      name: clean(g.name, 40),
      required: bool(g.required),
    };
    if (!group.name) throw new HttpError(400, 'У группы вариантов должно быть название');
    if (g.ref) {
      if (!/^lunch\.(salads|soups|hots|sides|drinks)$/.test(g.ref)) throw new HttpError(400, 'Неизвестный список');
      group.ref = g.ref;
      return group;
    }
    const choices = Array.isArray(g.choices) ? g.choices : [];
    if (choices.length > 24) throw new HttpError(400, 'Слишком много вариантов в группе');
    group.choices = choices
      .map((c) => ({ id: clean(c.id, 20) || db.newId('c'), name: clean(c.name, 60), price: int(c.price || 0, 0, 100000, 'Доплата') }))
      .filter((c) => c.name);
    if (!group.choices.length) throw new HttpError(400, `В группе «${group.name}» нет вариантов`);
    return group;
  });
}

function applyDish(db, d, b) {
  if ('name' in b) {
    const n = clean(b.name, 80);
    if (!n) throw new HttpError(400, 'Название не может быть пустым');
    d.name = n;
  }
  if ('desc' in b) d.desc = clean(b.desc, 400);
  if ('weight' in b) d.weight = clean(b.weight, 20);
  if ('price' in b) {
    d.price = int(b.price, 0, 100000, 'Цена');
    if (d.price > 0 && d.needsPrice) {
      d.needsPrice = false;
      d.hidden = false;
    }
  }
  if ('image' in b) d.image = imageUrl(b.image);
  if ('tags' in b) d.tags = (Array.isArray(b.tags) ? b.tags : []).filter((t) => ['veg', 'spicy', 'new'].includes(t));
  for (const k of ['hit', 'hidden', 'forTable', 'forDelivery']) if (k in b) d[k] = bool(b[k]);
  if ('stop' in b) {
    d.stop = bool(b.stop);
    d.stopAt = d.stop ? Date.now() : null;
  }
  if ('categoryId' in b && b.categoryId !== d.categoryId) {
    if (!db.config.categories.some((c) => c.id === b.categoryId)) throw new HttpError(400, 'Раздел не найден');
    d.categoryId = b.categoryId;
    d.order = Math.max(0, ...db.config.dishes.filter((x) => x.categoryId === d.categoryId).map((x) => x.order)) + 1;
  }
  if ('options' in b) d.options = sanitizeOptions(db, b.options);
  return d;
}

function sanitizeSettings(db, body) {
  const cur = db.settings;
  const out = {};
  const str = (v, max) => clean(v, max);

  if (body.brand) {
    out.brand = { name: str(body.brand.name, 40) || cur.brand.name, full: str(body.brand.full, 80), tagline: str(body.brand.tagline, 100), city: str(body.brand.city, 40) };
  }
  if (body.contacts) {
    const c = body.contacts;
    out.contacts = { address: str(c.address, 120), place: str(c.place, 120), phone: str(c.phone, 30), phone2: str(c.phone2, 30), email: str(c.email, 80), vk: str(c.vk, 200) };
  }
  if (body.timezone) {
    try {
      new Intl.DateTimeFormat('ru', { timeZone: String(body.timezone) });
      out.timezone = String(body.timezone);
    } catch {
      throw new HttpError(400, 'Неизвестный часовой пояс');
    }
  }
  if (body.hours) {
    out.hours = {};
    for (const k of DAY_KEYS) {
      const h = body.hours[k];
      if (!h || !h[0] || !h[1]) out.hours[k] = null;
      else if (HHMM.test(h[0]) && HHMM.test(h[1])) out.hours[k] = [h[0], h[1]];
      else throw new HttpError(400, 'Время работы указывайте как 11:00');
    }
  }
  if (body.delivery) {
    const d = body.delivery;
    out.delivery = {
      enabled: bool(d.enabled),
      pickupEnabled: bool(d.pickupEnabled),
      freeFrom: int(d.freeFrom ?? cur.delivery.freeFrom, 0, 1_000_000, 'Бесплатная доставка от'),
      fee: int(d.fee ?? cur.delivery.fee, 0, 10_000, 'Стоимость доставки'),
      minOrder: int(d.minOrder ?? cur.delivery.minOrder, 0, 1_000_000, 'Минимальный заказ'),
      eta: str(d.eta, 40),
      stopBeforeCloseMin: int(d.stopBeforeCloseMin ?? cur.delivery.stopBeforeCloseMin, 0, 240, 'Остановка приёма до закрытия'),
      area: str(d.area, 120),
    };
  }
  if (body.payments) {
    const p = { cash: bool(body.payments.cash), card: bool(body.payments.card), sbp: bool(body.payments.sbp) };
    if (!p.cash && !p.card && !p.sbp) throw new HttpError(400, 'Включите хотя бы один способ оплаты');
    out.payments = p;
  }
  if (body.tips) {
    const tips = [...new Set((Array.isArray(body.tips) ? body.tips : []).map((n) => int(n, 0, 30, 'Чаевые')))].sort((a, b) => a - b);
    out.tips = tips.includes(0) ? tips : [0, ...tips];
    if (out.tips.length > 6) throw new HttpError(400, 'Не больше 6 вариантов чаевых');
  }
  if (body.telegram) {
    const t = body.telegram;
    const chat = (v) => {
      const s = String(v ?? '').trim();
      if (s && !/^(-?\d{5,20}|@[A-Za-z0-9_]{4,64})$/.test(s)) throw new HttpError(400, 'ID чата — это число вида -1001234567890');
      return s;
    };
    out.telegram = { token: cur.telegram.token, chatId: chat(t.chatId), deliveryChatId: chat(t.deliveryChatId) };
    if (bool(t.clearToken)) out.telegram.token = '';
    else if (typeof t.token === 'string' && t.token.trim()) {
      if (!/^\d{5,15}:[\w-]{30,60}$/.test(t.token.trim())) throw new HttpError(400, 'Токен выглядит неверно. Он должен быть вида 123456789:AA…');
      out.telegram.token = t.token.trim();
    }
  }
  if (body.lunch) {
    const l = body.lunch;
    const list = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => str(x, 140)).filter(Boolean).slice(0, 30);
    out.lunch = { date: str(l.date, 10), salads: list(l.salads), soups: list(l.soups), hots: list(l.hots), sides: list(l.sides), drinks: list(l.drinks) };
  }
  if (body.banquet) {
    out.banquet = (Array.isArray(body.banquet) ? body.banquet : []).slice(0, 6).map((b) => ({
      name: str(b.name, 60),
      prices: (Array.isArray(b.prices) ? b.prices : []).map((n) => int(n, 0, 100000, 'Цена банкета')).slice(0, 6),
    }));
  }
  if ('legal' in body) out.legal = clean(body.legal, 6000).length ? String(body.legal).slice(0, 12000) : '';
  return out;
}

export function registerAdmin(router, c) {
  const { db, tg, doAction, limiter, publicUrl, notifyFast } = c;

  /* ───────────── вход ───────────── */

  router.get('/api/admin/me', ({ role }) => ({ role }));

  router.post('/api/admin/login', ({ req, res, ip, body }) => {
    if (!limiter.take('login|' + ip, 8, 10 * 60_000)) throw new HttpError(429, 'Слишком много попыток входа. Подождите 10 минут');
    const role = checkLogin(db, String(body.password || ''));
    if (!role) throw new HttpError(401, 'Неверный пароль');
    const secure = publicUrl(req).startsWith('https');
    res.setHeader('set-cookie', cookieHeader('dacha_session', signToken(db, role), { maxAge: 30 * 86400, secure }));
    return { role };
  });

  router.post('/api/admin/logout', ({ res }) => {
    res.setHeader('set-cookie', cookieHeader('dacha_session', '', { maxAge: 0 }));
    return { ok: true };
  });

  /* ───────────── данные ───────────── */

  const settingsView = () => {
    const s = clone(db.settings);
    s.telegram = {
      tokenSet: !!s.telegram.token,
      tokenHint: s.telegram.token ? '••••' + s.telegram.token.slice(-4) : '',
      chatId: s.telegram.chatId,
      deliveryChatId: s.telegram.deliveryChatId,
    };
    return s;
  };

  const unsentCount = () => db.runtime.orders.filter((e) => e.tg && !e.tg.ok && ['new', 'requested'].includes(e.status)).length;

  router.get('/api/admin/bootstrap', ({ role, req }) => {
    const { categories, dishes } = db.config;
    if (role === 'kitchen') return { role, categories, dishes: dishes.map((d) => ({ id: d.id, name: d.name, categoryId: d.categoryId, image: d.image, stop: d.stop, stopAt: d.stopAt || null, hidden: d.hidden, order: d.order, weight: d.weight })) };
    return {
      role,
      publicUrl: publicUrl(req),
      categories,
      dishes,
      halls: db.config.halls,
      tables: db.config.tables,
      menus: db.config.menus,
      promos: db.config.promos,
      settings: settingsView(),
      telegram: { configured: tg.configured, pollError: tg.lastPollError, bot: tg.me?.username || '', unsent: unsentCount() },
      externalImages: dishes.filter((d) => /^https?:\/\//i.test(d.image || '')).length,
    };
  }, STAFF);

  /* ───────────── стоп-лист ───────────── */

  router.post('/api/admin/stop', ({ body }) => {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const stop = bool(body.stop);
    let changed = 0;
    for (const d of db.config.dishes) {
      if (!ids.includes(d.id) || d.stop === stop) continue;
      d.stop = stop;
      d.stopAt = stop ? Date.now() : null;
      changed++;
    }
    db.saveConfig();
    return { ok: true, changed };
  }, STAFF);

  router.post('/api/admin/stop/reset', () => {
    let changed = 0;
    for (const d of db.config.dishes) {
      if (d.stop) {
        d.stop = false;
        d.stopAt = null;
        changed++;
      }
    }
    db.saveConfig();
    return { ok: true, changed };
  }, STAFF);

  /* ───────────── блюда и разделы ───────────── */

  router.put('/api/admin/dishes/:id', ({ params, body }) => {
    const d = db.config.dishes.find((x) => x.id === params.id);
    if (!d) throw new HttpError(404, 'Блюдо не найдено');
    applyDish(db, d, body);
    db.saveConfig();
    return { dish: d };
  }, ADMIN);

  router.post('/api/admin/dishes', ({ body }) => {
    const catId = body.categoryId;
    if (!db.config.categories.some((x) => x.id === catId)) throw new HttpError(400, 'Выберите раздел');
    const d = {
      id: db.newId('d'),
      categoryId: catId,
      name: '',
      desc: '',
      price: 0,
      weight: '',
      image: '',
      tags: [],
      options: [],
      order: Math.max(0, ...db.config.dishes.filter((x) => x.categoryId === catId).map((x) => x.order)) + 1,
      stop: false,
      hidden: false,
      needsPrice: false,
      hit: false,
      forTable: true,
      forDelivery: true,
    };
    applyDish(db, d, { ...body, categoryId: catId });
    if (!d.name) throw new HttpError(400, 'Укажите название');
    if (!(d.price > 0)) throw new HttpError(400, 'Укажите цену больше нуля');
    db.config.dishes.push(d);
    db.saveConfig();
    return { dish: d };
  }, ADMIN);

  router.delete('/api/admin/dishes/:id', ({ params }) => {
    const i = db.config.dishes.findIndex((x) => x.id === params.id);
    if (i < 0) throw new HttpError(404, 'Блюдо не найдено');
    db.config.dishes.splice(i, 1);
    db.saveConfig();
    return { ok: true };
  }, ADMIN);

  router.post('/api/admin/reorder', ({ body }) => {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (body.kind === 'categories') {
      ids.forEach((id, i) => {
        const cat = db.config.categories.find((x) => x.id === id);
        if (cat) cat.order = i;
      });
    } else {
      ids.forEach((id, i) => {
        const d = db.config.dishes.find((x) => x.id === id && x.categoryId === body.categoryId);
        if (d) d.order = i + 1;
      });
    }
    db.saveConfig();
    return { ok: true };
  }, ADMIN);

  const catFields = (cat, b) => {
    if ('name' in b) {
      const n = clean(b.name, 40);
      if (!n) throw new HttpError(400, 'Название раздела не может быть пустым');
      cat.name = n;
    }
    if ('note' in b) cat.note = clean(b.note, 60);
    if ('hidden' in b) cat.hidden = bool(b.hidden);
    for (const k of ['from', 'to']) {
      if (k in b) {
        const v = String(b[k] || '');
        if (v && !HHMM.test(v)) throw new HttpError(400, 'Время доступности указывайте как 11:00');
        cat[k] = v;
      }
    }
    if ((cat.from && !cat.to) || (!cat.from && cat.to)) throw new HttpError(400, 'Укажите время «с» и «до» вместе или оставьте пустыми');
  };

  router.post('/api/admin/categories', ({ body }) => {
    const cat = { id: db.newId('c'), name: '', note: '', order: Math.max(-1, ...db.config.categories.map((x) => x.order)) + 1, hidden: false, from: '', to: '' };
    catFields(cat, body);
    if (!cat.name) throw new HttpError(400, 'Укажите название раздела');
    db.config.categories.push(cat);
    db.saveConfig();
    return { category: cat };
  }, ADMIN);

  router.put('/api/admin/categories/:id', ({ params, body }) => {
    const cat = db.config.categories.find((x) => x.id === params.id);
    if (!cat) throw new HttpError(404, 'Раздел не найден');
    catFields(cat, body);
    db.saveConfig();
    return { category: cat };
  }, ADMIN);

  router.delete('/api/admin/categories/:id', ({ params }) => {
    const i = db.config.categories.findIndex((x) => x.id === params.id);
    if (i < 0) throw new HttpError(404, 'Раздел не найден');
    if (db.config.dishes.some((d) => d.categoryId === params.id)) throw new HttpError(409, 'В разделе есть блюда. Сначала перенесите или удалите их');
    db.config.categories.splice(i, 1);
    for (const m of db.config.menus) if (m.categoryIds) m.categoryIds = m.categoryIds.filter((x) => x !== params.id);
    db.saveConfig();
    return { ok: true };
  }, ADMIN);

  /** Массовое изменение цен: на процент или на сумму, с округлением. dry=true — только посмотреть. */
  router.post('/api/admin/prices/bulk', ({ body }) => {
    const mode = body.mode === 'rub' ? 'rub' : 'percent';
    const value = Number(body.value);
    if (!Number.isFinite(value) || value === 0) throw new HttpError(400, 'Укажите, на сколько изменить цены');
    if (mode === 'percent' && (value < -90 || value > 300)) throw new HttpError(400, 'Процент: от −90 до 300');
    if (mode === 'rub' && Math.abs(value) > 10_000) throw new HttpError(400, 'Сумма: не больше 10 000 ₽');
    const round = [1, 5, 10].includes(Number(body.round)) ? Number(body.round) : 10;
    const cats = Array.isArray(body.categoryIds) && body.categoryIds.length ? body.categoryIds : null;
    const targets = db.config.dishes.filter((d) => d.price > 0 && (!cats || cats.includes(d.categoryId)));
    const calc = (p) => {
      const raw = mode === 'percent' ? p * (1 + value / 100) : p + value;
      return Math.max(round, Math.round(raw / round) * round);
    };
    const changes = targets.map((d) => ({ id: d.id, name: d.name, from: d.price, to: calc(d.price) })).filter((x) => x.from !== x.to);
    if (!bool(body.dry)) {
      for (const ch of changes) db.config.dishes.find((d) => d.id === ch.id).price = ch.to;
      db.saveConfig();
    }
    return { count: changes.length, preview: changes.slice(0, 6) };
  }, ADMIN);

  /* ───────────── залы, столы, QR ───────────── */

  router.post('/api/admin/halls', ({ body }) => {
    const name = clean(body.name, 40);
    if (!name) throw new HttpError(400, 'Укажите название зала');
    const hall = { id: db.newId('h'), name, seats: int(body.seats || 0, 0, 1000, 'Вместимость') };
    db.config.halls.push(hall);
    db.saveConfig();
    return { hall };
  }, ADMIN);

  router.put('/api/admin/halls/:id', ({ params, body }) => {
    const hall = db.config.halls.find((h) => h.id === params.id);
    if (!hall) throw new HttpError(404, 'Зал не найден');
    if ('name' in body) hall.name = clean(body.name, 40) || hall.name;
    if ('seats' in body) hall.seats = int(body.seats || 0, 0, 1000, 'Вместимость');
    db.saveConfig();
    return { hall };
  }, ADMIN);

  router.delete('/api/admin/halls/:id', ({ params }) => {
    if (db.config.tables.some((t) => t.hallId === params.id)) throw new HttpError(409, 'В зале есть столы. Сначала перенесите или удалите их');
    db.config.halls = db.config.halls.filter((h) => h.id !== params.id);
    db.saveConfig();
    return { ok: true };
  }, ADMIN);

  const tableFields = (t, b) => {
    if ('number' in b) {
      const n = clean(b.number, 6);
      if (!n) throw new HttpError(400, 'Укажите номер стола');
      if (db.config.tables.some((x) => x.number === n && x.id !== t.id)) throw new HttpError(409, `Стол ${n} уже есть`);
      t.number = n;
    }
    if ('hallId' in b) {
      if (!db.config.halls.some((h) => h.id === b.hallId)) throw new HttpError(400, 'Зал не найден');
      t.hallId = b.hallId;
    }
    if ('menuId' in b) {
      if (!db.config.menus.some((m) => m.id === b.menuId)) throw new HttpError(400, 'Набор меню не найден');
      t.menuId = b.menuId;
    }
  };

  const newCode = () => {
    for (let i = 0; i < 20; i++) {
      const code = randomCode();
      if (!db.config.tables.some((t) => t.code === code)) return code;
    }
    throw new HttpError(500, 'Не удалось создать код стола');
  };

  router.post('/api/admin/tables', ({ body }) => {
    const t = { id: db.newId('t'), number: '', hallId: db.config.halls[0]?.id, menuId: 'main', code: newCode() };
    tableFields(t, body);
    db.config.tables.push(t);
    db.saveConfig();
    return { table: t };
  }, ADMIN);

  /** Несколько столов сразу: «с 15 по 24» */
  router.post('/api/admin/tables/bulk', ({ body }) => {
    const from = int(body.from, 1, 999, 'Первый стол');
    const to = int(body.to, from, Math.min(999, from + 99), 'Последний стол');
    const created = [];
    for (let n = from; n <= to; n++) {
      if (db.config.tables.some((x) => x.number === String(n))) continue;
      const t = { id: db.newId('t'), number: String(n), hallId: db.config.halls[0]?.id, menuId: 'main', code: newCode() };
      tableFields(t, { hallId: body.hallId, menuId: body.menuId });
      db.config.tables.push(t);
      created.push(t);
    }
    db.saveConfig();
    return { created: created.length };
  }, ADMIN);

  router.put('/api/admin/tables/:id', ({ params, body }) => {
    const t = db.config.tables.find((x) => x.id === params.id);
    if (!t) throw new HttpError(404, 'Стол не найден');
    tableFields(t, body);
    db.saveConfig();
    return { table: t };
  }, ADMIN);

  router.post('/api/admin/tables/:id/regen', ({ params }) => {
    const t = db.config.tables.find((x) => x.id === params.id);
    if (!t) throw new HttpError(404, 'Стол не найден');
    t.code = newCode();
    db.saveConfig();
    return { table: t };
  }, ADMIN);

  router.delete('/api/admin/tables/:id', ({ params }) => {
    const s = db.runtime.sessions[params.id];
    if (s && !s.closedAt) throw new HttpError(409, 'За столом сейчас сидят гости. Сначала закройте стол');
    db.config.tables = db.config.tables.filter((x) => x.id !== params.id);
    db.saveConfig();
    return { ok: true };
  }, ADMIN);

  router.put('/api/admin/menus', ({ body }) => {
    const list = (Array.isArray(body.menus) ? body.menus : []).slice(0, 12).map((m) => ({
      id: clean(m.id, 20) || db.newId('m'),
      name: clean(m.name, 40),
      categoryIds: m.categoryIds === null ? null : (Array.isArray(m.categoryIds) ? m.categoryIds : []).filter((id) => db.config.categories.some((c) => c.id === id)),
    }));
    if (list.some((m) => !m.name)) throw new HttpError(400, 'У набора меню должно быть название');
    if (!list.some((m) => m.id === 'main')) throw new HttpError(400, 'Основное меню удалять нельзя');
    db.config.menus = list;
    for (const t of db.config.tables) if (!list.some((m) => m.id === t.menuId)) t.menuId = 'main';
    db.saveConfig();
    return { menus: list };
  }, ADMIN);

  router.get('/api/admin/qr.svg', async ({ url, res }) => {
    const text = String(url.searchParams.get('text') || '');
    if (!text || text.length > 600) throw new HttpError(400, 'Нечего кодировать');
    const svg = await QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#14213D', light: '#0000' } });
    res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'private, max-age=3600' });
    res.end(svg);
  }, ADMIN);

  /* ───────────── настройки ───────────── */

  router.put('/api/admin/settings', ({ body }) => {
    const patch = sanitizeSettings(db, body);
    const tokenChanged = patch.telegram && patch.telegram.token !== db.settings.telegram.token;
    Object.assign(db.settings, patch);
    db.saveConfig();
    if (tokenChanged) {
      tg.me = null;
      tg.offset = 0;
    }
    return { settings: settingsView() };
  }, ADMIN);

  router.post('/api/admin/password', ({ body }) => {
    const role = body.role === 'kitchen' ? 'kitchen' : 'admin';
    const pw = String(body.password || '');
    if (pw.length < 6) throw new HttpError(400, 'Пароль — минимум 6 символов');
    db.config.auth[role === 'admin' ? 'adminHash' : 'kitchenHash'] = hashPassword(pw);
    db.saveConfig();
    return { ok: true };
  }, ADMIN);

  router.post('/api/admin/password/kitchen/remove', () => {
    delete db.config.auth.kitchenHash;
    db.saveConfig();
    return { ok: true };
  }, ADMIN);

  router.put('/api/admin/promos', ({ body }) => {
    const list = (Array.isArray(body.promos) ? body.promos : []).slice(0, 20).map((p) => ({
      code: clean(p.code, 30).toUpperCase(),
      percent: int(p.percent, 1, 90, 'Скидка'),
      active: bool(p.active),
      note: clean(p.note, 120),
    }));
    if (list.some((p) => !p.code)) throw new HttpError(400, 'Укажите промокод');
    if (new Set(list.map((p) => p.code)).size !== list.length) throw new HttpError(400, 'Промокоды не должны повторяться');
    db.config.promos = list;
    db.saveConfig();
    return { promos: list };
  }, ADMIN);

  router.post('/api/admin/telegram/test', async () => {
    try {
      const r = await tg.test();
      return { ok: true, ...r };
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }, ADMIN);

  router.post('/api/admin/telegram/resend', async () => ({ ok: true, ...(await tg.resendUnsent()) }), ADMIN);

  /* ───────────── заказы и столы сейчас ───────────── */

  const view = (e) => {
    const { key, token, ...rest } = e;
    return { ...rest, allowed: allowedActions(e), tg: e.tg ? { ok: e.tg.ok, error: e.tg.error, attempts: e.tg.attempts } : null };
  };

  router.get('/api/admin/orders', ({ url }) => {
    const types = (url.searchParams.get('types') || '').split(',').filter(Boolean);
    const limit = Math.min(300, Number(url.searchParams.get('limit')) || 120);
    const list = db.runtime.orders
      .filter((e) => !types.length || types.includes(e.type))
      .slice(-limit)
      .reverse()
      .map(view);
    return { orders: list };
  }, ADMIN);

  router.post('/api/admin/orders/:id/action', async ({ params, body, role }) => {
    const r = await doAction(params.id, String(body.action || ''), 'админка');
    if (!r.entry) throw new HttpError(404, r.toast);
    if (r.error) throw new HttpError(r.error.status || 400, r.toast);
    return { entry: view(r.entry), toast: r.toast };
  }, ADMIN);

  router.post('/api/admin/orders/:id/resend', async ({ params }) => {
    const e = db.getEntry(params.id);
    if (!e) throw new HttpError(404, 'Запись не найдена');
    if (e.tg) e.tg.attempts = 0;
    await notifyFast(e);
    return { entry: view(e) };
  }, ADMIN);

  router.get('/api/admin/live', () => {
    const now = Date.now();
    const rows = [];
    for (const t of db.config.tables) {
      const s = db.runtime.sessions[t.id];
      if (!s || s.closedAt) continue;
      const orders = s.orderIds.map((id) => db.getEntry(id)).filter(Boolean);
      const bill = sessionBill(db, s);
      const calls = s.callIds.map((id) => db.getEntry(id)).filter((x) => x && x.status !== 'done');
      const pay = s.payId ? db.getEntry(s.payId) : null;
      rows.push({
        tableId: t.id,
        number: t.number,
        hall: db.config.halls.find((h) => h.id === t.hallId)?.name || '',
        sessionId: s.id,
        guests: s.guests.map((g) => ({ name: g.name, color: g.color, paid: g.paid })),
        orders: orders.length,
        newOrders: orders.filter((o) => o.status === 'new').length,
        total: bill.total,
        calls: calls.map((x) => ({ id: x.id, label: x.label, status: x.status })),
        payment: pay && ['requested', 'ack'].includes(pay.status) ? { id: pay.id, status: pay.status, total: pay.total, method: pay.method } : null,
        idleMin: Math.round((now - s.updatedAt) / 60000),
      });
    }
    return { tables: rows };
  }, ADMIN);

  router.post('/api/admin/sessions/:id/close', ({ params }) => {
    const s = findSessionById(db, params.id);
    if (!s) throw new OrderError('Стол не найден', { status: 404 });
    closeSession(db, params.id);
    return { ok: true };
  }, ADMIN);

  /* ───────────── загрузка фото ───────────── */

  /** Фото блюд, которые пока лежат на чужом сайте, сохраняются на наш сервер */
  router.post('/api/admin/images/localize', async () => {
    const dir = path.join(db.dir, 'uploads');
    const todo = db.config.dishes.filter((d) => /^https?:\/\//i.test(d.image || ''));
    const cache = new Map();
    let ok = 0;
    const failed = [];
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const d = todo[i++];
        try {
          if (!cache.has(d.image)) cache.set(d.image, downloadImage(d.image, dir));
          d.image = await cache.get(d.image);
          ok++;
        } catch (e) {
          failed.push({ name: d.name, error: e.message });
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    db.saveConfig(true);
    return { total: todo.length, ok, failed: failed.slice(0, 10), failedCount: failed.length };
  }, ADMIN);

  router.post('/api/admin/upload', async ({ req }) => {
    const buf = await readBody(req, 6 * 1024 * 1024);
    const ext = sniffImage(buf);
    if (!ext) throw new HttpError(400, 'Нужна картинка в формате JPG, PNG, WebP или GIF');
    const name = randomBytes(8).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(db.dir, 'uploads', name), buf);
    return { url: '/uploads/' + name };
  }, { role: 'admin', raw: true });
}
