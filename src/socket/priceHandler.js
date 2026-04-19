const pricingService = require("../services/pricingService");
const notificationService = require("../services/notificationService");
const logger = require("../config/logger");

module.exports = (io, socket) => {
  // ── price:get_table ──
  socket.on("price:get_table", async (_payload, callback) => {
    try {
      const table = await pricingService.getFullPriceTable();
      callback({ success: true, data: table });
    } catch (err) {
      logger.error("price:get_table error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── price:calculate ──
  // Payload accepts every option pricingService.calculatePrice understands:
  //   { category, size, carbonType, gauge, mm, packaging, random }
  // packaging + random are only relevant for binding; ignored for other
  // categories. For nails pass { category: "nails", gauge, size } (size = inch).
  socket.on("price:calculate", async (payload, callback) => {
    try {
      const { category, size, carbonType, gauge, mm, packaging, random } = payload || {};
      const result = await pricingService.calculatePrice(category, {
        size, carbonType, gauge, mm, packaging, random,
      });
      callback({ success: true, data: result });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── price:update_base — admin sets new WR base rate → all prices recalculate → push to clients ──
  socket.on("price:update_base", async (payload, callback) => {
    try {
      if (!["admin", "manager"].includes(socket.employee.role)) {
        return callback({ success: false, error: "Insufficient permissions" });
      }

      const { wrBaseRate, ...overrides } = payload;
      if (typeof wrBaseRate !== "number" || wrBaseRate <= 0) {
        return callback({ success: false, error: "Invalid base rate" });
      }

      const newRate = await pricingService.updateBaseRate(
        wrBaseRate,
        socket.employee._id,
        overrides
      );

      const table = await pricingService.getFullPriceTable();

      // Broadcast full updated table to all employees
      io.to("employees").emit("price:updated", {
        baseRate: newRate,
        table,
        updatedBy: socket.employee.name,
        updatedAt: new Date(),
      });

      // Broadcast full updated table to all connected clients (/client namespace).
      // Top-level fields (wrBaseRate / bindingRandom20gBasic / nailsBasicRate)
      // let simple clients show the three admin-entered absolutes without
      // diving into `table`. Full category arrays are inside `table`.
      io.of("/client").emit("price:updated", {
        wrBaseRate,
        bindingRandom20gBasic: newRate.bindingRandom20gBasic,
        nailsBasicRate: newRate.nailsBasicRate,
        table,
        updatedAt: new Date(),
      });

      // Build a summary for the FCM push notification body
      let pushBody = `New WR base: ₹${wrBaseRate.toLocaleString("en-IN")}/ton`;
      try {
        const wr55 = table.wr.find((p) => p.size === "5.5" && p.carbonType === "normal");
        const hb12 = table.hb.find((p) => p.gauge === "12");
        if (wr55) pushBody += ` | WR 5.5mm: ₹${wr55.total.toLocaleString("en-IN")}/ton`;
        if (hb12) pushBody += ` | HB 12g: ₹${hb12.total.toLocaleString("en-IN")}/ton`;
      } catch { /* skip summary */ }

      // Send FCM push notification to all approved clients' Flutter apps
      notificationService.notifyPriceUpdate(wrBaseRate, socket.employee._id, pushBody)
        .then((result) => {
          logger.info(`[PRICE] Push sent: ${result.sent} ok, ${result.failed} failed`);
        })
        .catch((err) => {
          logger.error("[PRICE] Push failed:", err.message);
        });

      logger.info(`[PRICE] Base rate updated to ₹${wrBaseRate} by ${socket.employee.name}`);
      callback({ success: true, data: { baseRate: newRate, table } });
    } catch (err) {
      logger.error("price:update_base error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── price:update_admin_absolutes — update ONLY binding-random / nails basic.
  //
  // Admin dashboard calls this when updating the two absolute rates that don't
  // derive from wrBaseRate. WR base is left untouched. Payload:
  //   { bindingRandom20gBasic?: number, nailsBasicRate?: number }
  // At least one field must be present. Broadcasts the same full table refresh
  // as price:update_base so connected admin + client apps stay in sync.
  socket.on("price:update_admin_absolutes", async (payload, callback) => {
    try {
      if (!["admin", "manager"].includes(socket.employee.role)) {
        return callback({ success: false, error: "Insufficient permissions" });
      }

      const updates = {};
      if (payload && Object.prototype.hasOwnProperty.call(payload, "bindingRandom20gBasic")) {
        const v = Number(payload.bindingRandom20gBasic);
        if (!isFinite(v) || v < 0) {
          return callback({ success: false, error: "Invalid bindingRandom20gBasic" });
        }
        updates.bindingRandom20gBasic = v;
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, "nailsBasicRate")) {
        const v = Number(payload.nailsBasicRate);
        if (!isFinite(v) || v < 0) {
          return callback({ success: false, error: "Invalid nailsBasicRate" });
        }
        updates.nailsBasicRate = v;
      }
      if (Object.keys(updates).length === 0) {
        return callback({ success: false, error: "No admin absolutes provided" });
      }

      const newRate = await pricingService.updateAdminAbsolutes(updates, socket.employee._id);
      const table = await pricingService.getFullPriceTable();

      io.to("employees").emit("price:updated", {
        baseRate: newRate,
        table,
        updatedBy: socket.employee.name,
        updatedAt: new Date(),
        scope: "absolutes",
      });
      io.of("/client").emit("price:updated", {
        wrBaseRate: newRate.wrBaseRate,
        bindingRandom20gBasic: newRate.bindingRandom20gBasic,
        nailsBasicRate: newRate.nailsBasicRate,
        table,
        updatedAt: new Date(),
      });

      logger.info(
        `[PRICE] Admin absolutes updated ` +
        Object.entries(updates).map(([k, v]) => `${k}=₹${v}`).join(", ") +
        ` by ${socket.employee.name}`
      );
      callback({ success: true, data: { baseRate: newRate, table } });
    } catch (err) {
      logger.error("price:update_admin_absolutes error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── price:get_base ──
  socket.on("price:get_base", async (_payload, callback) => {
    try {
      const rate = await pricingService.getActiveBaseRate();
      callback({ success: true, data: rate });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── price:history — last N base rate changes ──
  socket.on("price:history", async (payload, callback) => {
    try {
      const { limit = 10 } = payload || {};
      const { BaseRate } = require("../models");
      const history = await BaseRate.find()
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("updatedBy", "name")
        .lean();
      callback({ success: true, data: history });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });
};
