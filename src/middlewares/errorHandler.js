const logger = require("../config/logger");
const env = require("../config/env");

const errorHandler = (err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;
  const isOperational = err.isOperational || false;

  logger.error({
    message: err.message,
    statusCode,
    stack: err.stack,
    isOperational,
  });

  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: messages,
    });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue).join(", ");
    return res.status(409).json({
      success: false,
      error: `Duplicate value for: ${field}`,
    });
  }

  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      error: `Invalid ${err.path}: ${err.value}`,
    });
  }

  res.status(statusCode).json({
    success: false,
    error: isOperational ? err.message : "Internal server error",
    ...(env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

module.exports = errorHandler;
