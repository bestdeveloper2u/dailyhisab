# ADR-0025: Custom PWA install chip via `beforeinstallprompt`

- Status: ACCEPTED (2026-09-06, cycle 26)
- Deciders: CEO (scope), CTO (merge); researched by PM (MDN fetched 200)
- Tags: pwa, ux, web, zero-dependency

## Context

Daily Hisab ships a full PWA (manifest + service worker via
`vite-plugin-pwa`, precached). On Chromium the only default install affordance
is the browser's mini-infobar, which is easy to miss and cannot be styled or
translated; Safari/Android WebView offer nothing comparable. The frozen
prototype's Settings has an app-install row concept; the web app had no
equivalent.

## Decision

Adopt the standard MDN `BeforeInstallPromptEvent` pattern with **zero new
dependencies**:

- `apps/web/src/lib/installPrompt.ts` — singleton store (same pattern as
  `UpdateToastStore`) listening once for `beforeinstallprompt`
  (`preventDefault()`), exposing `canInstall` / `installed` /
  `promptInstall()` / `dismissInstallChip()` via `useSyncExternalStore`.
  `installed` is true when `matchMedia('(display-mode: standalone)')` matches
  or after `appinstalled`. Every access is guarded for browsers without the
  event (Firefox/Safari render nothing — the browser's own flow still works).
- Dismissal persists at `localStorage['khoroch.installChip']`; the chip never
  nags more than once per storage clear.
- `InstallChip.tsx` renders a row in the Settings "অ্যাপ" card — bn-first
  copy ("অ্যাপ ইনস্টল করুন" / "পরে"), toast on accepted install. It renders
  `null` unless the browser actually deferred the prompt, so the UI never
  lies about installability.

## Consequences

- Single-use event: after `prompt()` the event is consumed; the chip hides
  via `appinstalled` or the `userChoice` outcome.
- No lighthouse/PWA score dependency; chip is purely additive.
- Tests stub the event + `matchMedia`; 6 vitest cases cover show/hide/prompt.
