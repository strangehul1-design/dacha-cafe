// Тексты сообщений для персонала в Telegram (parse_mode=HTML) и кнопки статусов.
import { rub, plural } from '../public/js/common/format.js';
import { localParts } from '../public/js/common/hours.js';
import { SHARED } from '../public/js/common/bill.js';
import { allowedActions } from './orders.js';

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const METHOD = { cash: '💵 Наличными', card: '💳 Картой', sbp: '📲 СБП (перевод по QR)' };
const METHOD_DELIVERY = { cash: '💵 Наличными курьеру', card: '💳 Картой курьеру', sbp: '📲 СБП (перевод по QR)' };

function hm(ts, tz) {
  return localParts(tz, new Date(ts)).hm;
}

function who(entry, status, tz) {
  const e = [...(entry.log || [])].reverse().find((l) => l.status === status);
  return e ? `${esc(e.by)}, ${hm(e.at, tz)}` : '';
}

function lineText(l) {
  const opts = l.opts?.length ? ` <i>(${l.opts.map((o) => esc(o.choice)).join(', ')})</i>` : '';
  let t = `• ${esc(l.name)}${opts} × ${l.qty} — ${rub(l.unit * l.qty)}`;
  if (l.note) t += `\n   ✎ ${esc(l.note)}`;
  return t;
}

function tableOrderText(o, tz) {
  const names = o.guestNames || {};
  const order = Object.keys(names);
  const groups = new Map();
  for (const l of o.lines) {
    const key = l.guestId === SHARED ? SHARED : l.guestId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === SHARED) return 1;
    if (b === SHARED) return -1;
    return order.indexOf(a) - order.indexOf(b);
  });

  const parts = [`🍽 <b>Стол ${esc(o.tableNumber)}</b>${o.hallName ? ' · ' + esc(o.hallName) : ''}`, `Заказ № ${o.num} · ${hm(o.createdAt, tz)}`, ''];
  for (const k of keys) {
    const ls = groups.get(k);
    if (k === SHARED) {
      const among = [...new Set(ls.flatMap((l) => l.splitAmong || []))].map((id) => names[id]).filter(Boolean);
      parts.push(`🤝 <b>Общее на стол</b>${among.length ? ' — делят: ' + esc(among.join(', ')) : ''}`);
    } else {
      parts.push(`👤 <b>${esc(names[k] || 'Гость')}</b>`);
    }
    for (const l of ls) parts.push(lineText(l));
  }
  parts.push('', `<b>Итого: ${rub(o.total)}</b>`);
  if (o.note) parts.push(`💬 ${esc(o.note)}`);
  if (o.status === 'accepted') parts.push('', `✅ Принято — ${who(o, 'accepted', tz)}`);
  if (o.status === 'cancelled') parts.push('', `❌ Отменён — ${who(o, 'cancelled', tz)}`);
  return parts.join('\n');
}

function callText(c, tz) {
  const parts = [`🔔 <b>Стол ${esc(c.tableNumber)}</b>${c.hallName ? ' · ' + esc(c.hallName) : ''}`, `Просят: <b>${esc(c.label)}</b>`];
  if (c.note) parts.push(`💬 ${esc(c.note)}`);
  if (c.status === 'ack') parts.push('', `🚶 Идёт — ${who(c, 'ack', tz)}`);
  if (c.status === 'done') parts.push('', `✅ Готово — ${who(c, 'done', tz)}`);
  return parts.join('\n');
}

function payText(p, tz, db) {
  const session = db ? Object.values(db.runtime.sessions).find((s) => s.id === p.sessionId) : null;
  const names = Object.fromEntries((session?.guests || []).map((g) => [g.id, g.name]));
  const parts = [`💰 <b>Стол ${esc(p.tableNumber)}</b>${p.hallName ? ' · ' + esc(p.hallName) : ''} — готовы оплатить`, `Способ: <b>${METHOD[p.method] || p.method}</b>`];
  if (p.mode === 'split') {
    parts.push('Счёт: <b>раздельно по гостям</b>');
    for (const gid of p.guestIds) {
      const tip = p.tips?.[gid] ? ` (+ чаевые ${rub(p.tips[gid])})` : '';
      parts.push(`• ${esc(names[gid] || 'Гость')} — ${rub(p.amounts[gid])}${tip}`);
    }
  } else {
    parts.push('Счёт: <b>одним чеком</b>');
  }
  if (p.tip) parts.push(`Чаевые ${p.tipPct}%: ${rub(p.tip)}`);
  parts.push(`<b>К оплате: ${rub(p.total)}</b>`);
  if (p.guestIds.length && p.mode === 'together') parts.push(`За: ${esc(p.guestIds.map((id) => names[id] || 'Гость').join(', '))}`);
  if (p.status === 'ack') parts.push('', `🚶 Подходит — ${who(p, 'ack', tz)}`);
  if (p.status === 'done') parts.push('', `✅ Оплачено — ${who(p, 'done', tz)}`);
  if (p.status === 'cancelled') parts.push('', `❌ Отменено — ${who(p, 'cancelled', tz)}`);
  if (p.status === 'replaced') parts.push('', '↪ Гости прислали новый запрос оплаты');
  return parts.join('\n');
}

function deliveryText(o, tz) {
  const pickup = o.fulfil === 'pickup';
  const when = o.when === 'asap' ? 'как можно скорее' : `к ${o.when}`;
  const parts = [`${pickup ? '🏃 <b>Самовывоз' : '🛵 <b>Доставка'} № ${o.num}</b> · ${when}`, `👤 ${esc(o.name)} · ${esc(o.phone)}`];
  if (!pickup && o.address) {
    const a = o.address;
    const bits = [`${a.street}, ${a.house}`];
    if (a.apt) bits.push(`кв. ${a.apt}`);
    if (a.entrance) bits.push(`подъезд ${a.entrance}`);
    if (a.floor) bits.push(`этаж ${a.floor}`);
    if (a.intercom) bits.push(`домофон ${a.intercom}`);
    parts.push(`📍 ${esc(bits.join(', '))}`);
  }
  parts.push('');
  for (const l of o.lines) parts.push(lineText(l));
  parts.push('');
  if (o.discount) parts.push(`Скидка ${esc(o.promo?.code)} −${o.promo?.percent}%: −${rub(o.discount)}`);
  if (!pickup) parts.push(`Доставка: ${o.fee ? rub(o.fee) : 'бесплатно'}`);
  parts.push(`<b>Итого: ${rub(o.total)}</b>`);
  let pay = METHOD_DELIVERY[o.payment] || o.payment;
  if (pickup) pay = pay.replace(' курьеру', ' при получении');
  if (o.payment === 'cash' && o.changeFrom) pay += ` (сдача с ${rub(o.changeFrom)})`;
  parts.push(`Оплата: ${pay}`);
  if (o.comment) parts.push(`💬 ${esc(o.comment)}`);
  const st = {
    accepted: `✅ Принят — ${who(o, 'accepted', tz)}`,
    onway: `🛵 Передан курьеру — ${who(o, 'onway', tz)}`,
    ready: `📦 Готов к выдаче — ${who(o, 'ready', tz)}`,
    done: `✔️ Выполнен — ${who(o, 'done', tz)}`,
    cancelled: `❌ Отменён — ${who(o, 'cancelled', tz)}`,
  }[o.status];
  if (st) parts.push('', st);
  return parts.join('\n');
}

function reserveText(r, tz, db) {
  const d = new Date(r.date + 'T12:00:00Z');
  const dateStr = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  const parts = [
    `${r.kind === 'banquet' ? '🎉 <b>Заявка на банкет' : '📅 <b>Бронь стола'} № ${r.num}</b>`,
    `${esc(dateStr)}, <b>${esc(r.time)}</b>`,
    `${r.guests} ${plural(r.guests, 'гость', 'гостя', 'гостей')}${r.hallName ? ' · ' + esc(r.hallName) : ''}`,
    `👤 ${esc(r.name)} · ${esc(r.phone)}`,
  ];
  if (r.comment) parts.push(`💬 ${esc(r.comment)}`);
  if (r.status === 'confirmed') parts.push('', `✅ Подтверждено — ${who(r, 'confirmed', tz)}`);
  if (r.status === 'declined') parts.push('', `🚫 Отклонено — ${who(r, 'declined', tz)}`);
  return parts.join('\n');
}

const BUTTONS = {
  table: { acc: '✅ Принять', cancel: '❌ Отменить' },
  delivery: { acc: '✅ Принять', way: '🛵 Передан курьеру', done: '✔️ Выполнен', cancel: '❌ Отменить' },
  pickup: { acc: '✅ Принять', ready: '📦 Готов к выдаче', done: '✔️ Выдан', cancel: '❌ Отменить' },
  reserve: { ok: '✅ Подтвердить', no: '🚫 Отклонить' },
  call: { go: '🚶 Иду', done: '✔️ Сделано' },
  pay: { go: '🚶 Подхожу', done: '💰 Оплачено', cancel: '❌ Отмена' },
};

function buttonsFor(entry) {
  const key = entry.type === 'delivery' && entry.fulfil === 'pickup' ? 'pickup' : entry.type;
  const labels = BUTTONS[key] || {};
  let actions = allowedActions(entry);
  // Ряды: основные действия в первой строке, отмена — отдельно
  const main = actions.filter((a) => a !== 'cancel' && a !== 'no');
  const rest = actions.filter((a) => a === 'cancel' || a === 'no');
  // «Принять» и «Передан курьеру» не нужны, если можно сразу выполнить; оставляем только ближайший шаг + завершение
  let primary = main;
  if (key === 'delivery' || key === 'pickup') {
    primary = main.includes('acc') ? ['acc'] : main;
  }
  const mk = (a) => ({ text: labels[a] || a, data: `e:${entry.id}:${a}` });
  const rows = [];
  if (primary.length) rows.push(primary.map(mk));
  if (rest.length) rows.push(rest.map(mk));
  return rows;
}

// Лимит Telegram — 4096 символов. Длинный заказ сокращаем по строкам (теги в строке всегда парные):
// сохраняем начало и конец, чтобы не потерять итог и отметку о статусе.
const MAX_LEN = 3900;

export function shorten(text) {
  if (text.length <= MAX_LEN) return text;
  const lines = text.split('\n');
  const head = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > 2700) break;
    head.push(l);
    len += l.length + 1;
  }
  const tail = [];
  len = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (len + lines[i].length + 1 > 900) break;
    tail.unshift(lines[i]);
    len += lines[i].length + 1;
  }
  const hidden = lines.length - head.length - tail.length;
  return [...head, `… <i>ещё строк: ${hidden}. Полный список — в админке</i>`, ...tail].join('\n');
}

/** Текст и кнопки сообщения для записи (заказ, бронь, вызов, оплата) */
export function buildMessage(db, entry) {
  const tz = db.settings.timezone;
  let text;
  switch (entry.type) {
    case 'table':
      text = tableOrderText(entry, tz);
      break;
    case 'call':
      text = callText(entry, tz);
      break;
    case 'pay':
      text = payText(entry, tz, db);
      break;
    case 'delivery':
      text = deliveryText(entry, tz);
      break;
    case 'reserve':
      text = reserveText(entry, tz, db);
      break;
    default:
      text = esc(JSON.stringify(entry));
  }
  return { text: shorten(text), buttons: buttonsFor(entry) };
}

/** В какой чат слать: доставка может идти в отдельную группу */
export function chatFor(db, entry) {
  const t = db.settings.telegram;
  if (entry.type === 'delivery' && t.deliveryChatId) return t.deliveryChatId;
  return t.chatId;
}
