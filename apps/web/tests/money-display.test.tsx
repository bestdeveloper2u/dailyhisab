import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { Dashboard } from "../src/screens/Dashboard";
import {
  makeQueryClient,
  makeResponse,
  resetLang,
  stubFetch,
  type RouteHandler,
} from "./helpers";
import { useLangStore } from "../src/store/lang";

const after = () => vi.unstubAllGlobals();
beforeEach(resetLang);
afterEach(after);

function localTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Dashboard mounts monthly(×2) + yearly + budgets — stub all. */
function dashboardHandler(): RouteHandler {
  return (_req, url) => {
    const p = url.pathname;
    const ym = url.searchParams.get("ym") ?? "";
    if (p.includes("/reports/monthly")) {
      if (ym.endsWith("-08"))
        return makeResponse(200, {
          ym: "2026-08",
          total: "45356.00",
          count: 12,
          by_group: { food: "30000.00" },
          by_day: [],
        });
      return makeResponse(200, {
        ym: "2026-09",
        total: "4820.00",
        count: 3,
        by_group: { food: "3000.00", transport: "1820.00" },
        by_day: [{ iso: localTodayIso(), total: "120.00" }],
      });
    }
    if (p.includes("/reports/yearly"))
      return makeResponse(200, {
        year: 2026,
        total: "49778.00",
        count: 20,
        by_group: {},
        by_month: [
          { ym: "2026-08", total: "45356.00" },
          { ym: "2026-09", total: "4820.00" },
        ],
      });
    if (p.includes("/budgets"))
      return makeResponse(200, {
        ym: "2026-09",
        total: "20000.00",
        spent: "4820.00",
        usage_pct: 24.1,
        by_cat: {},
        cats: {},
      });
    return makeResponse(404, { detail: "not found" });
  };
}

function renderDashboard() {
  stubFetch(dashboardHandler());
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Render-level parity check (T11.1): rendered amounts come out Indian-grouped
 * via fmtMoney. English locale shows the prototype's exact strings.
 */
describe("money formatting on screen", () => {
  it("Dashboard shows a grouped amount (49,778) in the en locale", async () => {
    useLangStore.setState({ lang: "en" });
    renderDashboard();

    // Year stat card: yearly total 49778.00 -> "৳49,778".
    expect(await screen.findAllByText("৳49,778").then((els) => els.length)).toBeGreaterThan(0);
    // Also grouped: monthly + trend amounts.
    expect(screen.getAllByText("৳4,820").length).toBeGreaterThan(0);
    expect(screen.getAllByText("৳45,356").length).toBeGreaterThan(0);
  });

  it("Dashboard shows grouped Bengali digits in the bn locale", async () => {
    renderDashboard();

    expect(await screen.findAllByText("৳৪৯,৭৭৮").then((els) => els.length)).toBeGreaterThan(0);
    expect(screen.getAllByText("৳৪,৮২০").length).toBeGreaterThan(0);
  });
});
