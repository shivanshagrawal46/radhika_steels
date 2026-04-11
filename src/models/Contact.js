const mongoose = require("mongoose");

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
  },
  {
    timestamps: true,
  }
);

contactSchema.index({ phone: 1, syncedBy: 1 }, { unique: true });
contactSchema.index({ syncedBy: 1 });
contactSchema.index({ phone: 1 });

module.exports = mongoose.model("Contact", contactSchema);
