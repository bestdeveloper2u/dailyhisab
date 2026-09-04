# ADR-0006: Web frontend shell (React 19 + Vite + Tailwind v4)

- **Status:** ACCEPTED
- **Date:** 2026-09-04
- **Scope:** `apps/web`

## Context

The legacy Daily Khoroch web app is frozen as a visual prototype at `www/index.html`
(plain HTML/CSS, dark/light vars, app bar + sidebar + bottom tab bar + FAB). The new
architecture is a pnpm monorepo with shared packages (`@khoroch/core` owning brand
tokens, bn/en dictionary and money helpers). We need a React shell that starts from
the frozen prototype's look and becomes the base for feature parity in later cycles.

## Decision

1. **Stack:** React 19 + TypeScript (strict, shared `tsconfig.base.json`) + Vite 6,
   built with `tsc --noEmit && vite build`.
2. **Styling — Tailwind CSS v4** via `@tailwindcss/vite`, configured with an `@theme`
   block in `src/index.css`. Tokens are **mirrored from `@khoroch/core`** (COLORS,
   RADII, brand shadow): core remains the single source of truth and its `CSS_VARS`
   map 1:1 to the web `--color-*`/`--radius-*` theme entries. Brand guardrails hold:
   emerald `#0E6B50` is the only accent, amounts render in ink (never green/red),
   Bengali text never in Inter, cards use `radius-card` + a single brand shadow, page
   background is ivory.
3. **Language state — zustand + localStorage.** `khoroch.lang` key, default `"bn"`
   (Bengali-first product); values validated with `isLang` on rehydrate. All UI text
   goes through `t(lang, key)` from `@khoroch/core`; bn/en toggles live in the app bar
   (compact) and Settings (segmented row), both `aria-pressed`.
4. **Routing — react-router 7** (declarative mode). react-router v8 is too new and
   unvetted for this cycle. `BrowserRouter` is created exactly once in `main.tsx`;
   components stay router-agnostic so tests can use `MemoryRouter`. `/login` renders
   outside the shell; the other six routes render inside a layout route (`AppShell`);
   unknown paths redirect to `/`.
5. **Shell mirrors the frozen prototype** until feature parity: app bar with logo +
   version chip + compact language toggle, 236 px sidebar ≥1024 px (active item =
   emerald pill with white text), 5-item bottom tab bar <1024 px with
   `env(safe-area-inset-bottom)` padding, and an emerald floating add button
   (`aria-label` = `addExpense`).
6. **Data layer:** `@tanstack/react-query` provider wired with `staleTime: 30s`;
   no queries yet — screens are placeholders carrying a `comingSoon` note.
7. **Testing stack:** Vitest 3 + jsdom + Testing Library (react/dom/jest-dom/
   user-event) with `globals: false` (explicit imports), `tests/setup.ts` loading
   `@testing-library/jest-dom/vitest` and auto-cleanup. Tests always use
   `MemoryRouter`, and reset the lang store/localStorage in `beforeEach` to keep
   bn-default state isolated.

## Consequences

- Token drift between core and web is a manual risk; mitigated by keeping the
  `@theme` block a literal mirror of `COLORS`/`RADII` (a future codegen/test can
  enforce equality).
- Login is visual-only this cycle (demo credentials `demo@khoroch.app` / `demo1234`,
  button navigates to `/`); real auth arrives with the API integration cycle.
- The `budget` route exists in the sidebar but not the mobile tab bar, matching the
  prototype's 5-item tab bar; it remains reachable via sidebar and Settings.
