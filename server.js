require('dotenv').config();

process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('UNCAUGHT EXCEPTION! Shutting down...', err);
  process.exit(1);
});

const connectDB = require('./src/config/db');
const redisClient = require('./src/config/redis');
const logger = require('./src/utils/logger');
const app = require('./src/app');

const PORT = process.env.PORT || 5000;
let server;

(async () => {
  try {
    await connectDB();

    server = app.listen(PORT, () => {
      logger.info(`🚀 Auth microservice for project "${process.env.PROJECT_NAME}" running on port ${PORT} [${process.env.NODE_ENV}]`);
    });
  } catch (err) {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }
})();

process.on('unhandledRejection', (err) => {
  logger.error(`UNHANDLED REJECTION! Shutting down... ${err.message}`);
  if (server) {
    server.close(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

const gracefulShutdown = (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  if (server) {
    server.close(async () => {
      logger.info('HTTP server closed.');
      try {
        await redisClient.quit();
      } catch (e) {
        // ignore
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
