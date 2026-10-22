import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBill, tipOf, SHARED } from '../public/js/common/bill.js';
import { openState, groupHours, categoryAvailable } from '../public/js/common/hours.js';
import { normalizePhone, plural, rub } from '../public/js/common/format.js';
import { defaultSettings } from '../lib/seed.js';

const guests = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('счёт: личные блюда и общие делятся поровну, сумма сходится до рубля', () => {
  const orders = [
    {
      status: 'new',
      lines: [
        { unit: 700, qty: 1, guestId: 'a' },
        { unit: 630, qty: 2, guestId: 'b' },
        { unit: 250, qty: 1, guestId: SHARED, splitAmong: ['a', 'b', 'c'] },
      ],
    },
  ];
  const bill = computeBill(orders, guests);
  assert.equal(bill.total, 700 + 1260 + 250);
  const sum = Object.values(bill.perGuest).reduce((s, g) => s + g.total, 0);
  assert.equal(sum, bill.total);
  assert.equal(bill.perGuest.a.own, 700);
  assert.equal(bill.perGuest.b.own, 1260);
  assert.equal(bill.perGuest.c.own, 0);
  // 250 / 3 = 83 + остаток 1 рубль уходит первому
  assert.deepEqual([bill.perGuest.a.shared, bill.perGuest.b.shared, bill.perGuest.c.shared], [84, 83, 83]);
});

test('счёт: отменённые заказы не считаются, общее можно делить на часть гостей', () => {
  const orders = [
    { status: 'cancelled', lines: [{ unit: 999, qty: 1, guestId: 'a' }] },
    { status: 'accepted', lines: [{ unit: 100, qty: 1, guestId: SHARED, splitAmong: ['a', 'c'] }] },
  ];
  const bill = computeBill(orders, guests);
  assert.equal(bill.total, 100);
  assert.equal(bill.perGuest.a.total, 50);
  assert.equal(bill.perGuest.b.total, 0);
  assert.equal(bill.perGuest.c.total, 50);
});

test('счёт: если общим блюдом поделились удалённым гостем, делим на всех', () => {
  const bill = computeBill([{ status: 'new', lines: [{ unit: 90, qty: 1, guestId: SHARED, splitAmong: ['ghost'] }] }], guests);
  assert.deepEqual(Object.values(bill.perGuest).map((g) => g.total), [30, 30, 30]);
});

test('чаевые округляются до рубля', () => {
  assert.equal(tipOf(1050, 10), 105);
  assert.equal(tipOf(333, 5), 17);
  assert.equal(tipOf(500, 0), 0);
});

const TZ = 'Asia/Yekaterinburg'; // UTC+5
const hours = defaultSettings.hours;

test('часы работы: четверг до 23:00', () => {
  const thu1900 = openState(hours, TZ, new Date('2026-10-22T14:00:00Z'));
  assert.equal(thu1900.open, true);
  assert.equal(thu1900.closeAt, '23:00');
  assert.equal(thu1900.minutesToClose, 240);

  const thu2330 = openState(hours, TZ, new Date('2026-10-22T18:30:00Z'));
  assert.equal(thu2330.open, false);
  assert.deepEqual(thu2330.nextOpen, { label: 'завтра', time: '11:00' });
});

test('часы работы: суббота после полуночи ещё открыто (пятница до 03:00)', () => {
  const sat0130 = openState(hours, TZ, new Date('2026-10-23T20:30:00Z'));
  assert.equal(sat0130.open, true);
  assert.equal(sat0130.closeAt, '03:00');
  assert.equal(sat0130.minutesToClose, 90);
  const sat0330 = openState(hours, TZ, new Date('2026-10-23T22:30:00Z'));
  assert.equal(sat0330.open, false);
});

test('часы работы: группировка для подвала', () => {
  const g = groupHours(hours);
  assert.deepEqual(g[0], { text: '11:00–23:00', days: 'пн–чт' });
  assert.deepEqual(g[1], { text: '11:00–03:00', days: 'пт–сб' });
  assert.deepEqual(g[2], { text: '11:00–23:00', days: 'вс' });
});

test('расписание раздела, в том числе через полночь', () => {
  assert.equal(categoryAvailable({ from: '11:00', to: '16:00' }, TZ, new Date('2026-10-22T08:00:00Z')), true); // 13:00
  assert.equal(categoryAvailable({ from: '11:00', to: '16:00' }, TZ, new Date('2026-10-22T14:00:00Z')), false); // 19:00
  assert.equal(categoryAvailable({ from: '', to: '' }, TZ), true);
  assert.equal(categoryAvailable({ from: '22:00', to: '03:00' }, TZ, new Date('2026-10-22T20:00:00Z')), true); // 01:00
});

test('форматирование', () => {
  assert.equal(normalizePhone('8 (900) 123-45-67'), '+79001234567');
  assert.equal(normalizePhone('+7 900 123 45 67'), '+79001234567');
  assert.equal(normalizePhone('123'), null);
  assert.equal(plural(1, 'гость', 'гостя', 'гостей'), 'гость');
  assert.equal(plural(3, 'гость', 'гостя', 'гостей'), 'гостя');
  assert.equal(plural(11, 'гость', 'гостя', 'гостей'), 'гостей');
  assert.equal(rub(1500), '1 500 ₽');
});
