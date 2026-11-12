'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-US');
const CART_KEY = 'shop-cart-v1';
const EMOJI = { Fashion: '👕', Footwear: '👞', Electronics: '🎧', Beauty: '🧴', Food: '🍛', General: '📦' };

let catalog = [];  // full active catalogue (cart always uses this)
let products = []; // catalogue filtered by category/search for display
let category = '';
let query = '';
let cart = loadCart(); // { [productId]: qty }

function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return {}; }
}
function saveCart() { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 2800);
}

async function getJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- catalogue ----------
async function loadStore() {
  const cfg = await getJSON('/api/shop/config');
  $('#store-name').textContent = `🛍️ ${cfg.store_name}`;
  document.title = cfg.store_name;
  $('#welcome').textContent = cfg.welcome_note || '';
  await loadProducts();
}

async function loadProducts() {
  ({ products: catalog } = await getJSON('/api/shop/products'));
  applyFilters();
}

function applyFilters() {
  const q = query.toLowerCase();
  products = catalog.filter((p) =>
    (!category || p.category === category) &&
    (!q || `${p.name} ${p.description}`.toLowerCase().includes(q)));
  renderCategories();
  renderProducts();
  renderCart();
}

function renderCategories() {
  const cats = [...new Set(catalog.map((p) => p.category))].sort();
  const all = ['', ...cats];
  $('#categories').innerHTML = all.map((c) => `
    <button class="chip ${c === category ? 'active' : ''}" data-cat="${esc(c)}">${c ? esc(c) : 'All'}</button>`).join('');
}

function renderProducts() {
  if (!products.length) {
    $('#products').innerHTML = '<p class="muted">No products match your search.</p>';
    return;
  }
  $('#products').innerHTML = products.map((p) => {
    const inCart = cart[p.id] || 0;
    const out = p.stock <= 0;
    const low = p.stock > 0 && p.stock <= 5;
    return `
      <article class="product">
        <div class="img" style="${p.image_url ? `background-image:url('${esc(p.image_url)}')` : ''}">${p.image_url ? '' : (EMOJI[p.category] || '📦')}</div>
        <div class="cat">${esc(p.category)}</div>
        <div class="name">${esc(p.name)}</div>
        <div class="desc">${esc(p.description)}</div>
        <div class="price">${naira(p.price)}</div>
        <div class="stock ${low ? 'low' : ''}">${out ? 'Out of stock' : low ? `Only ${p.stock} left` : 'In stock'}</div>
        <button class="btn primary" data-add="${p.id}" ${out || inCart >= p.stock ? 'disabled' : ''}>
          ${inCart ? `In cart (${inCart}) · Add more` : 'Add to cart'}
        </button>
      </article>`;
  }).join('');
}

// ---------- cart ----------
function cartLines() {
  return Object.entries(cart)
    .map(([id, qty]) => {
      const p = catalog.find((x) => String(x.id) === id);
      return p ? { product: p, qty } : null;
    })
    .filter(Boolean);
}

function renderCart() {
  const lines = cartLines();
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.product.price, 0);
  $('#cart-count').textContent = count;
  $('#cart-total').textContent = naira(total);
  $('#checkout-form').classList.toggle('hidden', lines.length === 0);
  $('#cart-items').innerHTML = lines.length
    ? lines.map(({ product: p, qty }) => `
        <div class="cart-line">
          <div><div class="name">${esc(p.name)}</div><div class="muted">${naira(p.price)} each</div></div>
          <div style="text-align:right">
            <div class="qty">
              <button data-dec="${p.id}" aria-label="decrease">−</button>
              <span>${qty}</span>
              <button data-inc="${p.id}" aria-label="increase" ${qty >= p.stock ? 'disabled' : ''}>+</button>
            </div>
            <div><strong>${naira(qty * p.price)}</strong></div>
            <button class="btn small ghost" data-remove="${p.id}">Remove</button>
          </div>
        </div>`).join('')
    : '<p class="muted">Your cart is empty. Add something from the catalogue.</p>';
}

function setQty(id, qty) {
  const p = catalog.find((x) => String(x.id) === String(id));
  if (qty <= 0) delete cart[id];
  else if (p && qty > p.stock) {
    toast(`Only ${p.stock} of ${p.name} in stock`, true);
    return;
  } else cart[id] = qty;
  saveCart();
  renderProducts();
  renderCart();
}

function openDrawer(open) {
  $('#drawer').classList.toggle('hidden', !open);
  $('#drawer-backdrop').classList.toggle('hidden', !open);
  if (open) {
    $('#order-success').classList.add('hidden');
    renderCart();
  }
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.cat !== undefined && t.closest('#categories')) {
    category = t.dataset.cat;
    return applyFilters();
  }
  if (t.dataset.add) return setQty(t.dataset.add, (cart[t.dataset.add] || 0) + 1);
  if (t.dataset.inc) return setQty(t.dataset.inc, (cart[t.dataset.inc] || 0) + 1);
  if (t.dataset.dec) return setQty(t.dataset.dec, (cart[t.dataset.dec] || 0) - 1);
  if (t.dataset.remove) return setQty(t.dataset.remove, 0);
});

$('#open-cart').addEventListener('click', () => openDrawer(true));
$('#close-cart').addEventListener('click', () => openDrawer(false));
$('#drawer-backdrop').addEventListener('click', () => openDrawer(false));

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = e.target.value.trim();
    applyFilters();
  }, 250);
});

$('#checkout-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = new FormData(form);
  const items = cartLines().map((l) => ({ productId: l.product.id, qty: l.qty }));
  $('#checkout-error').textContent = '';
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Placing order…';
  try {
    const { order } = await getJSON('/api/shop/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.get('name'), phone: f.get('phone'), address: f.get('address'), items }),
    });
    cart = {};
    saveCart();
    form.reset();
    $('#checkout-form').classList.add('hidden');
    $('#order-success').innerHTML = `<strong>Order ${esc(order.order_no)} placed!</strong>\nTotal: ${naira(order.total)}\n\n${esc(order.payment)}\n\nWe've sent the details to your WhatsApp.`;
    $('#order-success').classList.remove('hidden');
    renderProducts();
    renderCart();
    await loadProducts();
  } catch (err) {
    $('#checkout-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Place order';
  }
});

$('#track-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const out = $('#track-result');
  out.textContent = 'Checking…';
  try {
    const o = await getJSON(`/api/shop/orders/${encodeURIComponent(f.get('order_no').trim())}?phone=${encodeURIComponent(f.get('phone').trim())}`);
    out.innerHTML = `
      <p><strong>${esc(o.order_no)}</strong> · <span class="status ${esc(o.status)}">${esc(o.status)}</span> · ${naira(o.total)}</p>
      <ul>${o.items.map((i) => `<li>${i.qty} × ${esc(i.name)}</li>`).join('')}</ul>`;
  } catch (err) {
    out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
});

loadStore().catch((err) => toast(err.message, true));
