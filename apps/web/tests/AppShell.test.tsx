import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppShell } from "../src/components/AppShell";
import { Dashboard } from "../src/screens/Dashboard";
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

function localTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Dashboard mounts monthly(×2) + yearly + budgets — stub all (demo-style data). */
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

  it("renders every NAV item — including Budget — in the <1024px bottom tab bar", () => {
    renderShell();
    const tabs = screen.getByRole("navigation", { name: "Tabs" });
    // Icon-only tabs: the accessible name comes from aria-label (bn default).
    for (const label of ["ড্যাশবোর্ড", "খরচ", "রিপোর্ট", "ধার", "বাজেট", "সেটিংস"]) {
      expect(
        within(tabs).getByRole("link", { name: label }),
      ).toHaveAttribute("href");
    }
    // WCAG 2.2 target size: each tab is ≥44px tall and 1/6 of the bar wide.
    const budgetTab = within(tabs).getByRole("link", { name: "বাজেট" });
    expect(budgetTab).toHaveClass("min-h-11");
    expect(budgetTab.getAttribute("href")).toBe("/budget");
  });

  it("renders the prototype-faithful analytics: 4 stats, budget bar, comparison, trend", async () => {
    renderShell();
    // Stats: today / this month (+delta) / last month / year.
    expect(await screen.findByText("৳১২০")).toBeInTheDocument();
    expect(screen.getAllByText("৳৪,৮২০").length).toBeGreaterThan(0);
    expect(screen.getAllByText("৳৪৫,৩৫৬").length).toBeGreaterThan(0);
    expect(screen.getAllByText("৳৪৯,৭৭৮").length).toBeGreaterThan(0);
    expect(screen.getByText(/গত মাসের চেয়ে ↓/).textContent).toContain("কম");
    // Budget progress card + comparison + group bars + trend.
    expect(screen.getByText(/বাজেট অগ্রগতি —/).textContent).toContain("সীমা");
    expect(screen.getByText(/৳১৫,১৮০/).textContent).toContain("বাজেটে বাকি");
    expect(screen.getByText("মাসের তুলনা").textContent).toBe("মাসের তুলনা");
    expect(screen.getByText("গ্রুপ অনুযায়ী — এই মাস").textContent).toBe(
      "গ্রুপ অনুযায়ী — এই মাস",
    );
    expect(screen.getByText("মাসভিত্তিক ট্রেন্ড").textContent).toBe(
      "মাসভিত্তিক ট্রেন্ড",
    );
  });
});
