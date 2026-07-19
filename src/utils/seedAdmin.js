/**
 * Run with: npm run seed:admin
 * Creates (or updates) an admin user using ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME
 * from .env. Useful right after pointing this service at a brand-new project.
 */
require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');
const logger = require('./logger');

(async () => {
  try {
    await connectDB();

    const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env');
    }

    let admin = await User.findOne({ email: ADMIN_EMAIL }).select('+password');
    if (admin) {
      admin.role = 'admin';
      admin.isEmailVerified = true;
      await admin.save({ validateBeforeSave: false });
      logger.info(`Existing user ${ADMIN_EMAIL} promoted to admin.`);
    } else {
      admin = await User.create({
        name: ADMIN_NAME || 'Admin',
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        role: 'admin',
        isEmailVerified: true,
      });
      logger.info(`Admin user created: ${ADMIN_EMAIL}`);
    }

    process.exit(0);
  } catch (err) {
    logger.error(`Seeding failed: ${err.message}`);
    process.exit(1);
  }
})();
