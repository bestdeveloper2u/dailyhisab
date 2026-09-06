import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * T17.1 — boot-time recurring auto-run (ADR-0014 §3). The api-client module
 * is mocked wholesale: these tests pin the CONTRACT (fire once per local
 * day, optimistic stamp, toast + cache invalidation only on created > 0,
 * total silence on failure) not the HTTP plumbing.
 */

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock("@khoroch/api-client", () => ({ apiRunRecurring: runMock }));

import { RecurringAutoRun, recurringRunStampKey } from "./recurringRun";
import { subscribeToasts } from "./toast";
import { useLangStore } from "../store/lang";

function runOk(created: number) {
  return { ok: true as const, data: { ran_on: "2026-09-06", created, rules: created, expenses: [] } };
}

/** Let the fire-and-forget promise chain settle without real timers. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let unsubscribes: Array<() => void> = [];

function mountAutoRun() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const texts: string[] = [];
  unsubscribes.push(
    subscribeToasts((state) => {
      if (state) texts.push(state.text);
    }),
  );
  const view = render(
    <QueryClientProvider client={qc}>
      <RecurringAutoRun />
    </QueryClientProvider>,
  );
  return { qc, invalidateSpy, texts, view };
}

function invalidatedRoots(spy: unknown): unknown[] {
  const calls = (spy as { mock: { calls: Array<[opts?: { queryKey?: unknown[] }]> } })
    .mock.calls;
  return calls.map((call) => call[0]?.queryKey?.[0]);
}

beforeEach(() => {
  window.localStorage.clear();
  runMock.mockReset();
  useLangStore.setState({ lang: "bn" });
});

afterEach(() => {
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
  vi.restoreAllMocks();
});

describe("RecurringAutoRun (boot-time /recurring/run)", () => {
  it("(1) first mount fires POST once and writes the day stamp immediately", async () => {
    runMock.mockResolvedValue(runOk(0));
    const { texts } = mountAutoRun();

    // Optimistic stamp: present the moment the mount effect ran, before the
    // request even resolves.
    expect(window.localStorage.getItem(recurringRunStampKey())).toBe("1");
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith("bn");

    await flush();
    // created: 0 → silent, and nothing invalidated.
    expect(texts).toEqual([]);
  });

  it("(2) second mount on the same day does not fire again", async () => {
    runMock.mockResolvedValue(runOk(1));
    const first = mountAutoRun();
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    first.view.unmount();

    const second = mountAutoRun();
    await flush();
    expect(runMock).toHaveBeenCalledTimes(1); // stamp blocked the second run
    second.view.unmount();
  });

  it("(3) created > 0 → toast shown + expenses/reports/recurring invalidated", async () => {
    runMock.mockResolvedValue(runOk(3));
    const { texts, invalidateSpy } = mountAutoRun();

    await waitFor(() => expect(texts.length).toBeGreaterThan(0));
    expect(texts[0]).toBe("৩ টি আবর্তনশীল খরচ যোগ হয়েছে");
    expect(invalidatedRoots(invalidateSpy)).toEqual(
      expect.arrayContaining(["expenses", "reports", "recurring"]),
    );
  });

  it("(3b) en locale toasts the English wording", async () => {
    useLangStore.setState({ lang: "en" });
    runMock.mockResolvedValue(runOk(2));
    const { texts } = mountAutoRun();

    await waitFor(() => expect(texts.length).toBeGreaterThan(0));
    expect(texts[0]).toBe("2 recurring expenses added");
  });

  it("(3c) created = 0 stays silent (no toast, no invalidation)", async () => {
    runMock.mockResolvedValue(runOk(0));
    const { texts, invalidateSpy } = mountAutoRun();

    await flush();
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(texts).toEqual([]);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("(3d) an api-error result stays silent and keeps the optimistic stamp", async () => {
    runMock.mockResolvedValue({ ok: false, status: 500, detail: "boom" });
    const { texts, invalidateSpy } = mountAutoRun();

    expect(window.localStorage.getItem(recurringRunStampKey())).toBe("1");
    await flush();
    expect(texts).toEqual([]);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("(4) rejected request: no toast, no throw, stamp already written", async () => {
    runMock.mockRejectedValue(new Error("network down"));
    const { texts, invalidateSpy } = mountAutoRun();

    // The stamp must exist even though the promise never resolved.
    expect(window.localStorage.getItem(recurringRunStampKey())).toBe("1");

    await flush(); // an unhandled rejection here would fail the run
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(texts).toEqual([]);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("(5) a previous-day stamp does not block today's run", async () => {
    window.localStorage.setItem(recurringRunStampKey("2026-01-01"), "1");
    runMock.mockResolvedValue(runOk(1));
    mountAutoRun();

    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    // Old stamp untouched; today's stamp written.
    expect(window.localStorage.getItem(recurringRunStampKey("2026-01-01"))).toBe("1");
    expect(window.localStorage.getItem(recurringRunStampKey())).toBe("1");
  });

  it("renders nothing (no DOM noise in the authed tree)", () => {
    runMock.mockResolvedValue(runOk(0));
    const { view } = mountAutoRun();
    expect(view.container.textContent).toBe("");
  });
});
