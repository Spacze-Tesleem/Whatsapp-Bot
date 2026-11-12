'use strict';

const crypto = require('node:crypto');

const MAX_TEXT = 4096;

/**
 * Sends a text message through the WhatsApp Cloud API.
 * Without a token it runs in dry-run mode and only logs the message.
 */
function createWhatsAppClient(config, logger = console) {
  const dryRun = !config.token || !config.phoneNumberId;

  async function sendText(to, body) {
    const text = String(body).slice(0, MAX_TEXT);
    if (dryRun) {
      logger.log(`[whatsapp:dry-run] to ${to}:\n${text}\n`);
      return { dryRun: true };
    }
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WhatsApp send failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    return res.json();
  }

  return { sendText, dryRun };
}

/** Extracts text messages from a Cloud API webhook payload. */
function parseWebhook(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = new Map((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const msg of value.messages || []) {
        out.push({
          id: msg.id,
          from: String(msg.from),
          name: contacts.get(msg.from) || '',
          type: msg.type,
          text: msg.type === 'text' ? msg.text?.body || '' : (msg.type === 'interactive' ? msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '' : ''),
        });
      }
    }
  }
  return out;
}

/** Verifies the X-Hub-Signature-256 header Meta sends with each webhook call. */
function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return true;
  if (!rawBody || !header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

module.exports = { createWhatsAppClient, parseWebhook, verifySignature };
