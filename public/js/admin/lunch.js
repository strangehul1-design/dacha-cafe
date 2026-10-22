// Дачные обеды: списки блюд на сегодня. Подставляются в комплексы из раздела «Дачные обеды».
import { html, useState, useEffect } from '../common/lib.js';
import { Icon } from '../common/icons.js';
import { api } from '../common/api.js';
import { rub } from '../common/format.js';
import { localParts } from '../common/hours.js';
import { PageHead, Field, run, dishesOf } from './common.js';

const LISTS = [
  ['salads', 'Салаты', 'Дамский каприз (копчёная грудка, ананас, помидор, сыр)'],
  ['soups', 'Супы', 'Грибной с фрикадельками'],
  ['hots', 'Горячее', 'Бедро запечённое'],
  ['sides', 'Гарниры', 'Картофельное пюре'],
  ['drinks', 'Напитки', 'Компот'],
];

export const lunchIsStale = (data) => data.settings.lunch.date !== localParts(data.settings.timezone).ymd;

export function LunchView({ data, setData, goto }) {
  const L = data.settings.lunch;
  const today = localParts(data.settings.timezone).ymd;
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setF({ date: L.date, ...Object.fromEntries(LISTS.map(([k]) => [k, (L[k] || []).join('\n')])) });
  }, [L]);

  const save = async (patch = {}) => {
    setBusy(true);
    const r = await run(() => api.put('/api/admin/settings', { lunch: { ...f, ...patch } }), 'Меню обедов сохранено');
    setBusy(false);
    if (r) setData((p) => ({ ...p, settings: r.settings }));
  };

  const combos = dishesOf(data, 'lunch');
  const stale = L.date !== today;

  return html`<div>
    <${PageHead} title="Дачные обеды" text="Что сегодня в комплексах. Гость выбирает салат, суп и горячее из этих списков — один блюдо на строку." />

    ${stale && html`<div class="notice" style="margin-bottom:16px"><${Icon} name="warn" /><div style="display:grid;gap:8px"><span>Список составлен на <b>${L.date.split('-').reverse().join('.')}</b>. Если сегодня меню другое — обновите его ниже, иначе гости закажут вчерашнее.</span><button class="btn btn-sm btn-quiet" style="justify-self:start" onClick=${() => setF({ ...f, date: today })}>Это меню на сегодня</button></div></div>`}

    <div class="stack">
      <${Field} label="Дата меню" id="l-date"><input id="l-date" class="input" type="date" style="max-width:220px" value=${f.date || ''} onInput=${(e) => setF({ ...f, date: e.currentTarget.value })} /><//>
      ${LISTS.map(([k, label, ph]) => html`<${Field} key=${k} label=${label} id=${'l-' + k} hint="По одному блюду на строку"><textarea id=${'l-' + k} class="textarea" rows="4" placeholder=${ph} value=${f[k] ?? ''} onInput=${(e) => setF({ ...f, [k]: e.currentTarget.value })}></textarea><//>`)}
      <div class="sticky-save"><button class="btn btn-lg" disabled=${busy} onClick=${() => save()}>${busy ? 'Сохраняем…' : 'Сохранить меню обедов'}</button></div>
    </div>

    <section class="panel" style="margin-top:20px">
      <h3>Комплексы и цены</h3>
      ${combos.map((d) => html`<div class="row" key=${d.id} style="justify-content:space-between"><span>${d.name}</span><b class="num">${rub(d.price)}</b></div>`)}
      <button class="btn btn-quiet" style="justify-self:start" onClick=${() => goto('menu')}>Изменить цены в «Меню и цены»</button>
    </section>
  </div>`;
}
