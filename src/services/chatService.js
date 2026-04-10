const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const uuidv4 = () => crypto.randomUUID();
const { User, Conversation, Message, Order } = require("../models");
const whatsappService = require("./whatsappService");
const openaiService = require("./openaiService");
const pricingService = require("./pricingService");
const intentParser = require("./intentParser");
const env = require("../config/env");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");

const getIO = () => require("../socket").getIO();

// Valid stage progressions — later stages can't go backwards unless admin overrides
const STAGE_ORDER = [
  "talking", "price_inquiry", "negotiation", "order_confirmed",
  "advance_pending", "advance_received", "payment_complete",
  "dispatched", "delivered", "closed",
];

function canAutoAdvance(currentStage, newStage) {
  const curr = STAGE_ORDER.indexOf(currentStage);
  const next = STAGE_ORDER.indexOf(newStage);
  return next > curr;
}

// ─────────────────────────────────────────────────────
// INCOMING MESSAGE  (WhatsApp → Intent Parse → AI → WhatsApp)
// ─────────────────────────────────────────────────────

const handleIncomingMessage = async (parsed) => {
  const { from, waMessageId, name, text, timestamp, messageType } = parsed;
  logger.info(`[CHAT] ─── START handleIncomingMessage from=${from} text="${(text || "").substring(0, 60)}" ───`);

  const io = getIO();

  // 1. Upsert user
  logger.debug("[CHAT] Step 1: Upserting user...");
  const user = await User.findOneAndUpdate(
    { waId: from },
    {
      $set: { phone: from, name: name || undefined, lastMessageAt: new Date() },
      $setOnInsert: { waId: from },
    },
    { upsert: true, returnDocument: "after" }
  );
  logger.debug(`[CHAT] Step 1 OK: user=${user._id}, name=${user.name}`);

  if (user.isBlocked) {
    logger.info(`[CHAT] Blocked user ${from} — skipping`);
    return;
  }

  // 2. Get or create active conversation
  logger.debug("[CHAT] Step 2: Finding/creating conversation...");
  let conversation = await Conversation.findOne({ user: user._id, status: "active" });
  const isNewConversation = !conversation;
  if (!conversation) {
    conversation = await Conversation.create({ user: user._id, handlerType: "ai" });
    logger.debug(`[CHAT] Step 2: NEW conversation created: ${conversation._id}`);
  } else {
    logger.debug(`[CHAT] Step 2: Existing conversation: ${conversation._id}, handler=${conversation.handlerType}`);
  }

  // 3. Handle media
  logger.debug("[CHAT] Step 3: Downloading media if present...");
  const mediaData = await downloadMediaIfPresent(parsed);

  // 4. Save incoming message
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

  // 5. Intent parsing
  logger.debug("[CHAT] Step 5: Parsing intent...");
  const parsedIntent = intentParser.parse(text);
  logger.debug(`[CHAT] Step 5 OK: intent=${parsedIntent.intent}, category=${parsedIntent.category || "-"}, size=${parsedIntent.size || "-"}`);
  const suggestedStage = intentParser.intentToStage(parsedIntent.intent);

  // Auto-advance stage if appropriate
  if (suggestedStage && canAutoAdvance(conversation.stage, suggestedStage)) {
    conversation.stage = suggestedStage;
  }

  // Store detected product info in conversation context
  if (parsedIntent.category) {
    conversation.context.lastDetectedProduct = {
      category: parsedIntent.category,
      size: parsedIntent.size || "",
      carbonType: parsedIntent.carbonType || "normal",
      quantity: parsedIntent.quantity || 0,
      unit: parsedIntent.unit || "",
    };
  }
  if (parsedIntent.intent === "negotiation") {
    conversation.context.negotiationActive = true;
  }
  if (parsedIntent.intent === "delivery_inquiry") {
    conversation.context.deliveryInquiry = true;
  }
  conversation.context.lastIntent = parsedIntent.intent;

  // 6. Update conversation metadata
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

  // 7. Mark read on WhatsApp
  whatsappService.markAsRead(waMessageId);

  // 8. Emit to dashboard
  const populatedMsg = await Message.findById(incomingMsg._id)
    .populate("replyTo", "content.text sender.type")
    .lean();

  const conversationForEmit = await Conversation.findById(conversation._id)
    .populate("user", "name phone company city waId")
    .populate("assignedTo", "name")
    .lean();

  io.to("employees").emit("chat:notification", {
    type: isNewConversation ? "new_conversation" : "new_message",
    conversation: conversationForEmit,
    message: populatedMsg,
    parsedIntent,
  });

  io.to(`conv:${conversation._id}`).emit("chat:new_message", {
    conversationId: conversation._id.toString(),
    message: populatedMsg,
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

  // 9. If handled by employee, stop here (but still parse + emit)
  if (conversation.handlerType === "employee") {
    logger.debug(`[CHAT] Conversation ${conversation._id} handled by employee — skipping AI`);
    return;
  }

  // 10. Build chat history
  logger.debug("[CHAT] Step 10: Building chat history...");
  const recentMessages = await Message.find({
    conversation: conversation._id,
    isDeleted: false,
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  const chatHistory = recentMessages.reverse().map((m) => ({
    role: m.sender.type === "user" ? "user" : "assistant",
    content: m.content.text || `[${m.content.mediaType}]`,
  }));

  // 11. Build price context
  logger.debug("[CHAT] Step 11: Building price context...");
  let priceContext = await pricingService.buildPriceContext();
  logger.debug(`[CHAT] Step 11 OK: priceContext length=${priceContext.length}`);

  if (parsedIntent.size && !parsedIntent.sizeAvailable && parsedIntent.closestSizes.length > 0) {
    const lines = [
      `\n⚠️ UNAVAILABLE SIZE DETECTED: Customer asked for ${parsedIntent.size}mm — we do NOT carry this.`,
      `Available WR sizes: ${intentParser.AVAILABLE_WR_SIZES.join(", ")} mm`,
      `Closest sizes to ${parsedIntent.size}mm:`,
    ];
    for (const cs of parsedIntent.closestSizes) {
      try {
        const p = await pricingService.calculatePrice("wr", {
          size: cs,
          carbonType: parsedIntent.carbonType,
        });
        lines.push(`  → ${cs}mm${parsedIntent.carbonType === "lc" ? " LC" : ""}: ${p.displayLine1}  |  ${p.displayLine2}`);
      } catch { /* skip if price not configured */ }
    }
    lines.push("Tell the customer we don't have their size and show BOTH closest sizes with rates.");
    priceContext += "\n" + lines.join("\n");
  }

  // 12. Get AI response
  logger.info("[CHAT] Step 12: Calling OpenAI...");
  const { reply, functionCall, usage, responseTimeMs } = await openaiService.getChatCompletion(
    chatHistory,
    priceContext,
    parsedIntent
  );
  logger.info(`[CHAT] Step 12 OK: AI replied in ${responseTimeMs}ms, tokens=${usage.totalTokens}, reply="${reply.substring(0, 80)}..."`);

  // 13. Merge AI function call with our local parsing for best results
  const finalIntent = functionCall?.intent || parsedIntent.intent;
  const finalStage = intentParser.intentToStage(finalIntent);
  if (finalStage && canAutoAdvance(conversation.stage, finalStage)) {
    conversation.stage = finalStage;
  }

  // 14. Auto-create order if confirmed
  if (finalIntent === "order_confirm" && !conversation.linkedOrder) {
    try {
      const order = await createOrderFromConversation(conversation, user, parsedIntent, functionCall);
      conversation.linkedOrder = order._id;
      conversation.stage = "order_confirmed";

      io.to("employees").emit("order:new", {
        order: order.toObject(),
        conversationId: conversation._id.toString(),
        fromChat: true,
      });
    } catch (err) {
      logger.error("Auto-order creation failed:", err.message);
    }
  }

  // 15. Save AI message
  const aiMsg = await Message.create({
    conversation: conversation._id,
    sender: { type: "ai" },
    content: { text: reply },
    deliveryStatus: "pending",
    readByAdmin: true,
    aiMetadata: {
      model: env.OPENAI_MODEL || "gpt-4o",
      tokensUsed: usage.totalTokens,
      responseTimeMs,
      intent: finalIntent,
      detectedAction: finalIntent,
    },
  });

  conversation.messageCount += 1;
  conversation.lastMessage = {
    text: reply.substring(0, 200),
    senderType: "ai",
    mediaType: "none",
    timestamp: new Date(),
  };
  conversation.lastMessageAt = new Date();
  await conversation.save();

  // 16. Send via WhatsApp
  logger.info(`[CHAT] Step 16: Sending WA reply to ${from}...`);
  try {
    const waResponse = await whatsappService.sendTextMessage(from, reply);
    aiMsg.waMessageId = waResponse.messages?.[0]?.id || "";
    aiMsg.deliveryStatus = "sent";
    aiMsg.sentAt = new Date();
    await aiMsg.save();
    logger.info(`[CHAT] Step 16 OK: WA reply sent, waMessageId=${aiMsg.waMessageId}`);
  } catch (err) {
    aiMsg.deliveryStatus = "failed";
    aiMsg.failedAt = new Date();
    aiMsg.failureReason = err.message;
    await aiMsg.save();
    logger.error(`[CHAT] Step 16 FAILED — WA reply to ${from}: ${err.message}`);
    if (err.response?.data) {
      logger.error(`[CHAT] WA API error body: ${JSON.stringify(err.response.data)}`);
    }
  }

  logger.info(`[CHAT] ─── END handleIncomingMessage from=${from} ───`);

  // 17. Emit AI reply
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
    logger.error(`Failed WA send to ${conversation.user.phone}:`, err.message);
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
// ADMIN UPDATES STAGE MANUALLY
// ─────────────────────────────────────────────────────

const updateStage = async (conversationId, newStage, employeeId) => {
  const io = getIO();
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError("Conversation not found", 404);

  conversation.stage = newStage;
  await conversation.save();

  // If stage moves to advance_pending or beyond, link order if not linked
  if (
    ["advance_pending", "advance_received", "payment_complete", "dispatched", "delivered"].includes(newStage)
    && conversation.linkedOrder
  ) {
    await Order.findByIdAndUpdate(conversation.linkedOrder, {
      status: newStage,
    });
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

  logger.info(`Conversation ${conversationId} stage → ${newStage} by ${employeeId}`);
  return conversation;
};

// ─────────────────────────────────────────────────────
// AUTO-CREATE ORDER FROM CONVERSATION
// ─────────────────────────────────────────────────────

async function createOrderFromConversation(conversation, user, parsedIntent, functionCall) {
  const productInfo = functionCall || parsedIntent;

  const orderData = {
    user: user._id,
    conversation: conversation._id,
    items: [],
    status: "inquiry",
    createdBy: "ai",
    notes: `Auto-created from WhatsApp chat. User confirmed order.`,
  };

  // Try to populate item from parsed data
  if (productInfo.category && productInfo.size) {
    try {
      const priceResult = await pricingService.calculatePrice(
        productInfo.category || "wr",
        {
          size: productInfo.size,
          carbonType: productInfo.carbon_type || productInfo.carbonType || "normal",
          gauge: productInfo.gauge,
        }
      );

      const qty = productInfo.quantity || 1;
      const unit = productInfo.unit || "ton";

      orderData.items.push({
        product: null, // Will be linked later by admin
        productName: `${(productInfo.category || "wr").toUpperCase()} ${productInfo.size}mm${productInfo.carbonType === "lc" ? " LC" : ""}`,
        quantity: qty,
        unit,
        unitPrice: priceResult.total,
        totalPrice: Math.round(priceResult.total * qty * 100) / 100,
      });

      orderData.pricing = {
        subtotal: Math.round(priceResult.subtotal * qty * 100) / 100,
        taxAmount: Math.round(priceResult.gst * qty * 100) / 100,
        grandTotal: Math.round(priceResult.total * qty * 100) / 100,
      };

      orderData.status = "confirmed";
    } catch (err) {
      logger.warn("Could not auto-price order:", err.message);
      orderData.status = "inquiry";
    }
  }

  const order = await Order.create(orderData);
  logger.info(`Order ${order.orderNumber} auto-created from conversation ${conversation._id}`);
  return order;
}

// ─────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────

async function downloadMediaIfPresent(parsed) {
  const result = { mediaType: "none" };

  const mediaTypes = ["image", "document", "audio", "video", "sticker"];
  let waMedia = null;
  let type = "none";

  for (const t of mediaTypes) {
    if (parsed[t]) { waMedia = parsed[t]; type = t; break; }
  }

  if (parsed.location) {
    return { mediaType: "location", caption: parsed.location.name || "" };
  }
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
    logger.error(`Media download failed for ${waMedia.id}:`, err.message);
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
