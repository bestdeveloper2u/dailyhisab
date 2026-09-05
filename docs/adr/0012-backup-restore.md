# ADR-0012: Full-fidelity JSON backup and replace-semantics restore

- **Status:** ACCEPTED
- **Date:** 2026-09-05
- **Scope:** `/api/v1/export/backup.json`, `/api/v1/import/restore` (T15.3, cycle 15)
- **Related:** ADR-0004 (data conventions), ADR-0005 (DB portability), ADR-0009 (CSV export, debts/budgets shapes)

## Context

Phase 3 shipped a CSV export of expenses only (ADR-0009). Three gaps remain
for a ledger app where users accumulate years of history:

1. **Data portability is a legal requirement, not a feature.** GDPR Art. 20
   (Right to data portability) obliges a controller to provide a user's
   personal data "in a structured, commonly used and machine-readable
   format" and to transmit it to another controller without hindrance. A
   Bengali household-expense ledger is personal data; a CSV of one table
   (no debts, no budgets) does not satisfy a self-export, and self-hosters
   (ADR-0010) need a file they can move between deployments.
2. **No way back in.** There was no import at all. Any "move my data to a
   new phone/account/server" story needs a restore path that cannot leave
   the ledger half-written.
3. **Which format?** CSV round-trips poorly (no enums validation, no
   nullable clarity, no debts/budgets, quoting hazards). The API already
   has a strict JSON wire contract for every row (ADR-0004), so JSON is the
   only format that can be both exported and re-imported *losslessly*.

## Decision

1. **One JSON envelope, both directions.** `GET /export/backup.json`
   (auth-required) returns the caller's COMPLETE ledger in a single
   document: `schema_version`, `exported_at` (RFC 3339 UTC, `Z`), `counts`,
   and `expenses` / `debts` / `budgets` arrays. Expense and debt rows reuse
   the `ExpenseOut`/`DebtOut` wire shapes verbatim, so the backup IS the
   CRUD wire shape: every column, money as exact 2-decimal-place strings
   (never JSON numbers), timestamps RFC 3339 UTC, nullable `desc`/`note`/
   `settled_at` explicit. Budgets carry their single row (`total`, `cats`,
   `updated_at`) when present. Rows are ordered deterministically
   (`iso ASC, id ASC` — the CSV export's order), so identical data yields
   byte-stable documents modulo `exported_at`. Response is
   `application/json` with an `attachment` Content-Disposition
   (`backup-YYYYMMDD.json`), consistent with the CSV sibling.

2. **Restore is REPLACE, not merge, in v1.** `POST /import/restore` accepts
   the same envelope and, in ONE transaction, deletes the caller's budgets,
   debts and expenses and inserts the uploaded rows. Rationale:
   - Expenses have **no natural dedup key** (no client id, no unique
     business key; `desc`/`cat` are free text). A merge would need
     fuzzy matching → unpredictable duplicates or silent drops.
   - Predictability is the whole point of a restore: after a restore the
     ledger equals the file, exactly — users recovering from a bad state
     (or moving accounts) can reason about the result.
   - Merge/upsert can be layered later as `schema_version: 2` with per-row
     ids as hints; replace-first does not preclude it.

3. **Server re-derives identity; the file is never trusted.** Uploaded rows
   get FRESH primary keys and are stamped with the authenticated user's
   `user_id` — `id`/`user_id` fields present in the file are ignored
   (IDOR-safe: a stolen/edited backup cannot address another account).
   Ledger content is preserved: `created_at` (expenses/debts), `settled_at`
   (debts) and `updated_at` (budgets) are honoured when present so keyset
   ordering and settle status survive a restore. Rows are inserted with a
   fixed, deterministic field order.

4. **`schema_version` gates the envelope.** Version 1 is the only accepted
   value; a document with any other (or missing) version is rejected with
   422 `unsupported_backup_version` before any data is touched. Future
   format changes MUST bump the version and keep the old export endpoint
   able to emit `schema_version: 1` until no client needs it — readers
   never guess.

5. **Validation is manual, errors are house triples.** The restore body is
   validated with the strict pydantic `RestoreIn` model via
   `model_validate` inside the handler (not FastAPI's automatic body
   validation), so every invalid envelope — `schema_version` ≠ 1, negative/
   malformed amounts, bad `cat`/`grp`/`pay`/`dir` enums, malformed ISO
   dates, >1 budgets row — returns 422 with the house
   `{code, message_bn, message_en}` triple (ADR-0004 §7): `unsupported_
   backup_version`, `invalid_backup_row`, or `invalid_backup`. Trade-off:
   the OpenAPI request body is loosely typed (`object`); the response
   (`RestoreOut`) is fully typed, and the client mirrors the envelope via
   the export side.

6. **Limits and transaction integrity.** A restore accepts at most 10,000
   expenses and 10,000 debts (abuse guard) and at most one budgets row
   (the table PK is `user_id` — more cannot exist). The delete+insert runs
   in a single session transaction: any insert failure rolls the deletes
   back, so the ledger is either the old data or the new data, never a mix.
   All three collections default to empty, so a minimal envelope means
   "wipe me" — deliberate v1 REPLACE semantics.

## Consequences

- GDPR Art. 20 self-export is one authenticated GET; the file is also the
  exact input of the restore (roundtrip is field-for-field lossless except
  regenerated `id`s and the target `user_id`).
- Money never touches a float: the backup carries the same decimal strings
  as every other endpoint, and restore re-validates them with the shared
  `AmtStr`/`PositiveAmt` rules — a restored ledger's sums are
  Decimal-identical.
- Restoring into an account destroys its current data by design; the UI
  (future ticket) must double-confirm. The API cannot be made idempotent
  — a second restore re-keys every row.
- The generated client was regenerated; `BackupEnvelope`/`RestoreOut` are
  typed, the restore request body is `object` (see §5).
- If month-keyed budgets or payment ledgers ever land (ADR-0009
  consequences), they join the envelope behind a `schema_version` bump.
