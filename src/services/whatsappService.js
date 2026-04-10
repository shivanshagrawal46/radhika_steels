const axios = require("axios");
const env = require("../config/env");
const logger = require("../config/logger");

const WA_BASE_URL = `https://graph.facebook.com/${env.WA_API_VERSION}/${env.WA_PHONE_NUMBER_ID}`;

const waApi = axios.create({
  baseURL: WA_BASE_URL,
  headers: {
    Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 15_000,
});

// ──────────────────── Sending ────────────────────

const sendTextMessage = async (to, text) => {
  try {
    const res = await waApi.post("/messages", {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    });
    logger.debug(`WA text sent to ${to}: ${res.data.messages?.[0]?.id}`);
    return res.data;
  } catch (err) {
    logger.error("WA sendText failed:", err.response?.data || err.message);
    throw err;
  }
};

const sendMediaMessage = async (to, media) => {
  const { mediaType, buffer, mimeType, fileName, caption } = media;

  // Upload media to WhatsApp first
  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  formData.append("file", blob, fileName || "file");
  formData.append("messaging_product", "whatsapp");
  formData.append("type", mimeType);

  try {
    const uploadRes = await axios.post(
      `https://graph.facebook.com/${env.WA_API_VERSION}/${env.WA_PHONE_NUMBER_ID}/media`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
        },
        timeout: 30_000,
      }
    );

    const mediaId = uploadRes.data.id;

    const msgPayload = {
      messaging_product: "whatsapp",
      to,
      type: mediaType,
    };

    if (mediaType === "image") {
      msgPayload.image = { id: mediaId, caption: caption || "" };
    } else if (mediaType === "document") {
      msgPayload.document = { id: mediaId, caption: caption || "", filename: fileName || "file" };
    } else if (mediaType === "audio") {
      msgPayload.audio = { id: mediaId };
    } else if (mediaType === "video") {
      msgPayload.video = { id: mediaId, caption: caption || "" };
    }

    const res = await waApi.post("/messages", msgPayload);
    logger.debug(`WA media sent to ${to}: ${res.data.messages?.[0]?.id}`);
    return res.data;
  } catch (err) {
    logger.error("WA sendMedia failed:", err.response?.data || err.message);
    throw err;
  }
};

const sendButtonMessage = async (to, bodyText, buttons) => {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b, i) => ({
          type: "reply",
          reply: { id: b.id || `btn_${i}`, title: b.title },
        })),
      },
    },
  };

  try {
    const res = await waApi.post("/messages", payload);
    return res.data;
  } catch (err) {
    logger.error("WA button send failed:", err.response?.data || err.message);
    throw err;
  }
};

// ──────────────────── Media download ────────────────────

const downloadMedia = async (mediaId) => {
  try {
    // Step 1: Get media URL
    const metaRes = await axios.get(
      `https://graph.facebook.com/${env.WA_API_VERSION}/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
        timeout: 10_000,
      }
    );

    const mediaUrl = metaRes.data.url;
    if (!mediaUrl) return null;

    // Step 2: Download binary
    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
      responseType: "arraybuffer",
      timeout: 30_000,
    });

    return Buffer.from(fileRes.data);
  } catch (err) {
    logger.error(`Media download failed for ${mediaId}:`, err.message);
    return null;
  }
};

// ──────────────────── Incoming read ────────────────────

const markAsRead = async (messageId) => {
  try {
    await waApi.post("/messages", {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  } catch (err) {
    logger.warn("Failed to mark message as read:", err.message);
  }
};

// ──────────────────── Parse webhook ────────────────────

const parseWebhookPayload = (body) => {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  if (!value) return null;

  const messages = value.messages;
  const statuses = value.statuses;
  const contacts = value.contacts;

  if (messages && messages.length > 0) {
    const msg = messages[0];
    const contact = contacts?.[0];
    return {
      type: "message",
      from: msg.from,
      waMessageId: msg.id,
      timestamp: msg.timestamp,
      name: contact?.profile?.name || "",
      messageType: msg.type,
      text: msg.text?.body || "",
      image: msg.image || null,
      document: msg.document || null,
      audio: msg.audio || null,
      video: msg.video || null,
      sticker: msg.sticker || null,
      location: msg.location || null,
      interactive: msg.interactive || null,
      context: msg.context || null, // contains quoted message id for replies
    };
  }

  if (statuses && statuses.length > 0) {
    const status = statuses[0];
    return {
      type: "status",
      waMessageId: status.id,
      recipientId: status.recipient_id,
      status: status.status,
      timestamp: status.timestamp,
      errors: status.errors || null,
    };
  }

  return null;
};

module.exports = {
  sendTextMessage,
  sendMediaMessage,
  sendButtonMessage,
  downloadMedia,
  markAsRead,
  parseWebhookPayload,
};
