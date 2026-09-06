import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";

/**
 * T19.2 — expense draft autosave: storage contract of lib/draft.ts plus the
 * ExpenseForm create-mode integration (restore-on-open + toast, debounced
 * save, clear-on-submit/close, and edit-mode total silence). The queries
 * module is mocked so no network/react-query plumbing is involved.
 */

import {
  clearExpenseDraft,
  DRAFT_RESTORED_MSG,
  EXPENSE_DRAFT_KEY,
  loadExpenseDraft,
  saveExpenseDraft,
  type ExpenseDraft,
} from "./draft";
import { subscribeToasts } from "./toast";
import { useLangStore } from "../store/lang";
import { ExpenseForm } from "../components/ExpenseForm";
import type { Expense } from "@khoroch/api-client";

const { createMock, updateMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../lib/queries", () => ({
  useExpenseMutations: () => ({
    create: { isPending: false, mutateAsync: createMock },
    update: { isPending: false, mutateAsync: updateMock },
  }),
  // T20.4: the form also consumes the khata-categories query now; these
  // tests never exercise suggestions, so hand back a settled empty list.
  useKhataCategories: () => ({
    data: { ok: true as const, data: { items: [], next_cursor: null } },
  }),
}));

const DRAFT: ExpenseDraft = {
  amt: "250",
  cat: "খাবার",
  grp: "food",
  pay: "cash",
  iso: "2026-09-06",
  desc: "চা",
};

/** Edit-mode fixture (ExpenseOut shape). */
const EDIT_EXPENSE = {
  id: "e1",
  amt: "420.00",
  cat: "মাছ",
  grp: "food",
  pay: "cash",
  iso: "2026-09-05",
  desc: null,
  created_at: "2026-09-05T10:00:00Z",
  user_id: "u1",
} as Expense;

/** Toast capture via the imperative module's listener channel. */
let texts: string[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  texts = [];
  unsubscribe = subscribeToasts((state) => {
    if (state) texts.push(state.text);
  });
  useLangStore.setState({ lang: "bn" });
  createMock.mockReset();
  updateMock.mockReset();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  vi.restoreAllMocks(); // Storage.prototype spies must not leak into zustand persist
  vi.useRealTimers();
});

describe("expense draft storage (lib/draft.ts)", () => {
  it("round-trips save → load through the versioned localStorage key", () => {
    saveExpenseDraft(DRAFT);

    expect(JSON.parse(window.localStorage.getItem(EXPENSE_DRAFT_KEY) ?? "")).toEqual(DRAFT);
    expect(loadExpenseDraft()).toEqual(DRAFT);
  });

  it("save(null) and clearExpenseDraft() both remove the key", () => {
    saveExpenseDraft(DRAFT);
    saveExpenseDraft(null);
    expect(window.localStorage.getItem(EXPENSE_DRAFT_KEY)).toBeNull();
    expect(loadExpenseDraft()).toBeNull();

    saveExpenseDraft(DRAFT);
    clearExpenseDraft();
    expect(window.localStorage.getItem(EXPENSE_DRAFT_KEY)).toBeNull();
    expect(loadExpenseDraft()).toBeNull();
  });

  it("corrupt JSON loads as null instead of throwing", () => {
    window.localStorage.setItem(EXPENSE_DRAFT_KEY, "{not json at all");

    expect(loadExpenseDraft()).toBeNull();
  });

  it("wrong-shaped payloads load as null", () => {
    const bad = [
      "null",
      "42",
      '"string"',
      "[]",
      JSON.stringify({ amt: "1", cat: "c", grp: "g", pay: "p", iso: "i" }), // desc missing
      JSON.stringify({ ...DRAFT, amt: 250 }), // non-string field
    ];
    for (const raw of bad) {
      window.localStorage.setItem(EXPENSE_DRAFT_KEY, raw);
      expect(loadExpenseDraft()).toBeNull();
    }
  });

  it("storage failures are silent: save no-ops, load returns null", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => saveExpenseDraft(DRAFT)).not.toThrow();

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(loadExpenseDraft()).toBeNull();
  });
});

describe("ExpenseForm draft integration (create mode only)", () => {
  it("restores a saved draft on open: fields refilled + bn toast", () => {
    saveExpenseDraft(DRAFT);

    render(createElement(ExpenseForm, { open: true, onClose: () => {} }));

    expect((screen.getByLabelText("পরিমাণ (৳)") as HTMLInputElement).value).toBe("250");
    expect((screen.getByLabelText("খাত") as HTMLInputElement).value).toBe("খাবার");
    expect((screen.getByLabelText("বিবরণ") as HTMLInputElement).value).toBe("চা");
    expect(texts).toContain(DRAFT_RESTORED_MSG.bn);
  });

  it("en locale restores with the English toast wording", () => {
    useLangStore.setState({ lang: "en" });
    saveExpenseDraft(DRAFT);

    render(createElement(ExpenseForm, { open: true, onClose: () => {} }));

    expect(texts).toContain(DRAFT_RESTORED_MSG.en);
  });

  it("debounces saves by 300ms while typing, and clears when everything is emptied", () => {
    vi.useFakeTimers();
    render(createElement(ExpenseForm, { open: true, onClose: () => {} }));

    fireEvent.change(screen.getByLabelText("পরিমাণ (৳)"), { target: { value: "120" } });
    // Not yet — the debounce must not have flushed.
    expect(window.localStorage.getItem(EXPENSE_DRAFT_KEY)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(loadExpenseDraft()?.amt).toBe("120");

    // Emptying every typed field clears the draft.
    fireEvent.change(screen.getByLabelText("পরিমাণ (৳)"), { target: { value: "" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(window.localStorage.getItem(EXPENSE_DRAFT_KEY)).toBeNull();
    expect(loadExpenseDraft()).toBeNull();
  });

  it("edit mode never reads or writes the draft", () => {
    vi.useFakeTimers();
    const seeded = JSON.stringify(DRAFT);
    saveExpenseDraft(DRAFT);

    render(
      createElement(ExpenseForm, {
        open: true,
        onClose: () => {},
        expense: EDIT_EXPENSE,
      }),
    );

    // The expense's values win; the draft is not restored.
    expect((screen.getByLabelText("পরিমাণ (৳)") as HTMLInputElement).value).toBe("420");
    expect((screen.getByLabelText("খাত") as HTMLInputElement).value).toBe("মাছ");
    expect(texts).toEqual([]);

    // Editing in edit mode leaves the stored draft byte-identical.
    fireEvent.change(screen.getByLabelText("পরিমাণ (৳)"), { target: { value: "500" } });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(window.localStorage.getItem(EXPENSE_DRAFT_KEY)).toBe(seeded);
  });

  it("a successful create submit clears the draft", async () => {
    createMock.mockResolvedValue({ ok: true });
    saveExpenseDraft(DRAFT);

    const { container } = render(
      createElement(ExpenseForm, { open: true, onClose: () => {} }),
    );
    // Draft was restored; submit it as-is.
    expect(loadExpenseDraft()).not.toBeNull();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(window.localStorage.getItem(EXPENSE_DRAFT_KEY)).toBeNull(),
    );
  });

  it("closing an all-empty create form clears a pending draft immediately", () => {
    vi.useFakeTimers();
    saveExpenseDraft({ ...DRAFT, cat: "", desc: "" }); // only amt is non-empty

    const { container } = render(
      createElement(ExpenseForm, { open: true, onClose: () => {} }),
    );
    expect((screen.getByLabelText("পরিমাণ (৳)") as HTMLInputElement).value).toBe("250");

    // Empty the amount and close BEFORE the 300ms debounce flushes — the
    // close itself must clear the draft, not the timer.
    fireEvent.change(screen.getByLabelText("পরিমাণ (৳)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "বাতিল" }));
    expect(window.localStorage.getItem(EXPENSE_DRAFT_KEY)).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
  });
});
