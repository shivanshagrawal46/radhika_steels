/**
 * rateUpdateHandler — Socket.IO events for the admin-app
 * "Rate Broadcast" module.
 *
 * Subscriber CRUD events (admin-only):
 *   rate_subscribers:list       → paginated list + counts
 *   rate_subscribers:add        → add / re-activate a phone
 *   rate_subscribers:update     → edit name / firm / notes / isActive
 *   rate_subscribers:remove     → soft or hard remove
 *
 * Audience events:
 *   rate_update:preview_24h     → current recipients inside 24h WA free window
 *   rate_update:preview_all     → current active-subscriber list size
 *
 * Broadcast events:
 *   rate_update:send_to_all         → send template to every active subscriber
 *   rate_update:send_to_24h_replied → send template only to 24h-active users
 *
 * Real-time progress:
 *   Server pushes `rate_update:progress` to the "employees" room for
 *   every recipient (index/total/phone/status). When the batch finishes,
 *   `rate_update:done` is emitted with the summary.
 *
 * NOTE: This handler is completely isolated from chat / order pipelines.
 */

const rateUpdateService = require("../services/rateUpdateService");
const logger = require("../config/logger");

const isAdmin = (socket) => ["admin", "manager"].includes(socket.employee?.role);

// Prevent two concurrent broadcasts (they'd mix progress streams)
let _broadcastInFlight = false;

module.exports = (io, socket) => {
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

  // ─────────────── Preview audiences (for button counts) ───────────────
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

  // ─────────────── BROADCAST: all subscribers ───────────────
  socket.on("rate_update:send_to_all", async (_payload, cb) => {
    try {
      if (!isAdmin(socket)) return cb?.({ success: false, error: "Insufficient permissions" });
      if (_broadcastInFlight) return cb?.({ success: false, error: "Another broadcast is already running" });

      _broadcastInFlight = true;
      const startedBy = socket.employee.name;
      logger.info(`[RATE-BROADCAST] Started (audience=all_subscribers) by ${startedBy}`);

      io.to("employees").emit("rate_update:started", {
        audience: "all_subscribers",
        startedBy,
        startedAt: new Date(),
      });

      // Return immediately — progress streams via events
      cb?.({ success: true, data: { started: true, audience: "all_subscribers" } });

      const summary = await rateUpdateService.sendRateUpdateToAllSubscribers(socket.employee, {
        onProgress: (ev) => io.to("employees").emit("rate_update:progress", ev),
      });

      io.to("employees").emit("rate_update:done", {
        audience: "all_subscribers",
        startedBy,
        finishedAt: new Date(),
        ...summary,
      });

      logger.info(`[RATE-BROADCAST] Done (all_subscribers): sent=${summary.sent}, failed=${summary.failed}`);
    } catch (err) {
      logger.error("rate_update:send_to_all error:", err.message);
      io.to("employees").emit("rate_update:done", {
        audience: "all_subscribers",
        error: err.message,
        finishedAt: new Date(),
      });
    } finally {
      _broadcastInFlight = false;
    }
  });

  // ─────────────── BROADCAST: 24h free-window users ───────────────
  socket.on("rate_update:send_to_24h_replied", async (_payload, cb) => {
    try {
      if (!isAdmin(socket)) return cb?.({ success: false, error: "Insufficient permissions" });
      if (_broadcastInFlight) return cb?.({ success: false, error: "Another broadcast is already running" });

      _broadcastInFlight = true;
      const startedBy = socket.employee.name;
      logger.info(`[RATE-BROADCAST] Started (audience=24h_replied) by ${startedBy}`);

      io.to("employees").emit("rate_update:started", {
        audience: "24h_replied",
        startedBy,
        startedAt: new Date(),
      });

      cb?.({ success: true, data: { started: true, audience: "24h_replied" } });

      const summary = await rateUpdateService.sendRateUpdateTo24hReplied(socket.employee, {
        onProgress: (ev) => io.to("employees").emit("rate_update:progress", ev),
      });

      io.to("employees").emit("rate_update:done", {
        audience: "24h_replied",
        startedBy,
        finishedAt: new Date(),
        ...summary,
      });

      logger.info(`[RATE-BROADCAST] Done (24h_replied): sent=${summary.sent}, failed=${summary.failed}`);
    } catch (err) {
      logger.error("rate_update:send_to_24h_replied error:", err.message);
      io.to("employees").emit("rate_update:done", {
        audience: "24h_replied",
        error: err.message,
        finishedAt: new Date(),
      });
    } finally {
      _broadcastInFlight = false;
    }
  });
};
