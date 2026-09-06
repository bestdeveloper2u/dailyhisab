import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Expenses } from "../src/screens/Expenses";
import { makeResponse, renderWithProviders, resetLang, stubFetch, type RouteHandler } from "./helpers";
import { subscribeToasts } from "../src/lib/toast";

const after = () => vi.unstubAllGlobals();

function listHandler(
  rows: Array<{ id: string; cat: string; amt: string; iso: string; grp?: string; pay?: string; desc?: string | null }>,
  opts: { nextCursor?: string | null; onList?: (url: URL) => void; onDelete?: (id: string) => void; onCreate?: (body: unknown) => void } = {},
): RouteHandler {
  return (req, url) => {
    if (req.method === "GET" && url.pathname === "/api/v1/expenses") {
      opts.onList?.(url);
      const cursor = url.searchParams.get("cursor");
      const page = cursor === "CUR1" ? [] : rows;
      return makeResponse(200, { items: page, next_cursor: cursor === "CUR1" ? null : (opts.nextCursor ?? null) });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v1/expenses/")) {
      const id = url.pathname.split("/").pop()!;
      opts.onDelete?.(id);
      return makeResponse(204, null);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/expenses") {
      return req.json().then((body) => {
        opts.onCreate?.(body);
        const b = body as { amt: string; cat: string };
        return makeResponse(201, {
          id: "new-1",
          user_id: "u",
          cat: b.cat,
          grp: "education",
          amt: b.amt,
          pay: "cash",
          desc: null,
          iso: "2026-09-04",
          created_at: "2026-09-04T10:00:00Z",
        });
      });
    }
    return makeResponse(404, { detail: { code: "not_found", message_bn: "নেই", message_en: "missing" } });
  };
}

beforeEach(resetLang);
afterEach(after);

describe("Expenses screen (real API shapes)", () => {
  it("renders rows with bn-formatted amounts and a loaded total", async () => {
    stubFetch(
      listHandler([
        { id: "1", cat: "মাছ", amt: "890.00", iso: "2026-09-04" },
        { id: "2", cat: "চাল", amt: "1450.50", iso: "2026-09-04" },
      ]),
    );
    renderWithProviders(<Expenses />, { route: "/expenses" });

    expect(await screen.findByText("মাছ")).toBeInTheDocument();
    expect(screen.getByText("চাল")).toBeInTheDocument();
    expect(screen.getByText("৳৮৯০")).toBeInTheDocument();
    expect(screen.getByText("৳১,৪৫০.৫")).toBeInTheDocument();
    // 2 entries + total 2340.50 (header total AND the day-group sum coincide).
    expect(screen.getByText("২ এন্ট্রি")).toBeInTheDocument();
    expect(screen.getAllByText("৳২,৩৪০.৫")).toHaveLength(2);
  });

  it("loads the next keyset page via the cursor", async () => {
    const urls: string[] = [];
    stubFetch(
      listHandler([{ id: "1", cat: "মাছ", amt: "890.00", iso: "2026-09-04" }], {
        nextCursor: "CUR1",
        onList: (url) => urls.push(url.search),
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<Expenses />, { route: "/expenses" });

    await screen.findByText("মাছ");
    await user.click(screen.getByRole("button", { name: "আরও দেখুন" }));

    await waitFor(() => expect(urls.some((s) => s.includes("cursor=CUR1"))).toBe(true));
  });

  it("deletes on a single tap (undo toast replaces the confirm step)", async () => {
    const rows = [
      { id: "keep-1", cat: "চাল", amt: "200.00", iso: "2026-09-04" },
      { id: "del-1", cat: "মাছ", amt: "890.00", iso: "2026-09-04" },
    ];
    stubFetch(
      listHandler(rows, {
        onDelete: (id) => {
          const i = rows.findIndex((r) => r.id === id);
          if (i >= 0) rows.splice(i, 1);
        },
      }),
    );
    const toasts: string[] = [];
    const unsubscribe = subscribeToasts((s) => s && toasts.push(s.text));
    const user = userEvent.setup();
    renderWithProviders(<Expenses />, { route: "/expenses" });

    expect(await screen.findByText("মাছ")).toBeInTheDocument();

    // T22.1: no arm/confirm step anymore — one ✕ tap fires DELETE.
    await user.click(screen.getByRole("button", { name: "মাছ — মুছুন" }));
    expect(screen.queryByRole("button", { name: "নিশ্চিত?" })).not.toBeInTheDocument();

    // Invalidation refetches the (now smaller) list, and the undo toast shows.
    await waitFor(() => expect(screen.queryByText("মাছ")).not.toBeInTheDocument());
    await waitFor(() => expect(toasts).toContain("মোছা হয়েছে"));
    expect(screen.getByText("চাল")).toBeInTheDocument();
    expect(screen.getByText("১ এন্ট্রি")).toBeInTheDocument();
    unsubscribe();
  });

  it("creates an expense from the form with a normalized money string", async () => {
    const bodies: unknown[] = [];
    stubFetch(listHandler([{ id: "1", cat: "চাল", amt: "200.00", iso: "2026-09-04" }], { onCreate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    renderWithProviders(<Expenses />, { route: "/expenses" });

    await screen.findByText("চাল");
    await user.click(screen.getAllByRole("button", { name: "খরচ যোগ করুন" })[0]!);

    await user.type(await screen.findByLabelText("পরিমাণ (৳)"), "120.5");
    await user.type(screen.getByLabelText("খাত"), "বই");
    await user.click(screen.getByRole("button", { name: "সংরক্ষণ করুন" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    // The form's default group is "food"; amount is normalized to 2 decimals.
    expect(bodies[0]).toMatchObject({ amt: "120.50", cat: "বই", grp: "food" });
  });

  it("submits Bengali-digit amounts as ASCII money strings (T15.1b)", async () => {
    const bodies: unknown[] = [];
    stubFetch(listHandler([{ id: "1", cat: "চাল", amt: "200.00", iso: "2026-09-04" }], { onCreate: (b) => bodies.push(b) }));
    const user = userEvent.setup();
    renderWithProviders(<Expenses />, { route: "/expenses" });

    await screen.findByText("চাল");
    await user.click(screen.getAllByRole("button", { name: "খরচ যোগ করুন" })[0]!);

    // A bn-keyboard user types Bengali digits; the API needs ^\d+\.\d{2}$.
    await user.type(await screen.findByLabelText("পরিমাণ (৳)"), "৫০.২৫");
    await user.type(screen.getByLabelText("খাত"), "বই");
    await user.click(screen.getByRole("button", { name: "সংরক্ষণ করুন" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ amt: "50.25", cat: "বই" });
  });

  it("shows an empty state when the API returns no items", async () => {
    stubFetch(listHandler([]));
    renderWithProviders(<Expenses />, { route: "/expenses" });

    expect(await screen.findByText("কোনো খরচ নেই")).toBeInTheDocument();
    expect(screen.getByText("প্রথম খরচ যোগ করুন — লিখে বা ভয়েসে বলুন")).toBeInTheDocument();
  });
});


