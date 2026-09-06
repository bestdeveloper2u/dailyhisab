# ADR-0021 — Delete-undo toast instead of confirm dialogs for expense rows

Date: 2026-09-06
Status: Accepted
Deciders: dev team (Track A + CTO), owner order: team decides via ADRs

## Context

Deleting an expense row on web previously used a two-step arm → "নিশ্চিত মুছুন"
inline confirm (the pattern the frozen prototype's `showConfirm` popularized).
NN/g ("Confirmation Dialogs Can Prevent User Errors — If Not Overused",
https://www.nngroup.com/articles/confirmation-dialog/, fetched 200 in cycle 21)
shows that confirm dialogs on frequent actions become reflex-taps: users click
through them without reading, so they add friction without preventing errors.
The recommended pattern for destructive-but-recoverable actions is an undo
window — act immediately, offer UNDO in an aria-live toast.

An expense delete IS recoverable by design: the row is a plain resource and the
client holds the full pre-delete payload (amt decimal string, cat, grp, pay,
iso, desc), so UNDO = one POST with the identical body.

## Decision

1. Expense row delete on web = single tap → DELETE → toast "মোছা হয়েছে" with a
   "ফিরিয়ে আনুন" action for ~6s (`toastWithAction`, `ACTION_TOAST_DURATION`).
   UNDO re-creates the payload-exact row and invalidates the list queries.
2. Failure paths stay explicit: delete failure → "মোছা যায়নি" toast, row stays
   (the `remove` mutation now throws on `!ok` so onError is reachable — found by
   test, fixed this cycle); undo failure → "ফিরিয়ে আনা যায়নি".
3. Debts pay/close and Recurring rule deletes KEEP their two-step confirms:
   those are bookkeeping mutations with side effects (settled_at, materialized
   expenses) where a silent "undo by re-creating" would NOT reproduce the prior
   state — the destructive-irreversible class.
4. CSV import failures are never toasted with the ✓ success glyph
   (audit/t22x_audit.md P3-1): full failure → "আমদানি ব্যর্থ", partial →
   "⚠ N আমদানি হয়েছে — M টি বাকি" with a duplicate warning.

## Consequences

- Faster list hygiene; errors surface in the toast instead of a modal hop.
- Undo depends on the create endpoint accepting the exact payload — decimal
  strings are preserved (vitest asserts the POST body with toEqual).
- Action toasts live 6s (vs 2.6s plain) — long enough to read bn text + tap.
- The undo window is client-side only; after it lapses the row is gone from the
  server (no trash/bin). Data-safety guarantees remain backup.json/CSV
  (ADR-0012), not undo.

## References

- audit/t22x_audit.md (CSV import audit, same cycle)
- NN/g confirmation-dialog article (cited cycle 21)
- apps/web/src/lib/toast.ts (toastWithAction), screens/Expenses.tsx
