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
   If user says "hb rate" without gauge → assume 12g (base gauge)
   
   HB mm-to-gauge mapping examples:
   - 2.4-2.8mm = 12g | 3.0-3.4mm = 10g | 4.8-5.2mm = 6g
   - 5.2-5.6mm = 5g | 7.2-7.8mm = 1g | 8.6-9.2mm = 2/0 | 11.0-11.8mm = 6/0
   
   When user says mm size in HB range (1.6mm to 11.8mm), that's HB not WR.
   Examples: "5.3 se 5.4mm" → HB 5g | "6.8 mm" → HB 2g | "9.5mm" → HB 4/0

═══ LANGUAGE — Hindi/Hinglish/English ═══

Steel traders speak mixed Hindi-English. Read the FULL sentence before deciding.

═══ UNIT ALIASES (all mean the same: ton) ═══
ton = tons = tonne = tonnes = mt = mts = m.t. = metric ton = metric tons
Example: "5.5 10 mts" = "5.5 10 mt" = "5.5 10 ton" → WR 5.5mm 10 tons
"dia" / "diameter" just means mm size. It is NOT category-specific.
Determine category from the actual mm value:
- If mm is an available WR size (5.5, 7, 8, 10, 12, 14, 16, 18) → WR
- If mm is in HB range (1.6-11.8) and NOT a WR size → HB
Example: "5.5 dia" = 5.5mm → WR | "5.3 dia" = 5.3mm → HB (5g range) | "8 dia" = 8mm → WR

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

- Minimum per item: 2 ton
- Minimum total order: 5 ton
- Advance payment: ₹50,000 for booking
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

═══ WHAT NEEDS ADMIN ═══

needs_admin=true:
- Negotiation/discount requests
- Delivery inquiries WITHOUT DB context (no active orders)
- Complaints or frustration
- Anything you are NOT 100% sure about

needs_admin=false:
- Price inquiries (our system handles prices)
- Greetings, thanks
- Order process/minimum quantity questions (our system handles)
- Follow-ups on previously discussed products
- Order confirmations with product+quantity
- Delivery inquiries WITH active orders in DB context

═══ GOLDEN RULE ═══

Read the FULL message. Don't match single words.
If NOT SURE → intent="unknown", needs_admin=true.
Better to ask admin than give wrong answer.

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
- For order process: minimum 2 ton per item, total 5 ton. Advance ₹50,000.
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
- WR (Wire Rod): sizes 5.5mm, 7mm, 8mm, 10mm, 12mm, 14mm, 16mm, 18mm. Carbon: normal or lc (low carbon).
- HB Wire: gauges 1g-14g, 1/0-6/0. Specified in mm ranges like "5.3 se 5.4mm".

QUANTITY RULES:
- Each item minimum: 2 tons
- Total across all items minimum: 5 tons
- Default unit is "ton" unless specified otherwise
- ton = tons = tonne = tonnes = mt = mts = m.t. = metric ton — ALL SAME (1 ton = 1000 kg)
- "dia" / "diameter" = just means mm size. Determine WR/HB from the value.

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
- "5.5 3 ton aur hb 5g 5.2 se 5.3mm 2 ton book karo" = WR 5.5mm 3 ton + HB 5g 2 ton
- "pakka karo 12mm 5 ton" = WR 12mm 5 ton confirmed
- "le lo 10 ton 5.5" = WR 5.5mm 10 ton confirmed
- "5.5 dia 5 mts book karo" = 5.5mm (WR size) 5 ton confirmed
- "8 dia 3 mts aur hb 12g 2 mts le lo" = WR 8mm 3 ton + HB 12g 2 ton confirmed
- User replies "ye confirm karo" to old message showing "WR 12mm 5 ton" = WR 12mm 5 ton confirmed
- User replies "book karo" to old price quote = order those exact items

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
                category: { type: "string", enum: ["wr", "hb"] },
                size: { type: "string", description: "WR size in mm (e.g. '5.5'). Empty if HB." },
                gauge: { type: "string", description: "HB gauge (e.g. '5', '3/0'). Empty if WR." },
                mm: { type: "string", description: "HB mm range (e.g. '5.3'). Empty if WR or not specified." },
                carbon_type: { type: "string", enum: ["normal", "lc"] },
                quantity: { type: "number", description: "Quantity in tons" },
              },
              required: ["category", "quantity"],
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
