/**
 * rateUpdateHandler — Socket.IO events for the admin-side
 * "Rate Broadcast" module.
 *
 * ───────────── Subscriber management ─────────────
 *   rate_subscribers:list           → paginated + searchable list + counts
 *   rate_subscribers:add            → create or re-activate a subscriber
 *                                     (phone + subscribedProducts required)
 *   rate_subscribers:update         → edit name / firmName / notes /
 *                                     isActive / subscribedProducts
 *   rate_subscribers:remove         → soft or hard remove
 *   rate_subscribers:preview        → dry-run the exact template params +
 *                                     rendered body for ONE subscriber
 *
 * ───────────── Catalog ─────────────
 *   broadcast_catalog:list          → the 6 available products the admin
 *                                     can pick from
 *
 * ───────────── Audiences (for button counts) ─────────────
 *   rate_update:preview_24h         → phones currently inside the WA
 *                                     24h free window (will receive all
 *                                     6 rates as a plain-text message)
 *   rate_update:preview_all         → count of active subscribers (will
 *                                     receive the Utility template with
 *                                     their picked products)
 *
 * ───────────── Broadcasts ─────────────
 *   rate_update:send_to_all         → sends the approved Utility
 *                                     template to every active subscriber
 *                                     using THEIR selected products.
 *   rate_update:send_to_24h_replied → sends all 6 product rates as a
 *                                     single plain-text message to the
 *                                     24h-replied audience (FREE, no
 *                                     template used).
 *
 * ───────────── Real-time progress broadcast ─────────────
 *   Server pushes these to the "employees" room:
 *     rate_update:started           ({ audience, startedBy, startedAt })
 *     rate_update:progress          ({ index, total, phone, status, ... })
 *     rate_update:done              ({ audience, sent, failed, total, errors })
 *     rate_subscribers:updated      ({ action: "add"|"update"|"remove", ... })
 *
 * Isolation: this module does not touch chat / AI / order pipelines.
 */

const rateUpdateService = require("../services/rateUpdateService");
const logger = require("../config/logger");

const isAdmin = (socket) => ["admin", "manager"].includes(socket.employee?.role);

// Prevent two concurrent broadcasts (they'd interleave progress streams and
// blow statement counters up in unpredictable ways under load).
let _broadcastInFlight = false;

const runExclusiveBroadcast = async (io, socket, audience, runner, cb) => {
  if (!isAdmin(socket)) {
    cb?.({ success: false, error: "Insufficient permissions" });
    return;
  }
  if (_broadcastInFlight) {
    cb?.({ success: false, error: "Another broadcast is already running" });
    return;
  }
  _broadcastInFlight = true;
  const startedBy = socket.employee?.name || "unknown";
  const startedAt = new Date();

  logger.info(`[RATE-BROADCAST] Started (audience=${audience}) by ${startedBy}`);
  io.to("employees").emit("rate_update:started", { audience, startedBy, startedAt });

  // Ack the caller immediately — real progress comes via events.
  cb?.({ success: true, data: { started: true, audience, startedAt } });

  try {
    const summary = await runner((ev) =>
      io.to("employees").emit("rate_update:progress", { audience, ...ev })
    );
    io.to("employees").emit("rate_update:done", {
      audience,
      startedBy,
      startedAt,
      finishedAt: new Date(),
      ...summary,
    });
    logger.info(
      `[RATE-BROADCAST] Done (audience=${audience}): sent=${summary.sent}, ` +
      `failed=${summary.failed}, total=${summary.total}`
    );
  } catch (err) {
    logger.error(`[RATE-BROADCAST] audience=${audience} crashed:`, err.message);
    io.to("employees").emit("rate_update:done", {
      audience,
      startedBy,
      startedAt,
      finishedAt: new Date(),
      error: err.message || "BROADCAST_FAILED",
      sent: 0,
      failed: 0,
      total: 0,
      errors: [],
    });
  } finally {
    _broadcastInFlight = false;
  }
};

module.exports = (io, socket) => {
  // ─────────────── Catalog ───────────────
  socket.on("broadcast_catalog:list", async (_payload, cb) => {
    try {
      cb?.({ success: true, data: { catalog: rateUpdateService.listBroadcastCatalog() } });
    } catch (err) {
      cb?.({ success: false, error: err.message });
    }
  });

  // ─────────────── Subscribers list ───────────────
  socket.on("rate_subscribers:list", async (payload = {}, cb) => {
    try {
      const data = await rateUpdateService.listSubscribers({
        search: payload.search || "",
        page: payload.page || 1,
        limit: Math.min(payload.limit || 50, 200),
        onlyActive: !!payload.onlyActive,
      });
      cb?.({ success: true, data });
    } catch (err) {
      logger.error("rate_subscribers:list error:", err.message);
      cb?.({ success: false, error: err.message });
    }
  });

  // ─────────────── Add subscriber ───────────────
  socket.on("rate_subscribers:add", async (payload = {}, cb) => {
    try {
      if (!isAdmin(socket)) return cb?.({ success: false, error: "Insufficient permissions" });
      const doc = await rateUpdateService.addSubscriber(payload, socket.employee);
      io.to("employees").emit("rate_subscribers:updated", { action: "add", subscriber: doc });
      cb?.({ success: true, data: doc });
    } catch (err) {
      logger.warn("rate_subscribers:add error:", err.message);
      cb?.({ success: false, error: err.message });
    }
  });

  // ─────────────── Update subscriber ───────────────
  socket.on("rate_subscribers:update", async (payload = {}, cb) => {
    try {
      if (!isAdmin(socket)) return cb?.({ success: false, error: "Insufficient permissions" });
      const { id, ...patch } = payload;
      if (!id) return cb?.({ success: false, error: "id is required" });
      const doc = await rateUpdateService.updateSubscriber(id, patch, socket.employee);
      io.to("employees").emit("rate_subscribers:updated", { action: "update", subscriber: doc });
      cb?.({ success: true, data: doc });
    } catch (err) {
      logger.warn("rate_subscribers:update error:", err.message);
      cb?.({ success: false, error: err.message });
    }
  });

  // ─────────────── Remove subscriber ───────────────
  socket.on("rate_subscribers:remove", async (payload = {}, cb) => {
    try {
      if (!isAdmin(socket)) return cb?.({ success: false, error: "Insufficient permissions" });
      const { id, hard = false } = payload;
      if (!id) return cb?.({ success: false, error: "id is required" });
      const res = await rateUpdateService.removeSubscriber(id, { hard: !!hard });
      io.to("employees").emit("rate_subscribers:updated", { action: "remove", id, hard: !!hard });
      cb?.({ success: true, data: res });
    } catch (err) {
      logger.warn("rate_subscribers:remove error:", err.message);
      cb?.({ success: false, error: err.message });
    }
  });

  // ─────────────── Preview message for one subscriber ───────────────
  socket.on("rate_subscribers:preview", async (payload = {}, cb) => {
    try {
      const { id } = payload;
      if (!id) return cb?.({ success: false, error: "id is required" });
      const preview = await rateUpdateService.previewForSubscriber(id);
      cb?.({ success: true, data: preview });
    } catch (err) {
      logger.warn("rate_subscribers:preview error:", err.message);
      cb?.({ success: false, error: err.message });
    }
  });

  // ─────────────── Preview audiences (button counts) ───────────────
  socket.on("rate_update:preview_24h", async (_payload, cb) => {
    try {
      const list = await rateUpdateService.get24hRepliedUsers();
      cb?.({ success: true, data: { count: list.length, users: list } });
    } catch (err) {
      logger.error("rate_update:preview_24h error:", err.message);
      cb?.({ success: false, error: err.message });
    }
  });

  socket.on("rate_update:preview_all", async (_payload, cb) => {
    try {
      const data = await rateUpdateService.listSubscribers({ onlyActive: true, limit: 1 });
      cb?.({ success: true, data: { count: data.activeCount } });
    } catch (err) {
      cb?.({ success: false, error: err.message });
    }
  });

  // ─────────────── BROADCAST: all active subscribers (Utility template) ───────────────
  socket.on("rate_update:send_to_all", async (_payload, cb) => {
    await runExclusiveBroadcast(io, socket, "all_subscribers", async (onProgress) => {
      return rateUpdateService.sendRateStatementToAllSubscribers(socket.employee, { onProgress });
    }, cb);
  });

  // ─────────────── BROADCAST: 24h replied users (free-form, all 6 rates) ───────────────
  socket.on("rate_update:send_to_24h_replied", async (_payload, cb) => {
    await runExclusiveBroadcast(io, socket, "24h_replied", async (onProgress) => {
      return rateUpdateService.sendAllRatesTo24hReplied(socket.employee, { onProgress });
    }, cb);
  });
};
