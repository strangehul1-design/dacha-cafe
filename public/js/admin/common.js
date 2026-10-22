// Общие кусочки админки: переключатель, подтверждение, поля, сжатие и загрузка фото.
import { html, useState, useEffect } from '../common/lib.js';
import { Icon } from '../common/icons.js';
import { Sheet, cx, toast } from '../common/ui.js';
import { api } from '../common/api.js';

export function Switch({ checked, onChange, label, stop = false, small = false, disabled = false }) {
  return html`<button
    type="button"
    role="switch"
    class=${cx('switch', stop && 'stop', small && 'sm')}
    aria-checked=${checked}
    aria-label=${label}
    disabled=${disabled}
    onClick=${() => onChange(!checked)}
  ></button>`;
}

export function Field({ label, hint, children, id }) {
  return html`<div class="field">
    ${label && html`<label for=${id}>${label}</label>`}
    ${children}
    ${hint && html`<span class="hint">${hint}</span>`}
  </div>`;
}

export function Toggle({ checked, onChange, children }) {
  return html`<label class="check"><input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.currentTarget.checked)} /><span>${children}</span></label>`;
}

/* ───────── подтверждение (вместо window.confirm) ───────── */

let askFn = null;

export function askConfirm(opts) {
  return new Promise((resolve) => (askFn ? askFn({ ...opts, resolve }) : resolve(window.confirm(opts.title))));
}

export function ConfirmHost() {
  const [req, setReq] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    askFn = (r) => {
      setReq(r);
      setOpen(true);
    };
    return () => (askFn = null);
  }, []);
  const done = (v) => {
    setOpen(false);
    req?.resolve(v);
  };
  return html`<${Sheet}
    open=${open}
    onClose=${() => done(false)}
    title=${req?.title}
    footer=${html`<button class=${cx('btn btn-lg', req?.danger ? 'btn-accent' : '')} onClick=${() => done(true)}>${req?.okLabel || 'Да'}</button><button class="btn btn-ghost" onClick=${() => done(false)}>Отмена</button>`}
  >
    ${req?.text && html`<p class="muted">${req.text}</p>`}
  <//>`;
}

/* ───────── вызов API с понятным сообщением об ошибке ───────── */

export async function run(fn, okMessage) {
  try {
    const r = await fn();
    if (okMessage) toast(okMessage);
    return r;
  } catch (e) {
    toast(e.message, 'err');
    return undefined;
  }
}

/* ───────── фото: сжатие в браузере и загрузка ───────── */

async function shrink(file, max = 1280, quality = 0.86) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось обработать фото'))), 'image/jpeg', quality));
}

export async function uploadPhoto(file) {
  if (!file.type.startsWith('image/')) throw new Error('Выберите файл с картинкой');
  const blob = file.type === 'image/gif' ? file : await shrink(file);
  const r = await api.upload('/api/admin/upload', blob);
  return r.url;
}

export const hhmm = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function catName(data, id) {
  return data.categories.find((c) => c.id === id)?.name || '';
}

export function sortedCats(data) {
  return [...data.categories].sort((a, b) => a.order - b.order);
}

export function dishesOf(data, catId) {
  return data.dishes.filter((d) => d.categoryId === catId).sort((a, b) => a.order - b.order);
}

export function PageHead({ title, text, children }) {
  return html`<header class="page-head">
    <div><h2>${title}</h2>${text && html`<p>${text}</p>`}</div>
    ${children && html`<div class="actions">${children}</div>`}
  </header>`;
}

export { Icon };
