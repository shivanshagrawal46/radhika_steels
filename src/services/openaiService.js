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
    logger.info(`[OPENAI] Creating client — key starts with: ${key.substring(0, 12)}...`);
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
   "dia" = "diameter" = mm size (e.g., "5.5 dia" = WR 5.5mm)

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

Steel traders speak mixed Hindi-English. CRITICAL examples:
- "5.5 wr" or just "5.5" → WR 5.5mm price
- "5.5 10 ton" or "5.5 10 mt" → WR 5.5mm, 10 tons
- "5.5 lc" or "5.5 10 mt lc" → WR 5.5mm Low Carbon
- "12 mm wr lc" → WR 12mm LC
- "hb rate" or "hb" → HB 12g price
- "12g" or "12 gauge" → HB 12g
- "3/0" or "3/0g" → HB 3/0 gauge
- "5.3 se 5.4mm" → HB wire in that mm range (gauge 5)
- "6.8 se 6.9mm 5 ton" → HB 2g, 5 tons
- "gadi nikli kya" / "maal kab aayega" / "vehicle update" → delivery inquiry
- "thoda kam karo" / "discount" / "best rate do" → negotiation
- "pakka" / "confirm" / "book karo" / "done" / "final" → order confirmation
- "rate" / "Rate" / "bhav" / "aaj ka rate" → general price inquiry (default WR 5.5mm)
- "?" / "." / "haan" as reply to old message → follow-up (same product as before)
- "nahi chahiye" / "cancel" / "rehne do" → rejection
- "kitna hua" / "total batao" → asking for total calculation
- "LC mein kya rate hai" → asking Low Carbon for previously discussed product

═══ CONTEXT RULES ═══

1. Look at the last 5 messages. If user sent a short message ("?", "rate", ".", "haan"), and previous messages discussed a specific product → that's a follow_up for the SAME product.
2. If user asks "LC mein?" after discussing WR 12mm → they want WR 12mm LC price.
3. If user says just a number like "10" after discussing a product → could be quantity (10 tons).
4. When user sends mm size between 1.6-11.8mm WITHOUT "wr" keyword → it's HB wire, not WR.
5. Negotiation/discount requests → needs_admin=true (human should handle).
6. Delivery/dispatch inquiries → needs_admin=true.
7. Complaints or frustration → needs_admin=true, emotion=frustrated.

Return ONLY the function call, nothing else.`;

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
            enum: ["price_inquiry", "order_confirm", "negotiation", "delivery_inquiry", "greeting", "thanks", "follow_up", "unknown"],
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
const classifyIntent = async (recentMessages) => {
  const start = Date.now();

  try {
    const response = await getClient().chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: "system", content: INTENT_SYSTEM_PROMPT },
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
const generateResponse = async (recentMessages, context = "") => {
  const start = Date.now();
  const systemMsg = `You are the AI assistant for Radhika Steel Raipur, a major steel trading company in Chhattisgarh, India.

RULES:
- Reply in the SAME language the customer uses (Hindi/Hinglish/English)
- Keep it to 2-3 lines maximum
- Be professional, warm, and helpful — like a senior salesperson
- NEVER quote any prices, amounts, or rates — our system handles pricing separately
- If asked about prices, say "Abhi rate check karke batata hoon"
- If you don't understand, ask politely to clarify
- Use "aap" (respectful form), never "tu" or "tum"
- For negotiation/complaints, reassure the customer and say their request is being forwarded to the team

COMPANY CONTEXT:
- Products: Wire Rod (WR), HB Wire, Binding Wire, Nails
- Location: Raipur, Chhattisgarh
- Customers are mostly Hindi-speaking steel traders and builders
- "gadi" = truck/vehicle for delivery
- "maal" = material/goods
- "advance" = advance payment for orders${context ? "\n\nAdditional context: " + context : ""}`;

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

Look at the last 6-7 messages and determine:
1. Is the customer genuinely confirming/placing an order? (not just asking prices)
2. What items do they want to order? Extract ALL items with quantities.

PRODUCTS:
- WR (Wire Rod): sizes 5.5mm, 7mm, 8mm, 10mm, 12mm, 14mm, 16mm, 18mm. Carbon: normal or lc (low carbon).
- HB Wire: gauges 1g-14g, 1/0-6/0. Specified in mm ranges like "5.3 se 5.4mm".

QUANTITY RULES:
- Each item minimum: 2 tons
- Total across all items minimum: 5 tons
- Default unit is "ton" unless specified otherwise

LANGUAGE: Hindi/Hinglish/English mixed. Examples:
- "5.5 3 ton aur hb 5g 5.2 se 5.3mm 2 ton book karo" = WR 5.5mm 3 ton + HB 5g 2 ton
- "pakka karo 12mm 5 ton" = WR 12mm 5 ton confirmed
- "le lo 10 ton 5.5" = WR 5.5mm 10 ton confirmed

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

module.exports = { classifyIntent, generateResponse, verifyOrder };
