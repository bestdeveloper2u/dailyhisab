import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { Dashboard } from "../src/screens/Dashboard";
import { Settings } from "../src/screens/Settings";
import { Login } from "../src/screens/Login";
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

/** Dashboard mounts 4 queries — answer them all so the screen settles. */
function dashboardHandler(): RouteHandler {
  return (_req, url) => {
    const p = url.pathname;
    if (p.includes("/reports/monthly"))
      return makeResponse(200, {
        ym: "2026-09",
        total: "0.00",
        count: 0,
        by_group: {},
        by_day: [],
      });
    if (p.includes("/reports/yearly"))
      return makeResponse(200, {
        year: 2026,
        total: "0.00",
        count: 0,
        by_group: {},
        by_month: [],
      });
    if (p.includes("/budgets"))
      return makeResponse(200, {
        ym: "2026-09",
        total: "0.00",
        spent: "0.00",
        usage_pct: 0,
        by_cat: {},
        cats: {},
      });
    return makeResponse(404, { detail: "not found" });
  };
}

/** A tiny in-tree link so we can navigate between routes like the shell does. */
function NavToSettings() {
  return (
    <nav>
      <Link to="/settings">go-settings</Link>
    </nav>
  );
}

function renderRoutes(initialEntry: string) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <NavToSettings />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/login" element={<Login />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** T11.2 — WCAG 2.4.2 Page Titled: each route names itself in document.title. */
describe("per-route document.title", () => {
  it("dashboard route sets its title", async () => {
    stubFetch(dashboardHandler());
    renderRoutes("/");
    expect(await screen.findByText(/ড্যাশবোর্ড|Dashboard|আজ/)).toBeInTheDocument();
    expect(document.title).toBe("ড্যাশবোর্ড · Daily Hisab");
  });

  it("settings route sets its title", () => {
    renderRoutes("/settings");
    expect(document.title).toBe("সেটিংস · Daily Hisab");
  });

  it("login route sets its title", () => {
    renderRoutes("/login");
    expect(document.title).toBe("লগইন · Daily Hisab");
  });

  it("title updates when navigating between routes", async () => {
    stubFetch(dashboardHandler());
    const user = userEvent.setup();
    renderRoutes("/");
    expect(await screen.findByText(/ড্যাশবোর্ড|Dashboard|আজ/)).toBeInTheDocument();
    expect(document.title).toBe("ড্যাশবোর্ড · Daily Hisab");

    await user.click(screen.getByRole("link", { name: "go-settings" }));

    expect(document.title).toBe("সেটিংস · Daily Hisab");
  });
});
