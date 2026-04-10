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
      const { category, size, carbonType, gauge } = payload;
      const result = await pricingService.calculatePrice(category, { size, carbonType, gauge });
      callback({ success: true, data: result });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── price:update_base — admin sets new WR base rate + push notification to all clients ──
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

      // Broadcast to all employees
      io.to("employees").emit("price:updated", {
        baseRate: newRate,
        table,
        updatedBy: socket.employee.name,
      });

      // Broadcast to all connected clients (/client namespace)
      io.of("/client").emit("price:updated", {
        wrBaseRate,
        updatedAt: new Date(),
      });

      // Send FCM push notification to all approved clients' Flutter apps
      notificationService.notifyPriceUpdate(wrBaseRate, socket.employee._id)
        .then((result) => {
          logger.info(`Price update push sent: ${result.sent} delivered, ${result.failed} failed`);
        })
        .catch((err) => {
          logger.error("Price update push failed:", err.message);
        });

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
};
