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

  initFirebase();
  logger.info("[BOOT] Firebase checked");

  const server = http.createServer(app);
  socketIO.init(server);
  logger.info("[BOOT] Socket.IO attached");

  server.listen(env.PORT, () => {
    logger.info(`Radhika Steels API running on port ${env.PORT} [${env.NODE_ENV}]`);
    logger.info("Transport: Socket.IO (ws://) + HTTP webhook (/webhook)");
    logger.info("──── Server ready ────");
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
