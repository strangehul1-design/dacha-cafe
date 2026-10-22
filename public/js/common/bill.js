// Счёт стола: разделение по гостям, общие блюда, чаевые.
// Модуль общий для сервера и браузера — суммы на экране и в Telegram считаются одинаково.

export const SHARED = 'shared';

/**
 * orders: [{ status, lines: [{ unit, qty, guestId, splitAmong? }] }]
 * guests: [{ id }]
 * Возвращает { total, perGuest: { [id]: { own, shared, total } } }
 * Общие блюда делятся поровну между splitAmong (по умолчанию — все гости);
 * остаток от деления по рублям раздаётся по очереди, чтобы сумма сходилась до рубля.
 */
export function computeBill(orders, guests) {
  const perGuest = {};
  for (const g of guests) perGuest[g.id] = { own: 0, shared: 0, total: 0 };
  let total = 0;
  let turn = 0;

  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    for (const l of o.lines) {
      const sum = l.unit * l.qty;
      total += sum;
      const direct = l.guestId !== SHARED && perGuest[l.guestId];
      if (direct) {
        perGuest[l.guestId].own += sum;
        continue;
      }
      let among = (l.splitAmong || []).filter((id) => perGuest[id]);
      if (!among.length) among = guests.map((g) => g.id);
      if (!among.length) continue;
      const base = Math.floor(sum / among.length);
      let rest = sum - base * among.length;
      among.forEach((id) => {
        perGuest[id].shared += base;
      });
      for (let i = 0; i < rest; i++) {
        perGuest[among[(turn + i) % among.length]].shared += 1;
      }
      turn += rest;
    }
  }

  for (const id of Object.keys(perGuest)) perGuest[id].total = perGuest[id].own + perGuest[id].shared;
  return { total, perGuest };
}

/** Чаевые от суммы: округляем до рубля */
export function tipOf(amount, pct) {
  return Math.round((amount * (Number(pct) || 0)) / 100);
}

/** Сумма общих блюд без привязки к гостю (для подписи «Общее на стол») */
export function sharedTotal(orders) {
  let s = 0;
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    for (const l of o.lines) if (l.guestId === SHARED) s += l.unit * l.qty;
  }
  return s;
}

/** Цвета гостей: одинаковы у всех телефонов за столом */
export const GUEST_COLORS = ['#E8412C', '#1E3F96', '#2E8B57', '#C98A00', '#8A4FBF', '#0E8C9C', '#D6336C', '#5C6B7A'];

export function guestColor(i) {
  return GUEST_COLORS[i % GUEST_COLORS.length];
}
