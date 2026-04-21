const { Contact, User } = require("../models");
const contactsService = require("../services/contactsService");
const logger = require("../config/logger");
const { canonicalizePhone } = require("../utils/phoneUtils");

// Helpers ──────────────────────────────────────────────────────
// ALWAYS canonicalise to the CC-prefixed digit form we receive from Meta.
// Saving "9876543210" here means chat / orders / rate-broadcast lookups
// (which key on the 12-digit "919876543210" stored on User.phone) will
// never find the contact — so admin sees a blank name on those rows.
const normalizePhone = canonicalizePhone;

// Broadcast a fresh unified contact row for one phone so every open admin
// tab can update chat list / header / order rows live.
const broadcastContactUpdated = (io, phone) => {
  if (!phone) return;
  contactsService.emitContactUpdated(phone).catch((err) =>
    logger.warn(`[CONTACTS] broadcast failed for ${phone}: ${err.message}`)
  );
  // Minimal event too — useful when the frontend only needs the new name
  // and doesn't want to re-fetch the whole unified contact row.
  io.to("employees").emit("contact:name_changed", { phone });
};

module.exports = (io, socket) => {
  /**
   * contact:sync — bulk import contacts.
   *
   * Payload:
   *   {
   *     contacts: [{ phone: "917470...", name: "Vijay Hyderabad" }, ...],
   *     source: "phone" | "google" | "admin" | "other"  (optional, default "phone")
   *   }
   *
   * Accepts thousands of rows; writes in batches of 500.
   * Upserts by (phone, syncedBy) — each employee keeps their own copy, but
   * the display-name resolver always picks the most-recently-updated row
   * across the whole team, so the freshest save wins everywhere.
   */
  socket.on("contact:sync", async (payload, callback) => {
    try {
      const { contacts, source = "phone" } = payload || {};
      if (!Array.isArray(contacts) || contacts.length === 0) {
        return callback({ success: false, error: "No contacts provided" });
      }
      const allowedSources = ["phone", "google", "admin", "other"];
      const safeSource = allowedSources.includes(source) ? source : "other";

      const normalised = contacts
        .filter((c) => c && c.phone && c.name)
        .map((c) => ({
          phone: normalizePhone(c.phone),
          contactName: String(c.name).trim(),
          source: safeSource,
        }))
        .filter((c) => c.phone && c.contactName);

      const ops = normalised.map((c) => ({
        updateOne: {
          filter: { phone: c.phone, syncedBy: socket.employee._id },
          update: {
            $set: {
              contactName: c.contactName,
              syncedBy: socket.employee._id,
              source: c.source,
            },
          },
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

      logger.info(
        `[CONTACTS] Synced ${normalised.length} contacts for ${socket.employee.name} — new=${upserted}, updated=${modified}, source=${safeSource}`
      );

      // Broadcast ONE bulk notification (frontend should re-fetch the chat
      // list / open conversations). We intentionally don't flood with a
      // per-phone event for massive imports.
      io.to("employees").emit("contact:bulk_updated", {
        count: normalised.length,
        new: upserted,
        updated: modified,
        source: safeSource,
        by: socket.employee._id,
      });

      callback({
        success: true,
        data: { total: normalised.length, new: upserted, updated: modified, source: safeSource },
      });
    } catch (err) {
      logger.error("contact:sync error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:search — search synced contacts across the whole team.
   */
  socket.on("contact:search", async (query, callback) => {
    try {
      const searchRegex = { $regex: String(query || ""), $options: "i" };
      const contacts = await Contact.find({
        $or: [{ contactName: searchRegex }, { phone: searchRegex }],
      })
        .sort({ updatedAt: -1 })
        .limit(30)
        .lean();

      callback({ success: true, data: contacts });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:get_by_phone — all saved names for a phone (latest first).
   */
  socket.on("contact:get_by_phone", async (phone, callback) => {
    try {
      const normalised = normalizePhone(phone);
      const contacts = await Contact.find({ phone: normalised })
        .sort({ updatedAt: -1 })
        .lean();
      callback({ success: true, data: contacts });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:save — add OR update a single contact name.
   *
   * Payload: { phone, contactName, source? }
   *
   * Preferred over the legacy `contact:update`. When an admin edits the
   * name from the chat header this is the event that should fire.
   * Broadcasts `contact:updated` (+ `contact:name_changed`) so every open
   * admin tab refreshes the chat row / order header live.
   */
  socket.on("contact:save", async (payload, callback) => {
    try {
      const { phone, contactName, source = "admin" } = payload || {};
      const normalised = normalizePhone(phone);
      const name = String(contactName || "").trim();
      if (!normalised || !name) {
        return callback({ success: false, error: "phone and contactName are required" });
      }
      const allowedSources = ["phone", "google", "admin", "other"];
      const safeSource = allowedSources.includes(source) ? source : "admin";

      const contact = await Contact.findOneAndUpdate(
        { phone: normalised, syncedBy: socket.employee._id },
        { $set: { contactName: name, source: safeSource } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();

      broadcastContactUpdated(io, normalised);
      callback({ success: true, data: contact });
    } catch (err) {
      logger.error("contact:save error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:update — legacy alias for contact:save. Kept for backwards
   * compatibility with any already-shipped admin client.
   */
  socket.on("contact:update", async (payload, callback) => {
    try {
      const { phone, contactName } = payload || {};
      const normalised = normalizePhone(phone);
      const name = String(contactName || "").trim();
      if (!normalised || !name) {
        return callback({ success: false, error: "phone and contactName are required" });
      }

      const contact = await Contact.findOneAndUpdate(
        { phone: normalised, syncedBy: socket.employee._id },
        { $set: { contactName: name, source: "admin" } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();

      broadcastContactUpdated(io, normalised);
      callback({ success: true, data: contact });
    } catch (err) {
      logger.error("contact:update error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:delete — remove THIS employee's saved name for a phone.
   *
   * Other employees' saved names (if any) are preserved. After delete the
   * resolver falls back to the next-most-recent name or the WA profile.
   */
  socket.on("contact:delete", async (payload, callback) => {
    try {
      const { phone } = payload || {};
      const normalised = normalizePhone(phone);
      if (!normalised) return callback({ success: false, error: "phone is required" });

      const result = await Contact.deleteOne({
        phone: normalised,
        syncedBy: socket.employee._id,
      });

      broadcastContactUpdated(io, normalised);
      callback({ success: true, data: { deleted: result.deletedCount || 0 } });
    } catch (err) {
      logger.error("contact:delete error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:backfill_phone_format — ONE-TIME MIGRATION.
   *
   * Rewrites every Contact row whose `phone` is not in our canonical
   * 12-digit "91XXXXXXXXXX" form to that form. Exists because the old
   * `normalizePhone` stripped non-digits without adding the country code,
   * so contacts synced as "9876543210" never matched User.phone values
   * ("919876543210") and their names didn't surface in chat / orders /
   * rate-broadcast lookups.
   *
   * Safe to run repeatedly — already-canonical rows are left alone. If
   * rewriting a row would clash with an existing (canonical-phone,
   * syncedBy) row, the duplicate is deleted and the canonical winner
   * kept, because the unique index would otherwise reject the update.
   *
   * Payload: {}
   * Returns: { scanned, updated, deletedDuplicates }
   */
  socket.on("contact:backfill_phone_format", async (_payload, callback) => {
    try {
      // Security: require some admin capability here if your auth model
      // distinguishes roles. For now any connected employee can trigger.
      const cursor = Contact.find({}).cursor();
      let scanned = 0;
      let updated = 0;
      let deletedDuplicates = 0;

      // Process sequentially — it's a one-shot migration, correctness
      // beats speed. For larger datasets, convert to bulkWrite batches.
      // eslint-disable-next-line no-restricted-syntax
      for await (const row of cursor) {
        scanned++;
        const canonical = canonicalizePhone(row.phone);
        if (!canonical || canonical === row.phone) continue;

        // If another row for this employee already owns the canonical
        // phone, delete the non-canonical duplicate to respect the
        // unique (phone, syncedBy) index.
        const clash = await Contact.findOne({
          phone: canonical,
          syncedBy: row.syncedBy,
          _id: { $ne: row._id },
        }).lean();

        if (clash) {
          await Contact.deleteOne({ _id: row._id });
          deletedDuplicates++;
          continue;
        }

        await Contact.updateOne({ _id: row._id }, { $set: { phone: canonical } });
        updated++;
      }

      logger.info(
        `[CONTACTS] backfill by ${socket.employee?.name || "?"} — scanned=${scanned}, updated=${updated}, deletedDuplicates=${deletedDuplicates}`
      );

      // Every admin tab should refresh its chat list / order list so the
      // newly-matching names appear live.
      io.to("employees").emit("contact:bulk_updated", {
        count: updated,
        new: 0,
        updated,
        source: "migration",
        by: socket.employee?._id || null,
      });

      callback({
        success: true,
        data: { scanned, updated, deletedDuplicates },
      });
    } catch (err) {
      logger.error("contact:backfill_phone_format error:", err.message);
      callback({ success: false, error: err.message });
    }
  });

  /**
   * contact:list — paginated list of saved contacts for the current
   * employee. Useful for a "My Contacts" screen in the admin app.
   */
  socket.on("contact:list", async (payload, callback) => {
    try {
      const { page = 1, limit = 50, search = "", source } = payload || {};
      const skip = (page - 1) * limit;

      const query = { syncedBy: socket.employee._id };
      if (source) query.source = source;
      if (search && search.trim()) {
        const rx = new RegExp(
          search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i"
        );
        query.$or = [{ contactName: rx }, { phone: rx }];
      }

      const [contacts, total] = await Promise.all([
        Contact.find(query)
          .sort({ contactName: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Contact.countDocuments(query),
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
