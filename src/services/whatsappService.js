const axios = require("axios");
const env = require("../config/env");
const logger = require("../config/logger");

let _waApi = null;
const getWaApi = () => {
  if (!_waApi) {
    const phoneId = env.WA_PHONE_NUMBER_ID;
    const token = env.WA_ACCESS_TOKEN;
    const apiVer = env.WA_API_VERSION || "v21.0";
    if (!token) logger.error("[WA] FATAL — WA_ACCESS_TOKEN is missing!");
    if (!phoneId) logger.error("[WA] FATAL — WA_PHONE_NUMBER_ID is missing!");
    const baseURL = `https://graph.facebook.com/${apiVer}/${phoneId}`;
    logger.info(`[WA] Creating client — token=${token ? "SET" : "MISSING"}, phoneId=${phoneId}`);
    _waApi = axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    });
    logger.info(`[WA] Axios client created — baseURL: ${baseURL}`);
  }
  return _waApi;
};

const getAuthHeader = () => ({ Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` });

// ──────────────────── Sending ────────────────────

const sendTextMessage = async (to, text) => {
  logger.debug(`[WA] Sending text to ${to} (${text.length} chars)`);
  try {
    const res = await getWaApi().post("/messages", {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    });
    logger.debug(`[WA] Text sent to ${to}: ${res.data.messages?.[0]?.id}`);
    return res.data;
  } catch (err) {
    logger.error(`[WA] sendText FAILED to ${to}:`, err.response?.data || err.message);
    throw err;
  }
};

const sendMediaMessage = async (to, media) => {
  const { mediaType, buffer, mimeType, fileName, caption } = media;

  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  formData.append("file", blob, fileName || "file");
  formData.append("messaging_product", "whatsapp");
  formData.append("type", mimeType);

  try {
    const uploadRes = await axios.post(
      `https://graph.facebook.com/${env.WA_API_VERSION}/${env.WA_PHONE_NUMBER_ID}/media`,
      formData,
      { headers: getAuthHeader(), timeout: 30_000 }
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

    const res = await getWaApi().post("/messages", msgPayload);
    logger.debug(`[WA] Media sent to ${to}: ${res.data.messages?.[0]?.id}`);
    return res.data;
  } catch (err) {
    logger.error("[WA] sendMedia FAILED:", err.response?.data || err.message);
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
    const res = await getWaApi().post("/messages", payload);
    return res.data;
  } catch (err) {
    logger.error("[WA] Button send FAILED:", err.response?.data || err.message);
    throw err;
  }
};

// ──────────────────── Templates (HSM) ────────────────────

/**
 * Send a pre-approved WhatsApp template message.
 *
 * @param {string}   to             Destination phone (E.164 without +)
 * @param {string}   templateName   Template name registered in Meta Business Manager
 * @param {string[]} bodyParams     Ordered list of values for body placeholders {{1}}, {{2}}, ...
 * @param {string}   languageCode   BCP-47 language tag (defaults to env.WA_RATE_TEMPLATE_LANG)
 */
const sendTemplateMessage = async (to, templateName, bodyParams = [], languageCode) => {
  const lang = languageCode || env.WA_RATE_TEMPLATE_LANG || "en";
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: [
        {
          type: "body",
          parameters: bodyParams.map((v) => ({ type: "text", text: String(v ?? "") })),
        },
      ],
    },
  };

  try {
    const res = await getWaApi().post("/messages", payload);
    logger.debug(`[WA] Template '${templateName}' sent to ${to}: ${res.data.messages?.[0]?.id}`);
    return res.data;
  } catch (err) {
    const data = err.response?.data;
    logger.error(`[WA] sendTemplate '${templateName}' FAILED to ${to}:`, data || err.message);
    const metaErr = data?.error || {};
    const wrapped = new Error(metaErr.message || err.message);
    wrapped.code = metaErr.code;
    wrapped.subcode = metaErr.error_subcode;
    wrapped.details = metaErr;
    throw wrapped;
  }
};

// ──────────────────── Media download ────────────────────

const downloadMedia = async (mediaId) => {
  try {
    const metaRes = await axios.get(
      `https://graph.facebook.com/${env.WA_API_VERSION}/${mediaId}`,
      { headers: getAuthHeader(), timeout: 10_000 }
    );

    const mediaUrl = metaRes.data.url;
    if (!mediaUrl) return null;

    const fileRes = await axios.get(mediaUrl, {
      headers: getAuthHeader(),
      responseType: "arraybuffer",
      timeout: 30_000,
    });

    return Buffer.from(fileRes.data);
  } catch (err) {
    logger.error(`[WA] Media download FAILED for ${mediaId}:`, err.message);
    return null;
  }
};

// ──────────────────── Incoming read ────────────────────

const markAsRead = async (messageId) => {
  try {
    await getWaApi().post("/messages", {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  } catch (err) {
    logger.warn("[WA] markAsRead failed:", err.message);
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
      context: msg.context || null,
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
  sendTemplateMessage,
  downloadMedia,
  markAsRead,
  parseWebhookPayload,
};
