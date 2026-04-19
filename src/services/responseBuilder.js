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
// Strip mm range from HB label: "HB Wire 5g (5.2-5.6mm)" → "HB Wire 5g"
// ──────────────────────────────────────────────
const shortLabel = (label) => label.replace(/\s*\([\d.]+-[\d.]+mm\)/, "");

// ──────────────────────────────────────────────
// Multi-product response
// userMmRanges[i] (optional) — user's exact mm range for HB items
// ──────────────────────────────────────────────
const buildMultiPriceResponse = (prices, quantities, userMmRanges = []) => {
  let msg = `${BRAND}`;
  let grandTotal = 0;

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const qty = quantities[i] || 0;
    const userRange = userMmRanges[i] || null;
    // Use user's range for HB when provided, else short label
    const label = (userRange && p && p.gauge)
      ? `HB Wire ${p.gauge}g (${userRange}mm)${p.carbonType === "lc" ? " LC" : ""}`
      : shortLabel(p.label);
    msg += `\n\n▸ *${label}*`;
    msg += `\n${INR(p.mergedBase)} + ${INR(p.fixedCharge)} + ${p.gstPercent}% GST = *${INR(p.total)}/ton*`;
    if (qty > 0) {
      const itemTotal = Math.round(p.total * qty);
      grandTotal += itemTotal;
      msg += `\n${qty} ton × ${INR(p.total)} = *${INR(itemTotal)}*`;
    }
  }

  if (grandTotal > 0) {
    msg += `\n\n─────────────────`;
    msg += `\n*Total: ${INR(grandTotal)}*`;
  }

  msg += `\n\n_Rate per ton (1000 kg) incl. GST_`;
  return msg;
};

// ──────────────────────────────────────────────
// Order Confirmation
// ──────────────────────────────────────────────
const MIN_QTY_PER_ITEM = 2;
const MIN_QTY_TOTAL = 5;
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
  let totalQty = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let price;
    try {
      if (item.category === "wr") {
        price = await pricingService.calculatePrice("wr", {
          size: item.size || "5.5",
          carbonType: item.carbonType || "normal",
        });
      } else if (item.category === "hb") {
        const hbCarbon = item.carbonType || "normal";
        if (item.mm) {
          price = await pricingService.calculatePrice("hb", { mm: item.mm, carbonType: hbCarbon });
        } else {
          price = await pricingService.calculatePrice("hb", { gauge: item.gauge || "12", carbonType: hbCarbon });
        }
      }
    } catch (err) {
      logger.warn(`[ORDER] Price calc failed for item ${i}: ${err.message}`);
      continue;
    }
    if (!price) continue;

    const qty = item.quantity || 0;
    const itemTotal = Math.round(price.total * qty);
    grandTotal += itemTotal;
    totalQty += qty;

    msg += `\n\n▸ *${buildItemLabel(item, price)}*`;
    msg += `\n${INR(price.mergedBase)} + ${INR(price.fixedCharge)} + ${price.gstPercent}% GST = *${INR(price.total)}/ton*`;
    if (qty > 0) {
      msg += `\n${qty} ton × ${INR(price.total)} = *${INR(itemTotal)}*`;
    }
  }

  msg += `\n\n─────────────────`;
  msg += `\n*Total: ${totalQty} ton — ${INR(grandTotal)}*`;

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

const buildMinQtyError = (items) => {
  const totalQty = items.reduce((sum, i) => sum + (i.quantity || 0), 0);

  let msg = `${BRAND}\n\n`;
  msg += `Order ke liye minimum quantity:\n`;
  msg += `▸ Har item: *${MIN_QTY_PER_ITEM} ton*\n`;
  msg += `▸ Total: *${MIN_QTY_TOTAL} ton*\n`;

  const itemErrors = items.filter((i) => (i.quantity || 0) < MIN_QTY_PER_ITEM);
  if (itemErrors.length > 0) {
    msg += `\n`;
    for (const item of itemErrors) {
      let label;
      if (item.category === "wr") label = `WR ${item.size || "5.5"}mm`;
      else if (item.mm) label = `HB ${item.mm}mm`;
      else label = `HB ${item.gauge || "12"}g`;
      msg += `${label}: ${item.quantity || 0}T (min ${MIN_QTY_PER_ITEM}T chahiye)\n`;
    }
  }

  if (totalQty < MIN_QTY_TOTAL) {
    msg += `\nTotal: ${totalQty}T (min ${MIN_QTY_TOTAL}T chahiye)`;
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

  let msg = `${BRAND}\n\nOrder book karne ke liye har size ke liye kitna ton chahiye, ye bataiye:\n`;
  for (const it of list) {
    msg += `\n▸ *${itemShortLabel(it)}* — ? ton`;
  }
  msg += `\n\n_Example: "8mm 3 ton, 10mm 2 ton book karo"_`;
  msg += `\n_Minimum ${MIN_QTY_PER_ITEM} ton per size, total ${MIN_QTY_TOTAL} ton._`;
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
// Template responses
// ──────────────────────────────────────────────
const buildGreeting = async () => {
  let msg = `${BRAND}\n\nNamaste! 🙏\n`;
  try {
    const wr = await pricingService.calculatePrice("wr", { size: "5.5", carbonType: "normal" });
    msg += `\n*WR 5.5mm*\n`;
    msg += `${INR(wr.mergedBase)} + ${INR(wr.fixedCharge)} + ${wr.gstPercent}% GST\n`;
    msg += `*${INR(wr.total)}/ton*\n`;
  } catch { /* skip */ }
  try {
    const hb = await pricingService.calculatePrice("hb", { gauge: "12" });
    msg += `\n*HB Wire 12g*\n`;
    msg += `${INR(hb.mergedBase)} + ${INR(hb.fixedCharge)} + ${hb.gstPercent}% GST\n`;
    msg += `*${INR(hb.total)}/ton*\n`;
  } catch { /* skip */ }
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
  const { intent, category, size, carbonType, quantity, gauge, mm, mmRange, sizeAvailable } = parsedIntent;

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

    if (!category) {
      const price = await pricingService.calculatePrice("wr", { size: "5.5", carbonType: "normal" });
      return { text: buildWRResponse(price, quantity, true), usedGPT: false };
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
  buildUnavailableSizeResponse,
  buildMultiPriceResponse,
  buildOrderConfirmation,
  buildOrderPaymentSummary,
  buildMinQtyError,
  buildOrderQuantityAsk,
  buildQuantityAskForItems,
  buildGreeting,
  buildDeliveryResponse,
  buildFromIntent,
  getTemplate,
  TEMPLATES,
  INR,
  BRAND,
  MIN_QTY_PER_ITEM,
  MIN_QTY_TOTAL,
  ADVANCE_AMOUNT,
};
