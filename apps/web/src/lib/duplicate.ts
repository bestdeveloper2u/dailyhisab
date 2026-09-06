/**
 * T24.1 — Duplicate-add guard (WCAG 2.2 SC 3.3.4, Error Prevention —
 * Legal/Financial/Data): https://www.w3.org/TR/WCAG22/#error-prevention-legal-financial-data
 * requires that financial submissions are reversible, checked, or confirmed.
 * Repeating a voice phrase ("চায়ে ৪০ টাকা") used to save twice silently —
 * these helpers let the UI *check* before saving and demand one explicit
 * confirmation when an incoming expense matches something saved moments
 * earlier (the "checked" mechanism; a confirmed re-add stays one tap away).
 *
 * Matching is deliberately narrow to keep false positives low: same khata
 * (case/whitespace/NFC-insensitive) + same amount (digit-script-insensitive)
 * within a short recency window (DUPLICATE_WINDOW_MINUTES). That catches the
 * accidental repeat said minutes apart, while the second — perfectly real —
 * cup of tea after lunch passes without a peep. The guard never blocks:
 * matches only upgrade an automatic save into an explicit confirmation.
 */

import { apiListExpenses, type Expense, type Lang } from "@khoroch/api-client";
import { normalizeAmountInput } from "./num";

/** How recent a saved expense must be to count as "just added". */
export const DUPLICATE_WINDOW_MINUTES = 30;

export interface DuplicateCandidate {
  amt: string | number;
  cat: string;
  /** Only consulted when a compared row carries no usable created_at. */
  iso?: string | null;
}

export interface DuplicateRow {
  amt: string | number;
  cat: string;
  iso?: string;
  created_at?: string | null;
}

export interface DuplicateScanOptions {
  /** Injectable clock (tests); defaults to now. */
  now?: Date;
  /** Recency window in minutes; defaults to DUPLICATE_WINDOW_MINUTES. */
  windowMinutes?: number;
}

/**
 * Khata identity: Unicode NFC (keyboards compose Bengali conjuncts/vowel
 * signs differently), trimmed, whitespace-collapsed, case-folded — so
 * "চা", "  চা  " and "Tea" all compare equal.
 */
export function canonCat(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Amount as an integer number of poisha: "40" / "40.00" / "৪০" /
 * "৳ 1,200.50" → 4000 / 120050. Rounded to 2dp so decimal-string drift
 * ("0.1" vs "0.10") never splits a duplicate pair. null when unparseable.
 */
export function canonAmt(raw: string | number): number | null {
  const cleaned = normalizeAmountInput(String(raw));
  if (cleaned === "" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Stable (amount, khata) identity for batch-duplicate detection. */
export function dupKey(item: { amt: string | number; cat: string }): string {
  return `${canonAmt(item.amt)}|${canonCat(item.cat)}`;
}

/**
 * Is `row` recent enough to be the expense the user is about to re-add?
 * created_at drives the decision; rows without a parseable created_at
 * (hand-built fixtures, other producers) fall back to same-day equality.
 */
function isRecent(
  row: DuplicateRow,
  candidate: DuplicateCandidate,
  opts: DuplicateScanOptions,
): boolean {
  const now = (opts.now ?? new Date()).getTime();
  const windowMs = (opts.windowMinutes ?? DUPLICATE_WINDOW_MINUTES) * 60_000;
  const created = Date.parse(String(row.created_at ?? ""));
  if (!Number.isNaN(created)) return now - created <= windowMs;
  return row.iso !== undefined && row.iso === candidate.iso;
}

/**
 * Every already-saved row that looks like a re-add of `candidate`, most
 * recent first. Empty array = nothing suspicious.
 */
export function findDuplicateExpenses<R extends DuplicateRow>(
  candidate: DuplicateCandidate,
  rows: readonly R[],
  opts: DuplicateScanOptions = {},
): R[] {
  const amt = canonAmt(candidate.amt);
  const cat = canonCat(candidate.cat);
  if (amt === null || cat === "") return [];
  return rows
    .filter(
      (row) =>
        canonAmt(row.amt) === amt &&
        canonCat(row.cat) === cat &&
        isRecent(row, candidate, opts),
    )
    .sort(
      (a, b) =>
        Date.parse(String(b.created_at ?? "")) - Date.parse(String(a.created_at ?? "")),
    );
}

/**
 * Keys of a batch's internal duplicates: the parser splitting one repeated
 * sentence ("চায়ে ৪০ টাকা… চায়ে ৪০ টাকা") into two identical candidates is
 * the same accidental re-add, just inside a single save. Unparseable items
 * are never flagged (nothing matchable to duplicate).
 */
export function findBatchDuplicateKeys(
  items: readonly { amt: string | number; cat: string }[],
): Set<string> {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const item of items) {
    if (canonAmt(item.amt) === null || canonCat(item.cat) === "") continue;
    const key = dupKey(item);
    if (seen.has(key)) dups.add(key);
    else seen.add(key);
  }
  return dups;
}

/**
 * The save-guard verdict: does ANY candidate duplicate something — a row
 * saved inside the recency window, or its own twin within the batch?
 */
export function itemsHaveDuplicates(
  items: readonly DuplicateCandidate[],
  recentRows: readonly DuplicateRow[],
  opts: DuplicateScanOptions = {},
): boolean {
  const batch = findBatchDuplicateKeys(items);
  return items.some(
    (it) => batch.has(dupKey(it)) || findDuplicateExpenses(it, recentRows, opts).length > 0,
  );
}

/**
 * Saved expense rows for the guard's comparisons — one small indexed
 * day-query per distinct date (usually just today, limit 50/day). Failures
 * degrade to an empty list: the guard is an extra check (fail-open), never
 * a new way for a save to break.
 */
export async function fetchExpensesForDays(
  isos: readonly string[],
  lang: Lang,
): Promise<Expense[]> {
  const days = [...new Set(isos)].slice(0, 5);
  const settled = await Promise.allSettled(
    days.map((iso) => apiListExpenses({ from: iso, to: iso, limit: 50 }, lang)),
  );
  const rows: Expense[] = [];
  for (const out of settled) {
    if (out.status === "fulfilled" && out.value.ok) rows.push(...out.value.data.items);
  }
  return rows;
}
