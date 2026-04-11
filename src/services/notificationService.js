const admin = require("firebase-admin");
const { Client, Notification } = require("../models");
const logger = require("../config/logger");

/**
 * Send a push notification to a specific client.
 */
const sendToClient = async (clientId, { title, body, data = {} }) => {
  const client = await Client.findById(clientId);
  if (!client || !client.fcmTokens?.length) return { sent: 0, failed: 0 };

  const tokens = client.fcmTokens.map((t) => t.token);
  return sendToTokens(tokens, { title, body, data });
};

/**
 * Send push notification to ALL approved clients (e.g. price update).
 */
const sendToAllApproved = async ({ title, body, data = {}, type = "general", sentBy = null }) => {
  const clients = await Client.find({
    approvalStatus: "approved",
    isBlocked: false,
    "fcmTokens.0": { $exists: true },
  }).select("fcmTokens").lean();

  const allTokens = [];
  for (const c of clients) {
    for (const t of c.fcmTokens) {
      allTokens.push(t.token);
    }
  }

  if (allTokens.length === 0) {
    logger.info("No FCM tokens found for approved clients — skipping push");
    return { sent: 0, failed: 0 };
  }

  const result = await sendToTokens(allTokens, { title, body, data });

  // Log the notification
  await Notification.create({
    type,
    title,
    body,
    data,
    audience: "approved_clients",
    sentBy,
    sentCount: result.sent,
    failedCount: result.failed,
  });

  return result;
};

/**
 * Low-level: send to a batch of FCM tokens.
 */
const sendToTokens = async (tokens, { title, body, data = {} }) => {
  if (!tokens.length) return { sent: 0, failed: 0 };

  // Firebase sendEachForMulticast handles up to 500 tokens per call
  const message = {
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    tokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);

    // Clean up invalid tokens
    if (response.failureCount > 0) {
      const invalidTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (
            code === "messaging/invalid-registration-token" ||
            code === "messaging/registration-token-not-registered"
          ) {
            invalidTokens.push(tokens[idx]);
          }
        }
      });

      if (invalidTokens.length > 0) {
        await Client.updateMany(
          {},
          { $pull: { fcmTokens: { token: { $in: invalidTokens } } } }
        );
        logger.info(`Cleaned up ${invalidTokens.length} invalid FCM tokens`);
      }
    }

    logger.info(`FCM sent: ${response.successCount} ok, ${response.failureCount} failed`);
    return { sent: response.successCount, failed: response.failureCount };
  } catch (err) {
    logger.error("FCM send error:", err.message);
    return { sent: 0, failed: tokens.length };
  }
};

/**
 * Send a price update notification to all approved clients.
 */
const notifyPriceUpdate = async (newBaseRate, updatedBy, customBody = "") => {
  const body = customBody || `New base rate: ₹${newBaseRate.toLocaleString("en-IN")}/ton. Open the app for full price list.`;
  return sendToAllApproved({
    title: "⚡ Rate Updated — Radhika Steels",
    body,
    data: {
      type: "price_update",
      baseRate: newBaseRate,
      updatedAt: new Date().toISOString(),
    },
    type: "price_update",
    sentBy: updatedBy,
  });
};

/**
 * Register / refresh an FCM token for a client.
 */
const registerFCMToken = async (clientId, token, device = "") => {
  await Client.bulkWrite([
    { updateOne: { filter: { _id: clientId }, update: { $pull: { fcmTokens: { token } } } } },
    { updateOne: { filter: { _id: clientId }, update: { $push: { fcmTokens: { token, device, updatedAt: new Date() } } } } },
  ], { ordered: true });

  logger.debug(`FCM token registered for client ${clientId}`);
};

/**
 * Unregister an FCM token (e.g. on logout).
 */
const unregisterFCMToken = async (clientId, token) => {
  await Client.updateOne(
    { _id: clientId },
    { $pull: { fcmTokens: { token } } }
  );
};

module.exports = {
  sendToClient,
  sendToAllApproved,
  notifyPriceUpdate,
  registerFCMToken,
  unregisterFCMToken,
};
