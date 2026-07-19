const express = require('express');
const authController = require('../controllers/authController');
const validate = require('../middleware/validate');
const { protect, authorize } = require('../middleware/auth');
const {
  loginRateLimitMiddleware,
  sensitiveActionRateLimitMiddleware,
} = require('../middleware/rateLimiter');
const {
  registerValidator,
  loginValidator,
  forgotPasswordValidator,
  resetPasswordValidator,
  changePasswordValidator,
  verifyEmailValidator,
} = require('../validators/authValidators');

const router = express.Router();

// ---- Public routes ----
router.post('/register', registerValidator, validate, authController.register);
router.post('/verify-email', verifyEmailValidator, validate, authController.verifyEmail);
router.post(
  '/resend-verification',
  sensitiveActionRateLimitMiddleware,
  forgotPasswordValidator,
  validate,
  authController.resendVerification
);

// Login — protected by Redis-backed rate limiting (brute-force defense)
router.post('/login', loginRateLimitMiddleware, loginValidator, validate, authController.login);

router.post('/refresh-token', authController.refreshToken);

router.post(
  '/forgot-password',
  sensitiveActionRateLimitMiddleware,
  forgotPasswordValidator,
  validate,
  authController.forgotPassword
);
router.post('/reset-password', resetPasswordValidator, validate, authController.resetPassword);

// ---- Protected routes (require valid access token) ----
router.use(protect);

router.post('/logout', authController.logout);
router.post('/logout-all', authController.logoutAll);
router.get('/me', authController.getMe);
router.patch('/me', authController.updateMe);
router.delete('/me', authController.deleteMe);
router.patch('/change-password', changePasswordValidator, validate, authController.changePassword);

// ---- Admin-only ----
router.get('/users', authorize('admin'), authController.listUsers);

module.exports = router;
