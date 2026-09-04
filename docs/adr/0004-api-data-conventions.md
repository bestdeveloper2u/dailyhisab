# ADR-0004: API data conventions (money as strings, JSON mirrors DB columns)

- **Status:** ACCEPTED
- **Date:** 2026-09-04
- **Scope:** all `/api/v1` request/response bodies — FastAPI schemas in `apps/api`,
  mirrored by `@khoroch/core` types and the generated `@khoroch/api-client`
- **Related:** ADR-0002 (auth error codes in the envelope), ADR-0005 (DB column names
  and physical types), ADR-0003 §4 (client generation), docs/ARCHITECTURE.md §3/§4

## Context

1. The API is the only DB client: ARCHITECTURE §4 drops RLS and makes the FastAPI
   service the sole writer/reader of Supabase Postgres. There is no second consumer
   that would justify a translation layer between rows and JSON.
2. The DB already has terse, stable column names — `expenses(cat, grp, amt, pay, desc,
   iso)`, `debts(party, dir, amt, note, iso)`, `budgets(total, cats)` — fixed in
   `deploy/supabase-schema.sql` and mirrored by the SQLAlchemy models (ADR-0005, and
   the docstring in `app/apps/api/app/models/expense.py`).
3. JSON numbers are IEEE-754 doubles. Taka amounts in that type invite float drift
   (`0.1 + 0.2` problems, silent precision loss after round-trips through JS), and an
   integer-paisa encoding was explicitly rejected (ARCHITECTURE §3: "money as integer
   paisa? NO — numeric(12,2) strings").
4. `@khoroch/core` hand-mirrors the API types this cycle (`src/types.ts`,
   `src/money.ts`), and `pnpm generate:client` regenerates `@khoroch/api-client` from
   OpenAPI — both consumers break if the wire shape drifts.

## Decision

1. **Money is a decimal STRING at the API edge — never a JSON number, never integer
   paisa.** `amt: "890.00"`, `budgets.total: "20000.00"`. Serialization: `Decimal`
   quantized to exactly 2 places (`str(...)`), matching the `numeric(12,2)` column;
   parsing: `Decimal(value)` from a string, rejecting > 2 decimal places, with the
   domain checks already in the DB (`amt >= 0` for expenses/budgets, `amt > 0` for
   debts). Response models declare amounts as `str` (or a `Money` alias with a field
   serializer) so OpenAPI types them `{type: string}` and no client ever sees a number.
   Any `Number` in TS code is presentation-only (`moneyToNumber` in `@khoroch/core`
   feeds grouping/formatting, never a payload).
2. **Currency: single-currency product (BDT/৳), no currency field in v1 payloads.**
   Amounts are unitless decimal strings in taka; if multi-currency ever arrives it gets
   its own ADR and a new column. Note deliberately: the column named **`iso` is the
   event date (`date`, `YYYY-MM-DD`), not a currency code** — see
   `deploy/supabase-schema.sql` and `models/expense.py`.
3. **JSON field names mirror DB column names exactly** — `cat`, `grp`, `amt`, `pay`,
   `desc`, `iso`, `party`, `dir`, `total`, `cats`. No camelCase translation: no
   `createdAt`, no `categoryId`. Pydantic aliases keep payloads at column names
   (`desc` stays `desc` even though the Python attribute is `description`, per
   ADR-0005 §4). Rationale: rows ↔ models ↔ schemas ↔ TS types stay a 1:1 mechanical
   mapping, so the hand-mirrored `@khoroch/core` types and the generated client can
   never disagree about key names.
4. **Timestamps are RFC 3339 UTC strings** with `Z` — `created_at: "2026-09-04T09:30:00Z"`
   (`updated_at`, `settled_at` likewise). Pydantic normalizes tz-aware values to UTC at
   the boundary; date-only fields (`iso`) are plain `"YYYY-MM-DD"`. Bengali/localized
   rendering happens client-side only (ARCHITECTURE §3: "bn dates via ISO + client
   format").
5. **UUIDs are lowercase canonical strings.** `id`, `user_id` serialize as 36-char
   hyphenated strings; clients treat them as opaque (`id: string` in `@khoroch/core`).
   IDs are client-visible before flush (Python-side `uuid4` defaults, ADR-0005 §3).
6. **Nullable fields serialize explicitly as `null`** (`desc: null`), never omitted
   keys, in responses. In create/update payloads, omitted optional fields mean "use
   the default / null" — matching `@khoroch/core`'s `ExpenseCreate`/`DebtCreate`
   optionality.
7. **Errors use FastAPI's default envelope: every non-2xx body has a top-level
   `detail` key** — no custom exception handler rewrites the shape. Domain errors
   carry the localized triple as the value of `detail`:
   `{"detail": {"code": "auth_invalid_credentials", "message_bn": "...",
   "message_en": "..."}}` — this is the `{code, message_bn, message_en}` object from
   ARCHITECTURE §3 and the `ApiError` type in `@khoroch/core`. FastAPI's automatic
   422 validation errors keep their native `{"detail": [...]}` array form. Rationale:
   keeping the default envelope preserves the OpenAPI-documented error contract and
   gives clients one uniform extraction path (`body.detail`).
8. **List endpoints return `{"items": [...], "next_cursor": string | null}`**, filtered
   by `?from=&to=&q=` and page-limited by `?limit=&cursor=` (ARCHITECTURE §3); cursors
   are opaque strings derived from the last-seen `id`, never exposed internals.

## Consequences

- `@khoroch/core` types and the generated api-client stay mechanically aligned with the
  DB; regenerating after any schema change (`pnpm generate:client`) is the sync point.
- String money keeps `Decimal` fidelity end-to-end; the cost is that every client must
  parse before arithmetic — acceptable, and already isolated in `money.ts`.
- Column names are now wire contract: renaming a DB column is a breaking API change and
  needs an ADR + client regeneration, not just a migration.
- Auth errors (ADR-0002) plug into decision 7 without their own envelope rules.
