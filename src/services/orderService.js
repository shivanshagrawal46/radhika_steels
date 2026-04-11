const { Order, Conversation } = require("../models");
const AppError = require("../utils/AppError");
const logger = require("../config/logger");

const createOrder = async (orderData) => {
  const order = await Order.create(orderData);
  logger.info(`Order created: ${order.orderNumber}`);
  return order;
};

const getOrderById = async (orderId) => {
  const order = await Order.findById(orderId)
    .populate("user", "name phone company city partyName firmName billName gstNo contactName waId")
    .populate("items.product", "name category")
    .populate("assignedTo", "name email")
    .populate("payments.recordedBy", "name")
    .populate("conversation", "stage handlerType")
    .lean();

  if (!order) throw new AppError("Order not found", 404);
  return order;
};

const updateOrderStatus = async (orderId, status, employeeId) => {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError("Order not found", 404);

  order.status = status;
  if (status === "dispatched" && !order.delivery.dispatchedAt) {
    order.delivery.dispatchedAt = new Date();
  }
  if (status === "delivered" && !order.delivery.deliveredAt) {
    order.delivery.deliveredAt = new Date();
  }
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

  order.advancePayment.amount = (order.advancePayment.amount || 0) + paymentData.amount;
  order.advancePayment.isPaid = true;
  order.advancePayment.paidAt = new Date();

  if (order.status === "advance_pending") {
    order.status = "advance_received";
  }

  await order.save();
  logger.info(`Advance ₹${paymentData.amount} recorded for ${order.orderNumber}`);
  return order;
};

const updateDeliveryDetails = async (orderId, deliveryData, employeeId) => {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError("Order not found", 404);

  if (deliveryData.driverName !== undefined) order.delivery.driverName = deliveryData.driverName;
  if (deliveryData.driverPhone !== undefined) order.delivery.driverPhone = deliveryData.driverPhone;
  if (deliveryData.vehicleNumber !== undefined) order.delivery.vehicleNumber = deliveryData.vehicleNumber;
  if (deliveryData.scheduledDate !== undefined) order.delivery.scheduledDate = deliveryData.scheduledDate ? new Date(deliveryData.scheduledDate) : null;

  await order.save();
  logger.info(`Delivery details updated for ${order.orderNumber} by ${employeeId}`);
  return order;
};

const closeOrder = async (orderId, employeeId) => {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError("Order not found", 404);

  order.closedAt = new Date();
  await order.save();

  if (order.conversation) {
    await Conversation.findByIdAndUpdate(order.conversation, { stage: "closed" });
  }

  logger.info(`Order ${order.orderNumber} closed by ${employeeId}`);
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
      .populate("assignedTo", "name")
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
      .populate("user", "name phone company partyName firmName contactName waId")
      .populate("assignedTo", "name")
      .lean(),
    Order.countDocuments(filter),
  ]);

  return { orders, total, page, totalPages: Math.ceil(total / limit) };
};

const getActiveOrderForUser = async (userId) => {
  return Order.findOne({
    user: userId,
    status: { $nin: ["delivered", "cancelled"] },
    closedAt: null,
  })
    .sort({ createdAt: -1 })
    .lean();
};

module.exports = {
  createOrder,
  getOrderById,
  updateOrderStatus,
  recordAdvancePayment,
  updateDeliveryDetails,
  closeOrder,
  getOrdersByUser,
  getOrdersByStatus,
  getActiveOrderForUser,
};
