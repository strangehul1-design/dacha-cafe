// Заказы: столы прямо сейчас и журнал (столы, доставка, брони, вызовы, оплата) с кнопками статусов.
import { html, useState } from '../common/lib.js';
import { Icon } from '../common/icons.js';
import { api } from '../common/api.js';
import { Avatar, cx, toast, Empty } from '../common/ui.js';
import { rub, count, ago } from '../common/format.js';
import { SHARED } from '../common/bill.js';
import { PageHead, askConfirm, run, hhmm } from './common.js';

const STATUS = {
  table: { new: ['Новый', 'badge-hot'], accepted: ['Принят', 'badge-leaf'], cancelled: ['Отменён', 'badge-danger'] },
  delivery: { new: ['Новый', 'badge-hot'], accepted: ['Принят', 'badge-primary'], onway: ['У курьера', 'badge-primary'], ready: ['Готов к выдаче', 'badge-primary'], done: ['Выполнен', 'badge-leaf'], cancelled: ['Отменён', 'badge-danger'] },
  reserve: { new: ['Новая', 'badge-hot'], confirmed: ['Подтверждена', 'badge-leaf'], declined: ['Отклонена', 'badge-danger'] },
  call: { new: ['Зовут', 'badge-hot'], ack: ['Идут', 'badge-primary'], done: ['Готово', 'badge-leaf'] },
  pay: { requested: ['Просят счёт', 'badge-hot'], ack: ['Подходят', 'badge-primary'], done: ['Оплачено', 'badge-leaf'], cancelled: ['Отменено', 'badge-danger'], replaced: ['Заменён', ''] },
};

const ACTIONS = {
  table: { acc: 'Принять', cancel: 'Отменить' },
  delivery: { acc: 'Принять', way: 'Передан курьеру', ready: 'Готов к выдаче', done: 'Выполнен', cancel: 'Отменить' },
  reserve: { ok: 'Подтвердить', no: 'Отклонить' },
  call: { go: 'Иду', done: 'Сделано' },
  pay: { go: 'Подхожу', done: 'Оплачено', cancel: 'Отменить' },
};

const TYPE_FILTERS = [
  ['all', 'Все', null],
  ['attention', 'Требуют внимания', null],
  ['table', 'Столы', ['table']],
  ['delivery', 'Доставка', ['delivery']],
  ['reserve', 'Брони', ['reserve']],
  ['service', 'Вызовы и оплата', ['call', 'pay']],
];

export const isOpenEntry = (e) => ['new', 'requested'].includes(e.status);

export function OrdersView({ feed, refreshFeed, tg, soundOn, setSoundOn }) {
  const [filter, setFilter] = useState('all');
  const list = feed.orders.filter((e) => {
    if (filter === 'all') return true;
    if (filter === 'attention') return isOpenEntry(e) || (e.tg && !e.tg.ok && e.tg.error !== 'not_configured' && ['new', 'requested'].includes(e.status));
    return TYPE_FILTERS.find((f) => f[0] === filter)[2].includes(e.type);
  });

  const act = async (e, action) => {
    if (action === 'cancel' && !(await askConfirm({ title: 'Отменить?', text: e.type === 'table' ? 'Заказ исчезнет из счёта стола.' : undefined, okLabel: 'Отменить', danger: true }))) return;
    const r = await run(() => api.post(`/api/admin/orders/${e.id}/action`, { action }));
    if (r) refreshFeed();
  };

  const resend = async (e) => {
    const r = await run(() => api.post(`/api/admin/orders/${e.id}/resend`));
    if (r) {
      toast(r.entry.tg?.ok ? 'Отправлено в Telegram' : 'Пока не получилось отправить', r.entry.tg?.ok ? 'ok' : 'err');
      refreshFeed();
    }
  };

  const closeTable = async (t) => {
    if (!(await askConfirm({ title: `Закрыть стол ${t.number}?`, text: 'Гости увидят пустой стол, их гости и счёт будут сброшены. Делайте это, когда расчёт завершён.', okLabel: 'Закрыть стол' }))) return;
    const r = await run(() => api.post(`/api/admin/sessions/${t.sessionId}/close`), `Стол ${t.number} закрыт`);
    if (r) refreshFeed();
  };

  return html`<div>
    <${PageHead} title="Заказы" text="Всё, что приходит от гостей. Те же кнопки доступны сотрудникам в Telegram.">
      <button class="chip" aria-pressed=${soundOn} onClick=${() => setSoundOn(!soundOn)}><${Icon} name="bell" size=18 />Звук: ${soundOn ? 'включён' : 'выключен'}</button>
    <//>

    ${!tg.configured && html`<div class="notice" style="margin-bottom:16px"><${Icon} name="info" /><span>Telegram не подключён, поэтому официанты не получают уведомления. Все заказы всё равно сохраняются здесь. Подключить бота: Настройки → Telegram.</span></div>`}
    ${tg.unsent > 0 && tg.configured && html`<div class="notice notice-danger" style="margin-bottom:16px"><${Icon} name="warn" /><span>${count(tg.unsent, 'запись', 'записи', 'записей')} не дошли до Telegram. Сервер пробует отправить повторно; можно нажать «Отправить снова» у записи.</span></div>`}

    <h3 style="font-size:22px;margin-bottom:12px">Столы сейчас</h3>
    ${feed.live.length === 0
      ? html`<p class="muted" style="margin-bottom:22px">Сейчас за столами с QR-меню никого нет.</p>`
      : html`<div class="live-grid">
          ${feed.live.map((t) => {
            const hot = t.calls.length > 0 || t.payment || t.newOrders > 0;
            return html`<div class=${cx('live-table', hot && 'hot')} key=${t.tableId}>
              <div class="live-head">
                <span class="plaque">${t.number}</span>
                <div><b>Стол ${t.number}</b><small>${t.hall}</small></div>
                <span class="live-total num">${rub(t.total)}</span>
              </div>
              <div class="avatars" aria-label="Гости">${t.guests.map((g, i) => html`<${Avatar} key=${i} guest=${g} size=28 />`)}</div>
              <div class="tags">
                <span class="badge">${count(t.orders, 'заказ', 'заказа', 'заказов')}</span>
                ${t.newOrders > 0 && html`<span class="badge badge-hot">новых: ${t.newOrders}</span>`}
                ${t.calls.map((c) => html`<span class="badge badge-hot" key=${c.id}><${Icon} name="bell" />${c.label}</span>`)}
                ${t.payment && html`<span class="badge badge-leaf"><${Icon} name="cash" />просят счёт · ${rub(t.payment.total)}</span>`}
                ${t.idleMin >= 1 && html`<span class="badge">${t.idleMin} мин без движения</span>`}
              </div>
              <button class="btn btn-sm btn-ghost" onClick=${() => closeTable(t)}>Закрыть стол</button>
            </div>`;
          })}
        </div>`}

    <h3 style="font-size:22px;margin-bottom:12px">Журнал</h3>
    <div class="toolbar">${TYPE_FILTERS.map(([k, label]) => html`<button key=${k} class="chip" aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${label}${k === 'attention' && feed.orders.filter(isOpenEntry).length ? html`<span class="pill">${feed.orders.filter(isOpenEntry).length}</span>` : ''}</button>`)}</div>

    ${list.length === 0 && html`<${Empty} icon="receipt" title="Здесь пока пусто" text="Заказы, брони и вызовы официанта появятся здесь сразу, как только гости их отправят." />`}
    ${list.map((e) => html`<${Entry} key=${e.id} e=${e} onAct=${act} onResend=${resend} />`)}
  </div>`;
}

function Entry({ e, onAct, onResend }) {
  const [open, setOpen] = useState(isOpenEntry(e));
  const st = STATUS[e.type]?.[e.status] || [e.status, ''];
  const labels = ACTIONS[e.type] || {};
  const day = new Date(e.createdAt).toDateString() === new Date().toDateString() ? '' : new Date(e.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ';

  let icon = 'menu';
  let cls = '';
  let title = '';
  let sub = '';
  let total = null;
  if (e.type === 'table') {
    title = `Стол ${e.tableNumber} · заказ № ${e.num}`;
    sub = `${e.hallName ? e.hallName + ' · ' : ''}${day}${hhmm(e.createdAt)}`;
    total = e.total;
  } else if (e.type === 'delivery') {
    icon = e.fulfil === 'pickup' ? 'bag2' : 'bike';
    title = `${e.fulfil === 'pickup' ? 'Самовывоз' : 'Доставка'} № ${e.num} · ${e.name}`;
    sub = `${day}${hhmm(e.createdAt)} · ${e.phone} · ${e.when === 'asap' ? 'как можно скорее' : 'к ' + e.when}`;
    total = e.total;
  } else if (e.type === 'reserve') {
    icon = 'calendar';
    title = `${e.kind === 'banquet' ? 'Банкет' : 'Бронь'} № ${e.num} · ${e.name}`;
    sub = `${day}${hhmm(e.createdAt)} · ${e.phone}`;
  } else if (e.type === 'call') {
    icon = 'bell';
    cls = 'call';
    title = `Стол ${e.tableNumber} зовёт: ${e.label}`;
    sub = `${e.hallName ? e.hallName + ' · ' : ''}${day}${hhmm(e.createdAt)}`;
  } else if (e.type === 'pay') {
    icon = 'cash';
    cls = 'pay';
    title = `Стол ${e.tableNumber} · готовы оплатить`;
    sub = `${{ cash: 'наличными', card: 'картой', sbp: 'по СБП' }[e.method]}, ${e.mode === 'split' ? 'раздельно' : 'одним чеком'} · ${day}${hhmm(e.createdAt)}`;
    total = e.total;
  }

  return html`<article class="entry">
    <div class="entry-head">
      <span class=${cx('ico', cls)}><${Icon} name=${icon} size=20 /></span>
      <div style="min-width:0"><div class="title">${title}</div><div class="sub">${sub}</div></div>
      <div class="right">
        ${total != null && html`<b class="num">${rub(total)}</b>`}
        <span class=${cx('badge', st[1])}>${st[0]}</span>
        <button class="icon-btn" style="width:38px;height:38px" aria-label=${open ? 'Свернуть' : 'Подробнее'} onClick=${() => setOpen(!open)}><${Icon} name=${open ? 'up' : 'down'} size=18 /></button>
      </div>
    </div>
    ${open && html`<div class="entry-body"><${EntryBody} e=${e} /></div>`}
    <div class="entry-actions">
      ${e.allowed.map((a) => html`<button key=${a} class=${cx('btn btn-sm', a === 'cancel' || a === 'no' ? 'btn-ghost' : a === e.allowed[0] ? '' : 'btn-quiet')} onClick=${() => onAct(e, a)}>${labels[a] || a}</button>`)}
      ${e.tg && !e.tg.ok && e.tg.error !== 'not_configured' && html`<button class="btn btn-sm btn-danger" onClick=${() => onResend(e)}><${Icon} name="refresh" size=16 />Отправить снова</button>`}
    </div>
    ${e.tg && !e.tg.ok && open && html`<div class="entry-body tg-bad">${e.tg.error === 'not_configured' ? 'В Telegram не отправлено: бот не подключён.' : `Telegram: ${e.tg.error}. Попыток: ${e.tg.attempts}.`}</div>`}
  </article>`;
}

function Lines({ lines }) {
  return lines.map((l) => html`<div class="l" key=${l.id}><span>${l.name}${l.opts?.length ? ` (${l.opts.map((o) => o.choice).join(', ')})` : ''} × ${l.qty}${l.note ? ` — «${l.note}»` : ''}</span><span class="num">${rub(l.unit * l.qty)}</span></div>`);
}

function EntryBody({ e }) {
  if (e.type === 'table') {
    const groups = new Map();
    for (const l of e.lines) {
      if (!groups.has(l.guestId)) groups.set(l.guestId, []);
      groups.get(l.guestId).push(l);
    }
    return html`${[...groups.entries()].map(
      ([gid, ls]) => html`<div key=${gid} style="display:grid;gap:3px"><b style="color:var(--ink);margin-top:6px">${gid === SHARED ? 'Общее на стол' : e.guestNames?.[gid] || 'Гость'}</b><${Lines} lines=${ls} /></div>`,
    )}${e.note && html`<div>💬 ${e.note}</div>`}`;
  }
  if (e.type === 'delivery') {
    const a = e.address;
    return html`${a && html`<div>📍 ${[`${a.street}, ${a.house}`, a.apt && `кв. ${a.apt}`, a.entrance && `подъезд ${a.entrance}`, a.floor && `этаж ${a.floor}`, a.intercom && `домофон ${a.intercom}`].filter(Boolean).join(', ')}</div>`}
      <${Lines} lines=${e.lines} />
      ${e.discount > 0 && html`<div class="l"><span>Скидка ${e.promo?.code}</span><span class="num">−${rub(e.discount)}</span></div>`}
      ${e.fulfil !== 'pickup' && html`<div class="l"><span>Доставка</span><span>${e.fee ? rub(e.fee) : 'бесплатно'}</span></div>`}
      <div>Оплата: ${{ cash: 'наличными', card: 'картой', sbp: 'по СБП' }[e.payment]}${e.changeFrom ? `, сдача с ${rub(e.changeFrom)}` : ''}</div>
      ${e.comment && html`<div>💬 ${e.comment}</div>`}`;
  }
  if (e.type === 'reserve') {
    return html`<div>${new Date(e.date + 'T12:00:00Z').toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })}, ${e.time}</div>
      <div>${count(e.guests, 'гость', 'гостя', 'гостей')}${e.hallName ? ' · ' + e.hallName : ''}</div>${e.comment && html`<div>💬 ${e.comment}</div>`}`;
  }
  if (e.type === 'pay') {
    return html`<div>${e.mode === 'split' ? `Раздельно, гостей: ${e.guestIds.length}` : 'Одним чеком'}${e.tip ? ` · чаевые ${e.tipPct}% (${rub(e.tip)})` : ''}</div>`;
  }
  return html`<div>${e.label}${e.note ? ' — ' + e.note : ''}</div>`;
}
