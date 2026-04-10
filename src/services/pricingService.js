const { BaseRate } = require("../models");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");

// ──────────────────────────────────────────────
// Pricing Rules (WR & HB)
//
//   WR formula:
//     subtotal = wrBaseRate + sizePremium + carbonExtra + fixedCharge
//     gst      = subtotal × (gstPercent / 100)
//     total    = subtotal + gst
//
//   HB formula:
//     hbBase   = wrBaseRate + hbPremium   (e.g. +2500)
//     subtotal = hbBase + fixedCharge
//     gst      = subtotal × (gstPercent / 100)
//     total    = subtotal + gst
// ──────────────────────────────────────────────

let _cachedRate = null;
let _cacheTs = 0;
const RATE_CACHE_TTL = 30_000;

/**
 * Fetch the currently active base-rate document.
 * Cached in-memory for 30 s so chat messages don't hit DB every time.
 */
const getActiveBaseRate = async () => {
  const now = Date.now();
  if (_cachedRate && now - _cacheTs < RATE_CACHE_TTL) return _cachedRate;

  const rate = await BaseRate.findOne({ isActive: true })
    .sort({ createdAt: -1 })
    .lean();

  if (!rate) throw new AppError("No active base rate configured. Ask admin to set one.", 404);

  _cachedRate = rate;
  _cacheTs = now;
  return rate;
};

/**
 * Calculate the price for a WR product.
 *
 * @param {object} rate  - active BaseRate document (lean)
 * @param {string} size  - e.g. "5.5", "7", "12"
 * @param {string} carbonType - "normal" | "lc"
 * @returns {{ breakdown, subtotal, gst, total, displayLine1, displayLine2 }}
 */
const lookup = (obj, key) => {
  if (!obj) return undefined;
  if (obj instanceof Map) return obj.get(key);
  return obj[key];
};

const calcWR = (rate, size, carbonType = "normal") => {
  const sizePremium = lookup(rate.sizePremiums, size) ?? null;
  if (sizePremium === null) {
    throw new AppError(`No size premium configured for WR ${size}mm`, 400);
  }

  const carbonExtra = lookup(rate.carbonExtras, carbonType) ?? 0;
  const { wrBaseRate, fixedCharge, gstPercent } = rate;

  const subtotal = wrBaseRate + sizePremium + carbonExtra + fixedCharge;
  const gst = Math.round((subtotal * gstPercent) / 100 * 100) / 100;
  const total = Math.round((subtotal + gst) * 100) / 100;

  // Build display strings — all rates are per ton (1000 kg)
  const parts = [`₹${wrBaseRate.toLocaleString("en-IN")}`];
  if (sizePremium > 0) parts.push(`+ ₹${sizePremium.toLocaleString("en-IN")}`);
  if (carbonExtra > 0) parts.push(`+ ₹${carbonExtra.toLocaleString("en-IN")} (LC)`);
  parts.push(`+ ₹${fixedCharge} + ${gstPercent}% GST`);

  const displayLine1 = parts.join(" ");
  const displayLine2 = `Total: ₹${total.toLocaleString("en-IN")}/ton`;

  return {
    category: "wr",
    size,
    carbonType,
    unit: "ton",
    breakdown: {
      baseRate: wrBaseRate,
      sizePremium,
      carbonExtra,
      fixedCharge,
      gstPercent,
    },
    subtotal,
    gst,
    total,
    displayLine1,
    displayLine2,
  };
};

/**
 * Calculate the price for an HB product.
 *
 * @param {object} rate  - active BaseRate document (lean)
 * @param {string} gauge - e.g. "12" (12 gauge is the base)
 * @returns {{ breakdown, subtotal, gst, total, displayLine1, displayLine2 }}
 */
const calcHB = (rate, gauge = "12") => {
  const { wrBaseRate, hbPremium, fixedCharge, gstPercent } = rate;

  const hbBase = wrBaseRate + hbPremium;
  const subtotal = hbBase + fixedCharge;
  const gst = Math.round((subtotal * gstPercent) / 100 * 100) / 100;
  const total = Math.round((subtotal + gst) * 100) / 100;

  const displayLine1 = `₹${wrBaseRate.toLocaleString("en-IN")} + ₹${hbPremium.toLocaleString("en-IN")} (HB) + ₹${fixedCharge} + ${gstPercent}% GST`;
  const displayLine2 = `Total: ₹${total.toLocaleString("en-IN")}/ton`;

  return {
    category: "hb",
    gauge,
    unit: "ton",
    breakdown: {
      wrBaseRate,
      hbPremium,
      hbBase,
      fixedCharge,
      gstPercent,
    },
    subtotal,
    gst,
    total,
    displayLine1,
    displayLine2,
  };
};

/**
 * Calculate price for any supported category.
 */
const calculatePrice = async (category, options = {}) => {
  const rate = await getActiveBaseRate();

  switch (category) {
    case "wr":
      return calcWR(rate, options.size || "5.5", options.carbonType || "normal");

    case "hb":
      return calcHB(rate, options.gauge || "12");

    default:
      throw new AppError(`Pricing not yet configured for category: ${category}`, 400);
  }
};

/**
 * Get a full price table (all WR sizes + HB) — used for AI context & dashboard.
 */
const getFullPriceTable = async () => {
  const rate = await getActiveBaseRate();

  const sp = rate.sizePremiums || {};
  const ce = rate.carbonExtras || {};
  const wrSizes = Object.keys(sp instanceof Map ? Object.fromEntries(sp) : sp);
  const carbonTypes = Object.keys(ce instanceof Map ? Object.fromEntries(ce) : ce);

  const wrPrices = [];
  for (const size of wrSizes) {
    for (const ct of carbonTypes) {
      wrPrices.push(calcWR(rate, size, ct));
    }
  }

  const hbPrices = [calcHB(rate, "12")];

  return {
    wrBaseRate: rate.wrBaseRate,
    updatedAt: rate.updatedAt,
    wr: wrPrices,
    hb: hbPrices,
  };
};

/**
 * Build a human-readable price context string for OpenAI.
 */
const buildPriceContext = async () => {
  try {
    const table = await getFullPriceTable();

    const lines = [
      `Current Steel Prices — ALL RATES ARE PER TON (1 ton = 1000 kg)`,
      `Base Rate: ₹${table.wrBaseRate.toLocaleString("en-IN")}/ton | Updated: ${new Date(table.updatedAt).toLocaleDateString("en-IN")}`,
      "",
    ];

    lines.push("=== Wire Rod (WR) — Rate per ton ===");
    for (const p of table.wr) {
      const label = p.carbonType === "lc" ? `${p.size}mm LC` : `${p.size}mm`;
      lines.push(`  ${label}: ${p.displayLine1}`);
      lines.push(`         ${p.displayLine2}`);
    }

    lines.push("");
    lines.push("=== HB Wire — Rate per ton ===");
    for (const p of table.hb) {
      lines.push(`  ${p.gauge}g: ${p.displayLine1}`);
      lines.push(`      ${p.displayLine2}`);
    }

    return lines.join("\n");
  } catch {
    return "No product prices are currently available. Ask admin to set the base rate.";
  }
};

/**
 * Admin updates the WR base rate → all prices recalculate dynamically.
 */
const updateBaseRate = async (wrBaseRate, employeeId, overrides = {}) => {
  _cachedRate = null;
  _cacheTs = 0;

  await BaseRate.updateMany({ isActive: true }, { isActive: false });

  const rateData = {
    wrBaseRate,
    isActive: true,
    updatedBy: employeeId,
  };

  if (overrides.hbPremium !== undefined) rateData.hbPremium = overrides.hbPremium;
  if (overrides.fixedCharge !== undefined) rateData.fixedCharge = overrides.fixedCharge;
  if (overrides.gstPercent !== undefined) rateData.gstPercent = overrides.gstPercent;
  if (overrides.sizePremiums) rateData.sizePremiums = overrides.sizePremiums;
  if (overrides.carbonExtras) rateData.carbonExtras = overrides.carbonExtras;

  const newRate = await BaseRate.create(rateData);

  logger.info(`Base rate updated to ₹${wrBaseRate} by employee ${employeeId}`);

  return newRate;
};

module.exports = {
  getActiveBaseRate,
  calculatePrice,
  getFullPriceTable,
  buildPriceContext,
  updateBaseRate,
};
