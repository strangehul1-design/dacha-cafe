// Сайт кафе: главная, меню с доставкой и самовывозом, залы, отзывы, контакты и бронь.
import { html, render, useState, useEffect, useMemo, useRef } from './common/lib.js';
import { api } from './common/api.js';
import { Icon } from './common/icons.js';
import { Sheet, Stepper, Plaque, Toasts, toast, usePolling, useStored, cx, Fragment } from './common/ui.js';
import { rub, count, normalizePhone, plural } from './common/format.js';
import { groupHours, localParts, DAY_KEYS, toMin, fromMin } from './common/hours.js';
import { useMenu, useCart, indexMenu, unitPrice, optionLabels, needsChoice, cartSummary, lineKey } from './common/menu-core.js';
import { MenuView, DishSheet } from './common/menu-ui.js';

const REVIEWS = [
  { name: 'Евгения Доронина', text: 'Кафе «Дача» — моё любимое местечко в Снежинске. Здесь всегда приятно проводить время, по любому поводу и без него. Дни рождения, корпоративы, детские праздники, встречи с друзьями — всё это я обычно провожу в этом уютном атмосферном заведении. И конечно, кухня здесь просто на высоте.' },
  { name: 'Наталья Севрюк', text: 'Здесь не нужно много слов, это кафе, в котором вам будет хорошо! Удобное месторасположение, интересная подача блюд, добродушный шеф-повар, который ответит на самые каверзные вопросы о блюдах. Вежливые, внимательные и аккуратные официанты.' },
  { name: 'Данила Баталов', text: 'Самое лучшее место для вечерних встреч с друзьями. Вкусная кухня, отличные вечеринки. Из еды особенно хочу отметить стейки и сыр халуми с овощами. На дом заказываю пельмени — очень вкусные, особенно с рыбой. Магазинные пельмени после дачных больше есть не могу.' },
  { name: 'Сергей Соколов', text: 'Работникам кафе «Дача» хочется сказать огромное спасибо за вкусную еду, вежливый персонал и адекватные цены. Это наше любимое семейное кафе.' },
];

const HERO_DISHES = ['Пицца охотничья', 'Говядина wok', 'Шеф-бургер', 'Шоколадный лава-кейк'];
const PAY_LABELS = { cash: ['Наличными', 'cash'], card: ['Картой', 'card'], sbp: ['По СБП', 'qr'] };
const telHref = (p) => 'tel:+' + String(p || '').replace(/\D/g, '').replace(/^8/, '7');
const mapHref = (c) => `https://yandex.ru/maps/?text=${encodeURIComponent(c.address)}`;

function useMedia(q) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

function openLabel(cfg) {
  const o = cfg.open;
  if (o.open) return `Открыто до ${o.closeAt}`;
  if (o.nextOpen) return `Сейчас закрыто · откроемся ${o.nextOpen.label} в ${o.nextOpen.time}`;
  return 'Сейчас закрыто';
}

function App() {
  const [cfg, setCfg] = useState(null);
  const { menu, error: menuError, reload } = useMenu('mode=delivery');
  const index = useMemo(() => indexMenu(menu), [menu]);
  const cart = useCart('dacha:cart:delivery');
  const [layout, setLayout] = useStored('dacha:layout-site', 'list');
  const wide = useMedia('(min-width: 1000px)');
  const [open, setOpen] = useState({});
  const [dishItem, setDishItem] = useState(null);
  const [done, setDone] = useState(null);
  const show = (n) => setOpen((o) => ({ ...o, [n]: true }));
  const hide = (n) => setOpen((o) => ({ ...o, [n]: false }));

  const loadCfg = async () => setCfg(await api.get('/api/config'));
  useEffect(() => {
    loadCfg().catch(() => {});
  }, []);
  usePolling(loadCfg, 60_000, []);

  // Что-то из корзины убрали из меню или оно закончилось — предупреждаем, не молчим
  const bad = cart.lines.filter((l) => {
    const e = index.get(l.dishId);
    return menu && (!e || e.item.stop || !e.cat.available);
  });

  const qtyFor = (item) => cart.lines.filter((l) => l.dishId === item.id).reduce((s, l) => s + l.qty, 0);
  const openDish = (item) => (setDishItem(item), show('dish'));
  const quickAdd = (item) => (needsChoice(item) ? openDish(item) : cart.add({ dishId: item.id, qty: 1, options: {} }));
  const dec = (item) => {
    const ls = cart.lines.filter((l) => l.dishId === item.id);
    const l = ls[ls.length - 1];
    if (l) cart.setQty(lineKey(l), l.qty - 1);
  };
  const summary = cartSummary(cart.lines, index);

  const goMenu = () => document.getElementById('menu')?.scrollIntoView({ behavior: 'smooth' });

  // Если в оформлении что-то закончилось — убираем и просим выбрать заново
  const onMenuChanged = (problems) => {
    const gone = new Set(problems.filter((p) => p.reason !== 'options').map((p) => p.dishId));
    cart.dropWhere((l) => gone.has(l.dishId));
    reload();
  };

  if (!cfg) return html`<div class="skeleton-page" aria-hidden="true" style="min-height:100vh"><div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:320px"></div></div>`;

  return html`<${Fragment}>
    <${Header} cfg=${cfg} count=${summary.count} onCart=${() => show('cart')} />
    <main>
      <${Hero} cfg=${cfg} menu=${menu} onMenu=${goMenu} />
      <${MenuSection}
        cfg=${cfg}
        menu=${menu}
        menuError=${menuError}
        reload=${reload}
        layout=${wide ? 'cards' : layout}
        setLayout=${setLayout}
        wide=${wide}
        qtyFor=${qtyFor}
        onAdd=${quickAdd}
        onDec=${dec}
        onOpen=${openDish}
        aside=${html`<${CartPanel} cfg=${cfg} lines=${cart.lines} index=${index} bad=${bad} onQty=${cart.setQty} onClear=${cart.clear} onCheckout=${() => show('checkout')} />`}
      />
      <${DeliverySection} cfg=${cfg} onMenu=${goMenu} />
      <${HallsSection} cfg=${cfg} />
      <${ReviewsSection} />
      <${ContactsSection} cfg=${cfg} />
    </main>
    <${Footer} cfg=${cfg} />

    ${cart.lines.length > 0 && html`<button class="site-fab" onClick=${() => show('cart')}>
      <span class="left"><span class="count">${summary.count}</span>Корзина</span><span class="num">${rub(summary.total)}</span>
    </button>`}

    <${DishSheet} item=${dishItem} open=${!!open.dish} onClose=${() => hide('dish')} onSubmit=${(p) => (cart.add(p), hide('dish'), toast(`В корзине: ${dishItem.name}`))} />

    <${Sheet} open=${!!open.cart} onClose=${() => hide('cart')} title="Ваш заказ">
      <${CartPanel} cfg=${cfg} lines=${cart.lines} index=${index} bad=${bad} onQty=${cart.setQty} onClear=${cart.clear} bare onCheckout=${() => (hide('cart'), show('checkout'))} />
    <//>

    <${Checkout}
      open=${!!open.checkout}
      onClose=${() => hide('checkout')}
      cfg=${cfg}
      lines=${cart.lines}
      index=${index}
      onChanged=${onMenuChanged}
      onDone=${(d) => {
        cart.clear();
        hide('checkout');
        setDone(d);
        show('done');
      }}
    />

    <${DoneSheet} open=${!!open.done} onClose=${() => hide('done')} cfg=${cfg} done=${done} />
    <${Toasts} />
  <//>`;
}

/* ───────── шапка ───────── */

function Header({ cfg, count: n, onCart }) {
  return html`<header class="site-header">
    <div class="gingham-strip"></div>
    <div class="container site-header-row">
      <a class="brand" href="/" aria-label=${cfg.brand.full}>
        <${Plaque}>${cfg.brand.name}<//>
        <span class="brand-sub">для<br />друзей</span>
      </a>
      <nav class="site-nav" aria-label="Разделы сайта">
        <a href="#menu">Меню</a><a href="#delivery">Доставка</a><a href="#halls">Залы и банкеты</a><a href="#reviews">Отзывы</a><a href="#contacts">Контакты</a>
      </nav>
      <span class="spacer-grow"></span>
      <a class="header-phone" href=${telHref(cfg.contacts.phone)}><${Icon} name="phone" size=20 />${cfg.contacts.phone}</a>
      <button class="header-cart" onClick=${onCart} aria-label="Открыть корзину">
        <${Icon} name="bag" size=22 />
        <span>Корзина</span>
        ${n > 0 && html`<span class="count">${n}</span>`}
      </button>
    </div>
  </header>`;
}

/* ───────── главная ───────── */

function Hero({ cfg, menu, onMenu }) {
  const items = useMemo(() => {
    if (!menu) return [];
    const all = menu.categories.flatMap((c) => c.items);
    return HERO_DISHES.map((n) => all.find((i) => i.name === n)).filter((i) => i?.image);
  }, [menu]);
  const d = cfg.delivery;
  return html`<section class="hero">
    <div class="container hero-grid">
      <div class="hero-copy">
        <span class=${cx('open-chip', !cfg.open.open && 'is-closed')}><span class="dot dot-live"></span>${openLabel(cfg)}</span>
        <h1>${cfg.brand.name}<span>для друзей</span></h1>
        <p class="hero-lead">Пицца, пасты, гриль, вок и колбаски собственного производства. Приходите в парк — или закажите домой${d.enabled ? `: бесплатно от ${rub(d.freeFrom)}` : ''}.</p>
        <div class="hero-cta">
          <button class="btn btn-lg" onClick=${onMenu}><${Icon} name="menu" size=22 />Смотреть меню</button>
          <a class="btn btn-lg btn-ghost" href="#contacts"><${Icon} name="calendar" size=22 />Забронировать стол</a>
        </div>
        <div class="hero-where">
          <a href=${mapHref(cfg.contacts)} target="_blank" rel="noopener"><${Icon} name="pin" size=18 />${cfg.contacts.address}</a>
          <a href=${telHref(cfg.contacts.phone)}><${Icon} name="phone" size=18 />${cfg.contacts.phone}</a>
        </div>
      </div>
      <div class="hero-table" aria-hidden="true">
        ${items.map((it, i) => html`<img key=${it.id} class=${'plate plate-' + (i + 1)} src=${it.image} alt="" referrerpolicy="no-referrer" />`)}
        ${d.enabled && html`<div class="sticker"><div>доставка<br /><b>бесплатно</b>от ${rub(d.freeFrom)}</div></div>`}
      </div>
    </div>
  </section>`;
}

/* ───────── меню ───────── */

function MenuSection({ cfg, menu, menuError, reload, layout, setLayout, wide, qtyFor, onAdd, onDec, onOpen, aside }) {
  const d = cfg.delivery;
  return html`<section class="section menu-section" id="menu">
    <div class="container">
      <div class="section-head">
        <h2>Меню</h2>
        <p>Выбирайте блюда — заказ можно оформить на доставку или забрать самому.</p>
      </div>
      <div class="qr-hint"><${Icon} name="qr" size=28 /><span>Вы уже в кафе? Наведите камеру телефона на QR-код на столе: меню откроется с номером вашего стола, там можно заказывать за каждого гостя и платить раздельно.</span></div>
      ${!d.enabled && html`<div class="notice notice-danger" style="margin-bottom:16px"><${Icon} name="warn" /><span>Приём заказов на доставку сейчас приостановлен. Позвоните нам: <a href=${telHref(cfg.contacts.phone)}>${cfg.contacts.phone}</a>.</span></div>`}
      ${d.enabled && !cfg.open.open && html`<div class="notice" style="margin-bottom:16px"><${Icon} name="clock" /><span>Сейчас закрыто. Заказ можно оформить ко времени, когда мы откроемся.</span></div>`}
      <div class="menu-wrap">
        ${menu
          ? html`<${MenuView}
              menu=${menu}
              layout=${layout}
              onLayout=${setLayout}
              allowLayoutToggle=${!wide}
              qtyFor=${qtyFor}
              totalQtyFor=${qtyFor}
              onAdd=${onAdd}
              onDec=${onDec}
              onOpen=${onOpen}
              spyOffset=${wide ? 140 : 132}
            />`
          : menuError
            ? html`<div class="empty"><h3>Меню не загрузилось</h3><p>${menuError}</p><button class="btn" onClick=${reload}>Попробовать снова</button></div>`
            : html`<div style="display:grid;gap:14px"><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:120px"></div></div>`}
        <aside class="cart-aside" aria-label="Корзина">${aside}</aside>
      </div>
    </div>
  </section>`;
}

function CartPanel({ cfg, lines, index, bad, onQty, onClear, onCheckout, bare = false }) {
  const { count: n, total } = cartSummary(lines, index);
  const d = cfg.delivery;
  const left = Math.max(0, d.freeFrom - total);
  const pct = Math.min(100, Math.round((total / d.freeFrom) * 100));
  const blocked = !d.enabled || bad.length > 0 || total < d.minOrder;

  if (!lines.length) {
    return html`<div class="stack">
      ${!bare && html`<div class="cart-title"><h3>Ваш заказ</h3></div>`}
      <div class="empty" style="padding:28px 8px"><${Icon} name="bag" size=40 stroke=1.5 /><p>Корзина пуста. Добавьте блюда из меню — цены и фото уже ждут.</p></div>
      ${d.enabled && html`<div class="free-note muted">Доставка по Снежинску бесплатна от ${rub(d.freeFrom)}.</div>`}
    </div>`;
  }

  return html`<div class="stack" style="gap:14px">
    ${!bare && html`<div class="cart-title"><h3>Ваш заказ</h3><button onClick=${onClear}>Очистить</button></div>`}
    ${bare && html`<div class="cart-title"><span class="muted">${count(n, 'блюдо', 'блюда', 'блюд')}</span><button onClick=${onClear}>Очистить корзину</button></div>`}
    ${bad.length > 0 && html`<div class="notice notice-danger"><${Icon} name="warn" /><span>Некоторых блюд уже нет в наличии. Уберите их, чтобы оформить заказ.</span></div>`}
    <div>
      ${lines.map((l) => {
        const e = index.get(l.dishId);
        const key = lineKey(l);
        const isBad = bad.includes(l);
        const sub = [...(e ? optionLabels(e.item, l.options) : []), l.note && `«${l.note}»`].filter(Boolean).join(' · ');
        return html`<div class="cline" key=${key}>
          <div class="cline-name" style=${isBad ? 'color:var(--danger)' : ''}>${e?.item.name || 'Блюдо убрали из меню'}${isBad ? ' — недоступно' : ''}</div>
          <div class="cline-price num">${e ? rub(unitPrice(e.item, l.options) * l.qty) : ''}</div>
          <div class="cline-sub">${sub}</div>
          <${Stepper} value=${l.qty} flat onInc=${() => onQty(key, l.qty + 1)} onDec=${() => onQty(key, l.qty - 1)} label=${e?.item.name} />
        </div>`;
      })}
    </div>
    ${d.enabled && html`<div class="free-note">
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}><i style=${{ width: pct + '%' }}></i></div>
      <span>${left > 0 ? html`Добавьте ещё на <b class="num">${rub(left)}</b> — доставка будет бесплатной` : html`<b>Доставка бесплатная</b> — заказ от ${rub(d.freeFrom)}`}</span>
    </div>`}
    <div class="cart-sum"><div class="total"><span>Блюда</span><span class="num">${rub(total)}</span></div></div>
    ${total < d.minOrder && html`<p class="muted" style="font-size:14px">Минимальная сумма заказа — ${rub(d.minOrder)}.</p>`}
    <button class="btn btn-accent btn-lg btn-block" disabled=${blocked} onClick=${onCheckout}>Оформить заказ</button>
  </div>`;
}

/* ───────── оформление ───────── */

const EMPTY_PROFILE = { name: '', phone: '', street: '', house: '', apt: '', entrance: '', floor: '', intercom: '' };

function Checkout({ open, onClose, cfg, lines, index, onChanged, onDone }) {
  const d = cfg.delivery;
  const [profile, setProfile] = useStored('dacha:profile', EMPTY_PROFILE);
  const [type, setType] = useState('delivery');
  const [when, setWhen] = useState('asap');
  const [slots, setSlots] = useState({ slots: [], availability: { asap: true } });
  const [payment, setPayment] = useState('cash');
  const [change, setChange] = useState('');
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState(null);
  const [comment, setComment] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bad, setBad] = useState({});
  const bodyRef = useRef(null);

  const methods = Object.keys(PAY_LABELS).filter((m) => cfg.payments[m]);
  // функциональное обновление: автозаполнение браузера присылает несколько input подряд
  const set = (k, v) => setProfile((p) => ({ ...p, [k]: v }));
  const { total: subtotal } = cartSummary(lines, index);
  const discount = promo ? Math.round((subtotal * promo.percent) / 100) : 0;
  const fee = type === 'delivery' && subtotal < d.freeFrom ? d.fee : 0;
  const total = subtotal - discount + fee;

  useEffect(() => {
    if (!open) return;
    setError('');
    setBad({});
    api.get('/api/delivery/slots').then((s) => {
      setSlots(s);
      setWhen((w) => (s.availability.asap ? w : w === 'asap' ? s.slots[0]?.value || 'asap' : w));
    }).catch(() => {});
    if (!methods.includes(payment)) setPayment(methods[0]);
  }, [open]);

  useEffect(() => {
    if (promo) setPromo(null);
  }, [subtotal]);

  const applyPromo = async () => {
    if (!promoInput.trim()) return;
    try {
      const r = await api.post('/api/promo', { code: promoInput, subtotal });
      setPromo(r);
      toast(`Промокод ${r.code}: скидка ${r.percent}%`);
    } catch (e) {
      setPromo(null);
      toast(e.message, 'err');
    }
  };

  const validate = () => {
    const b = {};
    if (profile.name.trim().length < 2) b.name = 'Укажите имя';
    if (!normalizePhone(profile.phone)) b.phone = 'Введите номер: 10 цифр после +7';
    if (type === 'delivery') {
      if (!profile.street.trim()) b.street = 'Укажите улицу';
      if (!profile.house.trim()) b.house = 'Укажите дом';
    }
    if (payment === 'cash' && change && Number(change) < total) b.change = `Сумма должна быть не меньше ${rub(total)}`;
    if (!consent) b.consent = 'Нужно согласие на обработку данных';
    setBad(b);
    if (Object.keys(b).length) {
      requestAnimationFrame(() => bodyRef.current?.querySelector('[aria-invalid="true"]')?.focus());
      return false;
    }
    return true;
  };

  const submit = async () => {
    if (busy || !validate()) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/api/delivery/order', {
        type,
        name: profile.name,
        phone: profile.phone,
        address: type === 'delivery' ? { street: profile.street, house: profile.house, apt: profile.apt, entrance: profile.entrance, floor: profile.floor, intercom: profile.intercom } : undefined,
        when,
        payment,
        changeFrom: payment === 'cash' ? Number(change) || 0 : 0,
        promo: promo?.code || '',
        comment,
        consent: true,
        lines: lines.map(({ dishId, qty, options, note }) => ({ dishId, qty, options, note })),
      });
      onDone({ ...r.order, delivered: r.delivered });
      setComment('');
      setPromo(null);
      setPromoInput('');
    } catch (e) {
      setError(e.message);
      if (e.data?.problems) onChanged(e.data.problems);
    } finally {
      setBusy(false);
    }
  };

  const invalid = (k) => (bad[k] ? 'true' : undefined);
  const dayGroups = { today: slots.slots.filter((s) => s.day === 'today'), tomorrow: slots.slots.filter((s) => s.day === 'tomorrow') };

  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    title="Оформление заказа"
    class="wide"
    footer=${html`${error && html`<div class="notice notice-danger"><${Icon} name="warn" /><span>${error}</span></div>`}
      <div class="cart-sum">
        <div><span>Блюда</span><span class="num">${rub(subtotal)}</span></div>
        ${discount > 0 && html`<div><span>Скидка ${promo.code}</span><span class="num">−${rub(discount)}</span></div>`}
        ${type === 'delivery' && html`<div><span>Доставка</span><span class="num">${fee ? rub(fee) : 'бесплатно'}</span></div>`}
        <div class="total"><span>Итого</span><span class="num">${rub(total)}</span></div>
      </div>
      <button class="btn btn-accent btn-lg btn-block" disabled=${busy} onClick=${submit}>${busy ? 'Отправляем…' : `Заказать · ${rub(total)}`}</button>`}
  >
    <div ref=${bodyRef}>
      ${(d.pickupEnabled) && html`<div class="form-section">
        <div class="seg" role="group" aria-label="Способ получения">
          <button aria-pressed=${type === 'delivery'} onClick=${() => setType('delivery')}><${Icon} name="bike" size=20 style="display:inline;vertical-align:-4px;margin-right:6px" />Доставка</button>
          <button aria-pressed=${type === 'pickup'} onClick=${() => setType('pickup')}><${Icon} name="bag2" size=20 style="display:inline;vertical-align:-4px;margin-right:6px" />Самовывоз</button>
        </div>
        ${type === 'pickup' && html`<p class="muted" style="font-size:14.5px">Заберёте заказ сами: ${cfg.contacts.address}, ${cfg.contacts.place}.</p>`}
      </div>`}

      <div class="form-section">
        <h3>Контакты</h3>
        <div class="form-grid">
          <div class="field"><label for="c-name">Имя</label><input id="c-name" class="input" autocomplete="given-name" aria-invalid=${invalid('name')} value=${profile.name} onInput=${(e) => set('name', e.currentTarget.value)} />${bad.name && html`<span class="hint" style="color:var(--danger)">${bad.name}</span>`}</div>
          <div class="field"><label for="c-phone">Телефон</label><input id="c-phone" class="input" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" aria-invalid=${invalid('phone')} value=${profile.phone} onInput=${(e) => set('phone', e.currentTarget.value)} />${bad.phone && html`<span class="hint" style="color:var(--danger)">${bad.phone}</span>`}</div>
        </div>
      </div>

      ${type === 'delivery' && html`<div class="form-section">
        <h3>Адрес доставки</h3>
        <p class="muted" style="font-size:14px;margin-top:-4px">${d.area}</p>
        <div class="form-grid">
          <div class="field span-2"><label for="c-street">Улица</label><input id="c-street" class="input" autocomplete="street-address" aria-invalid=${invalid('street')} value=${profile.street} onInput=${(e) => set('street', e.currentTarget.value)} />${bad.street && html`<span class="hint" style="color:var(--danger)">${bad.street}</span>`}</div>
          <div class="field"><label for="c-house">Дом</label><input id="c-house" class="input" aria-invalid=${invalid('house')} value=${profile.house} onInput=${(e) => set('house', e.currentTarget.value)} /></div>
          <div class="field"><label for="c-apt">Квартира</label><input id="c-apt" class="input" value=${profile.apt} onInput=${(e) => set('apt', e.currentTarget.value)} /></div>
        </div>
        <div class="form-grid thirds">
          <div class="field"><label for="c-ent">Подъезд</label><input id="c-ent" class="input" value=${profile.entrance} onInput=${(e) => set('entrance', e.currentTarget.value)} /></div>
          <div class="field"><label for="c-floor">Этаж</label><input id="c-floor" class="input" value=${profile.floor} onInput=${(e) => set('floor', e.currentTarget.value)} /></div>
          <div class="field"><label for="c-int">Домофон</label><input id="c-int" class="input" value=${profile.intercom} onInput=${(e) => set('intercom', e.currentTarget.value)} /></div>
        </div>
      </div>`}

      <div class="form-section">
        <h3>${type === 'delivery' ? 'Когда привезти' : 'Когда заберёте'}</h3>
        <div class="field">
          <select class="select" aria-label="Время" value=${when} onChange=${(e) => setWhen(e.currentTarget.value)}>
            ${slots.availability.asap && html`<option value="asap">Как можно скорее${d.eta ? ` (около ${d.eta})` : ''}</option>`}
            ${dayGroups.today.length > 0 && html`<optgroup label="Сегодня">${dayGroups.today.map((s) => html`<option key=${'t' + s.value} value=${s.value}>к ${s.value}</option>`)}</optgroup>`}
            ${dayGroups.tomorrow.length > 0 && html`<optgroup label="Завтра">${dayGroups.tomorrow.map((s) => html`<option key=${'n' + s.value} value=${s.value}>к ${s.value}</option>`)}</optgroup>`}
          </select>
          ${!slots.availability.asap && html`<span class="hint">${slots.availability.reason === 'closed' ? 'Сейчас закрыто — выберите время, когда будем работать.' : slots.availability.reason === 'late' ? 'Сегодня приём заказов почти закончен — выберите время.' : 'Выберите время.'}</span>`}
        </div>
      </div>

      <div class="form-section">
        <h3>Оплата ${type === 'delivery' ? 'курьеру' : 'при получении'}</h3>
        <div class="pay-tiles" role="radiogroup">
          ${methods.map((m) => html`<button key=${m} class="pay-method" role="radio" aria-checked=${payment === m} onClick=${() => setPayment(m)}><${Icon} name=${PAY_LABELS[m][1]} size=28 />${PAY_LABELS[m][0]}</button>`)}
        </div>
        ${payment === 'cash' && html`<div class="field"><label for="c-change">Приготовить сдачу с (необязательно)</label><input id="c-change" class="input" inputmode="numeric" placeholder="Например, 2000" aria-invalid=${invalid('change')} value=${change} onInput=${(e) => setChange(e.currentTarget.value.replace(/\D/g, ''))} />${bad.change && html`<span class="hint" style="color:var(--danger)">${bad.change}</span>`}</div>`}
      </div>

      ${cfg.promo && html`<div class="form-section">
        <h3>Промокод</h3>
        <div class="promo-row">
          <input class="input" placeholder="Если есть" aria-label="Промокод" value=${promoInput} onInput=${(e) => setPromoInput(e.currentTarget.value)} />
          <button class="btn btn-quiet" onClick=${applyPromo}>Применить</button>
        </div>
        ${promo && html`<div class="notice notice-ok"><${Icon} name="check" /><span>Скидка ${promo.percent}% применена</span></div>`}
      </div>`}

      <div class="form-section">
        <h3>Комментарий</h3>
        <textarea class="textarea" maxlength="300" placeholder="Например: позвоните за 10 минут, не звоните в дверь" value=${comment} onInput=${(e) => setComment(e.currentTarget.value)}></textarea>
      </div>

      <div class="form-section">
        <label class="check"><input type="checkbox" checked=${consent} aria-invalid=${invalid('consent')} onChange=${(e) => setConsent(e.currentTarget.checked)} /><span>Я согласен на обработку персональных данных для выполнения заказа. <a href="/privacy" target="_blank" rel="noopener">Политика конфиденциальности</a></span></label>
        ${bad.consent && html`<span class="hint" style="color:var(--danger)">${bad.consent}</span>`}
      </div>
    </div>
  <//>`;
}

function DoneSheet({ open, onClose, cfg, done }) {
  const [status, setStatus] = useState('new');
  useEffect(() => {
    if (done) setStatus(done.status || 'new');
  }, [done?.token]);
  usePolling(async () => {
    if (!open || !done) return;
    const r = await api.get('/api/delivery/order/' + done.token);
    setStatus(r.status);
  }, 8000, [open, done?.token]);

  if (!done) return null;
  const pickup = done.fulfil === 'pickup';
  const steps = [
    ['new', 'Заказ отправлен в кафе', 'Сейчас его подтвердят'],
    ['accepted', 'Заказ принят', 'Готовим'],
    pickup ? ['ready', 'Готов к выдаче', cfg.contacts.address] : ['onway', 'Курьер выехал', 'Скоро будет у вас'],
    ['done', pickup ? 'Заказ выдан' : 'Заказ доставлен', 'Приятного аппетита!'],
  ];
  const order = steps.map((s) => s[0]);
  const cur = status === 'cancelled' ? -1 : order.indexOf(status);

  return html`<${Sheet} open=${open} onClose=${onClose} label="Заказ принят" title=${`Заказ № ${done.num}`}>
    <div class="stack" style="gap:20px">
      ${status === 'cancelled'
        ? html`<div class="notice notice-danger"><${Icon} name="warn" /><span>Заказ отменён. Если это неожиданно — позвоните нам: <a href=${telHref(cfg.contacts.phone)}>${cfg.contacts.phone}</a>.</span></div>`
        : html`<ol class="order-status">
            ${steps.map(([key, title, sub], i) => html`<li key=${key} class=${i < cur ? 'done' : i === cur ? 'now' : ''}><div>${title}${i === cur && html`<small>${sub}</small>`}</div></li>`)}
          </ol>`}
      ${!done.delivered && html`<div class="notice"><${Icon} name="info" /><span>Заказ сохранён. Если в течение 15 минут нам не получится вам позвонить, наберите нас: <a href=${telHref(cfg.contacts.phone)}>${cfg.contacts.phone}</a>.</span></div>`}
      <div class="cart-sum"><div class="total"><span>К оплате ${pickup ? 'при получении' : 'курьеру'}</span><span class="num">${rub(done.total)}</span></div></div>
      <button class="btn btn-ghost btn-lg" onClick=${onClose}>Закрыть</button>
    </div>
  <//>`;
}

/* ───────── доставка ───────── */

function DeliverySection({ cfg, onMenu }) {
  const d = cfg.delivery;
  const groups = groupHours(cfg.hours);
  const rest = groups.slice(1).map((g) => `${g.days} — ${g.text.replace('–', '–')}`).join(', ');
  return html`<section class="section delivery" id="delivery">
    <div class="container">
      <div class="section-head">
        <h2>Доставка по Снежинску</h2>
        <p>${d.enabled ? 'Привезём из кафе домой или в офис. Оставайтесь дома и кушайте наши вкусняшки.' : 'Сейчас доставка приостановлена — позвоните нам, подскажем, что можно сделать.'}</p>
      </div>
      <ul class="facts">
        <li><b>от ${rub(d.freeFrom)}</b><span>Доставка бесплатная. ${d.area}.${d.fee ? ` Если заказ меньше — доставка ${rub(d.fee)}.` : ''}</span></li>
        <li><b>${d.eta || 'по звонку'}</b><span>Ориентировочное время доставки. Самовывоз — быстрее, заказ ждёт в кафе.</span></li>
        <li><b>${groups[0]?.text || ''}</b><span>${groups[0]?.days}. ${rest ? `Ещё: ${rest}.` : ''} Заказы принимаем до закрытия.</span></li>
      </ul>
      <div class="delivery-note">
        <button class="btn btn-lg" onClick=${onMenu}>Выбрать блюда</button>
        <span><${Icon} name="phone" size=20 />Или по телефону <a href=${telHref(cfg.contacts.phone)} style="font-weight:700">${cfg.contacts.phone}</a></span>
      </div>
    </div>
  </section>`;
}

/* ───────── залы и банкеты ───────── */

function HallsSection({ cfg }) {
  const max = Math.max(...cfg.halls.map((h) => h.seats), 1);
  return html`<section class="section" id="halls">
    <div class="container halls-grid">
      <div>
        <div class="section-head">
          <h2>Четыре зала — компании друг другу не мешают</h2>
          <p>Тихая встреча друзей, день рождения, свадьба или корпоратив: в одном зале уютно вдвоём, в другом разместим большой праздник.</p>
        </div>
        <ul class="hall-rows">
          ${cfg.halls.map((h) => html`<li class="hall-row" key=${h.id}>
            <div class="hall-name"><b>${h.name}</b><span>до ${h.seats} человек</span></div>
            <div class="hall-bar" style=${{ width: Math.max(10, (h.seats / max) * 100) + '%' }}></div>
          </li>`)}
        </ul>
      </div>
      <div class="banquet">
        <h3>Банкеты и корпоративы</h3>
        <p>От 10 до 75 человек. Администрация поможет подобрать диджея и ведущего для вашего праздника.</p>
        ${cfg.banquet.map((b) => html`<div class="banquet-price" key=${b.name}>
          <div class="label">${b.name}</div>
          <div class="prices">${b.prices.map((p) => html`<span key=${p}>${rub(p)}</span>`)}</div>
        </div>`)}
        <p style="font-size:14.5px">Состав банкетных меню и детали — по телефону или в заявке ниже.</p>
        <a class="btn btn-lg" href="#reserve" onClick=${() => window.dispatchEvent(new CustomEvent('dacha:banquet'))}><${Icon} name="gift" size=22 />Оставить заявку на банкет</a>
      </div>
    </div>
  </section>`;
}

/* ───────── отзывы ───────── */

function ReviewsSection() {
  return html`<section class="section" id="reviews" style="padding-top:0">
    <div class="container">
      <div class="section-head"><h2>Гости о Даче</h2></div>
      <div class="quotes">
        ${REVIEWS.map((r) => html`<figure class="quote" key=${r.name}><blockquote>${r.text}</blockquote><figcaption>${r.name}</figcaption></figure>`)}
      </div>
    </div>
  </section>`;
}

/* ───────── контакты и бронь ───────── */

function timeOptions(cfg, ymd) {
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  const h = cfg.hours[DAY_KEYS[dow]];
  if (!h) return [];
  const a = toMin(h[0]);
  let b = toMin(h[1]);
  if (b <= a) b = 1440;
  const now = localParts(cfg.timezone);
  const out = [];
  for (let m = a; m <= b - 30; m += 30) {
    if (ymd === now.ymd && m < now.minutes + 30) continue;
    out.push(fromMin(m));
  }
  return out;
}

function ContactsSection({ cfg }) {
  const groups = groupHours(cfg.hours);
  return html`<section class="section" id="contacts" style="background:var(--surface-2)">
    <div class="container contacts-grid">
      <div>
        <div class="section-head"><h2>Как нас найти</h2></div>
        <ul class="info-list">
          <li><${Icon} name="pin" size=24 /><div><div class="k">Адрес</div><a href=${mapHref(cfg.contacts)} target="_blank" rel="noopener">${cfg.contacts.address}</a><div class="muted">${cfg.contacts.place}</div></div></li>
          <li><${Icon} name="phone" size=24 /><div><div class="k">Телефон</div><a href=${telHref(cfg.contacts.phone)}>${cfg.contacts.phone}</a>${cfg.contacts.phone2 && html`<br /><a href=${telHref(cfg.contacts.phone2)}>${cfg.contacts.phone2}</a>`}</div></li>
          <li><${Icon} name="clock" size=24 /><div><div class="k">Часы работы</div><div class="hours-list">${groups.map((g) => html`<div key=${g.days}><b>${g.days}</b><span>${g.text}</span></div>`)}</div></div></li>
          ${cfg.contacts.email && html`<li><${Icon} name="send" size=24 /><div><div class="k">Почта</div><a href=${'mailto:' + cfg.contacts.email}>${cfg.contacts.email}</a></div></li>`}
          ${cfg.contacts.vk && html`<li><${Icon} name="vk" size=24 /><div><div class="k">ВКонтакте</div><a href=${cfg.contacts.vk} target="_blank" rel="noopener">Сообщество кафе</a></div></li>`}
        </ul>
      </div>
      <${ReserveForm} cfg=${cfg} />
    </div>
  </section>`;
}

function ReserveForm({ cfg }) {
  const today = localParts(cfg.timezone).ymd;
  const maxDate = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  const [profile] = useStored('dacha:profile', EMPTY_PROFILE);
  const [kind, setKind] = useState('table');
  const [f, setF] = useState({ name: profile.name || '', phone: profile.phone || '', date: today, time: '', guests: 4, hallId: '', comment: '' });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);
  const times = useMemo(() => timeOptions(cfg, f.date), [cfg, f.date]);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    const onBanquet = () => (setKind('banquet'), set('guests', 20));
    window.addEventListener('dacha:banquet', onBanquet);
    return () => window.removeEventListener('dacha:banquet', onBanquet);
  }, []);

  useEffect(() => {
    if (!times.includes(f.time)) set('time', times.includes('19:00') ? '19:00' : times[0] || '');
  }, [times.join()]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!consent) return setError('Нужно согласие на обработку персональных данных');
    setBusy(true);
    try {
      const r = await api.post('/api/reserve', { ...f, kind, consent: true });
      setSent({ delivered: r.delivered, num: r.num });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return html`<div class="reserve" id="reserve">
      <div class="success-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
      <h3>Заявка № ${sent.num} отправлена</h3>
      <p>${sent.delivered ? 'Администратор получил заявку и свяжется с вами, чтобы подтвердить.' : 'Заявка сохранена. Если мы не перезвоним в течение часа — наберите нас, пожалуйста.'} Телефон: <a href=${telHref(cfg.contacts.phone)}>${cfg.contacts.phone}</a>.</p>
      <button class="btn btn-ghost" onClick=${() => setSent(null)}>Отправить ещё одну</button>
    </div>`;
  }

  return html`<form class="reserve" id="reserve" onSubmit=${submit} novalidate>
    <h3>${kind === 'banquet' ? 'Заявка на банкет' : 'Забронировать столик'}</h3>
    <p>Оставьте заявку — администратор перезвонит и подтвердит.</p>
    <div class="seg" role="group" aria-label="Тип заявки">
      <button type="button" aria-pressed=${kind === 'table'} onClick=${() => setKind('table')}>Столик</button>
      <button type="button" aria-pressed=${kind === 'banquet'} onClick=${() => setKind('banquet')}>Банкет</button>
    </div>
    <div class="form-grid">
      <div class="field"><label for="r-name">Имя</label><input id="r-name" class="input" autocomplete="given-name" value=${f.name} onInput=${(e) => set('name', e.currentTarget.value)} required /></div>
      <div class="field"><label for="r-phone">Телефон</label><input id="r-phone" class="input" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" value=${f.phone} onInput=${(e) => set('phone', e.currentTarget.value)} required /></div>
      <div class="field"><label for="r-date">Дата</label><input id="r-date" class="input" type="date" min=${today} max=${maxDate} value=${f.date} onInput=${(e) => set('date', e.currentTarget.value)} /></div>
      <div class="field"><label for="r-time">Время</label>
        <select id="r-time" class="select" value=${f.time} onChange=${(e) => set('time', e.currentTarget.value)}>${times.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}${!times.length && html`<option value="">нет свободного времени</option>`}</select>
      </div>
      <div class="field"><label>Гостей</label>
        <div class="guest-counter"><${Stepper} flat minOne value=${f.guests} onInc=${() => set('guests', Math.min(120, f.guests + 1))} onDec=${() => set('guests', Math.max(1, f.guests - 1))} label="Количество гостей" /><span class="muted">${plural(f.guests, 'гость', 'гостя', 'гостей')}</span></div>
      </div>
      <div class="field"><label for="r-hall">Зал</label>
        <select id="r-hall" class="select" value=${f.hallId} onChange=${(e) => set('hallId', e.currentTarget.value)}><option value="">Любой</option>${cfg.halls.map((h) => html`<option key=${h.id} value=${h.id}>${h.name} — до ${h.seats}</option>`)}</select>
      </div>
      <div class="field span-2"><label for="r-comment">Комментарий</label><textarea id="r-comment" class="textarea" maxlength="300" placeholder=${kind === 'banquet' ? 'Повод, пожелания по меню, нужен ли ведущий' : 'Например: детский стульчик, окно'} value=${f.comment} onInput=${(e) => set('comment', e.currentTarget.value)}></textarea></div>
    </div>
    <label class="check"><input type="checkbox" checked=${consent} onChange=${(e) => setConsent(e.currentTarget.checked)} /><span>Согласен на обработку персональных данных. <a href="/privacy" target="_blank" rel="noopener">Политика конфиденциальности</a></span></label>
    ${error && html`<div class="notice notice-danger"><${Icon} name="warn" /><span>${error}</span></div>`}
    <button class="btn btn-lg" type="submit" disabled=${busy || !times.length}>${busy ? 'Отправляем…' : 'Отправить заявку'}</button>
  </form>`;
}

function Footer({ cfg }) {
  return html`<footer class="site-footer">
    <div class="container">
      <div style="display:grid;gap:14px">
        <a class="brand" href="/"><${Plaque}>${cfg.brand.name}<//><span class="brand-sub">для<br />друзей</span></a>
        <p>${cfg.brand.tagline}. ${cfg.contacts.address}, ${cfg.contacts.place}.</p>
      </div>
      <div class="footer-links"><a href="/privacy">Политика конфиденциальности</a>${cfg.contacts.vk && html`<a href=${cfg.contacts.vk} target="_blank" rel="noopener">ВКонтакте</a>`}<a href=${telHref(cfg.contacts.phone)}>${cfg.contacts.phone}</a></div>
    </div>
  </footer>`;
}

render(html`<${App} />`, document.getElementById('app'));
