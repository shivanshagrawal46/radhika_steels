/**
 * Steel-domain intent parser — Hindi / Hinglish / English.
 *
 * Handles WR sizes, HB gauges, HB mm sizes, quantities, carbon types.
 * Returns structured intent that responseBuilder can use directly.
 */

const AVAILABLE_WR_SIZES = ["5.5", "7", "8", "10", "12", "14", "16", "18"];

// ── Binding wire — only two gauges sold in our domain. Whenever we see "18g"
// or "20g" we treat the message as binding (HB doesn't have these gauges).
const BINDING_GAUGES = ["18", "20"];

// ── Nails — every (gauge, inch) combination we sell. Mirrors NAILS_PREMIUMS
// in pricingService; duplicated here so the parser doesn't depend on the
// pricing layer.
const NAILS_GAUGE_SIZE_MAP = {
  "8":  ["1", "1.5", "2", "2.5", "3", "4"],
  "9":  ["2", "2.5", "3"],
  "10": ["2", "2.5", "3"],
  "11": ["1.5", "2", "2.5"],
  "13": ["1", "1.5", "2"],
  "6":  ["2.5", "3", "4", "5", "6"],
};
const NAILS_GAUGES = Object.keys(NAILS_GAUGE_SIZE_MAP);
const NAILS_DEFAULT_GAUGE = "8";
const NAILS_DEFAULT_SIZES = ["3", "4"];

function isNailsCombo(gauge, size) {
  const arr = NAILS_GAUGE_SIZE_MAP[String(gauge)];
  return Array.isArray(arr) && arr.includes(String(size));
}

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
  "13", "14", "15", "16",
];

// ── Patterns ──
const CATEGORY_PATTERNS = {
  wr: /(?:^|[\s,.])(wr|w\.r\.?|wire\s*rod|wirerod|वायर\s*रॉड|तार)(?:$|[\s,.])/i,
  hb: /(?:^|[\s,.])(hb|h\.b\.?|hb\s*wire|एचबी)(?:$|[\s,.])/i,
  binding: /(?:^|[\s,.,?!])(binding\s*wire|binding|bw|बाइंडिंग|बंधन)(?:$|[\s,.,?!])/i,
  nails: /(?:^|[\s,.,?!])(nails?|कील|किल|कील्स)(?:$|[\s,.,?!])/i,
};

const LC_PATTERN = /(?:^|[\s,.])(lc|l\.c\.?|low\s*carbon|लो\s*कार्बन)(?:$|[\s,.])/i;
const QTY_REGEX = /\b(\d+(?:\.\d+)?)\s*(?:ton|tons|tonne|tonnes|mt|mts|m\.t\.?|metric\s*ton|metric\s*tons|टन|मीट्रिक\s*टन|kg|kgs|किलो|bundle|bundles|बंडल|coil|coils|कॉइल)\b/i;
const UNIT_MAP = {
  ton: "ton", tons: "ton", tonne: "ton", tonnes: "ton",
  mt: "ton", mts: "ton", "m.t": "ton", "m.t.": "ton",
  "metric ton": "ton", "metric tons": "ton",
  "टन": "ton", "मीट्रिक टन": "ton",
  kg: "kg", kgs: "kg", "किलो": "kg",
  bundle: "bundle", bundles: "bundle", "बंडल": "bundle",
  coil: "coil", coils: "coil", "कॉइल": "coil",
};

// Gauge patterns: "12g", "12 gauge", "3/0g", "3/0 gauge"
const GAUGE_REGEX = /\b(\d\/0|\d+)\s*(?:g|gauge|गेज)\b/i;
// Slash gauge: "3/0", "4/0" etc. when standalone
const SLASH_GAUGE_REGEX = /\b([1-6]\/0)\b/;

// ── BINDING WIRE specific ──
// "18g" / "20g" tokens — strong, unambiguous signal of binding wire.
// HB never goes above gauge 16, so any 18g/20g is binding.
const BINDING_GAUGE_REGEX = /\b(18|20)\s*(?:g|gauge|गेज)\b/i;
// Wrapper / packaging — synonyms: wrapper, packaging, packing, packed.
// Default is "without wrapper" if customer doesn't say one of these.
const BINDING_WITH_WRAPPER_REGEX =
  /\bwith\s*(?:wrapper|wrappers|packaging|packing|pack(?:ed)?)\b|\bpacked\b|\bpackaging\s*(?:wala|वाला)\b|\bwrapper\s*(?:wala|वाला)\b/i;
const BINDING_WITHOUT_WRAPPER_REGEX =
  /\bwithout\s*(?:wrapper|wrappers|packaging|packing|pack(?:ed)?)\b|\bbina\s*(?:wrapper|packing|packaging)\b|\bloose\b|\bno\s*(?:wrapper|packaging|packing)\b/i;
const BINDING_RANDOM_REGEX = /\b(random|रैंडम|रंडम)\b/i;

// ── NAILS specific ──
// Inch tokens: 2", 2'', 2 inch, 2 inches, 2 इंच, 2"inch.
// Number → optional space → any of: "inch"/"inches", "इंच", two apostrophes,
// one-or-more `"`. Note: `inch(?:es)?` is the correct way to allow both
// "inch" and "inches" — `inches?` would match "inche"/"inches" instead
// because `s?` binds only to the final char.
// No trailing \b so that punctuation marks (', ") at end-of-string still
// match — \b fails there because ' and " are non-word characters.
const NAILS_INCH_REGEX = /\b(\d+(?:\.\d+)?)\s*(?:inch(?:es)?|इंच|''|"+)/gi;

// "se" pattern for mm ranges: "5.3 se 5.4 mm", "6.8 se 6.9"
const MM_RANGE_REGEX = /(\d+(?:\.\d+)?)\s*(?:se|to|-|–)\s*(\d+(?:\.\d+)?)\s*(?:mm|मिमी)?\b/i;
// "mm" / "dia" / "diameter" pattern: "5.3mm", "5.3 dia", "8 diameter"
const MM_SINGLE_REGEX = /(\d+(?:\.\d+)?)\s*(?:mm|dia|diameter|मिमी)/i;

// Intent patterns — used for hint detection only, NOT for final decision
// Parser only gets 0.95 when product+size is crystal clear
const INTENT_HINTS = {
  order_confirm: [
    /(?:^|[\s,.])(?:book\s*kar|pakka\s*kar|confirm\s*kar|le\s*lo|lelo|ले\s*लो|बुक\s*कर|पक्का\s*कर)(?:o|do|iye|va|ो|ा|ें)?(?:$|[\s,.\?])/i,
    /(?:^|[\s,.])(?:order\s*kar|final\s*kar|done\s*kar)(?:o|do|iye)?(?:$|[\s,.\?])/i,
    /(?:^|[\s,.])(?:confirm\s*hai|pakka\s*hai|done\s*hai|book\s*hai)(?:$|[\s,.\?])/i,
    // Bare confirmation words (standalone, 1–3 word messages):
    // "order", "confirm", "confirmed", "booked", "pakka", "final", "done",
    // "order de do", "confirm please", "ok confirm", "book it", etc.
    /^(?:ok\s+|okay\s+)?(?:order|confirm|confirmed|book|booked|pakka|final|done|आर्डर|कन्फर्म|पक्का|बुक)(?:\s+(?:please|pls|kar\s*do|de\s*do|it|ho|ji|karo|kardo))?\s*[.!]?$/i,
  ],
  price_inquiry: [
    /(?:^|[\s,.])(?:rate|rates|price|prices|bhav|भाव|kya\s*rate|क्या\s*रेट|quote|quotation)(?:$|[\s,.\?])/i,
    /(?:^|[\s,.])(?:aaj\s*ka\s*rate|today.?s?\s*rate|current\s*rate|latest\s*rate|new\s*rate)(?:$|[\s,.\?])/i,
  ],
  greeting: [
    /^(?:hi|hello|hey|namaste|namaskar|नमस्ते|हेलो|good\s*morning|good\s*evening|good\s*afternoon)\s*[!.?]?\s*$/i,
  ],
  thanks: [
    /^(?:ok\s*)?(?:thank|thanks|shukriya|शुक्रिया|dhanyawad|धन्यवाद|theek\s*hai)\s*[!.]?\s*$/i,
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
// Parser is CONSERVATIVE — only 0.95 confidence when product + size is crystal clear.
// Everything ambiguous stays low confidence → GPT decides.
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
    mmRange: null, // user-given mm range string e.g. "5.2-5.3" (preserves what user actually said)
    // Binding-only fields. `packaging` defaults to null at the parser level
    // (responseBuilder will fill in "without" downstream when category=binding
    // and customer didn't say which). `random` is true only when explicitly
    // mentioned ("random"/"रैंडम").
    packaging: null,
    random: false,
    // Nails-only field — inch size as a string ("2", "2.5", "1.5", …).
    inch: null,
  };

  // 1. Simple intents — greeting and thanks (only full-match, nothing else in message)
  for (const [intent, patterns] of Object.entries(INTENT_HINTS)) {
    for (const pattern of patterns) {
      if (pattern.test(lower)) {
        result.intent = intent;
        result.confidence = (intent === "greeting" || intent === "thanks") ? 0.95 : 0.7;
        break;
      }
    }
    if (result.intent !== "unknown") break;
  }

  // 2. Detect category keyword (wr / hb / binding / nails). Order matters:
  // when both "binding" and "wr" appear we still want "binding" — so we check
  // the more specific keywords (binding, nails) first by Object.entries order
  // (the object literal preserves insertion order in modern JS).
  for (const [cat, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(lower)) {
      result.category = cat;
      break;
    }
  }

  // 2a. BINDING gauge override — "18g" / "20g" is ALWAYS binding (HB doesn't
  // sell these). This must run before the generic GAUGE_REGEX in step 4 so
  // the gauge isn't grabbed as HB.
  const bindingGaugeMatch = BINDING_GAUGE_REGEX.exec(lower);
  if (bindingGaugeMatch) {
    result.category = "binding";
    result.gauge = bindingGaugeMatch[1]; // "18" or "20"
  }

  // 2b. BINDING wrapper / random — only meaningful when category is binding.
  if (result.category === "binding") {
    if (BINDING_WITH_WRAPPER_REGEX.test(lower)) result.packaging = "with";
    else if (BINDING_WITHOUT_WRAPPER_REGEX.test(lower)) result.packaging = "without";
    // else leave null — chatService/responseBuilder defaults to "without".
    if (BINDING_RANDOM_REGEX.test(lower)) result.random = true;
  }

  // 2c. NAILS detection — inch token signals nails. We pick the FIRST inch
  // value as the primary `inch`; multi-inch messages (e.g. "8g 2 inch and
  // 9g 3 inch nails") are handled by parseMultiple().
  const inchRe = new RegExp(NAILS_INCH_REGEX.source, "gi");
  const firstInchMatch = inchRe.exec(lower);
  if (firstInchMatch && !result.gauge) {
    // Inch found and gauge not yet decided → this is nails. Set category
    // first, then let step 4 below pick up the gauge token.
    result.category = "nails";
    result.inch = firstInchMatch[1];
  } else if (firstInchMatch && result.category === "nails") {
    result.inch = firstInchMatch[1];
  } else if (result.category === "nails" && !result.inch) {
    // "nails" keyword with NO inch → leave inch null; downstream will quote
    // the default 8G 3"+4" pair.
  }

  // 3. Carbon type
  if (LC_PATTERN.test(lower)) result.carbonType = "lc";

  // 4. Detect HB gauge: "12g", "3/0g", "3/0 gauge". Skip when category was
  // already locked to binding/nails (binding has its own gauge from step 2a;
  // for nails we still want to read the gauge below).
  if (result.category !== "binding") {
    const gaugeMatch = GAUGE_REGEX.exec(lower);
    if (gaugeMatch) {
      result.gauge = gaugeMatch[1];
      // Only auto-fill HB if no other category was set. For "nails" we keep
      // the nails category but still capture the gauge.
      if (!result.category) result.category = "hb";
    }
    if (!result.gauge && result.category !== "nails") {
      const slashMatch = SLASH_GAUGE_REGEX.exec(lower);
      if (slashMatch) {
        result.gauge = slashMatch[1];
        if (!result.category) result.category = "hb";
      }
    }
  }

  // 4a. NAILS post-fix — if we found inch + a numeric gauge, validate the
  // (gauge, inch) pair. If invalid we'll let it through (responseBuilder
  // will return "unavailable"). If we found inch but no gauge, leave gauge
  // null so the response can ask the customer for a gauge.
  if (result.category === "nails" && result.inch && result.gauge) {
    if (!NAILS_GAUGES.includes(result.gauge)) {
      // gauge that nails doesn't sell (e.g. user said "12g 2 inch") — let
      // it flow through; downstream will reply "not available".
    }
  }

  // 5. Detect HB mm range: "5.3 se 5.4 mm" — skip when category is already
  // binding or nails (those aren't specified in mm).
  const mmRangeMatch = (result.category === "binding" || result.category === "nails")
    ? null
    : MM_RANGE_REGEX.exec(lower);
  if (mmRangeMatch) {
    const mm1 = parseFloat(mmRangeMatch[1]);
    const mm2 = parseFloat(mmRangeMatch[2]);
    const avgMm = (mm1 + mm2) / 2;
    if (isHBMmRange(avgMm)) {
      result.mm = String(avgMm);
      result.gauge = mmToGauge(avgMm);
      // Keep the exact user-given range (e.g. "5.2-5.3") so order + reply
      // can echo the specific size the customer asked for.
      const lo = Math.min(mm1, mm2);
      const hi = Math.max(mm1, mm2);
      result.mmRange = `${lo}-${hi}`;
      if (!result.category) result.category = "hb";
    }
  }

  // 6. Detect single mm/dia: "5.3mm", "5.3 dia" — routes to HB if in HB range.
  // Normally we skip values that look like WR sizes (whole numbers or 5.5 in
  // the 3-30 range) so "5.5 dia" stays WR. BUT if the user explicitly said
  // "hb" / "hb wire", then 8mm, 10mm etc. are HB (the user told us so).
  // Skip for binding/nails — those categories never specify in mm.
  if (!result.mm && !result.gauge && result.category !== "binding" && result.category !== "nails") {
    const mmSingle = MM_SINGLE_REGEX.exec(lower);
    if (mmSingle) {
      const mmVal = parseFloat(mmSingle[1]);
      const looksLikeWR = isWRSize(mmVal) && (Number.isInteger(mmVal) || mmSingle[1] === "5.5");
      const hbExplicit = result.category === "hb";
      const isHb = isHBMmRange(mmVal) &&
        (hbExplicit || (!AVAILABLE_WR_SIZES.includes(mmSingle[1]) && !looksLikeWR));
      if (isHb) {
        result.mm = mmSingle[1];
        result.gauge = mmToGauge(mmVal);
        result.mmRange = mmSingle[1]; // single exact value the user gave
        if (!result.category) result.category = "hb";
      }
    }
  }

  // 7. Quantity + unit.
  // We scan GLOBALLY so every number followed by a unit keyword (ton/mt/kg/…)
  // is recognised as a quantity — not just the first one. This matters when
  // the customer gives a per-item quantity reply like "2 ton and 5 mt" after
  // we asked for qty per size; without this, the second number ("5" in "5mt")
  // leaks into step 8 and gets mistaken for a WR size (5mm → "not available").
  const qtyBoundValues = new Set();
  const qtyGlobalRe = new RegExp(QTY_REGEX.source, "gi");
  let qMatch;
  while ((qMatch = qtyGlobalRe.exec(lower)) !== null) {
    qtyBoundValues.add(qMatch[1]);
    if (result.quantity === null) {
      result.quantity = parseFloat(qMatch[1]);
      const unitRaw = qMatch[0].replace(qMatch[1], "").trim().toLowerCase();
      for (const [key, val] of Object.entries(UNIT_MAP)) {
        if (unitRaw.includes(key)) { result.unit = val; break; }
      }
      if (!result.unit) result.unit = "ton";
    }
  }

  // 8. Extract numbers for WR size. Skip entirely for binding/nails — those
  // categories do NOT have WR-style sizes and numbers like "2" in "2 inch"
  // or "18" in "18g" would otherwise get mis-picked as WR sizes.
  if (!result.gauge && !result.mm && !result.size &&
      result.category !== "binding" && result.category !== "nails") {
    const allNumbers = [];
    let match;
    const numRegex = /(\d+(?:\.\d+)?)/g;
    while ((match = numRegex.exec(lower)) !== null) {
      allNumbers.push({ value: match[1], index: match.index });
    }

    for (const num of allNumbers) {
      if (result.quantity && parseFloat(num.value) === result.quantity) continue;
      if (qtyBoundValues.has(num.value)) continue; // "5mt" → quantity, not a size
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
        break;
      }
    }

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

  // 8b. HB coercion for explicit "hb" keyword with WR-looking mm/size.
  // If the user wrote "hb 8mm" / "hb 10mm" / "hb 8" (bare number) and the
  // value we captured is in the HB mm range (1.5–12.0mm), treat it as HB mm
  // and map to the right gauge — the user explicitly said "hb" so we should
  // NOT serve a WR 8mm price for it. Out-of-range values (12+) are left
  // untouched (HB physical range ends at 11.8mm).
  if (result.category === "hb" && result.size && !result.gauge && !result.mm) {
    const mmVal = parseFloat(result.size);
    if (isHBMmRange(mmVal)) {
      result.mm = result.size;
      result.gauge = mmToGauge(mmVal);
      result.mmRange = result.size;
      result.size = null;
      result.sizeAvailable = true;
      result.closestSizes = [];
    }
  }

  // 9. Confidence — only 0.95 when we have CLEAR product evidence
  // "5.5 wr rate" → category=wr, size=5.5, price hint → 0.95
  // "hb 12g rate" → category=hb, gauge=12, price hint → 0.95
  // "5.3 se 5.4mm" → category=hb, mm detected → 0.95
  // "binding 20g"  → category=binding, gauge=20 → 0.95
  // "nails 8g 3 inch" → category=nails, gauge=8, inch=3 → 0.95
  // "5.5 3 ton book karo" → order_confirm (NEVER override to price_inquiry!)
  // Everything else → low confidence → GPT decides
  const hasProduct = result.category && (
    result.size || result.gauge || result.mm || result.inch
  );

  if (result.intent === "order_confirm") {
    // Keep order_confirm — NEVER override. Low confidence forces GPT verification.
    result.confidence = 0.7;
  } else if (hasProduct) {
    result.intent = "price_inquiry";
    result.confidence = 0.95;
  } else if (result.intent === "greeting" || result.intent === "thanks") {
    // already set to 0.95 above
  } else if (result.intent === "unknown" && result.category) {
    result.intent = "price_inquiry";
    // Binding / nails are deterministic with a default quote even when
    // customer just says "binding" / "nails" (we quote the 18g+20g+20g-
    // random trio / the 8G 3"+4" default pair). Give them the same 0.95
    // the detail-rich WR/HB queries get so L2 template handles them and
    // we skip an otherwise-unnecessary GPT classifyIntent round-trip.
    result.confidence = (result.category === "binding" || result.category === "nails") ? 0.95 : 0.7;
  }

  // 10. Short follow-up / confirmation messages
  if (result.intent === "unknown" && raw.length <= 15) {
    const c = raw.trim().toLowerCase();
    if (c === "?" || c === "." || /^rate$/i.test(c)) {
      result.intent = "follow_up";
      result.confidence = 0.5;
    }
    // "ji / ok / haan / yes / theek hai / accha" are pure acknowledgments.
    // They must NOT be treated as a re-ask for price. Mark as acknowledgment
    // so chatService will skip the price-enrichment path. Only the order-flow
    // handler (Case 2: confirm previously quoted qty) should act on them.
    if (/^(?:ji|haan|ha|haa|ok|okay|yes|theek|thik|sahi|done|acha|accha)\s*(?:ji|hai|h|bhai)?\s*[.!]?$/i.test(c)) {
      result.intent = "acknowledgment";
      result.confidence = 0.9;
    }
  }

  return result;
}

function intentToStage(intent) {
  const map = {
    price_inquiry: "price_inquiry",
    negotiation: "negotiation",
    order_confirm: null, // stage set only by processOrderConfirmation after DB save
    order_inquiry: "price_inquiry",
    follow_up: null,
    acknowledgment: null,
    delivery_inquiry: null,
    greeting: null,
    thanks: null,
    unknown: null,
  };
  return map[intent] || null;
}

// Global variant of MM_SINGLE_REGEX — extracts EVERY mm/dia value in the text.
// Used to detect inline multi-HB messages like "hb 8mm 10mm" or
// "8mm 10mm hb wire" where one line carries multiple HB sizes.
const MM_ALL_REGEX = /(\d+(?:\.\d+)?)\s*(?:mm|dia|diameter|मिमी)/gi;

function extractAllHbMms(text) {
  if (!text || typeof text !== "string") return [];
  const re = new RegExp(MM_ALL_REGEX.source, "gi");
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const v = parseFloat(raw);
    if (!isHBMmRange(v)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Parse a message that may contain multiple product inquiries.
 *
 * Two shapes are supported:
 *   1. Multi-line: one inquiry per line (e.g. "hb 12g\nwr 5.5").
 *   2. Inline multi-HB: single line with the "hb" keyword and 2+ mm values
 *      (e.g. "hb 8mm 10mm", "8mm 10mm hb wire"). Each mm maps to its gauge
 *      so the multi-item response shows one price per size the user asked for.
 *
 * Returns an array of parsed items (length >= 2) or empty array.
 */
function parseMultiple(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.split(/[\n\r]+/).map((l) => l.trim()).filter((l) => l.length > 0);

  // Shape 1: multi-line
  if (lines.length >= 2) {
    const items = [];
    for (const line of lines) {
      const parsed = parse(line);
      if (parsed.category && (parsed.size || parsed.gauge || parsed.mm || parsed.inch)) {
        items.push(parsed);
      }
    }
    if (items.length >= 2) return items;
  }

  const single = parse(text);

  // Shape 4: inline MULTI-CATEGORY (WR + HB + binding + nails mixed on one line).
  //
  // Canonical example the admin asked for:
  //   "5.5mm wr 2mt binding 20g 5mt Nails 2inch 500kgs"
  //      ↳ WR 5.5mm 2 ton + Binding 20g 5 ton + Nails 8G 2" 500 kg
  //
  // Strategy: scan the text for category "anchors" (wr / hb / binding / nails
  // and their synonyms + 18g/20g gauge tokens + inch tokens as implicit
  // nails anchors). Each anchor becomes a boundary; we slice the text at
  // those boundaries, parse each slice independently, and return all
  // valid items. Runs BEFORE Shape 3 because "wr"/"binding"/"nails"
  // keywords in the message are a stronger hint than naked mm tokens.
  const CAT_ANCHOR_RE = /\b(wire\s*rod|wirerod|wr|hb\s*wire|hb|एचबी|binding\s*wire|binding|bw|बाइंडिंग|बंधन|nails?|कील|किल|18\s*(?:g|gauge|गेज)|20\s*(?:g|gauge|गेज))\b/gi;
  const anchorMatches = [];
  {
    const re = new RegExp(CAT_ANCHOR_RE.source, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      const tok = m[1].toLowerCase().replace(/\s+/g, " ").trim();
      let cat;
      if (/^(wr|wire\s*rod|wirerod)$/i.test(tok)) cat = "wr";
      else if (/^(hb|hb\s*wire|एचबी)$/i.test(tok)) cat = "hb";
      else if (/^(binding|binding\s*wire|bw|बाइंडिंग|बंधन|18\s*(?:g|gauge|गेज)|20\s*(?:g|gauge|गेज))$/i.test(tok)) cat = "binding";
      else if (/^(nail|nails|कील|किल)$/i.test(tok)) cat = "nails";
      if (cat) anchorMatches.push({ cat, idx: m.index, end: m.index + m[0].length, tok });
    }
  }

  // Also treat the FIRST inch token as an implicit nails anchor when no
  // explicit nails keyword is present in the message.
  {
    const inchRe = new RegExp(NAILS_INCH_REGEX.source, "gi");
    const hasExplicitNails = anchorMatches.some((a) => a.cat === "nails");
    const firstInch = inchRe.exec(text);
    if (firstInch && !hasExplicitNails) {
      anchorMatches.push({ cat: "nails", idx: firstInch.index, end: firstInch.index + firstInch[0].length, tok: "(inch)" });
    }
  }

  anchorMatches.sort((a, b) => a.idx - b.idx);

  // Dedupe anchors of the SAME category that sit within 5 chars of each other
  // so "binding wire" (matched twice: once as "binding wire", once as "binding")
  // or "binding 20g" (matched as "binding" AND "20g") collapse to one anchor.
  const anchors = [];
  for (const a of anchorMatches) {
    const prev = anchors[anchors.length - 1];
    if (prev && prev.cat === a.cat && a.idx - prev.end <= 8) {
      prev.end = Math.max(prev.end, a.end);
      continue;
    }
    anchors.push({ ...a });
  }

  const distinctCats = new Set(anchors.map((a) => a.cat));
  if (anchors.length >= 2 && distinctCats.size >= 2) {
    const items = [];
    for (let i = 0; i < anchors.length; i++) {
      const segStart = anchors[i].idx;
      // Back-look ONLY for the first segment so patterns like
      // "5.5mm wr 2mt" (size preceding the category word) still get 5.5mm
      // bound to the WR segment. For subsequent segments we start exactly at
      // the anchor — otherwise the PREVIOUS segment's qty ("2mt" in
      // "wr 2mt binding …") would leak into the current segment and be
      // mistaken for binding/nails quantity.
      const extendedStart = i === 0 ? 0 : segStart;
      const segEnd = i + 1 < anchors.length ? anchors[i + 1].idx : text.length;
      const segText = text.slice(extendedStart, segEnd).trim();

      const parsedSeg = parse(segText);
      // Force the segment's category to the anchor's category (e.g. "20g 5mt"
      // alone would get category=binding from parse(), which is right; but
      // "2 inch 500kgs" segment, parse() might return category=nails without
      // gauge; we set it explicitly for safety).
      parsedSeg.category = anchors[i].cat;

      const hasDetail = Boolean(
        parsedSeg.size || parsedSeg.gauge || parsedSeg.mm || parsedSeg.inch
      );
      // Keep every segment that at least mentions a category — even bare
      // "binding" or "nails" without a gauge, because responseBuilder knows
      // how to render the default set for each (18g/20g/20g-random for
      // binding, 8G 3"+4" for nails).
      if (hasDetail || segText.length > 0) {
        items.push(parsedSeg);
      }
    }
    if (items.length >= 2) {
      // Tag raw so downstream can pass a consolidated response
      return items.map((it) => ({ ...it, raw: text }));
    }
  }

  // Shape 3: inline multi-size WITH per-size quantities.
  // Examples:
  //   "8mm 2mt and 10mm 5mt"         → WR 8mm 2ton + WR 10mm 5ton
  //   "hb 8mm 2mt aur 10mm 5mt"      → HB 1/0 (8mm) 2ton + HB 4/0 (10mm) 5ton
  //   "5.5 3 ton 7mm 2 ton"          → WR 5.5 3ton + WR 7 2ton
  //   "book 8mm 2mt aur 10mm 5mt"    → 2 items (chatService will route to order flow)
  //
  // We scan for size tokens (mm/dia-suffixed) and qty tokens (N + ton/mt/kg/…)
  // separately, then pair them in document order (each qty belongs to the
  // nearest preceding size that doesn't yet have one). If we get >= 2 paired
  // items this takes precedence over Shape 2 (qty is the stronger signal).
  const sizeTokens = [];
  const sizeRe = /(\d+(?:\.\d+)?)\s*(?:mm|dia|diameter|मिमी)/gi;
  let sm;
  while ((sm = sizeRe.exec(text)) !== null) {
    sizeTokens.push({ val: sm[1], idx: sm.index });
  }
  const qtyTokens = [];
  const qRe = new RegExp(QTY_REGEX.source, "gi");
  let qm;
  while ((qm = qRe.exec(text)) !== null) {
    qtyTokens.push({ val: parseFloat(qm[1]), idx: qm.index });
  }

  if (sizeTokens.length >= 2 && qtyTokens.length >= 2) {
    const hbKeyword = single.category === "hb";
    const lcCarbon = single.carbonType === "lc";
    const items = [];
    for (let i = 0; i < sizeTokens.length; i++) {
      const s = sizeTokens[i];
      const sNum = parseFloat(s.val);
      const nextIdx = sizeTokens[i + 1] ? sizeTokens[i + 1].idx : Infinity;
      // Pick the first qty token that lives between this size and the next size.
      const q = qtyTokens.find((t) => t.idx > s.idx && t.idx < nextIdx);
      if (!q) continue;

      // Category decision per size:
      // • "hb" keyword anywhere in text → HB (if value is in HB mm range)
      // • else: WR if the value is a known WR size; otherwise HB if in HB range.
      const isWRAvail = AVAILABLE_WR_SIZES.includes(s.val);
      const isHb = hbKeyword
        ? isHBMmRange(sNum)
        : (!isWRAvail && isHBMmRange(sNum));

      if (isHb) {
        items.push({
          intent: "price_inquiry",
          raw: text,
          confidence: 0.9,
          category: "hb",
          size: null,
          sizeAvailable: true,
          closestSizes: [],
          carbonType: lcCarbon ? "lc" : "normal",
          quantity: q.val,
          unit: "ton",
          gauge: mmToGauge(sNum),
          mm: s.val,
          mmRange: s.val,
        });
      } else {
        items.push({
          intent: "price_inquiry",
          raw: text,
          confidence: 0.9,
          category: "wr",
          size: s.val,
          sizeAvailable: isWRAvail,
          closestSizes: isWRAvail ? [] : findClosestWRSizes(s.val),
          carbonType: lcCarbon ? "lc" : "normal",
          quantity: q.val,
          unit: "ton",
          gauge: null,
          mm: null,
          mmRange: null,
        });
      }
    }
    if (items.length >= 2) return items;
  }

  // Shape 2: inline multi-HB — user gave 2+ mm values together with "hb"
  // keyword on a single line. We emit one item per mm so chatService's
  // existing multi-item path renders all requested sizes. Quantity is left
  // empty per item because "hb 8mm 10mm 5 ton" is ambiguous (total vs split),
  // so we only show rates — user can follow up with per-size qty.
  if (single.category === "hb") {
    const mms = extractAllHbMms(text);
    if (mms.length >= 2) {
      return mms.map((mm) => {
        const v = parseFloat(mm);
        return {
          ...single,
          intent: "price_inquiry",
          size: null,
          gauge: mmToGauge(v),
          mm,
          mmRange: mm,
          sizeAvailable: true,
          closestSizes: [],
          quantity: null,
          unit: null,
          // carbonType is inherited from `single` — so "hb 8mm 10mm lc" gives
          // both sizes as LC, matching user's intent.
        };
      });
    }
  }

  return [];
}

// Broad order-keyword detector — used by chatService to decide whether a
// message that ALSO carries product/qty info should be routed through the
// order-confirmation flow (GPT verifyOrder + processOrderConfirmation)
// instead of the price-inquiry flow. Intentionally permissive: matches the
// keyword anywhere in the message ("book", "book karo", "8mm 2mt book",
// "pakka kar do", "confirm please", "le lo", "order de do", etc.).
const ORDER_KEYWORD_REGEX =
  /\b(?:book|booked|booking|confirm|confirmed|pakka|pakki|final|finalize|finalise|order|le\s*lo|lelo|बुक|कन्फर्म|पक्का|आर्डर)\b/i;

module.exports = {
  parse,
  parseMultiple,
  intentToStage,
  findClosestWRSizes,
  mmToGauge,
  AVAILABLE_WR_SIZES,
  ALL_HB_GAUGES,
  HB_MM_RANGES,
  ORDER_KEYWORD_REGEX,
};
