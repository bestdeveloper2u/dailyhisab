# ADR-0015: Prototype Google-Sheet sync is superseded by backend storage

- **Status:** ACCEPTED
- **Date:** 2026-09-05
- **Scope:** product-level parity ruling (standing research rule, cycle 16); no code change by itself
- **Related:** ADR-0004 (data conventions), ADR-0009 (CSV export), ADR-0012 (backup.json / restore), ARCHITECTURE.md §0

## Context

The frozen prototype (www/index.html) presents the product as a spreadsheet:
dashboard chip "গুগল শিটে সিঙ্ক ✓" (@670), settings row "দৈনিক খরচের হিসাব ২০২৬ —
সংযুক্ত · প্রতিটি খরচ A–G কলামে সিঙ্ক হয়" (@857–860), toggle "গুগল শিটে অটো-সিঙ্ক চালু"
(@677), and the marketing bullet "আপনার গুগল শিটে অটো-সিঙ্ক" (@525).

That made sense pre-backend: the prototype had no server, so a Google Sheet *was*
the storage engine. The real product (ARCHITECTURE §0) instead has Supabase
Postgres behind a FastAPI API with JWT auth, multi-user isolation, and reports.

The cycle-16 prototype diff therefore records one deliberate divergence, not a
P0 gap: a Google-Sheet OAuth integration would add an external identity/SaaS
dependency for storage the backend already owns, cannot be made multi-user-safe
in the current auth model without a per-user Google token vault, and duplicates
every export path we already ship.

## Decision

1. We do NOT implement Google-Sheet auto-sync. The prototype's sheet metaphor is
   declared superseded by real backend storage.
2. The user-facing *substance* of that row — "my data is safe and mine to take" —
   is delivered by:
   - expenses CSV export (ADR-0009, v0.6.0),
   - full-fidelity `GET /export/backup.json` + `POST /import/restore`
     (ADR-0012, v0.12.0 API).
3. The remaining actionable parity gap is UI adoption of ADR-0012 in the web
   Settings screen (backup download + restore upload) — queued as T16.4
   (cycle 16) so the Settings screen offers a visible "data safety" surface
   where the prototype showed its sheet row.
4. BN copy uses the ledger vocabulary (হিসাব, ব্যাকআপ, রিস্টোর), not sheet
   vocabulary, in all new strings.

## Consequences

- Prototype diff reports sheet-sync rows as "superseded (this ADR)", not "missing".
- No Google OAuth client, no token storage, no third-party SaaS dependency.
- If the owner later wants sheet-shaped output for spreadsheet-savvy users, the
  right shape is an export format (e.g. a sheet-ready XLSX/CSV layout), not a
  live sync — new ADR required.
