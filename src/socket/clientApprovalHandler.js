const clientService = require("../services/clientService");
const logger = require("../config/logger");

/**
 * Admin-side events for managing client approvals.
 * Registered on the default "/" namespace (employee sockets).
 */
module.exports = (io, socket) => {
  // ────────────────────────────────────────────────
  // client:list — paginated list of clients with filters
  // ────────────────────────────────────────────────
  socket.on("client:list", async (filters, callback) => {
    try {
      const result = await clientService.getClients(filters || {});
      callback({ success: true, ...result });
    } catch (err) {
      logger.error("client:list error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // client:pending — shortcut: pending & profile-complete only
  // ────────────────────────────────────────────────
  socket.on("client:pending", async (filters, callback) => {
    try {
      const result = await clientService.getClients({
        approvalStatus: "pending",
        ...(filters || {}),
      });
      callback({ success: true, ...result });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // client:get — single client details
  // ────────────────────────────────────────────────
  socket.on("client:get", async (clientId, callback) => {
    try {
      const client = await clientService.getClientById(clientId);
      callback({ success: true, data: client });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // client:counts — dashboard badge counts
  // ────────────────────────────────────────────────
  socket.on("client:counts", async (_payload, callback) => {
    try {
      const counts = await clientService.getApprovalCounts();
      callback({ success: true, data: counts });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // client:approve — admin approves a client
  // ────────────────────────────────────────────────
  socket.on("client:approve", async (payload, callback) => {
    try {
      if (!["admin", "manager"].includes(socket.employee.role)) {
        return callback({ success: false, error: "Insufficient permissions" });
      }

      const { clientId } = payload;
      const client = await clientService.approveClient(clientId, socket.employee._id);

      // Broadcast to all employees so dashboards update in real-time
      io.to("employees").emit("client:updated", {
        client: client.toObject(),
        action: "approved",
        approvedBy: socket.employee.name,
      });

      callback({ success: true, data: client });
    } catch (err) {
      logger.error("client:approve error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // client:reject — admin rejects a client
  // ────────────────────────────────────────────────
  socket.on("client:reject", async (payload, callback) => {
    try {
      if (!["admin", "manager"].includes(socket.employee.role)) {
        return callback({ success: false, error: "Insufficient permissions" });
      }

      const { clientId, reason } = payload;
      const client = await clientService.rejectClient(
        clientId,
        socket.employee._id,
        reason || ""
      );

      io.to("employees").emit("client:updated", {
        client: client.toObject(),
        action: "rejected",
        rejectedBy: socket.employee.name,
      });

      callback({ success: true, data: client });
    } catch (err) {
      logger.error("client:reject error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // client:block / client:unblock — block/unblock a client
  // ────────────────────────────────────────────────
  socket.on("client:block", async (clientId, callback) => {
    try {
      if (socket.employee.role !== "admin") {
        return callback({ success: false, error: "Admin only" });
      }

      const { Client } = require("../models");
      const client = await Client.findByIdAndUpdate(
        clientId,
        { isBlocked: true },
        { returnDocument: "after" }
      );

      if (!client) return callback({ success: false, error: "Client not found" });

      io.to("employees").emit("client:updated", {
        client: client.toObject(),
        action: "blocked",
      });

      // Disconnect the client's socket if they're connected
      const clientNsp = io.of("/client");
      clientNsp.to(`client:${client.firebaseUid}`).emit("account:blocked", {
        message: "Your account has been blocked. Contact support.",
      });

      callback({ success: true, data: client });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on("client:unblock", async (clientId, callback) => {
    try {
      if (socket.employee.role !== "admin") {
        return callback({ success: false, error: "Admin only" });
      }

      const { Client } = require("../models");
      const client = await Client.findByIdAndUpdate(
        clientId,
        { isBlocked: false },
        { returnDocument: "after" }
      );

      if (!client) return callback({ success: false, error: "Client not found" });

      io.to("employees").emit("client:updated", {
        client: client.toObject(),
        action: "unblocked",
      });

      callback({ success: true, data: client });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });
};
