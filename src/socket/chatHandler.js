const { Conversation, Message, User, Contact } = require("../models");
const chatService = require("../services/chatService");
const { resolveDisplayName } = require("../services/contactsService");
const logger = require("../config/logger");

module.exports = (io, socket) => {
  // ── chat:list ──
  socket.on("chat:list", async (filters, callback) => {
    try {
      const { status, stage, handlerType, page = 1, limit = 30 } = filters || {};
      const query = {};
      if (status) query.status = status;
      if (stage) query.stage = stage;
      if (handlerType) query.handlerType = handlerType;

      const skip = (page - 1) * limit;

      const [conversations, total] = await Promise.all([
        Conversation.find(query)
          .sort({ lastMessageAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate("user", "name phone company city waId partyName firmName billName gstNo contactName")
          .populate("assignedTo", "name")
          .populate("linkedOrder", "orderNumber status pricing advancePayment delivery")
          .lean(),
        Conversation.countDocuments(query),
      ]);

      const phones = conversations.map((c) => c.user?.phone || c.user?.waId).filter(Boolean);
      const contacts = await Contact.find({ phone: { $in: phones } })
        .sort({ updatedAt: -1 })
        .lean();
      const contactMap = {};
      for (const c of contacts) {
        if (!contactMap[c.phone]) contactMap[c.phone] = [];
        contactMap[c.phone].push(c);
      }

      const enriched = conversations.map((c) => {
        const phone = c.user?.phone || c.user?.waId || "";
        const imported = contactMap[phone] || [];
        const displayName = resolveDisplayName({
          user: c.user,
          contacts: imported,
        }) || phone;
        return { ...c, displayName, importedContacts: imported };
      });

      callback({
        success: true,
        data: enriched,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (err) {
      logger.error("chat:list error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:pipeline — conversations grouped by stage ──
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
                employeeTakenAt: "$employeeTakenAt",
                assignedTo: "$assignedTo",
                needsAttention: "$needsAttention",
                needsAttentionAt: "$needsAttentionAt",
                needsAttentionReason: "$needsAttentionReason",
              },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      const populated = await Conversation.populate(pipeline, {
        path: "conversations.user",
        select: "name phone company partyName firmName contactName waId",
        model: "User",
      });

      // Attach displayName to every conversation so the frontend never has
      // to pick between fields on its own. Pulls imported Contact names in
      // one pass for all phones in the pipeline.
      const allPhones = new Set();
      for (const group of populated) {
        for (const conv of group.conversations || []) {
          const ph = conv.user?.phone || conv.user?.waId;
          if (ph) allPhones.add(ph);
        }
      }
      const contacts = allPhones.size
        ? await Contact.find({ phone: { $in: Array.from(allPhones) } })
            .sort({ updatedAt: -1 })
            .lean()
        : [];
      const contactMap = {};
      for (const c of contacts) {
        if (!contactMap[c.phone]) contactMap[c.phone] = [];
        contactMap[c.phone].push(c);
      }
      for (const group of populated) {
        group.conversations = (group.conversations || []).map((conv) => {
          const phone = conv.user?.phone || conv.user?.waId || "";
          const imported = contactMap[phone] || [];
          return {
            ...conv,
            displayName: resolveDisplayName({ user: conv.user, contacts: imported }) || phone,
          };
        });
      }

      callback({ success: true, data: populated });
    } catch (err) {
      logger.error("chat:pipeline error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:needs_attention_list — conversations where AI went silent ──
  socket.on("chat:needs_attention_list", async (_payload, callback) => {
    try {
      const conversations = await Conversation.find({ needsAttention: true, status: "active" })
        .sort({ needsAttentionAt: -1 })
        .populate("user", "name phone company city waId partyName firmName billName gstNo contactName")
        .populate("assignedTo", "name")
        .lean();

      const phones = conversations.map((c) => c.user?.phone || c.user?.waId).filter(Boolean);
      const contacts = await Contact.find({ phone: { $in: phones } })
        .sort({ updatedAt: -1 })
        .lean();
      const contactMap = {};
      for (const c of contacts) {
        if (!contactMap[c.phone]) contactMap[c.phone] = [];
        contactMap[c.phone].push(c);
      }

      const enriched = conversations.map((c) => {
        const phone = c.user?.phone || c.user?.waId || "";
        const imported = contactMap[phone] || [];
        const displayName = resolveDisplayName({
          user: c.user,
          contacts: imported,
        }) || phone;
        return { ...c, displayName, importedContacts: imported };
      });

      callback({ success: true, data: enriched, total: enriched.length });
    } catch (err) {
      logger.error("chat:needs_attention_list error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:join ──
  socket.on("chat:join", async (conversationId, callback) => {
    try {
      const conversation = await Conversation.findById(conversationId)
        .populate("user", "name phone company city waId partyName firmName billName gstNo contactName")
        .populate("assignedTo", "name")
        .populate("linkedOrder", "orderNumber status pricing advancePayment delivery")
        .lean();

      if (!conversation) {
        return callback({ success: false, error: "Conversation not found" });
      }

      const phone = conversation.user?.phone || conversation.user?.waId || "";
      const contacts = await Contact.find({ phone })
        .sort({ updatedAt: -1 })
        .lean();
      const displayName = resolveDisplayName({
        user: conversation.user,
        contacts,
      }) || phone;

      socket.join(`conv:${conversationId}`);
      callback({ success: true, data: { ...conversation, displayName, importedContacts: contacts } });
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

  // ── chat:take_over — employee takes control of conversation ──
  socket.on("chat:take_over", async (conversationId, callback) => {
    try {
      const conversation = await chatService.takeOverChat(conversationId, socket.employee._id);
      callback({ success: true, data: { conversationId, handlerType: "employee", employeeTakenAt: conversation.employeeTakenAt } });
    } catch (err) {
      logger.error("chat:take_over error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:release_to_ai — employee releases conversation back to AI ──
  socket.on("chat:release_to_ai", async (conversationId, callback) => {
    try {
      await chatService.releaseToAI(conversationId, socket.employee._id);
      callback({ success: true, data: { conversationId, handlerType: "ai" } });
    } catch (err) {
      logger.error("chat:release_to_ai error:", err.message);
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

  // ── chat:update_stage ──
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

      const conversation = await chatService.updateStage(conversationId, stage, socket.employee._id);
      callback({ success: true, data: conversation });
    } catch (err) {
      logger.error("chat:update_stage error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:update_party — save party/firm/GST details ──
  socket.on("chat:update_party", async (payload, callback) => {
    try {
      const { userId, partyName, firmName, billName, gstNo, contactName, city, company } = payload;
      const user = await chatService.updatePartyDetails(userId, {
        partyName, firmName, billName, gstNo, contactName, city, company,
      });
      io.to("employees").emit("chat:party_updated", { userId, user });
      callback({ success: true, data: user });
    } catch (err) {
      logger.error("chat:update_party error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  // ── chat:get_user_info — get user details with display name ──
  socket.on("chat:get_user_info", async (userId, callback) => {
    try {
      const info = await chatService.getUserDisplayInfo(userId);
      if (!info) return callback({ success: false, error: "User not found" });
      callback({ success: true, data: info });
    } catch (err) {
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
          employeeTakenAt: handlerType === "employee" ? new Date() : null,
        },
        { returnDocument: "after" }
      )
        .populate("user", "name phone company partyName firmName")
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
      const searchRegex = { $regex: query, $options: "i" };
      const [users, contacts] = await Promise.all([
        User.find({
          $or: [
            { name: searchRegex },
            { phone: searchRegex },
            { company: searchRegex },
            { partyName: searchRegex },
            { firmName: searchRegex },
            { contactName: searchRegex },
          ],
        })
          .select("name phone company city waId partyName firmName contactName lastMessageAt")
          .limit(20)
          .lean(),
        Contact.find({ contactName: searchRegex })
          .select("phone contactName syncedBy")
          .limit(20)
          .lean(),
      ]);

      const allPhones = new Set(users.map((u) => u.phone));
      for (const c of contacts) {
        if (!allPhones.has(c.phone)) {
          const u = await User.findOne({ $or: [{ phone: c.phone }, { waId: c.phone }] })
            .select("name phone company city waId partyName firmName contactName lastMessageAt")
            .lean();
          if (u) users.push({ ...u, matchedContactName: c.contactName });
        }
      }

      callback({ success: true, data: users });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });
};
