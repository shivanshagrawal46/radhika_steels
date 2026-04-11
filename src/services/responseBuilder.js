const pricingService = require("./pricingService");
const logger = require("../config/logger");

const INR = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const HEADER = "━━━━━━━━━━━━━━━━━━━━━\n  *RADHIKA STEEL RAIPUR*\n━━━━━━━━━━━━━━━━━━━━━\n";
const DIVIDER = "─────────────────────";
const FOOTER = "\n_All rates per ton (1000 kg) inclusive of GST_";

// ──────────────────────────────────────────────
// WR Price Response
// ──────────────────────────────────────────────
const buildWRResponse = (price, quantity) => {
  const lines = [HEADER];
  lines.push(`📦 *${price.label}*`);
  lines.push(DIVIDER);
  lines.push(`  Base Rate:  ${INR(price.mergedBase)}`);
  lines.push(`  Fixed:         + ${INR(price.fixedCharge)}`);
  lines.push(`  GST (${price.gstPercent}%):  + ${INR(price.gst)}`);
  lines.push(DIVIDER);
  lines.push(`  💰 *Rate: ${INR(price.total)}/ton*`);

  if (quantity && quantity > 0) {
    const grandTotal = Math.round(price.total * quantity);
    lines.push("");
    lines.push(`📋 *${quantity} Ton Order:*`);
    lines.push(`  ${quantity} × ${INR(price.total)} = *${INR(grandTotal)}*`);
  }

  lines.push(FOOTER);
  return lines.join("\n");
};

// ──────────────────────────────────────────────
// Build 0.1mm sub-ranges for a gauge (e.g. 5g → "5.2 se 5.3mm | 5.3 se 5.4mm | 5.4 se 5.5mm")
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
// HB Price Response — includes mm sub-ranges + asks for exact mm range
// ──────────────────────────────────────────────
const buildHBResponse = (price, quantity, askForMm = false) => {
  const lines = [HEADER];
  lines.push(`📦 *${price.label}*`);
  lines.push(DIVIDER);
  lines.push(`  Base Rate:  ${INR(price.mergedBase)}`);
  lines.push(`  Fixed:         + ${INR(price.fixedCharge)}`);
  lines.push(`  GST (${price.gstPercent}%):  + ${INR(price.gst)}`);
  lines.push(DIVIDER);
  lines.push(`  💰 *Rate: ${INR(price.total)}/ton*`);

  if (quantity && quantity > 0) {
    const grandTotal = Math.round(price.total * quantity);
    lines.push("");
    lines.push(`📋 *${quantity} Ton Order:*`);
    lines.push(`  ${quantity} × ${INR(price.total)} = *${INR(grandTotal)}*`);
  }

  if (askForMm && price.mmRange) {
    const subRanges = buildMmSubRanges(price.mmRange);
    lines.push("");
    lines.push(`📏 *${price.gauge}g available sizes:*`);
    subRanges.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
    lines.push("");
    lines.push(`_Aapko kaunsa mm range chahiye? Bataiye._`);
  }

  lines.push(FOOTER);
  return lines.join("\n");
};

// ──────────────────────────────────────────────
// Unavailable WR size — suggest closest
// ──────────────────────────────────────────────
const buildUnavailableSizeResponse = async (size, carbonType, quantity) => {
  const available = ["5.5", "7", "8", "10", "12", "14", "16", "18"];
  const req = parseFloat(size);
  let lower = null, upper = null;
  for (const s of available.map(Number).sort((a, b) => a - b)) {
    if (s < req) lower = s;
    if (s > req && upper === null) upper = s;
  }

  const lines = [HEADER];
  lines.push(`⚠️ *WR ${size}mm available nahi hai*`);
  lines.push("");
  lines.push("Nearest sizes:");

  const suggestions = [];
  if (lower !== null) suggestions.push(String(lower));
  if (upper !== null) suggestions.push(String(upper));

  for (const s of suggestions) {
    try {
      const p = await pricingService.calculatePrice("wr", { size: s, carbonType });
      lines.push("");
      lines.push(`📦 *WR ${s}mm${carbonType === "lc" ? " LC" : ""}*`);
      lines.push(`  ${INR(p.mergedBase)} + ${INR(p.fixedCharge)} + ${p.gstPercent}% GST`);
      lines.push(`  💰 *Rate: ${INR(p.total)}/ton*`);
      if (quantity && quantity > 0) {
        lines.push(`  ${quantity} ton = *${INR(Math.round(p.total * quantity))}*`);
      }
    } catch { /* skip */ }
  }

  lines.push("");
  lines.push("_Kaunsa size chahiye? Bataiye._");
  lines.push(FOOTER);
  return lines.join("\n");
};

// ──────────────────────────────────────────────
// Multi-product response
// ──────────────────────────────────────────────
const buildMultiPriceResponse = (prices, quantities) => {
  const lines = [HEADER];
  let grandTotal = 0;

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const qty = quantities[i] || 0;
    lines.push(`📦 *${p.label}*`);
    lines.push(`  ${INR(p.mergedBase)} + ${INR(p.fixedCharge)} + ${p.gstPercent}% GST`);
    lines.push(`  💰 *Rate: ${INR(p.total)}/ton*`);
    if (qty > 0) {
      const itemTotal = Math.round(p.total * qty);
      grandTotal += itemTotal;
      lines.push(`  ${qty} ton = *${INR(itemTotal)}*`);
    }
    lines.push("");
  }

  if (grandTotal > 0) {
    lines.push(DIVIDER);
    lines.push(`💰 *Grand Total: ${INR(grandTotal)}*`);
  }

  lines.push(FOOTER);
  return lines.join("\n");
};

// ──────────────────────────────────────────────
// Order Confirmation Response — professional with full breakdown
// ──────────────────────────────────────────────
const MIN_QTY_PER_ITEM = 2;
const MIN_QTY_TOTAL = 5;
const ADVANCE_AMOUNT = 50000;

const buildOrderConfirmation = async (items) => {
  const lines = [];
  lines.push("━━━━━━━━━━━━━━━━━━━━━");
  lines.push("  ✅ *RADHIKA STEEL RAIPUR*");
  lines.push("  ✅ *ORDER CONFIRMED*");
  lines.push("━━━━━━━━━━━━━━━━━━━━━\n");

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
        if (item.mm) {
          price = await pricingService.calculatePrice("hb", { mm: item.mm });
        } else {
          price = await pricingService.calculatePrice("hb", { gauge: item.gauge || "12" });
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

    lines.push(`${i + 1}️⃣ *${price.label}*`);
    lines.push(`   Rate: ${INR(price.total)}/ton`);
    lines.push(`   Qty:  ${qty} ton`);
    lines.push(`   ✅ Amount: *${INR(itemTotal)}*`);
    lines.push("");
  }

  lines.push(DIVIDER);
  lines.push(`📦 Total Quantity: *${totalQty} ton*`);
  lines.push(`💰 *Grand Total: ${INR(grandTotal)}*`);
  lines.push(DIVIDER);

  lines.push("");
  lines.push("💳 *Payment Terms:*");
  lines.push(`   🔹 Advance: *${INR(ADVANCE_AMOUNT)}* (booking)`);
  lines.push(`   🔹 Balance: *${INR(Math.max(0, grandTotal - ADVANCE_AMOUNT))}* (at loading)`);
  lines.push("");
  lines.push("🚚 *Transport: By your side*");

  lines.push("");
  lines.push(DIVIDER);
  lines.push("✅ _Order book ho gaya hai._");
  lines.push("✅ _Advance milte hi dispatch schedule hoga._");
  lines.push("🙏 _Dhanyawad! Radhika Steel Raipur_");

  return lines.join("\n");
};

const buildMinQtyError = (items) => {
  const lines = [HEADER];
  const totalQty = items.reduce((sum, i) => sum + (i.quantity || 0), 0);

  lines.push("⚠️ *Minimum Quantity Required*\n");

  const itemErrors = items.filter((i) => (i.quantity || 0) < MIN_QTY_PER_ITEM);
  if (itemErrors.length > 0) {
    lines.push(`🔸 Har item minimum *${MIN_QTY_PER_ITEM} ton* hona chahiye.`);
    for (const item of itemErrors) {
      const label = item.category === "wr" ? `WR ${item.size || "5.5"}mm` : `HB ${item.gauge || "12"}g`;
      lines.push(`   ${label}: ${item.quantity || 0} ton ❌`);
    }
    lines.push("");
  }

  if (totalQty < MIN_QTY_TOTAL) {
    lines.push(`🔸 Total quantity minimum *${MIN_QTY_TOTAL} ton* honi chahiye.`);
    lines.push(`   Current total: ${totalQty} ton ❌`);
    lines.push("");
  }

  lines.push("_Please quantity badhayein aur phir confirm karein._");
  return lines.join("\n");
};

// ──────────────────────────────────────────────
// Template responses (zero GPT cost)
// ──────────────────────────────────────────────
const TEMPLATES = {
  greeting: `${HEADER}Namaste! 🙏

Main Radhika Steel ka AI assistant hoon.
Aap kis product ka rate jaanna chahenge?

*Wire Rod (WR):*
5.5mm | 7mm | 8mm | 10mm | 12mm | 14mm | 16mm | 18mm

*HB Wire:*
6g se 14g | 1/0 se 6/0

_Size ya gauge bataiye, rate turant milega._`,

  thanks: `${HEADER}Dhanyawad! 🙏\nKoi aur madad chahiye toh zaroor batayein.`,

  negotiation: `${HEADER}Aapki baat team tak pahunchate hain. Thodi der mein best rate ke saath reply milega. 🙏`,

  delivery_inquiry: `${HEADER}Delivery status check karke batate hain. Thodi der mein update milega. 🚚`,

  admin_escalation: `${HEADER}Aapka sawaal team ke paas bhej diya hai. Jaldi se reply aayega. 🙏`,

  order_confirm_ask: `${HEADER}Order confirm karne ke liye ye details batayein:\n\n1️⃣ Quantity (kitna ton)\n2️⃣ Delivery location\n3️⃣ Firm name / GST number\n\n_Details milte hi order process karenge._`,
};

const getTemplate = (key) => TEMPLATES[key] || null;

// ──────────────────────────────────────────────
// Main entry: build response from parsed intent
// ──────────────────────────────────────────────
const buildFromIntent = async (parsedIntent) => {
  const { intent, category, size, carbonType, quantity, gauge, mm, sizeAvailable } = parsedIntent;

  if (intent === "greeting") return { text: TEMPLATES.greeting, usedGPT: false };
  if (intent === "thanks") return { text: TEMPLATES.thanks, usedGPT: false };
  if (intent === "negotiation") return { text: TEMPLATES.negotiation, usedGPT: false, escalateToAdmin: true };
  if (intent === "delivery_inquiry") return { text: TEMPLATES.delivery_inquiry, usedGPT: false, escalateToAdmin: true };

  if (intent === "price_inquiry" || intent === "follow_up") {
    // WR pricing
    if (category === "wr") {
      const wrSize = size || "5.5";
      const isAvailable = sizeAvailable !== false && ["5.5", "7", "8", "10", "12", "14", "16", "18"].includes(wrSize);

      if (!isAvailable) {
        const text = await buildUnavailableSizeResponse(wrSize, carbonType || "normal", quantity);
        return { text, usedGPT: false };
      }
      try {
        const price = await pricingService.calculatePrice("wr", { size: wrSize, carbonType: carbonType || "normal" });
        return { text: buildWRResponse(price, quantity), usedGPT: false };
      } catch (err) {
        logger.warn(`[RESPONSE] WR calc failed: ${err.message}`);
        return null;
      }
    }

    // HB pricing
    if (category === "hb") {
      try {
        let price;
        let askForMm = false;

        if (mm) {
          price = await pricingService.calculatePrice("hb", { mm });
        } else if (gauge) {
          price = await pricingService.calculatePrice("hb", { gauge });
          askForMm = true;
        } else {
          price = await pricingService.calculatePrice("hb", { gauge: "12" });
          askForMm = true;
        }

        return { text: buildHBResponse(price, quantity, askForMm), usedGPT: false };
      } catch (err) {
        logger.warn(`[RESPONSE] HB calc failed: ${err.message}`);
        return null;
      }
    }

    // Category not specified but we have price inquiry — default to WR 5.5mm
    if (!category) {
      try {
        const price = await pricingService.calculatePrice("wr", { size: "5.5", carbonType: "normal" });
        return { text: buildWRResponse(price, quantity), usedGPT: false };
      } catch (err) {
        logger.warn(`[RESPONSE] Default WR calc failed: ${err.message}`);
        return null;
      }
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
  buildMinQtyError,
  buildFromIntent,
  getTemplate,
  TEMPLATES,
  INR,
  HEADER,
  MIN_QTY_PER_ITEM,
  MIN_QTY_TOTAL,
  ADVANCE_AMOUNT,
};
