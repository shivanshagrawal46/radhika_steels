const { Order } = require("../models");
const AppError = require("../utils/AppError");
const logger = require("../config/logger");

const createOrder = async (orderData) => {
  const order = await Order.create(orderData);
  logger.info(`Order created: ${order.orderNumber}`);
  return order;
};

const getOrderById = async (orderId) => {
  const order = await Order.findById(orderId)
    .populate("user", "name phone company city")
    .populate("items.product", "name category")
    .populate("assignedTo", "name email")
    .populate("payments.recordedBy", "name")
    .lean();

  if (!order) throw new AppError("Order not found", 404);
  return order;
};

const updateOrderStatus = async (orderId, status, employeeId) => {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError("Order not found", 404);

  order.status = status;
  await order.save();

  logger.info(`Order ${order.orderNumber} status -> ${status} by ${employeeId}`);
  return order;
};

const recordAdvancePayment = async (orderId, paymentData, employeeId) => {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError("Order not found", 404);

  order.payments.push({
    ...paymentData,
    recordedBy: employeeId,
  });

  order.advancePayment.amount += paymentData.amount;
  order.advancePayment.isPaid = true;
  order.advancePayment.paidAt = new Date();

  if (order.status === "advance_pending") {
    order.status = "advance_received";
  }

  await order.save();
  logger.info(`Advance ₹${paymentData.amount} recorded for ${order.orderNumber}`);
  return order;
};

const getOrdersByUser = async (userId, page = 1, limit = 20) => {
  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("items.product", "name category")
      .lean(),
    Order.countDocuments({ user: userId }),
  ]);

  return { orders, total, page, totalPages: Math.ceil(total / limit) };
};

const getOrdersByStatus = async (status, page = 1, limit = 20) => {
  const skip = (page - 1) * limit;
  const filter = status ? { status } : {};

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "name phone company")
      .populate("assignedTo", "name")
      .lean(),
    Order.countDocuments(filter),
  ]);

  return { orders, total, page, totalPages: Math.ceil(total / limit) };
};

module.exports = {
  createOrder,
  getOrderById,
  updateOrderStatus,
  recordAdvancePayment,
  getOrdersByUser,
  getOrdersByStatus,
};
