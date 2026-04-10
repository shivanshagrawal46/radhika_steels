const { Router } = require("express");
const authController = require("../controllers/authController");
const { authenticate } = require("../middlewares/auth");

const router = Router();

router.post("/login", authController.login);
router.post("/register", authController.register);
router.get("/me", authenticate, authController.me);

module.exports = router;
