/*
 * T25.1 threshold-gated list virtualization for the Expenses screen.
 *
 * Two render paths share one markup (DayGroupHeader/ExpenseRow):
 *  - rows <= VIRTUAL_THRESHOLD (60): legacy .map render — DOM identical to
 *    pre-T25.1 (no virtual container attributes).
 *  - rows > threshold: TanStack `useWindowVirtualizer` over a flattened
 *    header/row array (the page/window is the scroller — AppShell <main>
 *    has no overflow of its own).
 *
 * jsdom has no layout engine, so the virtualizer is fed sizes two ways:
 * `window.innerHeight` (jsdom default 768) for the window rect, and a
 * ResizeObserver stub that reports a fixed 56px border-box height when the
 * virtualizer observes an item (measureElement prefers entry.borderBoxSize).
 * The component under test is rendered for real — nothing is mocked away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Expenses } from "../src/screens/Expenses";
import { makeResponse, renderWithProviders, resetLang, stubFetch, type RouteHandler } from "./helpers";

/** Mirrors ROW_ESTIMATE_PX in Expenses.tsx (reported by the RO stub). */
const ITEM_PX = 56;

class ResizeObserverStub {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    // Fire synchronously (virtual-core runs the callback without rAF by
    // default); measureElement reads entry.borderBoxSize[0].blockSize.
    this.cb(
      [
        {
          target,
          borderBoxSize: [{ inlineSize: 400, blockSize: ITEM_PX }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

interface Row {
  id: string;
  cat: string;
  amt: string;
  iso: string;
}

/**
 * GET /api/v1/expenses → n rows spread over several days (day-grouped).
 * Honors ?q= (server-side filter, same contract as the real API) so the
 * search flow can be exercised end-to-end.
 */
function bulkHandler(n: number, opts: { nextCursor?: string } = {}): RouteHandler {
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({
    id: `x${i}`,
    cat: `খরচ ${i}`,
    amt: "10.00",
    iso: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
  return (req, url) => {
    if (req.method === "GET" && url.pathname === "/api/v1/expenses") {
      const q = url.searchParams.get("q");
      const cursor = url.searchParams.get("cursor");
      const page = cursor ? [] : q ? rows.filter((r) => r.cat.includes(q)) : rows;
      return makeResponse(200, { items: page, next_cursor: cursor ? null : (opts.nextCursor ?? null) });
    }
    return makeResponse(404, { detail: { code: "not_found", message_bn: "নেই", message_en: "missing" } });
  };
}

beforeEach(resetLang);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Expenses virtualization gate (T25.1)", () => {
  it("small list (below threshold): legacy render path, no virtual container", async () => {
    stubFetch(bulkHandler(2));
    const { container } = renderWithProviders(<Expenses />, { route: "/expenses" });

    expect(await screen.findByText("খরচ 0")).toBeInTheDocument();
    expect(screen.getByText("খরচ 1")).toBeInTheDocument();

    // No virtualization markers — the DOM is exactly the pre-T25.1 tree.
    expect(container.querySelector("[data-virtualized='true']")).toBeNull();
    expect(container.querySelector("[data-index]")).toBeNull();
    // Every loaded row is a real DOM node (grouped day cards).
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("exactly VIRTUAL_THRESHOLD rows: still the legacy path", async () => {
    stubFetch(bulkHandler(60));
    const { container } = renderWithProviders(<Expenses />, { route: "/expenses" });

    expect(await screen.findByText("খরচ 0")).toBeInTheDocument();
    expect(container.querySelector("[data-virtualized='true']")).toBeNull();
    // <= threshold ⇒ every row is mounted, like today.
    expect(screen.getAllByRole("listitem")).toHaveLength(60);
  });

  it("above threshold: window virtualizer renders a windowed subset in a virtual container", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    stubFetch(bulkHandler(61));
    const { container } = renderWithProviders(<Expenses />, { route: "/expenses" });

    // The virtual container replaces the legacy flat list…
    const virtual = await screen.findByText("খরচ 0").then(() =>
      container.querySelector("[data-virtualized='true']"),
    );
    expect(virtual).not.toBeNull();

    // …the total-size spacer exists (virtualizer is driving layout)…
    const spacer = virtual!.firstElementChild as HTMLElement;
    expect(Number.parseFloat(spacer.style.height)).toBeGreaterThan(
      28 * 44 + 61 * 56 - 1, // ≥ sum of the estimates: full list height, not 0
    );
    // …and virtual items carry the measureElement bookkeeping attributes.
    const virtualItems = spacer.querySelectorAll("[data-index]");
    expect(virtualItems.length).toBeGreaterThan(0);

    // Windowing: only the items near scroll offset 0 (+overscan) are mounted
    // — far more rows are loaded than rendered.
    const renderedRows = screen.getAllByRole("listitem").length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(61);
    // First day-group's rows are in the window; the LAST flattened entries
    // (day 2026-08-28 → খরচ 27/55) are far below the fold and not mounted.
    expect(screen.queryByText("খরচ 27")).not.toBeInTheDocument();
    expect(screen.queryByText("খরচ 55")).not.toBeInTheDocument();

    // Day-group headers survive virtualization: খরচ 0 is on 2026-08-01, so
    // its day header renders above it with the same markup as the legacy path.
    expect(screen.getByText("১ আগস্ট")).toBeInTheDocument();
  });

  it("search filter still drives the list (server q → flattened render)", async () => {
    stubFetch(bulkHandler(3));
    const user = userEvent.setup();
    renderWithProviders(<Expenses />, { route: "/expenses" });

    expect(await screen.findByText("খরচ 0")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);

    // Debounced (300ms) ?q= refetch — the API contract filters, the screen
    // renders whatever the filtered flattened set contains.
    await user.type(screen.getByRole("searchbox"), "1");
    await vi.waitFor(
      () => expect(screen.getAllByRole("listitem")).toHaveLength(1),
      { timeout: 3000 },
    );
    expect(screen.getByText("খরচ 1")).toBeInTheDocument();
    expect(screen.queryByText("খরচ 0")).not.toBeInTheDocument();
  });
});
