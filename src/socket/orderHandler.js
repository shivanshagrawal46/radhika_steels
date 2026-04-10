const orderService = require("../services/orderService");
const logger = require("../config/logger");

module.exports = (io, socket) => {
  // ── order:list ──
  socket.on("order:list", async (filters, callback) => {
    try {
      const { status, page, limit } = filters || {};
      const result = await orderService.getOrdersByStatus(
        status,
        Number(page) || 1,
        Number(limit) || 20
      );
      callback({ success: true, ...result });
    } catch (err) {
      logger.error("order:list error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── order:get ──
  socket.on("order:get", async (orderId, callback) => {
    try {
      const order = await orderService.getOrderById(orderId);
      callback({ success: true, data: order });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── order:create ──
  socket.on("order:create", async (data, callback) => {
    try {
      const order = await orderService.createOrder({
        ...data,
        createdBy: "employee",
      });

      io.to("employees").emit("order:new", order);
      callback({ success: true, data: order });
    } catch (err) {
      logger.error("order:create error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── order:update_status ──
  socket.on("order:update_status", async (payload, callback) => {
    try {
      const { orderId, status } = payload;
      const order = await orderService.updateOrderStatus(
        orderId,
        status,
        socket.employee._id
      );

      io.to("employees").emit("order:updated", {
        orderId,
        status: order.status,
        updatedBy: socket.employee.name,
      });

      callback({ success: true, data: order });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── order:record_payment ──
  socket.on("order:record_payment", async (payload, callback) => {
    try {
      const { orderId, ...paymentData } = payload;
      const order = await orderService.recordAdvancePayment(
        orderId,
        paymentData,
        socket.employee._id
      );

      io.to("employees").emit("order:updated", {
        orderId,
        status: order.status,
        advancePayment: order.advancePayment,
        updatedBy: socket.employee.name,
      });

      callback({ success: true, data: order });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });
};
