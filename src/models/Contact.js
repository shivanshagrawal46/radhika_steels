const mongoose = require("mongoose");

/**
 * Contact — admin-maintained name for a phone number.
 *
 * A phone can have multiple rows (one per employee who synced it from their
 * own phonebook). When we need to display ONE canonical name for a phone, we
 * pick the most recently updated row — so whoever edits last wins, and that
 * name shows up for EVERY employee in chat / orders / pipeline.
 *
 * Sources:
 *   - "phone"   → synced from a mobile device address book
 *   - "google"  → imported from Google Contacts (CSV / vCard / People API)
 *   - "admin"   → typed or edited manually inside the admin dashboard
 *   - "other"   → fallback (legacy rows pre-source are treated as "other")
 */
const contactSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    contactName: {
      type: String,
      required: true,
      trim: true,
    },
    syncedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    source: {
      type: String,
      enum: ["phone", "google", "admin", "other"],
      default: "other",
    },
  },
  {
    timestamps: true,
  }
);

// One row per (phone, employee). Different employees can each keep their own
// name for the same phone — when reading we pick the latest one.
contactSchema.index({ phone: 1, syncedBy: 1 }, { unique: true });
contactSchema.index({ syncedBy: 1 });

// Used when resolving the display name — we always want the most recent
// admin-edited / synced row for a phone.
contactSchema.index({ phone: 1, updatedAt: -1 });

module.exports = mongoose.model("Contact", contactSchema);
