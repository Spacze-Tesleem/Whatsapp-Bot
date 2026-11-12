'use strict';

const path = require('node:path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Reads runtime configuration from environment variables. */
function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    adminPassword: env.ADMIN_PASSWORD || 'change-me',
    dbFile: path.resolve(env.DB_FILE || path.join(__dirname, '..', 'data', 'shop.db')),
    whatsapp: {
      token: env.WHATSAPP_TOKEN || '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || 'change-me-verify',
      appSecret: env.WHATSAPP_APP_SECRET || '',
      graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
    },
    seedDemo: bool(env.SEED_DEMO, true),
    // Set TRUST_PROXY=true when running behind a load balancer (e.g. Render) so rate limits use the real client IP.
    trustProxy: bool(env.TRUST_PROXY, false),
  };
}

/** Lists configuration problems that should be fixed before going live. */
function configWarnings(config) {
  const warnings = [];
  if (config.adminPassword === 'change-me') warnings.push('ADMIN_PASSWORD is the default; set a strong password.');
  if (config.whatsapp.verifyToken === 'change-me-verify') warnings.push('WHATSAPP_VERIFY_TOKEN is the default.');
  if (!config.whatsapp.token) warnings.push('WHATSAPP_TOKEN not set: running in dry-run mode (WhatsApp replies are logged, not sent).');
  if (config.whatsapp.token && !config.whatsapp.appSecret) warnings.push('WHATSAPP_APP_SECRET not set: incoming webhook requests are not signature-checked.');
  return warnings;
}

module.exports = { loadConfig, configWarnings };
