# ADR-0016: CSP exception for Google Fonts (and the self-hosting endgame)

- Status: ACCEPTED (2026-09-06, cycle 16)
- Deciders: CTO (release gate t160_ui.py caught the regression)
- Tags: security, csp, fonts, pwa

## Context

Cycle 14 made the Vercel CSP header **enforcing** (T14.2, v0.11.0) with
`style-src 'self' 'unsafe-inline'` and `font-src 'self' data:`. The SPA's
`apps/web/index.html` (owner commit d0174e1) loads Noto Sans Bengali + Inter
from `fonts.googleapis.com` (stylesheet) and `fonts.gstatic.com` (woff2).

Consequence, caught by the cycle-16 live smoke (audit/t160_ui.py check D):
every page load logged CSP violations and **rendered with fallback fonts**
since v0.11.0 — Bengali text fell back to system fonts, silently. The strict
CSP and the font `<link>` were both "working as coded", just not together.

## Decision

Allow exactly the two Google Fonts hosts in `vercel.json`:

- `style-src` += `https://fonts.googleapis.com` (the css2 stylesheet;
  `style-src-elem` is not set, so `style-src` is the effective directive)
- `font-src` += `https://fonts.gstatic.com` (the woff2 files)

`connect-src 'self'` stays — stylesheet and font loads are governed by
style/font-src, not connect-src. No other loosening; script-src/img-src
unchanged.

## Rationale

- Smallest possible diff that un-breaks typography for every Bengali user
  TODAY; zero app-code/build changes, applies on Vercel redeploy.
- The fonts are already a hard UI dependency of the shipped index.html —
  CSP that silently breaks a core resource is worse than a scoped exception.

## Consequences & follow-up

- Self-hosting the two families (`@font-face` + woff2 in the PWA precache)
  removes both external hosts again, tightens CSP back to `'self'`, and makes
  bn text render offline — queued as the proper fix (cycle-17 candidate,
  owner watch: PWA offline completeness).
- Any future third-party origin (analytics, Sentry) needs its own ADR; the
  default stays deny.

## References

- audit/t160_ui.py (failure evidence, console dump)
- ADR-0012/0014/0015 (same cycle), vercel.json headers block
