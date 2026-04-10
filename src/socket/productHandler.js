const { Product } = require("../models");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");

module.exports = (io, socket) => {
  // ── product:list ──
  socket.on("product:list", async (filters, callback) => {
    try {
      const { category, search, page = 1, limit = 50 } = filters || {};
      const query = { isActive: true };
      if (category) query.category = category;
      if (search) query.$text = { $search: search };

      const skip = (page - 1) * limit;
      const [products, total] = await Promise.all([
        Product.find(query).sort({ category: 1, size: 1 }).skip(skip).limit(limit).lean(),
        Product.countDocuments(query),
      ]);

      callback({ success: true, data: products, pagination: { page, limit, total } });
    } catch (err) {
      logger.error("product:list error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── product:create ──
  socket.on("product:create", async (data, callback) => {
    try {
      if (!["admin", "manager"].includes(socket.employee.role)) {
        return callback({ success: false, error: "Insufficient permissions" });
      }
      const product = await Product.create(data);
      io.to("employees").emit("product:created", product);
      callback({ success: true, data: product });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── product:update ──
  socket.on("product:update", async (payload, callback) => {
    try {
      if (!["admin", "manager"].includes(socket.employee.role)) {
        return callback({ success: false, error: "Insufficient permissions" });
      }
      const { productId, ...data } = payload;
      const product = await Product.findByIdAndUpdate(productId, data, {
        new: true,
        runValidators: true,
      });
      if (!product) return callback({ success: false, error: "Product not found" });

      io.to("employees").emit("product:updated", product);
      callback({ success: true, data: product });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── product:delete (soft) ──
  socket.on("product:delete", async (productId, callback) => {
    try {
      if (socket.employee.role !== "admin") {
        return callback({ success: false, error: "Admin only" });
      }
      await Product.findByIdAndUpdate(productId, { isActive: false });
      io.to("employees").emit("product:deleted", { productId });
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });
};
