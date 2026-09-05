# ADR-0013: Mobile voice STT — graceful degradation outside development builds

- **Status:** ACCEPTED
- **Date:** 2026-09-05
- **Scope:** `apps/mobile` voice entry (T15.2, cycle 15) — `lib/voice.ts`, `app/add.tsx`, `app.json`
- **Related:** ADR-0001 (stack pins), ADR-0003 (monorepo tooling / theme tokens), ADR-0004 (API conventions), prototype addscreen mic/overlay (`www/index.html`)

## Context

T15.2 brings the frozen prototype's hold-the-mic expense entry
("চায়ে ৪০ টাকা, রিকশায় ৫০ টাকা" → parsed rows) to the mobile app. The only
maintained Expo speech-to-text library is
[`jamsch/expo-speech-recognition`](https://github.com/jamsch/expo-speech-recognition),
and its README is explicit about the runtime surface: speech recognition
ships through a **config plugin plus microphone/speech permissions and
requires a development build** — the native module is *not* part of Expo Go.

That collides with two facts of life for this project:

1. **The app must keep running in Expo Go.** Demos, the CTO's quick
   smoke-tests, and the current inner loop all ride `npx expo start` +
   Expo Go. A static `import ... from "expo-speech-recognition"` makes the
   native module a hard bundle dependency; where the module is absent the
   app either crashes at import time or throws on first use — the whole
   manual add-expense flow must never be hostage to an optional feature.
2. **The UX is Bengali-first.** The prototype degrades visibly, never
   silently: a feature that is "just missing" must still be *explained* in
   the active language (bn/en), not hidden behind a dead button.

Meanwhile, turning a transcript into expense rows needs no client logic at
all: the API already exposes the rule-based, read-only
`POST /api/v1/voice/parse` (ADR-0004 wire shapes), which returns candidate
rows the user confirms before anything is written.

## Decision

1. **expo-speech-recognition, but only via a development build.** The
   package is registered in `app.json` as a config plugin with the
   Bengali microphone/speech permission strings, plus the iOS
   `NSMicrophoneUsageDescription`/`NSSpeechRecognitionUsageDescription`
   infoPlist entries and `android.permission.RECORD_AUDIO`. Native
   capability is provisioned exactly the way the package README requires;
   a dev build (or store build) carries the module, Expo Go does not.

2. **The native module is resolved through a dynamic `import()` inside
   try/catch — never a static import.** `lib/voice.ts` probes for
   `ExpoSpeechRecognitionModule` at runtime. In a dev build the import
   resolves and voice works; in Expo Go the import itself fails, the
   wrapper returns `null`, and the caller treats that as "voice
   unsupported". Bundling the package therefore stays safe everywhere —
   no static edge in the module graph, no crash at boot.

3. **Degradation is visible, bilingual, and leaves the manual flow
   untouched.** `app/add.tsx` probes once on mount. When the module is
   absent the mic area is not rendered and a themed hint chip shows
   `voiceUnavailable` — "ভয়েস এই বিল্ডে নেই — ডেভেলপমেন্ট বিল্ড প্রয়োজন" /
   "Voice needs a development build" — in the active bn/en UI language.
   The manual add-expense form (the pre-T15.2 path) is byte-identical
   whether or not voice is available; permission-denied recognizer errors
   map to their own `voicePermDenied` hint rather than a generic failure.

4. **Transcript→parse stays server-side; there is no client parser.** The
   final transcript is POSTed to `/api/v1/voice/parse`, which returns
   candidate rows; the app only renders them (editable amounts in a
   confirm sheet) and bulk-creates on confirm — with a loop of single
   creates as fallback for API builds without `/expenses/bulk`. Parsing
   rules therefore improve server-side with no app release, and the
   mobile bundle never carries NLP heuristics.

## Consequences

- **Expo Go keeps working, permanently.** The worst case for any future
  breakage of the native layer is the hint chip — never a red screen.
- **Development builds get the full prototype parity:** hold-to-record
  bn-BD recognition, live partial transcript, server parse, confirm
  sheet, bulk insert, success toast (`toastVoiceSaved`).
- The runtime surface of `expo-speech-recognition` is quarantined behind
  the structural types in `lib/voice.ts`; package upgrades touch one file.
- Voice stays pinned to bn-BD (the Settings screen's "ভয়েস ভাষা: বাংলা"
  row is display-only), matching the prototype.
- If a future Expo SDK ships an OS speech API in Expo Go, only the probe
  in `lib/voice.ts` changes — the UI, parse and confirm flow are agnostic
  to where the recognizer came from.
