const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },

    sender: {
      type: {
        type: String,
        enum: ["user", "ai", "employee", "system"],
        required: true,
      },
      employeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
        default: null,
      },
    },

    // ---- Content ----
    content: {
      text: { type: String, default: "" },

      // Media
      mediaType: {
        type: String,
        enum: ["none", "image", "document", "audio", "video", "sticker", "location", "contact"],
        default: "none",
      },
      mediaUrl: { type: String, default: "" },
      mediaLocalPath: { type: String, default: "" },
      waMediaId: { type: String, default: "" },
      mimeType: { type: String, default: "" },
      fileName: { type: String, default: "" },
      fileSize: { type: Number, default: 0 },
      caption: { type: String, default: "" },

      // Location (if mediaType === "location")
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      locationName: { type: String, default: "" },
    },

    // ---- Reply reference (for "reply to" feature) ----
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },

    // ---- WhatsApp tracking ----
    waMessageId: {
      type: String,
      default: "",
    },
    waTimestamp: {
      type: Date,
      default: null,
    },

    // ---- Delivery status (outgoing messages) ----
    deliveryStatus: {
      type: String,
      enum: ["pending", "sent", "delivered", "read", "failed"],
      default: "pending",
    },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failureReason: { type: String, default: "" },

    // ---- Admin read tracking (for unread badge) ----
    readByAdmin: {
      type: Boolean,
      default: false,
    },
    readByAdminAt: {
      type: Date,
      default: null,
    },

    // ---- AI metadata ----
    aiMetadata: {
      model: { type: String, default: "" },
      tokensUsed: { type: Number, default: 0 },
      responseTimeMs: { type: Number, default: 0 },
      intent: { type: String, default: "" },
      detectedAction: { type: String, default: "" },
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ waMessageId: 1 }, { sparse: true });
messageSchema.index({ conversation: 1, "sender.type": 1, readByAdmin: 1 });
messageSchema.index({ conversation: 1, isDeleted: 1, createdAt: -1 });

module.exports = mongoose.model("Message", messageSchema);
