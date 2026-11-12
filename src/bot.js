'use strict';

const { naira } = require('./format');
const { StoreError } = require('./store');

const MENU_ALIASES = new Set(['hi', 'hello', 'hey', 'hola', 'start', 'menu', 'home', '0']);
const NUMBER_SHORTCUTS = { 1: 'shop', 2: 'cart', 3: 'orders', 4: 'help' };
const YES = new Set(['yes', 'y', 'confirm', 'ok', 'okay']);
const NO = new Set(['no', 'n']);

function menuText(settings) {
  return [
    `👋 Welcome to *${settings.store_name}*!`,
    '',
    'Reply with a number or a command:',
    '1. *shop* – browse products',
    '2. *cart* – view your cart',
    '3. *orders* – your recent orders',
    '4. *help* – how to order',
  ].join('\n');
}

function helpText() {
  return [
    '*How to order*',
    '• *shop* – see all products with their IDs',
    '• *add <id> [qty]* – e.g. `add 3 2` adds 2 of product 3',
    '• *cart* – view your cart and total',
    '• *remove <id>* – remove a product from your cart',
    '• *clear* – empty your cart',
    '• *checkout* – place your order',
    '• *orders* – see your recent orders',
    '• *track <order no>* – check one order, e.g. `track ORD-1A2B3C`',
    '• *menu* – show the main menu',
  ].join('\n');
}

function cartText(cart) {
  if (cart.items.length === 0) return 'Your cart is empty. Type *shop* to browse products.';
  const lines = cart.items.map((i) => `• ${i.qty} x ${i.name} (ID ${i.productId}) = ${naira(i.lineTotal)}${i.available ? '' : ' ⚠️ no longer available'}`);
  return ['🛒 *Your cart*', ...lines, '', `*Total: ${naira(cart.total)}*`, '', 'Type *checkout* to place your order, or *clear* to empty it.'].join('\n');
}

function orderSummary(order) {
  const items = order.items.map((i) => `• ${i.qty} x ${i.name} = ${naira(i.lineTotal)}`).join('\n');
  return `*Order ${order.order_no}* – ${order.status.toUpperCase()}\n${items}\nTotal: ${naira(order.total)}`;
}

/**
 * The WhatsApp conversation engine. It is independent of the transport:
 * handleMessage(phone, text) returns the list of replies to send.
 */
function createBot({ store, onOrderCreated = () => {} }) {
  function paymentInstructions(settings) {
    if (!settings.account_number) return 'Our team will message you with payment details shortly.';
    return [
      '*Payment details*',
      `Bank: ${settings.bank_name}`,
      `Account name: ${settings.account_name}`,
      `Account number: ${settings.account_number}`,
      'Please use your order number as the payment reference, then reply *paid* with proof of payment if our team has not confirmed yet.',
    ].join('\n');
  }

  async function handleMessage(phone, rawText = '', profileName = '') {
    const text = String(rawText || '').trim();
    const settings = store.getSettings();
    if (profileName) store.upsertCustomer(phone, profileName, '');

    if (!text) return [`I can only read text messages for now.\n\n${menuText(settings)}`];

    const session = store.getSession(phone);
    if (session.state.startsWith('checkout_')) {
      const lower = text.toLowerCase();
      if (lower === 'cancel' || lower === 'menu') {
        store.setSession(phone, 'idle', {});
        return [lower === 'cancel' ? 'Checkout cancelled. Your cart is unchanged.' : menuText(settings)];
      }
      return checkoutStep(phone, text, session, settings);
    }

    const [cmdRaw, ...args] = text.toLowerCase().split(/\s+/);
    const cmd = NUMBER_SHORTCUTS[cmdRaw] || cmdRaw;

    try {
      if (MENU_ALIASES.has(cmd)) return [menuText(settings)];
      if (['shop', 'products', 'catalog', 'browse'].includes(cmd)) return [shopText()];
      if (['cart', 'basket', 'bag'].includes(cmd)) return [cartText(store.getCart(phone))];
      if (cmd === 'add') return [addCommand(phone, args)];
      if (cmd === 'remove' || cmd === 'delete') return [removeCommand(phone, args)];
      if (cmd === 'clear' || cmd === 'empty') {
        store.clearCart(phone);
        return ['Your cart has been cleared.'];
      }
      if (['checkout', 'buy', 'order'].includes(cmd)) return [startCheckout(phone)];
      if (['orders', 'my', 'history'].includes(cmd)) return [ordersText(phone)];
      if (cmd === 'track') return [trackCommand(phone, args)];
      if (cmd === 'help') return [helpText()];
      if (cmd === 'paid') return ['Thank you! Please send a screenshot of your payment here. Our team will confirm it shortly.'];
    } catch (err) {
      if (err instanceof StoreError) return [`⚠️ ${err.message}`];
      throw err;
    }

    return [`Sorry, I didn't understand "${text}".\n\n${menuText(settings)}`];
  }

  function shopText() {
    const products = store.listProducts({ activeOnly: true });
    if (products.length === 0) return 'No products are available right now. Please check back soon.';
    let currentCategory = null;
    const lines = [];
    for (const p of products) {
      if (p.category !== currentCategory) {
        currentCategory = p.category;
        lines.push(`\n*${currentCategory}*`);
      }
      const stock = p.stock > 0 ? '' : ' (out of stock)';
      lines.push(`[${p.id}] ${p.name} – ${naira(p.price)}${stock}`);
    }
    return ['🛍️ *Products*', ...lines, '', 'To buy, send *add <id>* e.g. `add 1` or `add 1 3` for 3 items.'].join('\n');
  }

  function addCommand(phone, args) {
    const id = Number(args[0]);
    if (!Number.isInteger(id) || id < 1) return 'Please give a product ID, e.g. `add 3` or `add 3 2`.';
    const qty = args[1] === undefined ? 1 : Number(args[1]);
    if (!Number.isInteger(qty) || qty < 1) return 'Quantity must be a whole number, e.g. `add 3 2`.';
    const { product, qty: total } = store.addToCart(phone, id, qty);
    return `✅ Added ${qty} x ${product.name} to your cart (${total} in cart).\nType *cart* to review or *checkout* to order.`;
  }

  function removeCommand(phone, args) {
    const id = Number(args[0]);
    if (!Number.isInteger(id)) return 'Please give a product ID, e.g. `remove 3`.';
    return store.removeFromCart(phone, id) ? `Removed product ${id} from your cart.` : `Product ${id} is not in your cart.`;
  }

  function ordersText(phone) {
    const orders = store.listOrders({ phone, limit: 5 });
    if (orders.length === 0) return "You haven't placed any orders yet. Type *shop* to start.";
    const lines = orders.map((o) => `• *${o.order_no}* – ${o.status} – ${naira(o.total)}`);
    return ['📦 *Your recent orders*', ...lines, '', 'Send *track <order no>* for details.'].join('\n');
  }

  function trackCommand(phone, args) {
    const orderNo = (args[0] || '').toUpperCase();
    if (!orderNo) return 'Please include the order number, e.g. `track ORD-1A2B3C`.';
    const order = store.getOrderByNumber(orderNo);
    if (!order || order.phone !== phone) return `I couldn't find order ${orderNo} on this number.`;
    return orderSummary(order);
  }

  function startCheckout(phone) {
    const cart = store.getCart(phone);
    if (cart.items.length === 0) return 'Your cart is empty. Type *shop* to browse products.';
    const unavailable = cart.items.filter((i) => !i.available || i.qty > i.stock);
    if (unavailable.length) {
      return `Some items are unavailable or low in stock: ${unavailable.map((i) => i.name).join(', ')}. Please *remove* them or lower the quantity, then checkout again.`;
    }
    store.setSession(phone, 'checkout_name', {});
    return `Let's place your order (${naira(cart.total)}).\n\nWhat is your *full name* for delivery? (or *cancel*)`;
  }

  async function checkoutStep(phone, text, session, settings) {
    const data = session.data || {};

    if (session.state === 'checkout_name') {
      if (text.length < 2) return ['Please send your full name.'];
      store.setSession(phone, 'checkout_address', { name: text });
      return ['Thanks! What is your *delivery address*? (street, area, city)'];
    }

    if (session.state === 'checkout_address') {
      if (text.length < 5) return ['Please send a complete delivery address.'];
      const next = { ...data, address: text };
      store.setSession(phone, 'checkout_confirm', next);
      const cart = store.getCart(phone);
      const lines = cart.items.map((i) => `• ${i.qty} x ${i.name} = ${naira(i.lineTotal)}`).join('\n');
      return [[
        '*Please confirm your order*',
        lines,
        `Total: *${naira(cart.total)}*`,
        `Name: ${next.name}`,
        `Deliver to: ${next.address}`,
        '',
        'Reply *YES* to place the order or *NO* to cancel.',
      ].join('\n')];
    }

    if (session.state === 'checkout_confirm') {
      const lower = text.toLowerCase();
      if (NO.has(lower)) {
        store.setSession(phone, 'idle', {});
        return ['Order cancelled. Your cart is still saved.'];
      }
      if (!YES.has(lower)) return ['Please reply *YES* to place the order or *NO* to cancel.'];

      const cart = store.getCart(phone);
      try {
        const order = store.createOrder({
          phone,
          customerName: data.name,
          address: data.address,
          items: cart.items.map((i) => ({ productId: i.productId, qty: i.qty })),
          source: 'whatsapp',
          clearCartAfter: true,
        });
        store.setSession(phone, 'idle', {});
        onOrderCreated(order);
        return [[
          `✅ Thank you! Your order *${order.order_no}* has been placed.`,
          `Total: *${naira(order.total)}*`,
          '',
          paymentInstructions(settings),
          '',
          `Type *track ${order.order_no}* anytime to check progress.`,
        ].join('\n')];
      } catch (err) {
        if (err instanceof StoreError) {
          store.setSession(phone, 'idle', {});
          return [`⚠️ We could not place your order: ${err.message}. Your cart has been kept, please review it with *cart*.`];
        }
        throw err;
      }
    }

    store.setSession(phone, 'idle', {});
    return [menuText(settings)];
  }

  return { handleMessage, menuText };
}

module.exports = { createBot, orderSummary, menuText };
