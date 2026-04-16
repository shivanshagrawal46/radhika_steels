const clientService = require("../services/clientService");
const pricingService = require("../services/pricingService");
const notificationService = require("../services/notificationService");
const logger = require("../config/logger");

/**
 * Events handled on the /client namespace.
 * socket.client is set by the Firebase auth middleware in socket/index.js.
 */
module.exports = (clientNsp, socket) => {
  // ────────────────────────────────────────────────
  // profile:get — get own profile + approval status
  // ────────────────────────────────────────────────
  socket.on("profile:get", async (_payload, callback) => {
    try {
      const client = await clientService.getClientById(socket.client._id);
      callback({ success: true, data: client });
    } catch (err) {
      logger.error("profile:get error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // profile:submit — submit / update profile for approval
  // ────────────────────────────────────────────────
  socket.on("profile:submit", async (profileData, callback) => {
    try {
      const { name, firmName, email, gstNumber, rateUpdatesConsent } = profileData || {};

      if (!name || !firmName || !email || !gstNumber) {
        return callback({
          success: false,
          error: "All fields are required: name, firmName, email, gstNumber",
        });
      }

      if (!rateUpdatesConsent) {
        return callback({
          success: false,
          error: "You must agree to receive daily steel rate updates on WhatsApp",
        });
      }

      const client = await clientService.submitProfile(socket.client._id, {
        name,
        firmName,
        email,
        gstNumber,
        rateUpdatesConsent,
      });

      // Update the socket's cached client reference
      socket.client = client;

      callback({
        success: true,
        data: {
          approvalStatus: client.approvalStatus,
          isProfileComplete: client.isProfileComplete,
          message:
            client.approvalStatus === "pending"
              ? "Profile submitted! Waiting for admin approval."
              : `Status: ${client.approvalStatus}`,
        },
      });
    } catch (err) {
      logger.error("profile:submit error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // price:get_table — get full price table (approved clients only)
  // ────────────────────────────────────────────────
  socket.on("price:get_table", async (_payload, callback) => {
    try {
      if (socket.client.approvalStatus !== "approved") {
        return callback({
          success: false,
          error: "ACCESS_DENIED",
          message: "Your account must be approved by admin to view prices.",
          approvalStatus: socket.client.approvalStatus,
        });
      }

      const table = await pricingService.getFullPriceTable();
      callback({ success: true, data: table });
    } catch (err) {
      logger.error("client price:get_table error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // price:calculate — calculate a specific price (approved only)
  // ────────────────────────────────────────────────
  socket.on("price:calculate", async (payload, callback) => {
    try {
      if (socket.client.approvalStatus !== "approved") {
        return callback({
          success: false,
          error: "ACCESS_DENIED",
          message: "Your account must be approved by admin to view prices.",
        });
      }

      const { category, size, carbonType, gauge } = payload;
      const result = await pricingService.calculatePrice(category, {
        size,
        carbonType,
        gauge,
      });
      callback({ success: true, data: result });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // approval:check — quick check of current approval status
  // ────────────────────────────────────────────────
  socket.on("approval:check", async (_payload, callback) => {
    try {
      const fresh = await clientService.getClientById(socket.client._id);
      // Refresh cached client on socket
      socket.client = fresh;

      callback({
        success: true,
        data: {
          approvalStatus: fresh.approvalStatus,
          isProfileComplete: fresh.isProfileComplete,
          rejectionReason: fresh.rejectionReason || "",
        },
      });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // fcm:register — register FCM token for push notifications
  // ────────────────────────────────────────────────
  socket.on("fcm:register", async (payload, callback) => {
    try {
      const { token, device } = payload;
      if (!token) return callback({ success: false, error: "Token is required" });

      await notificationService.registerFCMToken(socket.client._id, token, device || "");
      callback({ success: true });
    } catch (err) {
      logger.error("fcm:register error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────
  // fcm:unregister — remove FCM token (logout)
  // ────────────────────────────────────────────────
  socket.on("fcm:unregister", async (payload, callback) => {
    try {
      const { token } = payload;
      if (!token) return callback({ success: false, error: "Token is required" });

      await notificationService.unregisterFCMToken(socket.client._id, token);
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });
};
