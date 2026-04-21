/**
 * Single source of truth for phone-number formatting across the app.
 *
 * Meta/WhatsApp always delivers inbound `from` as a country-code-prefixed
 * digit string (e.g. India → "919876543210"). Everything we store on the
 * User / Conversation / Message side uses that format, so that IS our
 * canonical form everywhere.
 *
 * The old contact-handler normaliser only stripped non-digits, which meant
 * admin-typed or phone-synced numbers that started as "+91 9876543210" or
 * "9876543210" got stored as "9876543210" — and then NEVER matched the
 * "919876543210" stored on User rows. Result: contact names wouldn't
 * appear in chat / orders / rate broadcasts for those rows.
 *
 * Canonical format: digits only, with country code always present.
 *   - 10 digits  → prefix "91"
 *   - 11 digits starting with "0" → drop leading 0, prefix "91"
 *   - 12 digits starting with "91" (India) → kept as-is
 *   - anything else → kept as-is (foreign numbers just need to be
 *     consistent; the sender-side CC is already embedded)
 *
 * DO NOT change this without migrating every Contact / User / RateSubscriber
 * row — lookup asymmetry is exactly what we're fixing here.
 */
const canonicalizePhone = (raw) => {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
};

/**
 * Stripped-digits form — every character that isn't 0-9 removed, no
 * country-code prefixing applied. Used when the caller needs to compare
 * loosely against an already-canonical string (e.g. searching).
 */
const digitsOnly = (raw) => String(raw || "").replace(/\D/g, "");

module.exports = { canonicalizePhone, digitsOnly };
