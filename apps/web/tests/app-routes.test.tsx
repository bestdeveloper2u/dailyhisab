import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import App from "../src/App";
import { useAuthStore } from "../src/store/auth";
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

/** Same dashboard fixture as AppShell.test — monthly(×2) + yearly + budgets. */
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
      return makeResponse(200, { items: [], next_cursor: null });
    return makeResponse(404, { detail: "not found" });
  };
}

/** Renders the REAL App (ErrorBoundary > Suspense > lazy routes). */
function renderApp(route: string) {
  const queryClient = makeQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("App lazy routes (T15.1a)", () => {
  it("lazy-loads the /login chunk for an anonymous visitor", async () => {
    useAuthStore.setState({
      status: "anon",
      user: null,
      accessToken: null,
      refreshToken: null,
    });
    renderApp("/login");

    // findBy* waits through the Suspense fallback while the chunk resolves.
    expect(
      await screen.findByText("Demo: demo@khoroch.app / demo1234"),
    ).toBeInTheDocument();
  });

  it("lazy-loads the Dashboard chunk behind RequireAuth when authed", async () => {
    useAuthStore.setState({
      status: "authed",
      user: { id: "u1", email: "demo@khoroch.app", name: "ডেমো" },
      accessToken: "test-token",
      refreshToken: null,
    });
    stubFetch(dashboardHandler());
    renderApp("/");

    // Dashboard renders today's stat (bn digits) once the lazy chunk lands.
    expect(await screen.findByText("৳১২০")).toBeInTheDocument();
  });
});
