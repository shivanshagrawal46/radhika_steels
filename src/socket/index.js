const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const logger = require("../config/logger");
const { Employee, Client } = require("../models");

// Employee-side handlers
const chatHandler = require("./chatHandler");
const orderHandler = require("./orderHandler");
const productHandler = require("./productHandler");
const priceHandler = require("./priceHandler");
const clientApprovalHandler = require("./clientApprovalHandler");
const contactHandler = require("./contactHandler");

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
    contactHandler(io, socket);

    socket.on("disconnect", (reason) => {
      logger.debug(`Employee disconnected: ${socket.employee.name} — ${reason}`);
    });

    socket.on("error", (err) => {
      logger.error(`Employee socket error [${socket.employee.name}]:`, err.message);
    });
  });

  // ══════════════════════════════════════════════════
  //  NAMESPACE "/client"  —  APP CLIENTS  (JWT)
  // ══════════════════════════════════════════════════
  const clientNsp = io.of("/client");

  clientNsp.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("AUTH_REQUIRED"));

      const decoded = jwt.verify(token, env.JWT_SECRET);
      if (decoded.type !== "client") return next(new Error("AUTH_INVALID"));

      const client = await Client.findById(decoded.id);
      if (!client) return next(new Error("AUTH_INVALID"));
      if (client.isBlocked) return next(new Error("ACCOUNT_BLOCKED"));

      client.lastActiveAt = new Date();
      await client.save();

      socket.clientData = client;
      socket.join(`client:${client._id}`);
      next();
    } catch (err) {
      logger.warn("Client auth failed:", err.message);
      next(new Error("AUTH_INVALID"));
    }
  });

  clientNsp.on("connection", (socket) => {
    logger.info(`Client connected: ${socket.clientData.phone} (${socket.clientData.approvalStatus})`);

    clientHandler(clientNsp, socket);

    // Send current status immediately on connect
    socket.emit("approval:status", {
      approvalStatus: socket.clientData.approvalStatus,
      isProfileComplete: socket.clientData.isProfileComplete,
      rejectionReason: socket.clientData.rejectionReason || "",
    });

    socket.on("disconnect", (reason) => {
      logger.debug(`Client disconnected: ${socket.clientData.phone} — ${reason}`);
    });

    socket.on("error", (err) => {
      logger.error(`Client socket error [${socket.clientData.phone}]:`, err.message);
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
