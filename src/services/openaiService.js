const OpenAI = require("openai");
const env = require("../config/env");
const logger = require("../config/logger");

let _openai = null;
const getClient = () => {
  if (!_openai) {
    const key = env.OPENAI_API_KEY;
    if (!key) {
      const msg = "OPENAI_API_KEY is not set! Cannot create OpenAI client.";
      logger.error(`[OPENAI] ${msg}`);
      throw new Error(msg);
    }
    logger.info(`[OPENAI] Creating client — key starts with: ${key.substring(0, 8)}...`);
    _openai = new OpenAI({ apiKey: key });
  }
  return _openai;
};

// ──────────────────────────────────────────────────────
// SYSTEM PROMPT — Steel trading domain expert
// ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the AI sales assistant for **Radhika Steels**, a steel trading company in India.

## Your Personality
- Professional, helpful, concise.
- Reply in the same language the customer uses (Hindi, Hinglish, or English).
- Keep replies short — 2-4 lines max unless explaining a price table.
- Use ₹ symbol for prices. Format large numbers Indian-style (e.g. ₹49,023).

## Products You Handle
1. **WR (Wire Rod)** — ONLY these sizes: 5.5mm, 7mm, 8mm, 10mm, 12mm, 14mm, 16mm, 18mm
   - Carbon types: Normal (HC), Low Carbon (LC — adds ₹800)
   - "dia" = diameter = mm (same thing)
2. **HB Wire** — base gauge: 12g
   - HB base = WR base rate + ₹2,500

## CRITICAL — Unavailable Sizes
We ONLY carry: 5.5, 7, 8, 10, 12, 14, 16, 18 mm in wire rod.
If a customer asks for ANY size we DON'T carry (e.g. 6mm, 9mm, 11mm, 13mm, 15mm, 17mm, 20mm, etc.):
1. Politely say we don't have that exact size.
2. Immediately suggest the closest sizes we DO carry (one smaller, one larger).
3. Show the rates for BOTH closest sizes so they can choose.

Example — if user says "6 mm dia 5 ton":
  "6mm hamare paas available nahi hai. Nearest sizes:
   *5.5mm:* ₹40,000 + ₹345 + 18% GST = *Total: ₹47,607/ton*
   *7mm:* ₹40,000 + ₹800 + ₹345 + 18% GST = *Total: ₹48,551/ton*
   5 ton ke liye: 5.5mm = ₹2,38,035 | 7mm = ₹2,42,755
   Kaunsa chahiye? Bataiye."

Example — if user says "9mm wr":
  "9mm available nahi hai. Nearest sizes:
   *8mm:* (show rate)
   *10mm:* (show rate)
   Kaunsa size chahiye?"

## How Customers Ask (understand ALL of these):
- "5.5 wr" or "5.5" or "5.5mm rate" → WR 5.5mm price
- "5.5 10 ton" or "5.5 10 mt" → WR 5.5mm, 10 tons
- "5.5 10 mt lc" or "5.5 lc" → WR 5.5mm Low Carbon
- "12 wr lc" → WR 12mm Low Carbon
- "6 mm dia" or "6mm" → We DON'T have this, suggest 5.5mm and 7mm
- "hb rate" or "hb 12g" → HB 12 gauge
- "gadi nikli kya" / "maal kab tak aayega" / "vehicle update" → delivery status inquiry
- "rate batao" / "aaj ka rate" / "bhav kya hai" → general price inquiry
- "confirm karo" / "book kar do" / "pakka" / "done" → order confirmation
- "thoda kam karo" / "discount" / "best rate do" → negotiation

## Price Response Format
ALL prices are PER TON (1 ton = 1000 kg). ALWAYS mention "/ton" or "per ton" when quoting a rate.
When giving a price, ALWAYS use this format:
Line 1: Base rate breakdown (e.g. ₹40,000 + ₹800 + ₹345 + 18% GST)
Line 2: *Total: ₹XX,XXX/ton*

If the customer asks for a quantity, also show:
Line 3: For X tons: ₹XX,XX,XXX (total = rate per ton × quantity)

## Rules
- NEVER make up prices. ONLY use the prices from the context provided below.
- If no price context is available, say "Rate abhi update nahi hua hai, team se confirm karke batate hain."
- When a customer confirms an order, ask for: quantity, delivery location, and firm/GST details.
- When a customer negotiates, respond politely that you'll check with the team. Say "Main apki baat team tak pahunchata hoon."
- For delivery inquiries, say you'll check the dispatch status and update them.
- If a user sends just a size number (like "5.5" or "12"), assume they want the WR rate for that size.
- If a user sends a size + quantity (like "5.5 10"), assume WR, that size, that quantity in tons.
- If a user asks for a size we don't carry, ALWAYS suggest the nearest available sizes with rates.

## Important Context
- "mt" = metric ton = ton
- "lc" = Low Carbon
- "hc" = High Carbon (normal/default)
- "g" after number = gauge (for HB, e.g. "12g")
- "dia" = diameter = mm
- "gadi" = vehicle/truck (delivery related)
- "nikli" = dispatched
- "maal" = goods/material`;

// ──────────────────────────────────────────────────────
// OpenAI function definitions for structured extraction
// ──────────────────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "extract_product_inquiry",
      description: "Extract structured product inquiry from user message when they ask about a steel product price or want to place an order.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["wr", "hb"],
            description: "Product category: wr (wire rod) or hb",
          },
          size: {
            type: "string",
            description: "Size in mm for WR (e.g. '5.5', '12') or gauge for HB (e.g. '12')",
          },
          carbon_type: {
            type: "string",
            enum: ["normal", "lc"],
            description: "Carbon type. 'lc' for low carbon, 'normal' otherwise",
          },
          quantity: {
            type: "number",
            description: "Quantity requested (0 if not specified)",
          },
          unit: {
            type: "string",
            enum: ["ton", "kg", "bundle", "coil"],
            description: "Unit for quantity",
          },
          intent: {
            type: "string",
            enum: ["price_inquiry", "order_confirm", "negotiation", "delivery_inquiry", "greeting", "general"],
            description: "The user's primary intent",
          },
        },
        required: ["intent"],
      },
    },
  },
];

/**
 * Chat completion with steel-domain context + optional function calling.
 */
const getChatCompletion = async (messages, context = "", parsedIntent = null) => {
  const systemMessages = [{ role: "system", content: SYSTEM_PROMPT }];

  if (context) {
    systemMessages.push({
      role: "system",
      content: `## Current Price Data\n${context}`,
    });
  }

  // Inject parsed intent as a hint to the AI
  if (parsedIntent && parsedIntent.intent !== "unknown") {
    systemMessages.push({
      role: "system",
      content: `## Pre-parsed Intent (from our NLP)\n${JSON.stringify(parsedIntent, null, 2)}\nUse this to understand what the customer wants. Respond with the appropriate price if it's a price inquiry.`,
    });
  }

  const start = Date.now();

  try {
    const response = await getClient().chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [...systemMessages, ...messages],
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.3,
      max_tokens: 1024,
    });

    const choice = response.choices[0];
    let reply = choice.message?.content || "";
    let functionCall = null;

    // Handle function call if the AI used one
    if (choice.message?.tool_calls?.length > 0) {
      const tc = choice.message.tool_calls[0];
      if (tc.function?.name === "extract_product_inquiry") {
        try {
          functionCall = JSON.parse(tc.function.arguments);
        } catch { /* ignore parse errors */ }
      }

      // If the AI only returned a function call without text, do a follow-up
      if (!reply && functionCall) {
        const followUp = await getClient().chat.completions.create({
          model: env.OPENAI_MODEL,
          messages: [
            ...systemMessages,
            ...messages,
            choice.message,
            {
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ status: "ok", extracted: functionCall }),
            },
          ],
          temperature: 0.3,
          max_tokens: 1024,
        });
        reply = followUp.choices[0]?.message?.content || "";
      }
    }

    const usage = response.usage || {};
    logger.debug(`OpenAI response in ${Date.now() - start}ms, tokens: ${usage.total_tokens}`);

    return {
      reply,
      functionCall,
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      },
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    logger.error(`[OPENAI] API call FAILED: ${err.message}`);
    if (err.status) logger.error(`[OPENAI] HTTP status: ${err.status}`);
    if (err.code) logger.error(`[OPENAI] Error code: ${err.code}`);
    throw err;
  }
};

/**
 * Generate embeddings for RAG storage / retrieval.
 */
const getEmbedding = async (text) => {
  try {
    const response = await getClient().embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return response.data[0].embedding;
  } catch (err) {
    logger.error("OpenAI embedding error:", err.message);
    throw err;
  }
};

module.exports = { getChatCompletion, getEmbedding };
