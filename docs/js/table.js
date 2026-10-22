// QR-меню на столе: гости, заказ по гостям, счёт, «Готовы оплатить», вызов официанта.
import { html, render, useState, useEffect, useMemo, useRef, useCallback } from './common/lib.js';
import { api } from './common/api.js';
import { Icon } from './common/icons.js';
import { Sheet, Stepper, Avatar, Plaque, Toasts, toast, Empty, usePolling, useStored, cx, Fragment } from './common/ui.js';
import { rub, num, count, plural } from './common/format.js';
import { SHARED, tipOf } from './common/bill.js';
import { useMenu, useCart, indexMenu, unitPrice, optionLabels, needsChoice, cartSummary, lineKey } from './common/menu-core.js';
import { MenuView, DishSheet, WhoPicker } from './common/menu-ui.js';

// /t/<код> на сервере; в демо для GitHub Pages — table.html?t=<номер>
const code = new URLSearchParams(location.search).get('t') || location.pathname.split('/').filter(Boolean)[1] || '';

const STATUS = {
  new: { text: 'Отправлен официанту', tone: 'badge-primary' },
  accepted: { text: 'Принят', tone: 'badge-leaf' },
  cancelled: { text: 'Отменён', tone: 'badge-danger' },
};

const CALL_ICONS = { waiter: 'hand', bill: 'receipt', cutlery: 'menu', clean: 'broom', kids: 'chair', other: 'info' };
const METHODS = {
  cash: { label: 'Наличными', icon: 'cash' },
  card: { label: 'Картой', icon: 'card' },
  sbp: { label: 'По СБП', icon: 'qr' },
};

const hhmm = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const newKey = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function App() {
  const [info, setInfo] = useState(null);
  const [fatal, setFatal] = useState('');
  const { menu, error: menuError, reload: reloadMenu } = useMenu(`mode=table&table=${code}`);
  const index = useMemo(() => indexMenu(menu), [menu]);
  const cart = useCart('dacha:cart:' + code);
  const [dev, setDev] = useStored('dacha:dev:' + code, { sessionId: null, guestIds: [], active: null });
  const [tab, setTab] = useState('menu');
  useEffect(() => {
    // при смене вкладки всегда показываем её с начала, без плавной прокрутки
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [tab]);
  const [layout, setLayout] = useStored('dacha:layout', 'list');
  const [introSeen, setIntroSeen] = useStored('dacha:intro', false);
  const [open, setOpen] = useState({});
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [dishItem, setDishItem] = useState(null);
  const [whoLine, setWhoLine] = useState(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sentResult, setSentResult] = useState(null);
  const sendKey = useRef(null);

  const show = (name) => setOpen((o) => ({ ...o, [name]: true }));
  const hide = (name) => setOpen((o) => ({ ...o, [name]: false }));

  /* ───────── сервер ───────── */

  const refresh = useCallback(async () => {
    try {
      setInfo(await api.get('/api/table/' + code));
    } catch (e) {
      if (e.status === 404) setFatal(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, []);
  usePolling(refresh, tab === 'bill' || open.pay || open.waiter ? 4000 : 8000, [tab, open.pay, open.waiter]);

  const session = info?.session;
  const guests = session?.guests || [];
  const own = guests.filter((g) => dev.guestIds.includes(g.id));
  const activeId = guests.some((g) => g.id === dev.active) ? dev.active : own[0]?.id || null;
  const activeGuest = guests.find((g) => g.id === activeId) || null;

  // Стол закрыли (оплатили) — гости и черновик заказа начинаются заново
  useEffect(() => {
    if (!info) return;
    const sid = info.session.id;
    if (dev.sessionId && sid !== dev.sessionId) {
      setDev({ sessionId: sid, guestIds: [], active: null });
      cart.clear();
      setNote('');
      setWelcomeDismissed(false);
    } else if (!dev.sessionId && sid && own.length === 0) {
      setDev((d) => ({ ...d, sessionId: sid }));
    }
  }, [info?.session.id]);

  // В черновике не должно быть блюд для гостей, которых уже нет за столом
  useEffect(() => {
    if (!session || !session.id) return;
    const ids = new Set(guests.map((g) => g.id));
    if (cart.lines.some((l) => l.guestId !== SHARED && !ids.has(l.guestId))) cart.dropWhere((l) => l.guestId !== SHARED && !ids.has(l.guestId));
  }, [session?.id, guests.length]);

  // Первый заход: представиться
  useEffect(() => {
    if (info && own.length === 0 && !welcomeDismissed && !open.welcome) show('welcome');
  }, [info?.session.id, own.length, !!info]);

  const addGuest = async (name) => {
    const r = await api.post(`/api/table/${code}/guests`, { name });
    setInfo((p) => ({ ...p, session: r.session }));
    setDev((d) => ({ sessionId: r.session.id, guestIds: [...(d.sessionId === r.session.id ? d.guestIds : []), r.guest.id], active: r.guest.id }));
    return r.guest;
  };

  const claimGuest = (id) => {
    setDev((d) => ({ sessionId: session.id, guestIds: [...new Set([...(d.sessionId === session.id ? d.guestIds : []), id])], active: id }));
  };

  /* ───────── меню → черновик ───────── */

  const qtyFor = (item) => cart.lines.filter((l) => l.dishId === item.id && l.guestId === activeId).reduce((s, l) => s + l.qty, 0);
  const totalQtyFor = (item) => cart.lines.filter((l) => l.dishId === item.id).reduce((s, l) => s + l.qty, 0);

  const needGuest = () => {
    if (activeId) return false;
    setWelcomeDismissed(false);
    show('welcome');
    return true;
  };

  const openDish = (item) => {
    if (needGuest()) return;
    setDishItem(item);
    show('dish');
  };

  const quickAdd = (item) => {
    if (needGuest()) return;
    if (needsChoice(item)) return openDish(item);
    cart.add({ dishId: item.id, guestId: activeId, qty: 1, options: {} });
    if (guests.length > 1) toast(`${activeGuest?.name}: ${item.name}`);
  };

  const decItem = (item) => {
    const ls = cart.lines.filter((l) => l.dishId === item.id && l.guestId === activeId);
    const l = ls[ls.length - 1];
    if (l) cart.setQty(lineKey(l), l.qty - 1);
  };

  const submitDish = (payload) => {
    cart.add(payload);
    hide('dish');
    if (payload.guestId === SHARED) toast(`Общее на стол: ${dishItem.name}`);
    else if (guests.length > 1) toast(`${guests.find((g) => g.id === payload.guestId)?.name}: ${dishItem.name}`);
    else toast(`Добавлено: ${dishItem.name}`);
  };

  const summary = cartSummary(cart.lines, index);
  const badLines = cart.lines.filter((l) => {
    const e = index.get(l.dishId);
    return !e || e.item.stop || !e.cat.available;
  });

  /* ───────── отправка заказа ───────── */

  useEffect(() => {
    sendKey.current = null;
  }, [JSON.stringify(cart.lines), note]);

  const send = async () => {
    if (sending || !cart.lines.length) return;
    setSending(true);
    try {
      sendKey.current ||= newKey();
      const r = await api.post(`/api/table/${code}/order`, {
        key: sendKey.current,
        note,
        lines: cart.lines.map(({ dishId, qty, options, note: n, guestId, splitAmong }) => ({ dishId, qty, options, note: n, guestId, splitAmong })),
      });
      sendKey.current = null;
      cart.clear();
      setNote('');
      setInfo((p) => ({ ...p, session: r.session }));
      setSentResult({ num: r.order.num, delivered: r.delivered, total: r.order.total });
      setIntroSeen(true);
      show('sent');
    } catch (e) {
      toast(e.message, 'err');
      if (e.data?.problems) {
        const gone = new Set(e.data.problems.filter((p) => p.reason !== 'options').map((p) => p.dishId));
        cart.dropWhere((l) => gone.has(l.dishId));
        reloadMenu();
      }
    } finally {
      setSending(false);
    }
  };

  /* ───────── вызов официанта ───────── */

  const activeCall = session?.calls?.slice().reverse().find((c) => (c.status === 'new' || c.status === 'ack') && Date.now() - c.createdAt < 20 * 60_000);

  const callWaiter = async (reason) => {
    try {
      const r = await api.post(`/api/table/${code}/call`, { reason });
      setInfo((p) => ({ ...p, session: r.session }));
      return r;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    }
  };

  /* ───────── экраны ───────── */

  if (fatal) {
    return html`<div class="app"><div class="fatal">
      <${Plaque} size="lg"><${Icon} name="qr" size=40 /><//>
      <h1>Не нашли этот стол</h1>
      <p>${fatal}</p>
      <p class="faint">Если не получается — позовите официанта, он принесёт бумажное меню.</p>
    </div></div>`;
  }

  if (!info) {
    return html`<div class="app"><div class="skeleton-page" aria-hidden="true">
      <div class="skeleton" style="height:56px"></div><div class="skeleton" style="height:150px"></div><div class="skeleton" style="height:44px"></div><div class="skeleton" style="height:110px"></div><div class="skeleton" style="height:110px"></div>
    </div></div>`;
  }

  const t = info.table;
  const orderCount = session.orders.filter((o) => o.status !== 'cancelled').length;
  const billTotal = session.bill.total;

  return html`<div class="app">
    <header class="thead">
      <div class="gingham-strip"></div>
      <div class="thead-row">
        <${Plaque}>${t.number}<//>
        <div class="table-meta"><b>Стол ${t.number}</b><span>${t.hall?.name || info.brand.full}</span></div>
        <span class="spacer"></span>
        <button class=${cx('waiter-btn', activeCall && 'is-called')} onClick=${() => show('waiter')} aria-label="Позвать официанта">
          <${Icon} name="bell" size=20 />
          <span>${activeCall ? (activeCall.status === 'ack' ? 'Идёт к вам' : 'Вызвали') : 'Официант'}</span>
        </button>
      </div>
    </header>

    ${tab === 'menu' && (menu
      ? html`<${MenuView}
          menu=${menu}
          layout=${layout}
          onLayout=${setLayout}
          qtyFor=${qtyFor}
          totalQtyFor=${totalQtyFor}
          onAdd=${quickAdd}
          onDec=${decItem}
          onOpen=${openDish}
          spyOffset=${126}
          header=${html`<${Fragment}>
            ${!introSeen && html`<${Intro} brand=${info.brand} onClose=${() => setIntroSeen(true)} />`}
            <${GuestBar} guests=${guests} own=${own} activeId=${activeId} onPick=${(id) => setDev((d) => ({ ...d, active: id }))} onAdd=${() => (own.length ? show('guests') : (setWelcomeDismissed(false), show('welcome')))} />
          <//>`}
        />`
      : menuError
        ? html`<${Empty} icon="warn" title="Меню не загрузилось" text=${menuError}><button class="btn" onClick=${reloadMenu}>Попробовать снова</button><//>`
        : html`<div class="skeleton-page"><div class="skeleton" style="height:44px"></div><div class="skeleton" style="height:110px"></div><div class="skeleton" style="height:110px"></div></div>`)}

    ${tab === 'order' && html`<${OrderTab}
      table=${t}
      session=${session}
      lines=${cart.lines}
      index=${index}
      own=${own}
      activeId=${activeId}
      badLines=${badLines}
      summary=${summary}
      note=${note}
      setNote=${setNote}
      sending=${sending}
      onSend=${send}
      onQty=${cart.setQty}
      onWho=${(l) => (setWhoLine(l), show('who'))}
      onDropBad=${() => cart.dropWhere((l) => badLines.includes(l))}
      onMenu=${() => setTab('menu')}
    />`}

    ${tab === 'bill' && html`<${BillTab}
      session=${session}
      info=${info}
      own=${own}
      onPay=${() => show('pay')}
      onCall=${() => show('waiter')}
      onMenu=${() => setTab('menu')}
      onCancelPay=${async () => {
        try {
          const r = await api.post(`/api/table/${code}/pay/cancel`);
          setInfo((p) => ({ ...p, session: r.session }));
          toast('Запрос оплаты отменён');
        } catch (e) {
          toast(e.message, 'err');
        }
      }}
    />`}

    ${tab === 'menu' && cart.lines.length > 0 && html`<button class="fab-order" onClick=${() => setTab('order')}>
      <span class="left"><span class="count">${summary.count}</span>Мой заказ</span>
      <span class="num">${rub(summary.total)}</span>
    </button>`}

    <nav class="dock" aria-label="Разделы">
      <button aria-current=${tab === 'menu' ? 'page' : 'false'} onClick=${() => { setTab('menu'); window.scrollTo({ top: 0 }); }}><${Icon} name="menu" size=24 />Меню</button>
      <button aria-current=${tab === 'order' ? 'page' : 'false'} onClick=${() => { setTab('order'); window.scrollTo({ top: 0 }); }}>
        <${Icon} name="bag" size=24 />Заказ
        ${summary.count > 0 && html`<span class="mark">${summary.count}</span>`}
      </button>
      <button aria-current=${tab === 'bill' ? 'page' : 'false'} onClick=${() => { setTab('bill'); window.scrollTo({ top: 0 }); }}>
        <${Icon} name="receipt" size=24 />Счёт
        ${orderCount > 0 && html`<span class="mark dot" aria-label="Есть заказы"></span>`}
      </button>
    </nav>

    <${DishSheet}
      item=${dishItem}
      open=${!!open.dish}
      onClose=${() => hide('dish')}
      onSubmit=${submitDish}
      guests=${guests}
      activeGuestId=${activeId}
    />

    <${WelcomeSheet}
      open=${!!open.welcome}
      table=${t}
      guests=${guests}
      own=${own}
      onClose=${() => (hide('welcome'), setWelcomeDismissed(true))}
      onStart=${async (name) => {
        try {
          await addGuest(name);
          hide('welcome');
        } catch (e) {
          toast(e.message, 'err');
        }
      }}
      onClaim=${(id) => (claimGuest(id), hide('welcome'))}
    />

    <${GuestsSheet}
      open=${!!open.guests}
      onClose=${() => hide('guests')}
      guests=${guests}
      own=${own}
      activeId=${activeId}
      onAdd=${async (name) => {
        try {
          await addGuest(name);
          hide('guests');
        } catch (e) {
          toast(e.message, 'err');
        }
      }}
      onRename=${async (id, name) => {
        try {
          const r = await api.put(`/api/table/${code}/guests/${id}`, { name });
          setInfo((p) => ({ ...p, session: r.session }));
        } catch (e) {
          toast(e.message, 'err');
        }
      }}
    />

    <${Sheet}
      open=${!!open.who}
      onClose=${() => hide('who')}
      title="Чьё это блюдо?"
    >
      ${whoLine && html`<${WhoLine} line=${whoLine} guests=${guests} index=${index} onChoose=${(v) => {
        cart.update(lineKey(whoLine), { guestId: v.who, splitAmong: v.who === SHARED ? v.among : undefined });
        hide('who');
      }} />`}
    <//>

    <${WaiterSheet}
      open=${!!open.waiter}
      onClose=${() => hide('waiter')}
      reasons=${info.callReasons}
      call=${activeCall}
      onCall=${callWaiter}
    />

    <${PaySheet}
      open=${!!open.pay}
      onClose=${() => hide('pay')}
      info=${info}
      session=${session}
      own=${own}
      onDone=${(s) => {
        setInfo((p) => ({ ...p, session: s }));
        hide('pay');
        setTab('bill');
      }}
    />

    <${Sheet} open=${!!open.sent} onClose=${() => hide('sent')} label="Заказ отправлен">
      ${sentResult && html`<div class="call-done">
        <div class="success-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
        <h2 style="font-size:28px">Заказ № ${sentResult.num} отправлен</h2>
        <p>${sentResult.delivered ? 'Официант получил заказ и скоро подтвердит его.' : 'Заказ сохранён. Передаём его официанту — если никто не подойдёт в ближайшие минуты, нажмите «Официант».'}</p>
        <div class="num" style="font-weight:750;font-size:20px">${rub(sentResult.total)}</div>
      </div>
      <div class="stack" style="margin-top:20px">
        <button class="btn btn-lg" onClick=${() => (hide('sent'), setTab('bill'), window.scrollTo({ top: 0 }))}>Смотреть счёт</button>
        <button class="btn btn-ghost btn-lg" onClick=${() => (hide('sent'), setTab('menu'), window.scrollTo({ top: 0 }))}>Заказать ещё</button>
      </div>`}
    <//>

    <${Toasts} />
  </div>`;
}

/* ───────── приветствие и гости ───────── */

function Intro({ brand, onClose }) {
  return html`<section class="intro">
    <div class="intro-card">
      <div class="intro-cloth"></div>
      <button class="intro-close" onClick=${onClose} aria-label="Скрыть подсказку"><${Icon} name="x" size=18 /></button>
      <div class="intro-body">
        <h1>Приятного аппетита!</h1>
        <p>${brand.tagline}. Заказывайте с телефона — официант всё принесёт.</p>
        <ul class="intro-steps">
          <li><${Icon} name="users" size=20 />Добавьте друзей и выбирайте блюда за каждого</li>
          <li><${Icon} name="send" size=20 />Отправьте заказ — он сразу попадёт на кухню</li>
          <li><${Icon} name="receipt" size=20 />Платите вместе или раздельно, каждый за своё</li>
        </ul>
      </div>
    </div>
  </section>`;
}

function GuestBar({ guests, own, activeId, onPick, onAdd }) {
  if (!guests.length) return html`<div class="guestbar"><button class="guestchip add" onClick=${onAdd}><${Icon} name="plus" size=18 />Добавить себя</button></div>`;
  return html`<div class="guestbar" role="group" aria-label="За кого заказываем">
    <span class="guestbar-label">Заказываете за:</span>
    ${guests.map((g) => html`<button key=${g.id} class="guestchip" aria-pressed=${g.id === activeId} onClick=${() => onPick(g.id)}>
      <${Avatar} guest=${g} size=32 />${g.name}${own.some((o) => o.id === g.id) && own.length === 1 && guests.length > 1 ? html` <span class="you">вы</span>` : ''}
    </button>`)}
    <button class="guestchip add" onClick=${onAdd}><${Icon} name="plus" size=18 />Гость</button>
  </div>`;
}

function WelcomeSheet({ open, table, guests, own, onClose, onStart, onClaim }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    await onStart(name);
    setBusy(false);
    setName('');
  };
  const free = guests.filter((g) => !own.some((o) => o.id === g.id));
  return html`<${Sheet} open=${open} onClose=${onClose} label="Знакомство">
    <form class="welcome" onSubmit=${submit}>
      <${Plaque} size="lg">${table.number}<//>
      <div>
        <h2 style="font-size:30px;margin-bottom:8px">Как вас зовут?</h2>
        <p>Так друзья и официант увидят, кто что заказал. Можно заказывать за каждого отдельно и потом платить раздельно.</p>
      </div>
      <div class="field">
        <label for="guest-name">Ваше имя</label>
        <input id="guest-name" class="input" type="text" maxlength="20" autocomplete="given-name" placeholder="Например, Аня" value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
      </div>
      <button class="btn btn-lg btn-block" type="submit" disabled=${busy}>${name.trim() ? 'Начать' : 'Начать без имени'}</button>
      ${free.length > 0 && html`<div class="claim">
        <div class="divider"></div>
        <p class="muted" style="font-size:14.5px">Уже сидите за этим столом? Выберите себя:</p>
        <div class="who-grid">${free.map((g) => html`<button type="button" key=${g.id} class="chip" onClick=${() => onClaim(g.id)}><${Avatar} guest=${g} size=28 />${g.name}</button>`)}</div>
      </div>`}
      <button type="button" class="btn btn-quiet btn-block" onClick=${onClose}>Сначала посмотрю меню</button>
    </form>
  <//>`;
}

function GuestsSheet({ open, onClose, guests, own, activeId, onAdd, onRename }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const submit = (e) => {
    e.preventDefault();
    onAdd(name);
    setName('');
  };
  return html`<${Sheet} open=${open} onClose=${onClose} title="Гости за столом">
    <div class="stack">
      <p class="muted">Добавьте каждого, кто сидит с вами — тогда блюда и счёт разделятся по людям.</p>
      <div class="pay-guests">
        ${guests.map((g) => html`<div key=${g.id} class="pay-guest" style="cursor:default">
          <${Avatar} guest=${g} size=36 />
          ${editing === g.id
            ? html`<input class="input" style="min-height:42px;flex:1" value=${draft} maxlength="20" autofocus onInput=${(e) => setDraft(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && (onRename(g.id, draft), setEditing(null))} />
                <button class="btn btn-sm" onClick=${() => (onRename(g.id, draft), setEditing(null))}>Готово</button>`
            : html`<span class="grow">${g.name}${own.some((o) => o.id === g.id) ? html` <span class="faint" style="font-weight:500">· ваш</span>` : ''}</span>
                <button class="icon-btn" style="width:38px;height:38px" aria-label=${'Переименовать ' + g.name} onClick=${() => (setEditing(g.id), setDraft(g.name))}><${Icon} name="pencil" size=18 /></button>`}
        </div>`)}
      </div>
      <form class="field" onSubmit=${submit}>
        <label for="new-guest">Новый гость</label>
        <div class="row">
          <input id="new-guest" class="input" type="text" maxlength="20" placeholder="Имя" value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
          <button class="btn" type="submit"><${Icon} name="plus" size=20 />Добавить</button>
        </div>
      </form>
    </div>
  <//>`;
}

/* ───────── заказ ───────── */

function WhoLine({ line, guests, index, onChoose }) {
  const e = index.get(line.dishId);
  const [who, setWho] = useState(line.guestId);
  const [among, setAmong] = useState(line.splitAmong?.length ? line.splitAmong : guests.map((g) => g.id));
  return html`<div class="stack">
    <p class="muted">${e?.item.name}</p>
    <${WhoPicker} guests=${guests} value=${who} among=${among} onChange=${(v) => (setWho(v.who), setAmong(v.among))} />
    <button class="btn btn-lg" onClick=${() => onChoose({ who, among })}>Готово</button>
  </div>`;
}

function OrderTab({ table, session, lines, index, own, activeId, badLines, summary, note, setNote, sending, onSend, onQty, onWho, onDropBad, onMenu }) {
  if (!lines.length) {
    return html`<section class="tab">
      <header><h1>Заказ</h1></header>
      <${Empty} icon="bag" title="Пока пусто" text="Выберите блюда в меню. Можно добавлять сразу за всех — каждому своё.">
        <button class="btn btn-lg" onClick=${onMenu}>Открыть меню</button>
      <//>
    </section>`;
  }

  const guests = session.guests;
  const groups = [];
  for (const g of guests) {
    const ls = lines.filter((l) => l.guestId === g.id);
    if (ls.length) groups.push({ key: g.id, guest: g, lines: ls });
  }
  const shared = lines.filter((l) => l.guestId === SHARED);
  if (shared.length) groups.push({ key: SHARED, shared: true, lines: shared });

  const groupSum = (ls) => ls.reduce((s, l) => s + unitPrice(index.get(l.dishId)?.item || { price: 0, options: [] }, l.options) * l.qty, 0);
  const bad = new Set(badLines);

  return html`<section class="tab">
    <header>
      <h1>Заказ</h1>
      <p>Стол ${table.number} · ${count(summary.count, 'блюдо', 'блюда', 'блюд')}. Пока не отправлен.</p>
    </header>

    ${badLines.length > 0 && html`<div class="notice notice-danger">
      <${Icon} name="warn" />
      <div style="display:grid;gap:8px"><span>Некоторые блюда закончились или сейчас недоступны. Уберите их, чтобы отправить заказ.</span>
      <button class="btn btn-sm btn-danger" style="justify-self:start" onClick=${onDropBad}>Убрать недоступные</button></div>
    </div>`}

    ${groups.map((g) => {
      const among = g.shared ? [...new Set(g.lines.flatMap((l) => l.splitAmong || []))].map((id) => guests.find((x) => x.id === id)?.name).filter(Boolean) : [];
      return html`<div class="og" key=${g.key}>
        <div class="og-head">
          ${g.shared ? html`<${Avatar} shared size=34 />` : html`<${Avatar} guest=${g.guest} size=34 />`}
          <div style="display:grid;line-height:1.15">
            <b>${g.shared ? 'Общее на стол' : g.guest.name}</b>
            ${g.shared ? html`<span class="you">делим: ${among.join(', ') || 'на всех'}</span>` : own.some((o) => o.id === g.guest.id) && guests.length > 1 ? html`<span class="you">ваш заказ</span>` : ''}
          </div>
          <span class="sum">${rub(groupSum(g.lines))}</span>
        </div>
        ${g.lines.map((l) => {
          const e = index.get(l.dishId);
          const key = lineKey(l);
          const isBad = bad.has(l);
          const sub = [...(e ? optionLabels(e.item, l.options) : []), l.note && `«${l.note}»`].filter(Boolean).join(' · ');
          return html`<div class=${cx('oline', isBad && 'is-bad')} key=${key}>
            <div>
              <div class="oline-name">${e?.item.name || 'Блюдо убрали из меню'}</div>
              ${sub && html`<div class="oline-sub">${sub}</div>`}
              ${isBad && html`<div class="oline-sub" style="color:var(--danger);font-weight:650">${e?.item.stop ? 'Закончилось' : 'Недоступно сейчас'}</div>`}
            </div>
            <div class="oline-price num">${e ? rub(unitPrice(e.item, l.options) * l.qty) : ''}</div>
            <div class="oline-ctl">
              ${guests.length > 1
                ? html`<button class="whochip" onClick=${() => onWho(l)} aria-label="Сменить, чьё блюдо">${l.guestId === SHARED ? html`<${Avatar} shared size=26 />` : html`<${Avatar} guest=${guests.find((x) => x.id === l.guestId)} size=26 />`}${l.guestId === SHARED ? 'Общее' : guests.find((x) => x.id === l.guestId)?.name}<${Icon} name="down" size=16 /></button>`
                : html`<span></span>`}
              <${Stepper} value=${l.qty} flat onInc=${() => onQty(key, l.qty + 1)} onDec=${() => onQty(key, l.qty - 1)} label=${e?.item.name} />
            </div>
          </div>`;
        })}
      </div>`;
    })}

    <div class="order-note field">
      <label for="order-note">Пожелание кухне или официанту</label>
      <textarea id="order-note" class="textarea" maxlength="200" placeholder="Например: сначала закуски, потом горячее" value=${note} onInput=${(e) => setNote(e.currentTarget.value)}></textarea>
    </div>

    <div class="send-bar">
      <div class="order-total"><span>К отправке</span><b>${rub(summary.total)}</b></div>
      <button class="btn btn-accent btn-lg btn-block" disabled=${sending || badLines.length > 0} onClick=${onSend}>
        ${sending ? html`<span class="spinner" style="border-top-color:currentColor"></span>Отправляем…` : html`<${Icon} name="send" size=22 />Отправить официанту`}
      </button>
    </div>
  </section>`;
}

/* ───────── счёт ───────── */

function BillTab({ session, info, own, onPay, onCall, onMenu, onCancelPay }) {
  const orders = [...session.orders].reverse();
  const bill = session.bill;
  const guests = session.guests;
  const pay = session.payment && (session.payment.status === 'requested' || session.payment.status === 'ack') ? session.payment : null;
  const unpaidLeft = guests.some((g) => !g.paid && (bill.perGuest[g.id]?.total || 0) > 0);

  if (!orders.length) {
    return html`<section class="tab">
      <header><h1>Счёт</h1></header>
      <${Empty} icon="receipt" title="Заказов пока нет" text="Когда отправите заказ, он появится здесь — вместе со статусом и суммой на каждого гостя.">
        <button class="btn btn-lg" onClick=${onMenu}>Выбрать блюда</button>
      <//>
    </section>`;
  }

  const nameOf = (id) => guests.find((g) => g.id === id);
  return html`<section class="tab">
    <header>
      <h1>Счёт стола</h1>
      <p>Всё, что заказали за столом, и кто сколько должен.</p>
    </header>

    ${pay && html`<div class="pay-state">
      <div class="row"><${Icon} name="check" /><span>${pay.status === 'ack' ? 'Официант уже идёт к вам' : 'Официант получил запрос на оплату'}</span></div>
      <p>${METHODS[pay.method]?.label}, ${pay.mode === 'split' ? 'раздельно' : 'одним чеком'} · ${rub(pay.total)}${pay.tip ? ` (с чаевыми ${pay.tipPct}%)` : ''}</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm btn-quiet" onClick=${onPay}>Изменить</button>
        <button class="btn btn-sm btn-ghost" onClick=${onCancelPay}>Отменить запрос</button>
      </div>
    </div>`}

    <div class="check-card">
      <div class="check-head"><h2>Кто сколько</h2><span class="muted num">${count(orders.filter((o) => o.status !== 'cancelled').length, 'заказ', 'заказа', 'заказов')}</span></div>
      ${guests.map((g) => {
        const b = bill.perGuest[g.id] || { own: 0, shared: 0, total: 0 };
        if (!b.total && !guests.every((x) => !(bill.perGuest[x.id]?.total))) return null;
        return html`<div class="check-row" key=${g.id}>
          <${Avatar} guest=${g} size=36 />
          <div class="who"><b>${g.name}${own.some((o) => o.id === g.id) && guests.length > 1 ? ' (вы)' : ''}</b>
            <small>${b.own ? `блюда ${rub(b.own)}` : ''}${b.own && b.shared ? ' + ' : ''}${b.shared ? `общее ${rub(b.shared)}` : ''}${!b.total ? 'пока ничего' : ''}</small></div>
          <span class=${cx('amount num', g.paid && 'paid')}>${g.paid ? 'оплатил' : rub(b.total)}</span>
        </div>`;
      })}
      <div class="check-total"><span>Итого по столу</span><b>${rub(bill.total)}</b></div>
    </div>

    <div class="stack" style="gap:10px">
      <button class="btn btn-accent btn-lg btn-block" disabled=${!unpaidLeft} onClick=${onPay}><${Icon} name="cash" size=22 />${pay ? 'Изменить оплату' : 'Готовы оплатить'}</button>
      <button class="btn btn-ghost btn-block" onClick=${onCall}><${Icon} name="bell" size=20 />Позвать официанта</button>
    </div>

    <div>
      <h2 style="font-size:24px;margin:6px 0 12px">Отправленные заказы</h2>
      <div class="sent-list">
        ${orders.map((o) => {
          const st = STATUS[o.status] || STATUS.new;
          const byGuest = new Map();
          for (const l of o.lines) {
            const k = l.guestId;
            if (!byGuest.has(k)) byGuest.set(k, []);
            byGuest.get(k).push(l);
          }
          return html`<article class="sent" key=${o.id}>
            <div class="sent-head"><b>№ ${o.num}</b><time>${hhmm(o.createdAt)}</time><span class=${cx('badge', st.tone)}>${st.text}</span></div>
            <div class="sent-lines">
              ${[...byGuest.entries()].map(([gid, ls]) => html`<${Fragment} key=${gid}>
                <div class="g">${gid === SHARED ? html`<${Avatar} shared size=20 />Общее на стол` : html`<${Avatar} guest=${nameOf(gid)} size=20 />${nameOf(gid)?.name || 'Гость'}`}</div>
                ${ls.map((l) => html`<div class="l" key=${l.id}><span>${l.name}${l.opts?.length ? ` (${l.opts.map((x) => x.choice).join(', ')})` : ''} × ${l.qty}</span><span>${rub(l.unit * l.qty)}</span></div>`)}
              <//>`)}
            </div>
          </article>`;
        })}
      </div>
    </div>
  </section>`;
}

/* ───────── официант ───────── */

function WaiterSheet({ open, onClose, reasons, call, onCall }) {
  const [busy, setBusy] = useState(false);
  const [justCalled, setJustCalled] = useState(false);
  useEffect(() => {
    if (!open) setJustCalled(false);
  }, [open]);
  const go = async (key) => {
    if (busy) return;
    setBusy(true);
    const r = await onCall(key);
    setBusy(false);
    if (r) setJustCalled(true);
  };
  const showStatus = call && (justCalled || call);
  return html`<${Sheet} open=${open} onClose=${onClose} title="Позвать официанта">
    ${showStatus
      ? html`<div class="call-done">
          <div class="success-mark" style=${call.status === 'ack' ? '' : 'background:var(--primary)'}>${call.status === 'ack' ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` : html`<${Icon} name="bell" size=40 />`}</div>
          <h2 style="font-size:26px">${call.status === 'ack' ? 'Официант уже идёт' : 'Вызов отправлен'}</h2>
          <p>${call.label}. ${call.status === 'ack' ? 'Подождите пару минут.' : 'Официант получил уведомление и подойдёт к вам.'}</p>
        </div>
        <div class="stack" style="margin-top:18px"><button class="btn btn-ghost btn-lg" onClick=${onClose}>Закрыть</button></div>`
      : html`<div class="call-grid">
          ${Object.entries(reasons).map(([key, label]) => html`<button key=${key} class=${cx('call-tile', key === 'waiter' && 'primary')} onClick=${() => go(key)} disabled=${busy}>
            <${Icon} name=${CALL_ICONS[key] || 'bell'} size=${key === 'waiter' ? 30 : 26} />${label}
          </button>`)}
        </div>`}
  <//>`;
}

/* ───────── оплата ───────── */

function PaySheet({ open, onClose, info, session, own, onDone }) {
  const bill = session.bill;
  const unpaid = session.guests.filter((g) => !g.paid && (bill.perGuest[g.id]?.total || 0) > 0);
  const methods = Object.keys(METHODS).filter((m) => info.payments[m]);
  const [mode, setMode] = useState('split');
  const [picked, setPicked] = useState([]);
  const [method, setMethod] = useState(methods[0]);
  const [tip, setTip] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPicked(unpaid.map((g) => g.id));
      setMethod((m) => (methods.includes(m) ? m : methods[0]));
    }
  }, [open, unpaid.map((g) => g.id).join()]);

  const sel = unpaid.filter((g) => picked.includes(g.id));
  const subtotal = sel.reduce((s, g) => s + bill.perGuest[g.id].total, 0);
  const tipSum = sel.reduce((s, g) => s + tipOf(bill.perGuest[g.id].total, tip), 0);
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/table/${code}/pay`, { method, mode, guestIds: sel.map((g) => g.id), tipPct: tip });
      toast(r.delivered ? 'Официант получил запрос и скоро подойдёт' : 'Запрос сохранён, передаём официанту');
      onDone(r.session);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="Готовы оплатить"
    footer=${html`<div class="pay-sum">
        ${tipSum > 0 && html`<div><span>Счёт</span><span class="num">${rub(subtotal)}</span></div><div><span>Чаевые ${tip}%</span><span class="num">${rub(tipSum)}</span></div>`}
        <div class="big"><span>К оплате</span><span class="num">${rub(subtotal + tipSum)}</span></div>
      </div>
      <button class="btn btn-accent btn-lg btn-block" disabled=${busy || !sel.length || !method} onClick=${submit}>${busy ? 'Отправляем…' : 'Позвать официанта со счётом'}</button>`}
  >
    <div class="pay-section">
      <h3>Как считаем</h3>
      <div class="seg" role="group">
        <button aria-pressed=${mode === 'split'} onClick=${() => setMode('split')}>Раздельно</button>
        <button aria-pressed=${mode === 'together'} onClick=${() => setMode('together')}>Одним чеком</button>
      </div>
      <p class="faint" style="font-size:13.5px">${mode === 'split' ? 'Каждому гостю — отдельная сумма. Общие блюда поделены поровну.' : 'Один общий чек на выбранных гостей.'}</p>
    </div>

    <div class="pay-section">
      <h3>Кто платит сейчас</h3>
      <div class="pay-guests">
        ${unpaid.map((g) => html`<button key=${g.id} class="pay-guest" role="checkbox" aria-checked=${picked.includes(g.id)} onClick=${() => toggle(g.id)}>
          <${Avatar} guest=${g} size=34 />
          <span class="grow">${g.name}${own.some((o) => o.id === g.id) && session.guests.length > 1 ? html` <span class="faint" style="font-weight:500">· вы</span>` : ''}</span>
          <b class="num">${rub(bill.perGuest[g.id].total)}</b>
          <span class="tick"><${Icon} name="check" size=16 stroke=3 /></span>
        </button>`)}
      </div>
    </div>

    <div class="pay-section">
      <h3>Способ оплаты</h3>
      <div class="pay-methods" role="radiogroup">
        ${methods.map((m) => html`<button key=${m} class="pay-method" role="radio" aria-checked=${method === m} onClick=${() => setMethod(m)}><${Icon} name=${METHODS[m].icon} size=28 />${METHODS[m].label}</button>`)}
      </div>
      <p class="faint" style="font-size:13.5px">${method === 'cash' ? 'Официант подойдёт со счётом и принесёт сдачу.' : method === 'card' ? 'Официант подойдёт с терминалом.' : 'Официант покажет QR-код для перевода по СБП.'}</p>
    </div>

    ${info.tips.length > 1 && html`<div class="pay-section">
      <h3>Чаевые официанту</h3>
      <div class="tip-row">${info.tips.map((p) => html`<button key=${p} class="chip" aria-pressed=${tip === p} onClick=${() => setTip(p)}>${p ? p + '%' : 'Без чаевых'}</button>`)}</div>
    </div>`}
  <//>`;
}

render(html`<${App} />`, document.getElementById('app'));
