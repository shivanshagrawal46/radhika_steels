/**
 * rateUpdateService — Broadcast "daily rate update" WhatsApp template
 * to two audiences:
 *
 *  1. Curated subscribers (admin manages this list manually).
 *  2. Users who have messaged us in the last 24 hours
 *     (free-window recipients — no WA conversation charges).
 *
 * Template variables (registered in Meta Business Manager):
 *   {{1}} — customer first name (falls back to "ji")
 *   {{2}} — today's date, e.g. "17th April, 2026"
 *   {{3}} — WR 5.5mm base rate (before ₹345 + 18% GST)
 *   {{4}} — HB Wire 12g base rate (before ₹345 + 18% GST)
 *
 * IMPORTANT:
 *   - The WhatsApp template body itself must already be approved in
 *     Meta Business Manager with matching placeholders & language.
 *   - This service never touches the chat / AI / order pipelines.
 */

const { RateSubscriber, Message, Conversation, User, Contact } = require("../models");
const env = require("../config/env");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");
const whatsappService = require("./whatsappService");
const pricingService = require("./pricingService");
const { resolveDisplayName } = require("./contactsService");
const { formatIstDateOrdinal } = require("../utils/dateUtils");

// ────────────────────────── Helpers ──────────────────────────

const sanitizePhone = (raw) => {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  // Default assumption: 10-digit Indian → prepend 91
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

// Salutation pick — matches the global display-name priority.
// Expects caller to have resolved `displayName` for this recipient already
// (so it's the same name the admin sees in chat / orders).
// Falls back to legacy fields for back-compat with callers that pass raw
// user objects.
const pickFirstName = ({ displayName, partyName, contactName, firmName, name } = {}) => {
  const source = (displayName || contactName || partyName || firmName || name || "").trim();
  if (!source) return "ji";
  const first = source.split(/\s+/)[0];
  return first || "ji";
};

/**
 * Compute the 4 template variables (name + date + WR5.5 + HB12g base rates).
 * Name is per-recipient, the rest are the same for every message in a batch.
 *
 * Returns { baseVars: { date, wr55Base, hb12Base } } so the per-call name is
 * cheaply interpolated per recipient.
 */
const buildBatchRateVars = async () => {
  const wr = await pricingService.calculatePrice("wr", { size: "5.5", carbonType: "normal" });
  const hb = await pricingService.calculatePrice("hb", { gauge: "12" });

  return {
    date: formatIstDateOrdinal(new Date()),
    wr55Base: String(wr.mergedBase),
    hb12Base: String(hb.mergedBase),
  };
};

// ────────────────────────── Subscriber CRUD ──────────────────────────

const listSubscribers = async ({ search = "", page = 1, limit = 50, onlyActive = false } = {}) => {
  const query = {};
  if (onlyActive) query.isActive = true;
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ phone: rx }, { name: rx }, { firmName: rx }];
  }

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    RateSubscriber.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    RateSubscriber.countDocuments(query),
  ]);

  const activeCount = await RateSubscriber.countDocuments({ isActive: true });

  return { items, total, activeCount, page, limit };
};

const addSubscriber = async ({ phone, name, firmName, notes }, employee) => {
  const cleanPhone = sanitizePhone(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    throw new AppError("Valid phone number is required", 400);
  }

  const update = {
    phone: cleanPhone,
    isActive: true,
    ...(name !== undefined && { name: String(name).trim() }),
    ...(firmName !== undefined && { firmName: String(firmName).trim() }),
    ...(notes !== undefined && { notes: String(notes).trim() }),
    addedBy: employee?._id || null,
    addedByName: employee?.name || "",
  };

  const doc = await RateSubscriber.findOneAndUpdate(
    { phone: cleanPhone },
    { $set: update, $setOnInsert: { createdAt: new Date() } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  logger.info(`[RATE-SUB] ${employee?.name || "?"} added/updated subscriber ${cleanPhone}`);
  return doc;
};

const updateSubscriber = async (id, patch = {}, employee) => {
  const allowed = ["name", "firmName", "notes", "isActive"];
  const update = {};
  for (const k of allowed) if (patch[k] !== undefined) update[k] = patch[k];
  if (Object.keys(update).length === 0) throw new AppError("No valid fields to update", 400);

  const doc = await RateSubscriber.findByIdAndUpdate(id, { $set: update }, { new: true });
  if (!doc) throw new AppError("Subscriber not found", 404);
  logger.info(`[RATE-SUB] ${employee?.name || "?"} updated subscriber ${doc.phone}`);
  return doc;
};

const removeSubscriber = async (id, { hard = false } = {}) => {
  if (hard) {
    const res = await RateSubscriber.findByIdAndDelete(id);
    if (!res) throw new AppError("Subscriber not found", 404);
    return { removed: true, hard: true, phone: res.phone };
  }
  const doc = await RateSubscriber.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true });
  if (!doc) throw new AppError("Subscriber not found", 404);
  return { removed: true, hard: false, phone: doc.phone };
};

// ────────────────────── 24h active users (WA free window) ──────────────────────

/**
 * Users who have SENT us a message within the last 24 hours.
 * These are inside WhatsApp's free-response window — template or
 * regular messages to them do NOT create a new paid conversation.
 */
const get24hRepliedUsers = async () => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rows = await Message.aggregate([
    { $match: { "sender.type": "user", createdAt: { $gte: since }, isDeleted: { $ne: true } } },
    {
      $group: {
        _id: "$conversation",
        lastIncomingAt: { $max: "$createdAt" },
      },
    },
    {
      $lookup: {
        from: Conversation.collection.name,
        localField: "_id",
        foreignField: "_id",
        as: "conv",
      },
    },
    { $unwind: "$conv" },
    {
      $lookup: {
        from: User.collection.name,
        localField: "conv.user",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
    {
      $project: {
        _id: 0,
        phone: { $ifNull: ["$user.phone", "$user.waId"] },
        waId: "$user.waId",
        name: "$user.name",
        partyName: "$user.partyName",
        contactName: "$user.contactName",
        firmName: "$user.firmName",
        lastIncomingAt: 1,
      },
    },
  ]);

  // Deduplicate by phone
  const seen = new Map();
  for (const r of rows) {
    const phone = sanitizePhone(r.phone || r.waId);
    if (!phone) continue;
    if (!seen.has(phone)) seen.set(phone, { ...r, phone });
  }
  return Array.from(seen.values());
};

const count24hRepliedUsers = async () => {
  const list = await get24hRepliedUsers();
  return list.length;
};

// ───────────────────────── Broadcast engine ─────────────────────────

/**
 * Send the rate-update template to an array of recipients.
 * Each recipient object must carry { phone, name/partyName/etc }.
 *
 * onProgress({ index, total, phone, status, error }) is optional and
 * fires for every attempt — useful for live Socket.IO progress updates.
 *
 * updateSubscriberMetrics=true also patches matching RateSubscriber
 * documents with last-send bookkeeping.
 */
const broadcastRateUpdate = async (recipients, { onProgress, updateSubscriberMetrics = false, delayMs = 400 } = {}) => {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { sent: 0, failed: 0, total: 0, errors: [] };
  }

  const templateName = env.WA_RATE_TEMPLATE_NAME;
  const lang = env.WA_RATE_TEMPLATE_LANG;
  if (!templateName) throw new AppError("WA_RATE_TEMPLATE_NAME is not configured", 500);

  const { date, wr55Base, hb12Base } = await buildBatchRateVars();

  // Pre-fetch Contact rows for every recipient phone in ONE query so the
  // greeting uses the same canonical name the admin sees everywhere else
  // (chat / orders). Per-recipient lookup would be O(N) queries.
  const phonesForContactLookup = recipients
    .map((r) => sanitizePhone(r.phone || r.waId))
    .filter(Boolean);
  const contactRows = phonesForContactLookup.length
    ? await Contact.find({ phone: { $in: phonesForContactLookup } })
        .sort({ updatedAt: -1 })
        .lean()
    : [];
  const contactMap = {};
  for (const c of contactRows) {
    if (!contactMap[c.phone]) contactMap[c.phone] = [];
    contactMap[c.phone].push(c);
  }

  let sent = 0;
  let failed = 0;
  const errors = [];
  const total = recipients.length;

  for (let i = 0; i < total; i++) {
    const r = recipients[i];
    const phone = sanitizePhone(r.phone || r.waId);
    if (!phone) {
      failed++;
      errors.push({ phone: r.phone || "", error: "INVALID_PHONE" });
      if (onProgress) onProgress({ index: i, total, phone: r.phone, status: "failed", error: "INVALID_PHONE" });
      continue;
    }

    // Use the SAME resolver the rest of the app uses. Contact (if saved)
    // wins over any legacy partyName / firmName / WA profile name.
    const displayName = resolveDisplayName({
      user: {
        name: r.name,
        partyName: r.partyName,
        firmName: r.firmName,
        contactName: r.contactName,
      },
      contacts: contactMap[phone] || [],
    });
    const firstName = pickFirstName({ ...r, displayName });
    const params = [firstName, date, wr55Base, hb12Base];

    try {
      await whatsappService.sendTemplateMessage(phone, templateName, params, lang);
      sent++;

      if (updateSubscriberMetrics) {
        await RateSubscriber.updateOne(
          { phone },
          {
            $set: { lastSentAt: new Date(), lastSentStatus: "sent", lastSentError: "" },
            $inc: { totalSent: 1 },
          }
        ).catch(() => {});
      }

      if (onProgress) onProgress({ index: i, total, phone, status: "sent" });
    } catch (err) {
      failed++;
      const msg = err.details?.message || err.message || "SEND_FAILED";
      errors.push({ phone, error: msg, code: err.code, subcode: err.subcode });

      if (updateSubscriberMetrics) {
        await RateSubscriber.updateOne(
          { phone },
          {
            $set: { lastSentAt: new Date(), lastSentStatus: "failed", lastSentError: msg },
            $inc: { totalFailed: 1 },
          }
        ).catch(() => {});
      }

      if (onProgress) onProgress({ index: i, total, phone, status: "failed", error: msg });
    }

    // Gentle pacing so we don't hit WA rate limits (80 msg/sec soft cap)
    if (delayMs > 0 && i < total - 1) await new Promise((res) => setTimeout(res, delayMs));
  }

  return { sent, failed, total, errors };
};

const sendRateUpdateToAllSubscribers = async (_employee, opts = {}) => {
  const list = await RateSubscriber.find({ isActive: true }).lean();
  return broadcastRateUpdate(list, { ...opts, updateSubscriberMetrics: true });
};

const sendRateUpdateTo24hReplied = async (_employee, opts = {}) => {
  const list = await get24hRepliedUsers();
  return broadcastRateUpdate(list, { ...opts, updateSubscriberMetrics: false });
};

module.exports = {
  // Subscriber CRUD
  listSubscribers,
  addSubscriber,
  updateSubscriber,
  removeSubscriber,

  // Audience queries
  get24hRepliedUsers,
  count24hRepliedUsers,

  // Broadcast
  buildBatchRateVars,
  broadcastRateUpdate,
  sendRateUpdateToAllSubscribers,
  sendRateUpdateTo24hReplied,

  // Exposed for testing / reuse
  sanitizePhone,
  pickFirstName,
};
