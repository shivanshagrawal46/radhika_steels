const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

const envPath = path.resolve(__dirname, "../../.env");

if (fs.existsSync(envPath)) {
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    console.error("[ENV] dotenv failed to parse .env file:", result.error.message);
  } else {
    console.log(`[ENV] Loaded ${Object.keys(result.parsed || {}).length} vars from ${envPath}`);
  }
} else {
  console.warn(`[ENV] No .env file found at ${envPath} — using process.env only`);
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseInt(process.env.PORT, 10) || 3000,

  MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/radhika_steels",

  JWT_SECRET: process.env.JWT_SECRET || "change-me-in-production",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "7d",

  WA_PHONE_NUMBER_ID: process.env.WA_PHONE_NUMBER_ID,
  WA_ACCESS_TOKEN: process.env.WA_ACCESS_TOKEN,
  WA_VERIFY_TOKEN: process.env.WA_VERIFY_TOKEN || "radhika_steels_verify",
  WA_API_VERSION: process.env.WA_API_VERSION || "v21.0",

  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o",

  FIREBASE_SERVICE_ACCOUNT_PATH: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || "",
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || "",
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY || "",

  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
};

const CRITICAL_KEYS = ["MONGO_URI", "JWT_SECRET", "WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN", "OPENAI_API_KEY"];
const missing = CRITICAL_KEYS.filter((k) => !env[k]);

if (missing.length > 0) {
  console.error(`[ENV] CRITICAL — missing env vars: ${missing.join(", ")}`);
  if (env.NODE_ENV === "production") {
    throw new Error(`Missing required env variables: ${missing.join(", ")}`);
  }
}

console.log(`[ENV] OK — NODE_ENV=${env.NODE_ENV}, PORT=${env.PORT}, OPENAI_KEY=${env.OPENAI_API_KEY ? "SET (" + env.OPENAI_API_KEY.slice(0, 8) + "...)" : "MISSING!"}, WA_TOKEN=${env.WA_ACCESS_TOKEN ? "SET" : "MISSING!"}`);

module.exports = env;
