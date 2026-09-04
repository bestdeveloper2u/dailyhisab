import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toBnDigits } from "@khoroch/core";
import { Report } from "../src/screens/Report";
import { dayLabel, monthLabel } from "../src/lib/catalog";
import { makeResponse, renderWithProviders, resetLang, stubFetch, type RouteHandler } from "./helpers";

const after = () => vi.unstubAllGlobals();

beforeEach(resetLang);
afterEach(after);

/**
 * Report stub keyed off whatever ym/year the screen actually requests, so the
 * assertions hold regardless of the wall-clock date the test runs on.
 */
function reportHandler(state: { monthYm: string; year: string }): RouteHandler {
  return (_req, url) => {
    if (url.pathname === "/api/v1/reports/monthly") {
      state.monthYm = url.searchParams.get("ym") ?? "";
      return makeResponse(200, {
        ym: state.monthYm,
        total: "2340.50",
        count: 2,
        by_group: { food: "2340.50" },
        by_day: [
          { iso: `${state.monthYm}-04`, total: "2000.00" },
          { iso: `${state.monthYm}-05`, total: "340.50" },
        ],
      });
    }
    if (url.pathname === "/api/v1/reports/yearly") {
      state.year = url.searchParams.get("year") ?? "";
      return makeResponse(200, {
        year: Number(state.year),
        total: "32340.50",
        count: 12,
        by_group: { food: "20340.50", transport: "12000.00" },
        by_month: [
          { ym: `${state.year}-08`, total: "30000.00" },
          { ym: `${state.year}-09`, total: "2340.50" },
        ],
      });
    }
    return makeResponse(404, { detail: { code: "not_found", message_bn: "নেই", message_en: "missing" } });
  };
}

describe("Report screen", () => {
  it("renders the monthly report: KPIs, by-day bars, and by-group shares", async () => {
    const state = { monthYm: "", year: "" };
    stubFetch(reportHandler(state));
    renderWithProviders(<Report />);

    expect(screen.getByRole("heading", { name: "রিপোর্ট" })).toBeInTheDocument();

    // Default mode is monthly for the current month.
    expect(await screen.findByText("দিন অনুযায়ী")).toBeInTheDocument();
    expect(state.monthYm).toMatch(/^\d{4}-\d{2}$/);
    expect(screen.getByText(monthLabel(state.monthYm, "bn"))).toBeInTheDocument();

    // KPI row: total, entry count, top day.
    // Total KPI + the by-group bar amount both render this money string.
    expect(screen.getAllByText("৳২,৩৪০.৫০")).toHaveLength(2);
    expect(screen.getByText("২")).toBeInTheDocument();
    expect(
      screen.getByText(`${dayLabel(`${state.monthYm}-04`, "bn")} · ৳২,০০০`),
    ).toBeInTheDocument();
    // Daily average = 2340.50 over 2 active days.
    expect(screen.getByText("৳১,১৭০.২৫")).toBeInTheDocument();

    // By-group bars: single group → 100% share.
    expect(screen.getByText("খাদ্য ও মুদি")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("switches to the yearly report: KPIs, monthly trend, and by-group shares", async () => {
    const state = { monthYm: "", year: "" };
    stubFetch(reportHandler(state));
    renderWithProviders(<Report />);
    const user = userEvent.setup();

    await screen.findByText("দিন অনুযায়ী");
    await user.click(screen.getByRole("button", { name: "বার্ষিক" }));

    expect(await screen.findByText("মাসভিত্তিক ট্রেন্ড")).toBeInTheDocument();
    expect(state.year).toMatch(/^\d{4}$/);
    expect(screen.getByText(toBnDigits(state.year))).toBeInTheDocument();
    expect(screen.getByText("৳৩২,৩৪০.৫০")).toBeInTheDocument();
    expect(screen.getByText("১২")).toBeInTheDocument();
    expect(screen.getByText(`${monthLabel(`${state.year}-08`, "bn")} · ৳৩০,০০০`)).toBeInTheDocument();

    // Trend bar labels come from by_month keys.
    expect(screen.getByText("আগস্ট")).toBeInTheDocument();
    expect(screen.getByText("সেপ্টেম্বর")).toBeInTheDocument();

    // By-group shares, sorted by amount: food 63%, transport 37%.
    expect(screen.getByText("খাদ্য ও মুদি")).toBeInTheDocument();
    expect(screen.getByText("63%")).toBeInTheDocument();
    expect(screen.getByText("যাতায়াত")).toBeInTheDocument();
    expect(screen.getByText("37%")).toBeInTheDocument();
  });
});
