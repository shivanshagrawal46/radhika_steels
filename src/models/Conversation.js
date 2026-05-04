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
      // ── Negotiation flow tracking (added for AI negotiator). All four
      // fields are written by negotiationService and read by both the
      // scheduler and chatService. Old conversations created before this
      // schema landed will simply have an empty `negotiation` subdoc and
      // every default below applies — fully backwards-compatible.
      negotiation: {
        // # of polite refusals AI has sent in this conversation. Hard cap
        // is enforced in negotiationService.MAX_REFUSALS_PER_CONVERSATION
        // (currently 2) — beyond that we stay silent + notify dashboard.
        refusalCount: { type: Number, default: 0 },
        // The Message ObjectId of the latest AI refusal — used to (a) match
        // the 'read' status update so we know exactly when to schedule the
        // follow-up, and (b) fetch the refusal back when the scheduler runs.
        lastRefusalMessageId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Message",
          default: null,
        },
        // Set to (read-time + 10 min) ONLY when the refusal's WhatsApp status
        // becomes 'read'. Until then this stays null and the scheduler can't
        // pick it up — that's how we enforce "follow up only if seen".
        followUpDueAt: { type: Date, default: null },
        // Flipped to true the moment the scheduler claims this conversation
        // (atomic findOneAndUpdate) so the same follow-up can never fire
        // twice. Also flipped to true by the cancel logic in chatService
        // when the customer changes topic before the follow-up fires.
        followUpSent: { type: Boolean, default: false },
      },
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
// Negotiation follow-up scheduler index — sparse so it only stores docs
// that actually have a due date set (the vast majority of conversations
// will have followUpDueAt=null and be skipped from the index entirely).
conversationSchema.index(
  { "context.negotiation.followUpDueAt": 1, "context.negotiation.followUpSent": 1 },
  { sparse: true }
);

conversationSchema.virtual("messages", {
  ref: "Message",
  localField: "_id",
  foreignField: "conversation",
});

module.exports = mongoose.model("Conversation", conversationSchema);
