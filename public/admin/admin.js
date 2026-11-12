'use strict';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-US');
const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T') + (String(s).includes('T') ? '' : 'Z')).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const STATUSES = ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'];

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('Please sign in again');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').showModal();
  return $('#modal-body');
}
function closeModal() { $('#modal').close(); }

// ---------- auth ----------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('input[name=password]', $('#login-form')).focus();
}
function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = e.target.password.value;
  $('#login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password } });
    e.target.password.value = '';
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
  showLogin();
});

async function boot() {
  const me = await fetch('/api/admin/me', { credentials: 'same-origin' }).then((r) => r.json());
  if (!me.authenticated) return showLogin();
  showApp();
  const { settings } = await api('/settings');
  $('#brand-name').textContent = settings.store_name;
  route();
}

// ---------- router ----------
const views = {
  dashboard: renderDashboard,
  products: renderProducts,
  orders: renderOrders,
  customers: renderCustomers,
  messages: renderMessages,
  simulator: renderSimulator,
  settings: renderSettings,
};
let pollTimer = null;

function route() {
  const name = (location.hash.replace('#', '') || 'dashboard');
  const key = views[name] ? name : 'dashboard';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === key));
  clearInterval(pollTimer);
  pollTimer = null;
  views[key]().catch((err) => toast(err.message, true));
}
window.addEventListener('hashchange', route);

function setView(html) { $('#view').innerHTML = html; }

// ---------- dashboard ----------
async function renderDashboard() {
  const s = await api('/stats');
  const statusBadges = s.by_status.map((r) => `<span class="badge ${esc(r.status)}">${esc(r.status)}: ${r.n}</span>`).join(' ') || '<span class="muted">No orders yet</span>';
  setView(`
    <div class="page-head"><h1>Dashboard</h1><button class="btn ghost small" onclick="route()">Refresh</button></div>
    <div class="stats">
      <div class="stat"><div class="label">Revenue (excl. cancelled)</div><div class="value">${naira(s.revenue)}</div></div>
      <div class="stat"><div class="label">Orders</div><div class="value">${s.orders}</div></div>
      <div class="stat"><div class="label">Awaiting payment</div><div class="value">${s.pending}</div></div>
      <div class="stat"><div class="label">To fulfil</div><div class="value">${s.to_fulfil}</div></div>
      <div class="stat"><div class="label">Active products</div><div class="value">${s.products}</div></div>
      <div class="stat"><div class="label">Customers</div><div class="value">${s.customers}</div></div>
    </div>
    <div class="card"><h2>Orders by status</h2><p>${statusBadges}</p></div>
    <div class="grid-2">
      <div class="card"><h2>Recent orders</h2>${orderList(s.recent_orders)}</div>
      <div class="card"><h2>Low stock (5 or fewer)</h2>
        ${s.low_stock.length ? `<table><tbody>${s.low_stock.map((p) => `<tr><td><a href="#products">${esc(p.name)}</a></td><td class="num">${p.stock} left</td></tr>`).join('')}</tbody></table>` : '<p class="muted">All products are well stocked.</p>'}
      </div>
    </div>`);
}

function orderList(orders) {
  if (!orders.length) return '<p class="muted">No orders yet.</p>';
  return `<table><thead><tr><th>Order</th><th>Customer</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
    ${orders.map((o) => `<tr><td><a href="#orders" data-open-order="${o.id}">${esc(o.order_no)}</a></td><td>${esc(o.customer_name || o.phone)}</td><td class="num">${naira(o.total)}</td><td><span class="badge ${esc(o.status)}">${esc(o.status)}</span></td></tr>`).join('')}
  </tbody></table>`;
}

// ---------- products ----------
let productFilter = '';
async function renderProducts() {
  const { products } = await api(`/products${productFilter ? `?q=${encodeURIComponent(productFilter)}` : ''}`);
  setView(`
    <div class="page-head">
      <h1>Products</h1>
      <div class="toolbar">
        <input id="product-search" placeholder="Search products" value="${esc(productFilter)}">
        <button class="btn primary" id="new-product">+ New product</button>
      </div>
    </div>
    <table>
      <thead><tr><th>ID</th><th>Name</th><th>Category</th><th class="num">Price</th><th class="num">Stock</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${products.length ? products.map((p) => `
          <tr>
            <td>${p.id}</td>
            <td><strong>${esc(p.name)}</strong><div class="muted">${esc(p.description).slice(0, 80)}</div></td>
            <td>${esc(p.category)}</td>
            <td class="num">${naira(p.price)}</td>
            <td class="num">${p.stock}</td>
            <td><span class="badge ${p.active ? 'active' : 'inactive'}">${p.active ? 'active' : 'hidden'}</span></td>
            <td class="num">
              <button class="btn small" data-edit="${p.id}">Edit</button>
              <button class="btn small danger" data-delete="${p.id}">Delete</button>
            </td>
          </tr>`).join('') : '<tr><td colspan="7" class="empty">No products yet. Click "New product" to add one.</td></tr>'}
      </tbody>
    </table>`);

  $('#product-search').addEventListener('change', (e) => { productFilter = e.target.value.trim(); renderProducts(); });
  $('#new-product').addEventListener('click', () => productForm());
}

function productForm(p = {}) {
  const body = openModal(`
    <h2>${p.id ? `Edit product #${p.id}` : 'New product'}</h2>
    <form id="product-form" class="form-grid">
      <label class="full">Name<input name="name" required value="${esc(p.name)}"></label>
      <label>Category<input name="category" value="${esc(p.category || '')}" placeholder="e.g. Fashion"></label>
      <label>Price (₦)<input name="price" type="number" min="0" step="1" required value="${p.price ?? ''}"></label>
      <label>Stock<input name="stock" type="number" min="0" step="1" required value="${p.stock ?? 0}"></label>
      <label>Image URL<input name="image_url" value="${esc(p.image_url || '')}" placeholder="https://..."></label>
      <label class="full">Description<textarea name="description">${esc(p.description || '')}</textarea></label>
      <label class="check full"><input type="checkbox" name="active" ${p.active === false ? '' : 'checked'}> Visible to customers (active)</label>
      <div class="form-actions full">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`);
  body.querySelector('[data-close]').addEventListener('click', closeModal);
  body.querySelector('#product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const payload = {
      name: f.get('name'),
      category: f.get('category'),
      price: Number(f.get('price')),
      stock: Number(f.get('stock')),
      image_url: f.get('image_url'),
      description: f.get('description'),
      active: f.get('active') === 'on',
    };
    try {
      if (p.id) await api(`/products/${p.id}`, { method: 'PUT', body: payload });
      else await api('/products', { method: 'POST', body: payload });
      closeModal();
      toast('Product saved');
      renderProducts();
    } catch (err) { toast(err.message, true); }
  });
}

document.addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const { products } = await api('/products');
    productForm(products.find((p) => String(p.id) === edit.dataset.edit));
    return;
  }
  const del = e.target.closest('[data-delete]');
  if (del) {
    if (!confirm('Delete this product? Products already in orders will be hidden instead of deleted.')) return;
    try {
      const r = await api(`/products/${del.dataset.delete}`, { method: 'DELETE' });
      toast(r.deleted ? 'Product deleted' : 'Product has past orders, so it was hidden');
      renderProducts();
    } catch (err) { toast(err.message, true); }
    return;
  }
  const openOrder = e.target.closest('[data-open-order]');
  if (openOrder) {
    e.preventDefault();
    if (location.hash !== '#orders') location.hash = '#orders';
    setTimeout(() => orderDetail(openOrder.dataset.openOrder), 150);
  }
});

// ---------- orders ----------
let orderStatusFilter = '';
async function renderOrders() {
  const { orders } = await api(`/orders${orderStatusFilter ? `?status=${orderStatusFilter}` : ''}`);
  setView(`
    <div class="page-head">
      <h1>Orders</h1>
      <div class="toolbar">
        <select id="order-filter">
          <option value="">All statuses</option>
          ${STATUSES.map((s) => `<option value="${s}" ${s === orderStatusFilter ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <table>
      <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Source</th><th class="num">Total</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${orders.length ? orders.map((o) => `
          <tr>
            <td><strong>${esc(o.order_no)}</strong></td>
            <td>${fmtDate(o.created_at)}</td>
            <td>${esc(o.customer_name || '—')}<div class="muted">${esc(o.phone)}</div></td>
            <td>${esc(o.source)}</td>
            <td class="num">${naira(o.total)}</td>
            <td>
              <select data-status="${o.id}" style="width:auto">
                ${STATUSES.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </td>
            <td class="num"><button class="btn small" data-view-order="${o.id}">View</button></td>
          </tr>`).join('') : '<tr><td colspan="7" class="empty">No orders match this filter.</td></tr>'}
      </tbody>
    </table>
    <p class="muted">Changing a status notifies the customer on WhatsApp. Cancelling an order returns its items to stock.</p>`);

  $('#order-filter').addEventListener('change', (e) => { orderStatusFilter = e.target.value; renderOrders(); });
}

document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-status]');
  if (!sel) return;
  if (sel.value === 'cancelled' && !confirm('Cancel this order? Stock will be returned to inventory.')) {
    return renderOrders();
  }
  try {
    await api(`/orders/${sel.dataset.status}`, { method: 'PATCH', body: { status: sel.value } });
    toast('Order updated and customer notified');
    renderOrders();
  } catch (err) {
    toast(err.message, true);
    renderOrders();
  }
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view-order]');
  if (btn) orderDetail(btn.dataset.viewOrder);
});

async function orderDetail(id) {
  const { order: o } = await api(`/orders/${id}`);
  openModal(`
    <h2>Order ${esc(o.order_no)}</h2>
    <div class="kv">
      <div>Status</div><div><span class="badge ${esc(o.status)}">${esc(o.status)}</span></div>
      <div>Placed</div><div>${fmtDate(o.created_at)}</div>
      <div>Customer</div><div>${esc(o.customer_name || '—')}</div>
      <div>Phone</div><div>${esc(o.phone)}</div>
      <div>Address</div><div>${esc(o.address || '—')}</div>
      <div>Source</div><div>${esc(o.source)}</div>
    </div>
    <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Line total</th></tr></thead>
      <tbody>${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${naira(i.lineTotal)}</td></tr>`).join('')}
      <tr><th>Total</th><th></th><th class="num">${naira(o.total)}</th></tr></tbody></table>
    <div class="form-actions"><button class="btn ghost" data-close>Close</button></div>`).querySelector('[data-close]').addEventListener('click', closeModal);
}

// ---------- customers ----------
async function renderCustomers() {
  const { customers } = await api('/customers');
  setView(`
    <div class="page-head"><h1>Customers</h1></div>
    <table>
      <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th class="num">Orders</th><th class="num">Total spent</th><th>Joined</th></tr></thead>
      <tbody>
        ${customers.length ? customers.map((c) => `
          <tr>
            <td>${esc(c.name || '—')}</td>
            <td>${esc(c.phone)}</td>
            <td>${esc(c.address || '—')}</td>
            <td class="num">${c.order_count}</td>
            <td class="num">${naira(c.total_spent)}</td>
            <td>${fmtDate(c.created_at)}</td>
          </tr>`).join('') : '<tr><td colspan="6" class="empty">No customers yet.</td></tr>'}
      </tbody>
    </table>`);
}

// ---------- WhatsApp inbox ----------
let activePhone = null;
async function renderMessages() {
  const { conversations } = await api('/conversations');
  if (!activePhone && conversations.length) activePhone = conversations[0].phone;
  setView(`
    <div class="page-head">
      <h1>WhatsApp inbox</h1>
      <div class="toolbar"><span class="muted">Auto-refreshes every 10s</span><button class="btn ghost small" id="refresh-inbox">Refresh</button></div>
    </div>
    <div class="inbox">
      <div class="convo-list">
        ${conversations.length ? conversations.map((c) => `
          <div class="convo ${c.phone === activePhone ? 'active' : ''}" data-phone="${esc(c.phone)}">
            <div class="who">${esc(c.name || c.phone)}</div>
            <div class="preview">${c.last_direction === 'out' ? '↩ ' : ''}${esc(c.last_message)}</div>
          </div>`).join('') : '<div class="empty">No conversations yet. Messages will appear here once customers write to the bot.</div>'}
      </div>
      <div>
        <div class="chat" id="thread">${activePhone ? '' : '<div class="empty">Select a conversation</div>'}</div>
      </div>
    </div>`);

  $('#refresh-inbox').addEventListener('click', renderMessages);
  document.querySelectorAll('.convo').forEach((el) => el.addEventListener('click', () => {
    activePhone = el.dataset.phone;
    renderMessages();
  }));
  if (activePhone) await loadThread();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (location.hash === '#messages') renderMessages(); }, 10000);
}

async function loadThread() {
  const { messages } = await api(`/messages?phone=${encodeURIComponent(activePhone)}`);
  const thread = $('#thread');
  if (!thread) return;
  thread.innerHTML = messages.map((m) => `
    <div class="bubble ${m.direction}">${esc(m.body)}<time>${fmtDate(m.created_at)}</time></div>`).join('') || '<div class="empty">No messages</div>';
  thread.scrollTop = thread.scrollHeight;
}

// ---------- chat simulator ----------
let simPhone = '2348000000001';
let simTranscript = [];
function renderSimulator() {
  setView(`
    <div class="page-head">
      <h1>Chat simulator</h1>
      <div class="toolbar">
        <input id="sim-name" placeholder="Customer name" style="min-width:160px" value="Test Customer">
        <input id="sim-phone" placeholder="Phone" value="${esc(simPhone)}" style="min-width:160px">
        <button class="btn ghost" id="sim-new">New chat</button>
      </div>
    </div>
    <p class="muted">Test the WhatsApp bot without a phone. Messages here are not sent to WhatsApp, but they do create real orders in the database.</p>
    <div class="card" style="padding:0;max-width:520px">
      <div class="chat" id="sim-chat" style="height:55vh;border-radius:12px 12px 0 0">${simTranscript.map(bubble).join('')}</div>
    </div>
    <form class="chat-input" id="sim-form" style="max-width:520px">
      <input name="text" placeholder="Type a message, e.g. menu" autocomplete="off" autofocus>
      <button class="btn primary" type="submit">Send</button>
    </form>`);
  $('#sim-chat').scrollTop = 1e9;
  $('#sim-new').addEventListener('click', () => {
    simPhone = `23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    simTranscript = [];
    renderSimulator();
  });
  $('#sim-phone').addEventListener('change', (e) => { simPhone = e.target.value.trim(); simTranscript = []; renderSimulator(); });
  $('#sim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.text;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    simTranscript.push({ direction: 'in', body: text, at: new Date() });
    renderSimulator();
    try {
      const phone = $('#sim-phone').value.trim() || simPhone;
      const { replies } = await api('/simulate', { method: 'POST', body: { phone, name: $('#sim-name').value.trim(), text } });
      simPhone = phone;
      replies.forEach((r) => simTranscript.push({ direction: 'out', body: r, at: new Date() }));
    } catch (err) {
      simTranscript.push({ direction: 'out', body: `⚠️ ${err.message}`, at: new Date() });
    }
    renderSimulator();
    $('#sim-form [name=text]').focus();
  });
}
function bubble(m) {
  return `<div class="bubble ${m.direction}">${esc(m.body)}<time>${m.at.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}</time></div>`;
}

// ---------- settings ----------
async function renderSettings() {
  const { settings: s } = await api('/settings');
  const field = (name, label, opts = {}) => `<label class="${opts.full ? 'full' : ''}">${label}<input name="${name}" value="${esc(s[name])}" placeholder="${esc(opts.placeholder || '')}"></label>`;
  setView(`
    <div class="page-head"><h1>Settings</h1></div>
    <form id="settings-form" class="card" style="max-width:720px">
      <div class="form-grid">
        ${field('store_name', 'Store name')}
        ${field('admin_phone', 'Admin WhatsApp number (gets order alerts)', { placeholder: '08012345678' })}
        <label class="full">Welcome note<textarea name="welcome_note">${esc(s.welcome_note)}</textarea></label>
        <h2 class="full" style="margin:.5rem 0 0">Payment details</h2>
        <p class="full muted" style="margin:0 0 .5rem">Shown to customers after they place an order. Leave blank if you confirm payments manually.</p>
        ${field('bank_name', 'Bank name')}
        ${field('account_name', 'Account name')}
        ${field('account_number', 'Account number')}
      </div>
      <div class="form-actions"><button class="btn primary" type="submit">Save settings</button></div>
    </form>`);
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await api('/settings', { method: 'PUT', body: payload });
      $('#brand-name').textContent = r.settings.store_name;
      toast('Settings saved');
    } catch (err) { toast(err.message, true); }
  });
}

// expose for inline onclick in dashboard
window.route = route;

boot().catch((err) => { toast(err.message, true); showLogin(); });
