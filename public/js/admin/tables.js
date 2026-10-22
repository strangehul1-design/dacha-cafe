// Столы, залы, наборы меню для разных QR-кодов и печать табличек.
import { html, useState, useEffect } from '../common/lib.js';
import { Icon } from '../common/icons.js';
import { api } from '../common/api.js';
import { Sheet, Plaque, toast, cx } from '../common/ui.js';
import { count } from '../common/format.js';
import { Switch, Field, PageHead, askConfirm, run, sortedCats } from './common.js';

const qrSrc = (text) => '/api/admin/qr.svg?text=' + encodeURIComponent(text);
const tableUrl = (data, t) => `${data.publicUrl}/t/${t.code}`;

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Ссылка скопирована');
  } catch {
    toast('Не удалось скопировать — выделите ссылку вручную', 'err');
  }
}

export function TablesView({ data, setData, onPrint }) {
  const [sel, setSel] = useState(null);
  const [selOpen, setSelOpen] = useState(false);
  const [open, setOpen] = useState({});
  const [custom, setCustom] = useState('');
  const show = (n) => setOpen((o) => ({ ...o, [n]: true }));
  const hide = (n) => setOpen((o) => ({ ...o, [n]: false }));

  const tablesOf = (hallId) => data.tables.filter((t) => t.hallId === hallId).sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }));
  const menuName = (id) => data.menus.find((m) => m.id === id)?.name;

  return html`<div>
    <${PageHead} title="Столы и QR-коды" text="У каждого стола свой QR-код. Гость сканирует его, и меню открывается с номером стола.">
      <button class="btn btn-ghost" onClick=${() => show('menus')}><${Icon} name="list" size=20 />Наборы меню</button>
      <button class="btn btn-ghost" onClick=${() => show('halls')}><${Icon} name="home" size=20 />Залы</button>
      <button class="btn btn-ghost" onClick=${() => show('bulk')}><${Icon} name="plus" size=20 />Добавить столы</button>
      <button class="btn" onClick=${() => onPrint(data.tables)}><${Icon} name="print" size=20 />Печать табличек</button>
    <//>

    ${/localhost|127\.0\.0\.1|^http:\/\//.test(data.publicUrl) && html`<div class="notice notice-danger" style="margin-bottom:16px"><${Icon} name="warn" /><span>QR-коды сейчас ведут на <b>${data.publicUrl}</b>. На телефонах гостей такой адрес не откроется. Перед печатью откройте админку по боевому адресу сайта (https://…/admin) или задайте <code>PUBLIC_URL</code> на сервере.</span></div>`}

    ${data.halls.map(
      (h) => html`<section class="hall-block" key=${h.id}>
        <header><h3>${h.name}</h3><span class="badge">${h.seats ? `до ${h.seats} гостей` : 'без ограничения'}</span><span class="spacer"></span><button class="btn btn-sm btn-quiet" onClick=${() => onPrint(tablesOf(h.id))}><${Icon} name="print" size=16 />Печать зала</button></header>
        <div class="table-grid">
          ${tablesOf(h.id).map(
            (t) => html`<button key=${t.id} class="table-chip" onClick=${() => (setSel(t), setSelOpen(true))} aria-label=${`Стол ${t.number}: QR-код и настройки`}>
              <${Plaque}>${t.number}<//>
              <small>${t.menuId !== 'main' ? menuName(t.menuId) : 'QR-код'}</small>
            </button>`,
          )}
          ${tablesOf(h.id).length === 0 && html`<p class="muted">В этом зале пока нет столов.</p>`}
        </div>
      </section>`,
    )}

    <section class="panel" style="margin-top:28px">
      <h3>Другие QR-коды</h3>
      <p class="muted">Для вывески, листовки, чека или упаковки доставки. Скачайте картинку и отправьте в печать.</p>
      <div class="qr-cards">
        <${QrCard} title="Сайт и меню" text=${data.publicUrl + '/'} note="Главная страница с меню и доставкой" />
        <${QrCard} title="Заказ доставки" text=${data.publicUrl + '/#menu'} note="Сразу к меню для доставки" />
        ${/^https?:\/\//i.test(custom) && html`<${QrCard} title="Свой QR" text=${custom} note=${custom} />`}
      </div>
      <div class="field"><label for="qr-custom">Свой QR-код: вставьте любую ссылку</label><input id="qr-custom" class="input" placeholder="https://" value=${custom} onInput=${(e) => setCustom(e.currentTarget.value.trim())} /></div>
    </section>

    <${TableSheet} open=${selOpen} onClose=${() => setSelOpen(false)} table=${sel} data=${data} setData=${setData} onPrint=${onPrint} />
    <${BulkTables} open=${!!open.bulk} onClose=${() => hide('bulk')} data=${data} setData=${setData} />
    <${HallsSheet} open=${!!open.halls} onClose=${() => hide('halls')} data=${data} setData=${setData} />
    <${MenusSheet} open=${!!open.menus} onClose=${() => hide('menus')} data=${data} setData=${setData} />
  </div>`;
}

function QrCard({ title, text, note }) {
  return html`<div class="qr-card">
    <b>${title}</b>
    <img src=${qrSrc(text)} alt=${'QR-код: ' + title} />
    <span class="muted" style="font-size:13px;word-break:break-all">${note}</span>
    <a class="btn btn-sm btn-quiet" href=${qrSrc(text)} download=${title + '.svg'}><${Icon} name="upload" size=16 style="transform:rotate(180deg)" />Скачать</a>
  </div>`;
}

/* ───────── стол ───────── */

function TableSheet({ open, onClose, table, data, setData, onPrint }) {
  const [f, setF] = useState({ number: '', hallId: '', menuId: 'main' });
  useEffect(() => {
    if (table) setF({ number: table.number, hallId: table.hallId, menuId: table.menuId });
  }, [table?.id, open]);
  if (!table) return null;
  const live = data.tables.find((t) => t.id === table.id) || table;
  const url = tableUrl(data, live);

  const save = async (patch, ok) => {
    const r = await run(() => api.put(`/api/admin/tables/${table.id}`, patch), ok);
    if (r) setData((p) => ({ ...p, tables: p.tables.map((t) => (t.id === table.id ? r.table : t)) }));
    return r;
  };

  const regen = async () => {
    if (!(await askConfirm({ title: 'Выпустить новый QR-код?', text: 'Старая наклейка и табличка перестанут работать. Делайте это, если QR-код стола попал не туда.', okLabel: 'Новый код', danger: true }))) return;
    const r = await run(() => api.post(`/api/admin/tables/${table.id}/regen`), 'Новый код выпущен');
    if (r) setData((p) => ({ ...p, tables: p.tables.map((t) => (t.id === table.id ? r.table : t)) }));
  };

  const remove = async () => {
    if (!(await askConfirm({ title: `Удалить стол ${table.number}?`, text: 'QR-код этого стола перестанет работать.', okLabel: 'Удалить', danger: true }))) return;
    const r = await run(() => api.del(`/api/admin/tables/${table.id}`), 'Стол удалён');
    if (r) {
      setData((p) => ({ ...p, tables: p.tables.filter((t) => t.id !== table.id) }));
      onClose();
    }
  };

  return html`<${Sheet} open=${open} onClose=${onClose} title=${`Стол ${live.number}`}>
    <div class="stack">
      <div class="qr-box">
        <img src=${qrSrc(url)} alt=${`QR-код стола ${live.number}`} />
        <div class="url-row"><input class="input" readonly value=${url} aria-label="Ссылка на стол" onFocus=${(e) => e.currentTarget.select()} /><button class="btn btn-quiet" onClick=${() => copy(url)} aria-label="Скопировать"><${Icon} name="copy" size=20 /></button></div>
        <div class="row" style="flex-wrap:wrap;justify-content:center;gap:8px">
          <button class="btn btn-sm" onClick=${() => onPrint([live])}><${Icon} name="print" size=16 />Печать таблички</button>
          <a class="btn btn-sm btn-quiet" href=${qrSrc(url)} download=${`стол-${live.number}.svg`}>Скачать QR</a>
          <a class="btn btn-sm btn-ghost" href=${url} target="_blank" rel="noopener">Открыть как гость</a>
        </div>
      </div>
      <div class="kv">
        <${Field} label="Номер стола" id="t-num"><input id="t-num" class="input" maxlength="6" value=${f.number} onInput=${(e) => setF({ ...f, number: e.currentTarget.value })} onBlur=${() => f.number.trim() && f.number !== live.number && save({ number: f.number }, 'Номер сохранён')} /><//>
        <${Field} label="Зал" id="t-hall"><select id="t-hall" class="select" value=${f.hallId} onChange=${(e) => (setF({ ...f, hallId: e.currentTarget.value }), save({ hallId: e.currentTarget.value }, 'Зал изменён'))}>${data.halls.map((h) => html`<option key=${h.id} value=${h.id}>${h.name}</option>`)}</select><//>
      </div>
      <${Field} label="Меню на этом столе" id="t-menu" hint="Разные QR-коды могут открывать разные наборы разделов, например детское меню в детской зоне."><select id="t-menu" class="select" value=${f.menuId} onChange=${(e) => (setF({ ...f, menuId: e.currentTarget.value }), save({ menuId: e.currentTarget.value }, 'Меню стола изменено'))}>${data.menus.map((m) => html`<option key=${m.id} value=${m.id}>${m.name}</option>`)}</select><//>
      <div class="row" style="flex-wrap:wrap;gap:8px"><button class="btn btn-ghost" onClick=${regen}><${Icon} name="refresh" size=20 />Выпустить новый QR-код</button><button class="btn btn-danger" onClick=${remove}><${Icon} name="trash" size=20 />Удалить стол</button></div>
    </div>
  <//>`;
}

function BulkTables({ open, onClose, data, setData }) {
  const last = Math.max(0, ...data.tables.map((t) => parseInt(t.number, 10) || 0));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [hallId, setHallId] = useState('');
  const [menuId, setMenuId] = useState('main');
  useEffect(() => {
    if (open) {
      setFrom(String(last + 1));
      setTo(String(last + 1));
      setHallId(data.halls[0]?.id || '');
    }
  }, [open]);
  const go = async () => {
    const r = await run(() => api.post('/api/admin/tables/bulk', { from: Number(from), to: Number(to), hallId, menuId }));
    if (r) {
      toast(r.created ? `Добавлено столов: ${r.created}` : 'Такие столы уже есть');
      window.dispatchEvent(new CustomEvent('admin:refresh'));
      onClose();
    }
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="Добавить столы" footer=${html`<button class="btn btn-lg" onClick=${go}>Добавить</button>`}>
    <div class="stack">
      <div class="kv">
        <${Field} label="С номера" id="bt-from"><input id="bt-from" class="input" type="number" min="1" value=${from} onInput=${(e) => setFrom(e.currentTarget.value)} /><//>
        <${Field} label="По номер" id="bt-to"><input id="bt-to" class="input" type="number" min="1" value=${to} onInput=${(e) => setTo(e.currentTarget.value)} /><//>
      </div>
      <${Field} label="Зал" id="bt-hall"><select id="bt-hall" class="select" value=${hallId} onChange=${(e) => setHallId(e.currentTarget.value)}>${data.halls.map((h) => html`<option key=${h.id} value=${h.id}>${h.name}</option>`)}</select><//>
      <${Field} label="Меню" id="bt-menu"><select id="bt-menu" class="select" value=${menuId} onChange=${(e) => setMenuId(e.currentTarget.value)}>${data.menus.map((m) => html`<option key=${m.id} value=${m.id}>${m.name}</option>`)}</select><//>
      <p class="muted" style="font-size:14px">Для каждого стола создастся свой QR-код. Уже существующие номера пропускаются.</p>
    </div>
  <//>`;
}

/* ───────── залы ───────── */

function HallsSheet({ open, onClose, data, setData }) {
  const [name, setName] = useState('');
  const [seats, setSeats] = useState('');

  const upd = async (h, patch) => {
    const r = await run(() => api.put(`/api/admin/halls/${h.id}`, patch), 'Сохранено');
    if (r) setData((p) => ({ ...p, halls: p.halls.map((x) => (x.id === h.id ? r.hall : x)) }));
  };
  const add = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post('/api/admin/halls', { name, seats: Number(seats) || 0 }), 'Зал добавлен');
    if (r) {
      setData((p) => ({ ...p, halls: [...p.halls, r.hall] }));
      setName('');
      setSeats('');
    }
  };
  const del = async (h) => {
    if (!(await askConfirm({ title: `Удалить зал «${h.name}»?`, okLabel: 'Удалить', danger: true }))) return;
    const r = await run(() => api.del(`/api/admin/halls/${h.id}`), 'Зал удалён');
    if (r) setData((p) => ({ ...p, halls: p.halls.filter((x) => x.id !== h.id) }));
  };

  return html`<${Sheet} open=${open} onClose=${onClose} title="Залы">
    <div class="stack">
      ${data.halls.map(
        (h) => html`<div class="row" key=${h.id}>
          <input class="input" style="flex:1" defaultValue=${h.name} aria-label="Название зала" onBlur=${(e) => e.currentTarget.value.trim() && e.currentTarget.value !== h.name && upd(h, { name: e.currentTarget.value })} />
          <input class="input" style="width:92px" type="number" min="0" defaultValue=${h.seats} aria-label="Вместимость" onBlur=${(e) => Number(e.currentTarget.value) !== h.seats && upd(h, { seats: Number(e.currentTarget.value) })} />
          <button class="icon-btn" aria-label=${`Удалить зал ${h.name}`} onClick=${() => del(h)}><${Icon} name="trash" size=20 /></button>
        </div>`,
      )}
      <p class="faint" style="font-size:13px">Название и вместимость гостей. Удалить можно только зал без столов.</p>
      <form class="row" onSubmit=${add}>
        <input class="input" style="flex:1" placeholder="Новый зал" value=${name} onInput=${(e) => setName(e.currentTarget.value)} aria-label="Название нового зала" />
        <input class="input" style="width:92px" type="number" min="0" placeholder="мест" value=${seats} onInput=${(e) => setSeats(e.currentTarget.value)} aria-label="Вместимость" />
        <button class="btn" type="submit"><${Icon} name="plus" size=20 /></button>
      </form>
    </div>
  <//>`;
}

/* ───────── наборы меню ───────── */

function MenusSheet({ open, onClose, data, setData }) {
  const [menus, setMenus] = useState([]);
  const cats = sortedCats(data);
  useEffect(() => {
    if (open) setMenus(JSON.parse(JSON.stringify(data.menus)));
  }, [open]);

  const upd = (i, patch) => setMenus((m) => m.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const toggleCat = (i, id) => {
    const cur = menus[i].categoryIds || cats.map((c) => c.id);
    upd(i, { categoryIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };

  const save = async () => {
    const r = await run(() => api.put('/api/admin/menus', { menus }), 'Наборы меню сохранены');
    if (r) {
      setData((p) => ({ ...p, menus: r.menus, tables: p.tables.map((t) => (r.menus.some((m) => m.id === t.menuId) ? t : { ...t, menuId: 'main' })) }));
      onClose();
    }
  };

  return html`<${Sheet} open=${open} onClose=${onClose} title="Наборы меню" class="wide" footer=${html`<button class="btn btn-lg" onClick=${save}>Сохранить</button>`}>
    <div class="stack">
      <p class="muted">Набор — это список разделов. Назначьте его столу, и гости с этим QR-кодом увидят только выбранные разделы. «Основное меню» показывает всё.</p>
      ${menus.map(
        (m, i) => html`<div class="panel" key=${m.id}>
          <div class="row"><input class="input" style="flex:1" value=${m.name} onInput=${(e) => upd(i, { name: e.currentTarget.value })} aria-label="Название набора" disabled=${m.id === 'main'} />
            ${m.id !== 'main' && html`<button class="icon-btn" aria-label="Удалить набор" onClick=${() => setMenus(menus.filter((_, k) => k !== i))}><${Icon} name="trash" size=20 /></button>`}</div>
          ${m.id === 'main'
            ? html`<p class="muted" style="font-size:14px">Все разделы меню.</p>`
            : html`<div class="who-grid" style="display:flex;flex-wrap:wrap;gap:8px">${cats.map((c) => html`<button key=${c.id} class="chip" aria-pressed=${(m.categoryIds || cats.map((x) => x.id)).includes(c.id)} onClick=${() => toggleCat(i, c.id)}>${c.name}</button>`)}</div>`}
        </div>`,
      )}
      <button class="btn btn-ghost" onClick=${() => setMenus([...menus, { id: 'm' + Math.random().toString(36).slice(2, 7), name: 'Новый набор', categoryIds: [] }])}><${Icon} name="plus" size=20 />Новый набор</button>
    </div>
  <//>`;
}

/* ───────── печать табличек ───────── */

/** Скрытая область для печати: показывается только в @media print */
export function PrintHost({ tables, data, onDone }) {
  useEffect(() => {
    if (!tables?.length) return;
    let cancelled = false;
    const after = () => onDone();
    (async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const imgs = [...document.querySelectorAll('.print-root img')];
      await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
      if (cancelled) return;
      window.addEventListener('afterprint', after, { once: true });
      window.print();
    })();
    return () => {
      cancelled = true;
      window.removeEventListener('afterprint', after);
    };
  }, [tables]);

  if (!tables?.length) return null;
  return html`<div class="print-root">
    ${tables.map((t) => {
      const hall = data.halls.find((h) => h.id === t.hallId);
      return html`<div class="tent" key=${t.id}>
        <div class="gingham-strip"></div>
        <span class="plaque">${t.number}</span>
        <h4>Стол ${t.number}</h4>
        <p>Наведите камеру телефона на код: откроется меню. Заказывайте, зовите официанта и платите прямо со стола.</p>
        <img class="qr" src=${qrSrc(tableUrl(data, t))} alt="" />
        <small>${data.settings.brand.full}${hall ? ' · ' + hall.name : ''}</small>
      </div>`;
    })}
  </div>`;
}
