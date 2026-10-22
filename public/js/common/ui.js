// Общие компоненты и хуки: листы, тосты, степпер, аватар гостя, опрос сервера.
import { html, useState, useEffect, useRef, useCallback } from './lib.js';
import { Icon } from './icons.js';
import { GUEST_COLORS } from './bill.js';

export const cx = (...a) => a.filter(Boolean).join(' ');

/* ───────── localStorage без падений в приватном режиме ───────── */

export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* хранилище недоступно — работаем без него */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function useStored(key, initial) {
  const [v, setV] = useState(() => store.get(key, initial));
  const set = useCallback(
    (next) => {
      setV((prev) => {
        const val = typeof next === 'function' ? next(prev) : next;
        store.set(key, val);
        return val;
      });
    },
    [key],
  );
  return [v, set];
}

/* ───────── опрос сервера: только пока страница видна ───────── */

export function usePolling(fn, ms, deps = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let timer;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        try {
          await ref.current();
        } catch {
          /* следующий опрос повторит попытку */
        }
      }
      if (!stopped) timer = setTimeout(tick, ms);
    };
    timer = setTimeout(tick, ms);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, deps);
}

/* ───────── тосты ───────── */

const toastListeners = new Set();
let toastSeq = 0;

export function toast(message, type = 'ok') {
  const t = { id: ++toastSeq, message, type, leaving: false };
  toastListeners.forEach((fn) => fn({ add: t }));
  setTimeout(() => toastListeners.forEach((fn) => fn({ leave: t.id })), type === 'err' ? 5200 : 2800);
  setTimeout(() => toastListeners.forEach((fn) => fn({ remove: t.id })), type === 'err' ? 5450 : 3050);
}

export function Toasts() {
  const [list, setList] = useState([]);
  useEffect(() => {
    const fn = (ev) => {
      if (ev.add) setList((l) => [...l.slice(-2), ev.add]);
      if (ev.leave) setList((l) => l.map((t) => (t.id === ev.leave ? { ...t, leaving: true } : t)));
      if (ev.remove) setList((l) => l.filter((t) => t.id !== ev.remove));
    };
    toastListeners.add(fn);
    return () => toastListeners.delete(fn);
  }, []);
  return html`<div class="toasts" role="status" aria-live="polite">
    ${list.map((t) => html`<div key=${t.id} class=${cx('toast', t.type === 'err' ? 'toast-err' : 'toast-ok', t.leaving && 'leaving')}>
      <${Icon} name=${t.type === 'err' ? 'warn' : 'check'} size=20 />
      <span>${t.message}</span>
    </div>`)}
  </div>`;
}

/* ───────── лист (bottom sheet / диалог на десктопе) ───────── */

let sheetCount = 0;

export function Sheet({ open, onClose, title, children, footer, label, class: cls = '' }) {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef(null);
  const lastFocus = useRef(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const t = setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, 230);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    sheetCount++;
    document.documentElement.classList.add('no-scroll');
    lastFocus.current = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    return () => {
      sheetCount--;
      if (sheetCount <= 0) document.documentElement.classList.remove('no-scroll');
      lastFocus.current?.focus?.({ preventScroll: true });
    };
  }, [mounted]);

  if (!mounted) return null;
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose?.();
    }
  };
  return html`<${Fragment}>
    <div class=${cx('overlay', leaving && 'leaving')} onClick=${onClose}></div>
    <div ref=${ref} class=${cx('sheet', leaving && 'leaving', cls)} role="dialog" aria-modal="true" aria-label=${label || title} tabindex="-1" onKeyDown=${onKey}>
      <div class="sheet-grab"></div>
      ${title !== undefined && html`<div class="sheet-head">
        <h2>${title}</h2>
        <button class="icon-btn" onClick=${onClose} aria-label="Закрыть"><${Icon} name="x" /></button>
      </div>`}
      <div class="sheet-body">${children}</div>
      ${footer && html`<div class="sheet-foot">${footer}</div>`}
    </div>
  <//>`;
}

// htm: <//> закрывает любой компонент; Fragment — просто функция, возвращающая детей
function Fragment({ children }) {
  return children;
}
export { Fragment };

/* ───────── мелкие компоненты ───────── */

/** minOne: количество не опускается ниже единицы (в карточке блюда), иначе на единице «−» превращается в корзину */
export function Stepper({ value, onInc, onDec, flat = false, label = '', minOne = false }) {
  const trash = !minOne && value <= 1;
  return html`<div class=${cx('stepper', flat && 'stepper-flat')} role="group" aria-label=${label || 'Количество'}>
    <button type="button" onClick=${onDec} disabled=${minOne && value <= 1} style=${minOne && value <= 1 ? 'opacity:.35' : ''} aria-label=${trash ? 'Убрать' : 'Меньше'}><${Icon} name=${trash ? 'trash' : 'minus'} size=${trash ? 18 : 20} /></button>
    <output aria-live="polite">${value}</output>
    <button type="button" onClick=${onInc} aria-label="Больше"><${Icon} name="plus" /></button>
  </div>`;
}

export function Avatar({ guest, size = 32, shared = false }) {
  if (shared) return html`<span class="avatar avatar-shared" style=${{ '--s': size + 'px' }} title="Общее на стол"><${Icon} name="users" size=${size * 0.55} /></span>`;
  const color = GUEST_COLORS[(guest?.color ?? 0) % GUEST_COLORS.length];
  const letter = (guest?.name || '?').trim().charAt(0);
  return html`<span class="avatar" style=${{ '--s': size + 'px', '--c': color }} aria-hidden="true">${letter}</span>`;
}

export function Plaque({ children, size = '', class: cls = '' }) {
  return html`<span class=${cx('plaque', size && 'plaque-' + size, cls)}>${children}</span>`;
}

export function Spinner() {
  return html`<span class="spinner" role="progressbar" aria-label="Загрузка"></span>`;
}

/** Блок «ничего нет» с призывом к действию */
export function Empty({ icon = 'menu', title, text, children }) {
  return html`<div class="empty">
    <${Icon} name=${icon} size=44 stroke=1.5 />
    <h3>${title}</h3>
    ${text && html`<p>${text}</p>`}
    ${children}
  </div>`;
}

/** Изображение блюда: при ошибке или отсутствии фото — клетчатая заглушка */
export function Photo({ src, alt = '', class: cls = '', eager = false }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  if (!src || bad) {
    return html`<div class=${cx('photo photo-empty gingham', cls)} role="img" aria-label=${alt}><${Icon} name="menu" size=30 stroke=1.4 /></div>`;
  }
  return html`<img class=${cx('photo', cls)} src=${src} alt=${alt} loading=${eager ? 'eager' : 'lazy'} decoding="async" onError=${() => setBad(true)} referrerpolicy="no-referrer" />`;
}
