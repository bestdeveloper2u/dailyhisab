# ADR-0002: Custom JWT authentication (Phase 1 auth contract)

- **Status:** ACCEPTED
- **Date:** 2026-09-04
- **Scope:** `apps/api` (`/api/v1/auth/*`, `app/core/`), consumed identically by
  `apps/web` and `apps/mobile`
- **Related:** ADR-0001 (Valkey 7.2 / Supabase Postgres pins), ADR-0004 (error
  envelope), ADR-0005 (no-external-services posture this cycle), docs/ARCHITECTURE.md
  §0 constraint 4, §1 (auth row), §3 (endpoint list)
- **Note:** this is the Phase 1 contract; backend task T1.1 implements it verbatim.

## Context

1. **Supabase Auth is excluded by the product owner** (ARCHITECTURE §0.4): its
   RLS-centric `auth.uid()` model conflicts with our API-layer authorization (ARCHITECTURE
   §4 drops RLS), and it does not give us the control we want over token TTLs, claims,
   session revocation or rate limits. Supabase is used **only** as managed Postgres.
2. We therefore own email+password auth end-to-end. Clients are a Vercel-hosted web app
   and an Expo mobile app sharing one contract; OTP/social login is explicitly deferred.
3. The KV layer (sessions, refresh tokens, rate limits) targets Valkey (ADR-0001 §7),
   but the host Docker daemon is DOWN this cycle — local dev and tests must run with no
   external services, mirroring ADR-0005's SQLite-for-tests posture.

## Decision

### 1. Password hashing — Argon2id via `argon2-cffi`

Hash with `argon2.PasswordHasher` defaults (Argon2id, time_cost=3, memory_cost=64 MiB,
parallelism=4). Parameters live in one place (`app/core/security.py`) so they can be
tuned without touching call sites. Verify with `checkpw`; rehash-on-login when
`needs_rehash` says so. Registration enforces a minimum 8-character password (UTF-8;
Argon2id has no bcrypt-style 72-byte truncation issue).

### 2. Access token — short-lived HS256 JWT, 15 minutes

- Algorithm **HS256**; one symmetric secret, because only our API issues and verifies
  tokens today. (Revisit asymmetric signing if a third party ever needs to verify.)
- TTL **900 s**. Claims: `sub` (profile UUID string), `sid` (session id), `iat`, `exp`
  (`iat + 900`). No other claims in Phase 1.
- Secret: `KHOROCH_JWT_SECRET` (pydantic-settings `KHOROCH_` prefix, `app/core/config.py`),
  **≥ 32 bytes**; startup fails closed if missing or too short when `env != "local"`.
  The token library is an implementation detail (PyJWT is the default choice) as long as
  it emits/accepts standard compact HS256 JWTs with the claims above.

### 3. Refresh token — opaque 256-bit random, 30-day TTL, hash-only storage

- Value: 32 random bytes (`secrets.token_urlsafe(32)`); **opaque** — not a JWT, carries
  no claims, and clients treat it as an unguessable bearer string.
- TTL: **30 days** per token; each rotation resets the window (idle expiry — an unused
  session dies 30 days after its last refresh). Absolute session cap deferred.
- Storage: **only as a SHA-256 hash** (`hashlib.sha256(token).hexdigest()`) inside the
  session record in KV. The plaintext token exists solely in the client's secure storage
  and is returned exactly once, at issuance/rotation. Never logged, never in Postgres.

### 4. Rotation with reuse detection

Every `POST /auth/refresh` hashes the presented token and compares it to the stored
hash for its `sid`:

- **Match** → issue a fresh access+refresh pair, overwrite the stored hash, reset TTL.
- **No match** (token already rotated, revoked, or forged) → **reuse detected**: revoke
  the entire session family (delete `sess:<sid>`), return `401` with
  `code: "auth_refresh_reuse"` per ADR-0004. A thief replaying a stolen old token thus
  kills the session it belongs to. Because one login = one `sid`, the "family" is the
  session; clients must persist only the most recent pair.

### 5. Sessions in Valkey via a KV port with in-memory fallback

- Key: `sess:<sid>` → JSON `{sub, refresh_hash, created_at, last_used_at}`; KV TTL =
  refresh TTL so sessions self-expire. Logout deletes the key.
- Client: `redis-py` asyncio (`redis.asyncio`) — Valkey 7.2 is RESP-compatible
  (ADR-0001 §7); connection URL comes from `KHOROCH_REDIS_URL`.
- **KV port abstraction:** a small interface (`get/set/delete/expire`) with two
  implementations — the Valkey one above and an **in-memory dict + TTL sweep** fallback
  selected when `KHOROCH_REDIS_URL` is unset (local dev, tests). This is the
  session-side twin of ADR-0005's SQLite-for-tests decision: hermetic local runs now,
  a compose-backed integration test when Docker returns. Both implementations sit
  behind one protocol so no auth code knows which is active.

### 6. Rate limiting — sliding window on `/auth/*`

5 requests / 60 s per **(client IP + email bucket)**: key
`rl:auth:<ip>:<sha1(lower(email))>` (email empty bucket when absent), enforced by a
router dependency before handlers, counters in the same KV. Over the limit → **429**
with an integer **`Retry-After`** header (seconds until the window frees) and body per
ADR-0004 (`code: "rate_limited"`).

### 7. Endpoints (Phase 1 surface)

| Endpoint | Auth | Request | Success |
|---|---|---|---|
| `POST /auth/register` | — | `{name?, email, password, lang?}` | 201: profile + token pair |
| `POST /auth/login` | — | `{email, password}` | 200: profile + token pair |
| `POST /auth/refresh` | refresh token | body `{refresh_token}` **or** httpOnly cookie | 200: new pair |
| `POST /auth/logout` | access token | body `{refresh_token}` **or** cookie | 204 |
| `GET /auth/me` | access token | `Authorization` header with the access JWT | 200: profile |

Transport: access token always via `Authorization: Bearer`. Refresh token: web sets it
in an **httpOnly + Secure + SameSite=Lax cookie**; the mobile app keeps it in secure
storage and sends it in the JSON body — `refresh`/`logout` accept either. Emails are
unique (case-insensitive, stored lowercase); duplicate → 409 (`auth_email_taken`).
Error codes follow ADR-0004 (`auth_invalid_credentials` → 401, `auth_token_expired` /
`auth_token_invalid` → 401, `auth_refresh_reuse` → 401, `rate_limited` → 429).

## Consequences

- T1.1 adds deps (`argon2-cffi`, a JWT lib, `redis`) to `apps/api/pyproject.toml` and
  `KHOROCH_JWT_SECRET` / `KHOROCH_REDIS_URL` to `.env.example` — the only code-side
  deltas this ADR implies.
- Secrets handling: rotating `KHOROCH_JWT_SECRET` invalidates outstanding access tokens
  only (≤ 15 min blast radius); refresh sessions survive because they never touch it.
- The in-memory KV fallback is single-process by design; multi-worker deployments
  require the Valkey implementation, which is the default when the URL is set.
- Reuse detection is strict by intent: any client that loses its latest refresh token
  must re-authenticate. That is the trade that makes replay worthless.
- OTP, social login, and email verification are out of scope; each gets its own ADR.
