const http = require("http");

const env = require("./src/config/env");
const logger = require("./src/config/logger");
const connectDB = require("./src/config/db");
const { initFirebase } = require("./src/config/firebase");
const app = require("./src/app");
const socketIO = require("./src/socket");

const startServer = async () => {
  logger.info("──── Radhika Steels Server Starting ────");

  await connectDB();
  logger.info("[BOOT] MongoDB connected");

  // Auto-patch: ensure active BaseRate has all HB gauge premiums
  try {
    const { BaseRate } = require("./src/models");
    const REQUIRED_GAUGES = {
      "6": 0, "7": 0, "8": 0, "9": 0, "10": 0, "11": 0, "12": 0,
      "13": 1000, "14": 1700, "15": 1700, "16": 1700,
      "5": 800, "4": 800, "3": 800, "2": 800, "1": 800,
      "1/0": 800, "2/0": 800,
      "3/0": 1200, "4/0": 1200, "5/0": 1200, "6/0": 1200,
    };
    const activeRate = await BaseRate.findOne({ isActive: true });
    if (activeRate) {
      const existing = activeRate.hbGaugePremiums || {};
      let needsPatch = false;
      for (const key of Object.keys(REQUIRED_GAUGES)) {
        if (existing[key] === undefined || existing[key] === null) {
          needsPatch = true;
          break;
        }
      }
      if (needsPatch) {
        const merged = { ...REQUIRED_GAUGES, ...existing };
        await BaseRate.findByIdAndUpdate(activeRate._id, { hbGaugePremiums: merged });
        require("./src/services/pricingService").clearRateCache();
        logger.info("[BOOT] Patched missing HB gauge premiums on active BaseRate");
      }
    }
  } catch (err) {
    logger.warn(`[BOOT] BaseRate patch skipped: ${err.message}`);
  }

  initFirebase();
  logger.info("[BOOT] Firebase checked");

  const server = http.createServer(app);
  socketIO.init(server);
  logger.info("[BOOT] Socket.IO attached");

  server.listen(env.PORT, () => {
    logger.info(`Radhika Steels API running on port ${env.PORT} [${env.NODE_ENV}]`);
    logger.info("Transport: Socket.IO (ws://) + HTTP webhook (/webhook)");
    logger.info("──── Server ready ────");

    // 12-hour auto-reset: release employee-locked conversations back to AI
    const { Conversation } = require("./src/models");
    const RESET_CHECK_INTERVAL = 15 * 60 * 1000; // every 15 mins
    const EMPLOYEE_LOCK_TTL = 12 * 60 * 60 * 1000;

    setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - EMPLOYEE_LOCK_TTL);
        const result = await Conversation.updateMany(
          { handlerType: "employee", employeeTakenAt: { $lt: cutoff } },
          { $set: { handlerType: "ai", employeeTakenAt: null } }
        );
        if (result.modifiedCount > 0) {
          logger.info(`[SCHEDULER] Auto-reset ${result.modifiedCount} conversations from employee → AI`);
          const io = socketIO.getIO();
          io.to("employees").emit("chat:bulk_reset", { count: result.modifiedCount });
        }
      } catch (err) {
        logger.error(`[SCHEDULER] Auto-reset failed: ${err.message}`);
      }
    }, RESET_CHECK_INTERVAL);
    logger.info("[BOOT] 12hr auto-reset scheduler started (every 15min)");
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    const io = socketIO.getIO();
    io.close(() => logger.info("Socket.IO closed"));
    server.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (err) => {
    logger.error("Unhandled rejection:", err);
  });

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception:", err);
    process.exit(1);
  });
};

startServer().catch((err) => {
  console.error("[FATAL] Server failed to start:", err);
  process.exit(1);
});
