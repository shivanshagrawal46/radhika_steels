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
  // Always respond 200 immediately to WhatsApp (they retry on failure)
  res.status(200).send("EVENT_RECEIVED");

  const parsed = whatsappService.parseWebhookPayload(req.body);
  if (!parsed) return;

  try {
    if (parsed.type === "message") {
      await chatService.handleIncomingMessage(parsed);
    } else if (parsed.type === "status") {
      await chatService.handleStatusUpdate(parsed);
    }
  } catch (err) {
    logger.error("Webhook processing error:", err);
  }
});

module.exports = { verify, handleEvent };
