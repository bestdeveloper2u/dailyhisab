# ADR-0003: Monorepo tooling (pnpm, hoisted node_modules, raw-TS packages, SDK pins)

- **Status:** ACCEPTED
- **Date:** 2026-09-04
- **Scope:** `/opt/data/khoroch/app` pnpm workspace (`apps/web`, `apps/mobile`, `apps/api`, `packages/*`)
- **Related:** ADR-0004 (money as strings at the API edge), docs/BRAND.md

## Context

Daily Khoroch is a pnpm workspace containing a Vite web app, an Expo (React
Native) mobile app, a FastAPI service, and shared TypeScript packages. The
toolchain must satisfy several conflicting constraints at once:

1. **Global npm is blocked by policy** on the dev host — package-manager
   installation must go through a user-level shim, not `npm install -g`.
2. **Expo/Metro cannot follow pnpm's symlinked virtual store** reliably
   (asset and babel-preset resolution break inside `node_modules/.pnpm`).
3. **Metro and Vite both transform TS source**, so shared packages don't need
   a build step — but pnpm's strict isolation hides hoisted peers from them.
4. **Version stability matters more than novelty** for a solo project with no
   device farm: every major-version jump must be justified by a concrete need.

## Decision

### 1. pnpm 10.34.5 via corepack user-dir shims

`packageManager: "pnpm@10.34.5"` is pinned in the root `package.json`.
Developers enable it with corepack shims installed into `~/.local/bin`
(`corepack enable --install-directory ~/.local/bin`), which keeps the global
npm prefix untouched as policy requires. CI uses `pnpm/action-setup@v4` with
the same version, and every workflow installs with `--frozen-lockfile`.

### 2. `node-linker=hoisted` for Metro compatibility

`.npmrc` sets `node-linker=hoisted` so `node_modules` is a flat, real-file
layout instead of pnpm's symlink farm. This is required for Expo SDK 54 /
Metro to resolve `react-native` asset and babel plugins correctly. The cost
(hoisted peers can leak) is acceptable at this project size; Expo's
`npx expo install --check` guards drift.

### 3. `onlyBuiltDependencies: ["esbuild"]`

pnpm 10 blocks postinstall scripts by default. The only dependency we allow to
run one is `esbuild` (Vite's binary installer). Everything else — including
Expo's optional telemetry/native steps — runs fine without lifecycle scripts,
shrinking the supply-chain surface.

### 4. Workspace packages ship raw TypeScript source

`@khoroch/core` and `@khoroch/api-client` have no build output: their
`exports` point directly at `src/*.ts`. Vite (web) and Metro (mobile) both
transform TS themselves, so a compiled `dist/` would only add a build-order
dependency between packages. The FastAPI service is Python and never imports
these packages; the API contract lives in OpenAPI, regenerated into
`@khoroch/api-client` via `pnpm generate:client`.

### 5. Expo SDK 54 pin, upgrades deliberate

Mobile pins `expo ~54.0.0` (react-native 0.81.6, react 19.1.0,
expo-router ~6). SDK upgrades land only through `npx expo install --fix` in a
dedicated PR, because SDK releases move the entire native dependency graph.
No device/emulator exists in this environment, so the mobile gate is
`tsc --noEmit`; native builds are validated later on real hardware.

### 6. Stability pins: TS 5.9, react-router 7, vite 6 / vitest 3

- **TypeScript 5.9 (not TS 7 / tsgo):** the native-preview compiler is
  promising but not required; 5.9 is fully supported by Expo SDK 54's type
  definitions and every tool in the chain.
- **react-router 7 (not 8):** v7 is the framework-mode rewrite the web app
  uses today; jumping to v8 buys nothing until a concrete feature needs it.
- **vite 6 / vitest 3:** matched majors that are mutually tested; vite 7's
  node-version requirements and plugin churn offer no benefit here.

## Consequences

- CI gates equal local gates: `ruff`/`mypy`/`pytest` for the API,
  `typecheck`/`lint`/`test`/`build` for web, `tsc --noEmit` for mobile.
  Nothing merges green locally but red in CI, or vice versa.
- Adding a native Expo module requires re-running `expo install --check`
  because hoisted layout hides version mismatches less loudly.
- Package authors must not rely on runtime dependencies being hoisted
  (declared deps still resolve thanks to hoisting, but `src/*.ts` exports
  mean consumers' bundlers see the real import graph).
- Deploy tooling is intentionally absent until Phase 4 credentials exist
  (see `.github/workflows/ci.yml` header).
