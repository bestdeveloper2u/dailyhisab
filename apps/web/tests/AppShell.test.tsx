import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppShell } from "../src/components/AppShell";
import { Dashboard } from "../src/screens/Dashboard";
import { useLangStore } from "../src/store/lang";
import {
  makeQueryClient,
  makeResponse,
  resetLang,
  stubFetch,
  type RouteHandler,
} from "./helpers";

const after = () => vi.unstubAllGlobals();
beforeEach(resetLang);
afterEach(after);

/** Dashboard mounts three queries — stub all of them (demo-style data). */
function dashboardHandler(): RouteHandler {
  return (_req, url) => {
    const p = url.pathname;
    if (p.includes("/reports/monthly"))
      return makeResponse(200, {
        ym: "2026-09",
        total: "4820.00",
        count: 3,
        by_group: { food: "3000.00", transport: "1820.00" },
        by_day: [],
      });
    if (p.includes("/budgets"))
      return makeResponse(200, {
        ym: "2026-09",
        total: "12500.00",
        spent: "4820.00",
        usage_pct: 38.6,
        by_cat: {},
        cats: {},
      });
    if (p.includes("/expenses"))
      return makeResponse(200, {
        items: [
          {
            id: "e1",
            user_id: "u1",
            cat: "মাছ",
            grp: "food",
            amt: "890.00",
            iso: "2026-09-04",
            pay: "cash",
            desc: null,
            created_at: "2026-09-04T09:30:00Z",
          },
        ],
        next_cursor: null,
      });
    return makeResponse(404, { detail: "not found" });
  };
}

function renderShell() {
  const queryClient = makeQueryClient();
  stubFetch(dashboardHandler());
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="*" element={<Dashboard />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  it("renders the brand wordmark and a version chip", () => {
    renderShell();
    expect(screen.getAllByText("Daily Hisab").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/v0\.\d+\.\d+/).length).toBeGreaterThan(0);
  });

  it("switches nav labels from Bengali to English via the compact toggle", async () => {
    const user = userEvent.setup();
    renderShell();
    expect(screen.getAllByText("ড্যাশবোর্ড").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "EN" }));

    expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("ড্যাশবোর্ড")).toHaveLength(0);
  });

  it("shows the Bengali-formatted month total on the dashboard (real API shape)", async () => {
    renderShell();
    // Stamped skeleton first, then the stubbed report data lands.
    expect(await screen.findByText("৳৪,৮২০")).toBeInTheDocument();
    expect(screen.getByText("৳৭,৬৮০")).toBeInTheDocument(); // 12500 − 4820
  });
});
