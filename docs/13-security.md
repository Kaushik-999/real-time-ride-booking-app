# 13 · Security

> Previous: [12 Docker](12-docker-local-development.md) · Next: [14 Errors and recovery](14-error-handling-and-recovery.md)

**Important:** these measures are a reasonable baseline for a learning project. The application has **not** had a professional security review and should not be treated as production-ready.

## The basic idea

Security means assuming that some users will try to misuse the system, and making sure the server refuses. The guiding rule: **never trust the client**. Everything from the browser can be modified.

## Protections and where they live

### Authentication and authorization
JWT checked on every protected route; role read from the database; per-object ownership checks. See [03](03-authentication-and-authorization.md). Files: `server/src/middleware/auth.js`, `services/rideService.js` (`getRideForUser`), `services/offerService.js` (`loadOwnOffer`).

### Password hashing
bcrypt via `bcryptjs`, cost `BCRYPT_ROUNDS` (default 10). `passwordHash` has `select: false` and is removed by `toJSON`. Tested (#96): no hash appears in `/auth/me`, login, or admin user lists.

### JWT handling
HS256 only, expiry `JWT_EXPIRES_IN` (1 h), secret from `JWT_SECRET`. Production refuses to start without a 32+ character secret (`config/index.js`). Tokens are stored in `sessionStorage` and sent in the `Authorization` header.

### Request validation
Every body, param and query goes through Zod (`utils/validators.js`, `middleware/validate.js`). Body schemas are `.strict()`: unknown fields such as `fare`, `status`, `driverId`, `passengerId` produce `400`. IDs must be 24-hex ObjectIds. Coordinates must be numbers in range. JSON bodies are limited to 50 KB.

### Rate limiting
`middleware/rateLimiters.js` with `express-rate-limit`: login/register limited per IP (`AUTH_RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, default 20 per 15 min); booking limited per user (`BOOKING_RATE_LIMIT_MAX`, default 30). Exceeding returns `429 RATE_LIMITED` (test #95). Limits are kept in memory per process; with several API instances each has its own counter (a shared store would need extra infrastructure).

### CORS
Browsers block a web page from calling an API on another origin unless the API allows it. `app.js` allows only origins listed in `CORS_ORIGINS` (default `http://localhost:5173`); other origins get no `Access-Control-Allow-Origin` header (test #97). Socket.IO uses the same list.

### Helmet
Sets protective HTTP headers: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` (no clickjacking), `Strict-Transport-Security`, etc. `X-Powered-By` is removed (test #97).

### Environment secrets
Read only in `config/index.js`; validation errors print variable **names**, never values. `.env` is git-ignored (test #100 checks this). `.env.example` contains placeholders only.

### Database access
MongoDB in Docker has **no authentication** and is published on `localhost:27017` for development convenience. **Never expose this setup to a network.** Production needs MongoDB users/passwords, TLS, and no public port.

### Object-level permissions and privacy
- Passengers see only their rides; others get `404`.
- Drivers see a ride only after being offered/assigned; the `driver:offer` event includes the passenger's name (`passengerName`) and the addresses, but not their phone or email.
- Passengers see the driver's name, vehicle and phone (if provided) only once assigned.
- Admin lists include emails; admins are trusted operators.

### Location privacy
Driver locations are shared only with the passenger of a ride the driver is attached to, only through the authorised `ride:<id>` room, and only while `DRIVER_ASSIGNED`/`DRIVER_ARRIVED`/`IN_PROGRESS`. Passenger locations are never broadcast. Only the **latest** driver position is stored (no history).

### Payment security
No card data is collected or stored. Payment results arrive only through `POST /api/payments/webhook`, which requires an **HMAC-SHA256 signature** of the raw body using `PAYMENT_WEBHOOK_SECRET`, compared in constant time (`crypto.timingSafeEqual`). State changes are conditional (`PROCESSING → SUCCEEDED/FAILED` once), so forged or repeated callbacks can't double-pay or flip a failure (tests #92, #93). The provider is a **mock**.

### Logging without secrets
`utils/logger.js` (pino) redacts `password`, `passwordHash`, `token`, `authorization`, `signature`, `secret` fields (test #100). The access log records method, path, status and duration only, never headers or bodies.

### Safe errors
`middleware/errorHandler.js` returns `{ code, message }` only. Unexpected errors become `500 "Something went wrong"`; the stack trace goes to the server log (test #98).

## Common abuse scenarios

| Attempt | Result |
| --- | --- |
| Edit request to set `estimatedFare: 1` | `400` unknown field |
| Book as another passenger (`passengerId` in body) | `400`; identity comes from JWT |
| Read someone's ride by guessing an id | `404` |
| Accept another driver's offer | `403` |
| Passenger calls `/rides/:id/complete` | `403` |
| Forge a JWT with `role: ADMIN` | `401` (bad signature) |
| Valid token, edited role claim | role taken from DB → `403` |
| Brute-force login | `429` after the limit |
| Fake "payment succeeded" | `401` invalid signature |
| Subscribe to another ride's live location | `{ ok: false, error: 'FORBIDDEN' }` |
| Spam socket events | ignored; server accepts only `ride:subscribe`/`ride:unsubscribe` |

## Known gaps (not implemented)

No refresh-token rotation or token revocation; no account lockout beyond rate limiting; no email verification; no audit of admin actions; no CSP tuning for the map tile domain beyond Helmet defaults (tiles load as images, which the default policy allows); MongoDB without auth in development; dependency vulnerability scanning not automated.

## Glossary

- **CORS**: browser rule about which websites may call an API.
- **CSP**: header limiting where a page may load scripts from.
- **HMAC**: keyed hash proving a message's origin and integrity.
- **Redaction**: replacing sensitive values with `[REDACTED]` in logs.
- **Clickjacking**: tricking users into clicking a hidden framed page.

## Upgrade: new protections

| Area | Protection | Where |
| --- | --- | --- |
| Trip codes | random (`crypto.randomInt`), HMAC + AES-GCM at rest, attempt limits, single use, never sent to drivers or logged | [16](16-otp-and-trip-verification.md) |
| Destination privacy | hidden from drivers until the pickup code is verified | `rideView.js` |
| Login codes | no account enumeration, cooldown, hourly cap, single use | [24](24-authentication-providers.md) |
| Google | signature/issuer/audience/expiry verification; no automatic account merging | [24](24-authentication-providers.md) |
| Documents | magic-byte type check, size limit, AES-GCM encryption, random names, no public route, audited access, retention purge, no ID numbers stored | [23](23-driver-document-verification.md) |
| Admin power | per-permission checks on every admin route, audit log, no deletions, reasons required, admins can't be suspended from the UI | [25](25-admin-management-and-audit.md) |
| Women-driver data | only an admin-verified flag; never shown to passengers; ride preference never shown to drivers | [20](20-women-safety-and-matching-preferences.md) |
| Chat | DB authorisation per message, rate limit, bodies never logged, retention | [22](22-chat-system.md) |
| Safety | no false "police notified"; signed webhooks; lease-protected retries | [19](19-safety-and-emergency-response.md) |
| Suspension | every request and chat send re-checks account status | `middleware/auth.js`, `chatService.js` |

Still **not** reviewed by a professional; add malware scanning for uploads, secret management for the encryption keys, and MongoDB authentication before any real deployment.
