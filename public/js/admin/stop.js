// Стоп-лист: большие переключатели для телефона. Доступен и повару (роль kitchen).
import { html, useState, useMemo } from '../common/lib.js';
import { Icon } from '../common/icons.js';
import { api } from '../common/api.js';
import { cx, toast, Photo } from '../common/ui.js';
import { count } from '../common/format.js';
import { Switch, PageHead, askConfirm, run, hhmm, sortedCats, dishesOf } from './common.js';

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

export function StopView({ data, setData, role }) {
  const [q, setQ] = useState('');
  const [only, setOnly] = useState(false);
  const stopped = data.dishes.filter((d) => d.stop && !d.hidden);

  const visible = (d) => !d.hidden && (!q || norm(d.name).includes(norm(q))) && (!only || d.stop);

  const patch = (ids, stop) =>
    setData((p) => ({ ...p, dishes: p.dishes.map((d) => (ids.includes(d.id) ? { ...d, stop, stopAt: stop ? Date.now() : null } : d)) }));

  const toggle = async (d) => {
    const stop = !d.stop;
    patch([d.id], stop);
    const r = await run(() => api.post('/api/admin/stop', { ids: [d.id], stop }));
    if (!r) patch([d.id], !stop);
    else toast(stop ? `«${d.name}» — в стопе` : `«${d.name}» — снова в наличии`);
  };

  const bulk = async (ids, stop, label) => {
    patch(ids, stop);
    const r = await run(() => api.post('/api/admin/stop', { ids, stop }));
    if (!r) patch(ids, !stop);
    else toast(label);
  };

  const resetAll = async () => {
    if (!(await askConfirm({ title: 'Снять весь стоп-лист?', text: `Все блюда (${stopped.length}) снова станут доступными гостям.`, okLabel: 'Снять всё' }))) return;
    const r = await run(() => api.post('/api/admin/stop/reset'), 'Стоп-лист очищен');
    if (r) patch(data.dishes.map((d) => d.id), false);
  };

  const cats = sortedCats(data);

  return html`<div>
    <${PageHead} title="Стоп-лист" text="Отметьте блюда, которые закончились. Гости увидят это сразу — заказать их будет нельзя." />

    ${stopped.length > 0
      ? html`<div class="stop-summary"><${Icon} name="warn" /><span>В стопе: ${count(stopped.length, 'блюдо', 'блюда', 'блюд')}</span><button class="btn btn-sm btn-ghost" onClick=${resetAll}>Снять всё</button></div>`
      : html`<div class="stop-summary stop-ok"><${Icon} name="check" /><span>Всё в наличии</span></div>`}

    <div class="toolbar">
      <div class="searchbox">
        <${Icon} name="search" size=20 />
        <input class="input" type="search" placeholder="Найти блюдо" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} aria-label="Поиск" />
      </div>
      <button class="chip" aria-pressed=${only} onClick=${() => setOnly(!only)}>Только в стопе${stopped.length ? ` · ${stopped.length}` : ''}</button>
    </div>

    ${cats.map((c) => {
      const items = dishesOf(data, c.id).filter(visible);
      if (!items.length) return null;
      const allStop = items.every((d) => d.stop);
      return html`<section class="cat-block" key=${c.id}>
        <div class="cat-head">
          <h3>${c.name}</h3>
          <span class="count">${items.length}</span>
          <div class="actions">
            <button class="btn btn-sm btn-quiet" onClick=${() => bulk(items.map((d) => d.id), !allStop, allStop ? `${c.name}: снова в наличии` : `${c.name}: весь раздел в стопе`)}>${allStop ? 'Вернуть раздел' : 'Весь раздел в стоп'}</button>
          </div>
        </div>
        ${items.map(
          (d) => html`<div class=${cx('arow', d.stop && 'is-stop')} key=${d.id}>
            <${Thumb} src=${d.image} />
            <div>
              <div class="name"><span>${d.name}</span></div>
              ${d.stop
                ? html`<div class="stop-since">закончилось${d.stopAt ? ` в ${hhmm(d.stopAt)}` : ''}</div>`
                : html`<div class="meta">${d.weight || ''}</div>`}
            </div>
            <div class="arow-actions">
              <span class=${cx('muted', 'num')} style="font-size:13px;font-weight:650;min-width:38px;text-align:right">${d.stop ? 'Стоп' : 'Есть'}</span>
              <${Switch} checked=${!d.stop} stop onChange=${() => toggle(d)} label=${`${d.name}: в наличии`} />
            </div>
          </div>`,
        )}
      </section>`;
    })}
  </div>`;
}

export function Thumb({ src }) {
  return src ? html`<img class="thumb" src=${src} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${(e) => (e.currentTarget.style.visibility = 'hidden')} />` : html`<span class="thumb"><${Icon} name="image" size=22 /></span>`;
}
