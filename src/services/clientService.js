const { Client } = require("../models");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");

// Lazy getter to avoid circular dependency at require-time
const getIO = () => require("../socket").getIO();

/**
 * Find or create a Client record by phone number.
 * Called by OTP verification after successful WhatsApp OTP.
 */
const findOrCreateByPhone = async (phone) => {
  const client = await Client.findOneAndUpdate(
    { phone },
    {
      $set: { lastActiveAt: new Date() },
      $setOnInsert: { phone },
    },
    { upsert: true, returnDocument: "after" }
  );

  return client;
};

/**
 * Client submits their profile details after OTP registration.
 */
const submitProfile = async (clientId, profileData) => {
  const { name, firmName, email, gstNumber, rateUpdatesConsent } = profileData;

  const client = await Client.findById(clientId);
  if (!client) throw new AppError("Client not found", 404);

  if (client.approvalStatus === "approved") {
    throw new AppError("Profile already approved — contact support to update details", 400);
  }

  client.name = name || client.name;
  client.firmName = firmName || client.firmName;
  client.email = email || client.email;
  client.gstNumber = gstNumber || client.gstNumber;
  client.rateUpdatesConsent = !!rateUpdatesConsent;
  if (rateUpdatesConsent && !client.rateUpdatesConsentAt) {
    client.rateUpdatesConsentAt = new Date();
  }
  client.isProfileComplete = !!(name && firmName && email && gstNumber && rateUpdatesConsent);

  // Reset to pending if they were rejected and resubmit
  if (client.approvalStatus === "rejected") {
    client.approvalStatus = "pending";
    client.rejectionReason = "";
    client.rejectedAt = null;
  }

  await client.save();

  // Notify all admins in real-time
  const io = getIO();
  io.to("employees").emit("client:new_request", {
    client: client.toObject(),
  });

  // Also emit unified contact update
  try {
    require("./contactsService").emitContactUpdated(client.phone);
  } catch (_) { /* noop */ }

  logger.info(`Client ${client.phone} submitted profile for approval`);
  return client;
};

/**
 * Admin approves a client — they can now see prices.
 */
const approveClient = async (clientId, employeeId) => {
  const client = await Client.findById(clientId);
  if (!client) throw new AppError("Client not found", 404);

  if (client.approvalStatus === "approved") {
    throw new AppError("Client is already approved", 400);
  }

  client.approvalStatus = "approved";
  client.approvedBy = employeeId;
  client.approvedAt = new Date();
  client.rejectionReason = "";
  client.rejectedAt = null;
  await client.save();

  // Notify the client app in real-time via the /client namespace
  const io = getIO();
  const clientNsp = io.of("/client");
  clientNsp.to(`client:${client._id}`).emit("approval:status", {
    approvalStatus: "approved",
    message: "Your account has been approved! You can now view prices.",
  });

  try {
    require("./contactsService").emitContactUpdated(client.phone);
  } catch (_) { /* noop */ }

  logger.info(`Client ${client.phone} approved by employee ${employeeId}`);
  return client;
};

/**
 * Admin rejects a client.
 */
const rejectClient = async (clientId, employeeId, reason = "") => {
  const client = await Client.findById(clientId);
  if (!client) throw new AppError("Client not found", 404);

  client.approvalStatus = "rejected";
  client.rejectedAt = new Date();
  client.rejectionReason = reason;
  client.approvedBy = null;
  client.approvedAt = null;
  await client.save();

  // Notify the client app in real-time
  const io = getIO();
  const clientNsp = io.of("/client");
  clientNsp.to(`client:${client._id}`).emit("approval:status", {
    approvalStatus: "rejected",
    reason,
    message: "Your account request was not approved. Please update your details and try again.",
  });

  try {
    require("./contactsService").emitContactUpdated(client.phone);
  } catch (_) { /* noop */ }

  logger.info(`Client ${client.phone} rejected by employee ${employeeId}: ${reason}`);
  return client;
};

/**
 * Get paginated client list (for admin dashboard).
 */
const getClients = async (filters = {}) => {
  const { approvalStatus, search, page = 1, limit = 25 } = filters;
  const query = {};

  if (approvalStatus) query.approvalStatus = approvalStatus;
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { firmName: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
      { gstNumber: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (page - 1) * limit;
  const [clients, total] = await Promise.all([
    Client.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("approvedBy", "name email")
      .lean(),
    Client.countDocuments(query),
  ]);

  return {
    clients,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

/**
 * Get a single client by ID (for admin).
 */
const getClientById = async (clientId) => {
  const client = await Client.findById(clientId)
    .populate("approvedBy", "name email")
    .lean();

  if (!client) throw new AppError("Client not found", 404);
  return client;
};

/**
 * Admin creates a new client directly from the dashboard.
 * Auto-creates the matching User row for WhatsApp + order unification.
 *
 * @param {object} data { phone, name, firmName, gstNumber, email, city, company, partyName, billName, rateUpdatesConsent, approvalStatus }
 * @param {string} employeeId
 */
const createClientByAdmin = async (data, employeeId) => {
  const {
    phone,
    name = "",
    firmName = "",
    gstNumber = "",
    email = "",
    city = "",
    company = "",
    partyName = "",
    billName = "",
    rateUpdatesConsent = true,
    approvalStatus = "approved", // admin-created clients are approved by default
  } = data || {};

  if (!phone || String(phone).replace(/[^0-9]/g, "").length < 10) {
    throw new AppError("Valid phone number is required", 400);
  }
  const normalized = String(phone).replace(/[^0-9]/g, "");

  // Prevent duplicates
  const existing = await Client.findOne({ phone: normalized });
  if (existing) {
    throw new AppError("A client with this phone number already exists", 409);
  }

  const isProfileComplete = !!(name && firmName && email && gstNumber);

  const client = await Client.create({
    phone: normalized,
    name,
    firmName,
    gstNumber,
    email,
    rateUpdatesConsent: !!rateUpdatesConsent,
    rateUpdatesConsentAt: rateUpdatesConsent ? new Date() : null,
    isProfileComplete,
    approvalStatus,
    approvedBy: approvalStatus === "approved" ? employeeId : null,
    approvedAt: approvalStatus === "approved" ? new Date() : null,
  });

  // Sync matching User record (so WhatsApp chats + orders roll up to same phone)
  const { User } = require("../models");
  const userUpdate = {};
  if (name) userUpdate.name = name;
  if (firmName) userUpdate.firmName = firmName;
  if (gstNumber) userUpdate.gstNo = gstNumber;
  if (partyName) userUpdate.partyName = partyName;
  if (billName) userUpdate.billName = billName;
  if (city) userUpdate.city = city;
  if (company) userUpdate.company = company;

  await User.findOneAndUpdate(
    { $or: [{ phone: normalized }, { waId: normalized }] },
    {
      $set: userUpdate,
      $setOnInsert: { phone: normalized, waId: normalized },
    },
    { upsert: true, returnDocument: "after" }
  );

  // Real-time: broadcast
  const io = getIO();
  io.to("employees").emit("client:updated", {
    client: client.toObject(),
    action: "created",
    createdBy: employeeId,
  });

  try {
    require("./contactsService").emitContactUpdated(normalized);
  } catch (_) { /* noop */ }

  logger.info(`Admin created client ${normalized} (status=${approvalStatus})`);
  return client;
};

/**
 * Admin updates an existing client's details.
 * Mirrors relevant fields back to the linked User record.
 */
const updateClientByAdmin = async (clientId, updates, employeeId) => {
  const client = await Client.findById(clientId);
  if (!client) throw new AppError("Client not found", 404);

  const allowed = ["name", "firmName", "gstNumber", "email", "rateUpdatesConsent"];
  for (const key of allowed) {
    if (updates[key] !== undefined) client[key] = updates[key];
  }
  if (updates.rateUpdatesConsent === true && !client.rateUpdatesConsentAt) {
    client.rateUpdatesConsentAt = new Date();
  }
  client.isProfileComplete = !!(client.name && client.firmName && client.email && client.gstNumber);

  await client.save();

  // Mirror to User
  const { User } = require("../models");
  const userUpdate = {};
  if (updates.name !== undefined) userUpdate.name = updates.name;
  if (updates.firmName !== undefined) userUpdate.firmName = updates.firmName;
  if (updates.gstNumber !== undefined) userUpdate.gstNo = updates.gstNumber;
  if (updates.partyName !== undefined) userUpdate.partyName = updates.partyName;
  if (updates.billName !== undefined) userUpdate.billName = updates.billName;
  if (updates.city !== undefined) userUpdate.city = updates.city;
  if (updates.company !== undefined) userUpdate.company = updates.company;
  if (Object.keys(userUpdate).length > 0) {
    await User.findOneAndUpdate(
      { $or: [{ phone: client.phone }, { waId: client.phone }] },
      { $set: userUpdate, $setOnInsert: { phone: client.phone, waId: client.phone } },
      { upsert: true }
    );
  }

  const io = getIO();
  io.to("employees").emit("client:updated", {
    client: client.toObject(),
    action: "updated",
    updatedBy: employeeId,
  });

  try {
    require("./contactsService").emitContactUpdated(client.phone);
  } catch (_) { /* noop */ }

  logger.info(`Admin updated client ${client.phone}`);
  return client;
};

/**
 * Get counts for the admin dashboard badges.
 */
const getApprovalCounts = async () => {
  const [pending, approved, rejected, total] = await Promise.all([
    Client.countDocuments({ approvalStatus: "pending", isProfileComplete: true }),
    Client.countDocuments({ approvalStatus: "approved" }),
    Client.countDocuments({ approvalStatus: "rejected" }),
    Client.countDocuments(),
  ]);

  return { pending, approved, rejected, total };
};

module.exports = {
  findOrCreateByPhone,
  submitProfile,
  approveClient,
  rejectClient,
  createClientByAdmin,
  updateClientByAdmin,
  getClients,
  getClientById,
  getApprovalCounts,
};
