const pricingService = require("./pricingService");
const logger = require("../config/logger");

const INR = (n) => {
  const val = Number(n);
  if (!isFinite(val)) return "₹0";
  return "₹" + Math.round(val).toLocaleString("en-IN");
};
const BRAND = "*Radhika Steel Raipur*";

// ──────────────────────────────────────────────
// WR Price Response
// ──────────────────────────────────────────────
const buildWRResponse = (price, quantity, askForSize = false) => {
  let msg = `${BRAND}\n\n`;
  msg += `*${price.label}*\n`;
  msg += `${INR(price.mergedBase)} + ${INR(price.fixedCharge)} + ${price.gstPercent}% GST\n`;
  msg += `*${INR(price.total)}/ton*`;

  if (quantity && quantity > 0) {
    const grandTotal = Math.round(price.total * quantity);
    msg += `\n\n${quantity} ton × ${INR(price.total)} = *${INR(grandTotal)}*`;
  }

  if (askForSize) {
    msg += `\n\n*Available:* 5.5 | 7 | 8 | 10 | 12 | 14 | 16 | 18mm`;
    msg += `\n_Kaunsa size chahiye aapko?_`;
  }

  msg += `\n\n_Rate per ton (1000 kg) incl. GST_`;
  return msg;
};

// ──────────────────────────────────────────────
// Build 0.1mm sub-ranges for a gauge
// ──────────────────────────────────────────────
const buildMmSubRanges = (mmRange) => {
  if (!mmRange) return [];
  const ranges = [];
  let start = Math.round(mmRange.minMm * 10) / 10;
  const end = Math.round(mmRange.maxMm * 10) / 10;
  while (start + 0.1 <= end + 0.001) {
    const from = start.toFixed(1);
    const to = (start + 0.1).toFixed(1);
    ranges.push(`${from} se ${to}mm`);
    start = Math.round((start + 0.1) * 10) / 10;
  }
  return ranges;
};

// ──────────────────────────────────────────────
// HB Price Response
// Builds label using the user's exact mm range when they specified one
// (e.g. "HB Wire 5g (5.2-5.3mm)"), else falls back to the gauge's full
// range from pricingService (e.g. "HB Wire 5g (5.2-5.6mm)").
// ──────────────────────────────────────────────
const buildHBLabel = (price, userMmRange) => {
  if (userMmRange && price && price.gauge) {
    const lc = price.carbonType === "lc" ? " LC" : "";
    return `HB Wire ${price.gauge}g (${userMmRange}mm)${lc}`;
  }
  return price ? price.label : "HB Wire";
};

const buildHBResponse = (price, quantity, askForMm = false, userMmRange = null) => {
  let msg = `${BRAND}\n\n`;
  msg += `*${buildHBLabel(price, userMmRange)}*\n`;
  msg += `${INR(price.mergedBase)} + ${INR(price.fixedCharge)} + ${price.gstPercent}% GST\n`;
  msg += `*${INR(price.total)}/ton*`;

  if (quantity && quantity > 0) {
    const grandTotal = Math.round(price.total * quantity);
    msg += `\n\n${quantity} ton × ${INR(price.total)} = *${INR(grandTotal)}*`;
  }

  if (askForMm && price.mmRange && !userMmRange) {
    const subRanges = buildMmSubRanges(price.mmRange);
    msg += `\n\n*${price.gauge}g sizes:*\n`;
    msg += subRanges.join("  |  ");
    msg += `\n\n_Kaunsa mm range chahiye?_`;
  }

  msg += `\n\n_Rate per ton (1000 kg) incl. GST_`;
  return msg;
};

// ──────────────────────────────────────────────
// Unavailable WR size
// ──────────────────────────────────────────────
const buildUnavailableSizeResponse = async (size, carbonType, quantity) => {
  const available = ["5.5", "7", "8", "10", "12", "14", "16", "18"];
  const req = parseFloat(size);
  let lower = null, upper = null;
  for (const s of available.map(Number).sort((a, b) => a - b)) {
    if (s < req) lower = s;
    if (s > req && upper === null) upper = s;
  }

  let msg = `${BRAND}\n\n`;
  msg += `WR ${size}mm available nahi hai.\n\n`;
  msg += `Nearest sizes:\n`;

  const suggestions = [];
  if (lower !== null) suggestions.push(String(lower));
  if (upper !== null) suggestions.push(String(upper));

  for (const s of suggestions) {
    try {
      const p = await pricingService.calculatePrice("wr", { size: s, carbonType });
      msg += `\n▸ *WR ${s}mm${carbonType === "lc" ? " LC" : ""}* — *${INR(p.total)}/ton*`;
      if (quantity && quantity > 0) {
        msg += ` (${quantity}T = ${INR(Math.round(p.total * quantity))})`;
      }
    } catch { /* skip */ }
  }

  msg += `\n\n_Kaunsa size chahiye? Bataiye._`;
  return msg;
};

// ──────────────────────────────────────────────
// BINDING WIRE — single-SKU rate response
// ──────────────────────────────────────────────
const buildBindingResponse = (price, quantity) => {
  let msg = `${BRAND}\n\n`;
  msg += `*${price.label}*\n`;
  msg += `${INR(price.mergedBase)} + ${INR(price.fixedCharge)} + ${price.gstPercent}% GST\n`;
  msg += `*${INR(price.total)}/ton*`;

  if (quantity && quantity > 0) {
    const grandTotal = Math.round(price.total * quantity);
    msg += `\n\n${quantity} ton × ${INR(price.total)} = *${INR(grandTotal)}*`;
  }

  msg += `\n\n_Rate per ton (1000 kg) incl. GST_`;
  return msg;
};

// ──────────────────────────────────────────────
// BINDING WIRE — "binding" keyword only (no gauge / wrapper specified).
// Per spec: quote 18g, 20g and 20g random — all WITHOUT wrapper.
// ──────────────────────────────────────────────
const buildBindingDefaultResponse = async () => {
  let msg = `${BRAND}\n`;
  msg += `\n*Binding Wire rates:*`;

  const variants = [
    { gauge: "20", random: false, label: `Binding Wire 20g 25kg (without wrapper)` },
    { gauge: "18", random: false, label: `Binding Wire 18g 25kg (without wrapper)` },
    { gauge: "20", random: true,  label: `Binding Wire 20g 25kg (random)` },
  ];
  for (const v of variants) {
    try {
      const p = await pricingService.calculatePrice("binding", {
        gauge: v.gauge, random: v.random, packaging: "without",
      });
      msg += `\n\n▸ *${p.label}*`;
      msg += `\n${INR(p.mergedBase)} + ${INR(p.fixedCharge)} + ${p.gstPercent}% GST = *${INR(p.total)}/ton*`;
    } catch {
      // Rate not configured (typically 20g random before admin enters it).
      // Per spec the 20g random line MUST still appear — show a clear
      // "rate pending" placeholder instead of silently dropping it.
      msg += `\n\n▸ *${v.label}*`;
      msg += `\n_Rate update hona baki hai — thodi der me bhejte hain._`;
    }
  }
  msg += `\n\n_Rate per ton (1000 kg) incl. GST_`;
  msg += `\n_Packaging (wrapper) chahiye toh batayein — alag rate hai._`;
  return msg;
};

// ──────────────────────────────────────────────
// NAILS — single-SKU rate response (rate shown per ton, qty in kg).
// ──────────────────────────────────────────────
const buildNailsResponse = (price, quantity) => {
  let msg = `${BRAND}\n\n`;
  msg += `*${price.label}*\n`;
  msg += `${INR(price.mergedBase)} + ${INR(price.fixedCharge)} + ${price.gstPercent}% GST\n`;
  msg += `*${INR(price.total)}/ton*`;

  if (quantity && quantity > 0) {
    // Quantity is in KG for nails; convert to ton for the math.
    const tons = quantity / 1000;
    const grandTotal = Math.round(price.total * tons);
    msg += `\n\n${quantity} kg × ${INR(price.total)}/ton = *${INR(grandTotal)}*`;
  }

  msg += `\n\n_Rate per ton (1000 kg) incl. GST • Minimum 500 kg per size_`;
  return msg;
};

// ──────────────────────────────────────────────
// NAILS — "nails" keyword only (no gauge / inch).
// Per spec: quote 8G 3" and 8G 4" and ask which gauge + size is needed.
// ──────────────────────────────────────────────
const buildNailsDefaultResponse = async () => {
  let msg = `${BRAND}\n`;
  msg += `\n*Nails rates:*`;
  const defaults = [
    { gauge: "8", size: "3" },
    { gauge: "8", size: "4" },
  ];
  for (const d of defaults) {
    try {
      const p = await pricingService.calculatePrice("nails", d);
      msg += `\n\n▸ *${p.label}*`;
      msg += `\n${INR(p.mergedBase)} + ${INR(p.fixedCharge)} + ${p.gstPercent}% GST = *${INR(p.total)}/ton*`;
    } catch {
      // nails basic not configured yet — just skip so message still renders
    }
  }
  msg += `\n\n*Available gauge × inch:*`;
  msg += `\n▸ 8G: 1" | 1.5" | 2" | 2.5" | 3" | 4"`;
  msg += `\n▸ 9G: 2" | 2.5" | 3"`;
  msg += `\n▸ 10G: 2" | 2.5" | 3"`;
  msg += `\n▸ 11G: 1.5" | 2" | 2.5"`;
  msg += `\n▸ 13G: 1" | 1.5" | 2"`;
  msg += `\n▸ 6G: 2.5" | 3" | 4" | 5" | 6"`;
  msg += `\n\n_Rate per ton (1000 kg) incl. GST • Minimum 500 kg per size_`;
  msg += `\n_Kaunsa gauge aur kitna inch chahiye aapko?_`;
  return msg;
};

// ──────────────────────────────────────────────
// Strip mm range from HB label: "HB Wire 5g (5.2-5.6mm)" → "HB Wire 5g"
// ──────────────────────────────────────────────
const shortLabel = (label) => label.replace(/\s*\([\d.]+-[\d.]+mm\)/, "");

// ──────────────────────────────────────────────
// Multi-product response
// userMmRanges[i] (optional) — user's exact mm range for HB items
// quantities[i] is interpreted as TON for WR / HB / binding,
// and as KG for nails.
// ──────────────────────────────────────────────
const buildMultiPriceResponse = (prices, quantities, userMmRanges = []) => {
  let msg = `${BRAND}`;
  let grandTotal = 0;

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const qty = quantities[i] || 0;
    const userRange = userMmRanges[i] || null;
    // Label selection — HB uses user's exact mm range when provided;
    // WR / binding / nails use the price's built-in label verbatim.
    let label;
    if (p.category === "hb" && userRange && p.gauge) {
      label = `HB Wire ${p.gauge}g (${userRange}mm)${p.carbonType === "lc" ? " LC" : ""}`;
    } else {
      label = shortLabel(p.label);
    }
    msg += `\n\n▸ *${label}*`;
    msg += `\n${INR(p.mergedBase)} + ${INR(p.fixedCharge)} + ${p.gstPercent}% GST = *${INR(p.total)}/ton*`;
    if (qty > 0) {
      // Nails quantity is in kg; everything else is in ton.
      if (p.category === "nails") {
        const tons = qty / 1000;
        const itemTotal = Math.round(p.total * tons);
        grandTotal += itemTotal;
        msg += `\n${qty} kg × ${INR(p.total)}/ton = *${INR(itemTotal)}*`;
      } else {
        const itemTotal = Math.round(p.total * qty);
        grandTotal += itemTotal;
        msg += `\n${qty} ton × ${INR(p.total)} = *${INR(itemTotal)}*`;
      }
    }
  }

  if (grandTotal > 0) {
    msg += `\n\n─────────────────`;
    msg += `\n*Total: ${INR(grandTotal)}*`;
  }

  msg += `\n\n_Rate per ton (1000 kg) incl. GST_`;
  // Only mention the 500kg nails min when at least one nails item is present —
  // otherwise this is the regular WR/HB/binding combined quote.
  if (prices.some((p) => p && p.category === "nails")) {
    msg += `\n_Nails minimum 500 kg per size._`;
  }
  return msg;
};

// ──────────────────────────────────────────────
// Order Confirmation
// ──────────────────────────────────────────────
const MIN_QTY_PER_ITEM = 2;        // tons — applies to wr/hb/binding
const MIN_QTY_TOTAL = 5;           // tons — sum of wr+hb+binding
const MIN_QTY_NAILS_PER_ITEM = 500; // kg — applies to nails only
const ADVANCE_AMOUNT = 50000;

// Build the display label for a single order item — uses user's exact mm
// range for HB wire when provided.
const buildItemLabel = (item, price) => {
  if (item.category === "hb" && item.mmRange && price && price.gauge) {
    const lc = (item.carbonType === "lc" || price.carbonType === "lc") ? " LC" : "";
    return `HB Wire ${price.gauge}g (${item.mmRange}mm)${lc}`;
  }
  return shortLabel(price ? price.label : "");
};

// Map an order item → the right pricingService call. Centralises the
// WR / HB / binding / nails dispatch so both buildOrderConfirmation and
// any other caller stays consistent with pricingService defaults.
const priceForItem = async (item) => {
  if (item.category === "wr") {
    return pricingService.calculatePrice("wr", {
      size: item.size || "5.5",
      carbonType: item.carbonType || "normal",
    });
  }
  if (item.category === "hb") {
    const carbonType = item.carbonType || "normal";
    if (item.mm) {
      return pricingService.calculatePrice("hb", { mm: item.mm, carbonType });
    }
    return pricingService.calculatePrice("hb", { gauge: item.gauge || "12", carbonType });
  }
  if (item.category === "binding") {
    return pricingService.calculatePrice("binding", {
      gauge: String(item.gauge || "20"),
      packaging: item.packaging === "with" ? "with" : "without",
      random: Boolean(item.random),
    });
  }
  if (item.category === "nails") {
    return pricingService.calculatePrice("nails", {
      gauge: String(item.gauge || "8"),
      size: String(item.size || item.inch || ""),
    });
  }
  return null;
};

/**
 * Order confirmation message.
 * @param {Array} items    order items (each may carry mmRange for HB)
 * @param {Object} opts
 *   @param {string} [opts.orderNumber]  — order #, shown at top if provided
 *   @param {number} [opts.paidAmount]   — total paid so far (₹). Default 0.
 */
const buildOrderConfirmation = async (items, opts = {}) => {
  const { orderNumber = null, paidAmount = 0 } = opts;

  let msg = `${BRAND}\n`;
  msg += `✅ *Order Confirmed*`;
  if (orderNumber) msg += `\nOrder #: *${orderNumber}*`;

  let grandTotal = 0;
  let totalTons = 0;   // sum of ton-based items (wr/hb/binding)
  let totalKgNails = 0; // nails-only kg total, shown separately

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let price;
    try {
      price = await priceForItem(item);
    } catch (err) {
      logger.warn(`[ORDER] Price calc failed for item ${i}: ${err.message}`);
      continue;
    }
    if (!price) continue;

    const qty = item.quantity || 0;
    // Nails quantities are in kg; everything else is in ton.
    const isNails = item.category === "nails";
    const tonsForMath = isNails ? qty / 1000 : qty;
    const itemTotal = Math.round(price.total * tonsForMath);
    grandTotal += itemTotal;
    if (isNails) totalKgNails += qty;
    else totalTons += qty;

    msg += `\n\n▸ *${buildItemLabel(item, price)}*`;
    msg += `\n${INR(price.mergedBase)} + ${INR(price.fixedCharge)} + ${price.gstPercent}% GST = *${INR(price.total)}/ton*`;
    if (qty > 0) {
      if (isNails) {
        msg += `\n${qty} kg × ${INR(price.total)}/ton = *${INR(itemTotal)}*`;
      } else {
        msg += `\n${qty} ton × ${INR(price.total)} = *${INR(itemTotal)}*`;
      }
    }
  }

  msg += `\n\n─────────────────`;
  // Build the total line — combine ton and kg parts when both are present.
  const parts = [];
  if (totalTons > 0) parts.push(`${totalTons} ton`);
  if (totalKgNails > 0) parts.push(`${totalKgNails} kg nails`);
  const qtySummary = parts.length ? parts.join(" + ") + " — " : "";
  msg += `\n*Total: ${qtySummary}${INR(grandTotal)}*`;

  // Payment summary — always shows Total / Paid / Remaining.
  // Advance is flexible — customer can pay any amount (less than, equal to,
  // or more than the suggested booking amount). We only report actuals here.
  const paid = Math.max(0, Number(paidAmount) || 0);
  const remaining = Math.max(0, grandTotal - paid);
  msg += `\n\n*Payment:*`;
  msg += `\nTotal Amount: *${INR(grandTotal)}*`;
  msg += `\nPaid: *${INR(paid)}*`;
  msg += `\nRemaining: *${INR(remaining)}*`;

  if (paid === 0) {
    msg += `\n\nBooking ke liye advance bhejiye. Transport aapki taraf se.`;
    msg += `\n_Advance milte hi dispatch schedule hoga._`;
  } else if (remaining > 0) {
    msg += `\n\nBalance *${INR(remaining)}* loading ke time. Transport aapki taraf se.`;
  } else {
    msg += `\n\n✅ *Full payment received.* Dispatch ke liye ready.`;
  }

  msg += `\n\n🙏 Dhanyawad!`;

  return msg;
};

/**
 * Post-payment / status-update summary (short version). Reuses the same
 * Total / Paid / Remaining block so the customer always sees consistent
 * numbers whenever we message them about their order.
 */
const buildOrderPaymentSummary = (order) => {
  const grandTotal = Math.round(order?.pricing?.grandTotal || 0);
  const paid = Math.round(order?.advancePayment?.amount || 0);
  const remaining = Math.max(0, grandTotal - paid);

  let msg = `${BRAND}\n\n`;
  msg += `*Order: ${order?.orderNumber || "N/A"}*\n`;
  msg += `Status: *${String(order?.status || "pending").replace(/_/g, " ").toUpperCase()}*\n`;
  msg += `\n*Payment Summary:*`;
  msg += `\nTotal Amount: *${INR(grandTotal)}*`;
  msg += `\nPaid: *${INR(paid)}*`;
  msg += `\nRemaining: *${INR(remaining)}*`;
  return msg;
};

// Build a min-qty error message. Ton-based items (wr/hb/binding) share the
// existing 2T-per-item + 5T-total rule; nails items are validated separately
// at 500 kg per item (no total rule across nails).
const buildMinQtyError = (items) => {
  const tonItems = items.filter((i) => i.category !== "nails");
  const nailsItems = items.filter((i) => i.category === "nails");
  const totalTons = tonItems.reduce((sum, i) => sum + (i.quantity || 0), 0);

  let msg = `${BRAND}\n\n`;
  msg += `Order ke liye minimum quantity:\n`;
  if (tonItems.length > 0) {
    msg += `▸ Har item (WR / HB / Binding): *${MIN_QTY_PER_ITEM} ton*\n`;
    msg += `▸ Total: *${MIN_QTY_TOTAL} ton*\n`;
  }
  if (nailsItems.length > 0) {
    msg += `▸ Nails (har size): *${MIN_QTY_NAILS_PER_ITEM} kg*\n`;
  }

  const shortItemLabel = (item) => {
    if (item.category === "wr") return `WR ${item.size || "5.5"}mm`;
    if (item.category === "hb") {
      if (item.mm) return `HB ${item.mm}mm`;
      return `HB ${item.gauge || "12"}g`;
    }
    if (item.category === "binding") {
      const variant = item.random
        ? (item.packaging === "with" ? "20g random + wrapper" : "20g random")
        : `${item.gauge || "20"}g${item.packaging === "with" ? " + wrapper" : ""}`;
      return `Binding ${variant}`;
    }
    if (item.category === "nails") {
      return `Nails ${item.gauge || "8"}G ${item.size || item.inch || ""}"`;
    }
    return String(item.category || "item").toUpperCase();
  };

  const tonErrors = tonItems.filter((i) => (i.quantity || 0) < MIN_QTY_PER_ITEM);
  const nailsErrors = nailsItems.filter((i) => (i.quantity || 0) < MIN_QTY_NAILS_PER_ITEM);

  if (tonErrors.length > 0 || nailsErrors.length > 0) {
    msg += `\n`;
    for (const item of tonErrors) {
      msg += `${shortItemLabel(item)}: ${item.quantity || 0}T (min ${MIN_QTY_PER_ITEM}T chahiye)\n`;
    }
    for (const item of nailsErrors) {
      msg += `${shortItemLabel(item)}: ${item.quantity || 0}kg (min ${MIN_QTY_NAILS_PER_ITEM}kg chahiye)\n`;
    }
  }

  if (tonItems.length > 0 && totalTons < MIN_QTY_TOTAL) {
    msg += `\nTotal (WR/HB/Binding): ${totalTons}T (min ${MIN_QTY_TOTAL}T chahiye)`;
  }

  msg += `\n\n_Quantity badhake confirm karein._`;
  return msg;
};

// ──────────────────────────────────────────────
// Order Quantity Ask — natural employee-like message
// ──────────────────────────────────────────────
const buildOrderQuantityAsk = (parsedIntent, userText) => {
  const isEnglish = /^[a-zA-Z0-9\s.,?!'"()-]+$/.test((userText || "").trim());
  if (isEnglish) {
    return "Sure, how many tons do you need?";
  }
  return "Ji, kitna ton chahiye aapko?";
};

// Label used when asking the customer for a per-item quantity. Matches the
// shorter format used in multi-item price responses (no trailing mm range
// when the gauge's own mm range is implied).
const itemShortLabel = (item) => {
  const lc = item.carbonType === "lc" ? " LC" : "";
  if (item.category === "wr") {
    return `WR ${item.size || "5.5"}mm${lc}`;
  }
  if (item.category === "hb") {
    const g = item.gauge || "12";
    if (item.mmRange || item.mm) {
      return `HB Wire ${g}g (${item.mmRange || item.mm}mm)${lc}`;
    }
    return `HB Wire ${g}g${lc}`;
  }
  if (item.category === "binding") {
    const g = item.gauge || "20";
    const wrapper = item.packaging === "with" ? "with wrapper" : "without wrapper";
    const variantTag = item.random
      ? (item.packaging === "with" ? "random, with wrapper" : "random")
      : wrapper;
    return `Binding Wire ${g}g 25kg (${variantTag})`;
  }
  if (item.category === "nails") {
    const g = item.gauge || "8";
    const s = item.size || item.inch || "";
    return `Nails ${g}G${s ? ` ${s}"` : ""}`;
  }
  return `${String(item.category || "").toUpperCase()} ${item.size || item.gauge || ""}`.trim();
};

/**
 * Ask the customer for quantities when they've said "book" / "confirm" but
 * haven't told us how many tons per size. For a single item we send the
 * short existing ask; for multi-item we list every size so the customer
 * knows they need to give a quantity for each.
 */
const buildQuantityAskForItems = (items, userText = "") => {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length <= 1) {
    const single = list[0];
    const parsedIntent = single ? { category: single.category } : {};
    return buildOrderQuantityAsk(parsedIntent, userText);
  }

  const hasNails = list.some((it) => it.category === "nails");
  const hasTonItems = list.some((it) => it.category !== "nails");

  let msg = `${BRAND}\n\nOrder book karne ke liye har item ke liye quantity bataiye:\n`;
  for (const it of list) {
    const unitHint = it.category === "nails" ? "? kg" : "? ton";
    msg += `\n▸ *${itemShortLabel(it)}* — ${unitHint}`;
  }
  if (hasNails && hasTonItems) {
    msg += `\n\n_Example: "8mm 3 ton, 20g 2 ton, nails 500 kg"_`;
  } else if (hasNails) {
    msg += `\n\n_Example: "8G 3 inch 500 kg, 10G 2 inch 500 kg"_`;
  } else {
    msg += `\n\n_Example: "8mm 3 ton, 10mm 2 ton book karo"_`;
  }
  if (hasTonItems) {
    msg += `\n_Minimum ${MIN_QTY_PER_ITEM} ton per size, total ${MIN_QTY_TOTAL} ton._`;
  }
  if (hasNails) {
    msg += `\n_Nails minimum ${MIN_QTY_NAILS_PER_ITEM} kg per size._`;
  }
  return msg;
};

// ──────────────────────────────────────────────
// Delivery Info Response (from DB)
// ──────────────────────────────────────────────
const buildDeliveryResponse = (order) => {
  const d = order.delivery || {};
  const status = String(order.status || "pending").replace(/_/g, " ").toUpperCase();
  let msg = `${BRAND}\n\n`;
  msg += `*Order: ${order.orderNumber || "N/A"}*\n`;
  msg += `Status: *${status}*\n`;

  const { formatIstDate } = require("../utils/dateUtils");
  if (d.scheduledDate) msg += `\nDelivery Date: *${formatIstDate(d.scheduledDate)}*`;
  if (d.dispatchedAt) msg += `\nDispatched: *${formatIstDate(d.dispatchedAt)}*`;
  if (d.driverName) msg += `\nDriver: *${d.driverName}*`;
  if (d.driverPhone) msg += `\nDriver Phone: *${d.driverPhone}*`;
  if (d.vehicleNumber) msg += `\nVehicle: *${d.vehicleNumber}*`;
  if (d.deliveredAt) msg += `\nDelivered: *${formatIstDate(d.deliveredAt)}*`;

  if (!d.scheduledDate && !d.dispatchedAt && !d.driverName && !d.driverPhone && !d.vehicleNumber) {
    msg += `\nDelivery details abhi update nahi hui hain. Jaldi update milega.`;
  }

  return msg;
};

// ──────────────────────────────────────────────
// GENERIC RATE INQUIRY — fires when customer asks "rate" / "today's rate" /
// "aaj ka bhav" without naming any category. Quotes our full mainline
// line-up: WR 5.5mm, HB 12g, Binding 18g + 20g (without wrapper), and
// Nails 8G 3" — so the customer sees every SKU we push as daily updates.
// ──────────────────────────────────────────────
const buildDefaultRatesResponse = async (quantity) => {
  let msg = `${BRAND}\n`;
  msg += `\n*Aaj ke rates:*`;

  const lines = [
    { category: "wr", options: { size: "5.5", carbonType: "normal" }, fallback: "WR 5.5mm" },
    { category: "hb", options: { gauge: "12", carbonType: "normal" }, fallback: "HB Wire 12g" },
    { category: "binding", options: { gauge: "20", packaging: "without", random: false }, fallback: "Binding Wire 20g 25kg (without wrapper)" },
    { category: "binding", options: { gauge: "18", packaging: "without", random: false }, fallback: "Binding Wire 18g 25kg (without wrapper)" },
    { category: "nails", options: { gauge: "8", size: "3" }, fallback: `Nails 8G 3"` },
  ];

  for (const l of lines) {
    try {
      const p = await pricingService.calculatePrice(l.category, l.options);
      msg += `\n\n▸ *${p.label}*`;
      msg += `\n${INR(p.mergedBase)} + ${INR(p.fixedCharge)} + ${p.gstPercent}% GST = *${INR(p.total)}/ton*`;
      if (quantity && quantity > 0) {
        msg += `\n_${quantity} ton × ${INR(p.total)} = ${INR(Math.round(p.total * quantity))}_`;
      }
    } catch {
      msg += `\n\n▸ *${l.fallback}*`;
      msg += `\n_Rate update hona baki hai — thodi der me bhejte hain._`;
    }
  }

  msg += `\n\n_Rate per ton (1000 kg) incl. GST_`;
  msg += `\n_Koi aur size ya product chahiye toh bataiye._`;
  return msg;
};

// ──────────────────────────────────────────────
// Template responses
// ──────────────────────────────────────────────
const buildGreeting = async () => {
  let msg = `${BRAND}\n\nNamaste! 🙏\n`;

  // Greeting quote: WR 5.5mm, HB 12g, Binding 20g + 18g (both without
  // wrapper). Each block is wrapped in try/catch so a missing rate (e.g.
  // admin hasn't set bindingRandom20gBasic) doesn't break the greeting.
  const blocks = [
    { category: "wr", options: { size: "5.5", carbonType: "normal" } },
    { category: "hb", options: { gauge: "12", carbonType: "normal" } },
    { category: "binding", options: { gauge: "20", packaging: "without", random: false } },
    { category: "binding", options: { gauge: "18", packaging: "without", random: false } },
  ];

  for (const b of blocks) {
    try {
      const p = await pricingService.calculatePrice(b.category, b.options);
      msg += `\n*${p.label}*\n`;
      msg += `${INR(p.mergedBase)} + ${INR(p.fixedCharge)} + ${p.gstPercent}% GST\n`;
      msg += `*${INR(p.total)}/ton*\n`;
    } catch { /* skip SKUs that aren't configured yet */ }
  }

  msg += `\nAapko kaunsa size chahiye? Bataiye.`;
  return msg;
};

const TEMPLATES = {
  thanks: `${BRAND}\n\nDhanyawad! 🙏\nKoi aur madad chahiye toh batayein.`,

  negotiation: null,

  delivery_inquiry: null,

  order_inquiry: `${BRAND}\n\nOrder ke liye:\n\n▸ Har item minimum *2 ton*\n▸ Total minimum *5 ton*\n▸ Booking advance: bhejiye (amount aapki suvidha anusaar)\n▸ Balance: loading ke time\n▸ Transport: aapki taraf se\n\nProduct aur quantity bataiye, order process kar denge.`,

  order_confirm_ask: `${BRAND}\n\nOrder confirm karne ke liye batayein:\n\n▸ Product aur size\n▸ Quantity (kitna ton)\n▸ Delivery location\n▸ Firm name / GST no.\n\n_Details milte hi process karenge._`,
};

const getTemplate = (key) => TEMPLATES[key] || null;

// ──────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────
const buildFromIntent = async (parsedIntent) => {
  const { intent, category, size, carbonType, quantity, gauge, mm, mmRange, sizeAvailable, packaging, random, inch } = parsedIntent;

  if (intent === "greeting") {
    const text = await buildGreeting();
    return { text, usedGPT: false };
  }
  if (intent === "thanks") return { text: TEMPLATES.thanks, usedGPT: false };
  if (intent === "negotiation") return null;
  if (intent === "delivery_inquiry") return null; // handled in chatService from DB
  if (intent === "order_inquiry") return { text: TEMPLATES.order_inquiry, usedGPT: false };

  if (intent === "price_inquiry" || intent === "follow_up") {
    if (category === "wr") {
      const wrSize = size || "5.5";
      const askForSize = !size;
      const isAvailable = sizeAvailable !== false && ["5.5", "7", "8", "10", "12", "14", "16", "18"].includes(wrSize);
      if (!isAvailable) {
        const text = await buildUnavailableSizeResponse(wrSize, carbonType || "normal", quantity);
        return { text, usedGPT: false };
      }
      const price = await pricingService.calculatePrice("wr", { size: wrSize, carbonType: carbonType || "normal" });
      return { text: buildWRResponse(price, quantity, askForSize), usedGPT: false };
    }

    if (category === "hb") {
      let price;
      let askForMm = false;
      const hbCarbon = carbonType || "normal";
      if (mm) {
        price = await pricingService.calculatePrice("hb", { mm, carbonType: hbCarbon });
      } else if (gauge) {
        price = await pricingService.calculatePrice("hb", { gauge, carbonType: hbCarbon });
        askForMm = true;
      } else {
        price = await pricingService.calculatePrice("hb", { gauge: "12", carbonType: hbCarbon });
        askForMm = true;
      }
      return { text: buildHBResponse(price, quantity, askForMm, mmRange), usedGPT: false };
    }

    // ── BINDING WIRE ────────────────────────────────────────────────
    // • User said just "binding" (no gauge)  → quote the default trio
    //   (18g + 20g + 20g-random, all without wrapper).
    // • User specified a gauge (18 / 20)     → single SKU quote, with
    //   wrapper / random honoured if present.
    if (category === "binding") {
      if (!gauge && !random) {
        const text = await buildBindingDefaultResponse();
        return { text, usedGPT: false };
      }
      try {
        const price = await pricingService.calculatePrice("binding", {
          gauge: String(gauge || "20"),
          packaging: packaging === "with" ? "with" : "without",
          random: Boolean(random),
        });
        return { text: buildBindingResponse(price, quantity), usedGPT: false };
      } catch (err) {
        // Specific SKU couldn't be priced (typically 20g random before admin
        // enters its basic). Do NOT fall back to the default trio — that
        // looks like we ignored what the customer asked for. Instead return
        // a targeted note about THAT SKU.
        logger.warn(`[BINDING] price calc failed: ${err.message}`);
        const pkgLabel = packaging === "with" ? "with wrapper"
                        : random ? "random"
                        : "without wrapper";
        const skuLabel = `Binding Wire ${gauge || "20"}g 25kg (${pkgLabel})`;
        let text = `${BRAND}\n\n*${skuLabel}*`;
        text += `\n_Rate update hona baki hai — thodi der me bhejte hain._`;
        return { text, usedGPT: false };
      }
    }

    // ── NAILS ──────────────────────────────────────────────────────
    // • User said just "nails" (no gauge + no inch) → default quote
    //   (8G 3" + 8G 4") and ask for gauge + inch.
    // • User gave gauge + inch → single SKU quote.
    // • User gave only inch OR only gauge → default quote (ambiguous,
    //   need both to price one specific SKU).
    if (category === "nails") {
      const nailsGauge = gauge ? String(gauge) : null;
      const nailsInch = inch ? String(inch) : null;
      // Bare "nails" (no gauge AND no inch) → default quote WITH the
      // available gauge × inch list so the customer can pick.
      if (!nailsGauge && !nailsInch) {
        const text = await buildNailsDefaultResponse();
        return { text, usedGPT: false };
      }
      // Customer gave ONLY gauge or ONLY inch → ask for the missing piece
      // (don't dump the whole default template — they already narrowed it).
      if (!nailsGauge || !nailsInch) {
        const valid = pricingService.getNailsAvailableCombos
          ? pricingService.getNailsAvailableCombos()
          : [];
        let text = `${BRAND}\n\n*Nails*`;
        if (nailsGauge && !nailsInch) {
          const sizes = valid.filter(c => c.gauge === nailsGauge).map(c => `${c.size}"`);
          text += `\n${nailsGauge}G me konsa inch chahiye?`;
          if (sizes.length) text += `\n_${nailsGauge}G available:_ ${sizes.join(" | ")}`;
        } else {
          const gauges = [...new Set(valid.filter(c => c.size === nailsInch).map(c => `${c.gauge}G`))];
          text += `\n${nailsInch}" me konsa gauge chahiye?`;
          if (gauges.length) text += `\n_${nailsInch}" available in:_ ${gauges.join(" | ")}`;
        }
        return { text, usedGPT: false };
      }
      try {
        const price = await pricingService.calculatePrice("nails", {
          gauge: nailsGauge,
          size: nailsInch,
        });
        return { text: buildNailsResponse(price, quantity), usedGPT: false };
      } catch (err) {
        // Targeted response — do NOT dump the full default template with
        // the "available gauge × inch" list. The customer asked for a
        // specific combo; respond about THAT combo only.
        logger.warn(`[NAILS] price calc failed: ${err.message}`);
        const label = `Nails ${nailsGauge}G ${nailsInch}"`;
        const valid = pricingService.getNailsAvailableCombos
          ? pricingService.getNailsAvailableCombos()
          : [];
        const comboValid = valid.some(c => c.gauge === nailsGauge && c.size === nailsInch);
        let text = `${BRAND}\n\n*${label}*`;
        if (!comboValid) {
          // Bad combo — suggest valid sizes for that gauge only.
          const sizes = valid.filter(c => c.gauge === nailsGauge).map(c => `${c.size}"`);
          text += `\nYe combination available nahi hai.`;
          if (sizes.length) {
            text += `\n_${nailsGauge}G available sizes:_ ${sizes.join(" | ")}`;
          } else {
            text += `\n_${nailsGauge}G hamare paas available nahi hai._`;
          }
        } else {
          // Valid combo, but pricing failed (typically nailsBasicRate not set).
          text += `\n_Rate update hona baki hai — thodi der me bhejte hain._`;
        }
        return { text, usedGPT: false };
      }
    }

    if (!category) {
      // Generic "rate" / "today's rate" / "aaj ka bhav" — no category in
      // the message. Quote WR 5.5mm + Binding 18g + Binding 20g (all
      // without wrapper) so the customer sees our mainline SKUs in one
      // reply.
      const text = await buildDefaultRatesResponse(quantity);
      return { text, usedGPT: false };
    }
  }

  if (intent === "order_confirm") {
    return { text: null, isOrderConfirm: true, escalateToAdmin: true };
  }

  return null;
};

module.exports = {
  buildWRResponse,
  buildHBResponse,
  buildBindingResponse,
  buildBindingDefaultResponse,
  buildNailsResponse,
  buildNailsDefaultResponse,
  buildUnavailableSizeResponse,
  buildMultiPriceResponse,
  buildOrderConfirmation,
  buildOrderPaymentSummary,
  buildMinQtyError,
  buildOrderQuantityAsk,
  buildQuantityAskForItems,
  buildGreeting,
  buildDefaultRatesResponse,
  buildDeliveryResponse,
  buildFromIntent,
  priceForItem,
  itemShortLabel,
  getTemplate,
  TEMPLATES,
  INR,
  BRAND,
  MIN_QTY_PER_ITEM,
  MIN_QTY_TOTAL,
  MIN_QTY_NAILS_PER_ITEM,
  ADVANCE_AMOUNT,
};
