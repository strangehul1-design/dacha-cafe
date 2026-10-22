// Админ-панель: вход, навигация, опрос заказов, сигнал о новом заказе, печать табличек.
import { html, render, useState, useEffect, useRef, useCallback } from '../common/lib.js';
import { api } from '../common/api.js';
import { Icon } from '../common/icons.js';
import { Plaque, Toasts, toast, usePolling, useStored, cx, Spinner } from '../common/ui.js';
import { ConfirmHost } from './common.js';
import { StopView } from './stop.js';
import { MenuAdmin } from './menu.js';
import { OrdersView, isOpenEntry } from './orders.js';
import { TablesView, PrintHost } from './tables.js';
import { LunchView, lunchIsStale } from './lunch.js';
import { SettingsView } from './settings.js';

const ROUTES = [
  ['orders', 'Заказы', 'Заказы', 'receipt'],
  ['stop', 'Стоп-лист', 'Стоп', 'toggle'],
  ['menu', 'Меню и цены', 'Меню', 'menu'],
  ['tables', 'Столы и QR', 'Столы', 'qr'],
  ['lunch', 'Дачные обеды', 'Обеды', 'calendar'],
  ['settings', 'Настройки', 'Ещё', 'gear'],
];

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const tone = (freq, at) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.4);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.45);
    };
    tone(880, 0);
    tone(1175, 0.22);
    setTimeout(() => ctx.close(), 1000);
  } catch {
    /* звук недоступен — не страшно */
  }
}

function Login({ onLogin }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/api/admin/login', { password: pw });
      onLogin(r.role);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="login">
    <form class="login-card" onSubmit=${submit}>
      <${Plaque}>Дача<//>
      <div><h1>Вход в админку</h1><p class="muted" style="margin-top:6px">Меню, стоп-лист, цены и заказы кафе.</p></div>
      <div class="field"><label for="pw">Пароль</label><input id="pw" class="input" type="password" autocomplete="current-password" autofocus value=${pw} onInput=${(e) => setPw(e.currentTarget.value)} aria-invalid=${err ? 'true' : undefined} /></div>
      ${err && html`<div class="notice notice-danger"><${Icon} name="warn" /><span>${err}</span></div>`}
      <button class="btn btn-lg" type="submit" disabled=${busy || !pw}>${busy ? 'Входим…' : 'Войти'}</button>
    </form>
    <${Toasts} />
  </div>`;
}

function App() {
  const [role, setRole] = useState(undefined);
  const [data, setData] = useState(null);
  const [feed, setFeed] = useState({ orders: [], live: [] });
  const [route, setRoute] = useState((location.hash || '').slice(1));
  const [soundOn, setSoundOn] = useStored('dacha:admin-sound', false);
  const [printTables, setPrintTables] = useState(null);
  const seen = useRef(null);
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;

  const refresh = useCallback(async () => {
    try {
      setData(await api.get('/api/admin/bootstrap'));
    } catch (e) {
      if (e.status === 401) setRole(null);
      else toast(e.message, 'err');
    }
  }, []);

  const refreshFeed = useCallback(async () => {
    try {
      const [o, l] = await Promise.all([api.get('/api/admin/orders?limit=150'), api.get('/api/admin/live')]);
      const fresh = o.orders.filter((e) => isOpenEntry(e) && (e.type === 'table' || e.type === 'delivery' || e.type === 'reserve' || e.type === 'call' || e.type === 'pay'));
      if (seen.current === null) seen.current = new Set(o.orders.map((e) => e.id));
      else {
        const news = fresh.filter((e) => !seen.current.has(e.id));
        o.orders.forEach((e) => seen.current.add(e.id));
        if (news.length) {
          if (soundRef.current) beep();
          const e = news[0];
          toast(e.type === 'call' ? `Стол ${e.tableNumber} зовёт официанта` : e.type === 'pay' ? `Стол ${e.tableNumber} просит счёт` : e.type === 'table' ? `Новый заказ: стол ${e.tableNumber}` : e.type === 'delivery' ? `Новая доставка № ${e.num}` : `Новая бронь № ${e.num}`);
        }
      }
      setFeed({ orders: o.orders, live: l.tables });
    } catch (e) {
      if (e.status === 401) setRole(null);
    }
  }, []);

  useEffect(() => {
    api.get('/api/admin/me').then((r) => setRole(r.role || null)).catch(() => setRole(null));
  }, []);

  useEffect(() => {
    if (!role) return;
    refresh();
    if (role === 'admin') refreshFeed();
  }, [role]);

  usePolling(refreshFeed, 5000, [role]);
  usePolling(refresh, 60000, [role]);

  useEffect(() => {
    const on = () => refresh();
    window.addEventListener('admin:refresh', on);
    const hash = () => setRoute((location.hash || '').slice(1));
    window.addEventListener('hashchange', hash);
    return () => {
      window.removeEventListener('admin:refresh', on);
      window.removeEventListener('hashchange', hash);
    };
  }, [refresh]);

  const open = feed.orders.filter(isOpenEntry).length;
  useEffect(() => {
    document.title = (open ? `(${open}) ` : '') + 'Админка · Дача для друзей';
  }, [open]);

  const goto = (r) => {
    location.hash = r;
    setRoute(r);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const logout = async () => {
    await api.post('/api/admin/logout').catch(() => {});
    seen.current = null;
    setData(null);
    setRole(null);
  };

  if (role === undefined) return html`<div class="login"><${Spinner} /></div>`;
  if (!role) return html`<${Login} onLogin=${(r) => (setRole(r), setRoute(''))} />`;
  if (!data) return html`<div class="login"><${Spinner} /></div>`;

  const nav = role === 'kitchen' ? ROUTES.filter((r) => r[0] === 'stop') : ROUTES;
  const current = nav.find((r) => r[0] === route)?.[0] || nav[0][0];
  const noPrice = data.dishes?.filter((d) => d.needsPrice).length || 0;
  const pill = { orders: open, menu: noPrice, lunch: role === 'admin' && lunchIsStale(data) ? '!' : 0 };

  return html`<div class="adm">
    <aside class="adm-side" aria-label="Разделы админки">
      <div class="adm-brand"><${Plaque}>Дача<//><div><b>Админка</b><span>${role === 'kitchen' ? 'Повар' : 'Администратор'}</span></div></div>
      ${nav.map(([k, label, , icon]) => html`<button key=${k} class="nav-item" aria-current=${current === k ? 'page' : 'false'} onClick=${() => goto(k)}>
        <${Icon} name=${icon} size=22 />${label}${pill[k] ? html`<span class=${cx('pill', k !== 'orders' && 'pill-quiet')}>${pill[k]}</span>` : ''}
      </button>`)}
      <span class="grow"></span>
      ${role === 'admin' && html`<a class="nav-item" href="/" target="_blank" rel="noopener"><${Icon} name="link" size=22 />Открыть сайт</a>`}
      <button class="nav-item" onClick=${logout}><${Icon} name="logout" size=22 />Выйти</button>
    </aside>

    <div>
      <header class="adm-top">
        <${Plaque}>Дача<//>
        <h1>${nav.find((r) => r[0] === current)[1]}</h1>
        <span class="spacer"></span>
        <button class="icon-btn" onClick=${logout} aria-label="Выйти"><${Icon} name="logout" size=22 /></button>
      </header>
      <main class="adm-main">
        ${current === 'orders' && role === 'admin' && html`<${OrdersView} feed=${feed} refreshFeed=${refreshFeed} tg=${data.telegram} soundOn=${soundOn} setSoundOn=${setSoundOn} />`}
        ${current === 'stop' && html`<${StopView} data=${data} setData=${setData} role=${role} />`}
        ${current === 'menu' && role === 'admin' && html`<${MenuAdmin} data=${data} setData=${setData} />`}
        ${current === 'tables' && role === 'admin' && html`<${TablesView} data=${data} setData=${setData} onPrint=${setPrintTables} />`}
        ${current === 'lunch' && role === 'admin' && html`<${LunchView} data=${data} setData=${setData} goto=${goto} />`}
        ${current === 'settings' && role === 'admin' && html`<${SettingsView} data=${data} setData=${setData} refresh=${refresh} />`}
      </main>
    </div>

    ${role === 'admin' && html`<nav class="adm-bottom" aria-label="Разделы админки">
      ${nav.map(([k, , short, icon]) => html`<button key=${k} aria-current=${current === k ? 'page' : 'false'} onClick=${() => goto(k)}><${Icon} name=${icon} size=22 />${short}${pill[k] ? html`<span class="pill">${pill[k]}</span>` : ''}</button>`)}
    </nav>`}
    ${role === 'kitchen' && html`<nav class="adm-bottom"><button aria-current="page"><${Icon} name="toggle" size=22 />Стоп-лист</button></nav>`}

    ${role === 'admin' && html`<${PrintHost} tables=${printTables} data=${data} onDone=${() => setPrintTables(null)} />`}
    <${ConfirmHost} />
    <${Toasts} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
