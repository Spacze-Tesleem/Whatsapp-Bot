# WhatsApp Ecommerce Bot

A complete ecommerce system that runs **on WhatsApp**, with a customer storefront and an admin panel:

| Part | What it does |
|------|--------------|
| **WhatsApp bot** | Customers browse products, build a cart, check out, pay and track orders by chatting with your number. |
| **Storefront** (`/`) | Web shop with search, categories, cart, checkout and order tracking. Orders placed here also appear on WhatsApp. |
| **Admin panel** (`/admin`) | Dashboard, product management, order processing (status updates notify the customer on WhatsApp), customers, WhatsApp inbox, chat simulator and settings. |

Currency is Naira (₦). Data is stored in a single SQLite file, so there is nothing else to install.

## Quick start (no WhatsApp account needed)

Requires **Node.js 22.13+**.

```bash
npm install
ADMIN_PASSWORD=choose-a-strong-password npm start
```

- Storefront: http://localhost:3000/
- Admin panel: http://localhost:3000/admin (sign in with `ADMIN_PASSWORD`)
- Chat simulator: admin panel → **Chat simulator**. Type `menu` to try the bot without WhatsApp.

Without `WHATSAPP_TOKEN` the server runs in **dry-run mode**: bot replies are printed to the console and shown in the admin inbox, but not sent.

Six sample products are added on first run. Set `SEED_DEMO=false` to start empty.

## Connecting real WhatsApp (Meta Cloud API)

1. Create a Meta developer app at https://developers.facebook.com/ and add the **WhatsApp** product.
2. In **WhatsApp → API Setup**, copy the **Phone number ID** and create a **permanent access token** (System User in Business Settings). Set:
   - `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
3. Choose a random string for `WHATSAPP_VERIFY_TOKEN`, and set `WHATSAPP_APP_SECRET` to the app secret (App settings → Basic). The app secret enables signature checks on incoming webhooks.
4. Deploy the app somewhere with a public HTTPS URL (any Node host, VPS, Render, Railway, etc.). Your webhook URL is `https://YOUR-DOMAIN/webhook/whatsapp`.
5. In **WhatsApp → Configuration → Webhook**, set the callback URL to that address and the verify token to your `WHATSAPP_VERIFY_TOKEN`. Subscribe to the **messages** field.
6. In the admin panel → **Settings**, enter your bank details and your own WhatsApp number (for order alerts).

Note: Meta only allows free-form replies within 24 hours of a customer's last message. The bot always replies to customer messages, so this works. Order status updates sent outside that window need a Meta-approved template; the current code sends them as plain text.

## Customer bot commands

| Message | Action |
|---------|--------|
| `menu` or `hi` | Main menu |
| `shop` | List products with their IDs |
| `add 3` / `add 3 2` | Add product 3 (optionally 2 units) to the cart |
| `cart` | View the cart and total |
| `remove 3` / `clear` | Remove a product / empty the cart |
| `checkout` | Enter name and address, then reply `YES` to order |
| `orders` | Your 5 most recent orders |
| `track ORD-1A2B3C` | Status of one order |
| `help` | Command list |

## Configuration

All settings are environment variables (see `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSWORD` | `change-me` | Admin panel password (**change it**) |
| `DB_FILE` | `./data/shop.db` | SQLite database location |
| `WHATSAPP_TOKEN` | empty | Cloud API token. Empty = dry-run |
| `WHATSAPP_PHONE_NUMBER_ID` | empty | Cloud API phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | `change-me-verify` | Webhook verification string |
| `WHATSAPP_APP_SECRET` | empty | Enables webhook signature validation |
| `WHATSAPP_GRAPH_VERSION` | `v21.0` | Graph API version |
| `SEED_DEMO` | `true` | Add sample products on first run |

## API overview

Public storefront:
- `GET /api/shop/config`, `GET /api/shop/products?category=&q=`
- `POST /api/shop/orders` with `{ name, phone, address, items: [{ productId, qty }] }`
- `GET /api/shop/orders/:orderNo?phone=...` (order tracking; the phone must match the order)

Admin (cookie session from `POST /api/admin/login`): `/api/admin/stats`, `/products`, `/orders`, `/orders/:id` (PATCH status), `/customers`, `/conversations`, `/messages`, `/settings`, `/simulate`.

Meta webhook: `GET|POST /webhook/whatsapp`.

## How it works

```
src/
  index.js     entry point
  app.js       HTTP routes: webhook, storefront API, admin API, static panels
  bot.js       WhatsApp conversation engine (transport-independent)
  store.js     business logic: products, cart, orders, stock, customers, settings
  whatsapp.js  Cloud API client, webhook parsing, signature check
  db.js        SQLite schema (built-in node:sqlite, no native build)
  config.js    environment configuration
public/
  shop/        storefront UI
  admin/       admin panel UI
test/          unit and API tests
```

Stock is reserved when an order is placed and returned if the order is cancelled. Orders are never deleted, so history is kept. Products that appear in past orders are hidden rather than deleted.

## Tests

```bash
npm test
```

## Production notes

- Run behind HTTPS (required by Meta). Store `data/` on persistent disk.
- Use a strong `ADMIN_PASSWORD`. Sign-in is rate limited to 10 failures per 15 minutes per IP.
- Payments are manual: customers pay by bank transfer and the admin marks orders as paid. Automatic payment gateways (Paystack, Flutterwave) are not included yet.
