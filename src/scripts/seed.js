/**
 * Seed script — run once to set up initial data.
 * Usage:  node src/scripts/seed.js
 */
const mongoose = require("mongoose");
const env = require("../config/env");

const { Employee, BaseRate } = require("../models");

const seed = async () => {
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to MongoDB for seeding");

  // 1. Create admin employee
  const existingAdmin = await Employee.findOne({ email: "admin@radhikasteels.com" });
  if (!existingAdmin) {
    await Employee.create({
      name: "Admin",
      email: "admin@radhikasteels.com",
      password: "Admin@1234",
      phone: "",
      role: "admin",
    });
    console.log("✓ Admin employee created (admin@radhikasteels.com / Admin@1234)");
  } else {
    console.log("✓ Admin employee already exists");
  }

  // 2. Create or patch base rate with complete HB gauge premiums
  const FULL_HB_GAUGE_PREMIUMS = {
    "6": 0, "7": 0, "8": 0, "9": 0, "10": 0, "11": 0, "12": 0,
    "13": 1000, "14": 1700, "15": 1700, "16": 1700,
    "5": 800, "4": 800, "3": 800, "2": 800, "1": 800,
    "1/0": 800, "2/0": 800,
    "3/0": 1200, "4/0": 1200, "5/0": 1200, "6/0": 1200,
  };

  const existingRate = await BaseRate.findOne({ isActive: true });
  if (!existingRate) {
    const rate = await BaseRate.create({
      wrBaseRate: 40000,
      isActive: true,
      hbGaugePremiums: FULL_HB_GAUGE_PREMIUMS,
    });
    console.log("✓ Base rate seeded: ₹40,000/ton");
    const sp = rate.sizePremiums instanceof Map ? Object.fromEntries(rate.sizePremiums) : rate.sizePremiums;
    console.log("  WR size premiums:", sp);
    console.log("  HB base premium: +₹" + rate.hbPremium);
    console.log("  HB gauge premiums:", FULL_HB_GAUGE_PREMIUMS);
    console.log("  Fixed charge: +₹" + rate.fixedCharge);
    console.log("  GST: " + rate.gstPercent + "%");
  } else {
    console.log("✓ Base rate already exists: ₹" + existingRate.wrBaseRate + "/ton");

    // ALWAYS patch — merge missing gauges into existing premiums
    const existing = existingRate.hbGaugePremiums || {};
    let patched = false;
    const merged = { ...FULL_HB_GAUGE_PREMIUMS };
    for (const [k, v] of Object.entries(existing)) {
      merged[k] = v;
    }
    // Check if any gauge was missing
    for (const key of Object.keys(FULL_HB_GAUGE_PREMIUMS)) {
      if (existing[key] === undefined || existing[key] === null) {
        patched = true;
        break;
      }
    }
    if (patched || !existingRate.hbGaugePremiums) {
      await BaseRate.findByIdAndUpdate(existingRate._id, { hbGaugePremiums: merged });
      console.log("  ✓ HB gauge premiums patched (missing gauges added):", merged);
    } else {
      console.log("  ✓ HB gauge premiums OK — all gauges present");
    }
  }

  console.log("\n✅ Seed complete.");
  await mongoose.disconnect();
};

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
