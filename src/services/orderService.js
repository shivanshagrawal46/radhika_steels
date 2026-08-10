const { Order, Conversation, Contact, Client } = require("../models");
const AppError = require("../utils/AppError");
const logger = require("../config/logger");
const { resolveDisplayName } = require("./contactsService");

/**
 * Billing identity for the invoice. Deliberately kept separate from
 * `displayName`: that one prefers the phonebook name an admin saved for the
 * number and can be anything ("Ramesh bhai Raipur"), whereas these are the
 * details the customer gave us to bill against.
 *
 * `User` wins over the app `Client` profile because both the WhatsApp billing
 * flow and the admin's party editor write to `User`, so it's the fresher copy.
 */
function buildBilling(user, client) {
  return {
    firmName: user?.firmName || client?.firmName || "",
    gstNo: user?.gstNo || client?.gstNumber || "",
    billName: user?.billName || "",
  };
}

// Decorate a single plain (lean) order object with a resolved `displayName`
// plus the `billing` block, so admin-frontend never has to pick between
// name/partyName/firmName/... or go fetch the customer separately.
async function attachCustomerInfoToOrder(order) {
  if (!order) return order;
  const phone = order?.user?.phone || order?.user?.waId;
  let contacts = [];
  let client = null;
  if (phone) {
    [contacts, client] = await Promise.all([
      Contact.find({ phone }).sort({ updatedAt: -1 }).lean(),
      Client.findOne({ phone }, { firmName: 1, gstNumber: 1 }).lean(),
    ]);
  }
  order.displayName = resolveDisplayName({ user: order.user, contacts }) || phone || "";
  order.billing = buildBilling(order.user, client);
  return order;
}

// Batched version: one Contact query and one Client query for many orders.
async function attachCustomerInfoToOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return orders;
  const phones = new Set();
  for (const o of orders) {
    const ph = o?.user?.phone || o?.user?.waId;
    if (ph) phones.add(ph);
  }
  if (phones.size === 0) {
    for (const o of orders) {
      o.displayName = "";
      o.billing = buildBilling(o?.user, null);
    }
    return orders;
  }

  const phoneList = Array.from(phones);
  const [contacts, clients] = await Promise.all([
    Contact.find({ phone: { $in: phoneList } }).sort({ updatedAt: -1 }).lean(),
    Client.find({ phone: { $in: phoneList } }, { phone: 1, firmName: 1, gstNumber: 1 }).lean(),
  ]);

  const contactsByPhone = {};
  for (const c of contacts) {
    if (!contactsByPhone[c.phone]) contactsByPhone[c.phone] = [];
    contactsByPhone[c.phone].push(c);
  }
  const clientByPhone = {};
  for (const c of clients) clientByPhone[c.phone] = c;

  for (const o of orders) {
    const ph = o?.user?.phone || o?.user?.waId || "";
    o.displayName = resolveDisplayName({ user: o.user, contacts: contactsByPhone[ph] || [] }) || ph || "";
    o.billing = buildBilling(o?.user, clientByPhone[ph] || null);
  }
  return orders;
}

// Attach a consistent payment summary to any order object (plain JSON from .lean()).
// Frontend can read order.paymentSummary.{total,paid,remaining,...} directly —
// no recomputation needed. Advance is flexible: customer can pay any amount,
// so we only track actuals here — no "required advance" concept enforced.
function withPaymentSummary(order) {
  if (!order) return order;
  const total = Math.round(Number(order?.pricing?.grandTotal) || 0);
  // Prefer sum of payments[] (most accurate); fall back to advancePayment.amount.
  const paidFromPayments = Array.isArray(order.payments)
    ? order.payments.reduce((s, p) => s + (Number(p?.amount) || 0), 0)
    : 0;
  const paid = Math.round(paidFromPayments || Number(order?.advancePayment?.amount) || 0);
  const remaining = Math.max(0, total - paid);
  order.paymentSummary = {
    total,
    paid,
    remaining,
    fullyPaid: remaining === 0 && total > 0,
    paymentStatus: total === 0
      ? "no_pricing"
      : paid === 0
        ? "unpaid"
        : remaining === 0
          ? "fully_paid"
          : "partially_paid",
  };
  return order;
}

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
  await attachCustomerInfoToOrder(order);
  return withPaymentSummary(order);
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
      .populate("user", "name phone company city partyName firmName billName gstNo contactName waId")
      .populate("items.product", "name category")
      .populate("assignedTo", "name")
      .lean(),
    Order.countDocuments({ user: userId }),
  ]);

  await attachCustomerInfoToOrders(orders);
  return { orders: orders.map(withPaymentSummary), total, page, totalPages: Math.ceil(total / limit) };
};

const getOrdersByStatus = async (status, page = 1, limit = 20) => {
  const skip = (page - 1) * limit;
  const filter = status ? { status } : {};

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "name phone company city partyName firmName billName gstNo contactName waId")
      .populate("assignedTo", "name")
      .lean(),
    Order.countDocuments(filter),
  ]);

  await attachCustomerInfoToOrders(orders);
  return { orders: orders.map(withPaymentSummary), total, page, totalPages: Math.ceil(total / limit) };
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
  attachCustomerInfoToOrder,
  attachCustomerInfoToOrders,
  buildBilling,
};
