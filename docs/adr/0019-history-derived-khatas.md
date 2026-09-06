# ADR-0019: Khatas are derived from expense history, not stored

- Status: ACCEPTED (2026-09-06, cycle 20)
- Deciders: CTO (T20.1)
- Tags: expenses, khatas, api, window-functions

## Context

The expense form's category picker needs a khata list. The prototype's
settings khataList card labels it "আপনার শিট থেকে" — from the user's own
data — so the product intent was always *your khatas are the categories you
actually spend under*, never a curated taxonomy served to everyone.

Two shapes could satisfy that:

1. **Derived** — compute the list on demand from the `expenses` rows the
   user already has (`SELECT DISTINCT cat`, plus context for the picker).
2. **Stored** — a `custom_categories` table the user curates, referenced
   (loosely or by FK) from `expenses.cat`.

The stored shape buys ordering/pre-created defaults at the cost of a new
table, a migration, CRUD for category management, and a sync problem: every
expense already carries its `cat`, so the table would forever duplicate
state that history already answers. The picker is also the only consumer —
reports and budgets group by the per-row `grp` column, not by any category
entity.

## Decision

Khatas are **derived** from expense history. `GET /api/v1/expenses/categories`
returns one row per distinct `cat` in the caller's own expenses, computed in
a single window-function pass (portable across SQLite and Postgres — no
`DISTINCT ON`):

- `ROW_NUMBER() OVER (PARTITION BY cat ORDER BY iso DESC, created_at DESC,
  id DESC) = 1` picks each khata's most recent expense, supplying `grp` and
  `last_used` for form prefill;
- `COUNT(*) OVER (PARTITION BY cat)` supplies `use_count`.

Ordering is most-used → most-recent → cat (deterministic; `id` breaks
iso+created_at ties, which matter because `created_at` has second precision
on SQLite). The response uses the ADR-0004 §8 `{items, next_cursor}`
envelope with `next_cursor` always `null` — a khata set is bounded by the
user's own distinct cats, so it is picker-sized and unpaginated.

Deliberate carve-outs:

- **No `custom_categories` table, no migration** — `expenses.cat` stays a
  free `Text` column; deleting or patching expenses legitimately reshapes
  the khata list, because the list *is* the history.
- **`grp` on a khata is prefill only** — report (`/reports/*`) and budget
  rollups keep grouping each expense row by its own `grp`; a khata's `grp`
  is just the group of its latest expense and never feeds aggregation.
- **Per-user scoping as everywhere else** — the query filters on the
  authenticated `user_id`; one user's khatas are never visible to another.

## Consequences

- The picker always reflects reality (typos included). Renaming a khata is
  "new expenses under the new name"; there is no rename operation — the
  old name fades as its history ages out of recency ordering.
- Adding the endpoint changed no schema: OpenAPI grew one GET path + two
  response schemas, and the api-client regen is additive-only.
- Empty history yields an empty picker; the expense form must keep its own
  free-text input so a first expense (and any new khata) can be typed —
  the picker is a shortcut, not a gate.
- Revisit only if pre-created khatas are ever genuinely needed (e.g.
  onboarding defaults for brand-new users, per-khata metadata like icons
  or budgets). That is a new ADR + migration; this endpoint's shape
  (`KhataOut`) can absorb an optional source flag then.

## References

- Prototype settings khataList card ("আপনার শিট থেকে") — www/index.html
- ADR-0004 §8 (list envelope), ADR-0005 (column names/portability)
- apps/api/app/routers/expenses.py (`list_khata_categories`),
  apps/api/app/schemas/expense.py (`KhataOut`, `KhataListOut`),
  apps/api/tests/test_expenses.py (categories tests)
