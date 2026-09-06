import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Recurring as RecurringRule } from "@khoroch/api-client";
import { subscribeToasts } from "../lib/toast";
import { todayIso } from "../lib/catalog";
import { useLangStore } from "../store/lang";
import { Recurring } from "./Recurring";

/**
 * T16.4 — /recurring against the real api-client contract (ADR-0014):
 * list, run-now, active toggle, edit, and two-step delete all ride the
 * typed helpers, so the tests stub global fetch and assert the exact
 * requests/shapes the generated client emits.
 */

const RULE: RecurringRule = {
  id: "r1",
  cat: "বাসা ভাড়া",
  grp: "housing",
  amt: "8000.00",
  pay: "cash",
  desc: null,
  freq: "monthly",
  start_date: "2026-09-01",
  next_run: "2026-09-05",
  active: true,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  user_id: "u1",
};

interface Recorded {
  method: string;
  pathname: string;
  body?: unknown;
}

function stubApi(handler: (rec: Recorded) => Response | object | Promise<object>) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const pathname = new URL(req.url).pathname;
    let body: unknown;
    try {
      body = await req.clone().json();
    } catch {
      body = undefined;
    }
    const rec: Recorded = { method: req.method, pathname, body };
    calls.push(rec);
    const out = await handler(rec);
    if (out instanceof Response) return out;
    return Response.json(out);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** Stateful in-memory "server": the list reflects every mutation. */
function stubRecurringApi() {
  let items: RecurringRule[] = [{ ...RULE }];
  return stubApi(({ method, pathname, body }) => {
    if (method === "GET" && pathname === "/api/v1/recurring") {
      return { items, next_cursor: null };
    }
    if (method === "POST" && pathname === "/api/v1/recurring/run") {
      return { ran_on: "2026-09-05", created: 2, rules: 2, expenses: [] };
    }
    if (method === "POST" && pathname === "/api/v1/recurring") {
      const row: RecurringRule = {
        ...RULE,
        ...(body as Partial<RecurringRule>),
        id: "r2",
        active: true,
        next_run: (body as { start_date: string }).start_date,
      };
      items = [...items, row];
      return row;
    }
    if (method === "PATCH" && pathname === "/api/v1/recurring/r1") {
      const patch = body as Partial<RecurringRule>;
      items = items.map((r) => (r.id === "r1" ? { ...r, ...patch } : r));
      return items.find((r) => r.id === "r1") as RecurringRule;
    }
    if (method === "DELETE" && pathname === "/api/v1/recurring/r1") {
      items = items.filter((r) => r.id !== "r1");
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ detail: "not mocked" }), { status: 404 });
  });
}

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Recurring />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useLangStore.setState({ lang: "bn" });
});

describe("Recurring screen", () => {
  it("lists rules with amount, schedule and active badge", async () => {
    useLangStore.setState({ lang: "en" });
    stubRecurringApi();

    renderScreen();

    expect(await screen.findByText("বাসা ভাড়া")).toBeInTheDocument();
    expect(screen.getByText("৳8,000")).toBeInTheDocument();
    expect(screen.getByText(/Every month · Next/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "বাসা ভাড়া — Active" })).toBeChecked();
  });

  it("run-now posts to /recurring/run and toasts the created count", async () => {
    useLangStore.setState({ lang: "en" });
    const calls = stubRecurringApi();
    const seen: string[] = [];
    const unsubscribe = subscribeToasts((s) => s && seen.push(s.text));

    renderScreen();
    await screen.findByText("বাসা ভাড়া");

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.pathname === "/api/v1/recurring/run")).toBe(
        true,
      ),
    );
    await waitFor(() => expect(seen).toContain("2 expenses created ✓"));
    unsubscribe();
  });

  it("toggling the switch PATCHes active:false and re-renders paused", async () => {
    useLangStore.setState({ lang: "en" });
    const calls = stubRecurringApi();

    renderScreen();
    const sw = await screen.findByRole("switch", { name: "বাসা ভাড়া — Active" });
    fireEvent.click(sw);

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toEqual({ active: false });
    });
    expect(
      await screen.findByRole("switch", { name: "বাসা ভাড়া — Paused" }),
    ).not.toBeChecked();
  });

  it("creates a rule through the form with a normalized RecurringIn body", async () => {
    useLangStore.setState({ lang: "en" });
    const calls = stubRecurringApi();

    renderScreen();
    await screen.findByText("বাসা ভাড়া");

    fireEvent.click(screen.getByRole("button", { name: "New recurring" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "ইন্টারনেট" } });
    fireEvent.change(screen.getByLabelText("Amount (৳)"), { target: { value: "১০০০" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.pathname === "/api/v1/recurring",
      );
      expect(post?.body).toEqual({
        cat: "ইন্টারনেট",
        grp: "food",
        amt: "1000.00",
        pay: "cash",
        freq: "monthly",
        desc: null,
        start_date: todayIso(),
      });
    });
    // modal closes and the refetched list carries the new rule
    expect(await screen.findByText("ইন্টারনেট")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("edits a rule through the same dialog (PATCH with the new amount)", async () => {
    useLangStore.setState({ lang: "en" });
    const calls = stubRecurringApi();

    renderScreen();
    await screen.findByText("বাসা ভাড়া");

    fireEvent.click(screen.getByRole("button", { name: "বাসা ভাড়া — Edit" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Amount (৳)"), { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toMatchObject({ amt: "9000.00", cat: "বাসা ভাড়া" });
    });
    expect(await screen.findByText("৳9,000")).toBeInTheDocument();
  });

  it("delete is two-step and removes the rule", async () => {
    useLangStore.setState({ lang: "en" });
    const calls = stubRecurringApi();

    renderScreen();
    await screen.findByText("বাসা ভাড়া");

    fireEvent.click(screen.getByRole("button", { name: "বাসা ভাড়া — Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Sure?" }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === "DELETE" && c.pathname === "/api/v1/recurring/r1"),
      ).toBe(true);
    });
    expect(await screen.findByText("No recurring expenses yet")).toBeInTheDocument();
  });
});
