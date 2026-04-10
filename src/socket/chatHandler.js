const { Conversation, Message, User } = require("../models");
const chatService = require("../services/chatService");
const logger = require("../config/logger");

module.exports = (io, socket) => {
  // ── chat:list ──
  socket.on("chat:list", async (filters, callback) => {
    try {
      const { status, stage, page = 1, limit = 30 } = filters || {};
      const query = {};
      if (status) query.status = status;
      if (stage) query.stage = stage;

      const skip = (page - 1) * limit;

      const [conversations, total] = await Promise.all([
        Conversation.find(query)
          .sort({ lastMessageAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate("user", "name phone company city waId")
          .populate("assignedTo", "name")
          .populate("linkedOrder", "orderNumber status pricing advancePayment")
          .lean(),
        Conversation.countDocuments(query),
      ]);

      callback({
        success: true,
        data: conversations,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (err) {
      logger.error("chat:list error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:pipeline — get conversations grouped by stage (admin dashboard) ──
  socket.on("chat:pipeline", async (_payload, callback) => {
    try {
      const pipeline = await Conversation.aggregate([
        { $match: { status: "active" } },
        {
          $group: {
            _id: "$stage",
            count: { $sum: 1 },
            conversations: {
              $push: {
                _id: "$_id",
                user: "$user",
                lastMessage: "$lastMessage",
                unreadCount: "$unreadCount",
                lastMessageAt: "$lastMessageAt",
                linkedOrder: "$linkedOrder",
                handlerType: "$handlerType",
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      // Populate user info
      const populated = await Conversation.populate(pipeline, {
        path: "conversations.user",
        select: "name phone company",
        model: "User",
      });

      callback({ success: true, data: populated });
    } catch (err) {
      logger.error("chat:pipeline error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:join ──
  socket.on("chat:join", async (conversationId, callback) => {
    try {
      const conversation = await Conversation.findById(conversationId)
        .populate("user", "name phone company city waId")
        .populate("assignedTo", "name")
        .populate("linkedOrder", "orderNumber status pricing advancePayment")
        .lean();

      if (!conversation) {
        return callback({ success: false, error: "Conversation not found" });
      }

      socket.join(`conv:${conversationId}`);
      callback({ success: true, data: conversation });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:leave ──
  socket.on("chat:leave", (conversationId) => {
    socket.leave(`conv:${conversationId}`);
  });

  // ── chat:messages ──
  socket.on("chat:messages", async (params, callback) => {
    try {
      const { conversationId, before, limit = 50 } = params;
      const query = { conversation: conversationId, isDeleted: false };
      if (before) query.createdAt = { $lt: new Date(before) };

      const messages = await Message.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("replyTo", "content.text sender.type content.mediaType")
        .populate("sender.employeeId", "name")
        .lean();

      messages.reverse();
      callback({ success: true, data: messages, hasMore: messages.length === limit });
    } catch (err) {
      logger.error("chat:messages error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:send ──
  socket.on("chat:send", async (payload, callback) => {
    try {
      const { conversationId, text, replyTo, mediaType, mediaBuffer, fileName, mimeType, caption } = payload;

      const message = await chatService.sendEmployeeMessage({
        conversationId,
        employeeId: socket.employee._id,
        text,
        replyTo: replyTo || null,
        media: mediaBuffer
          ? { buffer: mediaBuffer, fileName, mimeType, mediaType: mediaType || "document", caption }
          : null,
      });

      callback({ success: true, data: message });
    } catch (err) {
      logger.error("chat:send error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:mark_read ──
  socket.on("chat:mark_read", async (conversationId, callback) => {
    try {
      const now = new Date();
      const [msgResult] = await Promise.all([
        Message.updateMany(
          { conversation: conversationId, readByAdmin: false, "sender.type": "user" },
          { $set: { readByAdmin: true, readByAdminAt: now } }
        ),
        Conversation.updateOne(
          { _id: conversationId },
          { $set: { unreadCount: 0 } }
        ),
      ]);

      io.to(`conv:${conversationId}`).emit("chat:unread_reset", { conversationId, readByAdminAt: now });
      io.to("employees").emit("chat:conversation_updated", { conversationId, unreadCount: 0 });

      callback({ success: true, data: { markedRead: msgResult.modifiedCount } });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:typing ──
  socket.on("chat:typing", (conversationId) => {
    socket.to(`conv:${conversationId}`).emit("chat:typing", {
      conversationId,
      employeeName: socket.employee.name,
    });
  });

  // ── chat:update_stage — admin manually changes pipeline stage ──
  socket.on("chat:update_stage", async (payload, callback) => {
    try {
      const { conversationId, stage } = payload;

      const validStages = [
        "talking", "price_inquiry", "negotiation", "order_confirmed",
        "advance_pending", "advance_received", "payment_complete",
        "dispatched", "delivered", "closed",
      ];
      if (!validStages.includes(stage)) {
        return callback({ success: false, error: `Invalid stage: ${stage}` });
      }

      const conversation = await chatService.updateStage(
        conversationId,
        stage,
        socket.employee._id
      );

      callback({ success: true, data: conversation });
    } catch (err) {
      logger.error("chat:update_stage error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:assign ──
  socket.on("chat:assign", async (payload, callback) => {
    try {
      const { conversationId, employeeId, handlerType } = payload;

      const conversation = await Conversation.findByIdAndUpdate(
        conversationId,
        {
          assignedTo: employeeId || null,
          handlerType: handlerType || "employee",
        },
        { returnDocument: "after" }
      )
        .populate("user", "name phone company")
        .populate("assignedTo", "name email")
        .lean();

      if (!conversation) {
        return callback({ success: false, error: "Conversation not found" });
      }

      io.to("employees").emit("chat:conversation_updated", {
        conversationId,
        assignedTo: conversation.assignedTo,
        handlerType: conversation.handlerType,
      });

      callback({ success: true, data: conversation });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:search_users ──
  socket.on("chat:search_users", async (query, callback) => {
    try {
      const users = await User.find({
        $or: [
          { name: { $regex: query, $options: "i" } },
          { phone: { $regex: query, $options: "i" } },
          { company: { $regex: query, $options: "i" } },
        ],
      })
        .select("name phone company city waId lastMessageAt")
        .limit(20)
        .lean();

      callback({ success: true, data: users });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });
};
