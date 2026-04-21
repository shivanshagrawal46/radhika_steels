const { RateSubscriber } = require("../models");

/**
 * Sequential customer-ID generator: "RS-CUST-0001", "RS-CUST-0002", ...
 *
 * This ID is permanent once assigned to a subscriber and is rendered in
 * the Utility template as "Customer ID: {{3}}". Never re-use an ID — if
 * a subscriber is hard-deleted we keep the numerical hole rather than
 * recycling, so historical statements remain unambiguous.
 *
 * The counter is derived from the HIGHEST numeric suffix currently
 * present on any RateSubscriber row, plus one. No separate "counter"
 * collection is needed.
 *
 * Concurrency note: two concurrent calls could pick the same next ID.
 * We defend against that with a retry-on-duplicate-key loop when the
 * consumer persists the value. The consumer (rateUpdateService) uses
 * findOneAndUpdate with the unique partial index on customerId, so a
 * collision surfaces as E11000 and we retry with a fresh peek.
 */

const CUSTOMER_ID_PREFIX = "RS-CUST-";
const PAD_WIDTH = 4;

const parseSuffix = (id) => {
  if (!id || typeof id !== "string") return 0;
  const m = id.match(/^RS-CUST-(\d+)$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : 0;
};

const formatId = (n) => `${CUSTOMER_ID_PREFIX}${String(n).padStart(PAD_WIDTH, "0")}`;

/**
 * Peek the NEXT customer ID without reserving it. Intended for use with
 * findOneAndUpdate + retry-on-E11000.
 */
const peekNextCustomerId = async () => {
  const rows = await RateSubscriber
    .find({ customerId: { $regex: /^RS-CUST-\d+$/ } })
    .select("customerId")
    .lean();

  let max = 0;
  for (const r of rows) {
    const n = parseSuffix(r.customerId);
    if (n > max) max = n;
  }
  return formatId(max + 1);
};

/**
 * Idempotently ensure a subscriber has a customerId. Safe to call many
 * times on the same doc — the first call assigns, subsequent calls are
 * no-ops. Uses optimistic concurrency (retry on duplicate index).
 *
 * Returns the final subscriber document.
 */
const ensureCustomerId = async (subscriberId) => {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await RateSubscriber.findById(subscriberId).lean();
    if (!current) throw new Error(`RateSubscriber ${subscriberId} not found`);
    if (current.customerId && /^RS-CUST-\d+$/.test(current.customerId)) {
      return current;
    }
    const candidate = await peekNextCustomerId();
    try {
      const updated = await RateSubscriber.findOneAndUpdate(
        { _id: subscriberId, $or: [{ customerId: "" }, { customerId: null }, { customerId: { $exists: false } }] },
        { $set: { customerId: candidate } },
        { new: true }
      );
      if (updated) return updated.toObject();
      // Row was updated by someone else between our read and write; loop.
    } catch (err) {
      if (err && err.code === 11000) {
        // Another subscriber claimed the same ID between peek and set.
        // Loop and try the next number.
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to assign customerId after retries");
};

module.exports = {
  CUSTOMER_ID_PREFIX,
  formatCustomerId: formatId,
  parseCustomerSuffix: parseSuffix,
  peekNextCustomerId,
  ensureCustomerId,
};
