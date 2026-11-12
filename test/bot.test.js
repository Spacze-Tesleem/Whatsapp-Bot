'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createStore } = require('../src/store');
const { createBot } = require('../src/bot');

function setup() {
  const store = createStore(openDatabase(':memory:'));
  store.seedDemoData();
  const created = [];
  const bot = createBot({ store, onOrderCreated: (o) => created.push(o) });
  const say = async (phone, text, name = '') => (await bot.handleMessage(phone, text, name)).join('\n');
  return { store, bot, say, created };
}

const PHONE = '2348011112222';

test('menu greeting and numeric shortcuts', async () => {
  const { say } = setup();
  assert.match(await say(PHONE, 'hi'), /Welcome to \*My Store\*/);
  assert.match(await say(PHONE, '1'), /Products/);
  assert.match(await say(PHONE, '4'), /How to order/);
});

test('shop lists active products with IDs and prices', async () => {
  const { say } = setup();
  const text = await say(PHONE, 'shop');
  assert.match(text, /\[1\] Ankara Print Shirt – ₦8,500/);
  assert.match(text, /\[6\] Jollof Spice Pack – ₦2,500/);
});

test('add, cart totals, remove and clear', async () => {
  const { say, store } = setup();
  assert.match(await say(PHONE, 'add 1 2'), /Added 2 x Ankara Print Shirt/);
  assert.match(await say(PHONE, 'add 6'), /Added 1 x Jollof Spice Pack/);
  const cart = await say(PHONE, 'cart');
  assert.match(cart, /\*Total: ₦19,500\*/);
  assert.match(await say(PHONE, 'remove 6'), /Removed product 6/);
  assert.equal(store.getCart(PHONE).total, 17000);
  assert.match(await say(PHONE, 'clear'), /cleared/);
  assert.match(await say(PHONE, 'cart'), /Your cart is empty/);
});

test('adding beyond stock is refused', async () => {
  const { say } = setup();
  assert.match(await say(PHONE, 'add 3 9'), /Only 8 of Wireless Earbuds left/);
});

test('bad input gets helpful replies', async () => {
  const { say } = setup();
  assert.match(await say(PHONE, 'add'), /product ID/);
  assert.match(await say(PHONE, 'add 999'), /not available/);
  assert.match(await say(PHONE, 'banana'), /didn't understand/);
  assert.match(await say(PHONE, ''), /only read text/);
});

test('full checkout flow creates an order, reserves stock and clears the cart', async () => {
  const { say, store, created } = setup();
  await say(PHONE, 'add 5 3');
  assert.match(await say(PHONE, 'checkout'), /full name/);
  assert.match(await say(PHONE, 'Ada Obi'), /delivery address/);
  const summary = await say(PHONE, '12 Adeola Odeku, Victoria Island, Lagos');
  assert.match(summary, /Total: \*₦9,000\*/);
  assert.match(summary, /Reply \*YES\*/);
  const done = await say(PHONE, 'yes');
  assert.match(done, /Your order \*ORD-[0-9A-F]{6}\*/);
  assert.equal(created.length, 1);
  assert.equal(created[0].customer_name, 'Ada Obi');
  assert.equal(store.getCart(PHONE).items.length, 0);
  assert.equal(store.getProduct(5).stock, 57);
  assert.equal(store.getSession(PHONE).state, 'idle');

  const orders = await say(PHONE, 'orders');
  assert.match(orders, /ORD-[0-9A-F]{6}/);
  const track = await say(PHONE, `track ${created[0].order_no}`);
  assert.match(track, /PENDING/);
});

test('checkout can be declined and cancelled', async () => {
  const { say, store } = setup();
  await say(PHONE, 'add 6');
  await say(PHONE, 'checkout');
  await say(PHONE, 'Ada Obi');
  await say(PHONE, '12 Adeola Odeku, Lagos');
  assert.match(await say(PHONE, 'no'), /Order cancelled/);
  assert.equal(store.getCart(PHONE).items.length, 1);

  await say(PHONE, 'checkout');
  assert.match(await say(PHONE, 'cancel'), /Checkout cancelled/);
  assert.equal(store.getSession(PHONE).state, 'idle');
});

test('checkout refuses an empty cart', async () => {
  const { say } = setup();
  assert.match(await say(PHONE, 'checkout'), /cart is empty/);
});

test('tracking another customer order is not allowed', async () => {
  const { say, created, store } = setup();
  store.addToCart(PHONE, 6, 1);
  store.createOrder({ phone: PHONE, customerName: 'A', address: 'Somewhere', items: [{ productId: 6, qty: 1 }] });
  const orderNo = store.listOrders()[0].order_no;
  assert.match(await say('2348099999999', `track ${orderNo}`), /couldn't find/);
  assert.equal(created.length, 0);
});

test('stock is restored when an order is cancelled', async () => {
  const { store } = setup();
  const before = store.getProduct(4).stock;
  const order = store.createOrder({ phone: PHONE, items: [{ productId: 4, qty: 5 }] });
  assert.equal(store.getProduct(4).stock, before - 5);
  store.updateOrderStatus(order.id, 'cancelled');
  assert.equal(store.getProduct(4).stock, before);
  assert.throws(() => store.updateOrderStatus(order.id, 'paid'), /cannot be reopened/);
});

test('an order cannot exceed available stock', () => {
  const { store } = setup();
  assert.throws(() => store.createOrder({ phone: PHONE, items: [{ productId: 3, qty: 99 }] }), /Only 8/);
  assert.equal(store.getProduct(3).stock, 8);
});
