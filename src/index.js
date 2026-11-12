'use strict';

const { loadConfig, configWarnings } = require('./config');
const { openDatabase } = require('./db');
const { createStore } = require('./store');
const { createWhatsAppClient } = require('./whatsapp');
const { createApp } = require('./app');

function main() {
  const config = loadConfig();
  for (const warning of configWarnings(config)) console.warn(`[config] ${warning}`);

  const db = openDatabase(config.dbFile);
  const store = createStore(db);
  if (config.seedDemo && store.seedDemoData()) console.log('[db] Seeded demo products.');

  const whatsapp = createWhatsAppClient(config.whatsapp);
  const { app } = createApp({ store, whatsapp, config });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Storefront:      http://localhost:${config.port}/`);
    console.log(`Admin panel:     http://localhost:${config.port}/admin`);
    console.log(`WhatsApp hook:   http://localhost:${config.port}/webhook/whatsapp`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
