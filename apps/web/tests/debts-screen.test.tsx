import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Debts } from "../src/screens/Debts";
import { makeResponse, renderWithProviders, resetLang, stubFetch, type RouteHandler } from "./helpers";
import type { Debt } from "@khoroch/api-client";

const after = () => vi.unstubAllGlobals();

beforeEach(resetLang);
afterEach(after);

function makeDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: "d1",
    user_id: "u1",
    party: "করিম",
    dir: "lend",
    amt: "890.00",
    iso: "2026-09-04",
    note: "বাজারের বাকি",
    settled_at: null,
    created_at: "2026-09-04T09:30:00Z",
    ...overrides,
  };
}

/** Stateful stub: POST /debts and POST …/pay mutate `items`; GETs read it. */
function debtHandler(items: Debt[], seen: { gets: string[]; posts: Array<{ url: string; body: unknown }> }): RouteHandler {
  return (req, url) => {
    if (req.method === "GET" && url.pathname === "/api/v1/debts") {
      seen.gets.push(url.search);
      const status = url.searchParams.get("status") ?? "open";
      const filtered = items.filter((d) =>
        status === "all" ? true : status === "open" ? d.settled_at === null : d.settled_at !== null,
      );
      return makeResponse(200, { items: filtered, next_cursor: null });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/debts") {
      // req.json() consumes the clone-safe body; stubFetch passes a fresh Request.
      return req.json().then((body) => {
        seen.posts.push({ url: url.pathname, body });
        const b = body as Partial<Debt>;
        items.push(
          makeDebt({
            id: `d${items.length + 1}`,
            party: b.party ?? "?",
            dir: b.dir ?? "lend",
            amt: b.amt ?? "0.00",
            iso: b.iso ?? "2026-09-04",
            note: b.note ?? null,
          }),
        );
        return makeResponse(201, items[items.length - 1]);
      });
    }
    if (req.method === "POST" && url.pathname.endsWith("/pay")) {
      return req.json().then((body) => {
        seen.posts.push({ url: url.pathname, body });
        const id = url.pathname.split("/")[4];
        const debt = items.find((d) => d.id === id)!;
        const pay = Number((body as { amt: string }).amt);
        const owed = Number(debt.amt);
        if (pay >= owed) {
          debt.settled_at = "2026-09-04T12:00:00Z";
          return makeResponse(200, { status: "FULL", debt });
        }
        debt.amt = (owed - pay).toFixed(2);
        return makeResponse(200, { status: "PARTIAL", debt });
      });
    }
    if (req.method === "DELETE") {
      const id = url.pathname.split("/")[4];
      const idx = items.findIndex((d) => d.id === id);
      if (idx >= 0) items.splice(idx, 1);
      return makeResponse(204, null);
    }
    return makeResponse(404, { detail: "nope" });
  };
}

describe("Debts screen", () => {
  it("renders receive/pay KPIs and the open ledger from the API", async () => {
    const items = [
      makeDebt({ party: "করিম", dir: "lend", amt: "890.00" }),
      makeDebt({ id: "d2", party: "শামসু স্টোর", dir: "borrow", amt: "1200.00", note: "চাল বাকি" }),
    ];
    const seen = { gets: [], posts: [] as Array<{ url: string; body: unknown }> };
    stubFetch(debtHandler(items, seen));
    renderWithProviders(<Debts />);

    expect(screen.getByRole("heading", { name: "ধার-দেনা" })).toBeInTheDocument();

    // KPI cards over the loaded open rows (each total also matches its row).
    expect(await screen.findByText("শামসু স্টোর")).toBeInTheDocument();
    expect(screen.getAllByText("৳৮৯০")).toHaveLength(2); // KPI + করিম's row
    expect(screen.getAllByText("৳১,২০০")).toHaveLength(2); // KPI + শামসু's row

    // Ledger badges + notes, open default filter sent to the API.
    expect(screen.getByText("ধার দিয়েছি")).toBeInTheDocument();
    expect(screen.getByText("ধার নিয়েছি")).toBeInTheDocument();
    expect(screen.getByText(/বাজারের বাকি/)).toBeInTheDocument();
    expect(seen.gets[0]).toContain("status=open");
  });

  it("adds a debt from the form: POST payload and refetched row", async () => {
    const items: Debt[] = [];
    const seen = { gets: [], posts: [] as Array<{ url: string; body: unknown }> };
    stubFetch(debtHandler(items, seen));
    renderWithProviders(<Debts />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("কার সাথে"), "রহিম");
    await user.type(screen.getByLabelText("পরিমাণ (৳)"), "500");
    await user.click(screen.getByRole("button", { name: "সংরক্ষণ করুন" }));

    expect(await screen.findByText("রহিম")).toBeInTheDocument();
    const post = seen.posts[0]!;
    expect(post.url).toBe("/api/v1/debts");
    expect(post.body).toMatchObject({
      party: "রহিম",
      dir: "lend",
      amt: "500.00",
      note: null,
    });
    expect((post.body as { iso: string }).iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Form resets and the saved flash appears.
    expect(screen.getByLabelText("কার সাথে")).toHaveValue("");
    expect(screen.getByText("সংরক্ষিত ✓")).toBeInTheDocument();
  });

  it("blocks empty-party submits with a local error (no POST)", async () => {
    const items: Debt[] = [];
    const seen = { gets: [], posts: [] as Array<{ url: string; body: unknown }> };
    stubFetch(debtHandler(items, seen));
    renderWithProviders(<Debts />);
    const user = userEvent.setup();

    await screen.findByText("নতুন এন্ট্রি");
    await user.click(screen.getByRole("button", { name: "সংরক্ষণ করুন" }));

    expect(await screen.findByText("কার সাথে লিখুন")).toBeInTheDocument();
    expect(seen.posts).toHaveLength(0);
  });

  it("partial pay: POST …/pay shrinks the row after refetch", async () => {
    const items = [makeDebt({ party: "করিম", dir: "lend", amt: "890.00" })];
    const seen = { gets: [], posts: [] as Array<{ url: string; body: unknown }> };
    stubFetch(debtHandler(items, seen));
    renderWithProviders(<Debts />);
    const user = userEvent.setup();

    await screen.findByText("করিম");
    await user.click(screen.getByRole("button", { name: "পরিশোধ" }));

    const dialog = screen.getByRole("dialog", { name: "পরিশোধ করুন" });
    const input = within(dialog).getByLabelText("পরিশোধের পরিমাণ (৳)");
    expect(input).toHaveValue("890");
    await user.clear(input);
    await user.type(input, "500");
    await user.click(within(dialog).getByRole("button", { name: "পরিশোধ" }));

    // PARTIAL: 890 − 500 = 390 stays on the ledger (row + receive KPI).
    expect(await screen.findAllByText("৳৩৯০")).toHaveLength(2);
    expect(seen.posts[0]).toEqual({ url: "/api/v1/debts/d1/pay", body: { amt: "500.00" } });
  });

  it("settled tab refetches with status=settled and hides pay/delete actions", async () => {
    const items = [
      makeDebt({ party: "করিম", settled_at: "2026-09-01T10:00:00Z" }),
      makeDebt({ id: "d2", party: "রহিম", dir: "borrow", amt: "200.00" }),
    ];
    const seen = { gets: [], posts: [] as Array<{ url: string; body: unknown }> };
    stubFetch(debtHandler(items, seen));
    renderWithProviders(<Debts />);
    const user = userEvent.setup();

    // Open tab first: only রহিম is unsettled.
    await screen.findByText("রহিম");
    await user.click(screen.getByRole("button", { name: "পরিশোধিত" }));

    // Only করিম (settled) is on the tab, tagged, and without a pay button.
    expect(await screen.findByText("পরিশোধিত ✓")).toBeInTheDocument();
    expect(screen.getByText("করিম")).toBeInTheDocument();
    expect(screen.queryByText("রহিম")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "পরিশোধ" })).not.toBeInTheDocument();
    expect(seen.gets.at(-1)).toContain("status=settled");
  });

  it("two-step delete fires DELETE /debts/{id} and drops the row", async () => {
    const items = [makeDebt({ party: "করিম" })];
    const seen = { gets: [], posts: [] as Array<{ url: string; body: unknown }> };
    stubFetch(debtHandler(items, seen));
    renderWithProviders(<Debts />);
    const user = userEvent.setup();

    await screen.findByText("করিম");
    await user.click(screen.getByRole("button", { name: "করিম — মুছুন" }));
    await user.click(screen.getByRole("button", { name: "নিশ্চিত?" }));

    expect(await screen.findByText("কোনো ধার-দেনা নেই")).toBeInTheDocument();
    expect(items).toHaveLength(0);
  });
});
