const mongoose = require("mongoose");
const { User, Client, Order, Conversation, Contact, Message } = require("../models");
const AppError = require("../utils/AppError");
const logger = require("../config/logger");

const getIO = () => require("../socket").getIO();

/**
 * Unified Contacts module — one row per PHONE NUMBER.
 *
 * Merges three sources by phone:
 *   - User       (WhatsApp sender, has conversation + orders)
 *   - Client     (registered in the app via OTP)
 *   - Contact    (imported phone book)
 *
 * Every order in the system belongs to a User (required). When a Client
 * registers via OTP, we ensure a User row also exists with the same phone,
 * so all orders roll up to a single contact regardless of source.
 */

// ──────────────────────────────────────────────────────────────
// Display name resolution (same priority as chatService)
// ──────────────────────────────────────────────────────────────
function resolveDisplayName({ client, user, contact }) {
  if (client?.firmName) return client.firmName;
  if (client?.name) return client.name;
  if (user?.partyName) return user.partyName;
  if (user?.firmName) return user.firmName;
  if (contact?.contactName) return contact.contactName;
  if (user?.contactName) return user.contactName;
  if (user?.name) return user.name;
  return user?.phone || client?.phone || contact?.phone || "";
}

// ──────────────────────────────────────────────────────────────
// Normalize a contact row from aggregation output
// ──────────────────────────────────────────────────────────────
function buildContactRow(doc) {
  const user = doc.user || null;
  const client = doc.client || null;
  const contact = doc.contact || null;

  const phone = user?.phone || client?.phone || contact?.phone || "";
  const displayName = resolveDisplayName({ client, user, contact });

  return {
    phone,
    displayName,
    hasWhatsApp: !!user,
    hasApp: !!client,
    whatsappUserId: user?._id || null,
    clientId: client?._id || null,

    // Profile (best available)
    name: client?.name || user?.name || "",
    firmName: client?.firmName || user?.firmName || "",
    partyName: user?.partyName || "",
    billName: user?.billName || "",
    gstNumber: client?.gstNumber || user?.gstNo || "",
    email: client?.email || "",
    city: user?.city || "",
    company: user?.company || "",
    contactName: contact?.contactName || user?.contactName || "",

    // App state
    approvalStatus: client?.approvalStatus || null,
    isProfileComplete: client?.isProfileComplete || false,
    rateUpdatesConsent: client?.rateUpdatesConsent || false,
    isBlocked: (user?.isBlocked || client?.isBlocked) || false,

    // Order rollup
    totalOrders: doc.totalOrders || 0,
    activeOrders: doc.activeOrders || 0,
    totalSpent: doc.totalSpent || 0,
    lastOrderAt: doc.lastOrderAt || null,
    lastOrderStatus: doc.lastOrderStatus || null,

    // Conversation rollup
    conversationId: doc.conversationId || null,
    lastMessageAt: doc.lastMessageAt || user?.lastMessageAt || client?.lastActiveAt || null,
    lastMessagePreview: doc.lastMessagePreview || "",
    unreadCount: doc.unreadCount || 0,
    stage: doc.stage || null,
    handlerType: doc.handlerType || null,
    needsAttention: doc.needsAttention || false,

    createdAt: user?.createdAt || client?.createdAt || null,
  };
}

// ──────────────────────────────────────────────────────────────
// Aggregation pipeline stages reused for both Users and Clients
// ──────────────────────────────────────────────────────────────
const commonLookups = [
  // Lookup Client by phone
  {
    $lookup: {
      from: "clients",
      let: { ph: "$phone" },
      pipeline: [
        { $match: { $expr: { $eq: ["$phone", "$$ph"] } } },
        { $limit: 1 },
      ],
      as: "client",
    },
  },
  { $unwind: { path: "$client", preserveNullAndEmptyArrays: true } },

  // Lookup imported Contact by phone (first match only)
  {
    $lookup: {
      from: "contacts",
      let: { ph: "$phone" },
      pipeline: [
        { $match: { $expr: { $eq: ["$phone", "$$ph"] } } },
        { $limit: 1 },
      ],
      as: "contact",
    },
  },
  { $unwind: { path: "$contact", preserveNullAndEmptyArrays: true } },

  // Order rollup (count + totals + last)
  {
    $lookup: {
      from: "orders",
      let: { uid: "$user._id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$user", "$$uid"] } } },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalSpent: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["cancelled", "inquiry"]] },
                  0,
                  "$pricing.grandTotal",
                ],
              },
            },
            activeOrders: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["delivered", "cancelled"]] },
                  0,
                  1,
                ],
              },
            },
            lastOrderAt: { $max: "$createdAt" },
          },
        },
      ],
      as: "orderStats",
    },
  },
  { $unwind: { path: "$orderStats", preserveNullAndEmptyArrays: true } },

  // Last order status (separate lookup because we need one doc)
  {
    $lookup: {
      from: "orders",
      let: { uid: "$user._id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$user", "$$uid"] } } },
        { $sort: { createdAt: -1 } },
        { $limit: 1 },
        { $project: { status: 1 } },
      ],
      as: "lastOrder",
    },
  },
  { $unwind: { path: "$lastOrder", preserveNullAndEmptyArrays: true } },

  // Conversation rollup
  {
    $lookup: {
      from: "conversations",
      let: { uid: "$user._id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$user", "$$uid"] } } },
        { $sort: { lastMessageAt: -1 } },
        { $limit: 1 },
        {
          $project: {
            lastMessage: 1,
            lastMessageAt: 1,
            unreadCount: 1,
            stage: 1,
            handlerType: 1,
            needsAttention: 1,
          },
        },
      ],
      as: "conversation",
    },
  },
  { $unwind: { path: "$conversation", preserveNullAndEmptyArrays: true } },

  // Shape final doc
  {
    $project: {
      _id: 0,
      phone: 1,
      user: 1,
      client: 1,
      contact: 1,
      totalOrders: { $ifNull: ["$orderStats.totalOrders", 0] },
      totalSpent: { $ifNull: ["$orderStats.totalSpent", 0] },
      activeOrders: { $ifNull: ["$orderStats.activeOrders", 0] },
      lastOrderAt: "$orderStats.lastOrderAt",
      lastOrderStatus: "$lastOrder.status",
      conversationId: "$conversation._id",
      lastMessageAt: "$conversation.lastMessageAt",
      lastMessagePreview: "$conversation.lastMessage.text",
      unreadCount: { $ifNull: ["$conversation.unreadCount", 0] },
      stage: "$conversation.stage",
      handlerType: "$conversation.handlerType",
      needsAttention: { $ifNull: ["$conversation.needsAttention", false] },
      sortKey: {
        $ifNull: ["$conversation.lastMessageAt", { $ifNull: ["$user.createdAt", "$client.createdAt"] }],
      },
    },
  },
];

// ──────────────────────────────────────────────────────────────
// listContacts — paginated, filtered, unified list
// ──────────────────────────────────────────────────────────────
/**
 * @param {object} filters
 *   search: string — matches name/firm/phone/gst/city (case-insensitive)
 *   hasApp: boolean — only clients who have the app
 *   approvalStatus: "pending" | "approved" | "rejected"
 *   hasOrders: boolean — only contacts with at least one order
 *   page, limit
 */
const listContacts = async (filters = {}) => {
  const { search = "", hasApp, approvalStatus, hasOrders, page = 1, limit = 25 } = filters;
  const pg = Math.max(1, Number(page) || 1);
  const lim = Math.max(1, Math.min(100, Number(limit) || 25));
  const skip = (pg - 1) * lim;

  // Users branch (start from User, attach phone directly)
  const usersBranch = [
    { $project: { _id: 1, waId: 1, phone: 1, name: 1, partyName: 1, firmName: 1, billName: 1, gstNo: 1, contactName: 1, city: 1, company: 1, isBlocked: 1, createdAt: 1, lastMessageAt: 1 } },
    { $addFields: { user: "$$ROOT", phone: { $ifNull: ["$phone", "$waId"] } } },
    { $project: { phone: 1, user: 1 } },
    ...commonLookups,
  ];

  // Clients branch — only include clients whose phone has NO user doc (app-only)
  const clientsOnlyBranch = [
    {
      $lookup: {
        from: "users",
        let: { ph: "$phone" },
        pipeline: [
          { $match: { $expr: { $or: [{ $eq: ["$phone", "$$ph"] }, { $eq: ["$waId", "$$ph"] }] } } },
          { $limit: 1 },
        ],
        as: "existingUser",
      },
    },
    { $match: { existingUser: { $size: 0 } } },
    { $addFields: { user: null } },
    { $project: { phone: 1, user: 1 } },
    ...commonLookups,
  ];

  // Base: unified aggregation (User + app-only Clients)
  const unionPipeline = [
    ...usersBranch,
    { $unionWith: { coll: "clients", pipeline: clientsOnlyBranch } },
  ];

  // Build filter stage
  const match = {};
  if (hasApp === true) match["client"] = { $ne: null };
  if (hasApp === false) match["client"] = null;
  if (approvalStatus) match["client.approvalStatus"] = approvalStatus;
  if (hasOrders === true) match.totalOrders = { $gt: 0 };
  if (hasOrders === false) match.totalOrders = { $eq: 0 };

  if (search && search.trim()) {
    const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    match.$or = [
      { phone: rx },
      { "user.name": rx },
      { "user.partyName": rx },
      { "user.firmName": rx },
      { "user.billName": rx },
      { "user.gstNo": rx },
      { "user.contactName": rx },
      { "user.city": rx },
      { "user.company": rx },
      { "client.name": rx },
      { "client.firmName": rx },
      { "client.gstNumber": rx },
      { "client.email": rx },
      { "contact.contactName": rx },
    ];
  }

  const finalPipeline = [
    ...unionPipeline,
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    { $sort: { sortKey: -1 } },
    {
      $facet: {
        rows: [{ $skip: skip }, { $limit: lim }],
        total: [{ $count: "n" }],
      },
    },
  ];

  const [result] = await User.aggregate(finalPipeline).allowDiskUse(true);
  const rows = (result?.rows || []).map(buildContactRow);
  const total = result?.total?.[0]?.n || 0;

  return {
    data: rows,
    pagination: { page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) },
  };
};

// ──────────────────────────────────────────────────────────────
// getContactByPhone — full detail (user + client + contacts + stats)
// ──────────────────────────────────────────────────────────────
const getContactByPhone = async (phone) => {
  if (!phone) throw new AppError("phone is required", 400);
  const normalized = String(phone).replace(/[^0-9]/g, "");

  const [user, client, contacts] = await Promise.all([
    User.findOne({ $or: [{ phone: normalized }, { waId: normalized }] }).lean(),
    Client.findOne({ phone: normalized }).populate("approvedBy", "name email").lean(),
    Contact.find({ phone: normalized }).lean(),
  ]);

  if (!user && !client) throw new AppError("Contact not found", 404);

  const contact = contacts[0] || null;
  const displayName = resolveDisplayName({ client, user, contact });

  let orderStats = { totalOrders: 0, activeOrders: 0, totalSpent: 0, lastOrderAt: null };
  let conversation = null;

  if (user) {
    const statsAgg = await Order.aggregate([
      { $match: { user: user._id } },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalSpent: { $sum: { $cond: [{ $in: ["$status", ["cancelled", "inquiry"]] }, 0, "$pricing.grandTotal"] } },
          activeOrders: { $sum: { $cond: [{ $in: ["$status", ["delivered", "cancelled"]] }, 0, 1] } },
          lastOrderAt: { $max: "$createdAt" },
        },
      },
    ]);
    if (statsAgg[0]) orderStats = statsAgg[0];

    conversation = await Conversation.findOne({ user: user._id })
      .sort({ lastMessageAt: -1 })
      .populate("assignedTo", "name")
      .populate("linkedOrder", "orderNumber status pricing")
      .lean();
  }

  return {
    phone: normalized,
    displayName,
    hasWhatsApp: !!user,
    hasApp: !!client,
    user,
    client,
    contacts,
    conversation,
    stats: orderStats,
  };
};

// ──────────────────────────────────────────────────────────────
// getOrdersByPhone — all orders for a phone (from either channel)
// ──────────────────────────────────────────────────────────────
const getOrdersByPhone = async (phone, { page = 1, limit = 20, status } = {}) => {
  if (!phone) throw new AppError("phone is required", 400);
  const normalized = String(phone).replace(/[^0-9]/g, "");

  const user = await User.findOne({ $or: [{ phone: normalized }, { waId: normalized }] }).lean();
  if (!user) {
    return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } };
  }

  const pg = Math.max(1, Number(page) || 1);
  const lim = Math.max(1, Math.min(100, Number(limit) || 20));
  const skip = (pg - 1) * lim;

  const query = { user: user._id };
  if (status) query.status = status;

  const [orders, total] = await Promise.all([
    Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .populate("assignedTo", "name")
      .populate("conversation", "stage handlerType")
      .lean(),
    Order.countDocuments(query),
  ]);

  return {
    data: orders,
    pagination: { page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) },
  };
};

// ──────────────────────────────────────────────────────────────
// searchContacts — quick typeahead across both Users & Clients
// ──────────────────────────────────────────────────────────────
const searchContacts = async (query, { limit = 20 } = {}) => {
  if (!query || !query.trim()) return [];
  const rx = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const lim = Math.max(1, Math.min(50, Number(limit) || 20));

  const [users, clients, contacts] = await Promise.all([
    User.find({
      $or: [
        { name: rx }, { phone: rx }, { waId: rx }, { partyName: rx },
        { firmName: rx }, { billName: rx }, { gstNo: rx }, { contactName: rx }, { company: rx },
      ],
    }).limit(lim).lean(),
    Client.find({
      $or: [{ name: rx }, { firmName: rx }, { phone: rx }, { gstNumber: rx }, { email: rx }],
    }).limit(lim).lean(),
    Contact.find({ $or: [{ contactName: rx }, { phone: rx }] }).limit(lim).lean(),
  ]);

  const byPhone = new Map();
  for (const u of users) {
    const p = u.phone || u.waId;
    if (!p) continue;
    if (!byPhone.has(p)) byPhone.set(p, { phone: p, user: u, client: null, contact: null });
    else byPhone.get(p).user = u;
  }
  for (const c of clients) {
    if (!c.phone) continue;
    if (!byPhone.has(c.phone)) byPhone.set(c.phone, { phone: c.phone, user: null, client: c, contact: null });
    else byPhone.get(c.phone).client = c;
  }
  for (const ct of contacts) {
    if (!ct.phone) continue;
    if (!byPhone.has(ct.phone)) byPhone.set(ct.phone, { phone: ct.phone, user: null, client: null, contact: ct });
    else if (!byPhone.get(ct.phone).contact) byPhone.get(ct.phone).contact = ct;
  }

  return Array.from(byPhone.values()).slice(0, lim).map((row) => ({
    phone: row.phone,
    displayName: resolveDisplayName(row),
    hasWhatsApp: !!row.user,
    hasApp: !!row.client,
    whatsappUserId: row.user?._id || null,
    clientId: row.client?._id || null,
    firmName: row.client?.firmName || row.user?.firmName || "",
    gstNumber: row.client?.gstNumber || row.user?.gstNo || "",
    approvalStatus: row.client?.approvalStatus || null,
  }));
};

// ──────────────────────────────────────────────────────────────
// emitContactUpdated — broadcast a single contact change in real-time
// ──────────────────────────────────────────────────────────────
const emitContactUpdated = async (phone) => {
  try {
    if (!phone) return;
    const io = getIO();
    const contact = await getContactByPhone(phone).catch(() => null);
    if (contact) {
      io.to("employees").emit("contact:updated", { phone, contact });
    }
  } catch (err) {
    logger.warn(`[CONTACTS] emit update failed: ${err.message}`);
  }
};

module.exports = {
  listContacts,
  getContactByPhone,
  getOrdersByPhone,
  searchContacts,
  emitContactUpdated,
  resolveDisplayName,
};
