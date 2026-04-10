const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { Employee } = require("../models");
const AppError = require("../utils/AppError");

const authenticate = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new AppError("Authentication required", 401);
    }

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, env.JWT_SECRET);

    const employee = await Employee.findById(decoded.id);
    if (!employee || !employee.isActive) {
      throw new AppError("Account not found or deactivated", 401);
    }

    req.employee = employee;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return next(new AppError("Invalid or expired token", 401));
    }
    next(err);
  }
};

const authorize = (...roles) => {
  return (req, _res, next) => {
    if (!roles.includes(req.employee.role)) {
      return next(new AppError("Insufficient permissions", 403));
    }
    next();
  };
};

module.exports = { authenticate, authorize };
