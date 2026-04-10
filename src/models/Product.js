const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      required: true,
      enum: ["wr", "hb", "binding", "nails"],
    },
    size: {
      type: String,
      required: true,
      trim: true,
    },
    sizeUnit: {
      type: String,
      enum: ["mm", "gauge", "swg"],
      default: "mm",
    },
    carbonType: {
      type: String,
      enum: ["normal", "lc"],
      default: "normal",
    },
    unit: {
      type: String,
      enum: ["kg", "ton", "piece", "bundle", "coil"],
      default: "ton",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

productSchema.index({ category: 1, size: 1, carbonType: 1 });
productSchema.index({ isActive: 1, category: 1 });
productSchema.index({ name: "text", category: "text" });

module.exports = mongoose.model("Product", productSchema);
