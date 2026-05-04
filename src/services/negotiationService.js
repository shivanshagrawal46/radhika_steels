/**
 * negotiationService — AI negotiation handler for Radhika Steel.
 *
 * Layered design (kept STRICTLY additive — never alters the existing
 * silent / order / price / delivery flows in chatService):
 *
 *   1. tryHandleNegotiation()  — called from chatService when either
 *      (a) the regex parser flagged the message as negotiation with
 *          high confidence (≥ 0.95) — we trust it and skip GPT verify, OR
 *      (b) GPT classifyIntent returned intent="negotiation" — we still
 *          run a strict GPT verify_negotiation call as a second gate.
 *      Generates a polite refusal via openaiService.generateNegotiationReply
 *      and returns the text. Refusal text NEVER mentions a number / discount
 *      / approval — those rules are baked into the GPT prompt.
 *
 *   2. markRefusalSent()  — called from chatService AFTER the refusal
 *      message has been persisted + sent. Stamps:
 *        - context.negotiation.refusalCount++
 *        - context.negotiation.lastRefusalMessageId
 *        - resets followUpDueAt / followUpSent (a new follow-up cycle
 *          begins when this new refusal is read).
 *
 *   3. onMessageStatusUpdate()  — called from chatService.handleStatusUpdate
 *      whenever a WhatsApp status change arrives. If the message is the
 *      latest negotiation refusal AND the new status is 'read', we set
 *      followUpDueAt = now + FOLLOWUP_DELAY_MS so the scheduler can fire
 *      a follow-up exactly that long after the customer SAW the message.
 *      "At least the negotiated message must be seen" — this enforces it.
 *
 *   4. processFollowUps()  — scheduler tick. Atomically claims a due
 *      follow-up via findOneAndUpdate (followUpSent=true), then runs all
 *      the safety checks (refusal still read, no fresh non-acknowledgment
 *      reply since, AI still handling) before sending. If a check fails
 *      we just leave it claimed — never repeats, never spams.
 *
 *   5. cancelFollowUpIfTopicChanged()  — called from chatService whenever
 *      a NEW user message arrives. If the user moved on (intent != negotiation
 *      and != acknowledgment), we cancel the pending follow-up so we don't
 *      ping them about a topic they already abandoned. Also resets the
 *      refusalCount so a future negotiation starts fresh.
 *
 * Everything below is invoked ONLY when the negotiation entry-points fire.
 * If anything in this file throws, callers swallow + log and the existing
 * silent path runs as it did before — guaranteed zero blast-radius.
 */

const { Conversation, Message } = require("../models");
const openaiService = require("./openaiService");
const whatsappService = require("./whatsappService");
const logger = require("../config/logger");
const env = require("../config/env");

// ── Tunables ────────────────────────────────────────────────────────────────
const MAX_REFUSALS_PER_CONVERSATION = 2;          // 3rd negotiation push → silent
const FOLLOWUP_DELAY_MS = 10 * 60 * 1000;          // 10 minutes after read
const VERIFY_CONFIDENCE_THRESHOLD = 0.85;          // GPT verify must be ≥ this
const SCHEDULER_INTERVAL_MS = 60 * 1000;           // poll every 60 seconds
const SCHEDULER_BATCH_LIMIT = 25;                  // max conversations per tick
const REFUSAL_COOLDOWN_MS = 60 * 1000;             // back-to-back negotiation messages within 60s share ONE refusal

const getIO = () => {
  try {
    return require("../socket").getIO();
  } catch {
    return null;
  }
};

// ── 1. Decide + generate the polite refusal ────────────────────────────────
/**
 * Returns one of three things:
 *   • { responseText, usage, responseTimeMs } — refusal ready to send
 *   • { silent: true }                        — we just sent a refusal a
 *       few seconds ago (REFUSAL_COOLDOWN_MS); the customer is mid-burst
 *       (e.g. typed two negotiation messages back-to-back). Caller must
 *       NOT send anything AND must NOT route to needsAttention either —
 *       just stay silent and end the request. The scheduler/follow-up
 *       state is unchanged.
 *   • null                                    — handler can't take this
 *       message (cap hit, GPT failure, low confidence). Caller falls
 *       through to the existing silent flow exactly like before.
 */
async function tryHandleNegotiation({
  conversation,
  chatHistory,
  skipVerification = false,
}) {
  const negCtx = (conversation.context && conversation.context.negotiation) || {};

  // ── Cooldown gate (deduplicate negotiation bursts) ────────────────────
  // Path 1: in-memory check via context.negotiation.lastRefusalAt — fast,
  // works for the common case where the previous refusal save has finished
  // before this message is processed.
  if (negCtx.lastRefusalAt) {
    const elapsed = Date.now() - new Date(negCtx.lastRefusalAt).getTime();
    if (elapsed < REFUSAL_COOLDOWN_MS) {
      logger.info(
        `[NEGOTIATION] Cooldown active (${elapsed}ms < ${REFUSAL_COOLDOWN_MS}ms) — ` +
        `same negotiation burst, staying silent (no double-reply)`
      );
      return { silent: true };
    }
  }
  // Path 2: DB-backed safety net — handles the rare race where two webhook
  // requests interleave so fast that path 1's in-memory state is stale.
  // Indexed query on (conversation, createdAt) is ~ms-fast.
  try {
    const recentRefusal = await Message.findOne({
      conversation: conversation._id,
      "sender.type": "ai",
      "aiMetadata.intent": "negotiation",
      createdAt: { $gte: new Date(Date.now() - REFUSAL_COOLDOWN_MS) },
    })
      .sort({ createdAt: -1 })
      .lean();
    if (recentRefusal) {
      logger.info(
        `[NEGOTIATION] DB-cooldown active (refusal ${recentRefusal._id} sent ` +
        `${Date.now() - new Date(recentRefusal.createdAt).getTime()}ms ago) — staying silent`
      );
      return { silent: true };
    }
  } catch (err) {
    logger.warn(`[NEGOTIATION] DB cooldown check failed: ${err.message} — proceeding`);
  }

  // ── Refusal-limit gate ────────────────────────────────────────────────
  const refusalCount = negCtx.refusalCount || 0;
  if (refusalCount >= MAX_REFUSALS_PER_CONVERSATION) {
    logger.info(
      `[NEGOTIATION] Refusal cap hit (${refusalCount}/${MAX_REFUSALS_PER_CONVERSATION}) — falling through to silent`
    );
    return null;
  }

  let usage = { totalTokens: 0 };
  let responseTimeMs = 0;

  // Strict GPT verification (skipped only when parser is super-confident)
  if (!skipVerification) {
    try {
      const verifyRes = await openaiService.verifyNegotiation(chatHistory);
      usage.totalTokens += verifyRes.usage?.totalTokens || 0;
      responseTimeMs += verifyRes.responseTimeMs || 0;

      const isNeg = verifyRes.result?.is_negotiation === true;
      const conf = Number(verifyRes.result?.confidence || 0);
      if (!isNeg || conf < VERIFY_CONFIDENCE_THRESHOLD) {
        logger.info(
          `[NEGOTIATION] Verifier said NOT negotiation (is_neg=${isNeg}, conf=${conf}) — falling through`
        );
        return null;
      }
      logger.info(`[NEGOTIATION] Verifier confirmed negotiation (conf=${conf})`);
    } catch (err) {
      logger.warn(`[NEGOTIATION] verifyNegotiation failed: ${err.message} — falling through`);
      return null;
    }
  } else {
    logger.info(`[NEGOTIATION] Skipping verification — parser high-confidence`);
  }

  // Generate the polite refusal — strict prompt, no numbers / no discount
  let replyRes;
  try {
    replyRes = await openaiService.generateNegotiationReply(chatHistory);
    usage.totalTokens += replyRes.usage?.totalTokens || 0;
    responseTimeMs += replyRes.responseTimeMs || 0;
  } catch (err) {
    logger.warn(`[NEGOTIATION] generateNegotiationReply failed: ${err.message}`);
    return null;
  }

  const text = (replyRes.text || "").trim();
  if (!text) {
    logger.warn(`[NEGOTIATION] Empty reply — falling through`);
    return null;
  }

  return { responseText: text, usage, responseTimeMs };
}

// ── 2. Stamp the conversation after sending the refusal ────────────────────
/**
 * Mutates conversation.context.negotiation in-place. Caller must save the
 * conversation afterwards — we do NOT save here because chatService is
 * already in the middle of its own save lifecycle.
 */
function markRefusalSent(conversation, refusalMessageId) {
  if (!conversation.context) conversation.context = {};
  if (!conversation.context.negotiation) conversation.context.negotiation = {};

  const ctx = conversation.context.negotiation;
  ctx.refusalCount = (ctx.refusalCount || 0) + 1;
  ctx.lastRefusalMessageId = refusalMessageId;
  ctx.lastRefusalAt = new Date();   // powers the burst cooldown
  ctx.followUpDueAt = null;         // will be set when 'read' status arrives
  ctx.followUpSent = false;         // fresh follow-up cycle
  conversation.markModified("context");
}

// ── 3. Hook: WhatsApp status update arrived ────────────────────────────────
/**
 * If the updated message is the latest negotiation refusal AND its new
 * status is 'read' (blue tick), schedule the follow-up.
 *
 * This is the ENFORCEMENT of "at least the negotiation message should be
 * seen" — followUpDueAt simply never gets set for unseen messages, so the
 * scheduler can never pick them up.
 */
async function onMessageStatusUpdate({ message, status }) {
  try {
    if (status !== "read") return;
    if (!message || !message.aiMetadata) return;
    if (message.aiMetadata.intent !== "negotiation") return;

    const conversation = await Conversation.findById(message.conversation);
    if (!conversation) return;

    const ctx = conversation.context && conversation.context.negotiation;
    if (!ctx || !ctx.lastRefusalMessageId) return;

    // Only the LATEST refusal qualifies — older ones are stale
    if (ctx.lastRefusalMessageId.toString() !== message._id.toString()) return;
    if (ctx.followUpDueAt) return; // already scheduled (idempotent)

    conversation.context.negotiation.followUpDueAt = new Date(Date.now() + FOLLOWUP_DELAY_MS);
    conversation.context.negotiation.followUpSent = false;
    conversation.markModified("context");
    await conversation.save();

    logger.info(
      `[NEGOTIATION] Follow-up scheduled: conv=${conversation._id} ` +
      `at ${conversation.context.negotiation.followUpDueAt.toISOString()}`
    );
  } catch (err) {
    logger.warn(`[NEGOTIATION] onMessageStatusUpdate failed: ${err.message}`);
  }
}

// ── 4. Cancel pending follow-up when the customer changes topics ───────────
/**
 * Called from chatService BEFORE responding to a new user message. If the
 * customer has clearly moved on (asked a different question, placed an order,
 * complained about something else, etc.), we cancel the scheduled follow-up
 * so we don't bring up the abandoned negotiation later.
 *
 * Acknowledgments ("ji", "ok", "aacha") and another negotiation push do
 * NOT cancel — those are part of the same negotiation thread.
 */
function cancelFollowUpIfTopicChanged(conversation, parsedIntent) {
  const ctx = conversation.context && conversation.context.negotiation;
  if (!ctx) return;
  if (!ctx.followUpDueAt && !ctx.refusalCount) return;
  if (ctx.followUpSent) return;

  const stillEngaging =
    parsedIntent.intent === "negotiation" || parsedIntent.intent === "acknowledgment";
  if (stillEngaging) return;

  // User moved on — cancel follow-up + reset refusal counter so a future
  // negotiation in this same conversation starts fresh.
  conversation.context.negotiation.followUpSent = true;
  conversation.context.negotiation.followUpDueAt = null;
  conversation.context.negotiation.refusalCount = 0;
  conversation.context.negotiation.lastRefusalMessageId = null;
  conversation.markModified("context");
  logger.info(
    `[NEGOTIATION] Follow-up cancelled: conv=${conversation._id} — ` +
    `user moved to "${parsedIntent.intent}"`
  );
}

// ── 5. Scheduler: process due follow-ups ───────────────────────────────────
async function processFollowUps() {
  const now = new Date();
  let processed = 0;

  // Atomically claim one follow-up at a time so two scheduler ticks (or
  // a tick + a chatService cancel) never race.
  while (processed < SCHEDULER_BATCH_LIMIT) {
    const conv = await Conversation.findOneAndUpdate(
      {
        "context.negotiation.followUpDueAt": { $lte: now, $ne: null },
        "context.negotiation.followUpSent": { $ne: true },
        handlerType: "ai",
        status: "active",
      },
      { $set: { "context.negotiation.followUpSent": true } },
      { new: true }
    ).populate("user");

    if (!conv) break;
    processed++;

    try {
      await sendFollowUpForConversation(conv);
    } catch (err) {
      logger.error(`[NEGOTIATION] Follow-up send failed: conv=${conv._id} — ${err.message}`);
      // Already marked sent — won't retry. Acceptable: customer can
      // continue the conversation freely; we just skipped one nudge.
    }
  }

  if (processed > 0) {
    logger.info(`[NEGOTIATION] Scheduler tick processed ${processed} follow-up(s)`);
  }
}

async function sendFollowUpForConversation(conversation) {
  const ctx = conversation.context && conversation.context.negotiation;
  if (!ctx || !ctx.lastRefusalMessageId) return;

  // Re-verify the refusal was actually READ (status may have changed since
  // followUpDueAt was set — defensive)
  const refusalMsg = await Message.findById(ctx.lastRefusalMessageId).lean();
  if (!refusalMsg) return;
  if (refusalMsg.deliveryStatus !== "read") {
    logger.info(`[NEGOTIATION] Skip: refusal not yet read for conv=${conversation._id}`);
    return;
  }

  // Has the user replied since with anything other than acknowledgment /
  // another negotiation? If yes, they moved on — don't ping them.
  const subsequentUserMsgs = await Message.find({
    conversation: conversation._id,
    "sender.type": "user",
    createdAt: { $gt: refusalMsg.createdAt },
    isDeleted: { $ne: true },
  })
    .sort({ createdAt: 1 })
    .lean();

  if (subsequentUserMsgs.length > 0) {
    const intentParser = require("./intentParser");
    for (const um of subsequentUserMsgs) {
      const parsed = intentParser.parse(um.content?.text || "");
      if (parsed.intent !== "acknowledgment" && parsed.intent !== "negotiation") {
        logger.info(
          `[NEGOTIATION] Skip: user moved to "${parsed.intent}" for conv=${conversation._id}`
        );
        return;
      }
    }
  }

  // Build a small chat history for GPT to write a contextual follow-up
  const recentMsgs = await Message.find({
    conversation: conversation._id,
    isDeleted: { $ne: true },
  })
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();
  const chatHistory = recentMsgs.reverse().map((m) => ({
    role: m.sender?.type === "user" ? "user" : "assistant",
    content: m.content?.text || `[${m.content?.mediaType || "media"}]`,
  }));

  let replyRes;
  try {
    replyRes = await openaiService.generateFollowUpReply(chatHistory);
  } catch (err) {
    logger.error(`[NEGOTIATION] generateFollowUpReply failed: ${err.message}`);
    return;
  }

  const followUpText = (replyRes.text || "").trim();
  if (!followUpText) {
    logger.warn(`[NEGOTIATION] Empty follow-up text for conv=${conversation._id}`);
    return;
  }

  const phone = conversation.user?.phone || conversation.user?.waId;
  if (!phone) return;

  // Save AI message
  const aiMsg = await Message.create({
    conversation: conversation._id,
    sender: { type: "ai" },
    content: { text: followUpText },
    deliveryStatus: "pending",
    readByAdmin: true,
    aiMetadata: {
      model: env.OPENAI_MODEL,
      tokensUsed: replyRes.usage?.totalTokens || 0,
      responseTimeMs: replyRes.responseTimeMs || 0,
      intent: "negotiation_followup",
      detectedAction: "negotiation_followup",
    },
  });

  conversation.messageCount = (conversation.messageCount || 0) + 1;
  conversation.lastMessage = {
    text: followUpText.substring(0, 200),
    senderType: "ai",
    mediaType: "none",
    timestamp: new Date(),
  };
  conversation.lastMessageAt = new Date();
  await conversation.save();

  try {
    const waResponse = await whatsappService.sendTextMessage(phone, followUpText);
    aiMsg.waMessageId = waResponse.messages?.[0]?.id || "";
    aiMsg.deliveryStatus = "sent";
    aiMsg.sentAt = new Date();
    await aiMsg.save();
  } catch (err) {
    aiMsg.deliveryStatus = "failed";
    aiMsg.failedAt = new Date();
    aiMsg.failureReason = err.message;
    await aiMsg.save();
    logger.error(`[NEGOTIATION] Follow-up WA send failed: conv=${conversation._id} — ${err.message}`);
    return;
  }

  // Live-update dashboard exactly the way chatService does it
  const io = getIO();
  if (io) {
    const populated = await Message.findById(aiMsg._id).lean();
    io.to(`conv:${conversation._id}`).emit("chat:new_message", {
      conversationId: conversation._id.toString(),
      message: populated,
    });
    io.to("employees").emit("chat:conversation_updated", {
      conversationId: conversation._id.toString(),
      lastMessage: conversation.lastMessage,
      lastMessageAt: conversation.lastMessageAt,
      handlerType: conversation.handlerType,
      stage: conversation.stage,
    });
  }

  logger.info(`[NEGOTIATION] Follow-up sent to ${phone} for conv=${conversation._id}`);
}

// ── Scheduler lifecycle ────────────────────────────────────────────────────
let _schedulerHandle = null;

function startScheduler() {
  if (_schedulerHandle) return;
  _schedulerHandle = setInterval(() => {
    processFollowUps().catch((err) => {
      logger.error(`[NEGOTIATION] Scheduler tick crashed: ${err.message}`);
    });
  }, SCHEDULER_INTERVAL_MS);
  logger.info(
    `[NEGOTIATION] Follow-up scheduler started (every ${SCHEDULER_INTERVAL_MS / 1000}s, ` +
    `delay=${FOLLOWUP_DELAY_MS / 60000}min after read, max ${MAX_REFUSALS_PER_CONVERSATION} refusals/conv)`
  );
}

function stopScheduler() {
  if (_schedulerHandle) {
    clearInterval(_schedulerHandle);
    _schedulerHandle = null;
  }
}

module.exports = {
  tryHandleNegotiation,
  markRefusalSent,
  onMessageStatusUpdate,
  cancelFollowUpIfTopicChanged,
  processFollowUps,
  startScheduler,
  stopScheduler,
  MAX_REFUSALS_PER_CONVERSATION,
  FOLLOWUP_DELAY_MS,
  REFUSAL_COOLDOWN_MS,
};
