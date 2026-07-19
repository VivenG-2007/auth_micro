# Auth Microservice

A production-grade, **reusable** authentication microservice built with Node.js, Express, MongoDB Atlas, and Redis. Designed to be dropped into any project as a standalone auth API.

## Why it's reusable

Every project-specific behaviour is driven by **one** environment variable: `PROJECT_NAME`.

- **MongoDB**: on connect, the service appends `PROJECT_NAME` to your Atlas connection string as the database name (`db.js`). MongoDB creates the database lazily on the first write — so registering your first user in a new project automatically provisions an isolated database. No manual Atlas setup per project.
- **Redis**: all keys are prefixed with `PROJECT_NAME:` (`redis.js`), so a single shared Redis instance can safely serve rate limits/sessions for many projects without collisions.

To reuse this service for a new project: copy the folder (or just point a new `.env` at it), set `PROJECT_NAME=your-new-project`, restart. That's it.

## Features

- Register / Login / Logout / Logout-everywhere
- Email verification (Nodemailer)
- Forgot / Reset password flow
- Change password (invalidates all sessions)
- JWT access tokens (short-lived) + rotating refresh tokens (httpOnly cookie, stored hashed in Mongo with reuse-detection)
- Role-based access control (`user` / `admin`)
- **Redis-backed rate limiting** on login (`rate-limiter-flexible`) — defends against brute force / credential stuffing, keyed by IP+email
- Sensitive-action rate limiting (forgot-password / resend-verification) to stop email bombing
- Global per-IP API rate limit as a safety net
- Account lockout after repeated failed logins
- Security hardening: `helmet`, CORS allow-list, `express-mongo-sanitize`, `xss-clean`, `hpp`, body size limits
- Centralized error handling + Winston logging
- Docker + docker-compose for local dev (Redis containerized, Mongo stays on Atlas)
- Admin user seed script

## Project Structure

```
auth-microservice/
├── server.js                  # Entry point
├── src/
│   ├── app.js                 # Express app + middleware wiring
│   ├── config/
│   │   ├── db.js              # Dynamic Atlas connection (uses PROJECT_NAME)
│   │   └── redis.js           # Namespaced Redis client
│   ├── models/
│   │   ├── User.js
│   │   └── RefreshToken.js
│   ├── controllers/
│   │   └── authController.js
│   ├── routes/
│   │   └── authRoutes.js
│   ├── middleware/
│   │   ├── auth.js            # protect / authorize
│   │   ├── rateLimiter.js     # Redis rate limiters
│   │   ├── validate.js
│   │   └── errorHandler.js
│   ├── validators/
│   │   └── authValidators.js
│   └── utils/
│       ├── tokens.js
│       ├── sendEmail.js
│       ├── logger.js
│       ├── AppError.js
│       ├── catchAsync.js
│       └── seedAdmin.js
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Fill in:
- `PROJECT_NAME` — becomes your database name (and Redis key namespace)
- `MONGO_URI` — Atlas connection string **without** a trailing database name
- `REDIS_URI` — any Redis instance (local, Docker, Upstash, Redis Cloud)
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — long random strings
- SMTP credentials for verification/reset emails

### 3. Run
```bash
npm run dev      # nodemon
npm start        # production
```

### 4. (Optional) Seed an admin user
```bash
npm run seed:admin
```

### Using Docker
```bash
docker compose up --build
```
This spins up the service + a local Redis container. Mongo remains on Atlas via your `.env`.

## Reusing for a new project

1. Duplicate this folder (or keep one deployed instance and swap `.env` per environment).
2. Change only: `PROJECT_NAME`, `CLIENT_ORIGINS`, `CLIENT_VERIFY_EMAIL_URL`, `CLIENT_RESET_PASSWORD_URL`, JWT secrets.
3. Restart. A fresh, isolated database is created automatically on first write.

## API Reference

Base URL: `/api/auth`

| Method | Endpoint | Auth | Rate Limited | Description |
|---|---|---|---|---|
| POST | `/register` | No | Global | Create a new user, sends verification email |
| POST | `/verify-email` | No | Global | Verify email with token |
| POST | `/resend-verification` | No | Yes (sensitive) | Resend verification email |
| POST | `/login` | No | **Yes (Redis, 5/15min per IP+email)** | Log in, returns access token + sets refresh cookie |
| POST | `/refresh-token` | Cookie | Global | Rotate refresh token, get new access token |
| POST | `/forgot-password` | No | Yes (sensitive) | Request password reset email |
| POST | `/reset-password` | No | Global | Reset password using emailed token |
| POST | `/logout` | Bearer | Global | Revoke current session |
| POST | `/logout-all` | Bearer | Global | Revoke all sessions for the user |
| GET | `/me` | Bearer | Global | Get current user profile |
| PATCH | `/me` | Bearer | Global | Update profile (name) |
| DELETE | `/me` | Bearer | Global | Deactivate account (soft delete) |
| PATCH | `/change-password` | Bearer | Global | Change password (revokes all sessions) |
| GET | `/users` | Bearer (admin) | Global | Paginated user list |

### Example: Register
```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Jane Doe","email":"jane@example.com","password":"StrongPass1"}'
```

### Example: Login
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email":"jane@example.com","password":"StrongPass1"}'
```
Response includes `accessToken` in the JSON body; the refresh token is set as an httpOnly cookie automatically (not accessible to JS — send it back via `credentials: 'include'` from the frontend).

### Example: Authenticated request
```bash
curl http://localhost:5000/api/auth/me \
  -H "Authorization: Bearer <accessToken>"
```

### Example: Refresh
```bash
curl -X POST http://localhost:5000/api/auth/refresh-token -b cookies.txt -c cookies.txt
```

## Frontend integration notes (React)

- Store the access token in memory (e.g. React context / state), **not** localStorage, to reduce XSS exposure.
- Send `credentials: 'include'` on fetch/axios calls so the refresh cookie is sent.
- On a 401 from an access-token-protected route, call `/refresh-token` once, then retry the original request.
- On login/logout, no manual cookie handling needed — the browser manages the httpOnly cookie.

## Security notes

- Passwords hashed with bcrypt (cost factor 12).
- Refresh tokens are never stored in plaintext — only their SHA-256 hash is persisted, with rotation + reuse detection.
- Login endpoint is protected by a Redis-backed sliding-window limiter keyed on `IP + email`, independent of the coarser global per-IP limiter, so it can't be bypassed by IP rotation targeting a single account.
- All user-supplied input is sanitized against NoSQL injection and XSS before reaching business logic.
- CORS is allow-list based via `CLIENT_ORIGINS`; unset it too loosely in production.

## Production checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set `COOKIE_SECURE=true` (requires HTTPS)
- [ ] Use strong, unique `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`
- [ ] Restrict `CLIENT_ORIGINS` to real frontend domains
- [ ] Put this service behind a reverse proxy / load balancer with TLS
- [ ] Point `MONGO_URI` at a production Atlas cluster with IP allow-listing
- [ ] Use a managed Redis (Upstash / Redis Cloud / ElastiCache) in production
"# auth_micro" 
