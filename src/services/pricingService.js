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

// ──────────────────────────────────────────────
// BINDING WIRE — hard-coded formula constants
//
// Pricing rules (all per ton, default unit = ton, no LC option):
//   • Binding 20g (without wrapper)  basic  =  WR55 + 9300 + 1345
//   • Binding 18g (without wrapper)  basic  =  (20g w/o wrapper basic) − 200
//   • With-wrapper variants          basic  =  corresponding w/o-wrapper + 1000
//   • Binding 20g random             basic  =  admin-entered absolute number
//                                              (rate.bindingRandom20gBasic)
//   • Random 20g with wrapper        basic  =  random basic + 1000
//   • Loading (per ton)             =  ₹515  (different from WR's ₹345)
//   • GST                           =  18%   (same as WR/HB)
// Default variant when customer doesn't say wrapper/random = without wrapper.
// ──────────────────────────────────────────────
const BINDING_PREMIUM_OVER_55 = 9300;     // additive on top of WR 5.5mm basic
const BINDING_EXTRA_OVER_55 = 1345;       // second additive (final = WR55 + 9300 + 1345)
const BINDING_18G_DISCOUNT = 200;         // 18g costs ₹200 LESS than 20g (same wrapper status)
const BINDING_PACKAGING_EXTRA = 1000;     // adding wrapper costs +₹1000 over the no-wrapper variant
const BINDING_LOADING = 515;              // per-ton loading (replaces WR's 345 for binding)

const BINDING_GAUGES = ["18", "20"];      // only two gauges sold
const BINDING_VARIANTS = ["without_wrapper", "with_wrapper", "random"];

// ──────────────────────────────────────────────
// NAILS — hard-coded premium table over admin-entered nailsBasicRate.
//
// The "default cluster" gets the basic rate as-is (premium = 0):
//   8G × {3", 4"}, 9G × {2", 2.5", 3"}, 10G × {2", 2.5", 3"}
//
// Every other valid (gauge, inch) combination gets a fixed premium added
// to the basic. Anything not in this table → unavailable.
// All sizes priced per ton; loading ₹515/ton; GST 18%.
// Customer minimum for nails is 500kg per item (enforced in chatService).
// ──────────────────────────────────────────────
const NAILS_LOADING = 515;
const NAILS_PREMIUMS = [
  // gauge, sizes (inches as strings), premium-over-basic
  { gauge: "8",  sizes: ["3", "4"],            premium: 0 },     // default cluster
  { gauge: "9",  sizes: ["2", "2.5", "3"],     premium: 0 },     // default cluster
  { gauge: "10", sizes: ["2", "2.5", "3"],     premium: 0 },     // default cluster
  { gauge: "11", sizes: ["1.5", "2", "2.5"],   premium: 500 },
  { gauge: "13", sizes: ["1.5", "2"],          premium: 4000 },
  { gauge: "13", sizes: ["1"],                 premium: 6000 },
  { gauge: "8",  sizes: ["1.5", "2", "2.5"],   premium: 850 },
  { gauge: "8",  sizes: ["1"],                 premium: 1700 },
  { gauge: "6",  sizes: ["2.5", "3", "4", "5", "6"], premium: 1000 },
];

const NAILS_DEFAULT_GAUGE = "8";
const NAILS_DEFAULT_SIZES = ["3", "4"];   // when customer says only "nails", quote 8G 3" + 8G 4"

// Build a flat lookup map: "8|3" → 0, "11|2.5" → 500, etc. (rebuilt at startup).
const _nailsPremiumLookup = (() => {
  const m = new Map();
  for (const row of NAILS_PREMIUMS) {
    for (const sz of row.sizes) {
      m.set(`${row.gauge}|${sz}`, row.premium);
    }
  }
  return m;
})();

const ALL_NAILS_COMBOS = NAILS_PREMIUMS.flatMap(
  (r) => r.sizes.map((sz) => ({ gauge: r.gauge, size: sz, premium: r.premium }))
);

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
  rate.bindingRandom20gBasic = rate.bindingRandom20gBasic ?? 0;
  rate.nailsBasicRate = rate.nailsBasicRate ?? 0;

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
// BINDING WIRE Price Calculation
//
// gauge      : "18" | "20"     (default "20")
// packaging  : "without" | "with"   (default "without" — customer must
//              explicitly say "with wrapper / packaging" to switch)
// random     : boolean          (only valid for "20" gauge)
//
// Final per-ton price = (basic + 515 loading) × 1.18
// ──────────────────────────────────────────────
const calcBinding = (rate, options = {}) => {
  const gauge = String(options.gauge || "20");
  const packaging = options.packaging === "with" ? "with" : "without";
  const random = Boolean(options.random);

  if (!BINDING_GAUGES.includes(gauge)) {
    throw new AppError(`Binding wire gauge ${gauge} is not available (only 18g, 20g)`, 400);
  }
  if (random && gauge !== "20") {
    throw new AppError(`Binding random is available only for 20g`, 400);
  }

  const { wrBaseRate, gstPercent, bindingRandom20gBasic } = rate;

  // mergedBase = the basic rate before loading + GST
  let mergedBase;
  if (random) {
    if (!bindingRandom20gBasic || bindingRandom20gBasic <= 0) {
      throw new AppError("Binding 20g random rate not set by admin yet", 404);
    }
    mergedBase = bindingRandom20gBasic;
  } else {
    // Derived from WR 5.5mm basic.
    const base20WithoutWrapper = wrBaseRate + BINDING_PREMIUM_OVER_55 + BINDING_EXTRA_OVER_55;
    mergedBase = gauge === "20"
      ? base20WithoutWrapper
      : base20WithoutWrapper - BINDING_18G_DISCOUNT;
  }
  if (packaging === "with") mergedBase += BINDING_PACKAGING_EXTRA;

  const fixedCharge = BINDING_LOADING;
  const subtotal = mergedBase + fixedCharge;
  const gst = Math.round((subtotal * gstPercent) / 100);
  const total = subtotal + gst;

  // Display label matches the admin-defined rate-template format the user
  // requested: "Binding Wire 20g 25kg (without wrapper)"
  const variantTag = random
    ? (packaging === "with" ? "random, with wrapper" : "random")
    : (packaging === "with" ? "with wrapper" : "without wrapper");
  const label = `Binding Wire ${gauge}g 25kg (${variantTag})`;

  return {
    category: "binding",
    gauge,
    packaging,
    random,
    unit: "ton",
    mergedBase,
    fixedCharge,
    gstPercent,
    subtotal,
    gst,
    total,
    label,
  };
};

// ──────────────────────────────────────────────
// NAILS Price Calculation
//
// gauge : "6" | "8" | "9" | "10" | "11" | "13"
// size  : inch as string ("1", "1.5", "2", "2.5", "3", "4", "5", "6")
//
// (gauge, size) MUST be one of the combinations in NAILS_PREMIUMS, otherwise
// we throw "not available". Customer minimum is 500kg per item (enforced in
// chatService); rate displayed per ton like all other categories.
// ──────────────────────────────────────────────
const calcNails = (rate, options = {}) => {
  const gauge = String(options.gauge || NAILS_DEFAULT_GAUGE);
  const size = String(options.size || "");
  if (!size) throw new AppError(`Nails size (inch) is required`, 400);

  const key = `${gauge}|${size}`;
  if (!_nailsPremiumLookup.has(key)) {
    throw new AppError(`Nails ${gauge}G ${size}" is not available`, 400);
  }

  const { nailsBasicRate, gstPercent } = rate;
  if (!nailsBasicRate || nailsBasicRate <= 0) {
    throw new AppError("Nails basic rate not set by admin yet", 404);
  }

  const premium = _nailsPremiumLookup.get(key);
  const mergedBase = nailsBasicRate + premium;
  const fixedCharge = NAILS_LOADING;
  const subtotal = mergedBase + fixedCharge;
  const gst = Math.round((subtotal * gstPercent) / 100);
  const total = subtotal + gst;

  const label = `Nails ${gauge}G ${size}"`;

  return {
    category: "nails",
    gauge,
    size,
    unit: "ton",
    mergedBase,
    fixedCharge,
    gstPercent,
    subtotal,
    gst,
    total,
    label,
  };
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
  if (category === "binding") {
    return calcBinding(rate, {
      gauge: options.gauge || "20",
      packaging: options.packaging || "without",
      random: Boolean(options.random),
    });
  }
  if (category === "nails") {
    return calcNails(rate, {
      gauge: options.gauge || NAILS_DEFAULT_GAUGE,
      size: options.size,
    });
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

  // Binding — emit all 6 SKUs (20g + 18g, with/without wrapper, plus 20g
  // random in both packagings if admin has set a random basic). Each entry
  // is calculated even if the random rate is missing — those throws are
  // caught and skipped so the table doesn't break for non-random SKUs.
  const binding = [];
  for (const gauge of BINDING_GAUGES) {
    for (const packaging of ["without", "with"]) {
      try { binding.push(calcBinding(rate, { gauge, packaging, random: false })); } catch { /* skip */ }
    }
  }
  for (const packaging of ["without", "with"]) {
    try { binding.push(calcBinding(rate, { gauge: "20", packaging, random: true })); } catch { /* skip if no random rate */ }
  }

  // Nails — every (gauge, inch) combination from NAILS_PREMIUMS.
  const nails = [];
  for (const combo of ALL_NAILS_COMBOS) {
    try { nails.push(calcNails(rate, { gauge: combo.gauge, size: combo.size })); } catch { /* skip if no nails basic */ }
  }

  return {
    wrBaseRate: rate.wrBaseRate,
    bindingRandom20gBasic: rate.bindingRandom20gBasic,
    nailsBasicRate: rate.nailsBasicRate,
    updatedAt: rate.updatedAt,
    wr,
    hb,
    binding,
    nails,
  };
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
    if (table.binding.length > 0) {
      lines.push("", "Binding: " + table.binding.map((p) => `${p.label}: ₹${p.total.toLocaleString("en-IN")}/ton`).join(" | "));
    }
    if (table.nails.length > 0) {
      lines.push("", "Nails: " + table.nails.map((p) => `${p.label}: ₹${p.total.toLocaleString("en-IN")}/ton`).join(" | "));
    }
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

  // ── New admin-entered absolutes for binding random + nails. Carry forward
  // from the previous active row when admin doesn't supply them, so updating
  // just the WR base doesn't accidentally wipe them.
  rateData.bindingRandom20gBasic =
    overrides.bindingRandom20gBasic !== undefined
      ? overrides.bindingRandom20gBasic
      : (prevRate?.bindingRandom20gBasic ?? 0);
  rateData.nailsBasicRate =
    overrides.nailsBasicRate !== undefined
      ? overrides.nailsBasicRate
      : (prevRate?.nailsBasicRate ?? 0);

  const newRate = await BaseRate.create(rateData);
  logger.info(
    `Base rate updated: WR=₹${wrBaseRate}, ` +
    `BindingRandom20g=₹${rateData.bindingRandom20gBasic}, ` +
    `NailsBasic=₹${rateData.nailsBasicRate}, by employee ${employeeId}`
  );
  return newRate;
};

// Update only one of the admin-entered "absolute" rates without touching the
// WR base. Used by the new admin UI buttons that update binding/nails alone.
// Pass either `bindingRandom20gBasic` or `nailsBasicRate` (or both); other
// fields are carried forward from the current active rate row.
const updateAdminAbsolutes = async (updates, employeeId) => {
  const prev = await BaseRate.findOne({ isActive: true }).lean();
  if (!prev) {
    throw new AppError("No active base rate yet — set WR base rate first.", 400);
  }
  const { wrBaseRate, ...overrides } = prev;
  // Strip mongo internal fields before re-creating
  delete overrides._id;
  delete overrides.createdAt;
  delete overrides.updatedAt;
  delete overrides.__v;

  if (updates.bindingRandom20gBasic !== undefined) {
    overrides.bindingRandom20gBasic = Number(updates.bindingRandom20gBasic);
  }
  if (updates.nailsBasicRate !== undefined) {
    overrides.nailsBasicRate = Number(updates.nailsBasicRate);
  }
  return updateBaseRate(wrBaseRate, employeeId, overrides);
};

const clearRateCache = () => {
  _cachedRate = null;
  _cacheTs = 0;
};

module.exports = {
  GAUGE_MM_TABLE,
  ALL_HB_GAUGES,
  DEFAULT_HB_GAUGE_PREMIUMS,
  // Binding constants — exposed so admin UI / docs can show derivation
  BINDING_GAUGES,
  BINDING_VARIANTS,
  BINDING_PREMIUM_OVER_55,
  BINDING_EXTRA_OVER_55,
  BINDING_18G_DISCOUNT,
  BINDING_PACKAGING_EXTRA,
  BINDING_LOADING,
  // Nails constants
  NAILS_LOADING,
  NAILS_PREMIUMS,
  NAILS_DEFAULT_GAUGE,
  NAILS_DEFAULT_SIZES,
  ALL_NAILS_COMBOS,
  mmToGauge,
  gaugeToMmRange,
  getActiveBaseRate,
  calculatePrice,
  getFullPriceTable,
  buildPriceContext,
  updateBaseRate,
  updateAdminAbsolutes,
  clearRateCache,
};
