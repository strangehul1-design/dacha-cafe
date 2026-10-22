// Форматирование чисел, цен и склонений. Модуль общий для сервера и браузера.

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/** 1500 → «1 500 ₽» (неразрывные пробелы) */
export function rub(n) {
  return nf.format(Math.round(Number(n) || 0)).replace(/\s/g, ' ') + ' ₽';
}

export function num(n) {
  return nf.format(Math.round(Number(n) || 0)).replace(/\s/g, ' ');
}

/** plural(5, 'блюдо', 'блюда', 'блюд') → «блюд» */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function count(n, one, few, many) {
  return `${num(n)} ${plural(n, one, few, many)}`;
}

export const pad2 = (n) => String(n).padStart(2, '0');

/** Телефон → +7XXXXXXXXXX или null, если номер некорректен */
export function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  let t = d;
  if (t.length === 11 && (t[0] === '8' || t[0] === '7')) t = t.slice(1);
  if (t.length !== 10) return null;
  return '+7' + t;
}

/** +79001234567 → +7 (900) 123-45-67 */
export function prettyPhone(p) {
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(p || '');
  return m ? `+7 (${m[1]}) ${m[2]}-${m[3]}-${m[4]}` : p || '';
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Короткая «как давно»: «только что», «5 мин назад», «вчера» */
export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
