# ADR-0008: Web token storage — Bearer + localStorage refresh (XSS tradeoff, cycle-1 of auth)

- **Status:** ACCEPTED
- **Date:** 2026-09-04
- **Scope:** apps/web, packages/api-client
- **Related:** ADR-0002 (auth design — its "httpOnly cookie for web" line is
  hereby AMENDED for this phase: the API ships Bearer-only in Phase 1)

## Context

ADR-0002 sketched httpOnly-cookie refresh transport for web. The Phase 1
backend implements Bearer-only endpoints; adding cookie session endpoints
would have doubled the auth surface this cycle. The web app needs a working
session that survives reload TODAY (login → protected routes → silent
refresh), and the app ships locally only (no production deploy until the
owner provides creds — deploy stays BLOCKED).

## Decision

1. **Access token: memory only** (zustand store field, never persisted).
2. **Refresh token: localStorage** under `khoroch.refresh` via zustand
   `persist`, with a guarded custom storage that REFUSES to write
   null-refresh snapshots (no tombstones — key absence means "anonymous").
3. **Silent refresh:** openapi-fetch middleware retries any protected-path 401
   exactly once after a single-flight `POST /auth/refresh`; the rotated pair
   is pushed back into the store via `configureAuth.onTokenRefresh`. On
   refresh failure the middleware emits `khoroch:auth-expired`; the store
   collapses to anon and the router lands on /login. The original 401's
   `{detail}` propagates to the caller.
4. The XSS tradeoff is explicit and time-boxed: before PRODUCTION deploy
   (Phase 4 gate), the API must gain httpOnly-cookie refresh endpoints
   (CSRF-double-submit) or a backend-for-frontend session — tracked in
   BACKLOG Phase 4 security hardening.

## Consequences

- Reload always costs one `/auth/refresh` round-trip (acceptable at this
  scale; no access-token cache).
- Any injected script could read the refresh token → session theft risk
  EXISTS until the Phase 4 hardening lands; rate limiting + rotation +
  reuse-detection (ADR-0002) bound the blast radius: a stolen rotated token
  presented twice revokes the whole session family.

---

# Addendum (2026-09-05, cycle 4 / T8.3): httpOnly-cookie refresh transport lands

- **Status:** ACCEPTED (amends Decision 2/4 above — the Phase 4 hardening is
  pulled forward; localStorage remains the web's current reader, but the API
  now offers the cookie path for the Phase 4 web/mobile switch)
- **Scope:** apps/api, packages/api-client (additive — the JSON endpoints
  `/auth/refresh` and `/auth/logout` are unchanged and stay byte-compatible)

## Decision

1. **`POST /api/v1/auth/refresh-cookie`** reads the refresh token from an
   `HttpOnly` cookie and rotates it through the *same* code path as the JSON
   endpoint (shared `_rotate_refresh` core: same KV keys `rt:*`/`sess:*`,
   same reuse-detection family kill, same status codes and detail strings).
   The rotated token is returned in the JSON body AND installed as the new
   cookie. Missing cookie → 401; replayed (rotated) token → 401 +
   session-family revocation, identical to the JSON path.
2. **`POST /api/v1/auth/logout-cookie`** clears the cookie (`Max-Age=0`,
   same path) and revokes the session the cookie points at (session record +
   current refresh token), like `/auth/logout`. Idempotent: missing/garbage
   cookie still answers 204.
3. **Cookie shape:** name `kh_refresh`, `Path=/api/v1/auth` (rides only on
   auth endpoints), `HttpOnly`, `SameSite=Lax`, `Max-Age` = refresh TTL
   (cookie never outlives its KV entries). Set/clear logic lives in one
   place, `app/core/cookies.py`.
4. **CSRF stance (time-boxed):** `SameSite=Lax` blocks cross-site POSTs in
   modern browsers, which is the accepted baseline for this phase. A
   double-submit CSRF token is NOT added yet; if the cookie path becomes the
   web's primary transport (Phase 4), add `__Host-` prefix + double-submit
   before PRODUCTION deploy.
5. **`Secure` flag:** always ON via `Settings.refresh_cookie_secure=True`
   (override `KHOROCH_REFRESH_COOKIE_SECURE=0` exists ONLY for the plain-
   http test client, which pins it in `tests/conftest.py`; browsers refuse
   Secure cookies over http). Chosen over keying off `settings.env` so a
   mis-set `KHOROCH_ENV` can never silently downgrade cookie security.

## Consequences

- Web/mobile can move the refresh token out of localStorage without an API
  contract change; the silent-refresh middleware just swaps `POST
  /auth/refresh` (JSON body) for `POST /auth/refresh-cookie` (cookie jar)
  and drops `refreshToken` from persistent storage.
- Reuse detection now also covers cookie-borne tokens for free — one KV
  truth, two transports.
- The JSON `refreshToken` in the response body remains (web keeps working
  during migration); a hardened future variant may omit it for cookie
  clients.
