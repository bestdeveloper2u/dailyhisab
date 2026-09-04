# ADR-0005: Database portability (GUID type, SQLite tests, UUID defaults, money & JSON types)

- **Status:** ACCEPTED
- **Date:** 2026-09-04
- **Deciders:** backend agent (this cycle), per ARCHITECTURE.md §1/§4

## Context

The API targets Supabase managed PostgreSQL in production, but unit tests and
this cycle's local environment must run without any external services (the
local Docker daemon is DOWN, so postgres:17 from docker-compose is unavailable
this cycle). SQLAlchemy models must therefore be portable across PostgreSQL
and SQLite while keeping the DB column names from
`deploy/supabase-schema.sql` (`cat`, `grp`, `amt`, `pay`, `desc`, `iso`) —
ADR-0004 already fixed that API JSON mirrors DB columns.

## Decision

1. **Portable GUID type** — `app/db/types.py:GUID` (TypeDecorator): native
   `UUID` on `postgresql`, `CHAR(36)` elsewhere; `process_result_value`
   always returns `uuid.UUID`, so model attribute types are identical on both
   backends. Alembic migrations use the generic `sa.Uuid()` type, which
   renders the same pair of physical types.
2. **SQLite for unit tests + local alembic verification this cycle.** pytest
   uses in-memory SQLite via `aiosqlite` + `StaticPool`; the handwritten
   migration `alembic/versions/0001_initial.py` is verified with
   `upgrade head` / `downgrade base` on SQLite. Postgres verification is
   deferred until Docker is available (only the dialect-specific physical
   types differ, and they are exercised via `with_variant`/`GUID`).
3. **Python-side `uuid4` defaults** instead of `gen_random_uuid()`:
   `gen_random_uuid()` is PostgreSQL 13+ only and has no SQLite equivalent,
   while a Python `default=uuid.uuid4` works everywhere, gives us IDs before
   flush (useful for cursor pagination headers), and avoids a DB extension
   dependency. Portability outweighs the negligible in-DB generation benefit.
4. **`desc` → `description` attribute mapping.** `desc` is a SQL keyword; the
   ORM attribute is `description` mapped via `mapped_column("desc", Text)`.
   SQL keeps column name `desc`; serialization can keep the JSON key `desc`
   per ADR-0004.
5. **Money is `Numeric(12, 2)`** (mapped to `decimal.Decimal`), matching the
   architecture decision "numeric(12,2) strings — no integer paisa".
   CheckConstraints: `expenses.amt >= 0`, `debts.amt > 0`.
6. **`budgets.cats` is JSON with a JSONB variant** (`JSONVariant`
   TypeDecorator: `JSONB` on postgresql, `JSON` on SQLite). Schema stays a
   `{"food": 8000, ...}` mapping on both backends.
7. **Server defaults chosen portably:** `CURRENT_TIMESTAMP` (instead of
   `now()`) and `CURRENT_DATE` work on both SQLite and PostgreSQL; string
   defaults (`'ডেমো ব্যবহারকারী'`, `'bn'`, `'light'`, `'cash'`, `'20000'`,
   `'{}'`) are plain literals, also portable.
8. **Deterministic naming convention** (`app/db/base.py`):
   `ix/uq/ck/fk/pk` templates, so Alembic output is identical across engines
   and constraint names are stable (`ck_expenses_amt_nonneg`,
   `fk_expenses_user_id_profiles`, ...).

## Consequences

- Tests run hermetically (no Docker, no network); CI needs no services.
- `CHECK (lang IN ('bn','en'))` etc. are enforced by SQLite just like
  PostgreSQL; only RLS is absent by design (auth lives at the API layer).
- When Postgres verification happens (Docker back up), run the same
  `upgrade head` / `downgrade base` gates against
  `postgresql+asyncpg://...`; no code changes expected — the dialect branches
  are already implemented.
- `DateTime(timezone=True)` is best-effort on SQLite (no native tz type);
  tz-aware values are normalized at the API/Pydantic boundary, production
  Postgres stores true `timestamptz`.
