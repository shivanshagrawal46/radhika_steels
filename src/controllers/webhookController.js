const env = require("../config/env");
const logger = require("../config/logger");
const whatsappService = require("../services/whatsappService");
const chatService = require("../services/chatService");
const asyncHandler = require("../utils/asyncHandler");

/**
 * GET /webhook — WhatsApp verification handshake.
 */
const verify = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.WA_VERIFY_TOKEN) {
    logger.info("WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }

  logger.warn("Webhook verification failed");
  res.status(403).send("Forbidden");
};

/**
 * POST /webhook — Handle incoming WhatsApp events.
 */
const handleEvent = asyncHandler(async (req, res) => {
  res.status(200).send("EVENT_RECEIVED");

  const parsed = whatsappService.parseWebhookPayload(req.body);
  if (!parsed) {
    logger.debug("[WEBHOOK] Received payload with no parseable message/status");
    return;
  }

  logger.info(`[WEBHOOK] Event: ${parsed.type} | from: ${parsed.from || parsed.recipientId || "?"} | msgType: ${parsed.messageType || parsed.status || "?"}`);

  try {
    if (parsed.type === "message") {
      logger.info(`[WEBHOOK] Processing message from ${parsed.from}: "${(parsed.text || "").substring(0, 80)}"`);
      await chatService.handleIncomingMessage(parsed);
      logger.info(`[WEBHOOK] Message from ${parsed.from} processed OK`);
    } else if (parsed.type === "status") {
      await chatService.handleStatusUpdate(parsed);
    }
  } catch (err) {
    logger.error(`[WEBHOOK] PROCESSING FAILED for ${parsed.type} from ${parsed.from || "?"}:`);
    logger.error(`[WEBHOOK] Error name: ${err.name}`);
    logger.error(`[WEBHOOK] Error message: ${err.message}`);
    logger.error(`[WEBHOOK] Stack: ${err.stack}`);
  }
});

module.exports = { verify, handleEvent };
