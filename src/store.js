'use strict';

const crypto = require('node:crypto');

const ORDER_STATUSES = ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'];

const DEFAULT_SETTINGS = {
  store_name: 'My Store',
  welcome_note: 'Thanks for shopping with us!',
  bank_name: '',
  account_name: '',
  account_number: '',
  admin_phone: '',
};

const SAMPLE_PRODUCTS = [
  { name: 'Ankara Print Shirt', category: 'Fashion', price: 8500, stock: 25, description: 'Handmade Ankara shirt, sizes M-XL.' },
  { name: 'Men\'s Leather Sandals', category: 'Footwear', price: 12000, stock: 12, description: 'Genuine leather, comfortable everyday wear.' },
  { name: 'Wireless Earbuds', category: 'Electronics', price: 15000, stock: 8, description: 'Bluetooth 5.3 with 24h battery case.' },
  { name: 'Phone Charger 25W', category: 'Electronics', price: 6500, stock: 40, description: 'Fast-charging USB-C adapter.' },
  { name: 'Shea Butter 500g', category: 'Beauty', price: 3000, stock: 60, description: 'Raw unrefined shea butter.' },
  { name: 'Jollof Spice Pack', category: 'Food', price: 2500, stock: 100, description: 'Seasoning blend for the perfect party jollof.' },
];

class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

function toProduct(row) {
  if (!row) return null;
  return { ...row, active: Boolean(row.active) };
}

/** Data-access layer. All business rules (stock, order status, etc.) live here. */
function createStore(db) {
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- Products ----------

  function sanitizeProduct(input) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new StoreError('Product name is required');
    const price = Number(input.price);
    if (!Number.isInteger(price) || price < 0) throw new StoreError('Price must be a whole number of naira (0 or more)');
    const stock = Number(input.stock ?? 0);
    if (!Number.isInteger(stock) || stock < 0) throw new StoreError('Stock must be a whole number (0 or more)');
    const inactive = input.active === false || input.active === 0 || input.active === '0';
    return {
      name,
      description: String(input.description ?? '').trim(),
      category: String(input.category ?? '').trim() || 'General',
      price,
      stock,
      image_url: String(input.image_url ?? '').trim(),
      active: inactive ? 0 : 1,
    };
  }

  function getProduct(id) {
    return toProduct(get('SELECT * FROM products WHERE id = ?', Number(id)));
  }

  function listProducts({ activeOnly = false, category, search } = {}) {
    const where = [];
    const params = [];
    if (activeOnly) where.push('active = 1');
    if (category) {
      where.push('LOWER(category) = LOWER(?)');
      params.push(category);
    }
    if (search) {
      where.push('(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)');
      const like = `%${String(search).toLowerCase()}%`;
      params.push(like, like);
    }
    const sql = `SELECT * FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY category, name`;
    return all(sql, ...params).map(toProduct);
  }

  function listCategories() {
    return all("SELECT DISTINCT category FROM products WHERE active = 1 ORDER BY category").map((r) => r.category);
  }

  function createProduct(input) {
    const p = sanitizeProduct(input);
    const r = run(
      'INSERT INTO products (name, description, category, price, stock, image_url, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.name, p.description, p.category, p.price, p.stock, p.image_url, p.active,
    );
    return getProduct(r.lastInsertRowid);
  }

  function updateProduct(id, input) {
    const existing = getProduct(id);
    if (!existing) throw new StoreError('Product not found', 404);
    const p = sanitizeProduct({ ...existing, ...input });
    run(
      'UPDATE products SET name = ?, description = ?, category = ?, price = ?, stock = ?, image_url = ?, active = ? WHERE id = ?',
      p.name, p.description, p.category, p.price, p.stock, p.image_url, p.active, Number(id),
    );
    return getProduct(id);
  }

  /** Deletes a product, or deactivates it if it already appears in orders (keeps order history intact). */
  function deleteProduct(id) {
    const used = get('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?', Number(id)).n;
    if (used > 0) {
      run('UPDATE products SET active = 0 WHERE id = ?', Number(id));
      return { deleted: false, deactivated: true };
    }
    run('DELETE FROM products WHERE id = ?', Number(id));
    return { deleted: true, deactivated: false };
  }

  // ---------- Cart ----------

  function getCart(phone) {
    const items = all(
      `SELECT c.product_id, c.qty, p.name, p.price, p.stock, p.active
       FROM cart_items c JOIN products p ON p.id = c.product_id
       WHERE c.phone = ? ORDER BY c.rowid`,
      phone,
    ).map((r) => ({
      productId: r.product_id,
      name: r.name,
      price: r.price,
      qty: r.qty,
      stock: r.stock,
      available: Boolean(r.active),
      lineTotal: r.price * r.qty,
    }));
    return {
      items,
      count: items.reduce((sum, i) => sum + i.qty, 0),
      total: items.reduce((sum, i) => sum + i.lineTotal, 0),
    };
  }

  function addToCart(phone, productId, qty = 1) {
    const p = getProduct(productId);
    if (!p || !p.active) throw new StoreError('That product is not available');
    if (!Number.isInteger(qty) || qty < 1) throw new StoreError('Quantity must be at least 1');
    const current = get('SELECT qty FROM cart_items WHERE phone = ? AND product_id = ?', phone, p.id)?.qty ?? 0;
    const newQty = current + qty;
    if (newQty > p.stock) {
      throw new StoreError(p.stock > 0 ? `Only ${p.stock} of ${p.name} left in stock` : `${p.name} is out of stock`);
    }
    run(
      `INSERT INTO cart_items (phone, product_id, qty) VALUES (?, ?, ?)
       ON CONFLICT(phone, product_id) DO UPDATE SET qty = excluded.qty`,
      phone, p.id, newQty,
    );
    return { product: p, qty: newQty };
  }

  function removeFromCart(phone, productId) {
    return run('DELETE FROM cart_items WHERE phone = ? AND product_id = ?', phone, Number(productId)).changes > 0;
  }

  function clearCart(phone) {
    run('DELETE FROM cart_items WHERE phone = ?', phone);
  }

  // ---------- Orders ----------

  function getOrder(id) {
    const order = get('SELECT * FROM orders WHERE id = ?', Number(id));
    if (!order) return null;
    return { ...order, items: getOrderItems(order.id) };
  }

  function getOrderItems(orderId) {
    return all('SELECT product_id, product_name, unit_price, qty FROM order_items WHERE order_id = ? ORDER BY id', orderId).map((r) => ({
      productId: r.product_id,
      name: r.product_name,
      unitPrice: r.unit_price,
      qty: r.qty,
      lineTotal: r.unit_price * r.qty,
    }));
  }

  function getOrderByNumber(orderNo) {
    const order = get('SELECT * FROM orders WHERE order_no = ?', String(orderNo || '').trim().toUpperCase());
    return order ? getOrder(order.id) : null;
  }

  function listOrders({ status, phone, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (phone) {
      where.push('phone = ?');
      params.push(phone);
    }
    params.push(Number(limit));
    return all(
      `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      ...params,
    );
  }

  /**
   * Creates an order from a list of {productId, qty}. Validates availability,
   * reserves stock and records the customer, all in one transaction.
   */
  function createOrder({ phone, customerName = '', address = '', items, source = 'whatsapp', clearCartAfter = false }) {
    if (!Array.isArray(items) || items.length === 0) throw new StoreError('Your cart is empty');
    return tx(() => {
      let total = 0;
      const lines = [];
      for (const { productId, qty } of items) {
        const p = getProduct(productId);
        if (!p || !p.active) throw new StoreError(`"${p?.name ?? 'A product'}" is no longer available`);
        if (qty > p.stock) throw new StoreError(`Only ${p.stock} of ${p.name} left in stock`);
        total += p.price * qty;
        lines.push({ p, qty });
      }

      let orderNo = null;
      for (let attempt = 0; attempt < 5 && !orderNo; attempt++) {
        const candidate = `ORD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        if (!get('SELECT 1 AS x FROM orders WHERE order_no = ?', candidate)) orderNo = candidate;
      }
      if (!orderNo) throw new StoreError('Could not generate an order number, please retry', 500);

      const r = run(
        `INSERT INTO orders (order_no, phone, customer_name, address, total, status, source)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        orderNo, phone, customerName, address, total, source,
      );
      const orderId = Number(r.lastInsertRowid);
      for (const { p, qty } of lines) {
        run(
          'INSERT INTO order_items (order_id, product_id, product_name, unit_price, qty) VALUES (?, ?, ?, ?, ?)',
          orderId, p.id, p.name, p.price, qty,
        );
        run('UPDATE products SET stock = stock - ? WHERE id = ?', qty, p.id);
      }
      if (clearCartAfter) clearCart(phone);
      if (customerName || address) upsertCustomer(phone, customerName, address);
      return getOrder(orderId);
    });
  }

  function updateOrderStatus(id, status) {
    if (!ORDER_STATUSES.includes(status)) throw new StoreError('Invalid order status');
    return tx(() => {
      const order = get('SELECT * FROM orders WHERE id = ?', Number(id));
      if (!order) throw new StoreError('Order not found', 404);
      if (order.status === status) return getOrder(id);
      if (order.status === 'cancelled') throw new StoreError('Cancelled orders cannot be reopened');
      if (status === 'cancelled') {
        // Give reserved stock back to the shelf.
        for (const item of getOrderItems(order.id)) {
          if (item.productId) run('UPDATE products SET stock = stock + ? WHERE id = ?', item.qty, item.productId);
        }
      }
      run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", status, order.id);
      return getOrder(id);
    });
  }

  // ---------- Customers ----------

  function upsertCustomer(phone, name = '', address = '') {
    run(
      `INSERT INTO customers (phone, name, address) VALUES (?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET
         name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE customers.name END,
         address = CASE WHEN excluded.address <> '' THEN excluded.address ELSE customers.address END`,
      phone, String(name || '').trim(), String(address || '').trim(),
    );
  }

  function getCustomer(phone) {
    return get('SELECT * FROM customers WHERE phone = ?', phone) || null;
  }

  function listCustomers() {
    return all(
      `SELECT c.*,
         (SELECT COUNT(*) FROM orders o WHERE o.phone = c.phone) AS order_count,
         (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.phone = c.phone AND o.status <> 'cancelled') AS total_spent
       FROM customers c ORDER BY c.created_at DESC`,
    );
  }

  // ---------- Conversation state ----------

  function getSession(phone) {
    const row = get('SELECT state, data FROM sessions WHERE phone = ?', phone);
    if (!row) return { state: 'idle', data: {} };
    return { state: row.state, data: JSON.parse(row.data || '{}') };
  }

  function setSession(phone, state, data = {}) {
    run(
      `INSERT INTO sessions (phone, state, data, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(phone) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
      phone, state, JSON.stringify(data),
    );
  }

  function logMessage(direction, phone, body) {
    run('INSERT INTO messages (direction, phone, body) VALUES (?, ?, ?)', direction, phone, String(body));
  }

  function listMessages({ phone, limit = 200 } = {}) {
    if (phone) return all('SELECT * FROM messages WHERE phone = ? ORDER BY id DESC LIMIT ?', phone, Number(limit)).reverse();
    return all('SELECT * FROM messages ORDER BY id DESC LIMIT ?', Number(limit)).reverse();
  }

  function listConversations() {
    return all(
      `SELECT m.phone, m.body AS last_message, m.created_at AS last_at, m.direction AS last_direction,
         COALESCE(c.name, '') AS name
       FROM messages m
       LEFT JOIN customers c ON c.phone = m.phone
       WHERE m.id IN (SELECT MAX(id) FROM messages GROUP BY phone)
       ORDER BY m.id DESC LIMIT 100`,
    );
  }

  // ---------- Settings ----------

  function getSettings() {
    const settings = { ...DEFAULT_SETTINGS };
    for (const row of all('SELECT key, value FROM settings')) {
      if (row.key in DEFAULT_SETTINGS) settings[row.key] = row.value;
    }
    return settings;
  }

  function setSettings(input) {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (input[key] === undefined) continue;
      run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key, String(input[key]).trim(),
      );
    }
    return getSettings();
  }

  // ---------- Dashboard ----------

  function stats() {
    const totals = get(
      `SELECT COUNT(*) AS orders,
         COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status IN ('paid', 'processing') THEN 1 ELSE 0 END), 0) AS to_fulfil
       FROM orders`,
    );
    return {
      ...totals,
      products: get('SELECT COUNT(*) AS n FROM products WHERE active = 1').n,
      customers: get('SELECT COUNT(*) AS n FROM customers').n,
      low_stock: all('SELECT id, name, stock FROM products WHERE active = 1 AND stock <= 5 ORDER BY stock LIMIT 10'),
      by_status: all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status'),
      recent_orders: listOrders({ limit: 8 }),
    };
  }

  // ---------- Seeding ----------

  function seedDemoData() {
    if (get('SELECT COUNT(*) AS n FROM products').n > 0) return false;
    for (const p of SAMPLE_PRODUCTS) createProduct(p);
    return true;
  }

  return {
    ORDER_STATUSES,
    DEFAULT_SETTINGS,
    tx,
    getProduct,
    listProducts,
    listCategories,
    createProduct,
    updateProduct,
    deleteProduct,
    getCart,
    addToCart,
    removeFromCart,
    clearCart,
    getOrder,
    getOrderByNumber,
    listOrders,
    createOrder,
    updateOrderStatus,
    upsertCustomer,
    getCustomer,
    listCustomers,
    getSession,
    setSession,
    logMessage,
    listMessages,
    listConversations,
    getSettings,
    setSettings,
    stats,
    seedDemoData,
  };
}

module.exports = { createStore, StoreError, ORDER_STATUSES, DEFAULT_SETTINGS };
