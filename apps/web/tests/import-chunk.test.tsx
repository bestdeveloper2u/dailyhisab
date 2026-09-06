import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Expenses } from "../src/screens/Expenses";
import { ToastHost } from "../src/components/Toast";
import { parseExpensesCsv } from "../src/lib/importCsv";
import {
  makeExpense,
  makeResponse,
  renderWithProviders,
  resetLang,
  stubFetch,
} from "./helpers";

/**
 * T22 wave-2 — CSV import chunk contract (audit/t22x_audit.md P1-1):
 * the bulk endpoint caps a request at 50 items (apps/api
 * schemas/expense.py BulkExpensesIn.items max_length=50), so confirmImport
 * MUST chunk at 50. A >50-row CSV used to fire one 100-row POST → 422 →
 * "✓ 0 imported" (silent total failure). Also covers the on-device length /
 * calendar guards (P2-1) and the failure/partial toasts (P3-1).
 */

beforeEach(resetLang);
afterEach(() => vi.unstubAllGlobals());

const N = 75; // forces 2 chunks: 50 + 25

function csvWithRows(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(`2026-09-0${(i % 9) + 1},ঘরে মাছ,চাল,food,12.50,cash`);
  }
  return lines.join("\n");
}

function stubBulkApi(bulkStatus: (chunkIndex: number) => number) {
  const chunkSizes: number[] = [];
  let chunkIndex = 0;
  stubFetch(async (req, url) => {
    if (req.method === "GET" && url.pathname === "/api/v1/expenses") {
      return makeResponse(200, { items: [], next_cursor: null });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/expenses/bulk") {
      const body = (await req.clone().json()) as { items: unknown[] };
      chunkSizes.push(body.items.length);
      const status = bulkStatus(chunkIndex);
      chunkIndex += 1;
      if (status >= 400) {
        return makeResponse(status, {
          detail: { code: "val", message_bn: "অবৈধ", message_en: "invalid" },
        });
      }
      // Bulk endpoint returns an ENVELOPE { items: Expense[] } (the client
      // helper unwraps data.items — packages/api-client apiBulkCreateExpenses).
      return makeResponse(201, {
        items: body.items.map((_, i) => makeExpense({ id: `b-${chunkIndex}-${i}` })),
      });
    }
    return makeResponse(404, { detail: "not mocked" });
  });
  return chunkSizes;
}

async function importCsv(text: string) {
  const user = userEvent.setup();
  const view = renderWithProviders(
    <>
      <Expenses />
      <ToastHost />
    </>,
    { route: "/expenses" },
  );
  await screen.findByRole("button", { name: "CSV আমদানি" });
  const input = view.container.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, { target: { files: [fileWithText(text)] } });
  // Preview modal appears with the parsed count.
  await screen.findByRole("dialog");
  await user.click(screen.getByRole("button", { name: /সব যোগ করুন/ }));
}

/**
 * jsdom (vitest env) does not implement Blob.text(); every real browser has
 * it (MDN Baseline). Stub it per-instance so onImportFile can read the CSV.
 */
function fileWithText(text: string): File {
  const f = new File([text], "rows.csv", { type: "text/csv" });
  Object.defineProperty(f, "text", { value: () => Promise.resolve(text) });
  return f;
}

describe("CSV import chunk contract (50-row bulk cap)", () => {
  it("chunks a 75-row CSV into 50 + 25 and imports all rows", async () => {
    const chunkSizes = stubBulkApi(() => 201);
    await importCsv(csvWithRows(N));

    await waitFor(() => expect(chunkSizes).toEqual([50, 25]));
    const region = screen.getByRole("status");
    await waitFor(() => expect(region).toHaveTextContent("✓"));
    expect(region).toHaveTextContent("৭৫");
  });

  it("shows the failure toast (no ✓) when the first chunk is rejected", async () => {
    stubBulkApi(() => 422);
    await importCsv(csvWithRows(N));

    const region = screen.getByRole("status");
    await waitFor(() => expect(region).toHaveTextContent("আমদানি ব্যর্থ"));
    expect(region.textContent).not.toContain("✓");
  });

  it("shows the partial toast with the saved count when a later chunk fails", async () => {
    stubBulkApi((i) => (i === 0 ? 201 : 500));
    await importCsv(csvWithRows(N));

    const region = screen.getByRole("status");
    await waitFor(() => expect(region).toHaveTextContent("⚠"));
    // 50 saved, 25 remaining.
    expect(region).toHaveTextContent("৫০ টি আমদানি হয়েছে");
    expect(region).toHaveTextContent("২৫ টি বাকি");
  });
});

describe("on-device row guards (audit P2-1)", () => {
  it("skips over-long cat/desc and impossible calendar dates on-device", () => {
    const csv = [
      "2026-09-01,ok,চাল,food,10,cash",
      `2026-09-01,d,${"ক".repeat(81)},food,10,cash`, // cat > 80
      `2026-09-01,${"খ".repeat(201)},চাল,food,10,cash`, // desc > 200
      "31/02/2026,impossible,চাল,food,10,cash", // not a real date
    ].join("\n");
    const res = parseExpensesCsv(csv);
    expect(res.items).toHaveLength(1);
    expect(res.skipped).toBe(3);
  });

  it("accepts boundary lengths (cat 80, desc 200) and real leap-day dates", () => {
    const csv = [
      `2026-09-01,${"খ".repeat(200)},${"ক".repeat(80)},food,10,cash`,
      "29/02/2024,leap day,চাল,food,10,cash",
    ].join("\n");
    const res = parseExpensesCsv(csv);
    expect(res.items).toHaveLength(2);
    expect(res.skipped).toBe(0);
    expect(res.items[1]?.iso).toBe("2024-02-29");
  });
});
