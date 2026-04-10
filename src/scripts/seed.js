/**
 * Seed script — run once to set up initial data.
 *
 * Usage:  node src/scripts/seed.js
 */
const mongoose = require("mongoose");
const env = require("../config/env");
const logger = require("../config/logger");

const { Employee, BaseRate } = require("../models");

const seed = async () => {
  await mongoose.connect(env.MONGO_URI);
  logger.info("Connected to MongoDB for seeding");

  // 1. Create admin employee (so you can log into the dashboard)
  const existingAdmin = await Employee.findOne({ email: "admin@radhikasteels.com" });
  if (!existingAdmin) {
    await Employee.create({
      name: "Admin",
      email: "admin@radhikasteels.com",
      password: "Admin@1234",
      phone: "",
      role: "admin",
    });
    console.log("✓ Admin employee created");
    console.log("  Email:    admin@radhikasteels.com");
    console.log("  Password: Admin@1234");
  } else {
    console.log("✓ Admin employee already exists");
  }

  // 2. Create initial base rate (WR 5.5mm base)
  const existingRate = await BaseRate.findOne({ isActive: true });
  if (!existingRate) {
    const rate = await BaseRate.create({
      wrBaseRate: 40000,
      isActive: true,
    });
    console.log("✓ Base rate seeded: ₹40,000/ton");
    const sp = rate.sizePremiums instanceof Map ? Object.fromEntries(rate.sizePremiums) : rate.sizePremiums;
    console.log("  Size premiums:", sp);
    console.log("  HB premium:   +₹" + rate.hbPremium);
    console.log("  Fixed charge:  +₹" + rate.fixedCharge);
    console.log("  GST:           " + rate.gstPercent + "%");
  } else {
    console.log("✓ Base rate already exists: ₹" + existingRate.wrBaseRate + "/ton");
  }

  console.log("\n✅ Seed complete. You can now start the server with: npm start");
  await mongoose.disconnect();
};

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
