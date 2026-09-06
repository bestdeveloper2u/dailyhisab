import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router";
import { Dashboard } from "../src/screens/Dashboard";
import {
  makeQueryClient,
  makeResponse,
  resetLang,
  stubFetch,
  type RouteHandler,
} from "./helpers";
import { QueryClientProvider } from "@tanstack/react-query";
import { useLangStore } from "../src/store/lang";

/**
 * T22.2 — dashboard empty-CTA (prototype emptyCta @1196 parity): when TODAY
 * has no expenses the dashboard shows a CTA card whose two buttons deep-link
 * to /expenses?add=1 and /expenses?voice=1; hidden when today has spend.
 */

function localTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dashboardHandler(todayTotal: string): RouteHandler {
  return (_req, url) => {
    const p = url.pathname;
    if (p.includes("/reports/monthly")) {
      return makeResponse(200, {
        ym: "2026-09",
        total: todayTotal === "0.00" ? "0.00" : "4820.00",
        count: todayTotal === "0.00" ? 0 : 3,
        by_group: {},
        // Only today's entry matters for the CTA derivation.
        by_day:
          todayTotal === "0.00"
            ? []
            : [{ iso: localTodayIso(), total: todayTotal }],
      });
    }
    if (p.includes("/reports/yearly"))
      return makeResponse(200, {
        year: 2026,
        total: "49778.00",
        count: 20,
        by_group: {},
        by_month: [{ ym: "2026-09", total: "4820.00" }],
      });
    if (p.includes("/budgets"))
      return makeResponse(200, {
        ym: "2026-09",
        total: "20000.00",
        spent: "0.00",
        usage_pct: 0,
        by_cat: {},
        cats: {},
      });
    return makeResponse(404, { detail: "not found" });
  };
}

/** Where did the CTA buttons land? Prints the deep-link params. */
function ExpensesProbe() {
  const [sp] = useSearchParams();
  return <p>probe add={sp.get("add")} voice={sp.get("voice")}</p>;
}

function renderDashboard() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/expenses" element={<ExpensesProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(resetLang);
afterEach(() => vi.unstubAllGlobals());

describe("dashboard empty-CTA (T22.2)", () => {
  it("shows the CTA card with both deep-link buttons when today is empty (en)", async () => {
    useLangStore.setState({ lang: "en" });
    stubFetch(dashboardHandler("0.00"));
    renderDashboard();

    expect(await screen.findByText("No expenses yet today")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "✏️ Add now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "🎙 Speak to add" })).toBeInTheDocument();
  });

  it("hides the CTA when today already has expenses", async () => {
    stubFetch(dashboardHandler("120.00"));
    renderDashboard();

    // The dashboard itself rendered (today's stat shows)…
    expect(await screen.findByText("৳১২০")).toBeInTheDocument();
    // …but the empty-CTA never appears.
    expect(screen.queryByText("আজ কোনো খরচ হয়নি")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "✏️ এখনই যোগ করুন" })).not.toBeInTheDocument();
  });

  it("✏️ button navigates to /expenses?add=1", async () => {
    stubFetch(dashboardHandler("0.00"));
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "✏️ এখনই যোগ করুন" }));

    expect(await screen.findByText(/add=1 voice=/)).toBeInTheDocument();
  });

  it("🎙 button navigates to /expenses?voice=1", async () => {
    stubFetch(dashboardHandler("0.00"));
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("button", { name: "🎙 বলে যোগ করুন" }));

    expect(await screen.findByText(/voice=1/)).toBeInTheDocument();
    expect(screen.getByText(/add= voice=1/)).toBeInTheDocument();
  });
});
