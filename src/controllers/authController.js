const Joi = require("joi");
const authService = require("../services/authService");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middlewares/validate");

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
});

const registerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).max(128).required(),
  phone: Joi.string().allow("").optional(),
  role: Joi.string().valid("admin", "manager", "sales", "support").optional(),
});

const login = [
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body.email, req.body.password);
    res.json({ success: true, data: result });
  }),
];

const register = [
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.register(req.body);
    res.status(201).json({ success: true, data: result });
  }),
];

const me = asyncHandler(async (req, res) => {
  const { _id, name, email, role } = req.employee;
  res.json({ success: true, data: { id: _id, name, email, role } });
});

module.exports = { login, register, me };
