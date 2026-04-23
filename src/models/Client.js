const mongoose = require("mongoose");

const clientSchema = new mongoose.Schema(
  {
    // ── Auth ──
    // Note: uniqueness is enforced via a partial index declared below,
    // so multiple clients without a firebaseUid don't collide on `null`.
    firebaseUid: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    // ── Profile (filled after OTP registration) ──
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
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    gstNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },

    // ── WhatsApp rate updates (2x daily) — mandatory during registration ──
    rateUpdatesConsent: {
      type: Boolean,
      default: false,
    },
    rateUpdatesConsentAt: {
      type: Date,
      default: null,
    },

    // ── Profile completion flag ──
    isProfileComplete: {
      type: Boolean,
      default: false,
    },

    // ── Approval workflow ──
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: "",
    },

    // ── Push notifications (FCM) ──
    fcmTokens: [{
      token: { type: String, required: true },
      device: { type: String, default: "" },
      updatedAt: { type: Date, default: Date.now },
    }],

    // ── Access control ──
    isBlocked: {
      type: Boolean,
      default: false,
    },

    lastActiveAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

clientSchema.index({ approvalStatus: 1, createdAt: -1 });
clientSchema.index({ approvalStatus: 1, isProfileComplete: 1 });
clientSchema.index({ approvalStatus: 1, isBlocked: 1 });
clientSchema.index({ firmName: "text", name: "text", gstNumber: "text" });

// Partial unique index on firebaseUid: only enforces uniqueness for docs
// where firebaseUid is a real non-empty string. Docs without the field
// (or with null/empty) are simply not indexed — so they never collide.
clientSchema.index(
  { firebaseUid: 1 },
  {
    unique: true,
    partialFilterExpression: {
      firebaseUid: { $type: "string", $gt: "" },
    },
  }
);

module.exports = mongoose.model("Client", clientSchema);
