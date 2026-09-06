# ADR-0020: Debt and budget voice parsing runs on-device (regex), not via /voice/parse

- Status: ACCEPTED (2026-09-06, cycle 21)
- Deciders: CTO (T21.1/T21.2)
- Tags: voice, debts, budgets, on-device, zero-cost

## Context

The frozen prototype's mic FAB is context-aware (`fabMode()` @1374): on the
expenses screen it books expenses, on the debts ledger it parses a debt
sentence ("করিমকে ৫০০ টাকা ধার দিলাম, বাজারের বাকি"), and on the budget
screen it parses "এই মাসের বাজেট ২৫০০০ টাকা". The web app's expense voice
flow calls `POST /voice/parse` (server-side rule-based Bengali parser,
ADR-0004). Debt and budget sentences are structurally simpler than expense
sentences: exactly one party, one direction, one amount, optional note
(debt); one amount (budget).

## Decision

Debt and budget voice parsing run **on-device** as pure regex helpers
(`apps/web/src/lib/parseDebt.ts`: `parseDebtText`, `parseBudgetAmount`).
The parsed result is ALWAYS shown in an editable review card before any
write (wrong money direction is worse than one extra tap), so parser
precision requirements are modest. Expense voice keeps using
`POST /voice/parse` — its number-words/category-keyword logic is genuinely
server-worthy and already battle-tested.

## Consequences

- Zero server cost, zero latency, works offline once the shell is precached
  (PWA) for these two flows.
- Parser bugs are client bugs — covered by 15 vitest cases including two
  production-class regressions found in review: the glued-suffix regex
  matching inside the word "থেকে" itself (spaced-party pattern must be tried
  FIRST), and thousands-commas ("1,250") leaking into the note field
  (normalize `(\d),(\d{3})(?!\d)` before amount AND note extraction).
- If debt sentences ever need party-name intelligence (fuzzy matching
  against the user's contacts), the on-device parser can be replaced by an
  API endpoint without changing the overlay's review-card UX.
