import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonAmt,
  canonCat,
  dupKey,
  DUPLICATE_WINDOW_MINUTES,
  fetchExpensesForDays,
  findBatchDuplicateKeys,
  findDuplicateExpenses,
  itemsHaveDuplicates,
} from "./duplicate";
import type { DuplicateRow } from "./duplicate";

/**
 * T24.1 — pure duplicate-detection logic (WCAG 2.2 SC 3.3.4 "checked"):
 * same khata + same amount inside a short recency window = a suspicious
 * re-add of "চায়ে ৪০ টাকা"; anything else is none of the guard's business.
 */

const NOW = new Date("2026-09-06T12:00:00Z");
const OPTS = { now: NOW };

/** Saved row created `min` minutes before NOW (or with explicit overrides). */
type TestRow = DuplicateRow & { id?: string };

function row(overrides: Partial<TestRow> = {}): TestRow {
  return {
    amt: "40.00",
    cat: "চা",
    iso: "2026-09-06",
    created_at: new Date(NOW.getTime() - 3 * 60_000).toISOString(),
    ...overrides,
  };
}

describe("canonCat / canonAmt / dupKey normalization", () => {
  it("canonCat trims, collapses whitespace and case-folds", () => {
    expect(canonCat("  চা  ")).toBe("চা");
    expect(canonCat("Tea   Snack")).toBe("tea snack");
    expect(canonCat("চা")).toBe(canonCat(" চা "));
  });

  it("canonCat folds Unicode-equivalent spellings via NFC", () => {
    // Decomposed o + combining circumflex vs precomposed ô.
    expect(canonCat("o\u0302")).toBe(canonCat("\u00f4"));
  });

  it("canonAmt reads ASCII, Bengali digits, ৳ and commas; null on garbage", () => {
    expect(canonAmt("40")).toBe(4000);
    expect(canonAmt("40.00")).toBe(4000);
    expect(canonAmt("৪০")).toBe(4000);
    expect(canonAmt("৳ 1,200.50")).toBe(120050);
    expect(canonAmt(40)).toBe(4000);
    expect(canonAmt("0.00")).toBe(0);
    expect(canonAmt("0.105")).toBe(11); // rounded to 2dp, not truncated
    expect(canonAmt("abc")).toBeNull();
    expect(canonAmt("")).toBeNull();
    expect(canonAmt(".")).toBeNull();
  });

  it("dupKey is stable across amount scripts and khata formatting", () => {
    expect(dupKey({ amt: "40", cat: " চা " })).toBe(dupKey({ amt: "৪০.০০", cat: "চা" }));
  });

  it("exposes the 30-minute recency window", () => {
    expect(DUPLICATE_WINDOW_MINUTES).toBe(30);
  });
});

describe("findDuplicateExpenses", () => {
  it("matches the same khata + amount saved minutes ago", () => {
    const rows = [row()];
    expect(findDuplicateExpenses({ amt: "40", cat: "চা", iso: "2026-09-06" }, rows, OPTS)).toEqual([
      rows[0],
    ]);
  });

  it("matches across Bengali/ASCII amounts and khata formatting", () => {
    const rows = [row({ cat: "  Tea  " })];
    expect(findDuplicateExpenses({ amt: "৪০.০০", cat: "tea" }, rows, OPTS)).toHaveLength(1);
  });

  it("ignores a different amount or khata", () => {
    const rows = [row()];
    expect(findDuplicateExpenses({ amt: "41", cat: "চা" }, rows, OPTS)).toEqual([]);
    expect(findDuplicateExpenses({ amt: "40", cat: "চাল" }, rows, OPTS)).toEqual([]);
  });

  it("ignores rows outside the recency window (the second real cup of tea)", () => {
    const rows = [row({ created_at: new Date(NOW.getTime() - 8 * 60 * 60_000).toISOString() })];
    expect(findDuplicateExpenses({ amt: "40", cat: "চা" }, rows, OPTS)).toEqual([]);
  });

  it("honours a custom window and injectable clock", () => {
    const rows = [row({ created_at: "2026-09-06T11:20:00Z" })]; // 40 min before NOW
    expect(findDuplicateExpenses({ amt: "40", cat: "চা" }, rows, OPTS)).toEqual([]);
    expect(
      findDuplicateExpenses({ amt: "40", cat: "চা" }, rows, { ...OPTS, windowMinutes: 60 }),
    ).toHaveLength(1);
  });

  it("rows without created_at fall back to same-day equality", () => {
    const undated = [row({ created_at: null, iso: "2026-09-06" })];
    expect(findDuplicateExpenses({ amt: "40", cat: "চা", iso: "2026-09-06" }, undated, OPTS)).toHaveLength(1);
    expect(findDuplicateExpenses({ amt: "40", cat: "চা", iso: "2026-09-05" }, undated, OPTS)).toEqual([]);
  });

  it("an unparseable created_at falls back to iso equality too", () => {
    const rows = [row({ created_at: "not-a-date", iso: "2026-09-06" })];
    expect(findDuplicateExpenses({ amt: "40", cat: "চা", iso: "2026-09-06" }, rows, OPTS)).toHaveLength(1);
  });

  it("never matches an unparseable candidate amount or empty khata", () => {
    const rows = [row()];
    expect(findDuplicateExpenses({ amt: "টাকা মাত্র", cat: "চা" }, rows, OPTS)).toEqual([]);
    expect(findDuplicateExpenses({ amt: "40", cat: "   " }, rows, OPTS)).toEqual([]);
  });

  it("orders multiple hits most-recent-first", () => {
    const older = row({ id: "older", created_at: new Date(NOW.getTime() - 10 * 60_000).toISOString() });
    const newer = row({ id: "newer", created_at: new Date(NOW.getTime() - 2 * 60_000).toISOString() });
    const hits = findDuplicateExpenses({ amt: "40", cat: "চা" }, [older, newer], OPTS);
    expect(hits.map((r) => r.id)).toEqual(["newer", "older"]);
  });
});

describe("findBatchDuplicateKeys / itemsHaveDuplicates", () => {
  it("flags identical candidates inside one batch, across scripts", () => {
    const items = [
      { amt: "40", cat: "চা" },
      { amt: "৪০.০০", cat: "চা" },
      { amt: "50", cat: "চাল" },
    ];
    expect(findBatchDuplicateKeys(items)).toEqual(new Set([dupKey(items[0])]));
  });

  it("never flags unparseable batch items", () => {
    const items = [
      { amt: "কিছু না", cat: "চা" },
      { amt: "কিছু না", cat: "চা" },
    ];
    expect(findBatchDuplicateKeys(items)).toEqual(new Set());
  });

  it("itemsHaveDuplicates sees batch twins, recent rows, and nothing else", () => {
    const twin = [
      { amt: "40", cat: "চা" },
      { amt: "40.00", cat: "চা" },
    ];
    expect(itemsHaveDuplicates(twin, [], OPTS)).toBe(true);
    expect(itemsHaveDuplicates([{ amt: "40", cat: "চা" }], [row()], OPTS)).toBe(true);
    expect(itemsHaveDuplicates([{ amt: "55", cat: "রিকশা" }], [row()], OPTS)).toBe(false);
  });
});

describe("fetchExpensesForDays", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("runs one day-query per distinct date and merges the rows", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        const url = new URL(request.url);
        calls.push(url.searchParams.get("from") ?? "");
        return jsonResponse(200, {
          items: [{ id: `e-${url.searchParams.get("from")}` }],
          next_cursor: null,
        });
      }),
    );
    const rows = await fetchExpensesForDays(["2026-09-06", "2026-09-06", "2026-09-05"], "bn");
    expect(calls.sort()).toEqual(["2026-09-05", "2026-09-06"]);
    expect(rows.map((r) => r.id)).toEqual(["e-2026-09-06", "e-2026-09-05"]);
  });

  it("fails open: a failed day contributes nothing and never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        if (new URL(request.url).searchParams.get("from") === "2026-09-06") {
          throw new Error("offline");
        }
        return jsonResponse(500, { detail: "boom" });
      }),
    );
    const rows = await fetchExpensesForDays(["2026-09-06", "2026-09-05"], "bn");
    expect(rows).toEqual([]);
  });
});
