# ADR-0001: Stack pins (language runtimes, framework majors, backing services)

- **Status:** ACCEPTED
- **Date:** 2026-09-04
- **Scope:** all of `app/` (`apps/api`, `apps/web`, `apps/mobile`, `packages/*`) plus the
  backing services they talk to (Supabase Postgres, Valkey)
- **Related:** ADR-0002 (auth crypto/stack pins), ADR-0003 (pnpm workspace tooling pins),
  ADR-0005 (DB portability), docs/ARCHITECTURE.md §1

## Context

docs/ARCHITECTURE.md §1 fixes the layers (Python API, SQLAlchemy 2 async + Alembic,
custom JWT auth, Valkey cache, React 19 web, Expo mobile, pnpm monorepo) and says the
team pins exact versions in `pyproject.toml` / `package.json`. This ADR is that pin
record. The constraints that shaped it:

1. **Stability over novelty** — solo project, no device farm, no staging environment;
   every major-version jump must buy something concrete.
2. **Latest stable at decision time (2026-09)** — the product owner asked for "latest
   stable Python", which we read as *latest stable line*, not bleeding-edge RCs.
3. **The host Docker daemon is DOWN this cycle** (see ADR-0005), so local dev and tests
   must run without Postgres/Valkey containers — but the pins must be chosen so nothing
   has to change when containers come back.
4. Reproducibility lives in lockfiles: `uv.lock` (API) and `pnpm-lock.yaml` (JS) are the
   exact-version source of truth; manifests carry deliberate floors/pins.

## Decision

### 1. Python 3.13 for the API

`apps/api/pyproject.toml` declares `requires-python = ">=3.13"`; `ruff`
`target-version = "py313"`, `mypy` `python_version = "3.13"`, and CI installs
Python 3.13 via `astral-sh/setup-uv@v5`. 3.13 is the latest stable CPython line; we do
not use the free-threaded build. Rationale: the product owner's constraint
("latest stable") plus `uv` making per-project interpreters cheap.

### 2. API framework set: FastAPI + Pydantic v2 + Uvicorn[standard]; SQLAlchemy 2.0 async + Alembic

- **FastAPI** — async, Pydantic v2 native, OpenAPI auto-docs which feed
  `pnpm generate:client` (ADR-0003 §4).
- **SQLAlchemy 2.0 async** with two drivers: `asyncpg` for production
  (`postgresql+asyncpg://…` → Supabase Postgres), `aiosqlite` for tests/local
  (ADR-0005). `greenlet` is a declared dependency because SQLAlchemy's async mode
  requires it.
- **Alembic** owns the schema; `deploy/supabase-schema.sql` stays as the column-name
  reference, not a parallel migration path.

### 3. Node 22 everywhere JavaScript runs

Root `package.json` sets `engines: { "node": ">=22" }`; CI uses
`actions/setup-node@v4` with `node-version: 22`. Node 22 is the active LTS line and
satisfies Vite 6, Vitest 3, ESLint 9 and Expo SDK 54 tooling simultaneously.

### 4. pnpm 10.34.5 via `packageManager`

Pinned in the root `package.json`, enforced by corepack shims locally and
`pnpm/action-setup@v4` in CI. The workspace mechanics (hoisted linker, raw-TS packages)
are ADR-0003's subject; here it is pinned as the only package manager.

### 5. Web majors (rationale detail in ADR-0006)

React 19 (`^19.2.8`), Vite 6 (`^6.3.5`) + Vitest 3 (matched majors), Tailwind CSS v4
(via `@tailwindcss/vite` — no postcss config chain), react-router 7 (declarative mode),
TanStack Query 5, zustand 5. Each is the current major that the neighbouring tools are
tested against; none has a successor that pays for itself here yet.

### 6. Mobile: Expo SDK 54 / React Native 0.81.6 / React 19.1

Pinned in `apps/mobile/package.json` (`expo ~54.0.0`, `react-native 0.81.6`,
`react 19.1.0`, expo-router ~6). SDK upgrades move the entire native graph, so they
only happen via `npx expo install --fix` in a dedicated PR (ADR-0003 §5). No emulator
exists in this environment; the mobile gate is `tsc --noEmit`.

### 7. Supabase is managed Postgres only; Valkey 7.2 for cache/queue

- **Supabase Postgres** (Postgres 17 line) is the production database. Supabase Auth is
  **not** used — constraint #4 in docs/ARCHITECTURE.md; auth is ours (ADR-0002). RLS is
  dropped in favour of API-layer authorization (ARCHITECTURE §4, ADR-0005).
- **Valkey 7.2** (`valkey/valkey:7.2-alpine` in `docker-compose.yml`, tag verified
  against Docker Hub 2026-09-04) is the cache/queue layer — monthly-aggregate cache,
  rate limiting, and the refresh-token/session store (ADR-0002). It is Redis-compatible
  (RESP), so the API speaks to it with the standard `redis-py` asyncio client; prod
  targets any managed Valkey/Redis-compatible endpoint.

## Consequences

- Upgrading any pinned major is a deliberate, dedicated PR with gates green — not a
  drive-by dependabot merge.
- When the Docker daemon returns, `docker-compose.yml` already pins the service
  versions (postgres:17, valkey:7.2); no pin changes are expected, only first use.
- The manifests' floors (`^`/`~`) plus lockfiles mean CI and local installs are
  reproducible today; floors only widen on an intentional upgrade PR.
- docs/ARCHITECTURE.md §1's pointer to "records them in ADR-0002" predates the final
  ADR numbering; this ADR (0001) is the stack-pin record, ADR-0002 carries the auth
  decisions and its own crypto pins.
