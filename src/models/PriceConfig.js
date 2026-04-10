const mongoose = require("mongoose");

const priceConfigSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    basePrice: {
      type: Number,
      required: true,
      min: 0,
    },
    unit: {
      type: String,
      enum: ["kg", "ton", "piece", "meter", "feet", "bundle"],
      default: "kg",
    },
    // Additional cost components that get added to base price
    costComponents: {
      gst: { type: Number, default: 18 },         // percentage
      freight: { type: Number, default: 0 },       // flat amount per unit
      loading: { type: Number, default: 0 },       // flat amount per unit
      insurance: { type: Number, default: 0 },     // flat amount per unit
      margin: { type: Number, default: 0 },        // percentage
      customCharges: {
        type: Map,
        of: Number,
        default: {},
      },
    },
    // Pre-computed prices so AI can answer instantly
    computed: {
      priceBeforeTax: { type: Number, default: 0 },
      taxAmount: { type: Number, default: 0 },
      totalPrice: { type: Number, default: 0 },
    },
    effectiveFrom: {
      type: Date,
      default: Date.now,
    },
    effectiveTo: {
      type: Date,
      default: null,
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

priceConfigSchema.index({ product: 1, isActive: 1, effectiveFrom: -1 });

priceConfigSchema.pre("save", function () {
  const { basePrice, costComponents } = this;
  const freight = costComponents.freight || 0;
  const loading = costComponents.loading || 0;
  const insurance = costComponents.insurance || 0;
  const marginPct = costComponents.margin || 0;
  const gstPct = costComponents.gst || 18;

  let customTotal = 0;
  if (costComponents.customCharges) {
    for (const v of costComponents.customCharges.values()) {
      customTotal += v;
    }
  }

  const priceBeforeTax =
    basePrice + freight + loading + insurance + customTotal;
  const afterMargin = priceBeforeTax * (1 + marginPct / 100);
  const taxAmount = afterMargin * (gstPct / 100);
  const totalPrice = afterMargin + taxAmount;

  this.computed = {
    priceBeforeTax: Math.round(priceBeforeTax * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    totalPrice: Math.round(totalPrice * 100) / 100,
  };
});

module.exports = mongoose.model("PriceConfig", priceConfigSchema);
