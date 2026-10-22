// Настройки: контакты, часы, доставка, оплата, промокоды, Telegram, пароли, банкеты, юридический текст.
import { html, useState, useEffect } from '../common/lib.js';
import { Icon } from '../common/icons.js';
import { api } from '../common/api.js';
import { cx, toast } from '../common/ui.js';
import { count } from '../common/format.js';
import { DAY_LABELS, WEEK_ORDER } from '../common/hours.js';
import { Switch, Field, Toggle, PageHead, askConfirm, run } from './common.js';

const TIMEZONES = ['Asia/Yekaterinburg', 'Europe/Moscow', 'Asia/Omsk', 'Asia/Novosibirsk', 'Asia/Krasnoyarsk', 'Europe/Samara', 'Asia/Irkutsk', 'Asia/Vladivostok', 'Europe/Kaliningrad'];

function Section({ title, text, children, onSave, busy, saveLabel = 'Сохранить' }) {
  return html`<section class="panel">
    <div><h3>${title}</h3>${text && html`<p class="muted" style="margin-top:4px;font-size:14.5px">${text}</p>`}</div>
    ${children}
    ${onSave && html`<div><button class="btn" disabled=${busy} onClick=${onSave}>${busy ? 'Сохраняем…' : saveLabel}</button></div>`}
  </section>`;
}

export function SettingsView({ data, setData, refresh }) {
  const s = data.settings;
  const save = async (patch, ok = 'Сохранено') => {
    const r = await run(() => api.put('/api/admin/settings', patch), ok);
    if (r) setData((p) => ({ ...p, settings: r.settings }));
    return !!r;
  };

  return html`<div class="stack" style="gap:16px">
    <${PageHead} title="Настройки" text="Контакты, часы работы, доставка, оплата и подключение Telegram." />
    <${TelegramSection} data=${data} save=${save} refresh=${refresh} />
    <${ContactsSection} s=${s} save=${save} />
    <${HoursSection} s=${s} save=${save} />
    <${DeliverySection} s=${s} save=${save} />
    <${PaymentsSection} s=${s} save=${save} />
    <${PromosSection} data=${data} setData=${setData} />
    <${BanquetSection} s=${s} save=${save} />
    <${LegalSection} s=${s} save=${save} />
    <${AccessSection} />
  </div>`;
}

/* ───────── Telegram ───────── */

function TelegramSection({ data, save, refresh }) {
  const t = data.settings.telegram;
  const [f, setF] = useState({ token: '', chatId: t.chatId, deliveryChatId: t.deliveryChatId });
  const [busy, setBusy] = useState(false);
  useEffect(() => setF((p) => ({ ...p, chatId: t.chatId, deliveryChatId: t.deliveryChatId })), [t.chatId, t.deliveryChatId]);

  const apply = async () => {
    setBusy(true);
    const ok = await save({ telegram: { token: f.token, chatId: f.chatId, deliveryChatId: f.deliveryChatId } }, 'Настройки Telegram сохранены');
    if (ok) setF((p) => ({ ...p, token: '' }));
    setBusy(false);
    refresh();
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/admin/telegram/test');
      toast(`Бот @${r.bot} на связи, тестовое сообщение отправлено`);
    } catch (e) {
      toast(e.message, 'err');
    }
    setBusy(false);
  };

  const resend = async () => {
    const r = await run(() => api.post('/api/admin/telegram/resend'));
    if (r) {
      toast(r.total ? `Отправлено ${r.ok} из ${r.total}` : 'Неотправленных записей нет');
      refresh();
    }
  };

  const clearToken = async () => {
    if (!(await askConfirm({ title: 'Отключить бота?', text: 'Уведомления в Telegram прекратятся. Заказы по-прежнему будут сохраняться в админке.', okLabel: 'Отключить', danger: true }))) return;
    await save({ telegram: { clearToken: true, chatId: f.chatId, deliveryChatId: f.deliveryChatId } }, 'Бот отключён');
    refresh();
  };

  return html`<${Section} title="Telegram" text="Сюда приходят заказы со столов, доставка, брони, вызовы официанта и запросы оплаты." onSave=${apply} busy=${busy}>
    <div class=${cx('notice', data.telegram.configured ? 'notice-ok' : '')}><${Icon} name=${data.telegram.configured ? 'check' : 'info'} /><span>${data.telegram.configured ? `Подключено${data.telegram.bot ? `: @${data.telegram.bot}` : ''}. ${data.telegram.pollError ? 'Но есть ошибка связи: ' + data.telegram.pollError : 'Кнопки в сообщениях работают.'}` : 'Пока не подключено. Следуйте шагам ниже — это займёт пять минут.'}</span></div>
    <div class="guide">
      <ol>
        <li>В Telegram откройте <b>@BotFather</b>, отправьте <code>/newbot</code>, придумайте имя и скопируйте токен.</li>
        <li>Создайте группу для персонала (официанты, бар, кухня) и добавьте в неё бота.</li>
        <li>Напишите в группе <code>/id</code> — бот ответит номером чата. Вставьте его ниже.</li>
        <li>Нажмите «Сохранить», затем «Проверить»: в группе появится тестовое сообщение.</li>
      </ol>
    </div>
    <${Field} label=${t.tokenSet ? `Токен бота (сейчас сохранён ${t.tokenHint})` : 'Токен бота'} id="tg-token" hint="Хранится на сервере и никогда не показывается гостям. Оставьте пустым, чтобы не менять."><input id="tg-token" class="input" type="password" autocomplete="off" placeholder=${t.tokenSet ? 'введите новый, чтобы заменить' : '123456789:AA…'} value=${f.token} onInput=${(e) => setF({ ...f, token: e.currentTarget.value })} /><//>
    <div class="kv">
      <${Field} label="Чат персонала" id="tg-chat" hint="Число вида -1001234567890"><input id="tg-chat" class="input" inputmode="numeric" value=${f.chatId} onInput=${(e) => setF({ ...f, chatId: e.currentTarget.value })} /><//>
      <${Field} label="Чат доставки (необязательно)" id="tg-dchat" hint="Если пусто — доставка приходит в чат персонала"><input id="tg-dchat" class="input" inputmode="numeric" value=${f.deliveryChatId} onInput=${(e) => setF({ ...f, deliveryChatId: e.currentTarget.value })} /><//>
    </div>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <button class="btn btn-quiet" disabled=${busy || !t.tokenSet} onClick=${test}><${Icon} name="send" size=18 />Проверить</button>
      ${data.telegram.unsent > 0 && data.telegram.configured && html`<button class="btn btn-quiet" onClick=${resend}><${Icon} name="refresh" size=18 />Отправить неотправленное (${data.telegram.unsent})</button>`}
      ${t.tokenSet && html`<button class="btn btn-ghost" onClick=${clearToken}>Отключить бота</button>`}
    </div>
  <//>`;
}

/* ───────── контакты ───────── */

function ContactsSection({ s, save }) {
  const [b, setB] = useState(s.brand);
  const [c, setC] = useState(s.contacts);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await save({ brand: b, contacts: c });
    setBusy(false);
  };
  return html`<${Section} title="Кафе и контакты" onSave=${go} busy=${busy}>
    <div class="kv">
      <${Field} label="Короткое название" id="s-name"><input id="s-name" class="input" maxlength="40" value=${b.name} onInput=${(e) => setB({ ...b, name: e.currentTarget.value })} /><//>
      <${Field} label="Полное название" id="s-full"><input id="s-full" class="input" maxlength="80" value=${b.full} onInput=${(e) => setB({ ...b, full: e.currentTarget.value })} /><//>
    </div>
    <${Field} label="Слоган" id="s-tag"><input id="s-tag" class="input" maxlength="100" value=${b.tagline} onInput=${(e) => setB({ ...b, tagline: e.currentTarget.value })} /><//>
    <div class="kv">
      <${Field} label="Адрес" id="s-addr"><input id="s-addr" class="input" value=${c.address} onInput=${(e) => setC({ ...c, address: e.currentTarget.value })} /><//>
      <${Field} label="Где находится" id="s-place"><input id="s-place" class="input" value=${c.place} onInput=${(e) => setC({ ...c, place: e.currentTarget.value })} /><//>
      <${Field} label="Телефон" id="s-ph"><input id="s-ph" class="input" type="tel" value=${c.phone} onInput=${(e) => setC({ ...c, phone: e.currentTarget.value })} /><//>
      <${Field} label="Второй телефон" id="s-ph2"><input id="s-ph2" class="input" type="tel" value=${c.phone2} onInput=${(e) => setC({ ...c, phone2: e.currentTarget.value })} /><//>
      <${Field} label="Почта" id="s-mail"><input id="s-mail" class="input" type="email" value=${c.email} onInput=${(e) => setC({ ...c, email: e.currentTarget.value })} /><//>
      <${Field} label="Ссылка ВКонтакте" id="s-vk"><input id="s-vk" class="input" value=${c.vk} onInput=${(e) => setC({ ...c, vk: e.currentTarget.value })} /><//>
    </div>
  <//>`;
}

/* ───────── часы ───────── */

function HoursSection({ s, save }) {
  const [h, setH] = useState(s.hours);
  const [tz, setTz] = useState(s.timezone);
  const [busy, setBusy] = useState(false);
  const set = (k, i, v) => setH((p) => ({ ...p, [k]: [...(p[k] || ['11:00', '23:00'])].map((x, j) => (j === i ? v : x)) }));
  const go = async () => {
    setBusy(true);
    await save({ hours: h, timezone: tz });
    setBusy(false);
  };
  return html`<${Section} title="Часы работы" text="Если закрытие раньше открытия (например, до 03:00) — это работа после полуночи. От часов зависит приём заказов на доставку." onSave=${go} busy=${busy}>
    <div class="hours-edit">
      ${WEEK_ORDER.map((k) => {
        const closed = !h[k];
        return html`<div class="hrow" key=${k}>
          <b>${DAY_LABELS[k]}</b>
          <input class="input" type="time" disabled=${closed} value=${h[k]?.[0] || ''} onInput=${(e) => set(k, 0, e.currentTarget.value)} aria-label=${`${DAY_LABELS[k]}: открытие`} />
          <input class="input" type="time" disabled=${closed} value=${h[k]?.[1] || ''} onInput=${(e) => set(k, 1, e.currentTarget.value)} aria-label=${`${DAY_LABELS[k]}: закрытие`} />
          <${Toggle} checked=${closed} onChange=${(v) => setH((p) => ({ ...p, [k]: v ? null : ['11:00', '23:00'] }))}>выходной<//>
        </div>`;
      })}
    </div>
    <${Field} label="Часовой пояс" id="s-tz"><select id="s-tz" class="select" value=${tz} onChange=${(e) => setTz(e.currentTarget.value)}>${TIMEZONES.map((z) => html`<option key=${z} value=${z}>${z}</option>`)}</select><//>
  <//>`;
}

/* ───────── доставка ───────── */

function DeliverySection({ s, save }) {
  const [d, setD] = useState(s.delivery);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setD((p) => ({ ...p, [k]: v }));
  const go = async () => {
    setBusy(true);
    await save({ delivery: d });
    setBusy(false);
  };
  return html`<${Section} title="Доставка и самовывоз" onSave=${go} busy=${busy}>
    <div class="row" style="justify-content:space-between"><span><b>Принимать заказы на доставку</b><br /><span class="muted" style="font-size:14px">Выключите, если курьеров нет или кухня не справляется. Сайт покажет гостям телефон.</span></span><${Switch} checked=${d.enabled} onChange=${(v) => set('enabled', v)} label="Принимать заказы на доставку" /></div>
    <div class="row" style="justify-content:space-between"><span><b>Самовывоз</b></span><${Switch} checked=${d.pickupEnabled} onChange=${(v) => set('pickupEnabled', v)} label="Самовывоз" /></div>
    <div class="kv">
      <${Field} label="Бесплатная доставка от, ₽" id="d-free"><input id="d-free" class="input" type="number" min="0" value=${d.freeFrom} onInput=${(e) => set('freeFrom', e.currentTarget.value)} /><//>
      <${Field} label="Стоимость доставки ниже этой суммы, ₽" id="d-fee" hint="Проверьте: стоит значение для примера"><input id="d-fee" class="input" type="number" min="0" value=${d.fee} onInput=${(e) => set('fee', e.currentTarget.value)} /><//>
      <${Field} label="Минимальный заказ, ₽" id="d-min"><input id="d-min" class="input" type="number" min="0" value=${d.minOrder} onInput=${(e) => set('minOrder', e.currentTarget.value)} /><//>
      <${Field} label="Время доставки" id="d-eta" hint="Показывается гостям"><input id="d-eta" class="input" value=${d.eta} onInput=${(e) => set('eta', e.currentTarget.value)} /><//>
      <${Field} label="Не принимать за … минут до закрытия" id="d-stop"><input id="d-stop" class="input" type="number" min="0" value=${d.stopBeforeCloseMin} onInput=${(e) => set('stopBeforeCloseMin', e.currentTarget.value)} /><//>
      <${Field} label="Зона доставки" id="d-area"><input id="d-area" class="input" value=${d.area} onInput=${(e) => set('area', e.currentTarget.value)} /><//>
    </div>
  <//>`;
}

/* ───────── оплата ───────── */

function PaymentsSection({ s, save }) {
  const [p, setP] = useState(s.payments);
  const [tips, setTips] = useState(s.tips);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await save({ payments: p, tips });
    setBusy(false);
  };
  const toggleTip = (n) => setTips((t) => (t.includes(n) ? t.filter((x) => x !== n) : [...t, n].sort((a, b) => a - b)));
  return html`<${Section} title="Способы оплаты и чаевые" text="Оплата принимается официантом или курьером: сайт не списывает деньги, он только передаёт выбор гостя." onSave=${go} busy=${busy}>
    <div class="row" style="flex-wrap:wrap;gap:8px 24px">
      <${Toggle} checked=${p.cash} onChange=${(v) => setP({ ...p, cash: v })}>Наличными<//>
      <${Toggle} checked=${p.card} onChange=${(v) => setP({ ...p, card: v })}>Картой<//>
      <${Toggle} checked=${p.sbp} onChange=${(v) => setP({ ...p, sbp: v })}>По СБП<//>
    </div>
    <div class="field"><span class="label">Варианты чаевых за столом</span>
      <div class="row" style="flex-wrap:wrap;gap:8px">${[5, 10, 15, 20].map((n) => html`<button key=${n} class="chip" aria-pressed=${tips.includes(n)} onClick=${() => toggleTip(n)}>${n}%</button>`)}</div>
      <span class="hint">Выключите все, если чаевые не нужны — кнопки у гостей не появятся.</span>
    </div>
  <//>`;
}

/* ───────── промокоды ───────── */

function PromosSection({ data, setData }) {
  const [list, setList] = useState(data.promos);
  const [busy, setBusy] = useState(false);
  useEffect(() => setList(data.promos), [data.promos]);
  const upd = (i, patch) => setList((l) => l.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const go = async () => {
    setBusy(true);
    const r = await run(() => api.put('/api/admin/promos', { promos: list }), 'Промокоды сохранены');
    if (r) setData((p) => ({ ...p, promos: r.promos }));
    setBusy(false);
  };
  return html`<${Section} title="Промокоды" text="Скидка в процентах на блюда в заказе доставки. Доставка не удешевляется." onSave=${go} busy=${busy}>
    ${list.length === 0 && html`<p class="muted">Промокодов пока нет.</p>`}
    ${list.map((p, i) => html`<div class="promo-edit" key=${i}>
      <input class="input" placeholder="КОД" value=${p.code} onInput=${(e) => upd(i, { code: e.currentTarget.value.toUpperCase() })} aria-label="Промокод" />
      <input class="input" type="number" min="1" max="90" value=${p.percent} onInput=${(e) => upd(i, { percent: Number(e.currentTarget.value) })} aria-label="Скидка, %" />
      <${Switch} small checked=${p.active} onChange=${(v) => upd(i, { active: v })} label=${`Промокод ${p.code} действует`} />
      <button class="icon-btn" aria-label="Удалить промокод" onClick=${() => setList(list.filter((_, k) => k !== i))}><${Icon} name="trash" size=20 /></button>
      ${p.note && html`<span class="note faint" style="font-size:13px">${p.note}</span>`}
    </div>`)}
    <button class="btn btn-sm btn-ghost" style="justify-self:start" onClick=${() => setList([...list, { code: '', percent: 10, active: true, note: '' }])}><${Icon} name="plus" size=16 />Промокод</button>
  <//>`;
}

/* ───────── банкеты ───────── */

function BanquetSection({ s, save }) {
  const [list, setList] = useState(s.banquet.map((b) => ({ name: b.name, prices: b.prices.join(', ') })));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await save({ banquet: list.map((b) => ({ name: b.name, prices: b.prices.split(/[,\s]+/).map(Number).filter((n) => n > 0) })) });
    setBusy(false);
  };
  return html`<${Section} title="Банкетные меню" text="Названия и цены, которые видят гости на сайте. Цены через запятую." onSave=${go} busy=${busy}>
    ${list.map((b, i) => html`<div class="kv" key=${i}>
      <input class="input" value=${b.name} aria-label="Название" onInput=${(e) => setList(list.map((x, k) => (k === i ? { ...x, name: e.currentTarget.value } : x)))} />
      <input class="input" value=${b.prices} placeholder="1900, 2200, 2500" aria-label="Цены" onInput=${(e) => setList(list.map((x, k) => (k === i ? { ...x, prices: e.currentTarget.value } : x)))} />
    </div>`)}
    <button class="btn btn-sm btn-ghost" style="justify-self:start" onClick=${() => setList([...list, { name: '', prices: '' }])}><${Icon} name="plus" size=16 />Меню</button>
  <//>`;
}

/* ───────── юридический текст ───────── */

function LegalSection({ s, save }) {
  const [t, setT] = useState(s.legal);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await save({ legal: t });
    setBusy(false);
  };
  return html`<${Section} title="Политика конфиденциальности" text="Сайт собирает имя, телефон и адрес гостей — нужна политика обработки данных. Вставьте текст вашей организации (ИП или ООО с реквизитами). Пока поле пустое, показывается краткий типовой текст." onSave=${go} busy=${busy}>
    <textarea class="textarea" rows="8" value=${t} onInput=${(e) => setT(e.currentTarget.value)} aria-label="Текст политики"></textarea>
  <//>`;
}

/* ───────── доступ ───────── */

function AccessSection() {
  const [admin, setAdmin] = useState('');
  const [kitchen, setKitchen] = useState('');
  const setPw = async (role, password, clear) => {
    const r = await run(() => api.post('/api/admin/password', { role, password }), role === 'admin' ? 'Пароль администратора изменён' : 'Пароль повара сохранён');
    if (r) clear('');
  };
  const removeKitchen = async () => {
    if (!(await askConfirm({ title: 'Закрыть доступ повару?', text: 'Вход по паролю повара перестанет работать.', okLabel: 'Закрыть доступ', danger: true }))) return;
    await run(() => api.post('/api/admin/password/kitchen/remove'), 'Доступ повара закрыт');
  };
  return html`<${Section} title="Пароли" text="Администратор видит всё. Повар входит по своему паролю и видит только стоп-лист — удобно отметить закончившееся с телефона.">
    <div class="kv">
      <div class="field"><label for="pw-a">Новый пароль администратора</label><div class="row"><input id="pw-a" class="input" type="password" autocomplete="new-password" minlength="6" value=${admin} onInput=${(e) => setAdmin(e.currentTarget.value)} /><button class="btn btn-quiet" disabled=${admin.length < 6} onClick=${() => setPw('admin', admin, setAdmin)}>Сменить</button></div><span class="hint">Минимум 6 символов</span></div>
      <div class="field"><label for="pw-k">Пароль повара</label><div class="row"><input id="pw-k" class="input" type="password" autocomplete="new-password" minlength="6" value=${kitchen} onInput=${(e) => setKitchen(e.currentTarget.value)} /><button class="btn btn-quiet" disabled=${kitchen.length < 6} onClick=${() => setPw('kitchen', kitchen, setKitchen)}>Задать</button></div><button class="btn btn-sm btn-ghost" style="justify-self:start" onClick=${removeKitchen}>Закрыть доступ повару</button></div>
    </div>
  <//>`;
}
