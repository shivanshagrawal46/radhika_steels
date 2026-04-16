const express = require("express");
const rateLimit = require("express-rate-limit");
const otpService = require("../services/otpService");

const router = express.Router();

// IP-based: max 5 OTP sends per 15 min per IP
const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, error: "Too many OTP requests. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// IP-based: max 15 verify attempts per 15 min per IP
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { success: false, error: "Too many attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /api/client/send-otp
 * Body: { phone: "919876543210" }
 */
router.post("/send-otp", sendLimiter, async (req, res, next) => {
  try {
    const { phone } = req.body;
    const result = await otpService.sendOtp(phone);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/client/verify-otp
 * Body: { phone: "919876543210", code: "123456" }
 * Returns: { success, token, client }
 */
router.post("/verify-otp", verifyLimiter, async (req, res, next) => {
  try {
    const { phone, code } = req.body;
    const result = await otpService.verifyOtp(phone, code);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
