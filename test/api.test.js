'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openDatabase } = require('../src/db');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { parseWebhook, verifySignature } = require('../src/whatsapp');

const CONFIG = {
  adminPassword: 'test-pass',
  whatsapp: { verifyToken: 'verify-123', appSecret: 'app-secret', token: '', phoneNumberId: '', graphVersion: 'v21.0' },
};

let server;
let base;
let sent;
let cookie;

before(async () => {
  const store = createStore(openDatabase(':memory:'));
  store.seedDemoData();
  sent = [];
  const whatsapp = { dryRun: true, sendText: async (to, body) => { sent.push({ to, body }); } };
  const { app } = createApp({ store, whatsapp, config: CONFIG, logger: { log() {}, error() {} } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

const json = (method, path, body, headers = {}) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function signed(payload) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${crypto.createHmac('sha256', CONFIG.whatsapp.appSecret).update(raw).digest('hex')}`;
  return { raw, sig };
}

async function waitFor(fn, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('webhook verification handshake', async () => {
  const ok = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-123&hub.challenge=42`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '42');
  const bad = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
  assert.equal(bad.status, 403);
});

test('webhook rejects bad signatures and accepts valid ones, then replies via WhatsApp', async () => {
  const payload = {
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '2348033334444', profile: { name: 'Chidi' } }],
      messages: [{ from: '2348033334444', id: 'wamid.1', type: 'text', text: { body: 'menu' } }],
    } }] }],
  };
  const { raw, sig } = signed(payload);
  const forged = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: raw });
  assert.equal(forged.status, 403);

  const res = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
  assert.equal(res.status, 200);
  assert.ok(await waitFor(() => sent.length > 0));
  assert.equal(sent[0].to, '2348033334444');
  assert.match(sent[0].body, /Welcome to/);
});

test('parseWebhook extracts text and button replies', () => {
  const msgs = parseWebhook({ entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '1', profile: { name: 'X' } }],
    messages: [
      { from: '1', id: 'a', type: 'text', text: { body: 'shop' } },
      { from: '1', id: 'b', type: 'image', image: {} },
      { from: '1', id: 'c', type: 'interactive', interactive: { button_reply: { title: 'Yes' } } },
    ],
  } }] }] });
  assert.deepEqual(msgs.map((m) => m.text), ['shop', '', 'Yes']);
  assert.equal(msgs[0].name, 'X');
  assert.equal(verifySignature(Buffer.from('x'), 'sha256=bad', ''), true);
});

test('storefront lists products and rejects invalid web orders', async () => {
  const res = await fetch(`${base}/api/shop/products?q=shea`);
  const { products } = await res.json();
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Shea Butter 500g');

  const bad = await json('POST', '/api/shop/orders', { name: 'A', phone: '123', address: 'x', items: [] });
  assert.equal(bad.status, 400);
  const badPhone = await json('POST', '/api/shop/orders', { name: 'Ada', phone: '12', address: '12 Some Street', items: [{ productId: 1, qty: 1 }] });
  assert.equal(badPhone.status, 400);
});

test('web order placement, notification and public tracking', async () => {
  sent.length = 0;
  const res = await json('POST', '/api/shop/orders', {
    name: 'Ngozi Eze', phone: '08055556666', address: '4 Allen Avenue, Ikeja', items: [{ productId: 6, qty: 2 }],
  });
  assert.equal(res.status, 201);
  const { order } = await res.json();
  assert.equal(order.total, 5000);
  assert.equal(order.phone, '2348055556666');
  assert.ok(await waitFor(() => sent.some((m) => m.to === '2348055556666')));

  const track = await fetch(`${base}/api/shop/orders/${order.order_no}?phone=08055556666`);
  assert.equal(track.status, 200);
  assert.equal((await track.json()).status, 'pending');
  const wrong = await fetch(`${base}/api/shop/orders/${order.order_no}?phone=08000000000`);
  assert.equal(wrong.status, 404);
});

test('admin API requires authentication', async () => {
  const res = await fetch(`${base}/api/admin/products`);
  assert.equal(res.status, 401);
  const wrong = await json('POST', '/api/admin/login', { password: 'nope' });
  assert.equal(wrong.status, 401);
});

test('admin login sets an HttpOnly session cookie', async () => {
  const res = await json('POST', '/api/admin/login', { password: 'test-pass' });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /admin_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  const me = await (await json('GET', '/api/admin/me')).json();
  assert.equal(me.authenticated, true);
});

test('admin can manage products', async () => {
  const created = await json('POST', '/api/admin/products', { name: 'Test Bag', price: 4000, stock: 3, category: 'Fashion' });
  assert.equal(created.status, 201);
  const { product } = await created.json();
  assert.equal(product.name, 'Test Bag');

  const updated = await json('PUT', `/api/admin/products/${product.id}`, { price: 4500, active: false });
  const body = await updated.json();
  assert.equal(body.product.price, 4500);
  assert.equal(body.product.active, false);

  const invalid = await json('POST', '/api/admin/products', { name: 'Bad', price: -1 });
  assert.equal(invalid.status, 400);

  const del = await json('DELETE', `/api/admin/products/${product.id}`);
  assert.equal((await del.json()).deleted, true);
});

test('admin status change notifies the customer and cancel restores stock', async () => {
  const before = await (await json('GET', '/api/admin/products')).json();
  const jollof = before.products.find((p) => p.name === 'Jollof Spice Pack');
  const list = await (await json('GET', '/api/admin/orders')).json();
  const order = list.orders.find((o) => o.phone === '2348055556666');

  sent.length = 0;
  const res = await json('PATCH', `/api/admin/orders/${order.id}`, { status: 'shipped' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).order.status, 'shipped');
  assert.ok(await waitFor(() => sent.some((m) => /SHIPPED/.test(m.body))));

  const cancel = await json('PATCH', `/api/admin/orders/${order.id}`, { status: 'cancelled' });
  assert.equal((await cancel.json()).order.status, 'cancelled');
  const after = await (await json('GET', '/api/admin/products')).json();
  assert.equal(after.products.find((p) => p.id === jollof.id).stock, jollof.stock + 2);
});

test('invalid order status is rejected', async () => {
  const list = await (await json('GET', '/api/admin/orders')).json();
  const res = await json('PATCH', `/api/admin/orders/${list.orders[0].id}`, { status: 'teleported' });
  assert.equal(res.status, 400);
});

test('admin simulator runs the bot without sending to WhatsApp', async () => {
  sent.length = 0;
  const res = await json('POST', '/api/admin/simulate', { phone: '08077778888', name: 'Sim', text: 'shop' });
  const { replies } = await res.json();
  assert.match(replies[0], /Products/);
  assert.equal(sent.length, 0);
});

test('settings can be read and updated', async () => {
  const res = await json('PUT', '/api/admin/settings', { store_name: 'Lagos Looks', account_number: '0123456789' });
  const { settings } = await res.json();
  assert.equal(settings.store_name, 'Lagos Looks');
  const pub = await (await fetch(`${base}/api/shop/config`)).json();
  assert.equal(pub.store_name, 'Lagos Looks');
  assert.equal(pub.account_number, undefined);
});

test('admin logout invalidates the session', async () => {
  await json('POST', '/api/admin/logout');
  const res = await json('GET', '/api/admin/products');
  assert.equal(res.status, 401);
});

test('static panels are served', async () => {
  const admin = await fetch(`${base}/admin`);
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /Admin sign in/);
  const shop = await fetch(`${base}/`);
  assert.equal(shop.status, 200);
  assert.match(await shop.text(), /Track an order/);
});

test('repeated failed logins are rate limited', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await json('POST', '/api/admin/login', { password: 'wrong' });
  assert.equal(last.status, 429);
});

test('health check reports dry-run mode when no WhatsApp token is set', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, whatsapp: 'dry-run' });
});
