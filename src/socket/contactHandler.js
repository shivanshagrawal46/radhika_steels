const { Contact, User } = require("../models");
const logger = require("../config/logger");

module.exports = (io, socket) => {
  /**
   * contact:sync — bulk import contacts from employee's phone.
   * Payload: { contacts: [{ phone: "917470691408", name: "Vijay Ji Hyderabad Steel" }, ...] }
   * Uses bulkWrite for speed. Upserts by phone+syncedBy.
   */
  socket.on("contact:sync", async (payload, callback) => {
    try {
      const { contacts } = payload;
      if (!Array.isArray(contacts) || contacts.length === 0) {
        return callback({ success: false, error: "No contacts provided" });
      }

      const normalised = contacts
        .filter((c) => c.phone && c.name)
        .map((c) => ({
          phone: c.phone.replace(/[^0-9]/g, ""),
          contactName: c.name.trim(),
        }));

      const ops = normalised.map((c) => ({
        updateOne: {
          filter: { phone: c.phone, syncedBy: socket.employee._id },
          update: { $set: { contactName: c.contactName, syncedBy: socket.employee._id } },
          upsert: true,
        },
      }));

      const BATCH_SIZE = 500;
      let upserted = 0;
      let modified = 0;
      for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        const batch = ops.slice(i, i + BATCH_SIZE);
        const result = await Contact.bulkWrite(batch, { ordered: false });
        upserted += result.upsertedCount || 0;
        modified += result.modifiedCount || 0;
      }

      logger.info(`[CONTACTS] Synced ${normalised.length} contacts for ${socket.employee.name} — new=${upserted}, updated=${modified}`);

      callback({
        success: true,
        data: { total: normalised.length, new: upserted, updated: modified },
      });
    } catch (err) {
      logger.error("contact:sync error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:search — search synced contacts
   */
  socket.on("contact:search", async (query, callback) => {
    try {
      const searchRegex = { $regex: query, $options: "i" };
      const contacts = await Contact.find({
        $or: [{ contactName: searchRegex }, { phone: searchRegex }],
      })
        .limit(30)
        .lean();

      callback({ success: true, data: contacts });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:get_by_phone — get contact name for a phone number
   */
  socket.on("contact:get_by_phone", async (phone, callback) => {
    try {
      const normalised = phone.replace(/[^0-9]/g, "");
      const contacts = await Contact.find({ phone: normalised }).lean();
      callback({ success: true, data: contacts });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:update — manually update a contact name
   */
  socket.on("contact:update", async (payload, callback) => {
    try {
      const { phone, contactName } = payload;
      const normalised = phone.replace(/[^0-9]/g, "");
      const contact = await Contact.findOneAndUpdate(
        { phone: normalised, syncedBy: socket.employee._id },
        { $set: { contactName } },
        { upsert: true, returnDocument: "after" }
      );
      callback({ success: true, data: contact });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:list — list all contacts for this employee
   */
  socket.on("contact:list", async (payload, callback) => {
    try {
      const { page = 1, limit = 50 } = payload || {};
      const skip = (page - 1) * limit;
      const [contacts, total] = await Promise.all([
        Contact.find({ syncedBy: socket.employee._id })
          .sort({ contactName: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Contact.countDocuments({ syncedBy: socket.employee._id }),
      ]);
      callback({
        success: true,
        data: contacts,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });
};
