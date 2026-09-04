# ADR-0009: Debts pay close-out, single-row budgets, and CSV export shape

- **Status:** ACCEPTED
- **Date:** 2026-09-04
- **Scope:** `/api/v1/debts*`, `/api/v1/budgets*`, `/api/v1/export/expenses.csv` (Phase 3, cycle 6)
- **Related:** ADR-0004 (data conventions), ADR-0005 (DB portability), docs/ARCHITECTURE.md §3/§4

## Context

Phase 3 adds debts, budgets, and export on top of migration 0001's tables. Three
questions were open after reading the spec against the actual schema:

1. `debts` has no `paid`/`due` columns — how does "pay back" close a debt
   (PARTIAL vs FULL) without a migration?
2. `budgets` PK is `user_id` alone — there is **no month dimension** in the table,
   while the backlog said "GET/PUT per month+group".
3. ARCHITECTURE §3 sketches `GET /export.csv` without a version prefix or format
   details (encoding, quoting, headers).

## Decision

1. **Pay close-out is expressed with the existing columns; no migration.**
   `POST /debts/{id}/pay {amt}` where `amt` is an ADR-0004 decimal string > 0:
   - `amt >= debt.amt` → **FULL**: `settled_at = now(UTC)`, `amt` unchanged
     (history preserved; "settled" is a status, not a zero balance).
   - `0 < amt < debt.amt` → **PARTIAL**: `amt -= paid` (the row carries the
     remaining outstanding amount), `settled_at` stays `null`.
   - Paying an already-settled debt → **409** `{code: "debt_already_settled",
     message_bn, message_en}`; paying ≤ 0 / malformed → 422; foreign/unknown id →
     user-scoped 404 (same IDOR posture as expenses).
   Individual field edits remain available via `PATCH /debts/{id}`. Rationale:
   the prototype models debts exactly as (party, dir, remaining amount, settled
   flag); adding payment-ledger tables would be speculative until an owner asks
   for per-installment history.
2. **Budgets are single-row per user ("my monthly budget"), months are a query
   parameter, not storage.** `PUT /budgets {total?, cats?}` upserts the one row
   (default `total` 20000.00, `cats` {}); `GET /budgets?ym=YYYY-MM` returns the
   stored budget **plus server-computed usage for that month** from `expenses`:
   `spent`, `usage_pct`, and `by_cat` as the **union** of budgeted categories and
   categories actually spent on (unbudgeted cats show `budget: "0.00"`, so the
   client can flag overspending everywhere). A missing row is not an error — the
   defaults are returned. No new migration. Rationale: the prototype's budget
   screen is a single monthly limit + per-category limits; month-keyed budget
   rows would need a migration + ADR if ever requested.
3. **Export is `GET /api/v1/export/expenses.csv`** (not the spec sketch
   `/export.csv`): versioned prefix like every other route, resource-typed path
   leaves room for future formats. Format: `text/csv; charset=utf-8` streaming
   response (keyset batches of 500, never one giant string), **UTF-8 BOM**
   (`EF BB BF`) so Excel opens Bengali text correctly, **RFC 4180** quoting
   (CRLF rows, doubled quotes), Bengali header row
   `তারিখ,বিবরণ,গ্রুপ,খাত,পরিমাণ (৳),পেমেন্ট` matching the prototype i18n,
   `Content-Disposition: attachment; filename="expenses-YYYYMMDD.csv"`, rows
   ordered `(iso, id)`, always the current user only; `from > to` → 422
   `invalid_date_range`; empty range → header-only file.

## Consequences

- Money stays decimal strings end-to-end (ADR-0004); `usage_pct` is a JSON
  number (a ratio, not money) rounded server-side.
- Pay close-out is idempotent-safe: a second FULL/any pay after settlement is a
  409, never a silent double-subtract.
- The generated client + `@khoroch/core` mirrors were regenerated for the new
  routes (`openapi.json` 35.1 KB → 56.2 KB).
- If the owner later wants month-keyed budgets or payment history, that is a
  migration + a new ADR — the API shapes here don't preclude it.
