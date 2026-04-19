const { BaseRate } = require("../models");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");

// ──────────────────────────────────────────────
// HB Wire Gauge ↔ MM conversion table (SWG standard — never changes)
// ──────────────────────────────────────────────
const GAUGE_MM_TABLE = [
  { gauge: "6/0", minMm: 11.00, maxMm: 11.80 },
  { gauge: "5/0", minMm: 10.40, maxMm: 11.00 },
  { gauge: "4/0", minMm: 9.80, maxMm: 10.40 },
  { gauge: "3/0", minMm: 9.20, maxMm: 9.80 },
  { gauge: "2/0", minMm: 8.60, maxMm: 9.20 },
  { gauge: "1/0", minMm: 7.80, maxMm: 8.60 },
  { gauge: "1", minMm: 7.20, maxMm: 7.80 },
  { gauge: "2", minMm: 6.80, maxMm: 7.20 },
  { gauge: "3", minMm: 6.20, maxMm: 6.80 },
  { gauge: "4", minMm: 5.60, maxMm: 6.20 },
  { gauge: "5", minMm: 5.20, maxMm: 5.60 },
  { gauge: "6", minMm: 4.80, maxMm: 5.20 },
  { gauge: "7", minMm: 4.40, maxMm: 4.80 },
  { gauge: "8", minMm: 3.80, maxMm: 4.40 },
  { gauge: "9", minMm: 3.40, maxMm: 3.80 },
  { gauge: "10", minMm: 3.00, maxMm: 3.40 },
  { gauge: "11", minMm: 2.80, maxMm: 3.00 },
  { gauge: "12", minMm: 2.40, maxMm: 2.80 },
  { gauge: "13", minMm: 2.20, maxMm: 2.40 },
  { gauge: "14", minMm: 1.90, maxMm: 2.20 },
  { gauge: "15", minMm: 1.75, maxMm: 1.90 },
  { gauge: "16", minMm: 1.60, maxMm: 1.75 },
];

const ALL_HB_GAUGES = [
  "6/0", "5/0", "4/0", "3/0", "2/0", "1/0",
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
  "13", "14", "15", "16",
];

const DEFAULT_HB_GAUGE_PREMIUMS = {
  "6": 0, "7": 0, "8": 0, "9": 0, "10": 0, "11": 0, "12": 0,
  "13": 1000, "14": 1700, "15": 1700, "16": 1700,
  "5": 800, "4": 800, "3": 800, "2": 800, "1": 800,
  "1/0": 800, "2/0": 800,
  "3/0": 1200, "4/0": 1200, "5/0": 1200, "6/0": 1200,
};

function mmToGauge(mm) {
  const val = parseFloat(mm);
  if (isNaN(val)) return null;
  for (const row of GAUGE_MM_TABLE) {
    if (val >= row.minMm && val <= row.maxMm) return row;
  }
  let closest = null;
  let minDist = Infinity;
  for (const row of GAUGE_MM_TABLE) {
    const mid = (row.minMm + row.maxMm) / 2;
    const dist = Math.abs(val - mid);
    if (dist < minDist) { minDist = dist; closest = row; }
  }
  return closest;
}

function gaugeToMmRange(gauge) {
  return GAUGE_MM_TABLE.find((r) => r.gauge === gauge) || null;
}

// ──────────────────────────────────────────────
// Rate cache
// ──────────────────────────────────────────────
let _cachedRate = null;
let _cacheTs = 0;
const RATE_CACHE_TTL = 30_000;

const DEFAULT_SIZE_PREMIUMS = {
  "5.5": 0, "7": 800, "8": 800, "10": 800,
  "12": 1200, "14": 1500, "16": 1700, "18": 2200,
};
const DEFAULT_CARBON_EXTRAS = { normal: 0, lc: 800 };

const getActiveBaseRate = async () => {
  const now = Date.now();
  if (_cachedRate && now - _cacheTs < RATE_CACHE_TTL) return _cachedRate;
  const rate = await BaseRate.findOne({ isActive: true }).sort({ createdAt: -1 }).lean();
  if (!rate) throw new AppError("No active base rate configured. Ask admin to set one.", 404);

  // Normalize — merge DB data over hardcoded defaults so every field is guaranteed present
  rate.sizePremiums = { ...DEFAULT_SIZE_PREMIUMS, ...(rate.sizePremiums || {}) };
  rate.carbonExtras = { ...DEFAULT_CARBON_EXTRAS, ...(rate.carbonExtras || {}) };
  rate.hbGaugePremiums = { ...DEFAULT_HB_GAUGE_PREMIUMS, ...(rate.hbGaugePremiums || {}) };
  rate.hbPremium = rate.hbPremium ?? 2500;
  rate.fixedCharge = rate.fixedCharge ?? 345;
  rate.gstPercent = rate.gstPercent ?? 18;

  _cachedRate = rate;
  _cacheTs = now;
  return rate;
};

const lookup = (obj, key) => {
  if (!obj) return undefined;
  if (obj instanceof Map) return obj.get(String(key));
  return obj[String(key)];
};

// ──────────────────────────────────────────────
// WR Price Calculation
// ──────────────────────────────────────────────
const calcWR = (rate, size, carbonType = "normal") => {
  const sizePremium = lookup(rate.sizePremiums, size);
  if (sizePremium === undefined || sizePremium === null) {
    throw new AppError(`WR ${size}mm is not available`, 400);
  }
  const carbonExtra = lookup(rate.carbonExtras, carbonType) ?? 0;
  const { wrBaseRate, fixedCharge, gstPercent } = rate;

  const mergedBase = wrBaseRate + sizePremium + carbonExtra;
  const subtotal = mergedBase + fixedCharge;
  const gst = Math.round((subtotal * gstPercent) / 100);
  const total = subtotal + gst;

  return {
    category: "wr",
    size,
    carbonType,
    unit: "ton",
    mergedBase,
    fixedCharge,
    gstPercent,
    subtotal,
    gst,
    total,
    label: `WR ${size}mm${carbonType === "lc" ? " LC" : ""}`,
  };
};

// ──────────────────────────────────────────────
// HB Price Calculation
//
// carbonType = "normal" | "lc". HB shares the same carbonExtras table as WR
// (normal = 0, lc = +₹800). Any other value → treated as normal.
// ──────────────────────────────────────────────
const calcHB = (rate, gauge = "12", carbonType = "normal") => {
  const gaugePremium = lookup(rate.hbGaugePremiums, gauge);
  if (gaugePremium === undefined || gaugePremium === null) {
    throw new AppError(`HB Wire ${gauge}g is not available`, 400);
  }
  const carbonExtra = lookup(rate.carbonExtras, carbonType) ?? 0;
  const { wrBaseRate, hbPremium, fixedCharge, gstPercent } = rate;

  const hbBase = wrBaseRate + hbPremium;
  const mergedBase = hbBase + gaugePremium + carbonExtra;
  const subtotal = mergedBase + fixedCharge;
  const gst = Math.round((subtotal * gstPercent) / 100);
  const total = subtotal + gst;

  const mmRange = gaugeToMmRange(gauge);
  const mmLabel = mmRange ? ` (${mmRange.minMm}-${mmRange.maxMm}mm)` : "";

  return {
    category: "hb",
    gauge,
    mmRange,
    carbonType,
    unit: "ton",
    mergedBase,
    fixedCharge,
    gstPercent,
    subtotal,
    gst,
    total,
    label: `HB Wire ${gauge}g${mmLabel}${carbonType === "lc" ? " LC" : ""}`,
  };
};

// ──────────────────────────────────────────────
// HB Price by MM size (user says "5.3mm" → find gauge → calculate)
// ──────────────────────────────────────────────
const calcHBByMm = (rate, mm, carbonType = "normal") => {
  const row = mmToGauge(mm);
  if (!row) throw new AppError(`Cannot find gauge for ${mm}mm`, 400);
  return calcHB(rate, row.gauge, carbonType);
};

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────
const calculatePrice = async (category, options = {}) => {
  const rate = await getActiveBaseRate();
  if (category === "wr") {
    return calcWR(rate, options.size || "5.5", options.carbonType || "normal");
  }
  if (category === "hb") {
    const carbonType = options.carbonType || "normal";
    if (options.mm) return calcHBByMm(rate, options.mm, carbonType);
    return calcHB(rate, options.gauge || "12", carbonType);
  }
  throw new AppError(`Pricing not configured for: ${category}`, 400);
};

const getFullPriceTable = async () => {
  const rate = await getActiveBaseRate();
  const sp = rate.sizePremiums || {};
  const ce = rate.carbonExtras || {};
  const wrSizes = Object.keys(sp instanceof Map ? Object.fromEntries(sp) : sp);
  const carbonTypes = Object.keys(ce instanceof Map ? Object.fromEntries(ce) : ce);

  const wr = [];
  for (const size of wrSizes) {
    for (const ct of carbonTypes) {
      wr.push(calcWR(rate, size, ct));
    }
  }

  // HB × carbonTypes — normal entries come first (preserves existing
  // `.find(p => p.gauge === "12")` callers picking the normal variant).
  const hb = [];
  for (const g of ALL_HB_GAUGES) {
    for (const ct of carbonTypes) {
      try { hb.push(calcHB(rate, g, ct)); } catch { /* skip unconfigured */ }
    }
  }

  return { wrBaseRate: rate.wrBaseRate, updatedAt: rate.updatedAt, wr, hb };
};

const buildPriceContext = async () => {
  try {
    const table = await getFullPriceTable();
    const lines = [
      `Steel Prices — ALL RATES PER TON`,
      `Base: ₹${table.wrBaseRate.toLocaleString("en-IN")}/ton`,
      "",
      "WR sizes: " + table.wr.map((p) => `${p.label}: ₹${p.total.toLocaleString("en-IN")}/ton`).join(" | "),
      "",
      "HB gauges: " + table.hb.map((p) => `${p.label}: ₹${p.total.toLocaleString("en-IN")}/ton`).join(" | "),
    ];
    return lines.join("\n");
  } catch {
    return "No prices available. Admin needs to set the base rate.";
  }
};

const updateBaseRate = async (wrBaseRate, employeeId, overrides = {}) => {
  _cachedRate = null;
  _cacheTs = 0;

  // Grab previous active rate to carry forward premiums/config
  const prevRate = await BaseRate.findOne({ isActive: true }).lean();

  await BaseRate.updateMany({ isActive: true }, { isActive: false });

  // Always carry forward hbGaugePremiums — merge: hardcoded defaults ← old DB values ← admin overrides
  const prevGaugePremiums = prevRate?.hbGaugePremiums || {};
  const mergedGaugePremiums = {
    ...DEFAULT_HB_GAUGE_PREMIUMS,
    ...prevGaugePremiums,
    ...(overrides.hbGaugePremiums || {}),
  };

  const rateData = {
    wrBaseRate,
    isActive: true,
    updatedBy: employeeId,
    hbGaugePremiums: mergedGaugePremiums,
    sizePremiums: overrides.sizePremiums || prevRate?.sizePremiums || undefined,
    carbonExtras: overrides.carbonExtras || prevRate?.carbonExtras || undefined,
  };
  if (overrides.hbPremium !== undefined) rateData.hbPremium = overrides.hbPremium;
  if (overrides.fixedCharge !== undefined) rateData.fixedCharge = overrides.fixedCharge;
  if (overrides.gstPercent !== undefined) rateData.gstPercent = overrides.gstPercent;

  const newRate = await BaseRate.create(rateData);
  logger.info(`Base rate updated to ₹${wrBaseRate} by employee ${employeeId}`);
  return newRate;
};

const clearRateCache = () => {
  _cachedRate = null;
  _cacheTs = 0;
};

module.exports = {
  GAUGE_MM_TABLE,
  ALL_HB_GAUGES,
  DEFAULT_HB_GAUGE_PREMIUMS,
  mmToGauge,
  gaugeToMmRange,
  getActiveBaseRate,
  calculatePrice,
  getFullPriceTable,
  buildPriceContext,
  updateBaseRate,
  clearRateCache,
};
