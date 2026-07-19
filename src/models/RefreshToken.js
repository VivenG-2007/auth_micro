const mongoose = require('mongoose');

/**
 * Storing refresh tokens (hashed) server-side lets us:
 *  - Revoke a single session (logout)
 *  - Revoke all sessions (logout everywhere / password change)
 *  - Detect refresh-token reuse (rotation theft detection)
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    userAgent: String,
    ip: String,
    revoked: {
      type: Boolean,
      default: false,
    },
    replacedByTokenHash: String,
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// TTL index — MongoDB automatically deletes expired token documents
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
