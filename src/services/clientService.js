const { Client } = require("../models");
const logger = require("../config/logger");
const AppError = require("../utils/AppError");

// Lazy getter to avoid circular dependency at require-time
const getIO = () => require("../socket").getIO();

/**
 * Find or create a Client record after Firebase OTP verification.
 * Called the moment a client socket connects with a valid Firebase token.
 */
const findOrCreateByFirebase = async (firebaseUid, phone) => {
  const client = await Client.findOneAndUpdate(
    { firebaseUid },
    {
      $set: { lastActiveAt: new Date() },
      $setOnInsert: { firebaseUid, phone },
    },
    { upsert: true, returnDocument: "after" }
  );

  if (!client.phone && phone) {
    client.phone = phone;
    await client.save();
  }

  return client;
};

/**
 * Client submits their profile details after OTP registration.
 */
const submitProfile = async (clientId, profileData) => {
  const { name, firmName, email, gstNumber } = profileData;

  const client = await Client.findById(clientId);
  if (!client) throw new AppError("Client not found", 404);

  if (client.approvalStatus === "approved") {
    throw new AppError("Profile already approved — contact support to update details", 400);
  }

  client.name = name || client.name;
  client.firmName = firmName || client.firmName;
  client.email = email || client.email;
  client.gstNumber = gstNumber || client.gstNumber;
  client.isProfileComplete = !!(name && firmName && email && gstNumber);

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
  clientNsp.to(`client:${client.firebaseUid}`).emit("approval:status", {
    approvalStatus: "approved",
    message: "Your account has been approved! You can now view prices.",
  });

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
  clientNsp.to(`client:${client.firebaseUid}`).emit("approval:status", {
    approvalStatus: "rejected",
    reason,
    message: "Your account request was not approved. Please update your details and try again.",
  });

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
  findOrCreateByFirebase,
  submitProfile,
  approveClient,
  rejectClient,
  getClients,
  getClientById,
  getApprovalCounts,
};
