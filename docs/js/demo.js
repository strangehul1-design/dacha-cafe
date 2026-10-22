// Демо-режим для GitHub Pages: вместо сервера отвечает сам браузер.
// Заказы, вызовы и оплата имитируются и хранятся в localStorage; в Telegram ничего не уходит.
// Подключается только в собранной демо-версии (см. scripts/build-demo.js).
import { computeBill, tipOf, SHARED } from './common/bill.js';
import { openState, localParts } from './common/hours.js';

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('demo:' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('demo:' + k, JSON.stringify(v));
    } catch {
      /* без хранилища демо работает, но не помнит состояние */
    }
  },
};

const fail = (status, message, data) => Object.assign(new Error(message), { status, data });
const rid = (p = '') => p + Math.random().toString(36).slice(2, 10);
let data;
async function load() {
  data ||= await fetch(new URL('../data/demo.json', import.meta.url)).then((r) => r.json());
  return data;
}

const nextNum = () => {
  const n = store.get('seq', 1000) + 1;
  store.set('seq', n);
  return n;
};

function findItem(d, id) {
  for (const c of d.menu.categories) for (const i of c.items) if (i.id === id) return i;
  return null;
}

/** Цена строки и выбранные варианты; ошибки — как у настоящего сервера */
function priceLines(d, raw) {
  if (!Array.isArray(raw) || !raw.length) throw fail(400, 'Корзина пуста');
  return raw.map((r) => {
    const item = findItem(d, r.dishId);
    if (!item) throw fail(409, 'Блюдо убрали из меню', { problems: [{ dishId: r.dishId, reason: 'gone' }] });
    if (item.stop) throw fail(409, `«${item.name}» закончилось`, { problems: [{ dishId: item.id, reason: 'stop' }] });
    let unit = item.price;
    const opts = [];
    for (const g of item.options) {
      const c = g.choices.find((x) => x.id === r.options?.[g.id]);
      if (!c) {
        if (g.required) throw fail(409, `«${item.name}»: выберите вариант заново`, { problems: [{ dishId: item.id, reason: 'options' }] });
        continue;
      }
      unit += c.price || 0;
      opts.push({ group: g.name, choice: c.name });
    }
    return { id: rid('l'), dishId: item.id, name: item.name, qty: Math.min(30, Math.max(1, Number(r.qty) || 1)), unit, opts, note: String(r.note || '').slice(0, 140) };
  });
}

/* ───────── стол ───────── */

const hallFor = (d, n) => {
  const i = n <= 6 ? 0 : n <= 10 ? 1 : n <= 12 ? 2 : 3;
  const h = d.config.halls[i] || d.config.halls[0];
  return { id: h.id, name: h.name };
};

function loadSession(code) {
  return store.get('session:' + code, null);
}

function saveSession(code, s) {
  s.updatedAt = Date.now();
  store.set('session:' + code, s);
}

/** Статусы «двигаются» со временем, как будто официант нажимает кнопки в Telegram */
function progress(s) {
  const now = Date.now();
  for (const o of s.orders) if (o.status === 'new' && now - o.createdAt > 8000) o.status = 'accepted';
  for (const c of s.calls) if (c.status === 'new' && now - c.createdAt > 6000) c.status = 'ack';
  if (s.payment?.status === 'requested' && now - s.payment.createdAt > 8000) s.payment.status = 'ack';
  return s;
}

function publicSession(s) {
  if (!s) return { id: null, updatedAt: 0, guests: [], orders: [], bill: { total: 0, perGuest: {} }, payment: null, calls: [] };
  progress(s);
  return { ...s, bill: computeBill(s.orders, s.guests), calls: s.calls.slice(-5) };
}

function tableInfo(d, code) {
  const number = String(code).replace(/\D/g, '') || '7';
  return {
    table: { number, hall: hallFor(d, Number(number)), menuName: 'Основное меню' },
    payments: d.config.payments,
    tips: d.config.tips,
    callReasons: d.callReasons,
    brand: d.config.brand,
    contacts: d.config.contacts,
  };
}

async function tableApi(d, method, parts, body) {
  const code = parts[0];
  const sub = parts.slice(1).join('/');
  let s = loadSession(code);

  if (method === 'GET' && !sub) return { ...tableInfo(d, code), session: publicSession(s) };

  const ensure = () =>
    (s ||= { id: rid('s'), guests: [], orders: [], payment: null, calls: [], updatedAt: Date.now() });

  if (method === 'POST' && sub === 'guests') {
    ensure();
    if (s.guests.length >= 12) throw fail(400, 'За столом уже 12 гостей — больше добавить нельзя');
    const used = new Set(s.guests.map((g) => g.color));
    let color = 0;
    while (used.has(color) && color < 8) color++;
    const guest = { id: rid('g'), name: String(body.name || '').trim().slice(0, 20) || `Гость ${s.guests.length + 1}`, color: color % 8, paid: false };
    s.guests.push(guest);
    saveSession(code, s);
    return { guest, session: publicSession(s) };
  }

  if (method === 'PUT' && parts[1] === 'guests') {
    const g = s?.guests.find((x) => x.id === parts[2]);
    if (!g) throw fail(404, 'Гость не найден');
    g.name = String(body.name || '').trim().slice(0, 20) || g.name;
    saveSession(code, s);
    return { guest: g, session: publicSession(s) };
  }

  if (method === 'POST' && sub === 'order') {
    ensure();
    if (!s.guests.length) throw fail(400, 'Сначала добавьте гостя');
    if (body.key && s.orders.some((o) => o.key === body.key)) {
      const o = s.orders.find((x) => x.key === body.key);
      return { ok: true, delivered: true, order: { id: o.id, num: o.num, status: o.status, total: o.total }, session: publicSession(s) };
    }
    const lines = priceLines(d, body.lines);
    const ids = new Set(s.guests.map((g) => g.id));
    lines.forEach((l, i) => {
      const src = body.lines[i];
      if (src.guestId !== SHARED && !ids.has(src.guestId)) throw fail(400, 'Гость не найден за столом — обновите страницу');
      l.guestId = src.guestId;
      if (src.guestId === SHARED) {
        const among = (src.splitAmong || []).filter((id) => ids.has(id));
        l.splitAmong = among.length ? among : [...ids];
      }
    });
    const order = { id: rid('o'), key: body.key || '', num: nextNum(), createdAt: Date.now(), status: 'new', note: String(body.note || '').slice(0, 200), total: lines.reduce((a, l) => a + l.unit * l.qty, 0), lines };
    s.orders.push(order);
    s.guests.forEach((g) => (g.paid = false));
    saveSession(code, s);
    return { ok: true, delivered: true, order: { id: order.id, num: order.num, status: order.status, total: order.total }, session: publicSession(s) };
  }

  if (method === 'POST' && sub === 'call') {
    ensure();
    progress(s);
    const reason = d.callReasons[body.reason] ? body.reason : 'waiter';
    const open = s.calls.find((c) => c.status === 'new' && c.reason === reason);
    if (open) return { ok: true, delivered: true, call: open, session: publicSession(s) };
    const call = { id: rid('c'), reason, label: d.callReasons[reason], status: 'new', createdAt: Date.now() };
    s.calls.push(call);
    saveSession(code, s);
    return { ok: true, delivered: true, call, session: publicSession(s) };
  }

  if (method === 'POST' && sub === 'pay') {
    if (!s || !s.orders.length) throw fail(400, 'Пока нечего оплачивать — сначала отправьте заказ официанту');
    const bill = computeBill(s.orders, s.guests);
    const method_ = ['cash', 'card', 'sbp'].includes(body.method) ? body.method : null;
    if (!method_) throw fail(400, 'Выберите способ оплаты');
    const tipPct = d.config.tips.includes(Number(body.tipPct)) ? Number(body.tipPct) : 0;
    let payers = s.guests.filter((g) => (body.guestIds || []).includes(g.id) && bill.perGuest[g.id].total > 0);
    if (!payers.length) payers = s.guests.filter((g) => bill.perGuest[g.id].total > 0);
    const amounts = {};
    let subtotal = 0;
    let tip = 0;
    for (const g of payers) {
      amounts[g.id] = bill.perGuest[g.id].total;
      subtotal += amounts[g.id];
      tip += tipOf(amounts[g.id], tipPct);
    }
    s.payment = { id: rid('p'), status: 'requested', method: method_, mode: body.mode === 'together' ? 'together' : 'split', guestIds: payers.map((g) => g.id), amounts, tipPct, tip, total: subtotal + tip, createdAt: Date.now() };
    saveSession(code, s);
    return { ok: true, delivered: true, session: publicSession(s) };
  }

  if (method === 'POST' && sub === 'pay/cancel') {
    if (s?.payment) s.payment = null;
    if (s) saveSession(code, s);
    return { ok: true, session: publicSession(s) };
  }

  throw fail(404, 'Не найдено');
}

/* ───────── доставка ───────── */

function slots(d) {
  const tz = d.config.timezone;
  const now = new Date();
  const today = localParts(tz, now).ymd;
  const start = new Date(Math.ceil((now.getTime() + 45 * 60000) / (15 * 60000)) * 15 * 60000);
  const out = [];
  for (let i = 0; i < 96; i++) {
    const t = new Date(start.getTime() + i * 15 * 60000);
    const st = openState(d.config.hours, tz, t);
    if (!st.open || st.minutesToClose < 30) continue;
    const p = localParts(tz, t);
    out.push({ value: p.hm, day: p.ymd === today ? 'today' : 'tomorrow' });
  }
  return out;
}

function availability(d) {
  const st = openState(d.config.hours, d.config.timezone);
  if (!st.open) return { asap: false, reason: 'closed', nextOpen: st.nextOpen };
  if (st.minutesToClose <= 30) return { asap: false, reason: 'late', closeAt: st.closeAt };
  return { asap: true, reason: null, closeAt: st.closeAt };
}

function deliveryOrder(d, body) {
  if (!body.name || String(body.name).trim().length < 2) throw fail(400, 'Укажите имя');
  if (String(body.phone || '').replace(/\D/g, '').length < 10) throw fail(400, 'Проверьте номер телефона: нужно 10 цифр после +7');
  if (body.consent !== true) throw fail(400, 'Нужно согласие на обработку персональных данных');
  const pickup = body.type === 'pickup';
  if (!pickup && (!body.address?.street || !body.address?.house)) throw fail(400, 'Укажите улицу и дом');
  const lines = priceLines(d, body.lines);
  const subtotal = lines.reduce((a, l) => a + l.unit * l.qty, 0);
  const discount = String(body.promo || '').toUpperCase() === 'ДАЧА10' ? Math.round(subtotal / 10) : 0;
  const fee = !pickup && subtotal < d.config.delivery.freeFrom ? d.config.delivery.fee : 0;
  const order = { token: rid(), num: nextNum(), status: 'new', fulfil: pickup ? 'pickup' : 'delivery', when: body.when || 'asap', total: subtotal - discount + fee, createdAt: Date.now() };
  store.set('delivery:' + order.token, order);
  return { ok: true, delivered: true, order: { num: order.num, token: order.token, status: 'new', total: order.total, when: order.when, fulfil: order.fulfil } };
}

function deliveryStatus(token) {
  const o = store.get('delivery:' + token, null);
  if (!o) throw fail(404, 'Заказ не найден');
  const age = Date.now() - o.createdAt;
  const status = age < 6000 ? 'new' : age < 14000 ? 'accepted' : age < 24000 ? (o.fulfil === 'pickup' ? 'ready' : 'onway') : 'done';
  return { num: o.num, status, fulfil: o.fulfil, when: o.when, total: o.total };
}

/* ───────── вход ───────── */

export async function handle(method, url, body = {}) {
  const d = await load();
  const u = new URL(url, location.href);
  const p = u.pathname.replace(/^.*?(\/api\/)/, '/api/');

  if (method === 'GET' && p === '/api/config') {
    const open = openState(d.config.hours, d.config.timezone);
    return { ...d.config, open, serverTime: new Date().toISOString(), delivery: { ...d.config.delivery, availability: availability(d) } };
  }
  if (method === 'GET' && p === '/api/menu') {
    if (u.searchParams.get('rev') === d.menu.rev) return { same: true, rev: d.menu.rev };
    return d.menu;
  }
  if (method === 'GET' && p === '/api/privacy') return { text: '', brand: d.config.brand, contacts: d.config.contacts };
  if (method === 'GET' && p === '/api/delivery/slots') return { slots: slots(d), availability: availability(d) };
  if (method === 'POST' && p === '/api/promo') {
    if (String(body.code || '').trim().toUpperCase() !== 'ДАЧА10') throw fail(400, 'Промокод не найден или уже не действует. В демо работает ДАЧА10');
    return { code: 'ДАЧА10', percent: 10, discount: Math.round((Number(body.subtotal) || 0) / 10) };
  }
  if (method === 'POST' && p === '/api/delivery/order') return deliveryOrder(d, body);
  if (method === 'GET' && p.startsWith('/api/delivery/order/')) return deliveryStatus(p.split('/').pop());
  if (method === 'POST' && p === '/api/reserve') {
    if (String(body.phone || '').replace(/\D/g, '').length < 10) throw fail(400, 'Проверьте номер телефона: нужно 10 цифр после +7');
    return { ok: true, delivered: true, num: nextNum() };
  }
  if (p.startsWith('/api/table/')) return tableApi(d, method, p.slice('/api/table/'.length).split('/'), body);
  throw fail(404, 'В демо-версии этого нет');
}
