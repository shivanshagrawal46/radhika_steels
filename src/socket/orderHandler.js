const { Order, Conversation, User, Contact } = require("../models");
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

  // ── order:list_by_user — all orders for a specific user/party ──
  socket.on("order:list_by_user", async (payload, callback) => {
    try {
      const { userId, page = 1, limit = 20 } = payload;
      const result = await orderService.getOrdersByUser(userId, page, limit);
      callback({ success: true, ...result });
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

  // ── order:confirm — employee manually confirms an order ──
  socket.on("order:confirm", async (payload, callback) => {
    try {
      const { orderId } = payload;
      const order = await Order.findById(orderId);
      if (!order) return callback({ success: false, error: "Order not found" });

      order.status = "advance_pending";
      order.assignedTo = socket.employee._id;
      await order.save();

      if (order.conversation) {
        await Conversation.findByIdAndUpdate(order.conversation, {
          stage: "advance_pending",
          linkedOrder: order._id,
        });
      }

      io.to("employees").emit("order:updated", {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        status: order.status,
        updatedBy: socket.employee.name,
      });

      callback({ success: true, data: order });
    } catch (err) {
      logger.error("order:confirm error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── order:update_status ──
  socket.on("order:update_status", async (payload, callback) => {
    try {
      const { orderId, status } = payload;
      const order = await orderService.updateOrderStatus(orderId, status, socket.employee._id);

      if (order.conversation) {
        const stageMap = {
          advance_pending: "advance_pending",
          advance_received: "advance_received",
          confirmed: "order_confirmed",
          processing: "order_confirmed",
          dispatched: "dispatched",
          delivered: "delivered",
          cancelled: "closed",
        };
        if (stageMap[status]) {
          await Conversation.findByIdAndUpdate(order.conversation, { stage: stageMap[status] });
        }
      }

      io.to("employees").emit("order:updated", {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        status: order.status,
        updatedBy: socket.employee.name,
      });

      callback({ success: true, data: order });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── order:record_payment — advance or balance payment ──
  socket.on("order:record_payment", async (payload, callback) => {
    try {
      const { orderId, amount, method, reference, note, isAdvance } = payload;
      const order = await Order.findById(orderId);
      if (!order) return callback({ success: false, error: "Order not found" });

      order.payments.push({
        amount,
        method: method || "bank_transfer",
        reference: reference || "",
        note: note || "",
        recordedBy: socket.employee._id,
      });

      if (isAdvance !== false) {
        order.advancePayment.amount = (order.advancePayment.amount || 0) + amount;
        order.advancePayment.isPaid = true;
        order.advancePayment.paidAt = new Date();
        if (order.status === "advance_pending") {
          order.status = "advance_received";
        }
      }

      await order.save();

      if (order.conversation && order.status === "advance_received") {
        await Conversation.findByIdAndUpdate(order.conversation, { stage: "advance_received" });
      }

      io.to("employees").emit("order:updated", {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        status: order.status,
        advancePayment: order.advancePayment,
        totalPayments: order.payments.reduce((s, p) => s + p.amount, 0),
        updatedBy: socket.employee.name,
      });

      callback({ success: true, data: order });
    } catch (err) {
      logger.error("order:record_payment error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── order:update_delivery — set driver, vehicle, scheduled date ──
  socket.on("order:update_delivery", async (payload, callback) => {
    try {
      const { orderId, driverName, driverPhone, vehicleNumber, scheduledDate } = payload;
      const order = await Order.findById(orderId);
      if (!order) return callback({ success: false, error: "Order not found" });

      if (driverName !== undefined) order.delivery.driverName = driverName;
      if (driverPhone !== undefined) order.delivery.driverPhone = driverPhone;
      if (vehicleNumber !== undefined) order.delivery.vehicleNumber = vehicleNumber;
      if (scheduledDate !== undefined) order.delivery.scheduledDate = scheduledDate ? new Date(scheduledDate) : null;

      await order.save();

      io.to("employees").emit("order:updated", {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        delivery: order.delivery,
        updatedBy: socket.employee.name,
      });

      callback({ success: true, data: order });
    } catch (err) {
      logger.error("order:update_delivery error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── order:dispatch — mark as dispatched ──
  socket.on("order:dispatch", async (payload, callback) => {
    try {
      const { orderId } = payload;
      const order = await Order.findById(orderId);
      if (!order) return callback({ success: false, error: "Order not found" });

      order.status = "dispatched";
      order.delivery.dispatchedAt = new Date();
      await order.save();

      if (order.conversation) {
        await Conversation.findByIdAndUpdate(order.conversation, { stage: "dispatched" });
      }

      io.to("employees").emit("order:updated", {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        status: "dispatched",
        delivery: order.delivery,
        updatedBy: socket.employee.name,
      });

      callback({ success: true, data: order });
    } catch (err) {
      logger.error("order:dispatch error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── order:mark_delivered — mark as delivered ──
  socket.on("order:mark_delivered", async (payload, callback) => {
    try {
      const { orderId } = payload;
      const order = await Order.findById(orderId);
      if (!order) return callback({ success: false, error: "Order not found" });

      order.status = "delivered";
      order.delivery.deliveredAt = new Date();
      await order.save();

      if (order.conversation) {
        await Conversation.findByIdAndUpdate(order.conversation, { stage: "delivered" });
      }

      io.to("employees").emit("order:updated", {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        status: "delivered",
        delivery: order.delivery,
        updatedBy: socket.employee.name,
      });

      callback({ success: true, data: order });
    } catch (err) {
      logger.error("order:mark_delivered error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── order:close — close a completed order ──
  socket.on("order:close", async (payload, callback) => {
    try {
      const { orderId } = payload;
      const order = await Order.findById(orderId);
      if (!order) return callback({ success: false, error: "Order not found" });

      order.closedAt = new Date();
      await order.save();

      if (order.conversation) {
        await Conversation.findByIdAndUpdate(order.conversation, { stage: "closed" });
      }

      io.to("employees").emit("order:updated", {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        status: order.status,
        closedAt: order.closedAt,
        updatedBy: socket.employee.name,
      });

      callback({ success: true, data: order });
    } catch (err) {
      logger.error("order:close error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── order:dashboard — summary for admin dashboard ──
  socket.on("order:dashboard", async (_payload, callback) => {
    try {
      const [statusCounts, recentOrders, totalRevenue] = await Promise.all([
        Order.aggregate([
          { $group: { _id: "$status", count: { $sum: 1 }, totalValue: { $sum: "$pricing.grandTotal" } } },
          { $sort: { _id: 1 } },
        ]),
        Order.find()
          .sort({ createdAt: -1 })
          .limit(10)
          .populate("user", "name phone partyName firmName contactName waId")
          .populate("assignedTo", "name")
          .lean(),
        Order.aggregate([
          { $match: { status: { $nin: ["cancelled", "inquiry"] } } },
          { $group: { _id: null, total: { $sum: "$pricing.grandTotal" }, count: { $sum: 1 } } },
        ]),
      ]);

      callback({
        success: true,
        data: {
          statusCounts,
          recentOrders,
          totalRevenue: totalRevenue[0] || { total: 0, count: 0 },
        },
      });
    } catch (err) {
      logger.error("order:dashboard error:", err.message);
      callback({ success: false, error: err.message });
    }
  });
};
