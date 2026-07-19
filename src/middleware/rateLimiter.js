const { RateLimiterRedis } = require('rate-limiter-flexible');
const redisClient = require('../config/redis');
const logger = require('../utils/logger');

/**
 * LOGIN rate limiter
 * Keyed by IP + email combined, so:
 *  - A single IP hammering many different accounts is throttled per account
 *  - A botnet spread across IPs trying ONE account is still throttled per account
 * This is the classic defense against credential-stuffing / brute force.
 */
const loginLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'rl:login',
  points: Number(process.env.LOGIN_RATE_LIMIT_POINTS) || 5,
  duration: Number(process.env.LOGIN_RATE_LIMIT_DURATION_SECONDS) || 900, // 15 min window
  blockDuration: Number(process.env.LOGIN_RATE_LIMIT_BLOCK_SECONDS) || 900, // 15 min block
});

const loginRateLimitMiddleware = async (req, res, next) => {
  const email = (req.body?.email || 'unknown').toLowerCase();
  const key = `${req.ip}:${email}`;

  try {
    const rateRes = await loginLimiter.consume(key);
    res.set('X-RateLimit-Remaining', String(rateRes.remainingPoints));
    next();
  } catch (rejRes) {
    const retrySecs = Math.ceil((rejRes?.msBeforeNext || 1000) / 1000);
    logger.warn(`Login rate limit hit for key=${key}. Retry after ${retrySecs}s`);
    res.set('Retry-After', String(retrySecs));
    return res.status(429).json({
      success: false,
      message: `Too many login attempts. Please try again in ${Math.ceil(retrySecs / 60)} minute(s).`,
    });
  }
};

/**
 * GENERAL API rate limiter — applied globally as a coarser safety net
 * (per IP) against abuse/DoS on any endpoint.
 */
const apiLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'rl:api',
  points: Number(process.env.API_RATE_LIMIT_POINTS) || 100,
  duration: Number(process.env.API_RATE_LIMIT_DURATION_SECONDS) || 60,
});

const apiRateLimitMiddleware = async (req, res, next) => {
  try {
    await apiLimiter.consume(req.ip);
    next();
  } catch {
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please slow down.',
    });
  }
};

/**
 * Stricter limiter for sensitive, less-frequent flows (password reset
 * request, resend verification) to stop email-bombing abuse.
 */
const sensitiveActionLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'rl:sensitive',
  points: 3,
  duration: 60 * 60, // 1 hour
  blockDuration: 60 * 60,
});

const sensitiveActionRateLimitMiddleware = async (req, res, next) => {
  const email = (req.body?.email || 'unknown').toLowerCase();
  const key = `${req.ip}:${email}`;
  try {
    await sensitiveActionLimiter.consume(key);
    next();
  } catch (rejRes) {
    const retrySecs = Math.ceil((rejRes?.msBeforeNext || 1000) / 1000);
    res.set('Retry-After', String(retrySecs));
    return res.status(429).json({
      success: false,
      message: 'Too many requests for this action. Please try again later.',
    });
  }
};

module.exports = {
  loginRateLimitMiddleware,
  apiRateLimitMiddleware,
  sensitiveActionRateLimitMiddleware,
};
