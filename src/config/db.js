const mongoose = require("mongoose");
const logger = require("./logger");
const env = require("./env");

const connectDB = async () => {
  try {
    const isProd = env.NODE_ENV === "production";

    const conn = await mongoose.connect(env.MONGO_URI, {
      maxPoolSize: isProd ? 25 : 10,
      minPoolSize: isProd ? 5 : 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      heartbeatFrequencyMS: 10000,
      autoIndex: !isProd,
    });

    logger.info(`MongoDB connected: ${conn.connection.host} [pool: ${isProd ? 25 : 10}]`);

    mongoose.connection.on("error", (err) => {
      logger.error("MongoDB connection error:", err);
    });

    mongoose.connection.on("disconnected", () => {
      logger.warn("MongoDB disconnected. Attempting reconnect...");
    });

    return conn;
  } catch (err) {
    logger.error("MongoDB connection failed:", err);
    process.exit(1);
  }
};

module.exports = connectDB;
