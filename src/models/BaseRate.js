const mongoose = require("mongoose");

const baseRateSchema = new mongoose.Schema(
  {
    // The single WR base rate that drives all pricing
    wrBaseRate: {
      type: Number,
      required: true,
      min: 0,
    },

    // Size premiums (added to base rate depending on mm)
    sizePremiums: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({
        "5.5": 0,
        "7": 800,
        "8": 800,
        "10": 800,
        "12": 1200,
        "14": 1500,
        "16": 1700,
        "18": 2200,
      }),
    },

    // Carbon-type extras
    carbonExtras: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({
        normal: 0,
        lc: 800,
      }),
    },

    // HB premium over WR base
    hbPremium: {
      type: Number,
      default: 2500,
    },

    // Fixed charge added to every rate
    fixedCharge: {
      type: Number,
      default: 345,
    },

    // GST percentage
    gstPercent: {
      type: Number,
      default: 18,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

baseRateSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model("BaseRate", baseRateSchema);
