const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const uuidv4 = () => crypto.randomUUID();
const { User, Conversation, Message, Order } = require("../models");
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

function canAutoAdvance(currentStage, newStage) {
  return STAGE_ORDER.indexOf(newStage) > STAGE_ORDER.indexOf(currentStage);
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

  // 6. LAYER 1 — Intent parsing (FREE)
  let parsedIntent = intentParser.parse(text);
  logger.info(`[CHAT] L1 Parser: intent=${parsedIntent.intent}, cat=${parsedIntent.category || "-"}, conf=${parsedIntent.confidence}`);

  // 7. LAYER 1b — Reply-to context enrichment
  if (parsedIntent.intent === "follow_up" && replyToContext) {
    const oldParsed = intentParser.parse(replyToContext.text);
    if (oldParsed.category) {
      parsedIntent.category = oldParsed.category;
      parsedIntent.size = oldParsed.size;
      parsedIntent.gauge = oldParsed.gauge;
      parsedIntent.mm = oldParsed.mm;
      parsedIntent.carbonType = oldParsed.carbonType;
      parsedIntent.intent = "price_inquiry";
      parsedIntent.confidence = 0.85;
      logger.info(`[CHAT] L1b Reply-to enriched: cat=${parsedIntent.category}, size=${parsedIntent.size || parsedIntent.gauge}`);
    }
  }

  // If follow_up but no reply-to, use conversation context
  if (parsedIntent.intent === "follow_up" && !replyToContext && conversation.context?.lastDetectedProduct?.category) {
    const ctx = conversation.context.lastDetectedProduct;
    parsedIntent.category = ctx.category;
    parsedIntent.size = ctx.size || null;
    parsedIntent.gauge = ctx.gauge || null;
    parsedIntent.carbonType = ctx.carbonType || "normal";
    parsedIntent.intent = "price_inquiry";
    parsedIntent.confidence = 0.8;
    logger.info(`[CHAT] L1b Context enriched: cat=${parsedIntent.category}, size=${parsedIntent.size}`);
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
    };
  }
  if (parsedIntent.intent === "negotiation") conversation.context.negotiationActive = true;
  if (parsedIntent.intent === "delivery_inquiry") conversation.context.deliveryInquiry = true;
  conversation.context.lastIntent = parsedIntent.intent;

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

  // 9. Mark read on WhatsApp
  whatsappService.markAsRead(waMessageId);

  // 10. Emit to dashboard
  emitToDashboard(io, conversation, incomingMsg, isNewConversation, parsedIntent);

  // 11. If employee is handling, stop
  if (conversation.handlerType === "employee") {
    logger.info(`[CHAT] Employee handling — skipping AI`);
    return;
  }

  // ─── LAYER 2: Parser confident (>= 0.9) → template directly, NO GPT ───
  let responseText = null;
  let usedGPT = false;
  let aiUsage = { totalTokens: 0 };
  let responseTimeMs = 0;

  if (parsedIntent.confidence >= 0.9) {
    // Default sizes when not specified
    if (parsedIntent.intent === "price_inquiry" && parsedIntent.category === "wr" && !parsedIntent.size) {
      parsedIntent.size = "5.5";
      parsedIntent.sizeAvailable = true;
    }
    if (parsedIntent.intent === "price_inquiry" && parsedIntent.category === "hb" && !parsedIntent.gauge && !parsedIntent.mm) {
      parsedIntent.gauge = "12";
    }

    const templateResult = await responseBuilder.buildFromIntent(parsedIntent);
    if (templateResult && templateResult.isOrderConfirm) {
      // Order confirm needs GPT verification — fall through to Layer 3
      logger.info(`[CHAT] L2 Order confirm detected — sending to GPT for verification`);
    } else if (templateResult && templateResult.text) {
      responseText = templateResult.text;
      usedGPT = false;
      logger.info(`[CHAT] L2 Parser confident (${parsedIntent.confidence}) — intent=${parsedIntent.intent}, cat=${parsedIntent.category || "-"}, GPT=NO`);

      if (templateResult.escalateToAdmin) {
        conversation.handlerType = "employee";
        await conversation.save();
        io.to("employees").emit("chat:escalated", {
          conversationId: conversation._id.toString(),
          reason: parsedIntent.intent,
          parsedIntent,
        });
      }
    }
  }

  // ─── LAYER 3: Parser NOT confident OR order confirm → GPT ───
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
      if (parsedIntent.intent === "order_confirm") {
        logger.info(`[CHAT] L3-ORDER: Verifying order with GPT (last ${chatHistory.length} messages)...`);
        const { result: orderResult, usage, responseTimeMs: rTime } = await openaiService.verifyOrder(chatHistory);
        aiUsage = usage;
        responseTimeMs = rTime;
        usedGPT = true;

        if (orderResult && orderResult.is_order && orderResult.items?.length > 0) {
          const items = orderResult.items.map((item) => ({
            category: item.category,
            size: item.size || null,
            gauge: item.gauge || null,
            mm: item.mm || null,
            carbonType: item.carbon_type || "normal",
            quantity: item.quantity || 0,
          }));

          logger.info(`[CHAT] L3-ORDER: GPT confirmed order with ${items.length} items`);

          // Validate minimum quantities
          const totalQty = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
          const belowMinItems = items.filter((i) => (i.quantity || 0) < responseBuilder.MIN_QTY_PER_ITEM);

          if (belowMinItems.length > 0 || totalQty < responseBuilder.MIN_QTY_TOTAL) {
            logger.info(`[CHAT] L3-ORDER: Min qty not met — total=${totalQty}, items_below_min=${belowMinItems.length}`);
            responseText = responseBuilder.buildMinQtyError(items);
          } else {
            responseText = await responseBuilder.buildOrderConfirmation(items);

            // Create order in DB with computed prices
            try {
              let grandTotal = 0;
              const orderItems = [];
              for (const item of items) {
                let price;
                try {
                  if (item.category === "wr") {
                    price = await pricingService.calculatePrice("wr", { size: item.size || "5.5", carbonType: item.carbonType });
                  } else if (item.category === "hb") {
                    price = item.mm
                      ? await pricingService.calculatePrice("hb", { mm: item.mm })
                      : await pricingService.calculatePrice("hb", { gauge: item.gauge || "12" });
                  }
                } catch { /* price calc failed */ }
                const unitPrice = price ? price.total : 0;
                const itemTotal = Math.round(unitPrice * (item.quantity || 0));
                grandTotal += itemTotal;
                const label = price ? price.label : `${item.category.toUpperCase()} ${item.size || item.gauge || ""}`;
                orderItems.push({
                  category: item.category,
                  productName: label,
                  size: item.size,
                  gauge: item.gauge,
                  mm: item.mm,
                  carbonType: item.carbonType,
                  quantity: item.quantity,
                  unit: "ton",
                  unitPrice,
                  totalPrice: itemTotal,
                });
              }

              const order = await Order.create({
                conversation: conversation._id,
                user: user._id,
                items: orderItems,
                pricing: { grandTotal },
                status: "advance_pending",
                advancePayment: { amount: responseBuilder.ADVANCE_AMOUNT, isPaid: false },
                notes: orderResult.customer_note || "",
              });

              conversation.stage = "order_confirmed";
              conversation.handlerType = "employee";
              await conversation.save();

              io.to("employees").emit("order:new", {
                orderId: order._id.toString(),
                orderNumber: order.orderNumber,
                conversationId: conversation._id.toString(),
                items: orderItems,
                grandTotal,
                userId: user._id.toString(),
                userName: user.name || from,
              });

              logger.info(`[CHAT] L3-ORDER: Order ${order.orderNumber} created, total=${grandTotal}, escalated to admin`);
            } catch (orderErr) {
              logger.error(`[CHAT] L3-ORDER: DB save failed: ${orderErr.message}`);
            }
          }
        } else {
          logger.info(`[CHAT] L3-ORDER: GPT says not a real order — asking for details`);
          responseText = responseBuilder.TEMPLATES.order_confirm_ask;
        }
      }

      // ─── STANDARD INTENT CLASSIFICATION ───
      if (!responseText && parsedIntent.intent !== "order_confirm") {
        const { classified, usage, responseTimeMs: rTime } = await openaiService.classifyIntent(chatHistory);
        aiUsage = usage;
        responseTimeMs = rTime;

        if (classified) {
          logger.info(`[CHAT] L3 GPT: intent=${classified.intent}, cat=${classified.category}, gauge=${classified.gauge || "-"}, size=${classified.size || "-"}, needs_admin=${classified.needs_admin}, emotion=${classified.emotion}`);

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

          // Default sizes when not specified
          if (finalIntent.intent === "price_inquiry" && finalIntent.category === "wr" && !finalIntent.size) {
            finalIntent.size = "5.5";
            finalIntent.sizeAvailable = true;
          }
          if (finalIntent.intent === "price_inquiry" && finalIntent.category === "hb" && !finalIntent.gauge && !finalIntent.mm) {
            finalIntent.gauge = "12";
          }

          // GPT detected order_confirm — run order flow
          if (classified.intent === "order_confirm") {
            logger.info(`[CHAT] L3 GPT classified as order_confirm — running order verification...`);
            const { result: orderResult, usage: orderUsage, responseTimeMs: orderTime } = await openaiService.verifyOrder(chatHistory);
            aiUsage.totalTokens += orderUsage.totalTokens;
            responseTimeMs += orderTime;

            if (orderResult && orderResult.is_order && orderResult.items?.length > 0) {
              const items = orderResult.items.map((item) => ({
                category: item.category,
                size: item.size || null,
                gauge: item.gauge || null,
                mm: item.mm || null,
                carbonType: item.carbon_type || "normal",
                quantity: item.quantity || 0,
              }));

              const totalQty = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
              const belowMinItems = items.filter((i) => (i.quantity || 0) < responseBuilder.MIN_QTY_PER_ITEM);

              if (belowMinItems.length > 0 || totalQty < responseBuilder.MIN_QTY_TOTAL) {
                responseText = responseBuilder.buildMinQtyError(items);
              } else {
                responseText = await responseBuilder.buildOrderConfirmation(items);
                try {
                  let grandTotal2 = 0;
                  const orderItems2 = [];
                  for (const item of items) {
                    let price;
                    try {
                      if (item.category === "wr") {
                        price = await pricingService.calculatePrice("wr", { size: item.size || "5.5", carbonType: item.carbonType });
                      } else if (item.category === "hb") {
                        price = item.mm
                          ? await pricingService.calculatePrice("hb", { mm: item.mm })
                          : await pricingService.calculatePrice("hb", { gauge: item.gauge || "12" });
                      }
                    } catch { /* skip */ }
                    const unitPrice = price ? price.total : 0;
                    const itemTotal = Math.round(unitPrice * (item.quantity || 0));
                    grandTotal2 += itemTotal;
                    orderItems2.push({
                      category: item.category,
                      productName: price ? price.label : `${item.category.toUpperCase()} ${item.size || item.gauge || ""}`,
                      size: item.size, gauge: item.gauge, mm: item.mm,
                      carbonType: item.carbonType, quantity: item.quantity,
                      unit: "ton", unitPrice, totalPrice: itemTotal,
                    });
                  }
                  const order = await Order.create({
                    conversation: conversation._id,
                    user: user._id,
                    items: orderItems2,
                    pricing: { grandTotal: grandTotal2 },
                    status: "advance_pending",
                    advancePayment: { amount: responseBuilder.ADVANCE_AMOUNT, isPaid: false },
                    notes: orderResult.customer_note || "",
                  });
                  conversation.stage = "order_confirmed";
                  conversation.handlerType = "employee";
                  await conversation.save();
                  io.to("employees").emit("order:new", {
                    orderId: order._id.toString(),
                    orderNumber: order.orderNumber,
                    conversationId: conversation._id.toString(),
                    items: orderItems2, grandTotal: grandTotal2,
                    userId: user._id.toString(),
                    userName: user.name || from,
                  });
                  logger.info(`[CHAT] L3-ORDER: Order ${order.orderNumber} created, total=${grandTotal2}`);
                } catch (orderErr) {
                  logger.error(`[CHAT] L3-ORDER: DB save failed: ${orderErr.message}`);
                }
              }
              usedGPT = true;
            } else {
              responseText = responseBuilder.TEMPLATES.order_confirm_ask;
              usedGPT = true;
            }
          }

          if (!responseText) {
            parsedIntent = finalIntent;
            const templateResult = await responseBuilder.buildFromIntent(finalIntent);
            if (templateResult && templateResult.text) {
              responseText = templateResult.text;
              usedGPT = true;

              if (templateResult.escalateToAdmin) {
                conversation.handlerType = "employee";
                await conversation.save();
                io.to("employees").emit("chat:escalated", {
                  conversationId: conversation._id.toString(),
                  reason: finalIntent.intent,
                  parsedIntent: finalIntent,
                });
              }
            }
          }

          if (!responseText && classified.needs_admin) {
            responseText = responseBuilder.getTemplate("admin_escalation");
            conversation.handlerType = "employee";
            await conversation.save();
          }
        }
      }

      // If still no response, generate conversational reply
      if (!responseText) {
        logger.info(`[CHAT] L3b Generating conversational response...`);
        const { reply, usage: u2, responseTimeMs: r2 } = await openaiService.generateResponse(chatHistory);
        responseText = reply || responseBuilder.getTemplate("admin_escalation");
        aiUsage.totalTokens += u2.totalTokens;
        responseTimeMs += r2;
        usedGPT = true;
      }
    } catch (err) {
      logger.error(`[CHAT] L3 GPT failed: ${err.message}`);
      const fallback = await responseBuilder.buildFromIntent(parsedIntent);
      if (fallback && fallback.text) {
        responseText = fallback.text;
      } else {
        responseText = responseBuilder.getTemplate("admin_escalation");
        conversation.handlerType = "employee";
        await conversation.save();
      }
    }
  }

  // 12. Save AI message
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
  await conversation.save();

  // 13. Send via WhatsApp
  logger.info(`[CHAT] Sending reply — GPT=${usedGPT}, tokens=${aiUsage.totalTokens}`);
  try {
    const waResponse = await whatsappService.sendTextMessage(from, responseText);
    aiMsg.waMessageId = waResponse.messages?.[0]?.id || "";
    aiMsg.deliveryStatus = "sent";
    aiMsg.sentAt = new Date();
    await aiMsg.save();
    logger.info(`[CHAT] Reply sent OK — waId=${aiMsg.waMessageId}`);
  } catch (err) {
    aiMsg.deliveryStatus = "failed";
    aiMsg.failedAt = new Date();
    aiMsg.failureReason = err.message;
    await aiMsg.save();
    logger.error(`[CHAT] WA send FAILED: ${err.message}`);
    if (err.response?.data) logger.error(`[CHAT] WA error: ${JSON.stringify(err.response.data)}`);
  }

  // 14. Emit AI reply
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
    linkedOrder: conversation.linkedOrder,
    context: conversation.context,
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
function emitToDashboard(io, conversation, incomingMsg, isNewConversation, parsedIntent) {
  const msgLean = incomingMsg.toObject ? incomingMsg.toObject() : incomingMsg;
  Conversation.findById(conversation._id)
    .populate("user", "name phone company city waId")
    .populate("assignedTo", "name")
    .lean()
    .then((convForEmit) => {
      io.to("employees").emit("chat:notification", {
        type: isNewConversation ? "new_conversation" : "new_message",
        conversation: convForEmit,
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
        unreadCount: conversation.unreadCount,
        lastMessage: conversation.lastMessage,
        lastMessageAt: conversation.lastMessageAt,
        stage: conversation.stage,
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

module.exports = {
  handleIncomingMessage,
  sendEmployeeMessage,
  handleStatusUpdate,
  updateStage,
};
