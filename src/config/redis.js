const Redis = require('ioredis');
const logger = require('../utils/logger');

const projectName = process.env.PROJECT_NAME || 'default-project';

const redisClient = new Redis(process.env.REDIS_URI, {
  keyPrefix: `${projectName}:`,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redisClient.on('connect', () => {
  logger.info(`Redis connecting… (namespace: "${projectName}:")`);
});

redisClient.on('ready', () => {
  logger.info('Redis connection ready');
});

redisClient.on('error', (err) => {
  logger.error(`Redis error: ${err.message}`);
});

module.exports = redisClient;
