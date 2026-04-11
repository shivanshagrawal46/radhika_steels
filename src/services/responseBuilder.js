const pricingService = require("./pricingService");
const logger = require("../config/logger");

const INR = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const BRAND = "*Radhika Steel Raipur*";

// ──────────────────────────────────────────────
// WR Price Response
// ──────────────────────────────────────────────
const buildWRResponse = (price, quantity) => {
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
// ──────────────────────────────────────────────
const buildHBResponse = (price, quantity, askForMm = false) => {
  let msg = `${BRAND}\n\n`;
  msg += `*${price.label}*\n`;
  msg += `${INR(price.mergedBase)} + ${INR(price.fixedCharge)} + ${price.gstPercent}% GST\n`;
  msg += `*${INR(price.total)}/ton*`;

  if (quantity && quantity > 0) {
    const grandTotal = Math.round(price.total * quantity);
    msg += `\n\n${quantity} ton × ${INR(price.total)} = *${INR(grandTotal)}*`;
  }

  if (askForMm && price.mmRange) {
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
// Multi-product response
// ──────────────────────────────────────────────
const buildMultiPriceResponse = (prices, quantities) => {
  let msg = `${BRAND}\n`;
  let grandTotal = 0;

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const qty = quantities[i] || 0;
    msg += `\n▸ *${p.label}* — *${INR(p.total)}/ton*`;
    if (qty > 0) {
      const itemTotal = Math.round(p.total * qty);
      grandTotal += itemTotal;
      msg += `\n   ${qty}T × ${INR(p.total)} = *${INR(itemTotal)}*`;
    }
  }

  if (grandTotal > 0) {
    msg += `\n\n*Total: ${INR(grandTotal)}*`;
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

const buildOrderConfirmation = async (items) => {
  let msg = `${BRAND}\n`;
  msg += `✅ *Order Confirmed*\n`;

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

    msg += `\n▸ *${price.label}*`;
    msg += `\n   ${INR(price.total)}/ton × ${qty}T = *${INR(itemTotal)}*`;
  }

  msg += `\n\n*Total: ${totalQty} ton — ${INR(grandTotal)}*`;

  msg += `\n\n*Payment:*`;
  msg += `\n▸ Advance: *${INR(ADVANCE_AMOUNT)}* (booking ke liye)`;
  msg += `\n▸ Balance: *${INR(Math.max(0, grandTotal - ADVANCE_AMOUNT))}* (loading pe)`;
  msg += `\n▸ Transport: Aapki taraf se`;

  msg += `\n\n✅ Advance milte hi dispatch schedule hoga.`;
  msg += `\n🙏 Dhanyawad!`;

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
      const label = item.category === "wr" ? `WR ${item.size || "5.5"}mm` : `HB ${item.gauge || "12"}g`;
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
// Template responses
// ──────────────────────────────────────────────
const TEMPLATES = {
  greeting: `${BRAND}\n\nNamaste! 🙏\nAap kis product ka rate chahiye?\n\n*WR:* 5.5 | 7 | 8 | 10 | 12 | 14 | 16 | 18mm\n*HB:* 6g se 14g, 1/0 se 6/0\n\n_Size bataiye, rate turant milega._`,

  thanks: `${BRAND}\n\nDhanyawad! 🙏\nKoi aur madad chahiye toh batayein.`,

  negotiation: `${BRAND}\n\nAapki baat team tak pahuncha dete hain. Best rate ke saath jaldi reply milega. 🙏`,

  delivery_inquiry: `${BRAND}\n\nDelivery status check karke batate hain. Thodi der mein update milega.`,

  admin_escalation: `${BRAND}\n\nAapka sawaal team ke paas bhej diya hai. Jaldi reply aayega. 🙏`,

  order_confirm_ask: `${BRAND}\n\nOrder confirm karne ke liye batayein:\n\n▸ Quantity (kitna ton)\n▸ Delivery location\n▸ Firm name / GST no.\n\n_Details milte hi process karenge._`,
};

const getTemplate = (key) => TEMPLATES[key] || null;

// ──────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────
const buildFromIntent = async (parsedIntent) => {
  const { intent, category, size, carbonType, quantity, gauge, mm, sizeAvailable } = parsedIntent;

  if (intent === "greeting") return { text: TEMPLATES.greeting, usedGPT: false };
  if (intent === "thanks") return { text: TEMPLATES.thanks, usedGPT: false };
  if (intent === "negotiation") return { text: TEMPLATES.negotiation, usedGPT: false, escalateToAdmin: true };
  if (intent === "delivery_inquiry") return { text: TEMPLATES.delivery_inquiry, usedGPT: false, escalateToAdmin: true };

  if (intent === "price_inquiry" || intent === "follow_up") {
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
  BRAND,
  MIN_QTY_PER_ITEM,
  MIN_QTY_TOTAL,
  ADVANCE_AMOUNT,
};
