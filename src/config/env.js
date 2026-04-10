const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseInt(process.env.PORT, 10) || 3000,

  // MongoDB
  MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/radhika_steels",

  // JWT
  JWT_SECRET: process.env.JWT_SECRET || "change-me-in-production",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "7d",

  // WhatsApp Cloud API
  WA_PHONE_NUMBER_ID: process.env.WA_PHONE_NUMBER_ID,
  WA_ACCESS_TOKEN: process.env.WA_ACCESS_TOKEN,
  WA_VERIFY_TOKEN: process.env.WA_VERIFY_TOKEN || "radhika_steels_verify",
  WA_API_VERSION: process.env.WA_API_VERSION || "v21.0",

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o",

  // Firebase (client auth)
  FIREBASE_SERVICE_ACCOUNT_PATH: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || "",
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || "",
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY || "",

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
};

const requiredInProduction = [
  "MONGO_URI",
  "JWT_SECRET",
  "WA_PHONE_NUMBER_ID",
  "WA_ACCESS_TOKEN",
  "OPENAI_API_KEY",
];

if (env.NODE_ENV === "production") {
  for (const key of requiredInProduction) {
    if (!env[key]) {
      throw new Error(`Missing required env variable: ${key}`);
    }
  }
}

module.exports = env;
