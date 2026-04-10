/**
 * Steel-domain intent parser for Hindi / Hinglish / English natural language.
 *
 * Extracts structured intent from messages like:
 *   "5.5 wr"            → { intent: "price_inquiry", category: "wr", size: "5.5" }
 *   "5.5 10 ton"        → { intent: "price_inquiry", category: "wr", size: "5.5", qty: 10, unit: "ton" }
 *   "5.5 10 mt lc"      → { intent: "price_inquiry", category: "wr", size: "5.5", qty: 10, unit: "ton", carbon: "lc" }
 *   "6 mm dia 5 ton"    → { intent: "price_inquiry", category: "wr", size: "6", sizeAvailable: false,
 *                           closestSizes: ["5.5", "7"], ... }
 *   "gadi nikli kya"    → { intent: "delivery_inquiry" }
 */

// ── The ONLY sizes Radhika Steels actually carries for WR ──
const AVAILABLE_WR_SIZES = ["5.5", "7", "8", "10", "12", "14", "16", "18"];

// Any size a user might type (including ones we don't carry)
const ALL_POSSIBLE_SIZES = [
  "3", "4", "4.5", "5", "5.5", "6", "6.5", "7", "8", "9", "10",
  "11", "12", "13", "14", "15", "16", "17", "18", "20", "22", "25",
];

// ── Category detection ──
const CATEGORY_PATTERNS = {
  wr: /\b(?:wr|w\.r\.?|wire\s*rod|wirerod|वायर\s*रॉड|तार|dia|diameter)\b/i,
  hb: /\b(?:hb|h\.b\.?|एचबी)\b/i,
  binding: /\b(?:binding|बाइंडिंग|बंधन)\b/i,
  nails: /\b(?:nail|nails|कील|किल)\b/i,
};

// ── Carbon type ──
const LC_PATTERN = /\b(?:lc|l\.c\.?|low\s*carbon|लो\s*कार्बन)\b/i;
const HC_PATTERN = /\b(?:hc|h\.c\.?|high\s*carbon|हाई\s*कार्बन)\b/i;

// ── Quantity + Unit ──
const QTY_REGEX = /\b(\d+(?:\.\d+)?)\s*(?:ton|tons|tonne|tonnes|mt|m\.t\.?|metric\s*ton|टन|मीट्रिक\s*टन|kg|किलो|bundle|bundles|बंडल|coil|coils|कॉइल)\b/i;
const UNIT_MAP = {
  ton: "ton", tons: "ton", tonne: "ton", tonnes: "ton",
  mt: "ton", "m.t": "ton", "m.t.": "ton", "metric ton": "ton",
  "टन": "ton", "मीट्रिक टन": "ton",
  kg: "kg", "किलो": "kg",
  bundle: "bundle", bundles: "bundle", "बंडल": "bundle",
  coil: "coil", coils: "coil", "कॉइल": "coil",
};

// ── Intent patterns ──
const INTENT_PATTERNS = {
  price_inquiry: [
    /\b(?:rate|rates|price|prices|cost|bhav|भाव|kitna|कितना|kya\s*rate|क्या\s*रेट|batao|बताओ|bata|बता|quote|quotation)\b/i,
    /\b(?:aaj\s*ka\s*rate|today.?s?\s*rate|current\s*rate|latest\s*rate)\b/i,
  ],
  order_confirm: [
    /\b(?:confirm|confirmed|book|booked|order\s*kar|finali[sz]e|pakka|पक्का|done|ok\s*book|le\s*lo|lelo|भेज\s*दो|bhej\s*do|daal\s*do|डाल\s*दो)\b/i,
  ],
  negotiation: [
    /\b(?:negotiat|discount|kam\s*kar|कम\s*कर|reduce|lower|best\s*price|thoda\s*kam|थोड़ा\s*कम|sahi\s*rate|सही\s*रेट|aur\s*kam|और\s*कम|kuch\s*kam|कुछ\s*कम|margin|concession)\b/i,
  ],
  delivery_inquiry: [
    /\b(?:gadi|गाड़ी|gaadi|vehicle|truck|dispatch|nikli|निकली|nikla|निकला|kab\s*tak|कब\s*तक|delivery|shipped|transport|माल|maal\s*nikla|status|tracking|pahunch|पहुंच)\b/i,
  ],
  greeting: [
    /^(?:hi|hello|hey|namaste|namaskar|नमस्ते|हेलो|good\s*morning|good\s*evening|good\s*afternoon)\s*[!.]?\s*$/i,
  ],
  thanks: [
    /\b(?:thank|thanks|shukriya|शुक्रिया|dhanyawad|धन्यवाद)\b/i,
  ],
};

// ── Gauge (for HB) ──
const GAUGE_REGEX = /\b(\d+)\s*(?:g|gauge|गेज)\b/i;

/**
 * Find the closest available WR sizes to a given size we don't carry.
 * Returns up to 2 sizes: the nearest smaller and nearest larger.
 */
function findClosestSizes(requestedSize) {
  const req = parseFloat(requestedSize);
  const available = AVAILABLE_WR_SIZES.map(Number).sort((a, b) => a - b);

  let lower = null;
  let upper = null;

  for (const s of available) {
    if (s < req) lower = s;
    if (s > req && upper === null) upper = s;
  }

  const result = [];
  if (lower !== null) result.push(String(lower));
  if (upper !== null) result.push(String(upper));
  return result;
}

/**
 * Parse a user message and extract structured intent + product details.
 */
function parse(text) {
  if (!text || typeof text !== "string") {
    return { intent: "unknown", raw: text || "" };
  }

  const raw = text.trim();
  const lower = raw.toLowerCase();

  const result = {
    intent: "unknown",
    raw,
    category: null,
    size: null,
    sizeAvailable: true,
    closestSizes: [],
    carbonType: "normal",
    quantity: null,
    unit: null,
    gauge: null,
  };

  // 1. Detect intent
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(lower)) {
        result.intent = intent;
        break;
      }
    }
    if (result.intent !== "unknown") break;
  }

  // 2. Detect category
  for (const [cat, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(lower)) {
      result.category = cat;
      break;
    }
  }

  // 3. Detect carbon type
  if (LC_PATTERN.test(lower)) {
    result.carbonType = "lc";
  } else if (HC_PATTERN.test(lower)) {
    result.carbonType = "normal";
  }

  // 4. Extract all numbers
  const allNumbers = [];
  let match;
  const numRegex = /(\d+(?:\.\d+)?)/g;
  while ((match = numRegex.exec(lower)) !== null) {
    allNumbers.push({ value: match[1], index: match.index });
  }

  // 5. Extract quantity with unit
  const qtyMatch = QTY_REGEX.exec(lower);
  if (qtyMatch) {
    result.quantity = parseFloat(qtyMatch[1]);
    const unitRaw = qtyMatch[0].replace(qtyMatch[1], "").trim().toLowerCase();
    for (const [key, val] of Object.entries(UNIT_MAP)) {
      if (unitRaw.includes(key)) {
        result.unit = val;
        break;
      }
    }
    if (!result.unit) result.unit = "ton";
  }

  // 6. Extract gauge (for HB)
  const gaugeMatch = GAUGE_REGEX.exec(lower);
  if (gaugeMatch) {
    result.gauge = gaugeMatch[1];
    if (!result.category) result.category = "hb";
  }

  // 7. Extract size — pick the first number that looks like a steel size
  for (const num of allNumbers) {
    const val = num.value;
    if (result.quantity && parseFloat(val) === result.quantity) continue;

    const asFloat = parseFloat(val);
    // Sizes are typically between 3 and 30mm
    if (asFloat >= 3 && asFloat <= 30) {
      result.size = val;

      // Check if this is a size we actually carry
      if (AVAILABLE_WR_SIZES.includes(val)) {
        result.sizeAvailable = true;
      } else {
        result.sizeAvailable = false;
        result.closestSizes = findClosestSizes(val);
      }
      break;
    }
  }

  // 8. If we found size or category but intent is still unknown, it's a price inquiry
  if (result.intent === "unknown" && (result.size || result.category)) {
    result.intent = "price_inquiry";
  }

  // 9. Default category to WR
  if (result.size && !result.category) {
    result.category = "wr";
  }

  // 10. Disambiguate quantity from bare numbers (e.g. "5.5 10" → size=5.5, qty=10)
  if (result.size && !result.quantity && allNumbers.length >= 2) {
    for (const num of allNumbers) {
      if (num.value !== result.size) {
        const potentialQty = parseFloat(num.value);
        if (potentialQty > 0 && potentialQty <= 1000) {
          result.quantity = potentialQty;
          if (!result.unit) result.unit = "ton";
          break;
        }
      }
    }
  }

  return result;
}

/**
 * Map parsed intent to a conversation pipeline stage.
 */
function intentToStage(intent) {
  const map = {
    price_inquiry: "price_inquiry",
    negotiation: "negotiation",
    order_confirm: "order_confirmed",
    delivery_inquiry: null,
    greeting: null,
    thanks: null,
    unknown: null,
  };
  return map[intent] || null;
}

module.exports = { parse, intentToStage, findClosestSizes, AVAILABLE_WR_SIZES };
