const crypto = require('crypto');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const sendEmail = require('../utils/sendEmail');
const logger = require('../utils/logger');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  msFromDuration,
} = require('../utils/tokens');

const REFRESH_COOKIE_NAME = 'refreshToken';

const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'strict',
  domain: process.env.COOKIE_DOMAIN || undefined,
  maxAge: msFromDuration(process.env.JWT_REFRESH_EXPIRES || '30d'),
  path: '/api/auth', // only sent on auth routes
});

/** Issues a fresh access + refresh token pair, persists the refresh token, and sets the cookie. */
const issueTokens = async (user, req, res) => {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(refreshToken),
    userAgent: req.headers['user-agent'],
    ip: req.ip,
    expiresAt: new Date(Date.now() + msFromDuration(process.env.JWT_REFRESH_EXPIRES || '30d')),
  });

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return accessToken;
};

// =====================================================
// POST /api/auth/register
// =====================================================
exports.register = catchAsync(async (req, res, next) => {
  const { name, email, password } = req.body;

  const existing = await User.findOne({ email });
  if (existing) {
    return next(new AppError('An account with this email already exists.', 409));
  }

  const user = await User.create({ name, email, password });

  const rawToken = user.createEmailVerificationToken();
  await user.save({ validateBeforeSave: false });

  const verifyUrl = `${process.env.CLIENT_VERIFY_EMAIL_URL}?token=${rawToken}`;
  await sendEmail({
    to: user.email,
    subject: 'Verify your email address',
    html: `<p>Hi ${user.name},</p><p>Please verify your email by clicking the link below:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`,
    text: `Verify your email: ${verifyUrl}`,
  });

  res.status(201).json({
    success: true,
    message: 'Registration successful. Please check your email to verify your account.',
    data: { user: user.toSafeObject() },
  });
});

// =====================================================
// POST /api/auth/verify-email
// =====================================================
exports.verifyEmail = catchAsync(async (req, res, next) => {
  const { token } = req.body;
  const hashed = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    emailVerificationToken: hashed,
    emailVerificationExpires: { $gt: Date.now() },
  }).select('+emailVerificationToken +emailVerificationExpires');

  if (!user) {
    return next(new AppError('Verification link is invalid or has expired.', 400));
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save({ validateBeforeSave: false });

  res.status(200).json({ success: true, message: 'Email verified successfully.' });
});

// =====================================================
// POST /api/auth/resend-verification
// =====================================================
exports.resendVerification = catchAsync(async (req, res, next) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  // Always respond the same way to avoid leaking which emails are registered
  const genericMsg = { success: true, message: 'If that account exists, a verification email has been sent.' };
  if (!user || user.isEmailVerified) return res.status(200).json(genericMsg);

  const rawToken = user.createEmailVerificationToken();
  await user.save({ validateBeforeSave: false });

  const verifyUrl = `${process.env.CLIENT_VERIFY_EMAIL_URL}?token=${rawToken}`;
  await sendEmail({
    to: user.email,
    subject: 'Verify your email address',
    html: `<p>Please verify your email: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
    text: `Verify your email: ${verifyUrl}`,
  });

  res.status(200).json(genericMsg);
});

// =====================================================
// POST /api/auth/login
// =====================================================
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password +failedLoginAttempts +accountLockedUntil');

  if (!user) {
    return next(new AppError('Invalid email or password.', 401));
  }

  if (user.accountLockedUntil && user.accountLockedUntil > Date.now()) {
    const minsLeft = Math.ceil((user.accountLockedUntil - Date.now()) / 60000);
    return next(new AppError(`Account temporarily locked. Try again in ${minsLeft} minute(s).`, 423));
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    if (user.failedLoginAttempts >= 10) {
      user.accountLockedUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 min lock
      user.failedLoginAttempts = 0;
    }
    await user.save({ validateBeforeSave: false });
    return next(new AppError('Invalid email or password.', 401));
  }

  if (!user.isActive) {
    return next(new AppError('This account has been deactivated. Contact support.', 403));
  }

  user.failedLoginAttempts = 0;
  user.accountLockedUntil = undefined;
  user.lastLoginAt = new Date();
  user.lastLoginIp = req.ip;
  await user.save({ validateBeforeSave: false });

  const accessToken = await issueTokens(user, req, res);

  res.status(200).json({
    success: true,
    message: 'Login successful.',
    data: { user: user.toSafeObject(), accessToken },
  });
});

// =====================================================
// POST /api/auth/refresh-token
// =====================================================
exports.refreshToken = catchAsync(async (req, res, next) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) {
    return next(new AppError('No refresh token provided.', 401));
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    return next(new AppError('Invalid or expired refresh token. Please log in again.', 401));
  }

  const tokenHash = hashToken(token);
  const storedToken = await RefreshToken.findOne({ tokenHash });

  if (!storedToken || storedToken.revoked || storedToken.expiresAt < new Date()) {
    // Possible token reuse/theft — revoke all sessions for this user as a precaution
    if (storedToken) {
      await RefreshToken.updateMany({ user: storedToken.user }, { revoked: true });
      logger.warn(`Refresh token reuse detected for user ${storedToken.user}. All sessions revoked.`);
    }
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    return next(new AppError('Session invalid. Please log in again.', 401));
  }

  const user = await User.findById(decoded.sub);
  if (!user || !user.isActive) {
    return next(new AppError('User no longer exists or is deactivated.', 401));
  }

  // Rotate: revoke old token, issue a new one
  storedToken.revoked = true;
  const newAccessToken = signAccessToken(user);
  const newRefreshToken = signRefreshToken(user);
  storedToken.replacedByTokenHash = hashToken(newRefreshToken);
  await storedToken.save();

  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(newRefreshToken),
    userAgent: req.headers['user-agent'],
    ip: req.ip,
    expiresAt: new Date(Date.now() + msFromDuration(process.env.JWT_REFRESH_EXPIRES || '30d')),
  });

  res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, refreshCookieOptions());

  res.status(200).json({
    success: true,
    data: { accessToken: newAccessToken },
  });
});

// =====================================================
// POST /api/auth/logout  (revokes current session only)
// =====================================================
exports.logout = catchAsync(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (token) {
    const tokenHash = hashToken(token);
    await RefreshToken.updateOne({ tokenHash }, { revoked: true });
  }
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
  res.status(200).json({ success: true, message: 'Logged out successfully.' });
});

// =====================================================
// POST /api/auth/logout-all  (revokes every session for the user)
// =====================================================
exports.logoutAll = catchAsync(async (req, res) => {
  await RefreshToken.updateMany({ user: req.user._id }, { revoked: true });
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
  res.status(200).json({ success: true, message: 'Logged out from all devices.' });
});

// =====================================================
// POST /api/auth/forgot-password
// =====================================================
exports.forgotPassword = catchAsync(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  const genericMsg = {
    success: true,
    message: 'If an account with that email exists, a password reset link has been sent.',
  };
  if (!user) return res.status(200).json(genericMsg);

  const rawToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  const resetUrl = `${process.env.CLIENT_RESET_PASSWORD_URL}?token=${rawToken}`;
  await sendEmail({
    to: user.email,
    subject: 'Password reset request',
    html: `<p>You requested a password reset. This link is valid for 1 hour:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`,
    text: `Reset your password: ${resetUrl}`,
  });

  res.status(200).json(genericMsg);
});

// =====================================================
// POST /api/auth/reset-password
// =====================================================
exports.resetPassword = catchAsync(async (req, res, next) => {
  const { token, password } = req.body;
  const hashed = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashed,
    passwordResetExpires: { $gt: Date.now() },
  }).select('+passwordResetToken +passwordResetExpires');

  if (!user) {
    return next(new AppError('Password reset link is invalid or has expired.', 400));
  }

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  // Revoke all existing sessions since the password changed
  await RefreshToken.updateMany({ user: user._id }, { revoked: true });

  res.status(200).json({ success: true, message: 'Password has been reset. Please log in again.' });
});

// =====================================================
// PATCH /api/auth/change-password  (requires auth)
// =====================================================
exports.changePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+password');

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    return next(new AppError('Current password is incorrect.', 401));
  }

  user.password = newPassword;
  await user.save();

  await RefreshToken.updateMany({ user: user._id }, { revoked: true });
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());

  res.status(200).json({ success: true, message: 'Password changed. Please log in again.' });
});

// =====================================================
// GET /api/auth/me  (requires auth)
// =====================================================
exports.getMe = catchAsync(async (req, res) => {
  res.status(200).json({ success: true, data: { user: req.user.toSafeObject() } });
});

// =====================================================
// PATCH /api/auth/me  (requires auth) — update name only (not email/password)
// =====================================================
exports.updateMe = catchAsync(async (req, res, next) => {
  const allowedFields = ['name'];
  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  if (Object.keys(updates).length === 0) {
    return next(new AppError('No valid fields provided to update.', 400));
  }

  const user = await User.findByIdAndUpdate(req.user._id, updates, {
    new: true,
    runValidators: true,
  });

  res.status(200).json({ success: true, data: { user: user.toSafeObject() } });
});

// =====================================================
// DELETE /api/auth/me  (requires auth) — soft delete
// =====================================================
exports.deleteMe = catchAsync(async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { isActive: false });
  await RefreshToken.updateMany({ user: req.user._id }, { revoked: true });
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
  res.status(200).json({ success: true, message: 'Account deactivated.' });
});

// =====================================================
// GET /api/auth/users  (admin only)
// =====================================================
exports.listUsers = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    User.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(),
  ]);

  res.status(200).json({
    success: true,
    data: {
      users: users.map((u) => u.toSafeObject()),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    },
  });
});
