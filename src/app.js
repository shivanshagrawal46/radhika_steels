const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const path = require("path");

const env = require("./config/env");
const errorHandler = require("./middlewares/errorHandler");
const webhookRoutes = require("./routes/webhook");
const authRoutes = require("./routes/auth");
const clientAuthRoutes = require("./routes/clientAuth");

const app = express();

// ── Security & Performance ──
app.use(helmet());
app.use(cors());
app.use(compression());

// ── Logging ──
if (env.NODE_ENV !== "test") {
  app.use(morgan("short"));
}

// ── Body parsing ──
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Static file serving for uploaded media ──
app.use("/uploads", express.static(path.resolve(__dirname, "../uploads")));

// ── HTTP Routes (only webhook + auth + health) ──
// WhatsApp Cloud API MUST hit an HTTP endpoint — this cannot be Socket.IO
app.use("/webhook", webhookRoutes);
// Auth kept as HTTP so the client can get a JWT before opening the socket
app.use("/api/auth", authRoutes);
app.use("/api/client", clientAuthRoutes);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), transport: "socket.io" });
});

// Everything else goes through Socket.IO — no other HTTP routes
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: "This API uses Socket.IO. Connect via ws:// with a valid JWT.",
  });
});

// ── Global error handler ──
app.use(errorHandler);

module.exports = app;
