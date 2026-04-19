const mongoose = require("mongoose");

/**
 * RateSubscriber — admin-managed list of phone numbers that receive
 * daily/updated rate broadcasts via WhatsApp template.
 *
 * Kept intentionally separate from User/Client/Contact:
 *   - Admin explicitly curates this list (add/remove).
 *   - A phone can exist here without ever messaging the business.
 *   - Deactivation is soft (isActive=false) so audit history is preserved,
 *     but hard delete is also supported by the handler.
 */
const rateSubscriberSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      trim: true,
      default: "",
    },
    firmName: {
      type: String,
      trim: true,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    addedByName: { type: String, default: "" },

    // Broadcast metrics
    lastSentAt: { type: Date, default: null },
    lastSentStatus: {
      type: String,
      enum: ["sent", "failed", null],
      default: null,
    },
    lastSentError: { type: String, default: "" },
    totalSent: { type: Number, default: 0 },
    totalFailed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

rateSubscriberSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model("RateSubscriber", rateSubscriberSchema);
