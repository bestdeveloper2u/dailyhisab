# ADR-0014: Recurring expenses — cursor-idempotent materialization, not a cron ledger

- **Status:** ACCEPTED
- **Date:** 2026-09-05
- **Scope:** `/api/v1/recurring*` (T16.1), migration `0003_recurring_expenses`, table
  `recurring_expenses`
- **Related:** ADR-0004 (data conventions), ADR-0005 (DB portability), ADR-0009
  (the same "express it with the columns we have" instinct), ADR-0012 (backup/restore)

## Context

The backlog asks for recurring expenses ("rent and tuition repeat every month —
don't make me re-type them") without a spec for the two hard parts: how a rule
becomes expense rows, and what happens when the run fires twice. Constraints from
the existing system: one shared `expenses` table (materialized rows must be
indistinguishable from manual ones, because reports/budgets/CSV/backup all read
it), SQLite + PostgreSQL portability (ADR-0005), and no background workers — the
API is the only process (ADR-0010).

## Decision

1. **A rule is a template + a forward-only cursor; no occurrence ledger.**
   Migration 0003 adds one table, `recurring_expenses(id, user_id, cat, grp, amt,
   pay, desc, freq, start_date, next_run, active, created_at, updated_at)` — the
   payload columns mirror `expenses` exactly, so materialization is a
   column-for-column copy (ADR-0004's mechanical mapping survives). `freq` is
   `daily | weekly | monthly | yearly` (DB CHECK; no per-rule interval multiplier
   until an owner asks — "every 2 weeks" is expressible as weekly rules or a
   future migration). `start_date` is the FIRST occurrence and defaults to today.
   **`next_run` is the idempotency cursor**: the earliest occurrence date not yet
   materialized. It is server-owned and only ever moves forward — create sets it
   to `start_date`, the run advances it past today, and PATCH clamps it with
   `max(current, start_date)`. `next_run` never appears in a request body, and a
   client-supplied value is ignored (pydantic drops unknown keys).

2. **Materialization is user-pull (`POST /recurring/run`), not a scheduler.**
   The endpoint scans the caller's active rules with `next_run <= today` and
   inserts one `expenses` row per due occurrence (`iso` = the occurrence date,
   catch-up included), then advances `next_run` past today. Every insert and
   every cursor advance commits in ONE transaction, so a crash rolls back to the
   exact pre-run state — never a half-run. The response reports what THIS run did:
   `{ran_on, created, rules, expenses}`. The client (or a cron hitting the
   endpoint with a token) decides when to pull; the server holds no timers, which
   keeps the self-hosted deploy story unchanged (ADR-0010). Materialized rows
   invalidate the monthly/yearly report cache exactly like manual expense writes.

3. **Idempotency is the cursor, not a dedup table.** Because `next_run` is
   monotonic and advances in the same transaction as the inserts, running the
   endpoint twice in a day is a no-op the second time (`created: 0`) — that is
   the contract, and the tests pin it. An occurrence-log table with a UNIQUE
   constraint would be race-proof under concurrent runs, but adds a table and a
   join for a single-user personal ledger; v1 documents the residual risk (two
   simultaneous runs in separate processes could double-insert) and defers the
   advisory-lock hardening (PG `pg_advisory_xact_lock`) until multi-worker
   deploys exist.

4. **Catch-up is capped, calendar-clamped, and never drops data.** Missed runs
   backfill (a monthly rent rule materializes the 3 missed months on the next
   run), with two guards: occurrence math is pure-stdlib with day clamping
   (Jan 31 monthly → Feb 28; Feb 29 yearly → Feb 28 off-years), and each rule
   materializes at most 120 occurrences per run — the cursor still advances past
   everything computed, so the cap defers work to the next run, it never skips
   occurrences. Pausing (`active: false`) freezes the cursor where it is;
   unpausing resumes from there (a rule paused for a year does not dump a year of
   rent on resume in one giant commit — it walks through in ≤ 120-row chunks).
   Deleting a rule never touches expenses it already produced.

5. **Backup v1 is left alone — deliberately.** ADR-0012's envelope carries
   expenses/debts/budgets; recurring rules are NOT added to it this cycle, and
   restore therefore does not delete them. Reason: older clients still export
   envelope v1 without a `recurring` key; if restore wiped rules, a backup taken
   by an old app would silently destroy the user's rules on restore — a
   data-loss hazard in exchange for no requested feature. Adding rules to the
   envelope is a schema_version 2 change with its own ADR.

## Consequences

- Money stays decimal strings end-to-end; `recurring_expenses.amt` CHECK is
  `amt >= 0` (mirrors `expenses`, not `debts` — a ৳0 template is odd but legal,
  same as a ৳0 expense).
- `POST /recurring/run` is safe to call from any client, any number of times:
  at-least-once triggering yields exactly-once materialization per occurrence.
- The generated client (`openapi.json` 64.9 KB → 81.7 KB) and typed helpers
  (`apiListRecurring`/`apiCreateRecurring`/`apiUpdateRecurring`/
  `apiDeleteRecurring`/`apiRunRecurring`) were regenerated this cycle.
- Known follow-ups (not this cycle): PG advisory lock for multi-worker
  concurrency; envelope v2 for rule backup/restore; per-rule interval multiplier
  and custom weekday/ month-day anchors if owners ask.
