/**
 * Broadcast Catalog — the fixed set of products that can be assigned to
 * a RateSubscriber for the "rate_statement_3p" / "rate_statement_5p"
 * Utility templates.
 *
 * Admin picks EXACTLY 3 or EXACTLY 5 of these for each subscriber.
 * The order picked is the order rendered in the WhatsApp message.
 *
 * Each entry describes:
 *   key          — stable identifier stored on RateSubscriber.subscribedProducts.
 *                  NEVER change an existing key; adding a new one is fine.
 *   displayName  — rendered verbatim as the product label in the template
 *                  (left-hand side of "<name>: <base> + <loading> + 18%").
 *   category     — routes to pricingService.calculatePrice(...) to fetch
 *                  the current mergedBase rate (base before loading + GST).
 *   options      — extra args forwarded to pricingService for this product.
 *   loadingCharge— per-product loading in Rs/MT, displayed inline in the
 *                  product line. Must match what pricingService uses for
 *                  the same category (see pricingService BINDING_LOADING
 *                  and BaseRate.fixedCharge), otherwise the message can
 *                  disagree with an order quote later.
 *
 * If you add / remove entries here, clients still keep whatever they were
 * subscribed to — but you MUST run a migration if you remove a key that
 * any active subscriber references, otherwise sends will fail for them.
 */

const BROADCAST_CATALOG = [
  {
    key: "wr_55",
    displayName: "Wire Rod 5.5mm",
    category: "wr",
    options: { size: "5.5", carbonType: "normal" },
    loadingCharge: 345,
  },
  {
    key: "wr_7",
    displayName: "Wire Rod 7mm",
    category: "wr",
    options: { size: "7", carbonType: "normal" },
    loadingCharge: 345,
  },
  {
    key: "hb_10",
    displayName: "H.B Wire 10g",
    category: "hb",
    options: { gauge: "10", carbonType: "normal" },
    loadingCharge: 345,
  },
  {
    key: "hb_12",
    displayName: "H.B Wire 12g",
    category: "hb",
    options: { gauge: "12", carbonType: "normal" },
    loadingCharge: 345,
  },
  {
    key: "binding_20_wow",
    displayName: "Binding Wire 20g (without wrapper)",
    category: "binding",
    options: { gauge: "20", packaging: "without", random: false },
    loadingCharge: 515,
  },
  {
    key: "binding_20_ww",
    displayName: "Binding Wire 20g (with wrapper)",
    category: "binding",
    options: { gauge: "20", packaging: "with", random: false },
    loadingCharge: 515,
  },
];

const CATALOG_BY_KEY = Object.fromEntries(BROADCAST_CATALOG.map((p) => [p.key, p]));

/** Returns the full catalog, safe to send to the frontend. */
const listCatalog = () => BROADCAST_CATALOG.map((p) => ({
  key: p.key,
  displayName: p.displayName,
  loadingCharge: p.loadingCharge,
  category: p.category,
}));

/** Returns the catalog entry for a key or null if unknown. */
const getProduct = (key) => CATALOG_BY_KEY[key] || null;

/**
 * Validate an admin-provided array of product keys for a subscriber.
 * Enforces:
 *   - length is exactly 3 or exactly 5 (matches the two approved templates)
 *   - every key exists in the catalog
 *   - no duplicates
 * Returns the normalised array (trimmed, dedup order preserved) or throws
 * a string error message the socket handler can surface verbatim.
 */
const validateProductKeys = (keys) => {
  if (!Array.isArray(keys)) throw new Error("subscribedProducts must be an array");
  const cleaned = keys.map((k) => String(k || "").trim()).filter(Boolean);
  if (cleaned.length !== 3 && cleaned.length !== 5) {
    throw new Error("subscribedProducts must be exactly 3 or exactly 5 items");
  }
  const seen = new Set();
  for (const k of cleaned) {
    if (seen.has(k)) throw new Error(`Duplicate product '${k}' in subscribedProducts`);
    if (!CATALOG_BY_KEY[k]) throw new Error(`Unknown product '${k}'`);
    seen.add(k);
  }
  return cleaned;
};

module.exports = {
  BROADCAST_CATALOG,
  CATALOG_BY_KEY,
  listCatalog,
  getProduct,
  validateProductKeys,
};
