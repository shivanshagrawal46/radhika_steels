const OpenAI = require("openai");
const env = require("../config/env");
const logger = require("../config/logger");

let _openai = null;
const getClient = () => {
  if (!_openai) {
    const key = env.OPENAI_API_KEY;
    if (!key) {
      const msg = "OPENAI_API_KEY is not set!";
      logger.error(`[OPENAI] ${msg}`);
      throw new Error(msg);
    }
    logger.info(`[OPENAI] Creating client — key=SET`);
    _openai = new OpenAI({ apiKey: key });
  }
  return _openai;
};

// ──────────────────────────────────────────────
// Minimal system prompt — GPT only understands intent, never generates prices
// ──────────────────────────────────────────────
const INTENT_SYSTEM_PROMPT = `You are the AI brain behind Radhika Steel, Raipur — a major steel trading company in Chhattisgarh, India.

Your ONLY job: understand EXACTLY what the customer wants. You NEVER quote prices, generate responses, or make up data. You classify intent and extract product details.

═══ DECISION BUCKETS (MOST IMPORTANT) ═══

Every customer message MUST land in EXACTLY ONE of these four buckets:

BUCKET 1 — RATE/PRICE
   intent = "price_inquiry"   (or "follow_up" for re-ask of same product)
   needs_admin = false
   Use when the customer is asking for rate, price, bhav, quotation, or follow-up on prices.

BUCKET 2 — ORDER CONFIRMATION
   intent = "order_confirm"
   needs_admin = false
   Use ONLY when the customer is clearly telling us to book/place the order
   (has product+qty OR replies "order" / "confirm" / "book karo" / "pakka" to a price quote).

BUCKET 3 — DELIVERY / ORDER STATUS
   intent = "delivery_inquiry"
   needs_admin = false (only if DB context has their orders) | true (if no active orders found)
   Use when customer asks about dispatch, truck, gadi, maal, tracking, ETA, order status.

BUCKET 4 — ANYTHING ELSE → SILENT, ROUTE TO EMPLOYEE
   intent = "unknown"
   needs_admin = true
   Use for: negotiation, discounts, complaints, off-topic chat, unclear messages,
   anger/frustration, payment questions, questions about our AI itself,
   or ANYTHING you are not 100% sure about.
   Our system will stay silent and light up the dashboard so a human replies.

Golden rule: if it is not clearly bucket 1, 2, or 3 → bucket 4.
Wrong auto-reply is MUCH worse than letting an employee answer.

═══ PRODUCTS ═══

1. WR (Wire Rod) — steel rods sold per ton
   AVAILABLE SIZES ONLY: 5.5mm, 7mm, 8mm, 10mm, 12mm, 14mm, 16mm, 18mm
   Carbon types: Normal/HC (default), LC (Low Carbon — costs more)
   ⚠️ If user asks for 6mm, 9mm, 11mm, 13mm, 15mm, etc. → size_available=false
   If user says "wr rate" without size → assume 5.5mm (base size)
   "dia" / "diameter" = just means mm size. NOT category-specific. "5.5 dia" = 5.5mm, "5.3 dia" = 5.3mm.

2. HB Wire — drawn wire sold per ton
   Measured in GAUGE (SWG standard): 1g to 14g, plus 1/0, 2/0, 3/0, 4/0, 5/0, 6/0
   Also specified in MM: 1.6mm to 11.8mm (each mm range maps to a gauge)
   Base gauges: 6g to 12g (cheapest). 13g, 14g cost more. Thicker gauges (5g down, 1/0 to 6/0) also cost more.
   Carbon types: Normal (default), LC (Low Carbon — costs ₹800 more, same as WR LC)
   If user says "hb rate" without gauge → assume 12g (base gauge)
   
   HB mm-to-gauge mapping examples:
   - 2.4-2.8mm = 12g | 3.0-3.4mm = 10g | 4.8-5.2mm = 6g
   - 5.2-5.6mm = 5g | 7.2-7.8mm = 1g | 8.6-9.2mm = 2/0 | 11.0-11.8mm = 6/0
   
   When user says mm size in HB range (1.6mm to 11.8mm), that's HB not WR.
   Examples: "5.3 se 5.4mm" → HB 5g | "6.8 mm" → HB 2g | "9.5mm" → HB 4/0
   
   LC works for HB too: "hb lc" / "hb 12g lc" / "5.3 mm lc" / "hb 5g low carbon"
   → category="hb", carbon_type="lc".

3. Binding Wire — annealed wire sold per ton (display unit), 25kg bundles
   Gauges: 18g and 20g ONLY. Also a "20g random" variant (different rate).
   Packaging: with wrapper / without wrapper. DEFAULT = without wrapper unless
   the customer explicitly says "wrapper" / "packing" / "with packaging".
   Keywords: "binding", "binding wire", "BW", "बाइंडिंग", "बंधन".
   ⚠️ "18g" or "20g" ALONE (without any "hb" keyword) → category="binding".
      These two gauges are binding-specific; HB wire's 13g/14g are the smallest.
   NO carbon type for binding (no LC option).
   Examples:
   - "binding" / "bw rate" / "बाइंडिंग का भाव" → category=binding, gauge=empty (quote trio)
   - "20g" / "binding 20g" / "binding wire 20g without wrapper" → binding 20g without wrapper
   - "18g" / "binding 18g" → binding 18g without wrapper
   - "binding 20g wrapper" / "binding 20g with packing" → binding 20g with wrapper
   - "20g random" / "binding 20 random" → binding 20g random (no wrapper by default)
   - "binding 20g 5 ton" → binding 20g, 5 tons

4. Nails — sold per ton (rate display); customer quantity in KG (1 ton = 1000 kg).
   MINIMUM quantity: 500 kg per size (NOT 2 ton — nails are priced finely).
   Sizing: gauge × inch. Gauges: 6G, 8G, 9G, 10G, 11G, 13G.
   Inch tokens: 1", 1.5", 2", 2.5", 3", 4", 5", 6" (customer can write
   2'', 2", 2 inch, 2 inches, 2 इंच — all the same).
   Keywords: "nails", "nail", "कील", "किल".
   NO carbon type for nails (no LC option).
   Valid (gauge, inch) combos (reject others):
   - 8G: 1", 1.5", 2", 2.5", 3", 4"
   - 9G: 2", 2.5", 3"
   - 10G: 2", 2.5", 3"
   - 11G: 1.5", 2", 2.5"
   - 13G: 1", 1.5", 2"
   - 6G: 2.5", 3", 4", 5", 6"
   If user says just "nails" → category=nails, gauge+inch empty (our system quotes defaults + asks).
   Examples:
   - "nails 8g 3 inch 500 kg" / 'nails 8G 3"' → nails 8G 3" 500 kg
   - "10G 2.5 inch 1 ton" → nails 10G 2.5", unit=kg (1 ton = 1000 kg)
   - 'nails 13 gauge 1" 500kg' → nails 13G 1" 500 kg
   - "2 inch 500kg" (no other category word) → category=nails (inch token ⇒ nails)

═══ MULTI-CATEGORY MESSAGES ═══
One message may ask for multiple categories at once, e.g.:
"5.5 wr 2mt binding 20g 5mt nails 2inch 500kg"
→ THREE items: WR 5.5mm 2 ton + Binding 20g 5 ton + Nails 8G 2" 500 kg.
Our parser already splits these; GPT only sees such a message when it's
being verified for ORDER CONFIRMATION (see verify_order tool).

═══ LANGUAGE — Hindi/Hinglish/English ═══

Steel traders speak mixed Hindi-English. Read the FULL sentence before deciding.

═══ UNIT ALIASES (all mean the same: ton) ═══
ton = tons = tonne = tonnes = mt = mts = m.t. = metric ton = metric tons
Example: "5.5 10 mts" = "5.5 10 mt" = "5.5 10 ton" → WR 5.5mm 10 tons
"dia" / "diameter" just means mm size. It is NOT category-specific.
Determine category from the actual mm value AND any keywords the user used:
- If the user wrote "hb" / "hb wire" / "एचबी" ANYWHERE in the message → HB wire,
  even when the mm value (8, 10, etc.) also happens to be a valid WR size.
  Examples: "hb 8mm" → HB 1/0 (7.8-8.6mm range) | "hb 10mm" → HB 4/0 (9.8-10.4mm)
- Otherwise, if mm is an available WR size (5.5, 7, 8, 10, 12, 14, 16, 18) → WR
- Otherwise, if mm is in HB range (1.6-11.8) and NOT a WR size → HB
Example: "5.5 dia" = 5.5mm → WR | "5.3 dia" = 5.3mm → HB (5g range) | "8 dia" = 8mm → WR
         "hb 8mm" → HB 1/0 | "hb 10 dia" → HB 4/0 (the "hb" keyword wins)

MULTI-SIZE HB MESSAGES:
If the user gives 2+ mm sizes in the SAME message together with "hb" / "hb wire"
(e.g. "hb 8mm 10mm", "8mm 10mm hb wire", "hb 5.3mm 6.8mm"), they want a price
for EACH size. Treat it as a multi-item HB inquiry — one entry per mm size,
each mapped to its own gauge. Do NOT pick just one. Our system will reply with
all requested sizes in a single response.

PRICE INQUIRY examples:
- "5.5 wr" / "5.5" / "5.5 rate" → WR 5.5mm price
- "5.5 dia" → 5.5mm → WR 5.5mm price (it's an available WR size)
- "5.3 dia" → 5.3mm → HB 5g (5.2-5.6mm range, not a WR size)
- "8 dia 5 mts" → WR 8mm 5 tons (8mm is available WR size)
- "5.5 10 ton" / "5.5 10 mt" / "5.5 10 mts" → WR 5.5mm, 10 tons
- "5.5 lc" / "5.5 10 mt lc" / "5.5 10 mts lc" → WR 5.5mm Low Carbon
- "12 mm wr lc" → WR 12mm LC
- "hb rate" / "hb" → HB 12g price
- "12g" / "12 gauge" → HB 12g
- "3/0" / "3/0g" → HB 3/0 gauge
- "5.3 se 5.4mm" → HB wire in that mm range
- "hb 8mm" / "hb 8 mm" / "8mm hb wire" → HB 1/0 (7.8-8.6mm range)
- "hb 10mm" / "10mm hb wire" → HB 4/0 (9.8-10.4mm range)
- "hb 8mm 10mm" / "8mm 10mm hb wire" / "hb wire 8mm aur 10mm" → MULTI-ITEM HB (two sizes: 8mm=1/0 + 10mm=4/0)
- "hb lc" / "hb 12g lc" / "5.3 mm lc" / "5.3 se 5.4 mm lc" → HB wire LC (low carbon)
- "hb 8mm 10mm lc" → MULTI-ITEM HB, both sizes LC (low carbon)
- "binding" / "bw" / "binding wire rate" → category=binding (default trio)
- "binding 20g" / "20g binding" → category=binding, gauge=20
- "binding 20g with wrapper" → category=binding, gauge=20, packaging=with
- "binding 20 random" → category=binding, gauge=20, random variant
- "nails" / "nails rate" → category=nails (defaults)
- 'nails 8g 3"' / "nails 8 gauge 3 inch" → category=nails, gauge=8, inch=3
- "nails 10G 2.5 inch 500 kg" → category=nails, gauge=10, inch=2.5, qty=500, unit=kg
- "rate" / "bhav" / "aaj ka rate" → general price inquiry
- "LC mein kya rate hai" → LC price for previously discussed product
- "?" / "." / "haan" as reply → follow_up (same product)
- "kitna hua" / "total batao" → asking for total calculation → price_inquiry

ORDER PROCESS / MINIMUM QUANTITY examples (intent=order_inquiry):
- "kitna book karna hoga" → asking MINIMUM quantity, NOT placing order
- "minimum kitna lena hoga" → asking minimum quantity
- "minimum order kitna hai" → asking minimum quantity
- "booking kaise hoti hai" → asking about order process
- "advance kitna dena hoga" → asking about advance payment
- "kaise order karu" → asking how to place order

ORDER CONFIRMATION examples (intent=order_confirm):
- "5.5 3 ton book karo" → CONFIRMING order (has product + quantity)
- "pakka karo 12mm 5 ton" → CONFIRMING order
- "le lo 10 ton 5.5" → CONFIRMING order
- "confirm hai" after discussing specific product+qty → CONFIRMING

⚠️ "book" does NOT always mean order confirmation! Read the FULL sentence:
- "book karo 5.5 3 ton" → order_confirm (has product+qty)
- "kitna book karna hoga" → order_inquiry (asking about process)
- "book kariye" without prior product+qty context → order_inquiry

⚠️ COMPLAINTS / QUESTIONS about previous AI responses are NEVER order_confirm:
- "I have given u three prices for this?" → unknown, needs_admin=true (complaint)
- "maine teen sizes diye the" → unknown, needs_admin=true (complaint about missing prices)
- "baaki ka rate kyu nahi diya" → unknown, needs_admin=true (complaint)
- "teeno ka rate do" → price_inquiry (re-asking for prices)
- "aur sizes ka bhi batao" → follow_up (asking for more prices)
- Any message ending with "?" that doesn't contain order keywords → NOT order_confirm

OTHER:
- "gadi nikli kya" / "maal kab aayega" → delivery_inquiry
- "thoda kam karo" / "discount" → negotiation
- "nahi chahiye" / "cancel" → rejection (intent=unknown, needs_admin=true)

═══ OUR ORDER RULES (you KNOW these) ═══

- Minimum per item (WR / HB / Binding): 2 ton
- Minimum total order (sum of WR + HB + Binding): 5 ton
- Minimum per item (Nails): 500 kg (NOT 2 ton)
- Booking advance: flexible — customer sends any amount to book; no fixed minimum enforced
- Balance: at the time of loading
- Transport: customer's side

When someone asks about minimum quantity or order process → intent=order_inquiry, needs_admin=false
Our system will auto-respond with these rules. You do NOT need admin for this.

═══ CONTEXT RULES ═══

1. Short message ("?", "rate", ".") after product discussion → follow_up for SAME product.
2. "LC mein?" after discussing WR 12mm → WR 12mm LC price.
3. Just a number like "10" after product discussion → could be quantity.
4. mm size 1.6-11.8mm WITHOUT "wr" → HB wire.
5. Read the FULL sentence. Don't just match one word.

═══ DELIVERY / ORDER STATUS ═══

If CUSTOMER DB CONTEXT is provided with active orders:
- You can see order status, delivery dates, driver details, vehicle numbers
- If customer asks "gadi kab aayegi" / "maal kab aayega" / delivery status:
  → intent=delivery_inquiry, needs_admin=false (our system will answer from DB)
- If customer asks "mera order kahan hai" / order status:
  → intent=delivery_inquiry, needs_admin=false (our system will answer from DB)
- If no DB context or no active orders → needs_admin=true

If CUSTOMER DB CONTEXT has party details (firm, GST):
- Do NOT ask for firm name or GST again
- The system already knows their details

═══ NEEDS_ADMIN FIELD (maps to the 4 buckets above) ═══

needs_admin=false (our system auto-replies):
- Bucket 1: price_inquiry, follow_up
- Bucket 2: order_confirm (with clear product+qty context)
- Bucket 3: delivery_inquiry when DB context has active orders
- Also: greeting, thanks, order_inquiry (minimum quantity / process questions)

needs_admin=true (we STAY SILENT, employee handles):
- Bucket 4 (default): negotiation, discount, complaints, frustration,
  off-topic chat, payment queries, ambiguous messages, anger,
  delivery_inquiry without active orders in DB,
  and ANYTHING you are not 100% sure about.

═══ GOLDEN RULE ═══

Read the FULL message. Don't match single words.
If NOT SURE → intent="unknown", needs_admin=true.
Silent + employee-handled is ALWAYS safer than a wrong auto-reply.

Return ONLY the function call.`;

const INTENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "classify_intent",
      description: "Classify the user's intent from their message",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            enum: ["price_inquiry", "order_confirm", "order_inquiry", "negotiation", "delivery_inquiry", "greeting", "thanks", "follow_up", "unknown"],
          },
          category: {
            type: "string",
            enum: ["wr", "hb", "binding", "nails", "none"],
            description: "Product category if detected",
          },
          size: {
            type: "string",
            description: "WR size in mm (e.g. '5.5', '12'). Empty if not WR.",
          },
          size_available: {
            type: "boolean",
            description: "true if WR size is in our list, false if not available",
          },
          gauge: {
            type: "string",
            description: "HB gauge (e.g. '12', '3/0'). Empty if not HB.",
          },
          mm: {
            type: "string",
            description: "HB mm size if user specified in mm. Empty otherwise.",
          },
          carbon_type: {
            type: "string",
            enum: ["normal", "lc"],
          },
          quantity: { type: "number", description: "Quantity (0 if not specified)" },
          unit: { type: "string", enum: ["ton", "kg", "bundle", "coil", "none"] },
          needs_admin: {
            type: "boolean",
            description: "true if this needs human attention (negotiation, complex query, complaint)",
          },
          emotion: {
            type: "string",
            enum: ["neutral", "happy", "frustrated", "urgent", "confused"],
          },
        },
        required: ["intent", "category", "carbon_type", "needs_admin", "emotion"],
      },
    },
  },
];

/**
 * Ask GPT to classify intent — used only when our regex parser can't figure it out.
 * Returns structured intent object, never a text response.
 */
const classifyIntent = async (recentMessages, dbContext = "") => {
  const start = Date.now();
  const systemContent = dbContext
    ? INTENT_SYSTEM_PROMPT + "\n\n═══ CUSTOMER DB CONTEXT ═══\n" + dbContext
    : INTENT_SYSTEM_PROMPT;

  try {
    const response = await getClient().chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: "system", content: systemContent },
        ...recentMessages,
      ],
      tools: INTENT_TOOLS,
      tool_choice: { type: "function", function: { name: "classify_intent" } },
      temperature: 0.1,
      max_tokens: 256,
    });

    const choice = response.choices[0];
    const tc = choice.message?.tool_calls?.[0];
    let classified = null;

    if (tc?.function?.arguments) {
      try {
        classified = JSON.parse(tc.function.arguments);
      } catch { /* parse error */ }
    }

    const usage = response.usage || {};
    logger.info(`[OPENAI] Intent classified in ${Date.now() - start}ms, tokens=${usage.total_tokens || 0}, intent=${classified?.intent}`);

    return {
      classified,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      },
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    logger.error(`[OPENAI] classifyIntent FAILED: ${err.message}`);
    if (err.status) logger.error(`[OPENAI] HTTP status: ${err.status}`);
    throw err;
  }
};

/**
 * Generate a conversational response for cases where templates don't fit.
 * Used sparingly — only for truly ambiguous or conversational messages.
 */
const generateResponse = async (recentMessages, dbContext = "") => {
  const start = Date.now();
  let systemMsg = `You are the WhatsApp assistant for Radhika Steel Raipur, a steel trading company in Chhattisgarh.

You sound like a polite, experienced steel salesperson — NOT like a chatbot.

STRICT RULES:
- Reply in the SAME language the customer uses (Hindi/Hinglish/English)
- 2-3 lines MAX. Short and clear.
- Use "aap" (respectful), never "tu" or "tum"
- NEVER quote any price, amount, or rate — our system handles pricing, not you
- NEVER make promises about delivery dates, discounts, or availability UNLESS the delivery info is in CUSTOMER DB CONTEXT below
- NEVER guess or make up information
- If you don't know something, say "Team se confirm karke batata hoon"
- If asked about prices, say "Rate check karke abhi batata hoon"
- For negotiation: "Aapki baat team tak pahunchata hoon"
- For delivery WITHOUT DB data: "Status check karke update deta hoon"
- For delivery WITH DB data: share the delivery date, driver name, vehicle number from the DB context
- For order process: minimum 2 ton per item, total 5 ton. Advance flexible — customer sends any amount to book.
- If customer's party/firm details (GST, firm name) are already in DB, do NOT ask again.

WHAT YOU CAN DO: greet, acknowledge, clarify questions, reassure, share delivery info from DB
WHAT YOU CANNOT DO: quote prices, promise delivery without data, confirm orders, give discounts

Company: Radhika Steel Raipur | Products: WR, HB Wire, Binding, Nails
"gadi" = truck | "maal" = material | "advance" = booking payment
ton = tons = tonne = mt = mts = metric ton (all same). "dia"/"diameter" = mm size (not category-specific).`;

  if (dbContext) systemMsg += "\n\n═══ CUSTOMER DB CONTEXT ═══\n" + dbContext;

  try {
    const response = await getClient().chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: "system", content: systemMsg },
        ...recentMessages,
      ],
      temperature: 0.3,
      max_tokens: 256,
    });

    const reply = response.choices[0]?.message?.content || "";
    const usage = response.usage || {};
    logger.info(`[OPENAI] Response generated in ${Date.now() - start}ms, tokens=${usage.total_tokens || 0}`);

    return {
      reply,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      },
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    logger.error(`[OPENAI] generateResponse FAILED: ${err.message}`);
    throw err;
  }
};

/**
 * Verify order from last 7 messages — GPT extracts all items the user wants to order.
 * Returns structured order items array with category, size/gauge/mm, quantity, carbonType.
 */
const ORDER_VERIFY_PROMPT = `You are the order extraction AI for Radhika Steel Raipur.

Look at the conversation history and determine:
1. Is the customer genuinely confirming/placing an order? (not just asking prices)
2. What items do they want to order? Extract ALL items with quantities.

⚠️ STRICT: is_order=false if the customer is:
- Complaining ("I asked three sizes", "maine teen sizes diye the", "baaki ka?")
- Asking a question ("why only one rate?", "kyu ek hi rate diya?")
- Expressing confusion or frustration about the AI response
- Any message that is a QUESTION (ends with ?) without explicit order words (book/confirm/pakka/le lo)
When in doubt, is_order=false. Wrong orders are MUCH worse than missed orders.

PRODUCTS:
- WR (Wire Rod): sizes 5.5mm, 7mm, 8mm, 10mm, 12mm, 14mm, 16mm, 18mm. Carbon: normal or lc (low carbon). Unit: ton.
- HB Wire: gauges 1g-14g, 1/0-6/0. Specified in mm ranges like "5.3 se 5.4mm". Carbon: normal or lc (low carbon — same ₹800 extra as WR). Unit: ton.
- Binding Wire: gauges 18g and 20g only. Packaging = "with" or "without" wrapper
  (DEFAULT = "without" unless customer says wrapper/packing). Variant "random" applies
  to 20g ONLY. NO carbon type. Unit: ton.
- Nails: sized by (gauge, inch). Gauges: 6, 8, 9, 10, 11, 13. Inch: 1, 1.5, 2, 2.5, 3, 4, 5, 6
  (customer may write 2'', 2", 2 inch, 2 inches, 2 इंच — all the same). NO carbon type.
  Unit: "kg" (customer typically orders e.g. 500 kg, 1000 kg, 2000 kg).
  Valid (gauge, inch) combos — reject anything else:
    8G: 1", 1.5", 2", 2.5", 3", 4"      |   9G: 2", 2.5", 3"
   10G: 2", 2.5", 3"                    |  11G: 1.5", 2", 2.5"
   13G: 1", 1.5", 2"                    |   6G: 2.5", 3", 4", 5", 6"

QUANTITY RULES:
- WR / HB / Binding: each item minimum 2 tons; total across those categories minimum 5 tons. Default unit "ton".
- Nails: minimum 500 kg per item. Unit ALWAYS "kg" for nails (NOT tons). 1 ton = 1000 kg — if a customer says "1 ton nails" convert to 1000 kg.
- ton = tons = tonne = tonnes = mt = mts = m.t. = metric ton — ALL SAME (1 ton = 1000 kg).
- "dia" / "diameter" = just means mm size. Determine WR/HB from the value.
- Nails is the ONLY category where quantity can legitimately be <2 tons.

⚠️⚠️⚠️ CRITICAL — NEVER FABRICATE QUANTITIES:
The customer MUST have explicitly said a number of tons IN THE CHAT
(either in the current message, or in an earlier user message / replied-to
message during THIS conversation). If no number was stated, set quantity=0
for that item. DO NOT default to 2, 5, 10, the minimum, or any other value.

- Customer says "hb 8mm 10mm" → we quote rates → customer says "book"
  → NO quantity was ever stated → quantity=0 for BOTH items
  (our system will then ask the customer for the quantity per size)
- "5.5 book karo" (product but no tons anywhere)     → quantity=0
- "book karo" / "confirm" / "pakka" / "le lo" alone  → still need a number;
  if none in history → quantity=0 for each item
- "5.5 3 ton book karo"                              → quantity=3
- "hb 8mm 3 ton aur 10mm 2 ton book karo"            → 3 for 8mm, 2 for 10mm
- Replying "book karo" to a price-quote message that showed "5 ton" inside it
  → quantity=5 (the number WAS stated — in the message they replied to)
- Replying "book karo" to a price-quote message that showed ONLY rates (no
  ton number) → quantity=0 — rates in our own message are NOT a quantity

Hallucinating a quantity creates a WRONG order that the customer did not ask
for — always worse than asking them. When in doubt → quantity=0.

MULTI-ITEM QTY FOLLOW-UP (per-size quantity reply) — CATEGORY AGNOSTIC:
If our PREVIOUS assistant message asked the customer for a per-size quantity
(e.g. "Order book karne ke liye har size ke liye kitna ton chahiye…" followed
by a list of items) and the customer replies with one or more numbers, map
the numbers to the PENDING ITEMS IN THE EXACT ORDER WE LISTED THEM.

This rule works for ANY category — WR, HB, or a mix. The pending items' full
product details (category / gauge / mm / carbon_type) come from OUR prior
listing; the customer's short qty reply won't repeat them but they're still
ordering THOSE items. Do NOT switch category based on the reply alone.

Quantity-reply patterns that ALL mean "is_order=true, use these qtys for the
pending items, in order":
- "2 ton aur 5 mt"  /  "2 ton and 5 mt"  /  "2 aur 5 ton"  /  "2, 5 ton"
    → 1st pending item = 2 tons, 2nd pending item = 5 tons
- "5.5mm 2 ton, 7mm 5 ton"  /  "8mm 3t 10mm 2t"
    → explicit per-size mapping, use exactly as stated
- "3 ton each"  /  "dono 3 ton"  /  "sab 2 ton"
    → every pending item gets that quantity
- If customer gives only ONE number and 2+ items are pending → ambiguous;
  set is_order=false so we re-ask. Do NOT split or duplicate blindly.

Worked examples:
  Prior list = HB 1/0(8mm) + HB 4/0(10mm):
    "2 ton and 5 mt"             → HB 1/0 2 ton + HB 4/0 5 ton
    "8mm 2mt aur 10mm 5mt"       → HB 1/0 2 ton + HB 4/0 5 ton
  Prior list = WR 5.5mm + WR 7mm:
    "2 ton and 5 mt"             → WR 5.5mm 2 ton + WR 7mm 5 ton
    "5.5mm 2mt aur 7mm 5mt"      → WR 5.5mm 2 ton + WR 7mm 5 ton
    "5.5 2 ton, 7 5 ton"         → WR 5.5mm 2 ton + WR 7mm 5 ton
  Prior list = WR 8mm + WR 10mm (user asked WR 8mm/10mm earlier):
    "8mm 2mt aur 10mm 5mt"       → WR 8mm 2 ton + WR 10mm 5 ton
                                   (DO NOT coerce to HB — prior was WR)
  Prior list mixed = WR 5.5mm + HB 1/0(8mm):
    "2 ton aur 3 ton"            → WR 5.5mm 2 ton + HB 1/0 3 ton

"mt" / "mts" / "m.t." ALL mean tons (metric tons) — never millimetres.

REPLY-TO CONTEXT:
- Messages prefixed with "[REPLIED-TO MESSAGE]:" are the original message the customer replied to.
- When customer replies "book karo" / "confirm karo" / "ye le lo" to an old price message,
  they want to ORDER the items from that original price message.
- Extract the product details and quantity from the replied-to message.
- Example: User replies "book karo" to a message that showed "WR 5.5mm 5 ton ka rate: ₹47,607/ton"
  → Extract: WR 5.5mm, 5 ton, confirmed.
- If the replied-to message is a price breakdown from our system (starts with "Radhika Steel Raipur"),
  parse the product and quantity from the breakdown shown in that message.

LANGUAGE: Hindi/Hinglish/English mixed. Examples:
- "5.5 3 ton aur hb 5g 5.2 se 5.3mm 2 ton book karo" = WR 5.5mm 3 ton + HB 5g 2 ton (mm_range="5.2-5.3")
- "pakka karo 12mm 5 ton" = WR 12mm 5 ton confirmed
- "le lo 10 ton 5.5" = WR 5.5mm 10 ton confirmed
- "5.5 dia 5 mts book karo" = 5.5mm (WR size) 5 ton confirmed
- "8 dia 3 mts aur hb 12g 2 mts le lo" = WR 8mm 3 ton + HB 12g 2 ton confirmed
- "hb 12g lc 3 ton book karo" = HB 12g LC, 3 ton (carbon_type="lc")
- "5.3 se 5.4 mm lc 2 ton book karo" = HB 5g LC, 2 ton (gauge="5", mm_range="5.3-5.4", carbon_type="lc")
- "hb 8mm 3 ton book karo" = HB 1/0 (7.8-8.6mm), 3 ton (gauge="1/0", mm="8", mm_range="8")
- "hb 8mm 3 ton aur 10mm 2 ton book karo" = TWO HB items:
    (1) HB 1/0 (gauge="1/0", mm="8", mm_range="8"), 3 ton
    (2) HB 4/0 (gauge="4/0", mm="10", mm_range="10"), 2 ton
  Extract BOTH items — user wants both sizes booked.
- User replies "ye confirm karo" to old message showing "WR 12mm 5 ton" = WR 12mm 5 ton confirmed
- User replies "book karo" to old price quote = order those exact items
- After we asked "kitna ton per size" for HB 1/0(8mm) + HB 4/0(10mm):
  - "2 ton and 5 mt"  = HB 1/0 2 ton + HB 4/0 5 ton (mt = tons, not mm!)
  - "2 aur 5 ton"     = HB 1/0 2 ton + HB 4/0 5 ton
  - "3 ton each"      = HB 1/0 3 ton + HB 4/0 3 ton
  - "2 ton"    (only one number, 2 items pending) = is_order=false (ambiguous)
- Fresh multi-item order with per-size qty — use CHAT HISTORY to pick category:
  - "book 8mm 2mt aur 10mm 5mt" with NO prior HB context in history
    → TWO WR items: WR 8mm 2 ton + WR 10mm 5 ton (default WR for those sizes)
  - "book 8mm 2mt aur 10mm 5mt" when we JUST quoted HB 8mm + HB 10mm
    → TWO HB items: HB 1/0 (8mm) 2 ton + HB 4/0 (10mm) 5 ton
      (user is ordering the HB sizes we just quoted — chat history wins over
       the "WR default for whole-mm value" rule)
  - "8mm 2mt aur 10mm 5mt" (NO "book" keyword) right after we asked qty per
    size → is_order=true, take CATEGORY from the items we just listed:
      • prior list HB 1/0 + HB 4/0 → HB 1/0 2 ton + HB 4/0 5 ton
      • prior list WR 8mm + WR 10mm → WR 8mm 2 ton + WR 10mm 5 ton
  - "5.5mm 2mt aur 7mm 5mt" (NO "book" keyword) right after we asked qty per
    size for WR 5.5mm + WR 7mm → WR 5.5mm 2 ton + WR 7mm 5 ton, is_order=true

BINDING WIRE EXAMPLES:
- "binding 20g 5 ton book karo" → category=binding, gauge=20, packaging=without,
  random=false, quantity=5, unit=ton
- "binding 18g 3 ton aur 20g 2 ton" → TWO items (both category=binding)
- "binding 20g wrapper 5 ton" → category=binding, gauge=20, packaging=with
- "binding 20 random 3 ton book karo" → category=binding, gauge=20, random=true,
  packaging=without (default)
- After we quoted 18g/20g/20g-random and user said "20g 5 ton book karo"
  → category=binding, gauge=20, packaging=without (they didn't say wrapper)

NAILS EXAMPLES (unit MUST be "kg"):
- 'nails 8g 3" 500 kg book karo' → category=nails, gauge=8, size="3", quantity=500, unit=kg
- "nails 10 gauge 2.5 inch 1 ton" → category=nails, gauge=10, size="2.5",
  quantity=1000 (convert 1 ton → 1000 kg), unit=kg
- "nails 8g 3 inch 500 kg aur 8g 4 inch 500 kg" → TWO nails items
- After we quoted default nails and user said "8g 3 inch 500 kg"
  → category=nails, gauge=8, size="3", quantity=500, unit=kg

MULTI-CATEGORY MIXED ORDER EXAMPLES:
- "5.5 wr 2mt binding 20g 5mt nails 8g 2 inch 500kg book karo" → THREE items:
    (1) category=wr, size="5.5", quantity=2, unit=ton
    (2) category=binding, gauge=20, packaging=without, random=false, quantity=5, unit=ton
    (3) category=nails, gauge=8, size="2", quantity=500, unit=kg
- "hb 8mm 3 ton aur binding 18g 2 ton book karo" → TWO items:
    (1) category=hb, gauge="1/0", mm="8", mm_range="8", quantity=3
    (2) category=binding, gauge=18, packaging=without, quantity=2
- After we quoted WR 5.5mm + Binding 20g + Nails 8G 3", user says
  "2 ton, 5 ton, 500 kg book karo" → map IN ORDER to the pending items:
    (1) WR 5.5mm 2 ton
    (2) Binding 20g 5 ton (carry the gauge/packaging from our prior listing)
    (3) Nails 8G 3" 500 kg

⚠️ HB MM RANGE — CRITICAL:
Whenever the customer specifies an HB wire mm size or range (e.g. "5.2 se 5.3",
"5.3 mm", "4.8-5.0"), set BOTH gauge AND mm_range fields:
- "5.2 se 5.3 mm 6 ton" → gauge="5", mm_range="5.2-5.3", quantity=6
- "5.3 dia 2 ton"       → gauge="5", mm_range="5.3",      quantity=2
- "hb 5g 2 ton"         → gauge="5", mm_range=""          (no specific mm given)
Admin uses mm_range to know the EXACT size the customer wants. Never drop it.

Return ONLY the function call.`;

const ORDER_VERIFY_TOOLS = [
  {
    type: "function",
    function: {
      name: "verify_order",
      description: "Verify if customer is placing an order and extract items",
      parameters: {
        type: "object",
        properties: {
          is_order: {
            type: "boolean",
            description: "true if customer is genuinely placing/confirming an order",
          },
          items: {
            type: "array",
            description: "List of items the customer wants to order",
            items: {
              type: "object",
              properties: {
                category: { type: "string", enum: ["wr", "hb", "binding", "nails"] },
                size: { type: "string", description: "WR size in mm (e.g. '5.5'). Nails: inch as string (e.g. '3', '2.5'). Empty if HB/binding." },
                gauge: { type: "string", description: "HB gauge (e.g. '5', '3/0'). Binding: '18' or '20'. Nails: '6', '8', '9', '10', '11', '13'. Empty if WR." },
                mm: { type: "string", description: "HB single mm value (e.g. '5.3'). Empty otherwise." },
                mm_range: {
                  type: "string",
                  description: "User's EXACT requested mm range for HB wire as they said it — e.g. '5.2-5.3' for '5.2 se 5.3 mm', or '5.3' if they gave a single value. Empty if WR/binding/nails or only gauge was given.",
                },
                carbon_type: { type: "string", enum: ["normal", "lc"], description: "Only meaningful for WR/HB. Always 'normal' for binding/nails." },
                packaging: { type: "string", enum: ["with", "without", ""], description: "Binding wire only. 'without' (default) unless customer explicitly says wrapper/packing. Empty for other categories." },
                random: { type: "boolean", description: "Binding wire only. True if customer said 'random' (applies to 20g only). False otherwise." },
                quantity: { type: "number", description: "Quantity. Tons for WR/HB/binding, kg for nails. 0 if not stated." },
                unit: { type: "string", enum: ["ton", "kg"], description: "'ton' for WR/HB/binding, 'kg' for nails. REQUIRED — nails must be 'kg'." },
              },
              required: ["category", "quantity", "unit"],
            },
          },
          customer_note: {
            type: "string",
            description: "Any special instructions from customer (delivery location, firm name, etc.)",
          },
        },
        required: ["is_order", "items"],
      },
    },
  },
];

const verifyOrder = async (recentMessages) => {
  const start = Date.now();

  try {
    const response = await getClient().chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: "system", content: ORDER_VERIFY_PROMPT },
        ...recentMessages,
      ],
      tools: ORDER_VERIFY_TOOLS,
      tool_choice: { type: "function", function: { name: "verify_order" } },
      temperature: 0.1,
      max_tokens: 512,
    });

    const choice = response.choices[0];
    const tc = choice.message?.tool_calls?.[0];
    let result = null;

    if (tc?.function?.arguments) {
      try {
        result = JSON.parse(tc.function.arguments);
      } catch { /* parse error */ }
    }

    const usage = response.usage || {};
    logger.info(`[OPENAI] Order verified in ${Date.now() - start}ms, tokens=${usage.total_tokens || 0}, is_order=${result?.is_order}`);

    return {
      result,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      },
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    logger.error(`[OPENAI] verifyOrder FAILED: ${err.message}`);
    throw err;
  }
};

/**
 * Extract billing details (firm name, GST number) from user's message.
 */
const BILLING_EXTRACT_TOOLS = [
  {
    type: "function",
    function: {
      name: "extract_billing",
      description: "Extract firm name and GST number from the customer's message",
      parameters: {
        type: "object",
        properties: {
          firm_name: { type: "string", description: "Firm or company name. Empty if not found." },
          gst_no: { type: "string", description: "GST number (15-char alphanumeric). Empty if not found." },
          bill_name: { type: "string", description: "Billing name if different from firm name. Empty if not found." },
          has_details: { type: "boolean", description: "true if at least firm name OR GST was found" },
        },
        required: ["firm_name", "gst_no", "has_details"],
      },
    },
  },
];

const extractBillingDetails = async (userMessage) => {
  const start = Date.now();
  try {
    const response = await getClient().chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: `Extract the firm name and GST number from the customer's message. The customer is a steel buyer in India.
GST numbers are 15 characters: 2 digits (state) + 10 chars (PAN) + 1 digit + 1 letter + 1 checksum.
Example: "27AABCU9603R1ZM"
The customer may send them in one message or separately. Extract whatever is available.
If the message doesn't contain billing info (e.g. it's a question or unrelated), set has_details=false.`,
        },
        { role: "user", content: userMessage },
      ],
      tools: BILLING_EXTRACT_TOOLS,
      tool_choice: { type: "function", function: { name: "extract_billing" } },
      temperature: 0.1,
      max_tokens: 256,
    });

    const tc = response.choices[0]?.message?.tool_calls?.[0];
    let result = null;
    if (tc?.function?.arguments) {
      try { result = JSON.parse(tc.function.arguments); } catch { /* parse error */ }
    }
    const usage = response.usage || {};
    logger.info(`[OPENAI] Billing extracted in ${Date.now() - start}ms, tokens=${usage.total_tokens || 0}, has=${result?.has_details}`);
    return {
      result,
      usage: { totalTokens: usage.total_tokens || 0 },
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    logger.error(`[OPENAI] extractBillingDetails FAILED: ${err.message}`);
    throw err;
  }
};

module.exports = { classifyIntent, generateResponse, verifyOrder, extractBillingDetails };
