// Бизнес-логика: цены считает сервер (клиенту не доверяем), сессии столов, оплата,
// вызов официанта, доставка, бронь и статусы.
import { SHARED, computeBill, tipOf } from '../public/js/common/bill.js';
import { normalizePhone } from '../public/js/common/format.js';
import { openState, localParts, toMin } from '../public/js/common/hours.js';
import { resolveOptions, dishCategoryAvailable, findMenuSet } from './menu.js';

export class OrderError extends Error {
  constructor(message, { code = 'bad_request', status = 400, problems } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.problems = problems;
  }
}

export const clean = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const sumLines = (lines) => lines.reduce((s, l) => s + l.unit * l.qty, 0);

/* ───────────── цены и проверка корзины ───────────── */

/**
 * Проверяет строки заказа и пересчитывает цены по актуальному меню.
 * При проблемах (стоп-лист, блюдо убрали, не выбран вариант) бросает OrderError с problems.
 * Возвращает строки в том же порядке, что и пришли; исходная строка лежит в _src.
 */
export function priceLines(db, raw, { mode, menuId = null, now = new Date() }) {
  if (!Array.isArray(raw) || raw.length === 0) throw new OrderError('Корзина пуста');
  if (raw.length > 60) throw new OrderError('Слишком много позиций в одном заказе');
  const set = menuId ? findMenuSet(db.config, menuId) : null;
  const lines = [];
  const problems = [];

  for (const r of raw) {
    const dish = db.config.dishes.find((d) => d.id === r?.dishId);
    const allowedByMode = dish && (mode === 'delivery' ? dish.forDelivery !== false : dish.forTable !== false);
    const allowedBySet = dish && !(set?.categoryIds && !set.categoryIds.includes(dish.categoryId));
    if (!dish || dish.hidden || !allowedByMode || !allowedBySet || !(dish.price > 0)) {
      problems.push({ dishId: r?.dishId, name: dish?.name || 'Блюдо', reason: 'gone' });
      continue;
    }
    if (dish.stop) {
      problems.push({ dishId: dish.id, name: dish.name, reason: 'stop' });
      continue;
    }
    if (!dishCategoryAvailable(db, dish, now)) {
      problems.push({ dishId: dish.id, name: dish.name, reason: 'closed' });
      continue;
    }
    const qty = Number(r.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 30) throw new OrderError('Некорректное количество');

    const { groups, unavailable } = resolveOptions(dish, db.settings);
    if (unavailable) {
      problems.push({ dishId: dish.id, name: dish.name, reason: 'stop' });
      continue;
    }
    const chosen = r.options && typeof r.options === 'object' ? r.options : {};
    let unit = dish.price;
    const opts = [];
    let bad = false;
    for (const g of groups) {
      const pick = chosen[g.id];
      if (!pick) {
        if (g.required) bad = true;
        continue;
      }
      const c = g.choices.find((x) => x.id === pick);
      if (!c) {
        bad = true;
        continue;
      }
      unit += c.price || 0;
      opts.push({ group: g.name, choice: c.name });
    }
    if (bad) {
      problems.push({ dishId: dish.id, name: dish.name, reason: 'options' });
      continue;
    }
    lines.push({
      id: db.newId('l'),
      dishId: dish.id,
      name: dish.name,
      qty,
      unit,
      opts,
      note: clean(r.note, 140),
      _src: r,
    });
  }

  if (problems.length) {
    const text = problems
      .map((p) => {
        if (p.reason === 'stop') return `«${p.name}» закончилось`;
        if (p.reason === 'closed') return `«${p.name}» сейчас недоступно по времени`;
        if (p.reason === 'options') return `«${p.name}»: выберите вариант заново`;
        return `«${p.name}» убрали из меню`;
      })
      .join('; ');
    throw new OrderError(text, { code: 'menu_changed', status: 409, problems });
  }
  return lines;
}

/* ───────────── сессии столов ───────────── */

const SESSION_IDLE_MS = 10 * 3600 * 1000;

export function getSession(db, table, { create = true, now = Date.now() } = {}) {
  let s = db.runtime.sessions[table.id];
  if (s && (s.closedAt || now - s.updatedAt > SESSION_IDLE_MS)) s = null;
  if (!s && create) {
    s = { id: db.newId('s'), tableId: table.id, openedAt: now, updatedAt: now, closedAt: null, guests: [], orderIds: [], callIds: [], payId: null };
    db.runtime.sessions[table.id] = s;
    db.saveRuntime();
  }
  return s || null;
}

export function sessionOrders(db, session) {
  return session.orderIds.map((id) => db.getEntry(id)).filter(Boolean);
}

export function sessionBill(db, session) {
  return computeBill(sessionOrders(db, session), session.guests);
}

export function addGuest(db, session, name) {
  if (session.guests.length >= 12) throw new OrderError('За столом уже 12 гостей — больше добавить нельзя');
  const used = new Set(session.guests.map((g) => g.color));
  let color = 0;
  while (used.has(color) && color < 8) color++;
  if (color >= 8) color = session.guests.length % 8;
  const guest = { id: db.newId('g'), name: clean(name, 20) || `Гость ${session.guests.length + 1}`, color, paid: false };
  session.guests.push(guest);
  session.updatedAt = Date.now();
  db.saveRuntime();
  return guest;
}

export function renameGuest(db, session, guestId, name) {
  const g = session.guests.find((x) => x.id === guestId);
  if (!g) throw new OrderError('Гость не найден', { status: 404, code: 'not_found' });
  const n = clean(name, 20);
  if (!n) throw new OrderError('Введите имя');
  g.name = n;
  session.updatedAt = Date.now();
  db.saveRuntime();
  return g;
}

/** Данные сессии для телефонов за столом */
export function publicSession(db, session) {
  const orders = sessionOrders(db, session).map((o) => ({
    id: o.id,
    num: o.num,
    createdAt: o.createdAt,
    status: o.status,
    note: o.note,
    total: o.total,
    lines: o.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, unit: l.unit, opts: l.opts, note: l.note, guestId: l.guestId, splitAmong: l.splitAmong || null })),
  }));
  const bill = sessionBill(db, session);
  const pay = session.payId ? db.getEntry(session.payId) : null;
  const calls = session.callIds
    .map((id) => db.getEntry(id))
    .filter(Boolean)
    .slice(-5)
    .map((c) => ({ id: c.id, reason: c.reason, label: c.label, status: c.status, createdAt: c.createdAt }));
  return {
    id: session.id,
    updatedAt: session.updatedAt,
    guests: session.guests,
    orders,
    bill,
    payment: pay
      ? { id: pay.id, status: pay.status, method: pay.method, mode: pay.mode, guestIds: pay.guestIds, amounts: pay.amounts, tipPct: pay.tipPct, tip: pay.tip, total: pay.total, createdAt: pay.createdAt }
      : null,
    calls,
  };
}

export function createTableOrder(db, table, body, now = new Date()) {
  const session = getSession(db, table, { now: now.getTime() });
  if (!session.guests.length) throw new OrderError('Сначала добавьте гостя');

  const key = clean(body.key, 40);
  if (key) {
    const dup = sessionOrders(db, session).find((o) => o.key === key);
    if (dup) return { order: dup, session, duplicate: true };
  }

  const lines = priceLines(db, body.lines, { mode: 'table', menuId: table.menuId, now });
  const guestIds = new Set(session.guests.map((g) => g.id));
  for (const l of lines) {
    const gid = l._src.guestId;
    if (gid !== SHARED && !guestIds.has(gid)) throw new OrderError('Гость не найден за столом — обновите страницу');
    l.guestId = gid;
    if (gid === SHARED) {
      const among = (Array.isArray(l._src.splitAmong) ? l._src.splitAmong : []).filter((id) => guestIds.has(id));
      l.splitAmong = among.length ? among : [...guestIds];
    }
    delete l._src;
  }

  const hall = db.config.halls.find((h) => h.id === table.hallId);
  const order = db.addEntry({
    id: db.newId('o'),
    type: 'table',
    num: db.nextOrderNum(),
    createdAt: Date.now(),
    status: 'new',
    key,
    tableId: table.id,
    tableNumber: table.number,
    hallName: hall?.name || '',
    sessionId: session.id,
    guestNames: Object.fromEntries(session.guests.map((g) => [g.id, g.name])),
    lines,
    total: sumLines(lines),
    note: clean(body.note, 200),
    tg: null,
    log: [],
  });

  session.orderIds.push(order.id);
  session.updatedAt = Date.now();
  for (const l of lines) {
    if (l.guestId === SHARED) session.guests.forEach((g) => (g.paid = false));
    else {
      const g = session.guests.find((x) => x.id === l.guestId);
      if (g) g.paid = false;
    }
  }
  db.saveRuntime();
  return { order, session, duplicate: false };
}

/* ───────────── оплата за столом ───────────── */

export function requestPayment(db, table, body) {
  const session = getSession(db, table, { create: false });
  if (!session || !sessionOrders(db, session).some((o) => o.status !== 'cancelled')) {
    throw new OrderError('Пока нечего оплачивать — сначала отправьте заказ официанту');
  }
  const method = String(body.method || '');
  if (!['cash', 'card', 'sbp'].includes(method) || !db.settings.payments[method]) throw new OrderError('Выберите способ оплаты');
  const mode = body.mode === 'together' ? 'together' : 'split';
  const tipPct = db.settings.tips.includes(Number(body.tipPct)) ? Number(body.tipPct) : 0;

  const bill = sessionBill(db, session);
  const wanted = Array.isArray(body.guestIds) ? body.guestIds : [];
  const unpaid = session.guests.filter((g) => !g.paid && bill.perGuest[g.id].total > 0);
  let payers = unpaid.filter((g) => wanted.includes(g.id));
  if (!payers.length) payers = unpaid;
  if (!payers.length) throw new OrderError('Всё уже оплачено');

  const amounts = {};
  const tips = {};
  let subtotal = 0;
  let tip = 0;
  for (const g of payers) {
    amounts[g.id] = bill.perGuest[g.id].total;
    tips[g.id] = tipOf(amounts[g.id], tipPct);
    subtotal += amounts[g.id];
    tip += tips[g.id];
  }

  let replaced = null;
  if (session.payId) {
    const prev = db.getEntry(session.payId);
    if (prev && (prev.status === 'requested' || prev.status === 'ack')) {
      prev.status = 'replaced';
      replaced = prev;
    }
  }

  const hall = db.config.halls.find((h) => h.id === table.hallId);
  const payment = db.addEntry({
    id: db.newId('p'),
    type: 'pay',
    createdAt: Date.now(),
    status: 'requested',
    tableId: table.id,
    tableNumber: table.number,
    hallName: hall?.name || '',
    sessionId: session.id,
    method,
    mode,
    guestIds: payers.map((g) => g.id),
    amounts,
    tips,
    tipPct,
    subtotal,
    tip,
    total: subtotal + tip,
    tg: null,
    log: [],
  });
  session.payId = payment.id;
  session.updatedAt = Date.now();
  db.saveRuntime();
  return { payment, replaced, session };
}

/* ───────────── вызов официанта ───────────── */

export const CALL_REASONS = {
  waiter: 'Подойти к столу',
  bill: 'Принести счёт',
  cutlery: 'Приборы и салфетки',
  clean: 'Убрать со стола',
  kids: 'Детский стульчик',
  other: 'Другое',
};

export function callWaiter(db, table, body, now = Date.now()) {
  const reason = Object.hasOwn(CALL_REASONS, body.reason) ? body.reason : 'waiter';
  const session = getSession(db, table, { now });
  const calls = session.callIds.map((id) => db.getEntry(id)).filter(Boolean);

  const open = calls.find((c) => c.status === 'new' && c.reason === reason);
  if (open) return { call: open, session, duplicate: true };
  const last = calls[calls.length - 1];
  if (last && now - last.createdAt < 20_000) {
    throw new OrderError('Официант уже получил вызов, подождите минуту', { code: 'cooldown', status: 429 });
  }

  const hall = db.config.halls.find((h) => h.id === table.hallId);
  const call = db.addEntry({
    id: db.newId('c'),
    type: 'call',
    createdAt: now,
    status: 'new',
    reason,
    label: CALL_REASONS[reason],
    tableId: table.id,
    tableNumber: table.number,
    hallName: hall?.name || '',
    sessionId: session.id,
    note: clean(body.note, 120),
    tg: null,
    log: [],
  });
  session.callIds.push(call.id);
  session.updatedAt = now;
  db.saveRuntime();
  return { call, session, duplicate: false };
}

/* ───────────── доставка и самовывоз ───────────── */

/** Доступные времена выдачи на ближайшие сутки с шагом 15 минут */
export function deliverySlots(db, now = new Date()) {
  const s = db.settings;
  const tz = s.timezone;
  const start = new Date(Math.ceil((now.getTime() + 45 * 60000) / (15 * 60000)) * 15 * 60000);
  const today = localParts(tz, now).ymd;
  const slots = [];
  for (let i = 0; i < 96; i++) {
    const t = new Date(start.getTime() + i * 15 * 60000);
    const st = openState(s.hours, tz, t);
    if (!st.open || st.minutesToClose < s.delivery.stopBeforeCloseMin) continue;
    const p = localParts(tz, t);
    slots.push({ value: p.hm, day: p.ymd === today ? 'today' : 'tomorrow' });
  }
  return slots;
}

/** Можно ли оформить заказ «как можно скорее» прямо сейчас */
export function deliveryAvailability(db, now = new Date()) {
  const s = db.settings;
  if (!s.delivery.enabled) return { asap: false, reason: 'paused' };
  const st = openState(s.hours, s.timezone, now);
  if (!st.open) return { asap: false, reason: 'closed', nextOpen: st.nextOpen };
  if (st.minutesToClose <= s.delivery.stopBeforeCloseMin) return { asap: false, reason: 'late', closeAt: st.closeAt };
  return { asap: true, reason: null, closeAt: st.closeAt };
}

function findPromo(db, code) {
  const c = clean(code, 30).toUpperCase();
  if (!c) return null;
  return db.config.promos.find((p) => p.active && p.code.toUpperCase() === c) || null;
}

export function previewPromo(db, code, subtotal) {
  const promo = findPromo(db, code);
  if (!promo) throw new OrderError('Промокод не найден или уже не действует');
  return { code: promo.code, percent: promo.percent, discount: Math.round((subtotal * promo.percent) / 100) };
}

export function createDeliveryOrder(db, body, now = new Date()) {
  const s = db.settings;
  const d = s.delivery;
  const fulfil = body.type === 'pickup' ? 'pickup' : 'delivery';
  if (!d.enabled) throw new OrderError('Приём заказов временно приостановлен. Позвоните нам — поможем по телефону', { code: 'paused', status: 409 });
  if (fulfil === 'pickup' && !d.pickupEnabled) throw new OrderError('Самовывоз сейчас недоступен');

  const name = clean(body.name, 60);
  if (name.length < 2) throw new OrderError('Укажите имя');
  const phone = normalizePhone(body.phone);
  if (!phone) throw new OrderError('Проверьте номер телефона: нужно 10 цифр после +7');
  if (body.consent !== true) throw new OrderError('Нужно согласие на обработку персональных данных');

  let address = null;
  if (fulfil === 'delivery') {
    address = {
      street: clean(body.address?.street, 80),
      house: clean(body.address?.house, 12),
      apt: clean(body.address?.apt, 12),
      entrance: clean(body.address?.entrance, 8),
      floor: clean(body.address?.floor, 8),
      intercom: clean(body.address?.intercom, 20),
    };
    if (!address.street || !address.house) throw new OrderError('Укажите улицу и дом');
  }

  const method = String(body.payment || '');
  if (!['cash', 'card', 'sbp'].includes(method) || !s.payments[method]) throw new OrderError('Выберите способ оплаты');

  // защита от спама: не больше 6 заказов с одного номера за полчаса
  const recent = db.runtime.orders.filter((o) => o.type === 'delivery' && o.phone === phone && now.getTime() - o.createdAt < 30 * 60_000);
  if (recent.length >= 6) throw new OrderError('С этого номера уже много заказов. Позвоните нам, пожалуйста', { code: 'rate', status: 429 });

  const lines = priceLines(db, body.lines, { mode: 'delivery', now });
  for (const l of lines) delete l._src;
  const subtotal = sumLines(lines);
  if (subtotal < d.minOrder) throw new OrderError(`Минимальная сумма заказа — ${d.minOrder} ₽`);

  let promo = null;
  let discount = 0;
  if (clean(body.promo, 30)) {
    const p = previewPromo(db, body.promo, subtotal);
    promo = { code: p.code, percent: p.percent };
    discount = p.discount;
  }
  const fee = fulfil === 'delivery' && subtotal < d.freeFrom ? d.fee : 0;
  const total = subtotal - discount + fee;

  let when = 'asap';
  const raw = clean(body.when, 5);
  if (raw && raw !== 'asap') {
    if (!/^\d{2}:\d{2}$/.test(raw) || !deliverySlots(db, now).some((x) => x.value === raw)) {
      throw new OrderError('Это время недоступно — выберите другое');
    }
    when = raw;
  } else {
    const a = deliveryAvailability(db, now);
    if (!a.asap) throw new OrderError('Сейчас мы не принимаем заказы «как можно скорее» — выберите удобное время');
  }

  let changeFrom = 0;
  if (method === 'cash' && Number(body.changeFrom) > 0) changeFrom = Math.min(100000, Math.round(Number(body.changeFrom)));
  if (changeFrom && changeFrom < total) throw new OrderError('Сумма для сдачи меньше стоимости заказа');

  const order = db.addEntry({
    id: db.newId('o'),
    token: db.newId(''),
    type: 'delivery',
    fulfil,
    num: db.nextOrderNum(),
    createdAt: now.getTime(),
    status: 'new',
    name,
    phone,
    address,
    when,
    payment: method,
    changeFrom,
    lines,
    subtotal,
    discount,
    promo,
    fee,
    total,
    comment: clean(body.comment, 300),
    tg: null,
    log: [],
  });
  return { order };
}

/* ───────────── бронь ───────────── */

export function createReservation(db, body, now = new Date()) {
  const s = db.settings;
  const name = clean(body.name, 60);
  if (name.length < 2) throw new OrderError('Укажите имя');
  const phone = normalizePhone(body.phone);
  if (!phone) throw new OrderError('Проверьте номер телефона: нужно 10 цифр после +7');
  if (body.consent !== true) throw new OrderError('Нужно согласие на обработку персональных данных');

  const date = clean(body.date, 10);
  const time = clean(body.time, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new OrderError('Укажите дату и время');
  const today = localParts(s.timezone, now);
  if (date < today.ymd) throw new OrderError('Эта дата уже прошла');
  const max = new Date(now.getTime() + 180 * 86400000);
  if (date > localParts(s.timezone, max).ymd) throw new OrderError('Бронируем не дальше чем на полгода вперёд');
  if (date === today.ymd && toMin(time) < today.minutes) throw new OrderError('Это время уже прошло — выберите позже');

  const guests = Math.round(Number(body.guests));
  if (!(guests >= 1 && guests <= 120)) throw new OrderError('Укажите, сколько будет гостей');
  const hallId = clean(body.hallId, 20);
  const hall = db.config.halls.find((h) => h.id === hallId);

  const entry = db.addEntry({
    id: db.newId('r'),
    type: 'reserve',
    num: db.nextOrderNum(),
    createdAt: now.getTime(),
    status: 'new',
    kind: body.kind === 'banquet' ? 'banquet' : 'table',
    name,
    phone,
    date,
    time,
    guests,
    hallId: hall?.id || '',
    hallName: hall?.name || '',
    comment: clean(body.comment, 300),
    tg: null,
    log: [],
  });
  return { entry };
}

/* ───────────── статусы ───────────── */

const FLOWS = {
  table: {
    acc: { from: ['new'], to: 'accepted' },
    cancel: { from: ['new', 'accepted'], to: 'cancelled' },
  },
  delivery: {
    acc: { from: ['new'], to: 'accepted' },
    way: { from: ['accepted'], to: 'onway' },
    done: { from: ['accepted', 'onway', 'ready'], to: 'done' },
    cancel: { from: ['new', 'accepted', 'onway', 'ready'], to: 'cancelled' },
  },
  pickup: {
    acc: { from: ['new'], to: 'accepted' },
    ready: { from: ['accepted'], to: 'ready' },
    done: { from: ['accepted', 'ready'], to: 'done' },
    cancel: { from: ['new', 'accepted', 'ready'], to: 'cancelled' },
  },
  reserve: {
    ok: { from: ['new'], to: 'confirmed' },
    no: { from: ['new', 'confirmed'], to: 'declined' },
  },
  call: {
    go: { from: ['new'], to: 'ack' },
    done: { from: ['new', 'ack'], to: 'done' },
  },
  pay: {
    go: { from: ['requested'], to: 'ack' },
    done: { from: ['requested', 'ack'], to: 'done' },
    cancel: { from: ['requested', 'ack'], to: 'cancelled' },
  },
};

export function flowKey(entry) {
  return entry.type === 'delivery' && entry.fulfil === 'pickup' ? 'pickup' : entry.type;
}

export function allowedActions(entry) {
  const flow = FLOWS[flowKey(entry)] || {};
  return Object.entries(flow)
    .filter(([, t]) => t.from.includes(entry.status))
    .map(([action]) => action);
}

export function findSessionById(db, id) {
  return Object.values(db.runtime.sessions).find((s) => s.id === id) || null;
}

/** Оплата подтверждена: гости помечаются оплатившими, стол закрывается, когда оплатили все */
function settlePayment(db, pay) {
  const session = findSessionById(db, pay.sessionId);
  if (!session) return;
  for (const gid of pay.guestIds) {
    const g = session.guests.find((x) => x.id === gid);
    if (g) g.paid = true;
  }
  const bill = sessionBill(db, session);
  const open = session.guests.some((g) => !g.paid && bill.perGuest[g.id].total > 0);
  if (!open) session.closedAt = Date.now();
  session.updatedAt = Date.now();
}

export function closeSession(db, sessionId) {
  const session = findSessionById(db, sessionId);
  if (!session) throw new OrderError('Стол не найден', { status: 404, code: 'not_found' });
  session.closedAt = Date.now();
  for (const id of session.callIds) {
    const c = db.getEntry(id);
    if (c && (c.status === 'new' || c.status === 'ack')) c.status = 'done';
  }
  const pay = session.payId ? db.getEntry(session.payId) : null;
  if (pay && (pay.status === 'requested' || pay.status === 'ack')) pay.status = 'done';
  db.saveRuntime();
  return session;
}

/** Меняет статус по действию. Бросает OrderError, если действие уже невозможно. */
export function applyAction(db, entry, action, actor = 'админка') {
  const flow = FLOWS[flowKey(entry)];
  const t = flow?.[action];
  if (!t) throw new OrderError('Неизвестное действие');
  if (!t.from.includes(entry.status)) {
    throw new OrderError('Статус уже изменили', { code: 'stale', status: 409 });
  }
  entry.status = t.to;
  (entry.log ||= []).push({ status: t.to, at: Date.now(), by: actor });
  if (entry.type === 'pay' && t.to === 'done') settlePayment(db, entry);
  const session = entry.sessionId ? findSessionById(db, entry.sessionId) : null;
  if (session) session.updatedAt = Date.now();
  db.saveRuntime();
  return entry;
}
