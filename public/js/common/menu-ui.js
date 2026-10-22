// Витрина меню: поиск, навигация по разделам, блюда списком/сеткой/карточками, лист с вариантами и «кому».
import { html, useState, useEffect, useRef, useMemo } from './lib.js';
import { Icon } from './icons.js';
import { Sheet, Stepper, Avatar, Photo, Empty, Fragment, cx } from './ui.js';
import { num, rub } from './format.js';
import { unitPrice, needsChoice } from './menu-core.js';
import { SHARED } from './bill.js';

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

export function Price({ value }) {
  return html`<div class="dish-price"><span>${num(value)}<small>₽</small></span></div>`;
}

export function DishTags({ item }) {
  return html`<${Fragment}>
    ${item.tags.includes('veg') && html`<span class="badge badge-leaf"><${Icon} name="leaf" />без мяса</span>`}
    ${item.tags.includes('spicy') && html`<span class="badge badge-hot"><${Icon} name="flame" />острое</span>`}
    ${item.tags.includes('new') && html`<span class="badge badge-primary">новинка</span>`}
  <//>`;
}

/** Одно блюдо. Кнопка «+» превращается в степпер, когда блюдо уже в заказе. */
export function DishRow({ item, qty, totalQty, locked, onAdd, onDec, onOpen }) {
  const stop = item.stop;
  const noPhoto = !item.image;
  const [bump, setBump] = useState(0);
  const quick = () => {
    setBump((b) => b + 1);
    onAdd(item);
  };

  return html`<article class=${cx('dish', stop && 'is-stop', noPhoto && 'no-photo')} data-id=${item.id}>
    <div class="dish-body" onClick=${() => onOpen(item)} role="button" tabindex="0" onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(item))} aria-label=${`${item.name}, подробнее`}>
      <h3 class="dish-name">${item.name}</h3>
      ${item.desc && html`<p class="dish-desc">${item.desc}</p>`}
      <div class="dish-meta">
        ${item.weight && html`<span>${item.weight}</span>`}
        <${DishTags} item=${item} />
      </div>
      <${Price} value=${item.price} />
    </div>
    <div class="dish-media">
      ${!noPhoto && html`<${Photo} src=${item.image} alt=${item.name} />`}
      ${item.hit && !stop && html`<span class="dish-hit"><${Icon} name="star" size=13 />Хит</span>`}
      ${stop && !noPhoto && html`<span class="dish-stop">Закончилось</span>`}
      ${stop && noPhoto && html`<span class="badge badge-danger">Закончилось</span>`}
      ${!stop && locked && html`<span class=${noPhoto ? 'badge' : 'dish-stop'}>${locked}</span>`}
      ${!stop && !locked && html`<div class="dish-ctl">
        ${qty > 0
          ? html`<${Stepper} value=${qty} onInc=${quick} onDec=${() => onDec(item)} label=${item.name} />`
          : html`<button key=${bump} class=${cx('dish-add', bump && 'bump')} onClick=${quick} aria-label=${`Добавить: ${item.name}`}><${Icon} name="plus" size=24 stroke=2.2 /></button>`}
        ${totalQty > qty && html`<span class="dish-qty-badge" title="Всего за столом">${totalQty}</span>`}
      </div>`}
    </div>
  </article>`;
}

/** Круглые фото разделов: нажал — прокрутило к разделу */
export function CategoryNav({ cats, activeId, onSelect }) {
  const scroller = useRef(null);
  useEffect(() => {
    const sc = scroller.current;
    const el = sc?.querySelector(`[data-cat="${activeId}"]`);
    if (!sc || !el) return;
    const left = el.offsetLeft - (sc.clientWidth - el.offsetWidth) / 2;
    sc.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }, [activeId]);

  return html`<nav class="catnav" aria-label="Разделы меню">
    <div class="catnav-scroll" ref=${scroller}>
      ${cats.map((c) => {
        const img = c.items.find((i) => i.image)?.image;
        return html`<button key=${c.id} class="catpill" data-cat=${c.id} aria-current=${activeId === c.id ? 'true' : 'false'} onClick=${() => onSelect(c.id)}>
          ${img ? html`<img class="catpill-img" src=${img} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${(e) => (e.currentTarget.style.visibility = 'hidden')} />` : html`<span class="catpill-text"></span>`}
          <span>${c.name}</span>
        </button>`;
      })}
    </div>
  </nav>`;
}

export function useScrollSpy(ids, offset) {
  const [active, setActive] = useState(ids[0]);
  const key = ids.join(',');
  useEffect(() => {
    if (!ids.length) return;
    let raf = 0;
    const calc = () => {
      raf = 0;
      let cur = ids[0];
      for (const id of ids) {
        const el = document.getElementById('cat-' + id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - offset <= 6) cur = id;
        else break;
      }
      setActive(cur);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(calc);
    };
    calc();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [key, offset]);
  return [active, setActive];
}

export function scrollToCategory(id) {
  const el = document.getElementById('cat-' + id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Вся витрина: поиск, переключатель вида, навигация, разделы.
 * Логику корзины ведёт родитель — сюда приходят qtyFor / onAdd / onDec / onOpen.
 */
export function MenuView({ menu, layout, onLayout, allowLayoutToggle = true, defaultLayouts = ['list', 'big'], qtyFor, totalQtyFor, onAdd, onDec, onOpen, spyOffset = 110, header = null }) {
  const [query, setQuery] = useState('');
  const q = norm(query).trim();
  const tokens = q ? q.split(/\s+/) : [];

  const cats = useMemo(() => {
    if (!tokens.length) return menu.categories;
    return menu.categories
      .map((c) => ({ ...c, items: c.items.filter((i) => tokens.every((t) => norm(i.name + ' ' + i.desc).includes(t))) }))
      .filter((c) => c.items.length);
  }, [menu, q]);

  const ids = cats.map((c) => c.id);
  const [active, setActive] = useScrollSpy(ids, spyOffset);

  const select = (id) => {
    setActive(id);
    scrollToCategory(id);
  };

  return html`<div class="menu-view">
    ${header}
    <div class="menu-toolbar">
      <div class="searchbox">
        <${Icon} name="search" size=20 />
        <input class="input" type="search" placeholder="Найти блюдо" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} aria-label="Поиск по меню" enterkeyhint="search" />
        ${query && html`<button class="clear" onClick=${() => setQuery('')} aria-label="Очистить поиск"><${Icon} name="x" size=18 /></button>`}
      </div>
      ${allowLayoutToggle && html`<div class="layout-toggle" role="group" aria-label="Вид меню">
        <button aria-pressed=${layout === defaultLayouts[0]} onClick=${() => onLayout(defaultLayouts[0])} aria-label="Списком"><${Icon} name="list" size=20 /></button>
        <button aria-pressed=${layout === defaultLayouts[1]} onClick=${() => onLayout(defaultLayouts[1])} aria-label="С крупными фото"><${Icon} name="grid" size=20 /></button>
      </div>`}
    </div>
    ${cats.length > 0 && html`<${CategoryNav} cats=${cats} activeId=${active} onSelect=${select} />`}
    ${cats.length === 0 && html`<${Empty} icon="search" title="Ничего не нашли" text="Попробуйте другое слово — например, «пицца» или «суп»."><button class="btn btn-quiet" onClick=${() => setQuery('')}>Показать всё меню</button><//>`}
    ${cats.map(
      (c) => html`<section class="menu-cat" id=${'cat-' + c.id} key=${c.id}>
        <header class="menu-cat-head"><h2>${c.name}</h2>${c.note && html`<span class="note">${c.note}</span>`}</header>
        ${!c.available && html`<div class="notice menu-cat-closed"><${Icon} name="clock" /><span>Этот раздел доступен с ${c.from} до ${c.to}.</span></div>`}
        <div class="dish-list" data-layout=${layout}>
          ${c.items.map((item) => html`<${DishRow} key=${item.id} item=${item} qty=${qtyFor(item)} totalQty=${totalQtyFor(item)} locked=${!c.available ? `с ${c.from}` : ''} onAdd=${onAdd} onDec=${onDec} onOpen=${onOpen} />`)}
        </div>
      </section>`,
    )}
  </div>`;
}

/* ───────── «Кому»: гости и общее блюдо ───────── */

export function WhoPicker({ guests, value, among, onChange }) {
  const toggle = (id) => {
    const set = new Set(among);
    set.has(id) ? set.delete(id) : set.add(id);
    if (set.size) onChange({ who: SHARED, among: [...set] });
  };
  return html`<div>
    <div class="who-grid" role="radiogroup" aria-label="Для кого блюдо">
      ${guests.map((g) => html`<button key=${g.id} class="chip" role="radio" aria-checked=${value === g.id} onClick=${() => onChange({ who: g.id, among })}><${Avatar} guest=${g} size=28 />${g.name}</button>`)}
      ${guests.length > 1 && html`<button class="chip" role="radio" aria-checked=${value === SHARED} onClick=${() => onChange({ who: SHARED, among: among.length ? among : guests.map((g) => g.id) })}><${Avatar} shared size=28 />На всех</button>`}
    </div>
    ${value === SHARED && html`<div class="sharewith">
      <span>Стоимость поделим поровну между:</span>
      <div class="who-grid">
        ${guests.map((g) => html`<button key=${g.id} class="chip" aria-pressed=${among.includes(g.id)} onClick=${() => toggle(g.id)}><${Avatar} guest=${g} size=24 />${g.name}</button>`)}
      </div>
    </div>`}
  </div>`;
}

/* ───────── карточка блюда ───────── */

export function DishSheet({ item, open, onClose, onSubmit, guests = null, activeGuestId = null, submitLabel = 'Добавить', initialQty = 1 }) {
  const [qty, setQty] = useState(initialQty);
  const [options, setOptions] = useState({});
  const [note, setNote] = useState('');
  const [who, setWho] = useState(activeGuestId);
  const [among, setAmong] = useState([]);
  const itemId = item?.id;

  useEffect(() => {
    if (!item) return;
    const pre = {};
    for (const g of item.options) if (g.required && g.choices.length === 1) pre[g.id] = g.choices[0].id;
    setOptions(pre);
    setQty(initialQty);
    setNote('');
    setWho(activeGuestId);
    setAmong(guests ? guests.map((g) => g.id) : []);
  }, [itemId, open]);

  if (!item) return null;
  const missing = item.options.filter((g) => g.required && !options[g.id]);
  const unit = unitPrice(item, options);
  const ready = missing.length === 0 && (!guests || who);

  const submit = () => {
    if (!ready) return;
    const payload = { dishId: item.id, qty, options, note: note.trim() };
    if (guests) {
      payload.guestId = who;
      if (who === SHARED) payload.splitAmong = among;
    }
    onSubmit(payload);
  };

  return html`<${Sheet}
    open=${open}
    onClose=${onClose}
    label=${item.name}
    footer=${html`<div class="dsheet-foot-row">
        <${Stepper} value=${qty} flat minOne onInc=${() => setQty(Math.min(30, qty + 1))} onDec=${() => setQty(Math.max(1, qty - 1))} />
        <button class="btn btn-lg" disabled=${!ready} onClick=${submit}>${missing.length ? `Выберите: ${missing[0].name.toLowerCase()}` : `${submitLabel} · ${rub(unit * qty)}`}</button>
      </div>`}
  >
    <div class="dsheet">
      <div class="dsheet-photo">
        <${Photo} src=${item.image} alt=${item.name} eager />
        <button class="dsheet-close" onClick=${onClose} aria-label="Закрыть"><${Icon} name="x" /></button>
      </div>
      <h2>${item.name}</h2>
      ${item.desc && html`<p class="dsheet-desc">${item.desc}</p>`}
      <div class="dsheet-tags">
        ${item.weight && html`<span class="badge">${item.weight}</span>`}
        <${DishTags} item=${item} />
      </div>

      ${item.options.map(
        (g) => html`<div class="dsheet-section" key=${g.id}>
          <h3>${g.name}${g.required ? html`<span class="req">нужно выбрать</span>` : html`<span class="faint" style="font-weight:550;font-size:12.5px">по желанию</span>`}</h3>
          <div class="opt-grid" role="radiogroup" aria-label=${g.name}>
            ${g.choices.map((c) => html`<button key=${c.id} class="chip" role="radio" aria-checked=${options[g.id] === c.id} onClick=${() => setOptions({ ...options, [g.id]: !g.required && options[g.id] === c.id ? undefined : c.id })}>${c.name}${c.price ? html` <small>+${num(c.price)} ₽</small>` : ''}</button>`)}
          </div>
        </div>`,
      )}

      ${guests && guests.length > 1 && html`<div class="dsheet-section">
        <h3>Для кого</h3>
        <${WhoPicker} guests=${guests} value=${who} among=${among} onChange=${(v) => (setWho(v.who), setAmong(v.among))} />
      </div>`}

      <div class="dsheet-section">
        <h3>Пожелания <span class="faint" style="font-weight:550;font-size:12.5px">по желанию</span></h3>
        <input class="input" type="text" maxlength="140" placeholder="Например: без лука, поострее" value=${note} onInput=${(e) => setNote(e.currentTarget.value)} />
      </div>
    </div>
  <//>`;
}

export { needsChoice };
