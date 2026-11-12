'use strict';

/** Formats a whole-naira amount, e.g. 2500 -> "₦2,500". */
function naira(amount) {
  const n = Math.round(Number(amount) || 0);
  return `₦${n.toLocaleString('en-US')}`;
}

/**
 * Normalises a phone number to international digits-only form.
 * Nigerian local numbers (0XXXXXXXXXX) are converted to 234XXXXXXXXXX.
 * Returns '' when the input is not a plausible phone number.
 */
function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = `234${digits.slice(1)}`;
  if (digits.length < 8 || digits.length > 15) return '';
  return digits;
}

module.exports = { naira, normalizePhone };
