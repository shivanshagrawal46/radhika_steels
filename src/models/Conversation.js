const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "closed", "escalated"],
      default: "active",
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    handlerType: {
      type: String,
      enum: ["ai", "employee"],
      default: "ai",
    },
    employeeTakenAt: {
      type: Date,
      default: null,
    },

    // ── Order pipeline stage (visible on admin dashboard) ──
    stage: {
      type: String,
      enum: [
        "talking",
        "price_inquiry",
        "negotiation",
        "order_confirmed",
        "advance_pending",
        "advance_received",
        "payment_complete",
        "dispatched",
        "delivered",
        "closed",
      ],
      default: "talking",
    },

    // ── Linked order (created when user confirms) ──
    linkedOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },

    // ── AI context ──
    context: {
      lastIntent: { type: String, default: "" },
      pendingAction: { type: String, default: "" },
      negotiationActive: { type: Boolean, default: false },
      lastDetectedProduct: {
        category: { type: String, default: "" },
        size: { type: String, default: "" },
        gauge: { type: String, default: "" },
        mm: { type: String, default: "" },
        carbonType: { type: String, default: "" },
        quantity: { type: Number, default: 0 },
        unit: { type: String, default: "" },
      },
      deliveryInquiry: { type: Boolean, default: false },
      metadata: {
        type: Map,
        of: mongoose.Schema.Types.Mixed,
        default: {},
      },
    },

    // ── AI needs employee attention ──
    needsAttention: { type: Boolean, default: false },
    needsAttentionAt: { type: Date, default: null },
    needsAttentionReason: { type: String, default: "" },

    // ── Unread tracking ──
    unreadCount: {
      type: Number,
      default: 0,
    },

    // ── Last message preview ──
    lastMessage: {
      text: { type: String, default: "" },
      senderType: { type: String, default: "" },
      mediaType: { type: String, default: "none" },
      timestamp: { type: Date, default: null },
    },

    messageCount: {
      type: Number,
      default: 0,
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

conversationSchema.index({ status: 1, lastMessageAt: -1 });
conversationSchema.index({ stage: 1, lastMessageAt: -1 });
conversationSchema.index({ assignedTo: 1, status: 1 });
conversationSchema.index({ user: 1, status: 1 });
conversationSchema.index({ unreadCount: -1, lastMessageAt: -1 });
conversationSchema.index({ needsAttention: 1, needsAttentionAt: -1 });

conversationSchema.virtual("messages", {
  ref: "Message",
  localField: "_id",
  foreignField: "conversation",
});

module.exports = mongoose.model("Conversation", conversationSchema);
