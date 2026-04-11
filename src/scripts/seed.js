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

  // 2. Create initial base rate with HB gauge premiums
  const existingRate = await BaseRate.findOne({ isActive: true });
  if (!existingRate) {
    const rate = await BaseRate.create({
      wrBaseRate: 40000,
      isActive: true,
      hbGaugePremiums: {
        "6": 0, "7": 0, "8": 0, "9": 0, "10": 0, "11": 0, "12": 0,
        "13": 1000,
        "14": 1700,
        "5": 800, "4": 800, "3": 800, "2": 800, "1": 800,
        "1/0": 800, "2/0": 800,
        "3/0": 1200, "4/0": 1200, "5/0": 1200, "6/0": 1200,
      },
    });
    console.log("✓ Base rate seeded: ₹40,000/ton");
    const sp = rate.sizePremiums instanceof Map ? Object.fromEntries(rate.sizePremiums) : rate.sizePremiums;
    console.log("  WR size premiums:", sp);
    console.log("  HB base premium: +₹" + rate.hbPremium);
    const gp = rate.hbGaugePremiums instanceof Map ? Object.fromEntries(rate.hbGaugePremiums) : rate.hbGaugePremiums;
    console.log("  HB gauge premiums:", gp);
    console.log("  Fixed charge: +₹" + rate.fixedCharge);
    console.log("  GST: " + rate.gstPercent + "%");
  } else {
    console.log("✓ Base rate already exists: ₹" + existingRate.wrBaseRate + "/ton");
    if (!existingRate.hbGaugePremiums || Object.keys(existingRate.hbGaugePremiums).length === 0) {
      await BaseRate.findByIdAndUpdate(existingRate._id, {
        hbGaugePremiums: {
          "6": 0, "7": 0, "8": 0, "9": 0, "10": 0, "11": 0, "12": 0,
          "13": 1000, "14": 1700,
          "5": 800, "4": 800, "3": 800, "2": 800, "1": 800,
          "1/0": 800, "2/0": 800,
          "3/0": 1200, "4/0": 1200, "5/0": 1200, "6/0": 1200,
        },
      });
      console.log("  ✓ HB gauge premiums added to existing rate");
    }
  }

  console.log("\n✅ Seed complete.");
  await mongoose.disconnect();
};

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
