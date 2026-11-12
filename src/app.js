'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { StoreError, ORDER_STATUSES } = require('./store');
const { normalizePhone, naira } = require('./format');
const { parseWebhook, verifySignature } = require('./whatsapp');
const { createBot, orderSummary } = require('./bot');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'admin_session';
const MAX_LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Express 4 does not forward promise rejections; this wrapper does. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest();
}

/**
 * Builds the Express application.
 *  - /webhook/whatsapp  Meta Cloud API webhook
 *  - /api/shop/*        public storefront API
 *  - /api/admin/*       admin API (cookie session)
 *  - /                  storefront UI, /admin  admin panel UI
 */
function createApp({ store, whatsapp, config, logger = console }) {
  const app = express();
  app.disable('x-powered-by');

  const adminSessions = new Map(); // token -> expiresAt

  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }));

  // ---------- Messaging helpers ----------

  /** Sends a WhatsApp message and records it in the conversation log. */
  async function dispatch(to, body) {
    store.logMessage('out', to, body);
    try {
      await whatsapp.sendText(to, body);
    } catch (err) {
      logger.error(`Failed to send WhatsApp message to ${to}: ${err.message}`);
    }
  }

  function notifyAdmin(text) {
    const adminPhone = normalizePhone(store.getSettings().admin_phone);
    if (adminPhone) dispatch(adminPhone, text);
  }

  // Incoming messages are processed one at a time so replies stay in order.
  let queue = Promise.resolve();
  function enqueueIncoming(message) {
    queue = queue
      .then(async () => {
        store.logMessage('in', message.from, message.text || `[${message.type} message]`);
        const replies = await bot.handleMessage(message.from, message.text, message.name);
        for (const reply of replies) await dispatch(message.from, reply);
      })
      .catch((err) => logger.error('Error handling WhatsApp message:', err));
    return queue;
  }

  function onOrderCreated(order) {
    if (order.source === 'whatsapp') {
      notifyAdmin(`🛎️ New WhatsApp order *${order.order_no}* from ${order.customer_name || order.phone}: ${naira(order.total)}`);
    }
  }
  const bot = createBot({ store, onOrderCreated });

  // ---------- WhatsApp webhook ----------

  app.get('/webhook/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === config.whatsapp.verifyToken) {
      return res.status(200).send(String(challenge));
    }
    return res.sendStatus(403);
  });

  app.post('/webhook/whatsapp', (req, res) => {
    if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), config.whatsapp.appSecret)) {
      return res.sendStatus(403);
    }
    // Acknowledge quickly; Meta retries if the response is slow.
    res.sendStatus(200);
    for (const message of parseWebhook(req.body)) enqueueIncoming(message);
    return undefined;
  });

  // ---------- Storefront API (public) ----------

  app.get('/api/shop/config', (_req, res) => {
    const s = store.getSettings();
    res.json({ store_name: s.store_name, welcome_note: s.welcome_note, categories: store.listCategories() });
  });

  app.get('/api/shop/products', (req, res) => {
    const products = store.listProducts({
      activeOnly: true,
      category: req.query.category || undefined,
      search: req.query.q || undefined,
    });
    res.json({ products });
  });

  app.post('/api/shop/orders', wrap(async (req, res) => {
    const { name, phone, address, items } = req.body || {};
    const normalizedPhone = normalizePhone(phone);
    if (!String(name || '').trim()) throw new StoreError('Please enter your name');
    if (!normalizedPhone) throw new StoreError('Enter a valid WhatsApp phone number, e.g. 08012345678');
    if (String(address || '').trim().length < 5) throw new StoreError('Please enter a delivery address');
    if (!Array.isArray(items) || items.length === 0) throw new StoreError('Your cart is empty');
    const cleanItems = items.map((i) => ({ productId: Number(i.productId), qty: Number(i.qty) }));
    if (cleanItems.some((i) => !Number.isInteger(i.qty) || i.qty < 1)) throw new StoreError('Invalid quantity');

    const order = store.createOrder({
      phone: normalizedPhone,
      customerName: String(name).trim(),
      address: String(address).trim(),
      items: cleanItems,
      source: 'web',
    });
    const s = store.getSettings();
    const payment = s.account_number
      ? `Bank: ${s.bank_name}\nAccount name: ${s.account_name}\nAccount number: ${s.account_number}\nUse ${order.order_no} as your payment reference.`
      : 'Our team will contact you on WhatsApp with payment details.';
    await dispatch(normalizedPhone, `✅ Thanks ${order.customer_name}! Your order *${order.order_no}* (${naira(order.total)}) was received.\n\n${payment}\n\nType *track ${order.order_no}* to check progress.`);
    notifyAdmin(`🛒 New web order *${order.order_no}* from ${order.customer_name}: ${naira(order.total)}`);
    res.status(201).json({ order: { ...order, payment } });
  }));

  app.get('/api/shop/orders/:orderNo', (req, res, next) => {
    try {
      const order = store.getOrderByNumber(req.params.orderNo);
      const phone = normalizePhone(req.query.phone);
      if (!order || !phone || order.phone !== phone) throw new StoreError('No order found for that number and phone', 404);
      res.json({
        order_no: order.order_no,
        status: order.status,
        total: order.total,
        created_at: order.created_at,
        items: order.items,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Admin auth ----------

  function parseCookies(header = '') {
    return Object.fromEntries(
      header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
      }),
    );
  }

  function isAdmin(req) {
    const token = parseCookies(req.get('cookie'))[COOKIE];
    if (!token) return false;
    const expires = adminSessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      adminSessions.delete(token);
      return false;
    }
    return true;
  }

  function requireAdmin(req, res, next) {
    if (isAdmin(req)) return next();
    return res.status(401).json({ error: 'Please sign in to the admin panel' });
  }

  const loginFailures = new Map(); // ip -> { count, resetAt }

  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const record = loginFailures.get(ip);
    if (record && record.resetAt > Date.now() && record.count >= MAX_LOGIN_FAILURES) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const password = String((req.body || {}).password || '');
    if (!crypto.timingSafeEqual(sha256(password), sha256(config.adminPassword))) {
      const fresh = !record || record.resetAt <= Date.now();
      loginFailures.set(ip, { count: fresh ? 1 : record.count + 1, resetAt: fresh ? Date.now() + LOGIN_WINDOW_MS : record.resetAt });
      return res.status(401).json({ error: 'Incorrect password' });
    }
    loginFailures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, Date.now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    return res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    const token = parseCookies(req.get('cookie'))[COOKIE];
    if (token) adminSessions.delete(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (req, res) => res.json({ authenticated: isAdmin(req) }));

  // ---------- Admin API ----------

  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/stats', (_req, res) => res.json(store.stats()));

  admin.get('/products', (req, res) => {
    res.json({
      products: store.listProducts({
        category: req.query.category || undefined,
        search: req.query.q || undefined,
      }),
    });
  });
  admin.post('/products', (req, res) => res.status(201).json({ product: store.createProduct(req.body || {}) }));
  admin.put('/products/:id', (req, res) => res.json({ product: store.updateProduct(req.params.id, req.body || {}) }));
  admin.delete('/products/:id', (req, res) => res.json(store.deleteProduct(req.params.id)));

  admin.get('/orders', (req, res) => {
    res.json({ orders: store.listOrders({ status: req.query.status || undefined }) });
  });
  admin.get('/orders/:id', (req, res) => {
    const order = store.getOrder(req.params.id);
    if (!order) throw new StoreError('Order not found', 404);
    res.json({ order });
  });
  admin.patch('/orders/:id', wrap(async (req, res) => {
    const status = String((req.body || {}).status || '');
    if (!ORDER_STATUSES.includes(status)) throw new StoreError('Invalid order status');
    const before = store.getOrder(req.params.id);
    if (!before) throw new StoreError('Order not found', 404);
    const order = store.updateOrderStatus(req.params.id, status);
    if (before.status !== status) {
      await dispatch(order.phone, `📦 Update on order *${order.order_no}*: status is now *${status.toUpperCase()}*.\n\nType *track ${order.order_no}* for details.`);
    }
    res.json({ order });
  }));

  admin.get('/customers', (_req, res) => res.json({ customers: store.listCustomers() }));

  admin.get('/conversations', (_req, res) => res.json({ conversations: store.listConversations() }));
  admin.get('/messages', (req, res) => {
    res.json({ messages: store.listMessages({ phone: req.query.phone || undefined, limit: 300 }) });
  });

  admin.get('/settings', (_req, res) => res.json({ settings: store.getSettings() }));
  admin.put('/settings', (req, res) => res.json({ settings: store.setSettings(req.body || {}) }));

  /** Runs a message through the bot without sending anything to WhatsApp (for testing). */
  admin.post('/simulate', wrap(async (req, res) => {
    const phone = normalizePhone((req.body || {}).phone);
    if (!phone) throw new StoreError('Enter a phone number for the simulated customer');
    const text = String((req.body || {}).text || '');
    const name = String((req.body || {}).name || '');
    store.logMessage('in', phone, text || '[empty]');
    const replies = await bot.handleMessage(phone, text, name);
    for (const reply of replies) store.logMessage('out', phone, reply);
    res.json({ phone, replies });
  }));

  admin.get('/orders/:id/summary', (req, res) => {
    const order = store.getOrder(req.params.id);
    if (!order) throw new StoreError('Order not found', 404);
    res.type('text/plain').send(orderSummary(order));
  });

  app.use('/api/admin', (req, res, next) => {
    if (req.path === '/login' || req.path === '/logout' || req.path === '/me') return next();
    return admin(req, res, next);
  });

  // ---------- Static UIs ----------

  const publicDir = path.join(__dirname, '..', 'public');
  app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(publicDir, 'admin', 'index.html')));
  app.use('/admin', express.static(path.join(publicDir, 'admin')));
  app.use(express.static(path.join(publicDir, 'shop')));

  // ---------- Errors ----------

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof StoreError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    logger.error(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return { app, dispatch, enqueueIncoming };
}

module.exports = { createApp };
