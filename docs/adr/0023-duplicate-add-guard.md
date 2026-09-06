# ADR-0023: Duplicate-add guard — a "checked" mechanism per WCAG 2.2 SC 3.3.4

- Status: ACCEPTED (2026-09-06, cycle 24)
- Deciders: CEO (scope), CTO (merge); researched by PM
- Tags: ux, accessibility, wcag, error-prevention, zero-cost, on-device

## Context

Daily Hisab is voice-first: users repeat short phrases like "চায়ে ৪০ টাকা"
throughout the day. Nothing told them an identical expense was already booked
minutes ago, so accidental double-bookings were silent — the ledger lies until
the monthly report exposes it.

WCAG 2.2 SC 3.3.4 "Error Prevention (Legal, Financial, Data)"
(https://www.w3.org/TR/WCAG22/#error-prevention-legal-financial-data, fetched
200 this cycle) requires that financial submissions are one of: **reversible**
(delete-undo shipped in v0.18.0, ADR-0021), **checked** (input is validated
for errors before proceeding), or **confirmed** (a review+confirm step).
Delete already has its reversible mechanism; CREATE had none.

## Decision

Add a duplicate-add **"checked"** guard on every expense-create surface, web
and mobile (cycle 24):

- **Match rule (deliberately narrow):** same khata (canonicalized: NFC,
  whitespace-collapsed, casefolded) + same amount (2-dp poisha integer,
  Bengali-digit/৳/comma-insensitive) with `created_at` inside a **30-minute
  window** of an existing row for the same date (same-iso fallback for rows
  without a parseable created_at). A second real cup of tea hours later never
  warns; an accidental instant re-submit always does. Voice batches also flag
  twins inside the batch itself.
- **Manual form (web ExpenseForm + mobile add.tsx):** first submit with a
  match does NOT create — inline warning shows the existing row, the submit
  button becomes "তবুও যোগ করুন / Add anyway"; the create goes through only on
  that explicit second submit. Editing amount/khata/date re-arms the guard, so
  a stale confirmation can never bless different values. Edit mode is never
  guarded (that row is being changed on purpose).
- **Voice overlay (web VoiceOverlay + mobile confirm sheet):** parsed
  candidates are compared against the same days' saved rows before any save;
  a confident parse that repeats a recent expense parks at review with an
  "আগেই আছে" badge and the save button relabeled "তবুও সংরক্ষণ করুন (n)".
  Clean confident parses keep the existing one-tap auto-save; share-target
  intake keeps its mandatory review (T23.2 rule).
- **Fail-open:** the guard's day-query (`GET /expenses?from=&to=`, limit 50,
  ≤5 days) degrades to "no check" on any failure. The guard must never become
  a new failure mode for saving.
- **On-device, zero AI cost:** pure client logic (canonicalization + list
  fetch); no parser/model calls, per the standing zero-AI-cost requirement.

## Consequences

- Accidental double-bookings now cost one explicit confirm instead of a silent
  duplicate row.
- The 30-minute window is a heuristic; cross-day genuine repeats (rent) are
  intentionally NOT flagged — blocking legitimate entries would be worse.
- Server-side `_extract_amount` was found to square হাজার ("আট হাজার" →
  1,000,000) during this cycle's number-word parity work; fixed in the same
  cycle (multiplier-only semantics, matching the on-device parsers) with a
  regression test — a spoken "N হাজার" can no longer 1000×-overbook.
