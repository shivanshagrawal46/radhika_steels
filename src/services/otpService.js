const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");
const Otp = require("../models/Otp");
const { Client } = require("../models");
const whatsappService = require("./whatsappService");

const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 60_000;
const DAILY_LIMIT = 10;

const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

const generateCode = () => crypto.randomInt(100000, 999999).toString();

const generateClientToken = (clientId) => {
  return jwt.sign({ id: clientId, type: "client" }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
};

/**
 * Send OTP to a phone number via WhatsApp.
 * - 1 OTP per minute (cooldown)
 * - 10 OTPs per day per phone (daily cap)
 * - OTP code is SHA-256 hashed in DB
 */
const sendOtp = async (phone) => {
  if (!phone || phone.length < 10) {
    throw new AppError("Valid phone number is required", 400);
  }

  const normalized = phone.replace(/[^0-9]/g, "");

  // Cooldown: 1 min between sends
  const latest = await Otp.findOne({ phone: normalized }).sort({ createdAt: -1 });
  if (latest && Date.now() - latest.createdAt.getTime() < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (Date.now() - latest.createdAt.getTime())) / 1000);
    throw new AppError(`Please wait ${waitSec}s before requesting another OTP`, 429);
  }

  // Daily cap: max 10 OTPs per phone per 24h
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dailyCount = await Otp.countDocuments({ phone: normalized, createdAt: { $gte: dayAgo } });
  if (dailyCount >= DAILY_LIMIT) {
    throw new AppError("Too many OTP requests today. Try again tomorrow.", 429);
  }

  // Delete any active OTP for this phone (only one active at a time)
  await Otp.deleteMany({ phone: normalized });

  const code = generateCode();
  await Otp.create({ phone: normalized, code: hashCode(code) });

  const message = `Your Radhika Steel login OTP is *${code}*\nValid for 5 minutes.\nDo not share this with anyone.`;

  try {
    await whatsappService.sendTextMessage(normalized, message);
    logger.info(`[OTP] Sent to ${normalized}`);
  } catch (err) {
    await Otp.deleteMany({ phone: normalized });
    logger.error(`[OTP] WhatsApp send failed for ${normalized}: ${err.message}`);
    throw new AppError("Failed to send OTP. Please try again.", 500);
  }

  return { sent: true };
};

/**
 * Verify OTP and return JWT + client data.
 * - Max 5 wrong attempts then OTP is invalidated
 * - Code is compared via hash (never stored in plain text)
 */
const verifyOtp = async (phone, code) => {
  if (!phone || !code) {
    throw new AppError("Phone and OTP code are required", 400);
  }

  const normalized = phone.replace(/[^0-9]/g, "");
  const otpDoc = await Otp.findOne({ phone: normalized });

  if (!otpDoc) {
    throw new AppError("OTP expired or not found. Request a new one.", 400);
  }

  if (otpDoc.attempts >= MAX_ATTEMPTS) {
    await Otp.deleteMany({ phone: normalized });
    throw new AppError("Too many wrong attempts. Request a new OTP.", 429);
  }

  if (otpDoc.code !== hashCode(code.trim())) {
    otpDoc.attempts += 1;
    await otpDoc.save();
    const remaining = MAX_ATTEMPTS - otpDoc.attempts;
    throw new AppError(`Wrong OTP. ${remaining} attempt${remaining !== 1 ? "s" : ""} left.`, 401);
  }

  await Otp.deleteMany({ phone: normalized });

  const client = await Client.findOneAndUpdate(
    { phone: normalized },
    { $set: { lastActiveAt: new Date() }, $setOnInsert: { phone: normalized } },
    { upsert: true, returnDocument: "after" }
  );

  const token = generateClientToken(client._id);

  logger.info(`[OTP] Verified for ${normalized}, client=${client._id}`);

  return {
    token,
    client: {
      id: client._id,
      phone: client.phone,
      name: client.name,
      firmName: client.firmName,
      approvalStatus: client.approvalStatus,
      isProfileComplete: client.isProfileComplete,
    },
  };
};

module.exports = { sendOtp, verifyOtp, generateClientToken };
