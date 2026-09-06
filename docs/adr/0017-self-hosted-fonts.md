# ADR-0017: Self-hosted web fonts (revert the ADR-0016 CSP exception)

- Status: ACCEPTED (2026-09-06, cycle 18)
- Deciders: CTO (T17.2)
- Tags: security, csp, fonts, pwa
- Supersedes: ADR-0016 (the Google Fonts host exception only; the enforcing
  CSP itself stays)

## Context

ADR-0016 (cycle 17, commit 281321b) un-blocked typography by allowing
`https://fonts.googleapis.com` (style-src) and `https://fonts.gstatic.com`
(font-src) in the Vercel CSP. That fixed the silent fallback-to-system-fonts
regression, but at a cost:

- every page load makes third-party requests to two Google hosts (privacy,
  another origin to trust);
- the woff2 files live outside the PWA precache, so **Bengali typography is
  a gap offline** — offline bn text still renders with system fallback fonts
  (owner watch: PWA offline completeness, carried from ADR-0016);
- the CSP carries a permanent exception for what should be first-party
  static assets.

## Decision

Self-host both families and revert the CSP hosts to `'self'`:

- `apps/web/public/fonts/` holds the woff2 files fetched from the Google
  Fonts css2 response (Noto Sans Bengali 400/500/600/700 + Inter
  400/500/600/700/800; bengali + latin + latin-ext subsets only — the
  cyrillic/greek/vietnamese subsets are dropped): 22 files, ~1.2 MB.
- `apps/web/src/index.css` carries the `@font-face` rules copied 1:1 from
  the css2 response with `src` rewritten to `/fonts/...` (unicode-range
  subsetting and `font-display: swap` preserved). `--font-bn` /
  `--font-en` stacks are unchanged.
- `apps/web/index.html` loses the two `preconnect` hints and the
  fonts.googleapis.com stylesheet `<link>`.
- `vercel.json` CSP is back to `style-src 'self' 'unsafe-inline'` and
  `font-src 'self' data:` — byte-identical to the pre-281321b header.
- No vite.config change was needed: the existing workbox
  `globPatterns: ["**/*.{js,css,html,png,svg,ico,woff,woff2}"]` (T9.1)
  already precaches everything in `dist/`, which includes `public/fonts/`
  (vite copies `public/` verbatim), so the fonts are offline from day one.

## Rationale

- Fonts are a hard UI dependency (ADR-0016's own argument) and now ship
  with the app shell — one origin, one cache, offline-complete.
- Removes the only third-party origin the CSP allowed; the default-deny
  posture is restored without breaking typography.
- The files are frozen at fetch time (variable-font woff2 served by
  Google on 2026-09-06), so rendering is deterministic — no silent
  re-design when Google updates the v33/v20 files upstream.

## Consequences

- Repo/deploy size grows by ~1.2 MB (22 woff2 files, ~1,254 KB). Note:
  Google served variable fonts, so the per-weight files are byte-identical
  per subset (e.g. all four noto-bengali-*-bengali files are the same
  bytes) — a follow-up could dedupe to 10 files (~280 KB) at the cost of
  diverging from the css2 response 1:1.
- No third-party font requests at runtime: CSP violations from font loads
  disappear, and the PWA renders bn text identically online and offline.
- Font updates are now a manual re-fetch (rerun the css2 fetch, replace
  files, bump the CSS) instead of Google silently rolling them out.
- Any future third-party origin still needs its own ADR (ADR-0016 rule
  unchanged).

## References

- ADR-0016 (superseded exception, cycle 16/17 history)
- commit 281321b (the CSP exception being reverted)
- apps/web/src/index.css (@font-face block), apps/web/public/fonts/
- apps/web/vite.config.ts (T9.1 workbox globPatterns, unchanged)
