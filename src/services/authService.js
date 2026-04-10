const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { Employee } = require("../models");
const AppError = require("../utils/AppError");

const generateToken = (employeeId) => {
  return jwt.sign({ id: employeeId }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
};

const login = async (email, password) => {
  const employee = await Employee.findOne({ email }).select("+password");
  if (!employee || !(await employee.comparePassword(password))) {
    throw new AppError("Invalid email or password", 401);
  }

  if (!employee.isActive) {
    throw new AppError("Account has been deactivated", 403);
  }

  employee.lastLoginAt = new Date();
  await employee.save();

  const token = generateToken(employee._id);

  return {
    token,
    employee: {
      id: employee._id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
    },
  };
};

const register = async (data) => {
  const existing = await Employee.findOne({ email: data.email });
  if (existing) throw new AppError("Email already registered", 409);

  const employee = await Employee.create(data);
  const token = generateToken(employee._id);

  return {
    token,
    employee: {
      id: employee._id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
    },
  };
};

module.exports = { login, register };
