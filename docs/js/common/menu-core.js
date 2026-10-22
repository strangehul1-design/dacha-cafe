// Логика меню и корзины на клиенте. Цены здесь только для показа — итог всегда пересчитывает сервер.
import { useState, useEffect, useRef, useCallback } from './lib.js';
import { api } from './api.js';
import { useStored, usePolling } from './ui.js';

export function indexMenu(menu) {
  const map = new Map();
  if (!menu) return map;
  for (const c of menu.categories) for (const item of c.items) map.set(item.id, { item, cat: c });
  return map;
}

export const unitPrice = (item, options = {}) => item.price + item.options.reduce((s, g) => s + (g.choices.find((c) => c.id === options[g.id])?.price || 0), 0);

export const optionLabels = (item, options = {}) =>
  item.options
    .map((g) => g.choices.find((c) => c.id === options[g.id])?.name)
    .filter(Boolean);

export const needsChoice = (item) => item.options.some((g) => g.required);

export const lineKey = (l) =>
  [l.dishId, l.guestId || '', JSON.stringify(Object.entries(l.options || {}).sort()), l.note || '', (l.splitAmong || []).slice().sort().join(',')].join('|');

/** Загружает меню и тихо обновляет его раз в 40 секунд: стоп-лист и цены меняются на глазах у гостей */
export function useMenu(query) {
  const [state, setState] = useState({ menu: null, error: null, loading: true });
  const rev = useRef('');
  const load = useCallback(async () => {
    try {
      const m = await api.get(`/api/menu?${query}${rev.current ? `&rev=${rev.current}` : ''}`);
      if (m.same) return;
      rev.current = m.rev;
      setState({ menu: m, error: null, loading: false });
    } catch (e) {
      setState((s) => ({ ...s, error: s.menu ? null : e.message, loading: false }));
    }
  }, [query]);
  useEffect(() => {
    rev.current = '';
    load();
  }, [query]);
  usePolling(load, 40_000, [query]);
  return { ...state, reload: load };
}

/** Корзина-черновик: хранится в браузере, поэтому переживает перезагрузку страницы */
export function useCart(storageKey) {
  const [lines, setLines] = useStored(storageKey, []);

  const merge = (arr) => {
    const out = [];
    for (const l of arr) {
      const k = lineKey(l);
      const i = out.findIndex((x) => lineKey(x) === k);
      if (i >= 0) out[i] = { ...out[i], qty: Math.min(30, out[i].qty + l.qty) };
      else out.push(l);
    }
    return out;
  };

  const add = useCallback((line) => setLines((prev) => merge([...prev, { qty: 1, options: {}, note: '', ...line }])), []);
  const setQty = useCallback((key, qty) => setLines((prev) => (qty <= 0 ? prev.filter((l) => lineKey(l) !== key) : prev.map((l) => (lineKey(l) === key ? { ...l, qty: Math.min(30, qty) } : l)))), []);
  const update = useCallback((key, patch) => setLines((prev) => merge(prev.map((l) => (lineKey(l) === key ? { ...l, ...patch } : l)))), []);
  const clear = useCallback(() => setLines([]), []);
  const dropWhere = useCallback((fn) => setLines((prev) => prev.filter((l) => !fn(l))), []);
  const replaceAll = useCallback((next) => setLines(next), []);

  return { lines, add, setQty, update, clear, dropWhere, replaceAll };
}

/** Сумма корзины по текущему меню */
export function cartSummary(lines, index) {
  let count = 0;
  let total = 0;
  for (const l of lines) {
    const e = index.get(l.dishId);
    if (!e) continue;
    count += l.qty;
    total += unitPrice(e.item, l.options) * l.qty;
  }
  return { count, total };
}
