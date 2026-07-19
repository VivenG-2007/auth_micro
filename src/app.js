const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');

const authRoutes = require('./routes/authRoutes');
const errorHandler = require('./middleware/errorHandler');
const AppError = require('./utils/AppError');
const { apiRateLimitMiddleware } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

const app = express();

// Trust the first proxy (needed for correct req.ip behind load balancers / Render / Heroku / Nginx)
app.set('trust proxy', 1);

// ---- Security headers ----
app.use(helmet());

// ---- CORS ----
const allowedOrigins = (process.env.CLIENT_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new AppError('Not allowed by CORS', 403));
      }
    },
    credentials: true,
  })
);

// ---- Body / cookie parsing ----
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// ---- Sanitization ----
app.use(mongoSanitize()); // strips $, . operators from user input (NoSQL injection defense)
app.use(xss()); // strips malicious HTML/JS from user input
app.use(hpp()); // prevents HTTP parameter pollution

// ---- Logging ----
app.use(
  morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
  })
)

// ---- Global rate limit (coarse safety net, per IP) ----
app.use('/api', apiRateLimitMiddleware);

// ---- Health check ----
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'auth-microservice',
    project: process.env.PROJECT_NAME,
    timestamp: new Date().toISOString(),
  });
});

// ---- Routes ----
app.use('/api/auth', authRoutes);

// ---- 404 handler ----
app.all('*', (req, res, next) => {
  next(new AppError(`Cannot find ${req.originalUrl} on this server.`, 404));
});

// ---- Global error handler (must be last) ----
app.use(errorHandler);

module.exports = app;
