import type { Lang } from "@khoroch/core";

/**
 * T19.2 — expense draft autosave. The add-expense form (create mode only)
 * persists its half-filled fields to localStorage so an accidental close
 * (backdrop tap, swipe, tab restore) never loses typing. Best-effort by
 * design: quota/privacy failures are silent no-ops and a corrupt or
 * wrong-shaped payload loads as null.
 */

export interface ExpenseDraft {
  amt: string;
  cat: string;
  grp: string;
  pay: string;
  iso: string;
  desc: string;
}

export const EXPENSE_DRAFT_KEY = "khoroch.expenseDraft.v1";

/** Restore toast copy (mirrors the bn-first dict pattern in web-i18n.ts). */
export const DRAFT_RESTORED_MSG: Record<Lang, string> = {
  bn: "অসম্পূর্ণ খরচের খসড়া পুনরুদ্ধার হয়েছে",
  en: "Restored your unfinished expense draft",
};

const DRAFT_FIELDS = ["amt", "cat", "grp", "pay", "iso", "desc"] as const;

/** All 6 string fields present — anything else loads as null. */
function isExpenseDraft(value: unknown): value is ExpenseDraft {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return DRAFT_FIELDS.every((field) => typeof record[field] === "string");
}

/** Persist the draft; `null` removes it. Storage errors are swallowed. */
export function saveExpenseDraft(draft: ExpenseDraft | null): void {
  try {
    if (draft === null) {
      window.localStorage.removeItem(EXPENSE_DRAFT_KEY);
      return;
    }
    window.localStorage.setItem(EXPENSE_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Private mode / quota exceeded — the draft is best-effort only.
  }
}

/** Load the draft, or null when absent / corrupt / wrong-shaped. */
export function loadExpenseDraft(): ExpenseDraft | null {
  try {
    const raw = window.localStorage.getItem(EXPENSE_DRAFT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isExpenseDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Drop the draft (after a successful create, or an all-empty close). */
export function clearExpenseDraft(): void {
  saveExpenseDraft(null);
}
