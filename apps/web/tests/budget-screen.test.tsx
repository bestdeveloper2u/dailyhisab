import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Budget } from "../src/screens/Budget";
import { shiftYm, todayIso, ymOfIso } from "../src/lib/catalog";
import {
  makeResponse,
  renderWithProviders,
  resetLang,
  stubFetch,
  type RouteHandler,
} from "./helpers";

const after = () => vi.unstubAllGlobals();

beforeEach(resetLang);
afterEach(after);

interface BudgetState {
  ym: string;
  total: string;
  cats: Record<string, string>;
  spent: string;
  usagePct: number;
  perCat: Record<string, { spent: string }>;
  puts: Array<{ url: string; body: unknown }>;
  gets: string[];
}

/**
 * Stateful /budgets stub: GET returns the current view, PUT merges the upsert
 * and recomputes usage so the screen's refetch actually reflects the change.
 */
function budgetHandler(state: BudgetState): RouteHandler {
  const pct = (spent: number, budget: number) =>
    budget === 0 ? 0 : Math.round((spent / budget) * 10000) / 100;
  return (req, url) => {
    if (req.method === "GET" && url.pathname === "/api/v1/budgets") {
      state.gets.push(`${url.pathname}${url.search}`);
      state.ym = url.searchParams.get("ym") ?? state.ym;
      const spentTotal = Number(state.spent);
      const totalNum = Number(state.total);
      const byCat: Record<string, { budget: string; spent: string; usage_pct: number }> = {};
      for (const [cat, usage] of Object.entries(state.perCat)) {
        const b = Number(state.cats[cat] ?? "0.00");
        byCat[cat] = {
          budget: b.toFixed(2),
          spent: usage.spent,
          usage_pct: pct(Number(usage.spent), b),
        };
      }
      return makeResponse(200, {
        ym: state.ym,
        total: state.total,
        cats: state.cats,
        spent: spentTotal.toFixed(2),
        usage_pct: pct(spentTotal, totalNum),
        by_cat: byCat,
      });
    }
    if (req.method === "PUT" && url.pathname === "/api/v1/budgets") {
      return req.json().then((body) => {
        state.puts.push({ url: url.pathname, body });
        const b = body as { total?: string; cats?: Record<string, string> };
        if (b.total !== undefined) state.total = b.total;
        if (b.cats !== undefined) state.cats = { ...state.cats, ...b.cats };
        return makeResponse(200, {
          ym: state.ym,
          total: state.total,
          cats: state.cats,
          spent: state.spent,
          usage_pct: 20,
          by_cat: {},
        });
      });
    }
    return makeResponse(404, { detail: "nope" });
  };
}

function baseState(): BudgetState {
  return {
    ym: ymOfIso(todayIso()), // default GET carries no ?ym → the current month
    total: "20000.00",
    cats: { food: "8000.00", transport: "1000.00" },
    spent: "5234.50",
    usagePct: 26.17,
    perCat: { food: { spent: "4234.50" }, transport: { spent: "1500.00" } },
    puts: [],
    gets: [],
  };
}

describe("Budget screen", () => {
  it("renders the month view: limit input, usage chips, and category rows", async () => {
    const state = baseState();
    stubFetch(budgetHandler(state));
    renderWithProviders(<Budget />);

    expect(screen.getByRole("heading", { name: "বাজেট" })).toBeInTheDocument();

    // Total card: editable limit + spent/left chips (bn digits via formatTaka).
    expect(await screen.findByLabelText("মাসিক বাজেট (৳)")).toHaveValue("20000");

    // First fetch requests the current month (?ym=YYYY-MM).
    expect(state.gets[0]).toBe(`/api/v1/budgets?ym=${ymOfIso(todayIso())}`);
    expect(state.ym).toMatch(/^\d{4}-\d{2}$/);
    expect(screen.getByText("খরচ: ৳৫,২৩৪.৫ (26%)")).toBeInTheDocument();
    expect(screen.getByText("বাকি: ৳১৪,৭৬৫.৫")).toBeInTheDocument();

    // Category rows: good tag under 75%, over tag past 100%.
    expect(screen.getByText("খাদ্য ও মুদি")).toBeInTheDocument();
    expect(screen.getByText("৳৪,২৩৪.৫ / ৳৮,০০০")).toBeInTheDocument();
    expect(screen.getByText("ভালো")).toBeInTheDocument();
    expect(screen.getByText("যাতায়াত")).toBeInTheDocument();
    expect(screen.getByText("৳১,৫০০ / ৳১,০০০")).toBeInTheDocument();
    expect(screen.getByText("বেশি হয়ে গেছে")).toBeInTheDocument();
  });

  it("editing the monthly limit PUTs {total} and refreshes the chips", async () => {
    const state = baseState();
    stubFetch(budgetHandler(state));
    renderWithProviders(<Budget />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("মাসিক বাজেট (৳)");
    await user.clear(input);
    await user.type(input, "25000");
    await user.tab(); // blur → save

    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(state.puts[0]).toEqual({ url: "/api/v1/budgets", body: { total: "25000.00" } });
    // Refetched view: 25000 − 5234.50 = 19765.50 left.
    expect(await screen.findByText("বাকি: ৳১৯,৭৬৫.৫")).toBeInTheDocument();
  });

  it("editing a category limit PUTs the whole cats map", async () => {
    const state = baseState();
    stubFetch(budgetHandler(state));
    renderWithProviders(<Budget />);
    const user = userEvent.setup();

    const food = await screen.findByLabelText("খাদ্য ও মুদি — সীমা (৳)");
    expect(food).toHaveValue("8000");
    await user.clear(food);
    await user.type(food, "9000");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(state.puts[0]).toEqual({
      url: "/api/v1/budgets",
      body: { cats: { food: "9000.00", transport: "1000.00" } },
    });
  });

  it("rejects a non-numeric limit with the local amount error", async () => {
    const state = baseState();
    stubFetch(budgetHandler(state));
    renderWithProviders(<Budget />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("মাসিক বাজেট (৳)");
    await user.clear(input);
    await user.type(input, "abc");
    await user.tab();

    expect(await screen.findByText(/পরিমাণ লিখুন|Enter a valid amount/)).toBeInTheDocument();
    expect(state.puts).toHaveLength(0);
  });

  it("month switcher refetches with the shifted ?ym=", async () => {
    const state = baseState();
    stubFetch(budgetHandler(state));
    renderWithProviders(<Budget />);
    const user = userEvent.setup();

    await screen.findByLabelText("মাসিক বাজেট (৳)");
    const firstYm = state.ym;
    await user.click(screen.getByRole("button", { name: "আগের মাস" }));

    await waitFor(() => expect(state.gets.length).toBeGreaterThan(1));
    expect(state.gets.at(-1)).toContain(`ym=${shiftYm(firstYm, -1)}`);
  });
});
