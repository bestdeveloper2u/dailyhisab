# ADR-0018: Security headers on the edge and the API

- Status: ACCEPTED (2026-09-06, cycle 18)
- Deciders: CTO (T19.4)
- Tags: security, headers, vercel, fastapi

## Context

Until now the only security header in the stack was the enforcing CSP on
the web origin (vercel.json, ADR-0016/0017 lineage). Everything else —
MIME sniffing, referrer leakage, powerful browser features — was left to
browser defaults. Those defaults are reasonable but invisible: an auditor
(or a future regression) cannot tell deliberate policy from omission, and
the API origin (`/api/*`, proxied through the edge) had no hardening at
all.

Three cheap, orthogonal headers close the gap:

- **`X-Content-Type-Options: nosniff`** — stops browsers from
  MIME-sniffing a response away from its declared `Content-Type`, the
  classic route to drive-by script execution from user-uploaded or
  JSON-looking content.
- **`Referrer-Policy: strict-origin-when-cross-origin`** — full URL stays
  same-origin, only the origin leaks cross-origin, `no-referrer` on
  downgrade. This is already the browser default; setting it explicitly
  costs one header and makes the guarantee auditable instead of assumed.
- **`Permissions-Policy`** — a minimal-disable set for features the app
  never uses, so an embedded/synthetic document can't silently invoke a
  powerful API.

## Decision

Two layers, each owning what it can actually enforce:

- **Edge (root `vercel.json`)** — a second entry in the `headers` array,
  source `/(.*)` so it covers the web shell *and* the API paths routed
  through the rewrites: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and
  `Permissions-Policy: camera=(), geolocation=(), payment=(), usb=()`.
  The existing CSP entry is untouched (its `frame-ancestors 'none'`
  already covers clickjacking; no `X-Frame-Options` duplicate is added).
- **API (`apps/api`)** — a small pure-ASGI middleware
  (`app/core/security_headers.py`, wired in `create_app`) that stamps
  `X-Content-Type-Options: nosniff` and `Referrer-Policy:
  strict-origin-when-cross-origin` on every response, including 404s and
  error responses (pure ASGI, so nothing that emits
  `http.response.start` can bypass it). Cache-related headers are not
  touched.

Deliberate carve-outs:

- **No `microphone=()`** — Daily Hisab is voice-first: expense entry uses
  the browser speech-recognition API, so the microphone must stay
  available. The Permissions-Policy disables only the four features the
  app provably never uses (camera, geolocation, payment, usb).
- **No server-side Permissions-Policy or CSP** — the API serves JSON to
  same-origin fetches; those two headers are document concerns owned by
  the edge. A single source of truth per header avoids the two layers
  drifting apart (the API test contract asserts the API does *not* emit a
  Permissions-Policy).

## Consequences

- Both origins now send nosniff + referrer-policy; defense holds even if
  a future deploy drops the vercel.json header entry or traffic reaches
  the API without the edge in front (self-host / direct origin).
- The header values are duplicated between edge and API by design
  (identical strings for the two shared headers); a change must touch
  both places — covered by the contract tests asserting exact values.
- OpenAPI is unchanged (middleware only appends response headers, no
  routes/schema touched), so the generated api-client stays byte-stable.
- Deploy note: the vercel.json change takes effect only when the CTO
  pushes (edge deploy); the API headers ship with the next backend
  rollout. Until both land, each layer still covers the shared pair
  independently.
- New browser features (e.g. `xr`) are not disabled by default; adding
  one to the Permissions-Policy set later is a one-line, additive change
  to vercel.json.

## References

- MDN, `X-Content-Type-Options`:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Content-Type-Options
- MDN, `Referrer-Policy`:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy
- MDN, `Permissions-Policy`:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy
- ADR-0016 / ADR-0017 (the CSP this complements; frame-ancestors 'none')
- vercel.json (`headers` array), apps/api/app/core/security_headers.py,
  apps/api/tests/test_security_headers.py
