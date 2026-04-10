const http = require("http");
const env = require("./src/config/env");
const logger = require("./src/config/logger");
const connectDB = require("./src/config/db");
const { initFirebase } = require("./src/config/firebase");
const app = require("./src/app");
const socketIO = require("./src/socket");

const startServer = async () => {
  await connectDB();

  initFirebase();

  const server = http.createServer(app);

  socketIO.init(server);

  server.listen(env.PORT, () => {
    logger.info(`Radhika Steels API running on port ${env.PORT} [${env.NODE_ENV}]`);
    logger.info("Transport: Socket.IO (ws://) + HTTP webhook (/webhook)");
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

startServer();
