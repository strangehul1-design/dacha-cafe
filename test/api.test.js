import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, sleep } from './helpers.js';

let t;
let menu;
const dish = (name) => {
  for (const c of menu.categories) {
    const d = c.items.find((i) => i.name === name);
    if (d) return d;
  }
  throw new Error('нет блюда ' + name);
};

before(async () => {
  t = await startTestApp();
  menu = (await t.get('/api/menu?mode=delivery')).json;
});
after(() => t.stop());

test('меню: скрытые позиции без цены не попадают к гостям, списки обеда подставлены', () => {
  const names = menu.categories.flatMap((c) => c.items.map((i) => i.name));
  assert.ok(!names.includes('Диабло'), 'позиция без цены скрыта');
  assert.ok(names.includes('Пицца гавайская'));
  const lunch = menu.categories.find((c) => c.id === 'lunch');
  const combo = lunch.items.find((i) => i.name.startsWith('Бизнес-ланч'));
  assert.equal(combo.options.find((o) => o.id === 'soup').choices.length, 4);
  assert.ok(!menu.categories.find((c) => c.id === 'drinks'), 'пустой раздел «Напитки» не показывается');
});

test('/api/config не отдаёт секреты', async () => {
  const r = await t.get('/api/config');
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.json).includes('AAFake'));
  assert.equal(r.json.delivery.freeFrom, 1000);
});

let tableCode;
let guestA;
let guestB;

test('стол: QR-код открывает стол, два гостя, заказ с общим блюдом уходит в Telegram', async () => {
  const table = t.app.db.config.tables.find((x) => x.number === '7');
  tableCode = table.code;

  const info = await t.get(`/api/table/${tableCode}`);
  assert.equal(info.status, 200);
  assert.equal(info.json.table.number, '7');
  assert.equal(info.json.session.guests.length, 0);

  guestA = (await t.post(`/api/table/${tableCode}/guests`, { name: 'Аня' })).json.guest;
  guestB = (await t.post(`/api/table/${tableCode}/guests`, { name: 'Пётр' })).json.guest;
  assert.notEqual(guestA.color, guestB.color);

  const noodles = dish('Говядина wok').options[0];
  const r = await t.post(`/api/table/${tableCode}/order`, {
    key: 'k1',
    lines: [
      { dishId: dish('Пицца гавайская').id, qty: 1, guestId: guestA.id, price: 1 }, // клиентская цена игнорируется
      { dishId: dish('Говядина wok').id, qty: 2, guestId: guestB.id, options: { noodles: noodles.choices[0].id }, note: 'без лука' },
      { dishId: dish('Картофель фри с кетчупом').id, qty: 1, guestId: 'shared', splitAmong: [guestA.id, guestB.id] },
    ],
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.delivered, true);
  assert.equal(r.json.order.total, 700 + 540 * 2 + 250);
  const bill = r.json.session.bill;
  assert.equal(bill.perGuest[guestA.id].total, 700 + 125);
  assert.equal(bill.perGuest[guestB.id].total, 1080 + 125);

  const msg = t.fake.state.sent.at(-1);
  assert.equal(msg.chat_id, '-1001');
  assert.match(msg.text, /Стол 7/);
  assert.match(msg.text, /Средний зал/);
  assert.match(msg.text, /Аня/);
  assert.match(msg.text, /Пётр/);
  assert.match(msg.text, /Общее на стол/);
  assert.match(msg.text, /гречневая/);
  assert.match(msg.text, /без лука/);
  assert.match(msg.text, /Итого: 2 030 ₽/);
  assert.equal(msg.reply_markup.inline_keyboard[0][0].text, '✅ Принять');
});

test('стол: повторная отправка с тем же ключом не создаёт второй заказ', async () => {
  const before = t.fake.state.sent.length;
  const r = await t.post(`/api/table/${tableCode}/order`, {
    key: 'k1',
    lines: [{ dishId: dish('Пицца гавайская').id, qty: 1, guestId: guestA.id }],
  });
  assert.equal(r.status, 200);
  assert.equal(t.fake.state.sent.length, before);
  assert.equal(r.json.session.orders.length, 1);
});

test('стол: нельзя заказать без обязательного варианта и несуществующему гостю', async () => {
  let r = await t.post(`/api/table/${tableCode}/order`, { lines: [{ dishId: dish('Свинина wok').id, qty: 1, guestId: guestA.id }] });
  assert.equal(r.status, 409);
  assert.equal(r.json.problems[0].reason, 'options');
  r = await t.post(`/api/table/${tableCode}/order`, { lines: [{ dishId: dish('Кетчуп').id, qty: 1, guestId: 'nobody' }] });
  assert.equal(r.status, 400);
  r = await t.post('/api/table/zzzzzz/order', { lines: [] });
  assert.equal(r.status, 404);
});

test('Telegram: «Принять» меняет статус и редактирует сообщение, повторное нажатие безопасно', async () => {
  const order = t.app.db.runtime.orders.find((o) => o.type === 'table');
  const tgMsg = t.fake.state.sent.find((m) => m.message_id === order.tg.messageId);
  const press = (action, id = order.id) =>
    t.fake.pushUpdate({ callback_query: { id: 'cb' + Math.random(), data: `e:${id}:${action}`, from: { first_name: 'Мария' }, message: { chat: { id: -1001 }, message_id: tgMsg.message_id } } });

  t.app.tg.start();
  press('acc');
  await waitFor(() => order.status === 'accepted');
  assert.match(t.fake.state.edits.at(-1).text, /Принято — Мария/);
  assert.equal(t.fake.state.answers.at(-1).text, 'Готово');

  press('acc');
  await waitFor(() => t.fake.state.answers.length >= 2);
  assert.equal(t.fake.state.answers.at(-1).text, 'Уже обработано');

  // гость видит статус при следующем опросе
  const info = await t.get(`/api/table/${tableCode}`);
  assert.equal(info.json.session.orders[0].status, 'accepted');
});

test('Telegram: нажатия из чужого чата игнорируются', async () => {
  const order = t.app.db.runtime.orders.find((o) => o.type === 'table');
  const n = t.fake.state.answers.length;
  t.fake.pushUpdate({ callback_query: { id: 'x', data: `e:${order.id}:cancel`, from: { first_name: 'Чужой' }, message: { chat: { id: -999 }, message_id: 1 } } });
  await waitFor(() => t.fake.state.answers.length > n);
  assert.equal(order.status, 'accepted');
  assert.match(t.fake.state.answers.at(-1).text, /не подключён/);
});

test('вызов официанта: уходит в Telegram, дубль того же вызова не плодится, потом частота ограничена', async () => {
  const before = t.fake.state.sent.length;
  let r = await t.post(`/api/table/${tableCode}/call`, { reason: 'bill' });
  assert.equal(r.status, 200);
  assert.equal(r.json.delivered, true);
  assert.match(t.fake.state.sent.at(-1).text, /Принести счёт/);
  assert.equal(t.fake.state.sent.length, before + 1);

  r = await t.post(`/api/table/${tableCode}/call`, { reason: 'bill' });
  assert.equal(r.status, 200);
  assert.equal(t.fake.state.sent.length, before + 1, 'тот же открытый вызов не дублируется');

  r = await t.post(`/api/table/${tableCode}/call`, { reason: 'clean' });
  assert.equal(r.status, 429);
});

test('оплата: раздельный счёт с чаевыми, подтверждение закрывает стол', async () => {
  let r = await t.post(`/api/table/${tableCode}/pay`, { method: 'bitcoin', mode: 'split' });
  assert.equal(r.status, 400);

  r = await t.post(`/api/table/${tableCode}/pay`, { method: 'card', mode: 'split', guestIds: [guestA.id, guestB.id], tipPct: 10 });
  assert.equal(r.status, 200, r.text);
  const pay = t.app.db.runtime.orders.find((o) => o.type === 'pay');
  assert.equal(pay.subtotal, 825 + 1205);
  assert.equal(pay.tip, 83 + 121);
  assert.equal(pay.total, 2030 + 204);
  const text = t.fake.state.sent.at(-1).text;
  assert.match(text, /готовы оплатить/);
  assert.match(text, /Картой/);
  assert.match(text, /раздельно по гостям/);
  assert.match(text, /Аня — 825/);
  assert.match(text, /К оплате: 2 234 ₽/);

  const press = (action) =>
    t.fake.pushUpdate({ callback_query: { id: 'p' + action, data: `e:${pay.id}:${action}`, from: { first_name: 'Мария' }, message: { chat: { id: -1001 }, message_id: pay.tg.messageId } } });
  press('done');
  await waitFor(() => pay.status === 'done');
  const info = await t.get(`/api/table/${tableCode}`);
  assert.equal(info.json.session.guests.length, 0, 'стол закрыт — следующая сессия пустая');
});

test('стоп-лист: кухня снимает блюдо, заказ с ним отклоняется, у гостей оно помечено', async () => {
  const d = dish('Пицца охотничья');
  assert.equal((await t.post('/api/admin/stop', { ids: [d.id], stop: true })).status, 401);

  assert.equal((await t.login('test-kitchen')).json.role, 'kitchen');
  assert.equal((await t.post('/api/admin/stop', { ids: [d.id], stop: true })).status, 200);
  // повар не меняет цены
  assert.equal((await t.put(`/api/admin/dishes/${d.id}`, { price: 1 })).status, 403);

  const fresh = (await t.get('/api/menu?mode=delivery')).json;
  assert.equal(fresh.categories.flatMap((c) => c.items).find((i) => i.id === d.id).stop, true);
  assert.notEqual(fresh.rev, menu.rev);
  const same = (await t.get(`/api/menu?mode=delivery&rev=${fresh.rev}`)).json;
  assert.equal(same.same, true);

  const g = (await t.post(`/api/table/${tableCode}/guests`, { name: 'Игорь' })).json.guest;
  const r = await t.post(`/api/table/${tableCode}/order`, { lines: [{ dishId: d.id, qty: 1, guestId: g.id }] });
  assert.equal(r.status, 409);
  assert.equal(r.json.problems[0].reason, 'stop');
  assert.match(r.json.error, /закончилось/);

  await t.post('/api/admin/stop', { ids: [d.id], stop: false });
});

test('админка: цена меняется только у администратора и сразу видна гостям', async () => {
  t.clearCookie();
  assert.equal((await t.login('wrong')).status, 401);
  assert.equal((await t.login()).json.role, 'admin');
  const d = dish('Пицца гавайская');
  const r = await t.put(`/api/admin/dishes/${d.id}`, { price: 720 });
  assert.equal(r.status, 200);
  const fresh = (await t.get('/api/menu?mode=delivery')).json;
  assert.equal(fresh.categories.flatMap((c) => c.items).find((i) => i.id === d.id).price, 720);
  assert.equal((await t.put(`/api/admin/dishes/${d.id}`, { price: -5 })).status, 400);
  await t.put(`/api/admin/dishes/${d.id}`, { price: 700 });
});

test('админка: массовое изменение цен с предпросмотром и округлением', async () => {
  const dry = await t.post('/api/admin/prices/bulk', { categoryIds: ['desert'], mode: 'percent', value: 10, round: 10, dry: true });
  assert.equal(dry.json.count, 7);
  const before = dish('Мороженое').price;
  assert.equal((await t.get('/api/menu?mode=delivery')).json.categories.flatMap((c) => c.items).find((i) => i.name === 'Мороженое').price, before);
  const done = await t.post('/api/admin/prices/bulk', { categoryIds: ['desert'], mode: 'percent', value: 10, round: 10 });
  assert.equal(done.json.count, 7);
  const icecream = (await t.get('/api/menu?mode=delivery')).json.categories.flatMap((c) => c.items).find((i) => i.name === 'Мороженое');
  assert.equal(icecream.price, 190); // 170 × 1,1 = 187 → 190
  await t.post('/api/admin/prices/bulk', { categoryIds: ['desert'], mode: 'percent', value: -9.0909, round: 10 });
});

test('позиция без цены появляется в меню после того, как цену указали', async () => {
  const d = t.app.db.config.dishes.find((x) => x.name === 'Диабло');
  assert.equal(d.hidden, true);
  const r = await t.put(`/api/admin/dishes/${d.id}`, { price: 690 });
  assert.equal(r.status, 200);
  assert.equal(r.json.dish.hidden, false);
  const names = (await t.get('/api/menu?mode=delivery')).json.categories.flatMap((c) => c.items.map((i) => i.name));
  assert.ok(names.includes('Диабло'));
});

test('доставка: заказ, бесплатная доставка от 1000, промокод, самовывоз', async () => {
  const lines = [{ dishId: dish('Мясная').id, qty: 1 }]; // 650 ₽ — ниже порога
  const base = { name: 'Иван', phone: '8 900 123-45-67', address: { street: 'ул. Ленина', house: '12', apt: '5' }, payment: 'cash', consent: true, when: 'asap' };
  const slots = (await t.get('/api/delivery/slots')).json;

  // «как можно скорее» зависит от часов работы: сверяем с ответом сервера
  const asap = slots.availability.asap;
  const when = asap ? 'asap' : slots.slots[0].value;

  let r = await t.post('/api/delivery/order', { ...base, when, lines });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.order.total, 650 + 150);
  assert.match(t.fake.state.sent.at(-1).text, /Доставка № \d+/);
  assert.match(t.fake.state.sent.at(-1).text, /ул\. Ленина, 12, кв\. 5/);

  r = await t.post('/api/delivery/order', { ...base, when, lines: [{ dishId: dish('Мясная').id, qty: 2 }] });
  assert.equal(r.json.order.total, 1300, 'от 1000 ₽ доставка бесплатна');

  r = await t.post('/api/delivery/order', { ...base, when, type: 'pickup', address: undefined, lines });
  assert.equal(r.json.order.total, 650, 'самовывоз без доставки');
  assert.match(t.fake.state.sent.at(-1).text, /Самовывоз/);

  const status = await t.get(`/api/delivery/order/${r.json.order.token}`);
  assert.equal(status.json.status, 'new');
});

test('доставка: проверки данных', async () => {
  const lines = [{ dishId: dish('Мясная').id, qty: 1 }];
  const good = { name: 'Иван', phone: '+79001234567', address: { street: 'ул. Ленина', house: '12' }, payment: 'card', consent: true, when: 'asap', lines };
  assert.equal((await t.post('/api/delivery/order', { ...good, phone: '123' })).status, 400);
  assert.equal((await t.post('/api/delivery/order', { ...good, consent: false })).status, 400);
  assert.equal((await t.post('/api/delivery/order', { ...good, address: { street: '', house: '' } })).status, 400);
  assert.equal((await t.post('/api/delivery/order', { ...good, payment: 'crypto' })).status, 400);
  assert.equal((await t.post('/api/delivery/order', { ...good, when: '03:07' })).status, 400);
  assert.equal((await t.post('/api/delivery/order', { ...good, promo: 'НЕТТАКОГО' })).status, 400);
});

test('промокод работает только когда включён', async () => {
  assert.equal((await t.post('/api/promo', { code: 'дача10', subtotal: 1000 })).status, 400);
  await t.put('/api/admin/promos', { promos: [{ code: 'ДАЧА10', percent: 10, active: true }] });
  const r = await t.post('/api/promo', { code: 'дача10', subtotal: 1000 });
  assert.equal(r.json.discount, 100);
});

test('бронь: заявка уходит в Telegram, прошедшая дата отклоняется', async () => {
  const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const body = { name: 'Ольга', phone: '+79001234567', date: future, time: '19:00', guests: 8, hallId: 'big', consent: true, comment: 'День рождения' };
  const r = await t.post('/api/reserve', body);
  assert.equal(r.status, 200, r.text);
  const text = t.fake.state.sent.at(-1).text;
  assert.match(text, /Бронь стола/);
  assert.match(text, /8 гостей/);
  assert.match(text, /Большой зал/);
  assert.match(text, /День рождения/);
  assert.equal((await t.post('/api/reserve', { ...body, date: '2020-01-01' })).status, 400);
});

test('если Telegram недоступен, заказ сохраняется и уходит повторно', async () => {
  t.fake.state.failNext = 1;
  const info = await t.post('/api/table/' + t.app.db.config.tables.find((x) => x.number === '1').code + '/guests', { name: 'Лена' });
  const code = t.app.db.config.tables.find((x) => x.number === '1').code;
  const r = await t.post(`/api/table/${code}/order`, { lines: [{ dishId: dish('Кетчуп').id, qty: 1, guestId: info.json.guest.id }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.delivered, false);
  const order = t.app.db.getEntry(r.json.order.id);
  assert.equal(order.tg.ok, false);

  const resend = await t.post(`/api/admin/orders/${order.id}/resend`);
  assert.equal(resend.json.entry.tg.ok, true);
});

test('Telegram: очень длинный заказ сокращается до лимита и сохраняет итог и кнопки', async () => {
  const table = t.app.db.config.tables.find((x) => x.number === '4');
  const g = (await t.post(`/api/table/${table.code}/guests`, { name: 'Гость' })).json.guest;
  const note = 'очень длинное пожелание '.repeat(6).slice(0, 140);
  const lines = Array.from({ length: 45 }, () => ({ dishId: dish('Мясная').id, qty: 1, guestId: g.id, note }));
  const r = await t.post(`/api/table/${table.code}/order`, { lines });
  assert.equal(r.status, 200, r.text);
  const msg = t.fake.state.sent.at(-1);
  assert.ok(msg.text.length <= 4096, `длина ${msg.text.length}`);
  assert.match(msg.text, /ещё строк/);
  assert.match(msg.text, /Итого: 29 250 ₽/);
  assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data.startsWith('e:'), true);
});

test('админка: QR-код стола и загрузка фото', async () => {
  const svg = await t.get('/api/admin/qr.svg?text=' + encodeURIComponent('https://example.com/t/abc'));
  assert.equal(svg.status, 200);
  assert.match(svg.text, /<svg/);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await t.api('POST', '/api/admin/upload', png, { raw: true, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(up.status, 200, up.text);
  assert.match(up.json.url, /^\/uploads\/[0-9a-f]+\.png$/);
  const got = await fetch(t.base + up.json.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');

  const bad = await t.api('POST', '/api/admin/upload', Buffer.from('<script>alert(1)</script>'), { raw: true });
  assert.equal(bad.status, 400);
});

test('страницы: сайт, QR-меню, админка и политика открываются, шрифты на месте', async () => {
  const code = t.app.db.config.tables[0].code;
  for (const [url, needle] of [
    ['/', 'Кафе «Дача для друзей»'],
    ['/menu', 'id="app"'],
    [`/t/${code}`, 'Меню на столе'],
    ['/admin', 'Админка'],
    ['/admin/anything', 'Админка'],
    ['/privacy', 'Политика конфиденциальности'],
  ]) {
    const r = await fetch(t.base + url);
    assert.equal(r.status, 200, url);
    assert.match(await r.text(), new RegExp(needle), url);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  }
  for (const f of ['/fonts/podkova-cyrillic-wght-normal.woff2', '/fonts/onest-latin-ext-wght-normal.woff2', '/js/vendor/htm-preact.js', '/css/tokens.css', '/img/favicon.svg']) {
    assert.equal((await fetch(t.base + f)).status, 200, f);
  }
  const priv = await (await fetch(t.base + '/api/privacy')).json();
  assert.equal(priv.text, '');
});

test('сохранение чужих фото: внутренние адреса не скачиваются, доступ только у администратора', async () => {
  // тесты не ходят в сеть: оставляем одну ссылку, ведущую на внутренний адрес
  t.app.db.config.dishes.forEach((x) => (x.image = ''));
  t.app.db.config.dishes.find((x) => x.name === 'Мороженое').image = 'http://127.0.0.1:1/secret.jpg';
  const r = await t.post('/api/admin/images/localize');
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 1);
  assert.equal(r.json.ok, 0);
  assert.equal(r.json.failedCount, 1);
  assert.equal(t.app.db.config.dishes.find((x) => x.name === 'Мороженое').image, 'http://127.0.0.1:1/secret.jpg', 'ссылка на внутренний адрес остаётся как есть');
  t.clearCookie();
  assert.equal((await t.post('/api/admin/images/localize')).status, 401);
  await t.login();
});

test('страницы и статика: нет выхода за пределы папки, чужие страницы не отдаются', async () => {
  assert.equal((await fetch(t.base + '/..%2f..%2fpackage.json')).status, 404);
  assert.equal((await fetch(t.base + '/data/config.json')).status, 404);
  assert.equal((await fetch(t.base + '/lib/app.js')).status, 404);
});

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(25);
  }
  assert.fail('не дождались условия');
}
