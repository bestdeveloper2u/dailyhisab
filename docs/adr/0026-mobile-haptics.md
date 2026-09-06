# ADR-0026: On-device haptic feedback via expo-haptics (mobile)

- Status: ACCEPTED (2026-09-06, cycle 26)
- Deciders: CEO (scope), CTO (merge); researched by PM (Expo SDK docs fetched 200)
- Tags: mobile, ux, zero-cost, on-device

## Context

Daily Hisab mobile is used one-handed, often mid-transaction in noisy markets;
visual toasts alone are easy to miss. iOS/Android both provide system haptics,
and Expo exposes them through `expo-haptics` (SDK 54 → ~15.0.8). Voice-first
flows (speak → confirm → saved) benefit from a tactile "done" beat. Zero-AI-
cost rule unaffected: haptics are purely on-device OS calls.

## Decision

- `apps/mobile/lib/haptics.ts` — three thin wrappers (`hapticSuccess`,
  `hapticWarning`, `hapticLight`). Contract: **a missing haptics engine must
  never break a user flow** — `Platform.OS === 'web'` returns immediately and
  every native call is try/caught into a silent no-op (Expo Go/web/old
  devices included). Static import is Expo-Go-safe (unlike
  `expo-speech-recognition`, which needs dynamic import).
- Wiring is fire-and-forget (`void hapticSuccess();`) inside **existing**
  success/error branches only: success beat on expense add, voice-batch save,
  debt pay, budget save (shared `flashSaved`), recurring create / run-now
  catch-up; warning beat on delete confirm, duplicate-guard hit, and save
  validation/API errors. Login untouched; no haptics on scroll or
  RefreshControl.
- Deliberately not wired: month/report (no success handlers exist yet).

## Consequences

- No behavioral risk: worst case is silence.
- `hapticLight` ships unused, reserved for future subtle taps (tsc-clean).
- Mobile gate remains `tsc --noEmit` (no test runner in the package).
