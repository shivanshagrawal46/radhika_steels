const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    waId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      trim: true,
      default: "",
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    company: {
      type: String,
      trim: true,
      default: "",
    },
    city: {
      type: String,
      trim: true,
      default: "",
    },
    gstNumber: {
      type: String,
      trim: true,
      default: "",
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
    tags: [{ type: String, trim: true }],
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

userSchema.index({ phone: 1 });
userSchema.index({ lastMessageAt: -1 });
userSchema.index({ createdAt: -1 });

userSchema.virtual("conversations", {
  ref: "Conversation",
  localField: "_id",
  foreignField: "user",
});

module.exports = mongoose.model("User", userSchema);
