const mongoose = require("mongoose");

/**
 * RateSubscriber — admin-managed list of phone numbers that receive
 * rate statements via the approved "rate_statement_3p" / "rate_statement_5p"
 * WhatsApp Utility templates.
 *
 * Per-subscriber data (designed to match the approved Utility template):
 *   - customerId         — permanent account-style ID shown in the template
 *                          (e.g. "RS-CUST-0112"). Never changes once assigned.
 *   - statementCounter   — monotonically increasing per-user send count.
 *                          {{2}} in the template; {{6}} shows counter-1.
 *   - subscribedProducts — ordered list of product keys from the broadcast
 *                          catalog (see config/broadcastCatalog.js).
 *                          MUST be exactly 3 or exactly 5 (matches the two
 *                          approved template variants).
 *
 * Broadcast metrics (bookkeeping — safe to wipe, not source of truth):
 *   - lastSentAt, lastSentStatus, lastSentError, totalSent, totalFailed.
 *
 * Soft-delete via `isActive=false` preserves audit history; hard delete is
 * also supported by the handler.
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

    // Template-critical fields (see templateDoc above).
    customerId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    statementCounter: {
      type: Number,
      default: 0,
      min: 0,
    },
    subscribedProducts: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => Array.isArray(arr) && (arr.length === 0 || arr.length === 3 || arr.length === 5),
        message: "subscribedProducts must be exactly 3 or exactly 5 items (or empty while the admin hasn't picked yet)",
      },
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
    lastStatementNumber: { type: Number, default: 0 },
    totalSent: { type: Number, default: 0 },
    totalFailed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

rateSubscriberSchema.index({ isActive: 1, createdAt: -1 });
rateSubscriberSchema.index({ customerId: 1 }, { unique: true, partialFilterExpression: { customerId: { $type: "string", $ne: "" } } });

module.exports = mongoose.model("RateSubscriber", rateSubscriberSchema);
