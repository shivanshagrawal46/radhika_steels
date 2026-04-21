/**
 * rateUpdateService — Send Utility-category "rate statement" messages
 * to two audiences:
 *
 *   1. Curated subscribers (admin-managed list).
 *      → Approved WhatsApp templates:
 *          - WA_RATE_TEMPLATE_3P_NAME   (9 vars, 3 product lines)
 *          - WA_RATE_TEMPLATE_5P_NAME   (11 vars, 5 product lines)
 *      → Template body (same structure, only product-line count differs):
 *          Namaste {{1}}, your rate statement #{{2}} is ready as per your account preferences.
 *          Customer ID: {{3}}
 *          Statement: {{4}}
 *          Issued: {{5}}
 *          Previous Statement: #{{6}}
 *          Rate breakdown (Base + Loading + GST):
 *          {{7}}
 *          {{8}}
 *          {{9}}        ← 3p ends here
 *          {{10}}       ← 5p has two more
 *          {{11}}
 *          Rates are market-linked and indicative. Please reconfirm at the time of transaction.
 *          Manage your product list or notification frequency from your account settings.
 *      → Each admin-added subscriber picks EXACTLY 3 or EXACTLY 5 products
 *        from the broadcast catalog (see config/broadcastCatalog.js).
 *
 *   2. Users inside the 24-hour customer-service free window (anyone who
 *      sent us a WA message in the last 24h). For these we send ALL SIX
 *      catalog rates as a plain text message — zero WhatsApp charges
 *      because no template is used inside the open window.
 *
 * IMPORTANT:
 *   - The Utility templates must already be APPROVED in Meta Business
 *     Manager with matching placeholders and language code.
 *   - This service never touches the chat / AI / order pipelines.
 */

const { RateSubscriber, Message, Conversation, User, Contact } = require("../models");
const env = require("../config/env");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");
const whatsappService = require("./whatsappService");
const pricingService = require("./pricingService");
const { resolveDisplayName } = require("./contactsService");
const { formatIstDateTime } = require("../utils/dateUtils");
const {
  BROADCAST_CATALOG,
  listCatalog,
  getProduct,
  validateProductKeys,
} = require("../config/broadcastCatalog");
const { ensureCustomerId } = require("./customerIdService");

// Lazy io accessor — socket may not be initialised yet when this module
// loads, and we only need it at runtime to push live chat events.
const getIO = () => {
  try {
    return require("../socket").getIO();
  } catch {
    return null;
  }
};

// ────────────────────────── Small helpers ──────────────────────────

const sanitizePhone = (raw) => {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  // Default: 10-digit Indian → prefix 91
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

/**
 * Pick the greeting-name used for {{1}}. Uses the SAME resolver the rest
 * of the app uses (chat, orders) so the greeting matches what the admin
 * sees everywhere else. Falls back to "ji" when nothing is available.
 */
const pickFirstName = ({ displayName, partyName, contactName, firmName, name } = {}) => {
  const source = (displayName || contactName || partyName || firmName || name || "").trim();
  if (!source) return "ji";
  const first = source.split(/\s+/)[0];
  return first || "ji";
};

/**
 * Format an integer rate with Indian thousands separator ("52,300").
 * Non-numeric input is returned as an empty string (never crashes a send).
 */
const formatRate = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return Math.round(v).toLocaleString("en-IN");
};

/**
 * Period-of-day label based on current IST hour:
 *   < 12:00 IST           → "Morning"
 *   12:00 ≤ h < 17:00     → "Afternoon"
 *   ≥ 17:00               → "Evening"
 */
const pickPeriodOfDay = (now = new Date()) => {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hourStr = (parts.find((p) => p.type === "hour") || {}).value || "00";
    const hour = parseInt(hourStr, 10);
    if (!Number.isFinite(hour)) return "Morning";
    if (hour < 12) return "Morning";
    if (hour < 17) return "Afternoon";
    return "Evening";
  } catch {
    return "Morning";
  }
};

// ────────────────────────── Rate snapshot ──────────────────────────

/**
 * Fetch current mergedBase (pre-loading, pre-GST) for every product in the
 * catalog ONCE per broadcast, keyed by product key. Per-user line building
 * becomes an O(1) lookup after this.
 *
 * Any individual product that fails to price is recorded in `errors` and
 * omitted from the snapshot — sends to subscribers who selected that
 * product will fail cleanly with a clear error instead of silently lying.
 */
const buildCatalogRateSnapshot = async () => {
  const snapshot = {}; // productKey -> { mergedBase, loadingCharge, displayName }
  const errors = {};
  for (const p of BROADCAST_CATALOG) {
    try {
      const res = await pricingService.calculatePrice(p.category, p.options || {});
      snapshot[p.key] = {
        mergedBase: res.mergedBase,
        loadingCharge: p.loadingCharge,
        displayName: p.displayName,
      };
    } catch (err) {
      errors[p.key] = err.message || "PRICING_FAILED";
      logger.warn(`[RATE-SNAPSHOT] Failed to price ${p.key}: ${errors[p.key]}`);
    }
  }
  return { snapshot, errors };
};

/**
 * Build one "<name>: <base> + <loading> + 18%" line from a snapshot entry.
 * Returns "" if the snapshot lacks this product (caller handles the gap).
 */
const buildProductLine = (productKey, snapshot) => {
  const entry = snapshot[productKey];
  if (!entry) return "";
  const base = formatRate(entry.mergedBase);
  if (!base) return "";
  return `${entry.displayName}: ${base} + ${entry.loadingCharge} + 18%`;
};

// ────────────────────────── Chat persistence ──────────────────────────

/**
 * Persist a broadcast message into the admin chat (Conversation + Message)
 * and push live socket events so the admin UI renders it in real time.
 *
 * Behaviour mirrors chatService.sendEmployeeMessage() so these broadcast
 * messages look identical to manually-typed admin messages in the chat UI
 * (same senderType, same socket events, same delivery-status machinery).
 *
 * What this function intentionally does NOT do:
 *   - It does NOT flip Conversation.handlerType to "employee". A broadcast
 *     is not an admin taking over the conversation — AI should continue
 *     handling any replies.
 *   - It does NOT clear needsAttention / unreadCount. A broadcast has no
 *     bearing on whether the conversation still needs human attention.
 *
 * All failures are swallowed with a warn-log: chat-persistence must NEVER
 * abort an actual WhatsApp send that already succeeded.
 */
const persistBroadcastMessage = async ({
  phone,
  text,
  waResponse,
  employee,
  name,
}) => {
  try {
    if (!phone || !text) return null;
    const io = getIO();

    const user = await User.findOneAndUpdate(
      { waId: phone },
      {
        $set: { phone, lastMessageAt: new Date(), ...(name ? { name } : {}) },
        $setOnInsert: { waId: phone },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    let conversation = await Conversation.findOne({ user: user._id, status: "active" });
    if (!conversation) {
      conversation = await Conversation.create({ user: user._id, handlerType: "ai" });
    }

    const waMessageId = waResponse?.messages?.[0]?.id || "";

    const message = await Message.create({
      conversation: conversation._id,
      sender: { type: "employee", employeeId: employee?._id || null },
      content: { text, mediaType: "none" },
      waMessageId,
      deliveryStatus: waMessageId ? "sent" : "pending",
      sentAt: waMessageId ? new Date() : null,
      readByAdmin: true,
    });

    conversation.messageCount = (conversation.messageCount || 0) + 1;
    conversation.lastMessage = {
      text: text.length > 200 ? `${text.slice(0, 197)}...` : text,
      senderType: "employee",
      mediaType: "none",
      timestamp: new Date(),
    };
    conversation.lastMessageAt = new Date();
    await conversation.save();

    if (io) {
      const populated = await Message.findById(message._id)
        .populate("sender.employeeId", "name")
        .lean();
      const convIdStr = conversation._id.toString();
      io.to(`conv:${convIdStr}`).emit("chat:new_message", {
        conversationId: convIdStr,
        message: populated,
      });
      io.to("employees").emit("chat:conversation_updated", {
        conversationId: convIdStr,
        lastMessage: conversation.lastMessage,
        lastMessageAt: conversation.lastMessageAt,
        handlerType: conversation.handlerType,
        stage: conversation.stage,
        needsAttention: conversation.needsAttention,
      });
    }

    return message;
  } catch (err) {
    logger.warn(
      `[RATE-BROADCAST] chat-persist failed for ${phone}: ${err.message}`
    );
    return null;
  }
};

// ────────────────────────── Subscriber CRUD ──────────────────────────

const listSubscribers = async ({ search = "", page = 1, limit = 50, onlyActive = false } = {}) => {
  const query = {};
  if (onlyActive) query.isActive = true;
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ phone: rx }, { name: rx }, { firmName: rx }, { customerId: rx }];
  }

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    RateSubscriber.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    RateSubscriber.countDocuments(query),
  ]);

  const activeCount = await RateSubscriber.countDocuments({ isActive: true });

  return { items, total, activeCount, page, limit };
};

const addSubscriber = async (
  { phone, name, firmName, notes, subscribedProducts },
  employee
) => {
  const cleanPhone = sanitizePhone(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    throw new AppError("Valid phone number is required", 400);
  }

  // Product selection is required on create, to avoid half-configured rows
  // sitting in the list.
  let productKeys;
  try {
    productKeys = validateProductKeys(subscribedProducts);
  } catch (err) {
    throw new AppError(err.message, 400);
  }

  const update = {
    phone: cleanPhone,
    isActive: true,
    subscribedProducts: productKeys,
    ...(name !== undefined && { name: String(name).trim() }),
    ...(firmName !== undefined && { firmName: String(firmName).trim() }),
    ...(notes !== undefined && { notes: String(notes).trim() }),
    addedBy: employee?._id || null,
    addedByName: employee?.name || "",
  };

  const doc = await RateSubscriber.findOneAndUpdate(
    { phone: cleanPhone },
    { $set: update, $setOnInsert: { createdAt: new Date(), statementCounter: 0 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // Assign a permanent customerId the first time we see this row.
  if (!doc.customerId) {
    const ensured = await ensureCustomerId(doc._id);
    Object.assign(doc, ensured);
  }

  logger.info(
    `[RATE-SUB] ${employee?.name || "?"} added/updated subscriber ${cleanPhone} ` +
    `(${productKeys.length} products: ${productKeys.join(",")})`
  );
  return doc.toObject ? doc.toObject() : doc;
};

const updateSubscriber = async (id, patch = {}, employee) => {
  const allowed = ["name", "firmName", "notes", "isActive"];
  const update = {};
  for (const k of allowed) if (patch[k] !== undefined) update[k] = patch[k];

  // Product list is optional on update — but if supplied, it must validate.
  if (patch.subscribedProducts !== undefined) {
    try {
      update.subscribedProducts = validateProductKeys(patch.subscribedProducts);
    } catch (err) {
      throw new AppError(err.message, 400);
    }
  }

  if (Object.keys(update).length === 0) {
    throw new AppError("No valid fields to update", 400);
  }

  const doc = await RateSubscriber.findByIdAndUpdate(id, { $set: update }, { new: true });
  if (!doc) throw new AppError("Subscriber not found", 404);
  logger.info(`[RATE-SUB] ${employee?.name || "?"} updated subscriber ${doc.phone}`);
  return doc.toObject();
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

// ────────────────────────── 24h replied users ──────────────────────────

/**
 * Everyone who has SENT us a WA message in the last 24h. Sending to these
 * numbers happens INSIDE WhatsApp's free customer-service window, so no
 * template is required and there is no per-conversation charge.
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

  // Dedup by sanitised phone.
  const seen = new Map();
  for (const r of rows) {
    const phone = sanitizePhone(r.phone || r.waId);
    if (!phone) continue;
    if (!seen.has(phone)) seen.set(phone, { ...r, phone });
  }
  return Array.from(seen.values());
};

const count24hRepliedUsers = async () => (await get24hRepliedUsers()).length;

// ────────────────────────── Template param builder ──────────────────────────

const TEMPLATE_3P = () => env.WA_RATE_TEMPLATE_3P_NAME || "rate_statement_3p";
const TEMPLATE_5P = () => env.WA_RATE_TEMPLATE_5P_NAME || "rate_statement_5p";
const TEMPLATE_LANG = () => env.WA_RATE_TEMPLATE_LANG || "en";

/**
 * Pick the approved template for a given product count. Throws a clean
 * AppError when the subscriber has a count we don't have a template for —
 * this can happen if the catalog changes or somebody skipped validation.
 */
const pickTemplateForProductCount = (count) => {
  if (count === 3) return TEMPLATE_3P();
  if (count === 5) return TEMPLATE_5P();
  throw new AppError(`No template registered for ${count} products`, 500);
};

/**
 * Build the ordered parameter list for the 3p / 5p Utility template.
 *
 * The common first six variables are identical for both templates:
 *   {{1}} first name
 *   {{2}} new statement number  (statementCounter + 1)
 *   {{3}} customerId
 *   {{4}} "Daily <period> Notification"
 *   {{5}} issued-at, IST "17 Apr 2026, 09:15 AM"
 *   {{6}} previous statement number, or "N/A" for the first send
 *   {{7..N}} product lines, exactly matching subscribedProducts.length
 *
 * `snapshot` is the rate snapshot for the whole catalog. If any of the
 * subscriber's picked products is missing from the snapshot we throw —
 * callers catch and record the per-recipient failure.
 */
const buildTemplateParams = ({ subscriber, firstName, statementNumber, period, snapshot }) => {
  if (!subscriber?.subscribedProducts?.length) {
    throw new AppError("Subscriber has no products selected", 400);
  }
  const productLines = subscriber.subscribedProducts.map((key) => {
    const line = buildProductLine(key, snapshot);
    if (!line) {
      throw new AppError(`Rate unavailable for product '${key}'`, 500);
    }
    return line;
  });

  const prev = Number(subscriber.statementCounter || 0);
  const issuedAt = formatIstDateTime(new Date()); // e.g. "17 Apr 2026, 09:15 AM"

  const params = [
    firstName,                                // {{1}}
    String(statementNumber),                  // {{2}}
    subscriber.customerId || "",              // {{3}}
    `Daily ${period} Notification`,           // {{4}}
    issuedAt,                                 // {{5}}
    prev > 0 ? String(prev) : "N/A",          // {{6}}
    ...productLines,                          // {{7}} ... {{N}}
  ];
  return params;
};

// ────────────────────────── Broadcast engine ──────────────────────────

/**
 * Core per-batch template sender. Each recipient is a RateSubscriber-like
 * object that MUST carry { _id, phone, customerId, subscribedProducts,
 * statementCounter, ...displayName-ish fields }.
 *
 * onProgress({ index, total, phone, status, error }) is optional and fires
 * once per recipient attempt — useful for live Socket.IO progress streams.
 *
 * Notes:
 *   - Customer ID is auto-assigned if missing (idempotent).
 *   - Statement counter is $inc'd ATOMICALLY before the WA call, using the
 *     returned new value as {{2}}. This guarantees no two sends ever share
 *     the same number for the same customer, even under retries.
 *   - We pace at 400ms between sends by default to stay under WA's 80/sec.
 */
const broadcastRateStatement = async (
  recipients,
  { onProgress, delayMs = 400, employee } = {}
) => {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { sent: 0, failed: 0, total: 0, errors: [] };
  }

  // One rate snapshot for the whole batch (all subscribers share it).
  const { snapshot, errors: snapshotErrors } = await buildCatalogRateSnapshot();
  const period = pickPeriodOfDay(new Date());

  // Pre-resolve display names in ONE Contact query (O(1) vs O(N)).
  const phones = recipients
    .map((r) => sanitizePhone(r.phone || r.waId))
    .filter(Boolean);
  const contactRows = phones.length
    ? await Contact.find({ phone: { $in: phones } }).sort({ updatedAt: -1 }).lean()
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
  const lang = TEMPLATE_LANG();

  for (let i = 0; i < total; i++) {
    const r = recipients[i];
    const phone = sanitizePhone(r.phone || r.waId);

    if (!phone) {
      failed++;
      errors.push({ phone: r.phone || "", error: "INVALID_PHONE" });
      if (onProgress) onProgress({ index: i, total, phone: r.phone, status: "failed", error: "INVALID_PHONE" });
      continue;
    }

    // Resolve display name using the SAME resolver the rest of the app uses.
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

    try {
      // Make sure every subscriber has a customer ID before we render it.
      let subscriber = r;
      if (!subscriber.customerId && subscriber._id) {
        subscriber = await ensureCustomerId(subscriber._id);
      }
      if (!subscriber.customerId) {
        throw new AppError("Subscriber has no customerId", 500);
      }

      // Atomic counter bump. The returned new value is the statement number
      // we render in this message — guaranteed unique per subscriber.
      const bumped = await RateSubscriber.findByIdAndUpdate(
        subscriber._id,
        { $inc: { statementCounter: 1 } },
        { new: true, projection: { statementCounter: 1, subscribedProducts: 1, customerId: 1 } }
      );
      if (!bumped) throw new AppError("Subscriber disappeared before send", 500);

      const newStatementNumber = bumped.statementCounter;
      // statementCounter on the in-memory object passed to buildTemplateParams
      // must represent the PREVIOUS counter (for {{6}}) — which is new - 1.
      const effectiveSubscriber = {
        ...subscriber,
        customerId: bumped.customerId || subscriber.customerId,
        subscribedProducts: bumped.subscribedProducts || subscriber.subscribedProducts,
        statementCounter: newStatementNumber - 1,
      };

      const params = buildTemplateParams({
        subscriber: effectiveSubscriber,
        firstName,
        statementNumber: newStatementNumber,
        period,
        snapshot,
      });

      const templateName = pickTemplateForProductCount(effectiveSubscriber.subscribedProducts.length);
      const waResponse = await whatsappService.sendTemplateMessage(phone, templateName, params, lang);

      // Persist into admin chat so the broadcast is visible in the
      // conversation timeline exactly like any other outbound message.
      const renderedBody = renderTemplateForPreview(
        params,
        effectiveSubscriber.subscribedProducts.length
      );
      await persistBroadcastMessage({
        phone,
        text: renderedBody,
        waResponse,
        employee,
        name: displayName,
      });

      await RateSubscriber.updateOne(
        { _id: subscriber._id },
        {
          $set: {
            lastSentAt: new Date(),
            lastSentStatus: "sent",
            lastSentError: "",
            lastStatementNumber: newStatementNumber,
          },
          $inc: { totalSent: 1 },
        }
      ).catch(() => {});

      sent++;
      if (onProgress) {
        onProgress({ index: i, total, phone, status: "sent", statementNumber: newStatementNumber });
      }
    } catch (err) {
      failed++;
      const msg = err.details?.message || err.message || "SEND_FAILED";
      errors.push({ phone, error: msg, code: err.code, subcode: err.subcode });

      if (r._id) {
        await RateSubscriber.updateOne(
          { _id: r._id },
          {
            $set: { lastSentAt: new Date(), lastSentStatus: "failed", lastSentError: msg },
            $inc: { totalFailed: 1 },
          }
        ).catch(() => {});
      }

      if (onProgress) onProgress({ index: i, total, phone, status: "failed", error: msg });
    }

    if (delayMs > 0 && i < total - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  return { sent, failed, total, errors, snapshotErrors };
};

const sendRateStatementToAllSubscribers = async (employee, opts = {}) => {
  const list = await RateSubscriber.find({
    isActive: true,
    subscribedProducts: { $exists: true, $ne: [] },
  }).lean();
  return broadcastRateStatement(list, { ...opts, employee });
};

// ────────────────────── 24h free-window broadcast (plain text) ──────────────────────

/**
 * Compose the full-catalog rate text used inside the 24h free window.
 * This is a plain WhatsApp text message (NOT a template), which means:
 *   - No category concerns
 *   - No template variable limits (can include all 6 products)
 *   - Zero per-message charge (inside the 24h service window)
 *
 * Format mirrors the Utility template tone so recipients see a consistent
 * "rate statement" voice across both channels.
 */
const buildAllProductsTextMessage = ({ firstName, snapshot, period }) => {
  const lines = [];
  lines.push(`Namaste ${firstName || "ji"},`);
  lines.push("");
  lines.push(`As requested, here is your ${period.toLowerCase()} rate statement from Radhika Steel.`);
  lines.push("");
  lines.push("Rate breakdown (Base + Loading + GST):");
  for (const p of BROADCAST_CATALOG) {
    const line = buildProductLine(p.key, snapshot);
    if (line) lines.push(line);
  }
  lines.push("");
  lines.push("Rates are market-linked and indicative. Please reconfirm at the time of transaction.");
  return lines.join("\n");
};

/**
 * Send a plain-text "all 6 rates" message to every user who replied within
 * the last 24h. This does not consume template quota and is free inside
 * the WhatsApp service window.
 */
const sendAllRatesTo24hReplied = async (
  employee,
  { onProgress, delayMs = 400 } = {}
) => {
  const list = await get24hRepliedUsers();
  if (!list.length) return { sent: 0, failed: 0, total: 0, errors: [] };

  const { snapshot, errors: snapshotErrors } = await buildCatalogRateSnapshot();
  const period = pickPeriodOfDay(new Date());

  // Pre-resolve names in one Contact query.
  const phones = list.map((r) => sanitizePhone(r.phone || r.waId)).filter(Boolean);
  const contactRows = phones.length
    ? await Contact.find({ phone: { $in: phones } }).sort({ updatedAt: -1 }).lean()
    : [];
  const contactMap = {};
  for (const c of contactRows) {
    if (!contactMap[c.phone]) contactMap[c.phone] = [];
    contactMap[c.phone].push(c);
  }

  let sent = 0;
  let failed = 0;
  const errors = [];
  const total = list.length;

  for (let i = 0; i < total; i++) {
    const r = list[i];
    const phone = sanitizePhone(r.phone || r.waId);
    if (!phone) {
      failed++;
      errors.push({ phone: r.phone || "", error: "INVALID_PHONE" });
      if (onProgress) onProgress({ index: i, total, phone: r.phone, status: "failed", error: "INVALID_PHONE" });
      continue;
    }
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

    try {
      const text = buildAllProductsTextMessage({ firstName, snapshot, period });
      const waResponse = await whatsappService.sendTextMessage(phone, text);

      await persistBroadcastMessage({
        phone,
        text,
        waResponse,
        employee,
        name: displayName,
      });

      sent++;
      if (onProgress) onProgress({ index: i, total, phone, status: "sent" });
    } catch (err) {
      failed++;
      const msg = err.response?.data?.error?.message || err.message || "SEND_FAILED";
      errors.push({ phone, error: msg });
      if (onProgress) onProgress({ index: i, total, phone, status: "failed", error: msg });
    }

    if (delayMs > 0 && i < total - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  return { sent, failed, total, errors, snapshotErrors };
};

// ────────────────────────── Preview (no send) ──────────────────────────

/**
 * Dry-run: returns the exact params (and resolved text) that would be sent
 * to a given subscriber right now. Used by the admin UI's "Preview message"
 * button so admins can verify the output before pressing Send.
 */
const previewForSubscriber = async (subscriberId) => {
  const sub = await RateSubscriber.findById(subscriberId).lean();
  if (!sub) throw new AppError("Subscriber not found", 404);
  if (!sub.subscribedProducts || sub.subscribedProducts.length === 0) {
    throw new AppError("Subscriber has no products selected", 400);
  }

  const { snapshot, errors: snapshotErrors } = await buildCatalogRateSnapshot();
  const period = pickPeriodOfDay(new Date());

  // Display name lookup (same resolver as real send).
  const phone = sanitizePhone(sub.phone);
  const contacts = phone
    ? await Contact.find({ phone }).sort({ updatedAt: -1 }).lean()
    : [];
  const displayName = resolveDisplayName({
    user: { name: sub.name, firmName: sub.firmName, contactName: sub.name },
    contacts,
  });
  const firstName = pickFirstName({ displayName });

  const nextStatementNumber = (Number(sub.statementCounter) || 0) + 1;
  const effectiveSub = {
    ...sub,
    customerId: sub.customerId || "(will be assigned on first send)",
    statementCounter: nextStatementNumber - 1,
  };

  const params = buildTemplateParams({
    subscriber: effectiveSub,
    firstName,
    statementNumber: nextStatementNumber,
    period,
    snapshot,
  });

  const templateName = pickTemplateForProductCount(sub.subscribedProducts.length);
  return {
    templateName,
    language: TEMPLATE_LANG(),
    params,
    renderedMessage: renderTemplateForPreview(params, sub.subscribedProducts.length),
    snapshotErrors,
  };
};

/**
 * Render the approved template body client-side for the preview screen.
 * Keep this in sync with the body submitted to Meta.
 */
const renderTemplateForPreview = (params, productCount) => {
  const [p1, p2, p3, p4, p5, p6, ...productLines] = params;
  const productBlock = productLines.slice(0, productCount).join("\n");
  return [
    `Namaste ${p1}, your rate statement #${p2} is ready as per your account preferences.`,
    "",
    `Customer ID: ${p3}`,
    `Statement: ${p4}`,
    `Issued: ${p5}`,
    `Previous Statement: #${p6}`,
    "",
    "Rate breakdown (Base + Loading + GST):",
    productBlock,
    "",
    "Rates are market-linked and indicative. Please reconfirm at the time of transaction.",
    "",
    "Manage your product list or notification frequency from your account settings.",
    "",
    "Account Notification Service",
  ].join("\n");
};

// ────────────────────────── Exports ──────────────────────────

module.exports = {
  // Subscriber CRUD
  listSubscribers,
  addSubscriber,
  updateSubscriber,
  removeSubscriber,

  // Audience queries
  get24hRepliedUsers,
  count24hRepliedUsers,

  // Catalog passthrough (so the socket layer imports from one place)
  listBroadcastCatalog: listCatalog,
  getCatalogProduct: getProduct,

  // Preview + broadcast
  previewForSubscriber,
  sendRateStatementToAllSubscribers,
  sendAllRatesTo24hReplied,

  // Lower-level helpers exposed for tests / reuse
  sanitizePhone,
  pickFirstName,
  pickPeriodOfDay,
  buildCatalogRateSnapshot,
  buildProductLine,
  buildTemplateParams,
  buildAllProductsTextMessage,
  pickTemplateForProductCount,
};
