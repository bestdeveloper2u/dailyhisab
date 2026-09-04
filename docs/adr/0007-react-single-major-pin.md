# ADR-0007: Single React major (19.1.0) pinned workspace-wide

- **Status:** ACCEPTED
- **Date:** 2026-09-04
- **Scope:** `/opt/data/khoroch/app` (apps/web, apps/mobile, root overrides)

## Context

The web test suite crashed at render with `TypeError: Cannot read properties of
null (reading 'useRef')`. Root cause: TWO React runtime copies in the hoisted
install — root `react@19.1.0` (required by `react-native 0.81.6` / `expo ~54`)
and `apps/web`'s `react@19.2.8`, plus nested copies under react-dom,
react-router, zustand and @testing-library/react. Hooks called across copies
see a null dispatcher. A previous attempt (vite alias + `deps.inline`) made it
worse by splitting web itself into two React worlds.

## Decision

1. **Unify on `react@19.1.0`** — the ceiling Expo's supported matrix imposes:
   `react-native 0.81.6` + `expo ~54.0.0` require exactly `react 19.1.0`, so
   web cannot move ahead of mobile.
2. Root `package.json` gets `pnpm.overrides: { react: "19.1.0", react-dom:
   "19.1.0" }` so no transitive dependency can reintroduce another copy.
3. The temporary vite alias / `deps.inline` workaround and a require-cache
   seeding hack in the vitest setup were REMOVED; tests pass against the single
   runtime with no test edits (the components were already correct).

## Consequences

- Web upgrades to newer React only together with an Expo SDK bump that
  supports it (one lockstep change, never per-app).
- Known benign peer warning: expo's transitive `@types/react-dom@19.2.7` wants
  `@types/react@^19.2` — types-only, inside expo's own tree, all gates green.
