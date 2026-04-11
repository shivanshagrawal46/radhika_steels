const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const uuidv4 = () => crypto.randomUUID();
const { User, Conversation, Message, Order, Contact } = require("../models");
const whatsappService = require("./whatsappService");
const openaiService = require("./openaiService");
const pricingService = require("./pricingService");
const responseBuilder = require("./responseBuilder");
const intentParser = require("./intentParser");
const env = require("../config/env");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");

const getIO = () => require("../socket").getIO();

const STAGE_ORDER = [
  "talking", "price_inquiry", "negotiation", "order_confirmed",
  "advance_pending", "advance_received", "payment_complete",
  "dispatched", "delivered", "closed",
];

const EMPLOYEE_LOCK_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function canAutoAdvance(currentStage, newStage) {
  return STAGE_ORDER.indexOf(newStage) > STAGE_ORDER.indexOf(currentStage);
}

function isEmployeeLocked(conversation) {
  if (conversation.handlerType !== "employee") return false;
  if (!conversation.employeeTakenAt) return false;
  const elapsed = Date.now() - new Date(conversation.employeeTakenAt).getTime();
  if (elapsed > EMPLOYEE_LOCK_TTL_MS) {
    logger.info(`[CHAT] 12hr auto-reset: conv=${conversation._id} released back to AI`);
    return false;
  }
  return true;
}

async function autoResetIfExpired(conversation) {
  if (conversation.handlerType === "employee" && conversation.employeeTakenAt) {
    const elapsed = Date.now() - new Date(conversation.employeeTakenAt).getTime();
    if (elapsed > EMPLOYEE_LOCK_TTL_MS) {
      conversation.handlerType = "ai";
      conversation.employeeTakenAt = null;
      await conversation.save();
      const io = getIO();
      io.to("employees").emit("chat:conversation_updated", {
        conversationId: conversation._id.toString(),
        handlerType: "ai",
        autoReset: true,
      });
      return true;
    }
  }
  return false;
}

function getDisplayName(user, contacts) {
  if (user.partyName) return user.partyName;
  if (user.firmName) return user.firmName;
  if (contacts && contacts.length > 0) return contacts[0].contactName;
  if (user.contactName) return user.contactName;
  if (user.name) return user.name;
  return user.phone || user.waId;
}

// ─────────────────────────────────────────────────────
// ORDER CONFIRMATION HELPER — DB-first, then template
// ─────────────────────────────────────────────────────
async function processOrderConfirmation(orderResult, conversation, user, io, from, displayName) {
  const items = orderResult.items.map((i) => ({
    category: i.category, size: i.size || null, gauge: i.gauge || null,
    mm: i.mm || null, carbonType: i.carbon_type || "normal", quantity: i.quantity || 0,
  }));

  const totalQty = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
  const belowMin = items.filter((i) => (i.quantity || 0) < responseBuilder.MIN_QTY_PER_ITEM);

  if (belowMin.length > 0 || totalQty < responseBuilder.MIN_QTY_TOTAL) {
    return responseBuilder.buildMinQtyError(items);
  }

  // Calculate prices and build order items FIRST
  let grandTotal = 0;
  const orderItems = [];
  for (const item of items) {
    let price = null;
    try {
      if (item.category === "wr") {
        price = await pricingService.calculatePrice("wr", { size: item.size || "5.5", carbonType: item.carbonType });
      } else if (item.category === "hb") {
        price = item.mm
          ? await pricingService.calculatePrice("hb", { mm: item.mm })
          : await pricingService.calculatePrice("hb", { gauge: item.gauge || "12" });
      }
    } catch (err) {
      logger.warn(`[ORDER] Price calc failed: ${err.message}`);
    }
    const unitPrice = price ? price.total : 0;
    const itemTotal = Math.round(unitPrice * (item.quantity || 0));
    grandTotal += itemTotal;
    orderItems.push({
      category: item.category,
      productName: price ? price.label : `${(item.category || "").toUpperCase()} ${item.size || item.gauge || ""}`.trim(),
      size: item.size, gauge: item.gauge, mm: item.mm, carbonType: item.carbonType,
      quantity: item.quantity, unit: "ton", unitPrice, totalPrice: itemTotal,
    });
  }

  // Save order to DB FIRST — only send confirmation if DB succeeds
  try {
    const order = await Order.create({
      conversation: conversation._id,
      user: user._id,
      items: orderItems,
      pricing: { grandTotal },
      status: "advance_pending",
      advancePayment: { amount: responseBuilder.ADVANCE_AMOUNT, isPaid: false },
      notes: orderResult.customer_note || "",
    });

    // Link order to conversation
    conversation.stage = "order_confirmed";
    conversation.linkedOrder = order._id;
    conversation.markModified("context");
    await conversation.save();

    io.to("employees").emit("order:new", {
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      conversationId: conversation._id.toString(),
      items: orderItems,
      grandTotal,
      userId: user._id.toString(),
      userName: displayName || user.name || from,
    });

    logger.info(`[ORDER] ${order.orderNumber} created, total=₹${grandTotal}`);

    // Only build confirmation text AFTER successful DB save
    return await responseBuilder.buildOrderConfirmation(items);
  } catch (err) {
    logger.error(`[ORDER] DB save failed: ${err.message}`);
    return null; // Don't send confirmation if DB failed
  }
}

// ─────────────────────────────────────────────────────
// INCOMING MESSAGE — Layered: Parser → Template → GPT fallback
// ─────────────────────────────────────────────────────
const handleIncomingMessage = async (parsed) => {
  const { from, waMessageId, name, text, timestamp, messageType } = parsed;
  logger.info(`[CHAT] ─── START from=${from} text="${(text || "").substring(0, 60)}" ───`);
  const io = getIO();

  // 1. Upsert user
  const user = await User.findOneAndUpdate(
    { waId: from },
    { $set: { phone: from, name: name || undefined, lastMessageAt: new Date() }, $setOnInsert: { waId: from } },
    { upsert: true, returnDocument: "after" }
  );
  if (user.isBlocked) { logger.info(`[CHAT] Blocked user ${from}`); return; }

  // 2. Get or create conversation
  let conversation = await Conversation.findOne({ user: user._id, status: "active" });
  const isNewConversation = !conversation;
  if (!conversation) {
    conversation = await Conversation.create({ user: user._id, handlerType: "ai" });
  }

  // 2a. Ensure context subdocument exists (guards against old docs missing it)
  if (!conversation.context) {
    conversation.context = {};
  }
  if (!conversation.context.lastDetectedProduct) {
    conversation.context.lastDetectedProduct = {};
  }

  // 2b. Auto-reset expired employee lock
  await autoResetIfExpired(conversation);

  // 2c. Resolve display name (party > contact import > WA name > phone)
  const contacts = await Contact.find({ phone: from }).lean();
  const displayName = getDisplayName(user, contacts);

  // 3. Handle media
  const mediaData = await downloadMediaIfPresent(parsed);

  // 4. Check reply-to context
  let replyToContext = null;
  if (parsed.context?.id) {
    const replyToMsg = await Message.findOne({ waMessageId: parsed.context.id }).lean();
    if (replyToMsg) {
      replyToContext = {
        text: replyToMsg.content?.text || "",
        senderType: replyToMsg.sender?.type || "",
        aiMetadata: replyToMsg.aiMetadata || {},
      };
    }
  }

  // 5. Save incoming message
  const incomingMsg = await Message.create({
    conversation: conversation._id,
    sender: { type: "user" },
    content: {
      text: text || mediaData.caption || "",
      mediaType: mediaData.mediaType || "none",
      mediaUrl: mediaData.mediaUrl || "",
      mediaLocalPath: mediaData.localPath || "",
      waMediaId: mediaData.waMediaId || "",
      mimeType: mediaData.mimeType || "",
      fileName: mediaData.fileName || "",
      fileSize: mediaData.fileSize || 0,
      caption: mediaData.caption || "",
      latitude: parsed.location?.latitude || null,
      longitude: parsed.location?.longitude || null,
      locationName: parsed.location?.name || "",
    },
    waMessageId,
    waTimestamp: timestamp ? new Date(Number(timestamp) * 1000) : new Date(),
    deliveryStatus: "delivered",
    readByAdmin: false,
  });

  // 5b. Build DB context for AI (delivery, order status, party)
  let dbContext = "";
  try {
    const activeOrders = await Order.find({ user: user._id, status: { $nin: ["delivered", "cancelled"] }, closedAt: null })
      .sort({ createdAt: -1 }).limit(3).lean();
    if (activeOrders.length > 0) {
      const orderLines = activeOrders.map((o) => {
        const itemsStr = o.items.map((it) => `${it.category?.toUpperCase()} ${it.size || it.gauge || ""}${it.carbonType === "lc" ? " LC" : ""} ${it.quantity}T`).join(", ");
        const delivery = o.delivery || {};
        let delStr = "";
        if (delivery.scheduledDate) delStr += ` DeliveryDate=${new Date(delivery.scheduledDate).toLocaleDateString("en-IN")}`;
        if (delivery.driverName) delStr += ` Driver=${delivery.driverName}`;
        if (delivery.driverPhone) delStr += ` DriverPh=${delivery.driverPhone}`;
        if (delivery.vehicleNumber) delStr += ` Vehicle=${delivery.vehicleNumber}`;
        if (delivery.dispatchedAt) delStr += ` Dispatched=${new Date(delivery.dispatchedAt).toLocaleDateString("en-IN")}`;
        return `Order#${o.orderNumber} Status=${o.status} Items=[${itemsStr}] Total=₹${o.pricing?.grandTotal || 0}${delStr}`;
      });
      dbContext += `\n\nACTIVE ORDERS for this customer:\n${orderLines.join("\n")}`;
    }

    if (user.partyName || user.firmName || user.gstNo) {
      dbContext += `\n\nPARTY DETAILS: Name=${user.partyName || "-"} Firm=${user.firmName || "-"} GST=${user.gstNo || "-"} City=${user.city || "-"}`;
    }
  } catch (err) {
    logger.warn(`[CHAT] DB context build failed: ${err.message}`);
  }

  // 6. LAYER 1 — Intent parsing (FREE)
  let parsedIntent = intentParser.parse(text);
  logger.info(`[CHAT] L1 Parser: intent=${parsedIntent.intent}, cat=${parsedIntent.category || "-"}, conf=${parsedIntent.confidence}`);

  // 7. LAYER 1b — Reply-to context enrichment
  if (replyToContext) {
    const oldParsed = intentParser.parse(replyToContext.text);

    if (parsedIntent.intent === "follow_up" && oldParsed.category) {
      parsedIntent.category = oldParsed.category;
      parsedIntent.size = oldParsed.size;
      parsedIntent.gauge = oldParsed.gauge;
      parsedIntent.mm = oldParsed.mm;
      parsedIntent.carbonType = oldParsed.carbonType;
      parsedIntent.intent = "price_inquiry";
      parsedIntent.confidence = 0.9;
      logger.info(`[CHAT] L1b Reply-to enriched (follow_up): cat=${parsedIntent.category}, size=${parsedIntent.size || parsedIntent.gauge}`);
    }

    // If user replies to an old message with "book karo" / "confirm karo",
    // carry over the product details from the replied-to message
    if (parsedIntent.intent === "order_confirm" && oldParsed.category && !parsedIntent.category) {
      parsedIntent.category = oldParsed.category;
      parsedIntent.size = oldParsed.size;
      parsedIntent.gauge = oldParsed.gauge;
      parsedIntent.mm = oldParsed.mm;
      parsedIntent.carbonType = oldParsed.carbonType;
      parsedIntent.quantity = oldParsed.quantity || parsedIntent.quantity;
      parsedIntent.unit = oldParsed.unit || parsedIntent.unit;
      logger.info(`[CHAT] L1b Reply-to enriched (order_confirm): cat=${parsedIntent.category}, size=${parsedIntent.size || parsedIntent.gauge}, qty=${parsedIntent.quantity}`);
    }
  }

  // If follow_up but no reply-to, use conversation context
  if (parsedIntent.intent === "follow_up" && !replyToContext && conversation.context?.lastDetectedProduct?.category) {
    const ctx = conversation.context.lastDetectedProduct;
    parsedIntent.category = ctx.category;
    parsedIntent.size = ctx.size || null;
    parsedIntent.gauge = ctx.gauge || null;
    parsedIntent.mm = ctx.mm || null;
    parsedIntent.carbonType = ctx.carbonType || "normal";
    parsedIntent.intent = "price_inquiry";
    parsedIntent.confidence = 0.9;
    logger.info(`[CHAT] L1b Context enriched: cat=${parsedIntent.category}, size=${parsedIntent.size || parsedIntent.gauge || parsedIntent.mm}`);
  }

  // If order_confirm but no product details in the text and no reply-to,
  // look at the LAST 2 USER messages (immediate + one before) for product+quantity.
  // Only use recent context — never stale data from days ago.
  if (parsedIntent.intent === "order_confirm" && !parsedIntent.category && !replyToContext) {
    try {
      const recentUserMsgs = await Message.find(
        { conversation: conversation._id, "sender.type": "user", _id: { $ne: incomingMsg._id } },
        { "content.text": 1 },
        { sort: { createdAt: -1 }, limit: 2 }
      ).lean();

      let enrichedFromRecent = false;
      for (const msg of recentUserMsgs) {
        const msgParsed = intentParser.parse(msg.content?.text || "");
        if (msgParsed.category) {
          parsedIntent.category = msgParsed.category;
          parsedIntent.size = msgParsed.size || null;
          parsedIntent.gauge = msgParsed.gauge || null;
          parsedIntent.mm = msgParsed.mm || null;
          parsedIntent.carbonType = msgParsed.carbonType || "normal";
          parsedIntent.quantity = parsedIntent.quantity || msgParsed.quantity || null;
          parsedIntent.unit = parsedIntent.unit || msgParsed.unit || "ton";
          enrichedFromRecent = true;
          logger.info(`[CHAT] L1b Recent-msg enriched (order_confirm): cat=${parsedIntent.category}, size=${parsedIntent.size || parsedIntent.gauge || parsedIntent.mm}, qty=${parsedIntent.quantity}`);
          break;
        }
      }

      if (!enrichedFromRecent && conversation.context?.lastDetectedProduct?.category) {
        const ctx = conversation.context.lastDetectedProduct;
        parsedIntent.category = ctx.category;
        parsedIntent.size = ctx.size || null;
        parsedIntent.gauge = ctx.gauge || null;
        parsedIntent.mm = ctx.mm || null;
        parsedIntent.carbonType = ctx.carbonType || "normal";
        parsedIntent.quantity = null;
        parsedIntent.unit = ctx.unit || "ton";
        logger.info(`[CHAT] L1b Context fallback (order_confirm, no qty): cat=${parsedIntent.category}`);
      }
    } catch (err) {
      logger.warn(`[CHAT] L1b Recent-msg lookup failed: ${err.message}`);
    }
  }

  // ─── Multi-message order flow ───
  // When AI asked "kitna ton chahiye?", the user's next message is the answer.
  // Override whatever the parser detected — "5" is quantity, NOT WR 5mm.
  logger.info(`[CHAT] L1c check: lastIntent="${conversation.context?.lastIntent}", stage="${conversation.stage}", productCtx="${conversation.context?.lastDetectedProduct?.category || "-"}"`);
  let lastWasOrder = conversation.context?.lastIntent === "order_confirm";
  const orderNotYetCreated = conversation.stage !== "order_confirmed";
  const hasProductCtx = conversation.context?.lastDetectedProduct?.category;

  // DB-backed fallback: if context.lastIntent wasn't persisted, check the last AI message
  if (!lastWasOrder && orderNotYetCreated && hasProductCtx) {
    try {
      const lastAiMsg = await Message.findOne(
        { conversation: conversation._id, "sender.type": "ai" },
        { "content.text": 1 },
        { sort: { createdAt: -1 } }
      ).lean();
      const lastAiText = (lastAiMsg?.content?.text || "").toLowerCase();
      if (
        lastAiText.includes("kitna ton") ||
        lastAiText.includes("how many ton") ||
        lastAiText.includes("quantity") ||
        lastAiText.includes("kitni quantity")
      ) {
        lastWasOrder = true;
        logger.info(`[CHAT] L1c DB-fallback: last AI msg was qty ask → treating as order flow`);
      }
    } catch (err) {
      logger.warn(`[CHAT] L1c DB-fallback check failed: ${err.message}`);
    }
  }

  if (lastWasOrder && orderNotYetCreated && hasProductCtx) {
    const ctx = conversation.context.lastDetectedProduct;
    const trimmed = (text || "").trim();

    // Case 1: User sends quantity — "5", "5 ton", "5 ton kariye", "10 mt karo"
    const qtyMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*(?:ton|tons|mt|mts|tonne|tonnes|metric\s*ton)?\s*(?:kariye|karo|kar\s*do|kijiye|please|chahiye|de\s*do|bhejo|book)?[.!?]*$/i);
    if (qtyMatch) {
      const qty = parseFloat(qtyMatch[1]);
      if (qty > 0 && qty <= 1000) {
        parsedIntent.intent = "order_confirm";
        parsedIntent.category = ctx.category;
        parsedIntent.size = ctx.size || null;
        parsedIntent.gauge = ctx.gauge || null;
        parsedIntent.mm = ctx.mm || null;
        parsedIntent.carbonType = ctx.carbonType || "normal";
        parsedIntent.quantity = qty;
        parsedIntent.unit = "ton";
        parsedIntent.sizeAvailable = true;
        parsedIntent.closestSizes = [];
        parsedIntent.confidence = 0.7;
        logger.info(`[CHAT] L1c Order quantity: cat=${ctx.category}, qty=${qty}`);
      }
    }

    // Case 2: User confirms — "ji", "haan", "ok" — use previously discussed quantity
    if (parsedIntent.intent === "follow_up" && ctx.quantity && ctx.quantity > 0) {
      parsedIntent.intent = "order_confirm";
      parsedIntent.category = ctx.category;
      parsedIntent.size = ctx.size || null;
      parsedIntent.gauge = ctx.gauge || null;
      parsedIntent.mm = ctx.mm || null;
      parsedIntent.carbonType = ctx.carbonType || "normal";
      parsedIntent.quantity = ctx.quantity;
      parsedIntent.unit = ctx.unit || "ton";
      parsedIntent.confidence = 0.7;
      logger.info(`[CHAT] L1c Order confirmation: cat=${ctx.category}, qty=${ctx.quantity}`);
    }
  }

  // Update conversation context
  const suggestedStage = intentParser.intentToStage(parsedIntent.intent);
  if (suggestedStage && canAutoAdvance(conversation.stage, suggestedStage)) {
    conversation.stage = suggestedStage;
  }
  if (parsedIntent.category) {
    conversation.context.lastDetectedProduct = {
      category: parsedIntent.category,
      size: parsedIntent.size || "",
      carbonType: parsedIntent.carbonType || "normal",
      quantity: parsedIntent.quantity || 0,
      unit: parsedIntent.unit || "",
      gauge: parsedIntent.gauge || "",
      mm: parsedIntent.mm || "",
    };
  }
  if (parsedIntent.intent === "negotiation") conversation.context.negotiationActive = true;
  if (parsedIntent.intent === "delivery_inquiry") conversation.context.deliveryInquiry = true;
  conversation.context.lastIntent = parsedIntent.intent;
  conversation.markModified("context");

  // 8. Update conversation metadata
  conversation.messageCount += 1;
  conversation.unreadCount += 1;
  conversation.lastMessageAt = new Date();
  conversation.lastMessage = {
    text: text || `[${mediaData.mediaType || messageType}]`,
    senderType: "user",
    mediaType: mediaData.mediaType || "none",
    timestamp: new Date(),
  };
  await conversation.save();
  logger.info(`[CHAT] Context saved: lastIntent=${conversation.context.lastIntent}, product=${conversation.context.lastDetectedProduct?.category || "-"}, qty=${conversation.context.lastDetectedProduct?.quantity || 0}`);

  // 9. Mark read on WhatsApp
  whatsappService.markAsRead(waMessageId);

  // 10. Emit to dashboard
  emitToDashboard(io, conversation, incomingMsg, isNewConversation, parsedIntent, displayName);

  // 10b. If employee is actively handling this chat, skip AI
  if (isEmployeeLocked(conversation)) {
    logger.info(`[CHAT] ─── END from=${from} — SKIPPED (employee handling, taken ${Math.round((Date.now() - new Date(conversation.employeeTakenAt).getTime()) / 60000)}m ago) ───`);
    return;
  }

  // 11. AI tries
  let responseText = null;
  let usedGPT = false;
  let aiUsage = { totalTokens: 0 };
  let responseTimeMs = 0;

  // ─── LAYER 2: Parser confident (>= 0.9) → template directly ───
  if (parsedIntent.confidence >= 0.9) {
    if (parsedIntent.intent === "price_inquiry" && parsedIntent.category === "wr" && !parsedIntent.size) {
      parsedIntent.size = "5.5";
      parsedIntent.sizeAvailable = true;
    }
    if (parsedIntent.intent === "price_inquiry" && parsedIntent.category === "hb" && !parsedIntent.gauge && !parsedIntent.mm) {
      parsedIntent.gauge = "12";
    }

    const templateResult = await responseBuilder.buildFromIntent(parsedIntent);
    if (templateResult && templateResult.isOrderConfirm) {
      logger.info(`[CHAT] L2 Order confirm → sending to GPT for verification`);
    } else if (templateResult && templateResult.text) {
      responseText = templateResult.text;
      usedGPT = false;
      logger.info(`[CHAT] L2 Parser confident (${parsedIntent.confidence}) — intent=${parsedIntent.intent}, cat=${parsedIntent.category || "-"}`);
    }
  }

  // ─── LAYER 2b: Delivery inquiry — check DB for delivery info ───
  if (!responseText && (parsedIntent.intent === "delivery_inquiry" || text.match(/\b(gadi|gaadi|maal|truck|dispatch|deliver|loading)\b/i))) {
    try {
      const activeOrders = await Order.find({ user: user._id, status: { $nin: ["delivered", "cancelled"] }, closedAt: null })
        .sort({ createdAt: -1 }).limit(1).lean();
      if (activeOrders.length > 0) {
        const o = activeOrders[0];
        const d = o.delivery || {};
        if (d.scheduledDate || d.dispatchedAt || d.driverName || d.vehicleNumber) {
          responseText = responseBuilder.buildDeliveryResponse(o);
          usedGPT = false;
          logger.info(`[CHAT] L2b Delivery info from DB for order ${o.orderNumber}`);
        }
      }
    } catch (err) {
      logger.warn(`[CHAT] L2b Delivery check failed: ${err.message}`);
    }
  }

  // ─── LAYER 3: Parser not confident → GPT classifies ───
  if (!responseText) {
    logger.info(`[CHAT] L3 GPT — parser conf=${parsedIntent.confidence}, intent=${parsedIntent.intent}`);

    const recentMessages = await Message.find({ conversation: conversation._id, isDeleted: false })
      .sort({ createdAt: -1 }).limit(7).lean();
    const chatHistory = recentMessages.reverse().map((m) => ({
      role: m.sender.type === "user" ? "user" : "assistant",
      content: m.content.text || `[${m.content.mediaType}]`,
    }));

    try {
      // ─── ORDER CONFIRMATION FLOW ───
      const isOrderIntent = parsedIntent.intent === "order_confirm";
      if (isOrderIntent) {
        logger.info(`[CHAT] L3-ORDER: Verifying with GPT...`);

        // If user replied to an old message, inject it at the top so GPT sees the
        // original product/quantity context even if it's older than the last 7 messages
        let orderChatHistory = chatHistory;
        if (replyToContext && replyToContext.text) {
          const replyRole = replyToContext.senderType === "user" ? "user" : "assistant";
          const alreadyInHistory = chatHistory.some(
            (m) => m.content === replyToContext.text && m.role === replyRole
          );
          if (!alreadyInHistory) {
            orderChatHistory = [
              { role: replyRole, content: `[REPLIED-TO MESSAGE]: ${replyToContext.text}` },
              ...chatHistory,
            ];
            logger.info(`[CHAT] L3-ORDER: Injected reply-to message into GPT context`);
          }
        }

        const { result: orderResult, usage, responseTimeMs: rTime } = await openaiService.verifyOrder(orderChatHistory);
        aiUsage = usage;
        responseTimeMs = rTime;
        usedGPT = true;

        if (orderResult && orderResult.is_order && orderResult.items?.length > 0) {
          const orderRes = await processOrderConfirmation(orderResult, conversation, user, io, from, displayName);
          if (orderRes) responseText = orderRes;
        }

        // Fallback: GPT couldn't extract items but parser enriched from reply-to context
        if (!responseText && parsedIntent.category && parsedIntent.quantity) {
          logger.info(`[CHAT] L3-ORDER: GPT couldn't extract, using parser-enriched items`);
          const fallbackResult = {
            is_order: true,
            items: [{
              category: parsedIntent.category,
              size: parsedIntent.size || null,
              gauge: parsedIntent.gauge || null,
              mm: parsedIntent.mm || null,
              carbon_type: parsedIntent.carbonType || "normal",
              quantity: parsedIntent.quantity,
            }],
          };
          const orderRes = await processOrderConfirmation(fallbackResult, conversation, user, io, from, displayName);
          if (orderRes) responseText = orderRes;
        }

        // Still no order created — ask for quantity so next message can complete the order
        if (!responseText && parsedIntent.category) {
          logger.info(`[CHAT] L3-ORDER: No items extracted — asking for quantity`);
          conversation.context.lastIntent = "order_confirm";
          conversation.markModified("context");
          responseText = responseBuilder.buildOrderQuantityAsk(parsedIntent, text);
        }
      }

      // ─── STANDARD INTENT CLASSIFICATION ───
      if (!responseText && !isOrderIntent) {
        const { classified, usage, responseTimeMs: rTime } = await openaiService.classifyIntent(chatHistory, dbContext);
        aiUsage = usage;
        responseTimeMs = rTime;

        if (classified) {
          logger.info(`[CHAT] L3 GPT: intent=${classified.intent}, cat=${classified.category}, needs_admin=${classified.needs_admin}`);

          const finalIntent = {
            ...parsedIntent,
            intent: classified.intent || parsedIntent.intent,
            category: (classified.category && classified.category !== "none") ? classified.category : parsedIntent.category,
            size: classified.size || parsedIntent.size,
            gauge: classified.gauge || parsedIntent.gauge,
            mm: classified.mm || parsedIntent.mm,
            carbonType: classified.carbon_type || parsedIntent.carbonType,
            quantity: classified.quantity || parsedIntent.quantity,
            unit: (classified.unit && classified.unit !== "none") ? classified.unit : parsedIntent.unit,
            sizeAvailable: classified.size_available !== undefined ? classified.size_available : parsedIntent.sizeAvailable,
            confidence: 0.95,
          };

          if (finalIntent.intent === "price_inquiry" && finalIntent.category === "wr" && !finalIntent.size) {
            finalIntent.size = "5.5";
            finalIntent.sizeAvailable = true;
          }
          if (finalIntent.intent === "price_inquiry" && finalIntent.category === "hb" && !finalIntent.gauge && !finalIntent.mm) {
            finalIntent.gauge = "12";
          }

          // GPT detected order_confirm
          if (classified.intent === "order_confirm") {
            let gptOrderHistory = chatHistory;
            if (replyToContext && replyToContext.text) {
              const replyRole = replyToContext.senderType === "user" ? "user" : "assistant";
              const alreadyInHistory = chatHistory.some(
                (m) => m.content === replyToContext.text && m.role === replyRole
              );
              if (!alreadyInHistory) {
                gptOrderHistory = [
                  { role: replyRole, content: `[REPLIED-TO MESSAGE]: ${replyToContext.text}` },
                  ...chatHistory,
                ];
              }
            }
            const { result: orderResult, usage: ou, responseTimeMs: ot } = await openaiService.verifyOrder(gptOrderHistory);
            aiUsage.totalTokens += ou.totalTokens;
            responseTimeMs += ot;
            usedGPT = true;

            if (orderResult && orderResult.is_order && orderResult.items?.length > 0) {
              const orderRes = await processOrderConfirmation(orderResult, conversation, user, io, from, displayName);
              if (orderRes) responseText = orderRes;
            }

            // GPT classified as order but couldn't extract items — ask for quantity
            if (!responseText) {
              const cat = finalIntent.category || parsedIntent.category;
              if (cat) {
                conversation.context.lastIntent = "order_confirm";
                conversation.markModified("context");
                responseText = responseBuilder.buildOrderQuantityAsk({ ...parsedIntent, ...finalIntent, category: cat }, text);
              }
            }
          }

          // Try template for the classified intent
          if (!responseText) {
            parsedIntent = finalIntent;
            const templateResult = await responseBuilder.buildFromIntent(finalIntent);
            if (templateResult && templateResult.text) {
              responseText = templateResult.text;
              usedGPT = true;
            }
          }

          // If GPT says needs_admin → DON'T reply, just notify dashboard
          if (!responseText && classified.needs_admin) {
            logger.info(`[CHAT] AI can't answer — staying silent, notifying dashboard`);
            io.to("employees").emit("chat:needs_attention", {
              conversationId: conversation._id.toString(),
              userId: user._id.toString(),
              userName: displayName || user.name || from,
              phone: from,
              lastMessage: text,
              intent: classified.intent,
              emotion: classified.emotion,
            });
            logger.info(`[CHAT] ─── END from=${from} — SILENT (needs employee) ───`);
            return;
          }
        }
      }

      // If still no response — try conversational reply (only for safe topics)
      if (!responseText) {
        logger.info(`[CHAT] L3b Conversational response...`);
        const { reply, usage: u2, responseTimeMs: r2 } = await openaiService.generateResponse(chatHistory, dbContext);
        if (reply && reply.trim()) {
          responseText = reply;
          aiUsage.totalTokens += u2.totalTokens;
          responseTimeMs += r2;
          usedGPT = true;
        } else {
          // GPT couldn't generate safe response — stay silent, notify dashboard
          logger.info(`[CHAT] AI has no safe response — staying silent, notifying dashboard`);
          io.to("employees").emit("chat:needs_attention", {
            conversationId: conversation._id.toString(),
            userId: user._id.toString(),
            userName: displayName || user.name || from,
            phone: from,
            lastMessage: text,
          });
          logger.info(`[CHAT] ─── END from=${from} — SILENT ───`);
          return;
        }
      }
    } catch (err) {
      logger.error(`[CHAT] L3 GPT failed: ${err.message}`);
      // GPT failed — try template with parser data
      const fallback = await responseBuilder.buildFromIntent(parsedIntent);
      if (fallback && fallback.text) {
        responseText = fallback.text;
      } else {
        // Can't answer — stay silent, notify dashboard
        logger.info(`[CHAT] GPT failed, no fallback — staying silent`);
        io.to("employees").emit("chat:needs_attention", {
          conversationId: conversation._id.toString(),
          userId: user._id.toString(),
          userName: displayName || user.name || from,
          phone: from,
          lastMessage: text,
          error: err.message,
        });
        logger.info(`[CHAT] ─── END from=${from} — SILENT (GPT error) ───`);
        return;
      }
    }
  }

  // 12. Save AI message & send
  const aiMsg = await Message.create({
    conversation: conversation._id,
    sender: { type: "ai" },
    content: { text: responseText },
    deliveryStatus: "pending",
    readByAdmin: true,
    aiMetadata: {
      model: usedGPT ? env.OPENAI_MODEL : "template",
      tokensUsed: aiUsage.totalTokens,
      responseTimeMs,
      intent: parsedIntent.intent,
      detectedAction: parsedIntent.intent,
    },
  });

  conversation.messageCount += 1;
  conversation.lastMessage = {
    text: responseText.substring(0, 200),
    senderType: "ai",
    mediaType: "none",
    timestamp: new Date(),
  };
  conversation.lastMessageAt = new Date();
  conversation.markModified("context");
  await conversation.save();

  // 13. Send via WhatsApp
  logger.info(`[CHAT] Sending reply — GPT=${usedGPT}, tokens=${aiUsage.totalTokens}`);
  try {
    const waResponse = await whatsappService.sendTextMessage(from, responseText);
    aiMsg.waMessageId = waResponse.messages?.[0]?.id || "";
    aiMsg.deliveryStatus = "sent";
    aiMsg.sentAt = new Date();
    await aiMsg.save();
  } catch (err) {
    aiMsg.deliveryStatus = "failed";
    aiMsg.failedAt = new Date();
    aiMsg.failureReason = err.message;
    await aiMsg.save();
    logger.error(`[CHAT] WA send FAILED: ${err.message}`);
  }

  // 14. Emit to dashboard
  const populatedAiMsg = await Message.findById(aiMsg._id).lean();
  io.to(`conv:${conversation._id}`).emit("chat:new_message", {
    conversationId: conversation._id.toString(),
    message: populatedAiMsg,
  });
  io.to("employees").emit("chat:conversation_updated", {
    conversationId: conversation._id.toString(),
    lastMessage: conversation.lastMessage,
    lastMessageAt: conversation.lastMessageAt,
    stage: conversation.stage,
  });

  logger.info(`[CHAT] ─── END from=${from} GPT=${usedGPT} tokens=${aiUsage.totalTokens} ───`);
};

// ─────────────────────────────────────────────────────
// EMPLOYEE SENDS MESSAGE
// ─────────────────────────────────────────────────────
const sendEmployeeMessage = async ({ conversationId, employeeId, text, replyTo, media }) => {
  const io = getIO();
  const conversation = await Conversation.findById(conversationId).populate("user");
  if (!conversation) throw new AppError("Conversation not found", 404);

  let mediaFields = {};
  if (media && media.buffer) {
    const saved = saveMediaLocally(media);
    mediaFields = {
      mediaType: media.mediaType,
      mediaLocalPath: saved.localPath,
      mimeType: media.mimeType,
      fileName: media.fileName || saved.fileName,
      fileSize: media.buffer.length,
      caption: media.caption || "",
    };
  }

  const message = await Message.create({
    conversation: conversation._id,
    sender: { type: "employee", employeeId },
    content: { text: text || "", ...mediaFields },
    replyTo: replyTo || null,
    deliveryStatus: "pending",
    readByAdmin: true,
  });

  if (conversation.handlerType === "ai") {
    conversation.handlerType = "employee";
    conversation.assignedTo = employeeId;
    conversation.employeeTakenAt = new Date();
  } else {
    conversation.employeeTakenAt = new Date();
  }
  conversation.messageCount += 1;
  conversation.lastMessage = {
    text: text || `[${mediaFields.mediaType || "text"}]`,
    senderType: "employee",
    mediaType: mediaFields.mediaType || "none",
    timestamp: new Date(),
  };
  conversation.lastMessageAt = new Date();
  await conversation.save();

  try {
    let waResponse;
    if (media && media.buffer) {
      waResponse = await whatsappService.sendMediaMessage(conversation.user.phone, media);
    } else {
      waResponse = await whatsappService.sendTextMessage(conversation.user.phone, text);
    }
    message.waMessageId = waResponse.messages?.[0]?.id || "";
    message.deliveryStatus = "sent";
    message.sentAt = new Date();
    await message.save();
  } catch (err) {
    message.deliveryStatus = "failed";
    message.failedAt = new Date();
    message.failureReason = err.message;
    await message.save();
    logger.error(`[CHAT] Employee WA send failed: ${err.message}`);
  }

  const populated = await Message.findById(message._id)
    .populate("replyTo", "content.text sender.type content.mediaType")
    .populate("sender.employeeId", "name")
    .lean();

  io.to(`conv:${conversationId}`).emit("chat:new_message", { conversationId, message: populated });
  io.to("employees").emit("chat:conversation_updated", {
    conversationId,
    lastMessage: conversation.lastMessage,
    lastMessageAt: conversation.lastMessageAt,
    handlerType: conversation.handlerType,
    stage: conversation.stage,
  });

  return populated;
};

// ─────────────────────────────────────────────────────
// STATUS UPDATES
// ─────────────────────────────────────────────────────
const handleStatusUpdate = async (parsed) => {
  const { waMessageId, status, timestamp } = parsed;
  if (!waMessageId) return;
  const io = getIO();
  const update = { deliveryStatus: status };
  const ts = timestamp ? new Date(Number(timestamp) * 1000) : new Date();
  if (status === "sent") update.sentAt = ts;
  else if (status === "delivered") update.deliveredAt = ts;
  else if (status === "read") update.readAt = ts;
  else if (status === "failed") update.failedAt = ts;

  const message = await Message.findOneAndUpdate({ waMessageId }, update, { returnDocument: "after" });
  if (message) {
    io.to(`conv:${message.conversation}`).emit("chat:status_update", {
      conversationId: message.conversation.toString(),
      messageId: message._id.toString(),
      waMessageId,
      deliveryStatus: status,
      sentAt: message.sentAt,
      deliveredAt: message.deliveredAt,
      readAt: message.readAt,
    });
  }
};

// ─────────────────────────────────────────────────────
// ADMIN UPDATES STAGE
// ─────────────────────────────────────────────────────
const updateStage = async (conversationId, newStage, employeeId) => {
  const io = getIO();
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError("Conversation not found", 404);
  conversation.stage = newStage;
  await conversation.save();

  if (["advance_pending", "advance_received", "payment_complete", "dispatched", "delivered"].includes(newStage) && conversation.linkedOrder) {
    await Order.findByIdAndUpdate(conversation.linkedOrder, { status: newStage });
  }

  io.to("employees").emit("chat:conversation_updated", {
    conversationId: conversationId.toString(),
    stage: newStage,
    updatedBy: employeeId,
  });
  io.to(`conv:${conversationId}`).emit("chat:stage_changed", {
    conversationId: conversationId.toString(),
    stage: newStage,
  });
  return conversation;
};

// ─────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────
function emitToDashboard(io, conversation, incomingMsg, isNewConversation, parsedIntent, displayName) {
  const msgLean = incomingMsg.toObject ? incomingMsg.toObject() : incomingMsg;
  Conversation.findById(conversation._id)
    .populate("user", "name phone company city waId partyName firmName contactName")
    .populate("assignedTo", "name")
    .lean()
    .then((convForEmit) => {
      io.to("employees").emit("chat:notification", {
        type: isNewConversation ? "new_conversation" : "new_message",
        conversation: convForEmit,
        displayName: displayName || convForEmit?.user?.name || "",
        message: msgLean,
        parsedIntent,
      });
      io.to(`conv:${conversation._id}`).emit("chat:new_message", {
        conversationId: conversation._id.toString(),
        message: msgLean,
        parsedIntent,
      });
      io.to("employees").emit("chat:conversation_updated", {
        conversationId: conversation._id.toString(),
        displayName: displayName || convForEmit?.user?.name || "",
        unreadCount: conversation.unreadCount,
        lastMessage: conversation.lastMessage,
        lastMessageAt: conversation.lastMessageAt,
        stage: conversation.stage,
        handlerType: conversation.handlerType,
        context: conversation.context,
      });
    })
    .catch((err) => logger.error(`[CHAT] Dashboard emit failed: ${err.message}`));
}

async function downloadMediaIfPresent(parsed) {
  const result = { mediaType: "none" };
  const mediaTypes = ["image", "document", "audio", "video", "sticker"];
  let waMedia = null, type = "none";
  for (const t of mediaTypes) {
    if (parsed[t]) { waMedia = parsed[t]; type = t; break; }
  }
  if (parsed.location) return { mediaType: "location", caption: parsed.location.name || "" };
  if (!waMedia) return result;

  result.mediaType = type;
  result.waMediaId = waMedia.id || "";
  result.mimeType = waMedia.mime_type || "";
  result.caption = waMedia.caption || "";

  try {
    const downloaded = await whatsappService.downloadMedia(waMedia.id);
    if (downloaded) {
      const ext = getExtFromMime(waMedia.mime_type);
      const fileName = `${uuidv4()}${ext}`;
      const folder = type === "image" ? "images" : type === "video" ? "video" : type === "audio" ? "audio" : "documents";
      const localDir = path.resolve(__dirname, `../../uploads/${folder}`);
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      const localPath = path.join(localDir, fileName);
      fs.writeFileSync(localPath, downloaded);
      result.localPath = `uploads/${folder}/${fileName}`;
      result.fileName = fileName;
      result.fileSize = downloaded.length;
      result.mediaUrl = result.localPath;
    }
  } catch (err) {
    logger.error(`[CHAT] Media download failed: ${err.message}`);
  }
  return result;
}

function saveMediaLocally(media) {
  const ext = getExtFromMime(media.mimeType);
  const fileName = `${uuidv4()}${ext}`;
  const type = media.mediaType || "document";
  const folder = type === "image" ? "images" : type === "video" ? "video" : type === "audio" ? "audio" : "documents";
  const localDir = path.resolve(__dirname, `../../uploads/${folder}`);
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
  const localPath = path.join(localDir, fileName);
  fs.writeFileSync(localPath, Buffer.from(media.buffer));
  return { localPath: `uploads/${folder}/${fileName}`, fileName };
}

function getExtFromMime(mime) {
  const map = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "application/pdf": ".pdf", "audio/ogg": ".ogg", "audio/mpeg": ".mp3",
    "video/mp4": ".mp4", "image/gif": ".gif",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  };
  return map[mime] || ".bin";
}

// ─────────────────────────────────────────────────────
// EMPLOYEE HANDOFF — take over / release / auto-reset
// ─────────────────────────────────────────────────────
const takeOverChat = async (conversationId, employeeId) => {
  const io = getIO();
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError("Conversation not found", 404);

  conversation.handlerType = "employee";
  conversation.assignedTo = employeeId;
  conversation.employeeTakenAt = new Date();
  await conversation.save();

  io.to("employees").emit("chat:conversation_updated", {
    conversationId: conversationId.toString(),
    handlerType: "employee",
    assignedTo: employeeId,
    employeeTakenAt: conversation.employeeTakenAt,
  });
  io.to(`conv:${conversationId}`).emit("chat:handler_changed", {
    conversationId: conversationId.toString(),
    handlerType: "employee",
    employeeId,
  });

  logger.info(`[CHAT] Employee ${employeeId} took over conv=${conversationId}`);
  return conversation;
};

const releaseToAI = async (conversationId, employeeId) => {
  const io = getIO();
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError("Conversation not found", 404);

  conversation.handlerType = "ai";
  conversation.assignedTo = null;
  conversation.employeeTakenAt = null;
  await conversation.save();

  io.to("employees").emit("chat:conversation_updated", {
    conversationId: conversationId.toString(),
    handlerType: "ai",
    assignedTo: null,
    releasedBy: employeeId,
  });
  io.to(`conv:${conversationId}`).emit("chat:handler_changed", {
    conversationId: conversationId.toString(),
    handlerType: "ai",
  });

  logger.info(`[CHAT] Employee ${employeeId} released conv=${conversationId} to AI`);
  return conversation;
};

// ─────────────────────────────────────────────────────
// PARTY DETAILS — save/update for a user
// ─────────────────────────────────────────────────────
const updatePartyDetails = async (userId, details) => {
  const update = {};
  if (details.partyName !== undefined) update.partyName = details.partyName;
  if (details.firmName !== undefined) update.firmName = details.firmName;
  if (details.billName !== undefined) update.billName = details.billName;
  if (details.gstNo !== undefined) update.gstNo = details.gstNo;
  if (details.contactName !== undefined) update.contactName = details.contactName;
  if (details.city !== undefined) update.city = details.city;
  if (details.company !== undefined) update.company = details.company;

  const user = await User.findByIdAndUpdate(userId, { $set: update }, { returnDocument: "after" }).lean();
  if (!user) throw new AppError("User not found", 404);

  logger.info(`[CHAT] Party details updated for user=${userId}`);
  return user;
};

// ─────────────────────────────────────────────────────
// GET USER WITH DISPLAY NAME
// ─────────────────────────────────────────────────────
const getUserDisplayInfo = async (userId) => {
  const user = await User.findById(userId).lean();
  if (!user) return null;
  const contacts = await Contact.find({ phone: user.phone || user.waId }).lean();
  return {
    ...user,
    displayName: getDisplayName(user, contacts),
    importedContacts: contacts,
  };
};

module.exports = {
  handleIncomingMessage,
  sendEmployeeMessage,
  handleStatusUpdate,
  updateStage,
  takeOverChat,
  releaseToAI,
  updatePartyDetails,
  getUserDisplayInfo,
  autoResetIfExpired,
  EMPLOYEE_LOCK_TTL_MS,
};
