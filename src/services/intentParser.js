/**
 * Steel-domain intent parser — Hindi / Hinglish / English.
 *
 * Handles WR sizes, HB gauges, HB mm sizes, quantities, carbon types.
 * Returns structured intent that responseBuilder can use directly.
 */

const AVAILABLE_WR_SIZES = ["5.5", "7", "8", "10", "12", "14", "16", "18"];

const HB_MM_RANGES = [
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
  "13", "14",
];

// ── Patterns ──
const CATEGORY_PATTERNS = {
  wr: /\b(?:wr|w\.r\.?|wire\s*rod|wirerod|वायर\s*रॉड|तार)\b/i,
  hb: /\b(?:hb|h\.b\.?|hb\s*wire|एचबी)\b/i,
  binding: /\b(?:binding|बाइंडिंग|बंधन)\b/i,
  nails: /\b(?:nail|nails|कील|किल)\b/i,
};

const LC_PATTERN = /\b(?:lc|l\.c\.?|low\s*carbon|लो\s*कार्बन)\b/i;
const QTY_REGEX = /\b(\d+(?:\.\d+)?)\s*(?:ton|tons|tonne|tonnes|mt|m\.t\.?|metric\s*ton|टन|मीट्रिक\s*टन|kg|किलो|bundle|bundles|बंडल|coil|coils|कॉइल)\b/i;
const UNIT_MAP = {
  ton: "ton", tons: "ton", tonne: "ton", tonnes: "ton",
  mt: "ton", "m.t": "ton", "m.t.": "ton", "metric ton": "ton",
  "टन": "ton", "मीट्रिक टन": "ton",
  kg: "kg", "किलो": "kg",
  bundle: "bundle", bundles: "bundle", "बंडल": "bundle",
  coil: "coil", coils: "coil", "कॉइल": "coil",
};

// Gauge patterns: "12g", "12 gauge", "3/0g", "3/0 gauge"
const GAUGE_REGEX = /\b(\d\/0|\d+)\s*(?:g|gauge|गेज)\b/i;
// Slash gauge: "3/0", "4/0" etc. when standalone
const SLASH_GAUGE_REGEX = /\b([1-6]\/0)\b/;

// "se" pattern for mm ranges: "5.3 se 5.4 mm", "6.8 se 6.9"
const MM_RANGE_REGEX = /(\d+(?:\.\d+)?)\s*(?:se|to|-|–)\s*(\d+(?:\.\d+)?)\s*(?:mm|मिमी)?\b/i;
// "dia" or "mm" patterns for HB mm size: "5.3mm", "5.3 mm", "5.3 dia"
const MM_SINGLE_REGEX = /(\d+\.\d+)\s*(?:mm|dia|diameter|मिमी)/i;

const INTENT_PATTERNS = {
  price_inquiry: [
    /\b(?:rate|rates|price|prices|cost|bhav|भाव|kitna|कितना|kya\s*rate|क्या\s*रेट|batao|बताओ|bata|बता|quote|quotation)\b/i,
    /\b(?:aaj\s*ka\s*rate|today.?s?\s*rate|current\s*rate|latest\s*rate|new\s*rate)\b/i,
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
    /\b(?:thank|thanks|shukriya|शुक्रिया|dhanyawad|धन्यवाद|ok\s*thanks|theek\s*hai)\b/i,
  ],
};

function findClosestWRSizes(requestedSize) {
  const req = parseFloat(requestedSize);
  const available = AVAILABLE_WR_SIZES.map(Number).sort((a, b) => a - b);
  let lower = null, upper = null;
  for (const s of available) {
    if (s < req) lower = s;
    if (s > req && upper === null) upper = s;
  }
  const result = [];
  if (lower !== null) result.push(String(lower));
  if (upper !== null) result.push(String(upper));
  return result;
}

function mmToGauge(mm) {
  const val = parseFloat(mm);
  if (isNaN(val)) return null;
  for (const row of HB_MM_RANGES) {
    if (val >= row.minMm && val <= row.maxMm) return row.gauge;
  }
  let closest = null, minDist = Infinity;
  for (const row of HB_MM_RANGES) {
    const mid = (row.minMm + row.maxMm) / 2;
    const dist = Math.abs(val - mid);
    if (dist < minDist) { minDist = dist; closest = row.gauge; }
  }
  return closest;
}

function isHBMmRange(mm) {
  const val = parseFloat(mm);
  return val >= 1.5 && val <= 12.0;
}

function isWRSize(size) {
  const val = parseFloat(size);
  return val >= 3 && val <= 30;
}

// ──────────────────────────────────────────────
// Main parse function
// ──────────────────────────────────────────────
function parse(text) {
  if (!text || typeof text !== "string") {
    return { intent: "unknown", raw: text || "", confidence: 0 };
  }

  const raw = text.trim();
  const lower = raw.toLowerCase();

  const result = {
    intent: "unknown",
    raw,
    confidence: 0,
    category: null,
    size: null,
    sizeAvailable: true,
    closestSizes: [],
    carbonType: "normal",
    quantity: null,
    unit: null,
    gauge: null,
    mm: null,
  };

  // 1. Detect intent from patterns
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(lower)) {
        result.intent = intent;
        result.confidence = 0.9;
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

  // 3. Carbon type
  if (LC_PATTERN.test(lower)) result.carbonType = "lc";

  // 4. Detect HB gauge explicitly: "12g", "3/0g", "3/0 gauge"
  const gaugeMatch = GAUGE_REGEX.exec(lower);
  if (gaugeMatch) {
    result.gauge = gaugeMatch[1];
    if (!result.category) result.category = "hb";
    result.confidence = Math.max(result.confidence, 0.95);
  }
  if (!result.gauge) {
    const slashMatch = SLASH_GAUGE_REGEX.exec(lower);
    if (slashMatch) {
      result.gauge = slashMatch[1];
      if (!result.category) result.category = "hb";
      result.confidence = Math.max(result.confidence, 0.9);
    }
  }

  // 5. Detect HB mm range: "5.3 se 5.4 mm"
  const mmRangeMatch = MM_RANGE_REGEX.exec(lower);
  if (mmRangeMatch) {
    const mm1 = parseFloat(mmRangeMatch[1]);
    const mm2 = parseFloat(mmRangeMatch[2]);
    const avgMm = (mm1 + mm2) / 2;
    if (isHBMmRange(avgMm)) {
      result.mm = String(avgMm);
      result.gauge = mmToGauge(avgMm);
      if (!result.category) result.category = "hb";
      result.confidence = Math.max(result.confidence, 0.95);
    }
  }

  // 6. Detect single mm for HB: "5.3mm", "5.3 dia"
  if (!result.mm && !result.gauge) {
    const mmSingle = MM_SINGLE_REGEX.exec(lower);
    if (mmSingle) {
      const mmVal = parseFloat(mmSingle[1]);
      if (isHBMmRange(mmVal) && !AVAILABLE_WR_SIZES.includes(mmSingle[1])) {
        result.mm = mmSingle[1];
        result.gauge = mmToGauge(mmVal);
        if (!result.category) result.category = "hb";
        result.confidence = Math.max(result.confidence, 0.85);
      }
    }
  }

  // 7. Quantity + unit
  const qtyMatch = QTY_REGEX.exec(lower);
  if (qtyMatch) {
    result.quantity = parseFloat(qtyMatch[1]);
    const unitRaw = qtyMatch[0].replace(qtyMatch[1], "").trim().toLowerCase();
    for (const [key, val] of Object.entries(UNIT_MAP)) {
      if (unitRaw.includes(key)) { result.unit = val; break; }
    }
    if (!result.unit) result.unit = "ton";
  }

  // 8. Extract numbers for WR size detection
  if (!result.gauge && !result.mm) {
    const allNumbers = [];
    let match;
    const numRegex = /(\d+(?:\.\d+)?)/g;
    while ((match = numRegex.exec(lower)) !== null) {
      allNumbers.push({ value: match[1], index: match.index });
    }

    for (const num of allNumbers) {
      if (result.quantity && parseFloat(num.value) === result.quantity) continue;
      const asFloat = parseFloat(num.value);

      if (isWRSize(asFloat)) {
        result.size = num.value;
        if (AVAILABLE_WR_SIZES.includes(num.value)) {
          result.sizeAvailable = true;
        } else {
          result.sizeAvailable = false;
          result.closestSizes = findClosestWRSizes(num.value);
        }
        if (!result.category) result.category = "wr";
        result.confidence = Math.max(result.confidence, 0.85);
        break;
      }
    }

    // Disambiguate quantity from bare numbers: "5.5 10" → size=5.5, qty=10
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
  }

  // 9. If product detected but intent still unknown → price inquiry
  if (result.intent === "unknown" && (result.size || result.category || result.gauge || result.mm)) {
    result.intent = "price_inquiry";
    result.confidence = Math.max(result.confidence, 0.8);
  }

  // 10. Detect very short messages that might be follow-ups
  if (result.intent === "unknown" && raw.length <= 3) {
    const c = raw.trim();
    if (c === "?" || c === "." || c === "rate" || c === "Rate") {
      result.intent = "follow_up";
      result.confidence = 0.7;
    }
  }

  return result;
}

function intentToStage(intent) {
  const map = {
    price_inquiry: "price_inquiry",
    negotiation: "negotiation",
    order_confirm: "order_confirmed",
    follow_up: null,
    delivery_inquiry: null,
    greeting: null,
    thanks: null,
    unknown: null,
  };
  return map[intent] || null;
}

module.exports = {
  parse,
  intentToStage,
  findClosestWRSizes,
  mmToGauge,
  AVAILABLE_WR_SIZES,
  ALL_HB_GAUGES,
  HB_MM_RANGES,
};
