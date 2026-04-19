const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
    category: { type: String, enum: ["wr", "hb", "binding", "nails"], required: true },
    productName: { type: String, default: "" },
    size: { type: String, default: null },
    gauge: { type: String, default: null },
    mm: { type: String, default: null },
    // User's exact requested mm range for HB wire, e.g. "5.2-5.3" or "5.3".
    // Gauge-only queries (no mm specified) leave this null. Admin relies on
    // this to know which specific size within the gauge the customer wants.
    mmRange: { type: String, default: null },
    carbonType: { type: String, enum: ["normal", "lc"], default: "normal" },
    // Binding-specific: "without" (default) or "with" wrapper; random applies
    // only to 20g binding.
    packaging: { type: String, enum: ["without", "with", null], default: null },
    random: { type: Boolean, default: false },
    // Nails-specific: inch token ("1", "1.5", "2", "2.5", "3", "4", "5", "6").
    // Stored in addition to `size` for forward-compatibility; admin dashboards
    // can read either field.
    inch: { type: String, default: null },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, default: "ton" }, // "ton" for wr/hb/binding, "kg" for nails
    unitPrice: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    method: {
      type: String,
      enum: ["cash", "bank_transfer", "upi", "cheque", "other"],
      default: "bank_transfer",
    },
    reference: { type: String, default: "" },
    note: { type: String, default: "" },
    receivedAt: { type: Date, default: Date.now },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
      default: function () {
        const ts = Date.now().toString(36).toUpperCase();
        const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        return `RS-${ts}-${rand}`;
      },
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    items: [orderItemSchema],
    pricing: {
      subtotal: { type: Number, default: 0 },
      taxAmount: { type: Number, default: 0 },
      freight: { type: Number, default: 0 },
      discount: { type: Number, default: 0 },
      grandTotal: { type: Number, default: 0 },
    },
    advancePayment: {
      amount: { type: Number, default: 0 },
      isPaid: { type: Boolean, default: false },
      paidAt: { type: Date, default: null },
    },
    payments: [paymentSchema],
    status: {
      type: String,
      enum: [
        "inquiry",
        "quoted",
        "advance_pending",
        "advance_received",
        "confirmed",
        "processing",
        "dispatched",
        "delivered",
        "cancelled",
      ],
      default: "inquiry",
    },
    delivery: {
      driverName: { type: String, default: "" },
      driverPhone: { type: String, default: "" },
      vehicleNumber: { type: String, default: "" },
      scheduledDate: { type: Date, default: null },
      dispatchedAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
    },
    deliveryAddress: {
      line1: { type: String, default: "" },
      line2: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, default: "" },
    },
    closedAt: { type: Date, default: null },
    notes: { type: String, default: "" },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    createdBy: {
      type: String,
      enum: ["ai", "employee"],
      default: "ai",
    },
  },
  {
    timestamps: true,
  }
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ assignedTo: 1, status: 1 });
orderSchema.index({ conversation: 1 });




module.exports = mongoose.model("Order", orderSchema);
