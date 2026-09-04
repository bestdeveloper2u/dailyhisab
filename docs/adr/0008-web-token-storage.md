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
