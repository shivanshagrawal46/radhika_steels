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
  socket.on("price:calculate", async (payload, callback) => {
    try {
      const { category, size, carbonType, gauge, mm } = payload;
      const result = await pricingService.calculatePrice(category, { size, carbonType, gauge, mm });
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

      // Broadcast full updated table to all connected clients (/client namespace)
      io.of("/client").emit("price:updated", {
        wrBaseRate,
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
