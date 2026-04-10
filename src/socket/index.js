const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const logger = require("../config/logger");
const { Employee } = require("../models");
const { verifyIdToken } = require("../config/firebase");
const clientService = require("../services/clientService");

// Employee-side handlers
const chatHandler = require("./chatHandler");
const orderHandler = require("./orderHandler");
const productHandler = require("./productHandler");
const priceHandler = require("./priceHandler");
const clientApprovalHandler = require("./clientApprovalHandler");

// Client-side handler
const clientHandler = require("./clientHandler");

let io = null;

/**
 * Initialise Socket.IO on the existing HTTP server.
 * Two namespaces:
 *   "/"        → employees (JWT auth)
 *   "/client"  → app clients (Firebase token auth)
 */
const init = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingInterval: 25000,
    pingTimeout: 60000,
    maxHttpBufferSize: 10 * 1024 * 1024,
  });

  // ══════════════════════════════════════════════════
  //  NAMESPACE "/"  —  EMPLOYEES  (JWT)
  // ══════════════════════════════════════════════════
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("AUTH_REQUIRED"));

      const decoded = jwt.verify(token, env.JWT_SECRET);
      const employee = await Employee.findById(decoded.id);
      if (!employee || !employee.isActive) return next(new Error("AUTH_INVALID"));

      socket.employee = employee;
      socket.join("employees");
      next();
    } catch {
      next(new Error("AUTH_INVALID"));
    }
  });

  io.on("connection", (socket) => {
    logger.info(`Employee connected: ${socket.employee.name} (${socket.employee.role})`);

    chatHandler(io, socket);
    orderHandler(io, socket);
    productHandler(io, socket);
    priceHandler(io, socket);
    clientApprovalHandler(io, socket);

    socket.on("disconnect", (reason) => {
      logger.debug(`Employee disconnected: ${socket.employee.name} — ${reason}`);
    });

    socket.on("error", (err) => {
      logger.error(`Employee socket error [${socket.employee.name}]:`, err.message);
    });
  });

  // ══════════════════════════════════════════════════
  //  NAMESPACE "/client"  —  APP CLIENTS  (Firebase)
  // ══════════════════════════════════════════════════
  const clientNsp = io.of("/client");

  clientNsp.use(async (socket, next) => {
    try {
      const firebaseToken = socket.handshake.auth?.token;
      if (!firebaseToken) return next(new Error("AUTH_REQUIRED"));

      // Verify the Firebase ID token from the client app
      const decoded = await verifyIdToken(firebaseToken);

      // Firebase phone auth gives uid + phone_number
      const uid = decoded.uid;
      const phone = decoded.phone_number || "";

      if (!phone) return next(new Error("PHONE_REQUIRED"));

      // Find or create the client in our DB
      const client = await clientService.findOrCreateByFirebase(uid, phone);

      if (client.isBlocked) return next(new Error("ACCOUNT_BLOCKED"));

      socket.client = client;
      // Personal room so we can push approval updates to this exact client
      socket.join(`client:${uid}`);
      next();
    } catch (err) {
      logger.warn("Client auth failed:", err.message);
      next(new Error("AUTH_INVALID"));
    }
  });

  clientNsp.on("connection", (socket) => {
    logger.info(`Client connected: ${socket.client.phone} (${socket.client.approvalStatus})`);

    clientHandler(clientNsp, socket);

    // Send current status immediately on connect
    socket.emit("approval:status", {
      approvalStatus: socket.client.approvalStatus,
      isProfileComplete: socket.client.isProfileComplete,
      rejectionReason: socket.client.rejectionReason || "",
    });

    socket.on("disconnect", (reason) => {
      logger.debug(`Client disconnected: ${socket.client.phone} — ${reason}`);
    });

    socket.on("error", (err) => {
      logger.error(`Client socket error [${socket.client.phone}]:`, err.message);
    });
  });

  logger.info("Socket.IO initialised (namespaces: /, /client)");
  return io;
};

/**
 * Get the live io instance (used by services to emit events).
 */
const getIO = () => {
  if (!io) throw new Error("Socket.IO not initialised yet");
  return io;
};

module.exports = { init, getIO };
