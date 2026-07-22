# Auth Microservice — API Request/Response Reference

Base URL: `http://localhost:5000/api/auth` (adjust host per environment)

**Conventions:**
- All request/response bodies are JSON (`Content-Type: application/json`)
- Protected routes require header: `Authorization: Bearer <accessToken>`
- The refresh token is never in the JSON body — it's set/read as an httpOnly cookie automatically
- All error responses share this shape: `{ "success": false, "message": "..." }` (validation errors additionally include an `errors` array)

---

## How Email Verification & Password Reset Actually Work

These flows involve **real SMTP email delivery**, not a simulated/mocked step. Configure real credentials in `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`) — Gmail (with an App Password), SendGrid, Mailgun, etc. all work since Nodemailer just talks standard SMTP.

**Step by step (identical mechanism for both email verification and password reset):**

1. **Token generation** (`User.js` model methods `createEmailVerificationToken()` / `createPasswordResetToken()`):
   ```js
   const rawToken = crypto.randomBytes(32).toString('hex');                          // random, unguessable, sent to the user
   this.emailVerificationToken = crypto.createHash('sha256').update(rawToken).digest('hex'); // only the HASH is stored in MongoDB
   this.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;                 // 24h expiry (1h for password reset)
   ```
   Only the hashed token ever touches the database. The raw token exists only in the email itself — so a leaked database alone can't be used to forge a valid verification/reset link.

2. **Link construction** — the raw token is appended as a query param to a frontend URL defined in `.env`:
   ```
   CLIENT_VERIFY_EMAIL_URL=http://localhost:3000/verify-email
   CLIENT_RESET_PASSWORD_URL=http://localhost:3000/reset-password
   ```
   e.g. `http://localhost:3000/verify-email?token=<rawToken>`

3. **Delivery** — `sendEmail()` (`src/utils/sendEmail.js`) sends this link via Nodemailer through your configured SMTP provider to the user's real inbox. Failure to send is logged but does not throw (so registration doesn't hard-fail just because SMTP briefly hiccups).

4. **Frontend responsibility** — your React app needs a page at the configured URL (e.g. `/verify-email` and `/reset-password`) that reads the `token` query param from the address bar and calls the corresponding API endpoint (`POST /verify-email` or `POST /reset-password`) with it in the JSON body. **This microservice only provides the API side** — the actual page UI is not included and must be built in your frontend.

5. **Verification on the backend** — the token received from the frontend is re-hashed with SHA-256 and compared against the stored hash, along with an expiry check:
   ```js
   const hashed = crypto.createHash('sha256').update(token).digest('hex');
   const user = await User.findOne({
     emailVerificationToken: hashed,
     emailVerificationExpires: { $gt: Date.now() },
   });
   ```
   On success, the token fields are cleared from the DB so the same link can't be reused.

**Why the token is never emailed in plaintext-stored form:** if the database were ever compromised, an attacker holding only the hash cannot reverse it back into a usable token (one-way SHA-256), so they can't verify/reset accounts using leaked DB contents alone.

---

## 1. Register
`POST /register` — public

**Request**
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "StrongPass1"
}
```

**Success — 201**
```json
{
  "success": true,
  "message": "Registration successful. Please check your email to verify your account.",
  "data": {
    "user": {
      "id": "64f1c2...",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "role": "user",
      "isEmailVerified": false,
      "isActive": true,
      "createdAt": "2026-07-19T06:00:00.000Z"
    }
  }
}
```

**Errors**
- `409` — email already registered: `{ "success": false, "message": "An account with this email already exists." }`
- `400` — validation failed:
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    { "field": "password", "message": "Password must contain a number" }
  ]
}
```

---

## 2. Verify Email
`POST /verify-email` — public

**Request**
```json
{ "token": "raw-token-from-email-link" }
```

**Success — 200**
```json
{ "success": true, "message": "Email verified successfully." }
```

**Error — 400**
```json
{ "success": false, "message": "Verification link is invalid or has expired." }
```

---

## 3. Resend Verification
`POST /resend-verification` — public (rate limited: 3/hour per IP+email)

**Request**
```json
{ "email": "jane@example.com" }
```

**Success — 200** (always this generic message, whether or not the account exists)
```json
{ "success": true, "message": "If that account exists, a verification email has been sent." }
```

**Error — 429**
```json
{ "success": false, "message": "Too many requests for this action. Please try again later." }
```

---

## 4. Login
`POST /login` — public (rate limited: 5/15min per IP+email)

**Request**
```json
{
  "email": "jane@example.com",
  "password": "StrongPass1"
}
```

**Success — 200**
Sets `Set-Cookie: refreshToken=...; HttpOnly; Path=/api/auth; ...`
```json
{
  "success": true,
  "message": "Login successful.",
  "data": {
    "user": {
      "id": "64f1c2...",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "role": "user",
      "isEmailVerified": true,
      "isActive": true,
      "createdAt": "2026-07-19T06:00:00.000Z"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs..."
  }
}
```

**Errors**
- `401` — wrong credentials: `{ "success": false, "message": "Invalid email or password." }`
- `423` — account locked: `{ "success": false, "message": "Account temporarily locked. Try again in 24 minute(s)." }`
- `403` — deactivated account: `{ "success": false, "message": "This account has been deactivated. Contact support." }`
- `429` — rate limited: `{ "success": false, "message": "Too many login attempts. Please try again in 15 minute(s)." }`

---

## 5. Refresh Token
`POST /refresh-token` — public, but requires the `refreshToken` httpOnly cookie to be present (send with `credentials: 'include'`)

**Request** — empty body, cookie does the work
```json
{}
```

**Success — 200**
Rotates the cookie (`Set-Cookie: refreshToken=<new>; ...`)
```json
{
  "success": true,
  "data": { "accessToken": "eyJhbGciOiJIUzI1NiIs..." }
}
```

**Errors**
- `401` — no cookie: `{ "success": false, "message": "No refresh token provided." }`
- `401` — expired/invalid/reused: `{ "success": false, "message": "Session invalid. Please log in again." }`

---

## 6. Forgot Password
`POST /forgot-password` — public (rate limited: 3/hour per IP+email)

**Request**
```json
{ "email": "jane@example.com" }
```

**Success — 200** (generic message regardless of whether email exists)
```json
{ "success": true, "message": "If an account with that email exists, a password reset link has been sent." }
```

---

## 7. Reset Password
`POST /reset-password` — public

**Request**
```json
{
  "token": "raw-token-from-email-link",
  "password": "NewStrongPass1"
}
```

**Success — 200**
```json
{ "success": true, "message": "Password has been reset. Please log in again." }
```

**Error — 400**
```json
{ "success": false, "message": "Password reset link is invalid or has expired." }
```

---

## 8. Logout
`POST /logout` — 🔒 requires `Authorization: Bearer <accessToken>`

**Request** — empty body
```json
{}
```

**Success — 200**
Clears the refresh cookie.
```json
{ "success": true, "message": "Logged out successfully." }
```

---

## 9. Logout All Devices
`POST /logout-all` — 🔒 requires Bearer token

**Request** — empty body

**Success — 200**
```json
{ "success": true, "message": "Logged out from all devices." }
```

---

## 10. Get Current User
`GET /me` — 🔒 requires Bearer token

**Request** — no body

**Success — 200**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "64f1c2...",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "role": "user",
      "isEmailVerified": true,
      "isActive": true,
      "createdAt": "2026-07-19T06:00:00.000Z"
    }
  }
}
```

**Error — 401**
```json
{ "success": false, "message": "You are not logged in. Please log in to access this resource." }
```

---

## 11. Update Profile
`PATCH /me` — 🔒 requires Bearer token (only `name` is updatable)

**Request**
```json
{ "name": "Jane R. Doe" }
```

**Success — 200**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "64f1c2...",
      "name": "Jane R. Doe",
      "email": "jane@example.com",
      "role": "user",
      "isEmailVerified": true,
      "isActive": true,
      "createdAt": "2026-07-19T06:00:00.000Z"
    }
  }
}
```

**Error — 400**
```json
{ "success": false, "message": "No valid fields provided to update." }
```

---

## 12. Delete (Deactivate) Account
`DELETE /me` — 🔒 requires Bearer token

**Request** — no body

**Success — 200**
Soft-deletes (`isActive: false`), revokes all sessions, clears cookie.
```json
{ "success": true, "message": "Account deactivated." }
```

---

## 13. Change Password
`PATCH /change-password` — 🔒 requires Bearer token

**Request**
```json
{
  "currentPassword": "StrongPass1",
  "newPassword": "EvenStrongerPass2"
}
```

**Success — 200**
Revokes all sessions (including current one) — client must log in again.
```json
{ "success": true, "message": "Password changed. Please log in again." }
```

**Error — 401**
```json
{ "success": false, "message": "Current password is incorrect." }
```

---

## 14. List Users (Admin)
`GET /users?page=1&limit=20` — 🔒 requires Bearer token + `role: admin`

**Request** — no body, optional query params `page`, `limit` (max 100)

**Success — 200**
```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "64f1c2...",
        "name": "Jane Doe",
        "email": "jane@example.com",
        "role": "user",
        "isEmailVerified": true,
        "isActive": true,
        "createdAt": "2026-07-19T06:00:00.000Z"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 42, "pages": 3 }
  }
}
```

**Error — 403**
```json
{ "success": false, "message": "You do not have permission to perform this action." }
```

---

## Global Error Shapes

**404 — unknown route**
```json
{ "success": false, "message": "Cannot find /api/auth/xyz on this server." }
```

**429 — global API rate limit**
```json
{ "success": false, "message": "Too many requests. Please slow down." }
```

**500 — unexpected error** (message is generic in production; `stack`/`error` fields are included only when `NODE_ENV !== production`)
```json
{ "success": false, "message": "Something went wrong. Please try again later." }
```