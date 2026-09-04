import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiCreateDebt,
  apiDeleteDebt,
  apiGetBudget,
  apiListDebts,
  apiPayDebt,
  apiPutBudget,
  apiUpdateDebt,
} from "@khoroch/api-client";
import { makeResponse, stubFetch } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEBT = {
  id: "d1",
  user_id: "u",
  party: "করিম",
  dir: "lend" as const,
  amt: "890.00",
  iso: "2026-09-04",
  note: "বাজারের বাকি",
  settled_at: null,
  created_at: "2026-09-04T09:30:00Z",
};

describe("phase 3 debt endpoint helpers", () => {
  it("list: GET with status/limit/cursor query params", async () => {
    const fetchMock = stubFetch(() =>
      makeResponse(200, { items: [DEBT], next_cursor: "CUR2" }),
    );

    const res = await apiListDebts({ status: "settled", limit: 20, cursor: "abc" }, "bn");

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.items[0]!.party).toBe("করিম");
    const called = (fetchMock.mock.calls[0]![0] as Request).url;
    expect(called).toContain("/api/v1/debts?");
    expect(called).toContain("status=settled");
    expect(called).toContain("limit=20");
    expect(called).toContain("cursor=abc");
  });

  it("list: status defaults to open and cursor is omitted when absent", async () => {
    const fetchMock = stubFetch(() => makeResponse(200, { items: [], next_cursor: null }));

    await apiListDebts({ status: "open" }, "en");

    const called = (fetchMock.mock.calls[0]![0] as Request).url;
    expect(called).toContain("status=open");
    expect(called).not.toContain("cursor=");
  });

  it("create: POST with the decimal-string amount (201)", async () => {
    const fetchMock = stubFetch(() => makeResponse(201, DEBT));

    const res = await apiCreateDebt(
      { party: "করিম", dir: "lend", amt: "890.00", iso: "2026-09-04", note: "বাজারের বাকি" },
      "en",
    );

    expect(res.ok).toBe(true);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/api/v1/debts");
    expect(await req.json()).toEqual({
      party: "করিম",
      dir: "lend",
      amt: "890.00",
      iso: "2026-09-04",
      note: "বাজারের বাকি",
    });
  });

  it("update: PATCH to /debts/{id}", async () => {
    const fetchMock = stubFetch((_req, url) => {
      expect(url.pathname).toBe("/api/v1/debts/d1");
      return makeResponse(200, { ...DEBT, amt: "950.00" });
    });

    const res = await apiUpdateDebt("d1", { amt: "950.00" }, "en");

    expect(res.ok && res.data.amt === "950.00").toBe(true);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.method).toBe("PATCH");
  });

  it("delete: 204 → ok with null data", async () => {
    stubFetch((_req, url) => {
      expect(url.pathname).toBe("/api/v1/debts/d1");
      return makeResponse(204, null);
    });

    const res = await apiDeleteDebt("d1", "en");

    expect(res).toEqual({ ok: true, data: null });
  });

  it("pay: POST /debts/{id}/pay with {amt}; FULL carries the settled row", async () => {
    const fetchMock = stubFetch(() =>
      makeResponse(200, {
        status: "FULL",
        debt: { ...DEBT, settled_at: "2026-09-04T12:00:00Z" },
      }),
    );

    const res = await apiPayDebt("d1", "890.00", "en");

    expect(res.ok && res.data.status === "FULL").toBe(true);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.url).toContain("/api/v1/debts/d1/pay");
    expect(await req.json()).toEqual({ amt: "890.00" });
  });

  it("pay: PARTIAL returns the debt with the shrunken amount", async () => {
    stubFetch(() => makeResponse(200, { status: "PARTIAL", debt: { ...DEBT, amt: "390.00" } }));

    const res = await apiPayDebt("d1", "500.00", "en");

    expect(res.ok && res.data.status === "PARTIAL" && res.data.debt.amt === "390.00").toBe(true);
  });

  it("paying a settled debt surfaces the localized 409 debt_already_settled triple", async () => {
    stubFetch(() =>
      makeResponse(409, {
        detail: {
          code: "debt_already_settled",
          message_bn: "এই ধারটি আগেই পরিশোধ করা হয়েছে",
          message_en: "This debt is already settled",
        },
      }),
    );

    const bn = await apiPayDebt("d1", "100.00", "bn");
    const en = await apiPayDebt("d1", "100.00", "en");

    expect(bn).toMatchObject({ ok: false, status: 409, detail: "এই ধারটি আগেই পরিশোধ করা হয়েছে" });
    expect(en).toMatchObject({ ok: false, status: 409, detail: "This debt is already settled" });
  });

  it("unknown debt id surfaces the localized not_found triple", async () => {
    stubFetch(() =>
      makeResponse(404, {
        detail: { code: "not_found", message_bn: "ধারটি খুঁজে পাওয়া যায়নি", message_en: "Debt not found" },
      }),
    );

    const en = await apiDeleteDebt("missing", "en");

    expect(en).toMatchObject({ ok: false, status: 404, detail: "Debt not found" });
  });
});

describe("phase 3 budget endpoint helpers", () => {
  it("get: ?ym=YYYY-MM query param; omitted for the default month", async () => {
    const seen: string[] = [];
    stubFetch((_req, url) => {
      seen.push(`${url.pathname}${url.search}`);
      return makeResponse(200, {
        ym: "2026-09",
        total: "20000.00",
        cats: {},
        spent: "0.00",
        usage_pct: 0,
        by_cat: {},
      });
    });

    const explicit = await apiGetBudget("2026-09", "en");
    const current = await apiGetBudget(undefined, "en");

    expect(explicit.ok && current.ok).toBe(true);
    expect(seen[0]).toBe("/api/v1/budgets?ym=2026-09");
    expect(seen[1]).toBe("/api/v1/budgets");
  });

  it("put: upsert body with total and/or cats; returns the month view", async () => {
    const fetchMock = stubFetch(() =>
      makeResponse(200, {
        ym: "2026-09",
        total: "25000.00",
        cats: { food: "8000.00" },
        spent: "4234.50",
        usage_pct: 16.94,
        by_cat: { food: { budget: "8000.00", spent: "4234.50", usage_pct: 52.93 } },
      }),
    );

    const res = await apiPutBudget({ total: "25000.00", cats: { food: "8000.00" } }, "en");

    expect(res.ok && res.data.total === "25000.00").toBe(true);
    const req = fetchMock.mock.calls[0]![0] as Request;
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("/api/v1/budgets");
    expect(await req.json()).toEqual({ total: "25000.00", cats: { food: "8000.00" } });
  });
});
