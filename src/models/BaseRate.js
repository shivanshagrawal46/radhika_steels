const mongoose = require("mongoose");

const baseRateSchema = new mongoose.Schema(
  {
    wrBaseRate: {
      type: Number,
      required: true,
      min: 0,
    },

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

    carbonExtras: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({
        normal: 0,
        lc: 800,
      }),
    },

    hbPremium: {
      type: Number,
      default: 2500,
    },

    hbGaugePremiums: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({
        "6": 0, "7": 0, "8": 0, "9": 0, "10": 0, "11": 0, "12": 0,
        "13": 1000,
        "14": 1700,
        "5": 800, "4": 800, "3": 800, "2": 800, "1": 800,
        "1/0": 800, "2/0": 800,
        "3/0": 1200, "4/0": 1200, "5/0": 1200, "6/0": 1200,
      }),
    },

    fixedCharge: {
      type: Number,
      default: 345,
    },

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
  { timestamps: true }
);

baseRateSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model("BaseRate", baseRateSchema);
