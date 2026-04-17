const contactsService = require("../services/contactsService");
const logger = require("../config/logger");

/**
 * Admin-side socket handlers for unified CONTACTS
 * (phone-number keyed merge of Users + Clients + imported Contacts).
 *
 * Events:
 *   contacts:list              — paginated unified list with filters
 *   contacts:get               — full detail for a single phone
 *   contacts:orders            — all orders under a phone
 *   contacts:search            — typeahead search
 *   contacts:counts            — quick badges (total, withApp, pending, withOrders)
 */
module.exports = (io, socket) => {
  // ── contacts:list ──
  socket.on("contacts:list", async (filters, callback) => {
    try {
      const result = await contactsService.listContacts(filters || {});
      callback({ success: true, ...result });
    } catch (err) {
      logger.error("contacts:list error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── contacts:get ──
  socket.on("contacts:get", async (payload, callback) => {
    try {
      const phone = typeof payload === "string" ? payload : payload?.phone;
      const data = await contactsService.getContactByPhone(phone);
      callback({ success: true, data });
    } catch (err) {
      logger.error("contacts:get error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── contacts:orders ──
  socket.on("contacts:orders", async (payload, callback) => {
    try {
      const { phone, page, limit, status } = payload || {};
      const result = await contactsService.getOrdersByPhone(phone, { page, limit, status });
      callback({ success: true, ...result });
    } catch (err) {
      logger.error("contacts:orders error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── contacts:search ──
  socket.on("contacts:search", async (payload, callback) => {
    try {
      const query = typeof payload === "string" ? payload : payload?.query;
      const limit = typeof payload === "object" ? payload?.limit : undefined;
      const data = await contactsService.searchContacts(query, { limit });
      callback({ success: true, data });
    } catch (err) {
      logger.error("contacts:search error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── contacts:counts (quick badges) ──
  socket.on("contacts:counts", async (_payload, callback) => {
    try {
      const { User, Client, Order } = require("../models");
      const [
        totalUsers,
        withApp,
        pendingApproval,
        approvedClients,
        blockedClients,
        usersWithOrders,
      ] = await Promise.all([
        User.countDocuments({}),
        Client.countDocuments({}),
        Client.countDocuments({ approvalStatus: "pending", isProfileComplete: true }),
        Client.countDocuments({ approvalStatus: "approved" }),
        Client.countDocuments({ isBlocked: true }),
        Order.distinct("user").then((arr) => arr.length),
      ]);

      callback({
        success: true,
        data: {
          total: totalUsers + Math.max(0, withApp - usersWithOrders),
          whatsapp: totalUsers,
          withApp,
          pendingApproval,
          approvedClients,
          blockedClients,
          withOrders: usersWithOrders,
        },
      });
    } catch (err) {
      logger.error("contacts:counts error:", err.message);
      callback({ success: false, error: err.message });
    }
  });
};
