/**
 * Expense draft autosave (T19.3 — mobile twin of web T19.2).
 *
 * Persists the add-expense manual form so an accidental back-nav or app kill
 * doesn't lose what the user typed. Stored as a small JSON blob in
 * expo-secure-store — the app has no AsyncStorage dependency (cycle-11
 * decision: no new native deps), and the six-string blob is well under
 * SecureStore's per-value limit, mirroring lib/prefs.tsx's approach.
 *
 * Every function is failure-safe: if SecureStore is unavailable, or the stored
 * blob is missing/corrupt/malformed, callers see a no-op / null draft instead
 * of a crash.
 */
import * as SecureStore from "expo-secure-store";

/** Storage key. Matches the web draft's versioned key convention. */
const DRAFT_KEY = "khoroch.expenseDraft.v1";

/** The six manual add-expense form fields, as held in app/add.tsx state. */
export interface ExpenseDraft {
  amount: string;
  cat: string;
  grp: string;
  pay: string;
  iso: string;
  desc: string;
}

/** Shape-validate an unknown parsed value — all six fields must be strings. */
function isExpenseDraft(value: unknown): value is ExpenseDraft {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.amount === "string" &&
    typeof obj.cat === "string" &&
    typeof obj.grp === "string" &&
    typeof obj.pay === "string" &&
    typeof obj.iso === "string" &&
    typeof obj.desc === "string"
  );
}

/** Persist the draft; `null` erases it (form back to empty). */
export async function saveExpenseDraft(d: ExpenseDraft | null): Promise<void> {
  try {
    if (d === null) {
      await SecureStore.deleteItemAsync(DRAFT_KEY);
    } else {
      await SecureStore.setItemAsync(DRAFT_KEY, JSON.stringify(d));
    }
  } catch {
    // SecureStore unavailable → draft stays session-only.
  }
}

/** Stored draft, shape-validated; null when absent, corrupt, or no storage. */
export async function loadExpenseDraft(): Promise<ExpenseDraft | null> {
  try {
    const raw = await SecureStore.getItemAsync(DRAFT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isExpenseDraft(parsed) ? parsed : null;
  } catch {
    // Corrupt blob / SecureStore unavailable → behave as if there is no draft.
    return null;
  }
}

/** Erase the draft — called after any successful expense creation. */
export async function clearExpenseDraft(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(DRAFT_KEY);
  } catch {
    // Storage unavailable → nothing to clear.
  }
}
