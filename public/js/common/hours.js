// Часы работы с учётом часового пояса кафе и ночных смен (пт–сб до 03:00).
// Модуль общий для сервера и браузера.

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_LABELS = {
  mon: 'Понедельник',
  tue: 'Вторник',
  wed: 'Среда',
  thu: 'Четверг',
  fri: 'Пятница',
  sat: 'Суббота',
  sun: 'Воскресенье',
};
export const DAY_SHORT = { mon: 'пн', tue: 'вт', wed: 'ср', thu: 'чт', fri: 'пт', sat: 'сб', sun: 'вс' };
export const WEEK_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const toMin = (hm) => {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export const fromMin = (m) => {
  const x = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
};

/** Текущие день недели, минуты от полуночи и дата в часовом поясе кафе */
export function localParts(tz, date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return { dow, minutes, ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

function slot(hours, key) {
  const h = hours?.[key];
  if (!h || !h[0] || !h[1]) return null;
  return { open: toMin(h[0]), close: toMin(h[1]), overnight: toMin(h[1]) <= toMin(h[0]) };
}

/**
 * Состояние «открыто / закрыто» на момент date.
 * Возвращает { open, closeAt, minutesToClose, nextOpen: {label, time} }
 */
export function openState(hours, tz, date = new Date()) {
  const { dow, minutes } = localParts(tz, date);
  const today = slot(hours, DAY_KEYS[dow]);
  const yest = slot(hours, DAY_KEYS[(dow + 6) % 7]);

  if (yest && yest.overnight && minutes < yest.close) {
    return { open: true, closeAt: fromMin(yest.close), minutesToClose: yest.close - minutes };
  }
  if (today) {
    if (today.overnight && minutes >= today.open) {
      return { open: true, closeAt: fromMin(today.close), minutesToClose: 1440 - minutes + today.close };
    }
    if (!today.overnight && minutes >= today.open && minutes < today.close) {
      return { open: true, closeAt: fromMin(today.close), minutesToClose: today.close - minutes };
    }
  }

  for (let add = 0; add < 8; add++) {
    const key = DAY_KEYS[(dow + add) % 7];
    const s = slot(hours, key);
    if (!s) continue;
    if (add === 0 && minutes >= s.open) continue;
    const label = add === 0 ? 'сегодня' : add === 1 ? 'завтра' : DAY_LABELS[key].toLowerCase();
    return { open: false, closeAt: null, minutesToClose: 0, nextOpen: { label, time: fromMin(s.open) } };
  }
  return { open: false, closeAt: null, minutesToClose: 0, nextOpen: null };
}

/** Сгруппированное расписание для подвала: «пн–чт 11:00–23:00» */
export function groupHours(hours) {
  const out = [];
  for (const key of WEEK_ORDER) {
    const h = hours?.[key];
    const text = h && h[0] && h[1] ? `${h[0]}–${h[1]}` : 'выходной';
    const last = out[out.length - 1];
    if (last && last.text === text) last.keys.push(key);
    else out.push({ text, keys: [key] });
  }
  return out.map((g) => ({
    text: g.text,
    days: g.keys.length === 1 ? DAY_SHORT[g.keys[0]] : `${DAY_SHORT[g.keys[0]]}–${DAY_SHORT[g.keys[g.keys.length - 1]]}`,
  }));
}

/** Доступна ли категория сейчас (расписание from/to в минутах часового пояса кафе) */
export function categoryAvailable(cat, tz, date = new Date()) {
  if (!cat.from || !cat.to) return true;
  const { minutes } = localParts(tz, date);
  const a = toMin(cat.from);
  const b = toMin(cat.to);
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}
