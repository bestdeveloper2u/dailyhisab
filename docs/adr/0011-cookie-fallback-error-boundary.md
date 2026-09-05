# ADR-0011: Cookie-refresh adoption order + route-root ErrorBoundary

Date: 2026-09-05 (cycle 13) · Status: Accepted · Extends: ADR-0008

## Context
ADR-0008 shipped httpOnly-cookie refresh endpoints (cycle 9) but the web client
kept JSON refresh only. Also, neither app had an error boundary: any render
exception white-screens the app (React has no functional-component equivalent
for catching render errors — react.dev, "Catching rendering errors with an
error boundary").

## Decision 1 — cookie refresh as FALLBACK, not replacement
- `packages/api-client` refreshSession() stays JSON-first: persisted refresh
  token → POST /auth/refresh. Only when JSON has nothing to answer with
  (no token, or 401/403) do we probe POST /auth/refresh-cookie **once**
  (single-flight spans both paths).
- A network-level JSON failure deliberately does NOT probe the cookie: a
  tombstoned/reused cookie could trip the server's reuse-detection and kill a
  session that JSON would have recovered on retry.
- bootstrap(): me() → JSON refresh → cookie restore → anon. logout() also
  fires logout-cookie (fire-and-forget).
- Mobile is unaffected: the cookie handler is simply not configured there.

## Decision 2 — one boundary at the route/screen root, dependency-free fallback
- Web: `<ErrorBoundary>` wraps the whole `<Routes>` tree in App.tsx.
- Mobile: wraps `<RootNavigator/>` inside PrefsProvider (so the fallback reads
  live theme + language tokens).
- The fallback renders from LOCAL bn/en copy maps inside the boundary file and
  imports nothing from shared components — the crash source may be the shared
  module itself. "আবার চেষ্টা করুন" resets state and re-renders children.
- componentDidCatch logs the real error + component stack; UX stays branded.

## Consequences
- XSS blast radius shrinks: refresh tokens live in httpOnly cookies after any
  JSON-refresh failure path; localStorage refresh token still used first when
  present (no behavioral break for existing sessions).
- Cold starts without any session now make one extra 401 request (visible in
  devtools only); re-visit if we want a 204 "no session" response.
- Render crashes degrade to a retry card instead of a white screen on both
  platforms; axe scan (audit/t130_audit.md) shows no a11y regressions.
