import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiBulkCreateExpenses,
  apiCreateExpense,
  apiDeleteExpense,
  apiListExpenses,
  apiMonthlyReport,
  apiUpdateExpense,
  apiVoiceParse,
  apiYearlyReport,
} from "@khoroch/api-client";
import { makeResponse, stubFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("phase 2 endpoint helpers", () => {
  it("list: GET with query filters and pagination params", async () => {
    const fetchMock = stubFetch(() =>
      makeResponse(200, {
        items: [],
        next_cursor: "CUR1",
      }),
    );

    const res = await apiListExpenses(
      { q: "মাছ", from: "2026-09-01", to: "2026-09-30", limit: 20, cursor: "abc" },
      "bn",
    );

    expect(res.ok).toBe(true);
    const called = (fetchMock.mock.calls[0]![0] as Request).url;
    expect(called).toContain("q=%E0%A6%AE%E0%A6%BE%E0%A6%9B");
    expect(called).toContain("from=2026-09-01");
    expect(called).toContain("to=2026-09-30");
    expect(called).toContain("limit=20");
    expect(called).toContain("cursor=abc");
  });

  it("create: POST with the decimal-string amount", async () => {
    const fetchMock = stubFetch(() =>
      makeResponse(201, {
        id: "e1",
        cat: "বই",
        amt: "120.50",
        grp: "education",
        pay: "cash",
        desc: null,
        iso: "2026-09-04",
        user_id: "u",
        created_at: "2026-09-04T10:00:00Z",
      }),
    );

    const res = await apiCreateExpense(
      { amt: "120.50", cat: "বই", grp: "education", pay: "cash", iso: "2026-09-04", desc: null },
      "en",
    );

    expect(res.ok).toBe(true);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.method).toBe("POST");
    expect(await req.json()).toEqual({
      amt: "120.50",
      cat: "বই",
      grp: "education",
      pay: "cash",
      iso: "2026-09-04",
      desc: null,
    });
  });

  it("update: PATCH to /expenses/{id}", async () => {
    const fetchMock = stubFetch((_req, url) => {
      expect(url.pathname).toBe("/api/v1/expenses/e9");
      return makeResponse(200, { id: "e9", amt: "950.00" });
    });

    const res = await apiUpdateExpense("e9", { amt: "950.00" }, "en");

    expect(res.ok).toBe(true);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.method).toBe("PATCH");
  });

  it("delete: 204 → ok with null data", async () => {
    stubFetch((_req, url) => {
      expect(url.pathname).toBe("/api/v1/expenses/e9");
      return makeResponse(204, null);
    });

    const res = await apiDeleteExpense("e9", "en");

    expect(res).toEqual({ ok: true, data: null });
  });

  it("bulk: POST /expenses/bulk with the item array", async () => {
    const fetchMock = stubFetch(() =>
      makeResponse(201, { items: [{ id: "b1" }, { id: "b2" }] }),
    );

    const res = await apiBulkCreateExpenses(
      [
        { amt: "890.00", cat: "মাছ", grp: "food", pay: "cash", iso: "2026-09-04" },
        { amt: "200.00", cat: "চাল", grp: "food", pay: "cash", iso: "2026-09-04" },
      ],
      "en",
    );

    expect(res.ok && res.data).toHaveLength(2);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.url).toContain("/api/v1/expenses/bulk");
    expect(await req.json()).toEqual({
      items: [
        { amt: "890.00", cat: "মাছ", grp: "food", pay: "cash", iso: "2026-09-04" },
        { amt: "200.00", cat: "চাল", grp: "food", pay: "cash", iso: "2026-09-04" },
      ],
    });
  });

  it("voice parse: POST /voice/parse with {text}", async () => {
    const fetchMock = stubFetch(() => makeResponse(200, { items: [], confidence: 0.5 }));

    const res = await apiVoiceParse("মাছ ৮৯০ টাকা", "bn");

    expect(res.ok).toBe(true);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.url).toContain("/api/v1/voice/parse");
    expect(await req.json()).toEqual({ text: "মাছ ৮৯০ টাকা" });
  });

  it("reports: monthly ym and yearly year query params", async () => {
    const seen: string[] = [];
    stubFetch((_req, url) => {
      seen.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("monthly")) {
        return makeResponse(200, { ym: "2026-09", total: "0.00", count: 0, by_group: {}, by_day: [] });
      }
      return makeResponse(200, { year: 2026, total: "0.00", count: 0, by_group: {}, by_month: [] });
    });

    const monthly = await apiMonthlyReport("2026-09", "en");
    const monthlyDefault = await apiMonthlyReport(undefined, "en");
    const yearly = await apiYearlyReport(2026, "en");

    expect(monthly.ok && monthlyDefault.ok && yearly.ok).toBe(true);
    expect(seen[0]).toBe("/api/v1/reports/monthly?ym=2026-09");
    expect(seen[1]).toBe("/api/v1/reports/monthly");
    expect(seen[2]).toBe("/api/v1/reports/yearly?year=2026");
  });

  it("domain errors surface the localized {code,message_bn,message_en} triple", async () => {
    const detail = {
      code: "expense_not_found",
      message_bn: "খরচটি পাওয়া যায়নি",
      message_en: "Expense not found",
    };
    stubFetch(() => makeResponse(404, { detail }));

    const bn = await apiDeleteExpense("missing", "bn");
    const en = await apiDeleteExpense("missing", "en");

    expect(bn).toMatchObject({ ok: false, status: 404, detail: "খরচটি পাওয়া যায়নি" });
    expect(en).toMatchObject({ ok: false, status: 404, detail: "Expense not found" });
  });

  it("validation errors flatten the 422 detail array", async () => {
    stubFetch(() =>
      makeResponse(422, {
        detail: [{ msg: "Input should be a valid decimal", type: "decimal_parsing" }],
      }),
    );

    const res = await apiCreateExpense(
      { amt: "bogus", cat: "x", grp: "food", pay: "cash", iso: "2026-09-04" },
      "bn",
    );

    expect(res).toMatchObject({
      ok: false,
      status: 422,
      detail: "Input should be a valid decimal",
    });
  });
});
