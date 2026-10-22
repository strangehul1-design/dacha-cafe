// Меню и цены: правка цены прямо в списке, карточка блюда, массовое изменение цен, разделы.
import { html, useState, useEffect, useRef } from '../common/lib.js';
import { Icon } from '../common/icons.js';
import { api } from '../common/api.js';
import { Sheet, cx, toast } from '../common/ui.js';
import { count, rub } from '../common/format.js';
import { Switch, Field, Toggle, PageHead, askConfirm, run, uploadPhoto, sortedCats, dishesOf, catName } from './common.js';
import { Thumb } from './stop.js';

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const rid = () => Math.random().toString(36).slice(2, 8);

export function MenuAdmin({ data, setData }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [order, setOrder] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const noPrice = data.dishes.filter((d) => d.needsPrice || (d.price <= 0 && d.hidden));
  const cats = sortedCats(data);

  const localize = async () => {
    setSaving(true);
    const r = await run(() => api.post('/api/admin/images/localize'));
    setSaving(false);
    if (!r) return;
    toast(r.failedCount ? `Сохранено ${r.ok} из ${r.total}. Не удалось: ${r.failedCount}` : `Готово: сохранено фото — ${r.ok}`, r.failedCount ? 'err' : 'ok');
    reloadAfter();
  };

  const upsertDish = (dish) =>
    setData((p) => ({ ...p, dishes: p.dishes.some((d) => d.id === dish.id) ? p.dishes.map((d) => (d.id === dish.id ? dish : d)) : [...p.dishes, dish] }));

  const savePrice = async (d, price) => {
    const r = await run(() => api.put(`/api/admin/dishes/${d.id}`, { price }));
    if (r) {
      upsertDish(r.dish);
      if (d.needsPrice && r.dish.price > 0) toast(`«${d.name}» теперь видно гостям`);
      return true;
    }
    return false;
  };

  const toggleHidden = async (d) => {
    const r = await run(() => api.put(`/api/admin/dishes/${d.id}`, { hidden: !d.hidden }));
    if (r) {
      upsertDish(r.dish);
      toast(r.dish.hidden ? `«${d.name}» скрыто из меню` : `«${d.name}» снова в меню`);
    }
  };

  const edit = (d) => (setEditing(d), setEditOpen(true));
  const addDish = (categoryId) => (setEditing({ isNew: true, categoryId }), setEditOpen(true));

  const move = async (list, i, dir, kind, categoryId) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setData((p) =>
      kind === 'categories'
        ? { ...p, categories: p.categories.map((c) => ({ ...c, order: ids.indexOf(c.id) })) }
        : { ...p, dishes: p.dishes.map((d) => (ids.includes(d.id) ? { ...d, order: ids.indexOf(d.id) + 1 } : d)) },
    );
    await run(() => api.post('/api/admin/reorder', { kind, ids, categoryId }));
  };

  const match = (d) => {
    if (q && !norm(d.name).includes(norm(q))) return false;
    if (filter === 'noprice') return d.needsPrice || (d.price <= 0 && d.hidden);
    if (filter === 'hidden') return d.hidden;
    return true;
  };

  return html`<div>
    <${PageHead} title="Меню и цены" text="Меняйте цены прямо в списке: введите число и нажмите Enter. Скрытые блюда гости не видят.">
      <button class="btn btn-ghost" onClick=${() => setBulkOpen(true)}><${Icon} name="tag" size=20 />Изменить цены</button>
      <button class="btn btn-ghost" onClick=${() => setCatsOpen(true)}><${Icon} name="list" size=20 />Разделы</button>
      <button class="btn" onClick=${() => addDish(cats[0]?.id)}><${Icon} name="plus" size=20 />Блюдо</button>
    <//>

    ${data.externalImages > 0 && html`<div class="notice" style="margin-bottom:16px">
      <${Icon} name="image" />
      <div style="display:grid;gap:8px"><span>Фото ${count(data.externalImages, 'блюда', 'блюд', 'блюд')} подгружаются с другого сайта (прежний сайт кафе). Если он изменится или исчезнет, фото пропадут. Сохраните их на свой сервер — это делается один раз.</span>
      <button class="btn btn-sm btn-quiet" style="justify-self:start" disabled=${saving} onClick=${localize}>${saving ? 'Сохраняем, подождите…' : 'Сохранить фото на сервер'}</button></div>
    </div>`}

    ${noPrice.length > 0 && html`<div class="notice" style="margin-bottom:16px">
      <${Icon} name="warn" />
      <div style="display:grid;gap:8px"><span><b>${count(noPrice.length, 'позиция', 'позиции', 'позиций')} без цены</b> скрыты от гостей. Укажите цену — блюдо сразу появится в меню.</span>
      <button class="btn btn-sm btn-quiet" style="justify-self:start" onClick=${() => setFilter('noprice')}>Показать их</button></div>
    </div>`}

    <div class="toolbar">
      <div class="searchbox"><${Icon} name="search" size=20 /><input class="input" type="search" placeholder="Найти блюдо" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} aria-label="Поиск" /></div>
      <button class="chip" aria-pressed=${filter === 'all'} onClick=${() => setFilter('all')}>Все</button>
      <button class="chip" aria-pressed=${filter === 'noprice'} onClick=${() => setFilter(filter === 'noprice' ? 'all' : 'noprice')}>Без цены</button>
      <button class="chip" aria-pressed=${filter === 'hidden'} onClick=${() => setFilter(filter === 'hidden' ? 'all' : 'hidden')}>Скрытые</button>
      <button class="chip" aria-pressed=${order} onClick=${() => setOrder(!order)}><${Icon} name="drag" size=16 />Порядок</button>
    </div>

    ${cats.map((c, ci) => {
      const all = dishesOf(data, c.id);
      const items = all.filter(match);
      if (!items.length && (q || filter !== 'all')) return null;
      return html`<section class="cat-block" key=${c.id}>
        <div class="cat-head">
          <h3>${c.name}${c.hidden ? html` <span class="badge badge-danger">скрыт</span>` : ''}</h3>
          <span class="count">${all.length}</span>
          <div class="actions">
            ${order && html`<button class="icon-btn" aria-label="Раздел выше" onClick=${() => move(cats, ci, -1, 'categories')}><${Icon} name="up" size=20 /></button><button class="icon-btn" aria-label="Раздел ниже" onClick=${() => move(cats, ci, 1, 'categories')}><${Icon} name="down" size=20 /></button>`}
            <button class="icon-btn" aria-label=${`Добавить блюдо в раздел ${c.name}`} onClick=${() => addDish(c.id)}><${Icon} name="plus" size=22 /></button>
          </div>
        </div>
        ${items.length === 0 && html`<p class="muted" style="padding:14px 0">В разделе пока нет блюд. Нажмите «+», чтобы добавить.</p>`}
        ${items.map((d, i) => html`<${DishRow} key=${d.id} d=${d} order=${order} first=${i === 0} last=${i === items.length - 1} onPrice=${savePrice} onEdit=${edit} onHide=${toggleHidden} onMove=${(dir) => move(items, i, dir, 'dishes', c.id)} />`)}
      </section>`;
    })}

    <${DishEditor} open=${editOpen} onClose=${() => setEditOpen(false)} dish=${editing} data=${data} onSaved=${(dish) => (upsertDish(dish), setEditOpen(false))} onDeleted=${(id) => (setData((p) => ({ ...p, dishes: p.dishes.filter((d) => d.id !== id) })), setEditOpen(false))} />
    <${BulkPrices} open=${bulkOpen} onClose=${() => setBulkOpen(false)} data=${data} />
    <${CategoriesSheet} open=${catsOpen} onClose=${() => setCatsOpen(false)} data=${data} setData=${setData} />
  </div>`;
}

// После массового изменения цен проще перечитать данные целиком
function reloadAfter() {
  window.dispatchEvent(new CustomEvent('admin:refresh'));
}

function DishRow({ d, order, first, last, onPrice, onEdit, onHide, onMove }) {
  const [val, setVal] = useState(d.price > 0 ? String(d.price) : '');
  const [state, setState] = useState('');
  useEffect(() => setVal(d.price > 0 ? String(d.price) : ''), [d.price]);

  const commit = async () => {
    const n = Math.round(Number(val));
    if (val === '' || !Number.isFinite(n) || n <= 0) {
      setVal(d.price > 0 ? String(d.price) : '');
      return;
    }
    if (n === d.price) return;
    const ok = await onPrice(d, n);
    setState(ok ? 'saved' : 'error');
    setTimeout(() => setState(''), 1400);
  };

  return html`<div class=${cx('arow', d.hidden && 'is-hidden', d.stop && 'is-stop')}>
    <${Thumb} src=${d.image} />
    <button class="name-btn" onClick=${() => onEdit(d)} aria-label=${`Редактировать: ${d.name}`}>
      <span class="name"><span>${d.name}</span>${d.hit ? html`<span class="badge badge-butter">хит</span>` : ''}${d.stop ? html`<span class="badge badge-danger">стоп</span>` : ''}${d.hidden ? html`<span class="badge">${d.needsPrice ? 'нужна цена' : 'скрыто'}</span>` : ''}</span>
      <span class="meta">${[d.weight, !d.forTable && 'нет в зале', !d.forDelivery && 'нет в доставке'].filter(Boolean).join(' · ')}</span>
    </button>
    <div class="arow-actions">
      ${order
        ? html`<button class="icon-btn" disabled=${first} aria-label="Выше" onClick=${() => onMove(-1)}><${Icon} name="up" size=20 /></button><button class="icon-btn" disabled=${last} aria-label="Ниже" onClick=${() => onMove(1)}><${Icon} name="down" size=20 /></button>`
        : html`<label class=${cx('price-input', state)}>
            <input type="number" inputmode="numeric" min="1" step="1" placeholder="цена" value=${val} aria-label=${`Цена: ${d.name}`} onInput=${(e) => setVal(e.currentTarget.value)} onBlur=${commit} onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.blur()} />
            <span>₽</span>
          </label>
          <button class="icon-btn" aria-label=${d.hidden ? 'Показать в меню' : 'Скрыть из меню'} title=${d.hidden ? 'Показать в меню' : 'Скрыть из меню'} onClick=${() => onHide(d)}><${Icon} name=${d.hidden ? 'eyeoff' : 'eye'} size=20 /></button>`}
    </div>
  </div>`;
}

/* ───────── карточка блюда ───────── */

function blank(categoryId) {
  return { name: '', desc: '', weight: '', price: '', image: '', categoryId, tags: [], hit: false, hidden: false, forTable: true, forDelivery: true, options: [] };
}

function DishEditor({ open, onClose, dish, data, onSaved, onDeleted }) {
  const isNew = !!dish?.isNew;
  const [f, setF] = useState(blank(''));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const file = useRef(null);

  useEffect(() => {
    if (!open || !dish) return;
    setF(isNew ? blank(dish.categoryId) : { ...JSON.parse(JSON.stringify(dish)), price: dish.price > 0 ? String(dish.price) : '' });
  }, [open, dish?.id, dish?.isNew]);

  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const tag = (t, on) => set('tags', on ? [...new Set([...f.tags, t])] : f.tags.filter((x) => x !== t));

  const onFile = async (e) => {
    const fl = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!fl) return;
    setUploading(true);
    try {
      set('image', await uploadPhoto(fl));
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!f.name.trim()) return toast('Укажите название блюда', 'err');
    if (isNew && !(Number(f.price) > 0)) return toast('Укажите цену', 'err');
    setBusy(true);
    const body = { ...f, price: Number(f.price) || 0 };
    delete body.id;
    delete body.order;
    delete body.stopAt;
    delete body.needsPrice;
    delete body.isNew;
    const r = await run(() => (isNew ? api.post('/api/admin/dishes', body) : api.put(`/api/admin/dishes/${dish.id}`, body)), isNew ? 'Блюдо добавлено' : 'Сохранено');
    setBusy(false);
    if (r) onSaved(r.dish);
  };

  const remove = async () => {
    if (!(await askConfirm({ title: `Удалить «${f.name}»?`, text: 'Блюдо исчезнет из меню навсегда. Если нужно только убрать на время — лучше скрыть его.', okLabel: 'Удалить', danger: true }))) return;
    const r = await run(() => api.del(`/api/admin/dishes/${dish.id}`), 'Блюдо удалено');
    if (r) onDeleted(dish.id);
  };

  const cats = sortedCats(data);

  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title=${isNew ? 'Новое блюдо' : 'Блюдо'}
    class="wide"
    footer=${html`<button class="btn btn-lg" disabled=${busy} onClick=${save}>${busy ? 'Сохраняем…' : 'Сохранить'}</button>${!isNew && html`<button class="btn btn-danger" onClick=${remove}><${Icon} name="trash" size=20 />Удалить блюдо</button>`}`}
  >
    <div class="stack">
      <div class="photo-edit">
        ${f.image ? html`<img class="preview" src=${f.image} alt="" referrerpolicy="no-referrer" />` : html`<span class="preview"><${Icon} name="image" size=30 /></span>`}
        <div class="stack">
          <input type="file" accept="image/*" hidden ref=${file} onChange=${onFile} />
          <div class="row" style="flex-wrap:wrap;gap:8px">
            <button class="btn btn-sm btn-quiet" disabled=${uploading} onClick=${() => file.current.click()}><${Icon} name="upload" size=18 />${uploading ? 'Загружаем…' : 'Загрузить фото'}</button>
            ${f.image && html`<button class="btn btn-sm btn-ghost" onClick=${() => set('image', '')}>Убрать</button>`}
          </div>
          <input class="input" style="min-height:44px;font-size:14px" placeholder="или вставьте ссылку на фото" value=${f.image} onInput=${(e) => set('image', e.currentTarget.value)} aria-label="Ссылка на фото" />
        </div>
      </div>

      <${Field} label="Название" id="d-name"><input id="d-name" class="input" maxlength="80" value=${f.name} onInput=${(e) => set('name', e.currentTarget.value)} /><//>
      <${Field} label="Описание" id="d-desc" hint="Состав или пара слов о блюде"><textarea id="d-desc" class="textarea" maxlength="400" value=${f.desc} onInput=${(e) => set('desc', e.currentTarget.value)}></textarea><//>
      <div class="kv">
        <${Field} label="Цена, ₽" id="d-price"><input id="d-price" class="input" type="number" inputmode="numeric" min="0" step="1" value=${f.price} onInput=${(e) => set('price', e.currentTarget.value)} /><//>
        <${Field} label="Вес или объём" id="d-weight"><input id="d-weight" class="input" maxlength="20" placeholder="например, 250 г" value=${f.weight} onInput=${(e) => set('weight', e.currentTarget.value)} /><//>
      </div>
      <${Field} label="Раздел" id="d-cat"><select id="d-cat" class="select" value=${f.categoryId} onChange=${(e) => set('categoryId', e.currentTarget.value)}>${cats.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}</select><//>

      <div class="field"><span class="label">Пометки</span>
        <div class="row" style="flex-wrap:wrap;gap:8px 18px">
          <${Toggle} checked=${f.tags.includes('veg')} onChange=${(v) => tag('veg', v)}>Без мяса<//>
          <${Toggle} checked=${f.tags.includes('spicy')} onChange=${(v) => tag('spicy', v)}>Острое<//>
          <${Toggle} checked=${f.tags.includes('new')} onChange=${(v) => tag('new', v)}>Новинка<//>
          <${Toggle} checked=${f.hit} onChange=${(v) => set('hit', v)}>Хит<//>
        </div>
      </div>

      <div class="field"><span class="label">Где показывать</span>
        <div class="row" style="flex-wrap:wrap;gap:8px 18px">
          <${Toggle} checked=${f.forTable} onChange=${(v) => set('forTable', v)}>В зале (QR-меню)<//>
          <${Toggle} checked=${f.forDelivery} onChange=${(v) => set('forDelivery', v)}>В доставке на сайте<//>
          <${Toggle} checked=${!f.hidden} onChange=${(v) => set('hidden', !v)}>Показывать гостям<//>
        </div>
      </div>

      <${OptionsEditor} options=${f.options} onChange=${(o) => set('options', o)} />
    </div>
  <//>`;
}

function OptionsEditor({ options, onChange }) {
  const upd = (i, patch) => onChange(options.map((g, k) => (k === i ? { ...g, ...patch } : g)));
  const addGroup = () => onChange([...options, { id: rid(), name: '', required: true, choices: [{ id: rid(), name: '', price: 0 }] }]);

  return html`<div class="field">
    <span class="label">Варианты выбора</span>
    <span class="hint">Например, «Лапша на выбор» или «Гарнир». Гость выберет вариант, прежде чем добавить блюдо.</span>
    ${options.map(
      (g, i) => html`<div class="opt-edit" key=${g.id}>
        <div class="row">
          <input class="input" style="flex:1" placeholder="Название группы" value=${g.name} onInput=${(e) => upd(i, { name: e.currentTarget.value })} aria-label="Название группы" />
          <button class="icon-btn" aria-label="Удалить группу" onClick=${() => onChange(options.filter((_, k) => k !== i))}><${Icon} name="trash" size=20 /></button>
        </div>
        <${Toggle} checked=${g.required} onChange=${(v) => upd(i, { required: v })}>Выбрать обязательно<//>
        ${g.choices.map(
              (c, k) => html`<div class="choice" key=${c.id}>
                <input class="input" placeholder="Вариант" value=${c.name} onInput=${(e) => upd(i, { choices: g.choices.map((x, m) => (m === k ? { ...x, name: e.currentTarget.value } : x)) })} aria-label="Вариант" />
                <input class="input" type="number" min="0" inputmode="numeric" placeholder="+0 ₽" value=${c.price || ''} onInput=${(e) => upd(i, { choices: g.choices.map((x, m) => (m === k ? { ...x, price: Number(e.currentTarget.value) || 0 } : x)) })} aria-label="Доплата, ₽" />
                <button class="icon-btn" aria-label="Убрать вариант" onClick=${() => upd(i, { choices: g.choices.filter((_, m) => m !== k) })}><${Icon} name="x" size=18 /></button>
              </div>`,
            )}
        <button class="btn btn-sm btn-quiet" style="justify-self:start" onClick=${() => upd(i, { choices: [...g.choices, { id: rid(), name: '', price: 0 }] })}><${Icon} name="plus" size=16 />Вариант</button>
      </div>`,
    )}
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <button class="btn btn-sm btn-ghost" onClick=${addGroup}><${Icon} name="plus" size=16 />Новая группа</button>
    </div>
  </div>`;
}

/* ───────── массовое изменение цен ───────── */

function BulkPrices({ open, onClose, data, onDone }) {
  const [mode, setMode] = useState('percent');
  const [value, setValue] = useState('');
  const [round, setRound] = useState(10);
  const [picked, setPicked] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const cats = sortedCats(data);

  useEffect(() => {
    if (open) {
      setPicked(cats.map((c) => c.id));
      setValue('');
      setPreview(null);
    }
  }, [open]);

  const body = () => ({ mode, value: Number(value), round, categoryIds: picked.length === cats.length ? null : picked });

  useEffect(() => {
    if (!open || !Number(value) || !picked.length) return setPreview(null);
    const t = setTimeout(async () => {
      try {
        setPreview(await api.post('/api/admin/prices/bulk', { ...body(), dry: true }));
      } catch (e) {
        setPreview({ error: e.message });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [mode, value, round, picked.join(), open]);

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const apply = async () => {
    setBusy(true);
    const r = await run(() => api.post('/api/admin/prices/bulk', body()));
    setBusy(false);
    if (r) {
      toast(`Цены изменены: ${count(r.count, 'блюдо', 'блюда', 'блюд')}`);
      reloadAfter();
      onClose();
    }
  };

  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="Изменить цены сразу"
    footer=${html`<button class="btn btn-lg" disabled=${busy || !preview || preview.error || !preview.count} onClick=${apply}>${preview?.count ? `Изменить цены: ${preview.count}` : 'Изменить цены'}</button>`}
  >
    <div class="stack">
      <div class="seg" role="group"><button aria-pressed=${mode === 'percent'} onClick=${() => setMode('percent')}>На процент</button><button aria-pressed=${mode === 'rub'} onClick=${() => setMode('rub')}>На сумму</button></div>
      <${Field} label=${mode === 'percent' ? 'На сколько процентов (можно со знаком минус)' : 'На сколько рублей (можно со знаком минус)'} id="b-val"><input id="b-val" class="input" type="number" inputmode="decimal" placeholder=${mode === 'percent' ? 'например, 8' : 'например, 20'} value=${value} onInput=${(e) => setValue(e.currentTarget.value)} /><//>
      <${Field} label="Округлять цены до" id="b-round"><select id="b-round" class="select" value=${round} onChange=${(e) => setRound(Number(e.currentTarget.value))}><option value="10">10 ₽</option><option value="5">5 ₽</option><option value="1">1 ₽ (без округления)</option></select><//>
      <div class="field"><span class="label">Какие разделы</span>
        <div class="who-grid" style="gap:8px;display:flex;flex-wrap:wrap">${cats.map((c) => html`<button key=${c.id} class="chip" aria-pressed=${picked.includes(c.id)} onClick=${() => toggle(c.id)}>${c.name}</button>`)}</div>
      </div>
      ${preview?.error && html`<div class="notice notice-danger"><${Icon} name="warn" /><span>${preview.error}</span></div>`}
      ${preview && !preview.error && html`<div class="panel"><b>${preview.count ? `Изменится ${count(preview.count, 'цена', 'цены', 'цен')}. Например:` : 'Ни одна цена не изменится'}</b>
        ${preview.preview.map((p) => html`<div class="row" key=${p.id} style="justify-content:space-between;font-size:15px"><span>${p.name}</span><span class="num"><s class="faint">${rub(p.from)}</s> → <b>${rub(p.to)}</b></span></div>`)}</div>`}
    </div>
  <//>`;
}

/* ───────── разделы ───────── */

function CategoriesSheet({ open, onClose, data, setData }) {
  const [name, setName] = useState('');
  const cats = sortedCats(data);

  const patchCat = (cat) => setData((p) => ({ ...p, categories: p.categories.map((c) => (c.id === cat.id ? cat : c)) }));

  const save = async (c, patch, okMsg) => {
    const r = await run(() => api.put(`/api/admin/categories/${c.id}`, patch), okMsg);
    if (r) patchCat(r.category);
  };

  const add = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    const r = await run(() => api.post('/api/admin/categories', { name }), 'Раздел добавлен');
    if (r) {
      setData((p) => ({ ...p, categories: [...p.categories, r.category] }));
      setName('');
    }
  };

  const remove = async (c) => {
    if (!(await askConfirm({ title: `Удалить раздел «${c.name}»?`, text: 'Удалить можно только пустой раздел.', okLabel: 'Удалить', danger: true }))) return;
    const r = await run(() => api.del(`/api/admin/categories/${c.id}`), 'Раздел удалён');
    if (r) setData((p) => ({ ...p, categories: p.categories.filter((x) => x.id !== c.id) }));
  };

  return html`<${Sheet} open=${open} onClose=${onClose} title="Разделы меню" class="wide">
    <div class="stack">
      <p class="muted">Название, подпись и время доступности. Например, бизнес-ланч можно показывать только с 11:00 до 16:00.</p>
      ${cats.map(
        (c) => html`<div class="panel" key=${c.id}>
          <div class="row">
            <input class="input" style="flex:1" defaultValue=${c.name} aria-label="Название раздела" onBlur=${(e) => e.currentTarget.value.trim() && e.currentTarget.value !== c.name && save(c, { name: e.currentTarget.value }, 'Название сохранено')} />
            <${Switch} small checked=${!c.hidden} label=${`Показывать раздел ${c.name}`} onChange=${(v) => save(c, { hidden: !v }, v ? 'Раздел виден гостям' : 'Раздел скрыт')} />
            <button class="icon-btn" aria-label="Удалить раздел" onClick=${() => remove(c)}><${Icon} name="trash" size=20 /></button>
          </div>
          <div class="kv">
            <${Field} label="Подпись"><input class="input" defaultValue=${c.note} maxlength="60" onBlur=${(e) => e.currentTarget.value !== c.note && save(c, { note: e.currentTarget.value })} /><//>
            <div class="field"><span class="label">Доступно по времени</span>
              <div class="row"><input class="input" type="time" defaultValue=${c.from} aria-label="С" onChange=${(e) => save(c, { from: e.currentTarget.value, to: c.to || (e.currentTarget.value ? '23:00' : '') })} /><span>–</span><input class="input" type="time" defaultValue=${c.to} aria-label="До" onChange=${(e) => save(c, { to: e.currentTarget.value, from: c.from || (e.currentTarget.value ? '11:00' : '') })} /></div>
              ${(c.from || c.to) && html`<button class="btn btn-sm btn-ghost" style="justify-self:start" onClick=${() => save(c, { from: '', to: '' }, 'Ограничение снято')}>Показывать весь день</button>`}
            </div>
          </div>
        </div>`,
      )}
      <form class="row" onSubmit=${add}>
        <input class="input" style="flex:1" placeholder="Новый раздел, например «Напитки»" value=${name} onInput=${(e) => setName(e.currentTarget.value)} aria-label="Название нового раздела" />
        <button class="btn" type="submit"><${Icon} name="plus" size=20 />Добавить</button>
      </form>
    </div>
  <//>`;
}
