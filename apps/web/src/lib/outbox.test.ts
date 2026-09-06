import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * T23.1 (ADR-0022) — offline expense outbox. The api-client module is
 * mocked (only the two create endpoints are replaced): the storage/flush
 * tests pin the queue CONTRACT against an injectable in-memory backend
 * (jsdom has no IndexedDB), and the hook tests pin the queries.ts wiring
 * (offline create → enqueue + optimistic rollback + "queued" toast; boot,
 * online-event and after-save flush triggers).
 */

const { createExpenseMock, bulkCreateMock } = vi.hoisted(() => ({
  createExpenseMock: vi.fn(),
  bulkCreateMock: vi.fn(),
}));

vi.mock("@khoroch/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@khoroch/api-client")>()),
  apiCreateExpense: createExpenseMock,
  apiBulkCreateExpenses: bulkCreateMock,
}));

import {
  countOutbox,
  enqueueOutbox,
  flushOutbox,
  listOutbox,
  makeInMemoryOutboxBackend,
  OfflineQueuedError,
  offlineFlushedText,
  OutboxAutoFlush,
  removeOutbox,
  setOutboxBackendForTests,
  type OutboxFlushReport,
  type OutboxItem,
  type OutboxItemInput,
  type OutboxSendResult,
} from "./outbox";
import { useExpenseMutations } from "./queries";
import { subscribeToasts } from "./toast";
import { useLangStore } from "../store/lang";
import type { Expense, ExpenseCreateInput } from "@khoroch/api-client";

/** jsdom ships no IndexedDB — the production raw-IDB path must be a no-op. */
const IDB_ABSENT = typeof indexedDB === "undefined";

const BODY: ExpenseCreateInput = {
  amt: "890",
  cat: "মাছ",
  grp: "food",
  pay: "cash",
  iso: "2026-09-06",
  desc: "বাজার",
};

function baseItem(amt: string): OutboxItemInput {
  return { amt, cat: "চা", grp: "food", pay: "cash", iso: "2026-09-06", desc: null };
}

/** Send stub: accepts every row unless scripted otherwise. */
function okSend() {
  return vi.fn(async () => "ok" as const);
}

/** Let fire-and-forget promise chains settle without real timers. */
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/* ---------------- navigator.onLine mock plumbing ---------------- */

const onLineDescriptor =
  Object.getOwnPropertyDescriptor(window.navigator, "onLine") ??
  Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

/* ---------------- toast capture ---------------- */

let texts: string[] = [];
let unsubscribe: (() => void) | null = null;

/* ---------- expense cache seed (optimistic rollback) ---------- */

const EXISTING = {
  id: "e-existing",
  user_id: "u1",
  amt: "120.00",
  cat: "চা",
  grp: "food",
  pay: "cash",
  desc: null,
  iso: "2026-09-05",
  created_at: "2026-09-05T10:00:00Z",
} as Expense;

function seedExpenses(qc: QueryClient): void {
  qc.setQueryData(["expenses", "list", {}], {
    pages: [{ ok: true, data: { items: [EXISTING], next_cursor: null } }],
    pageParams: [null],
  });
}

type InvalidateSpyLike = { mock: { calls: Array<[opts?: { queryKey?: unknown[] }]> } };

function hookedClient() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  return { qc, invalidateSpy };
}

function invalidatedRoots(spy: InvalidateSpyLike): unknown[] {
  return spy.mock.calls.map((call) => call[0]?.queryKey?.[0]);
}

beforeEach(() => {
  texts = [];
  unsubscribe = subscribeToasts((state) => {
    if (state) texts.push(state.text);
  });
  useLangStore.setState({ lang: "bn" });
  createExpenseMock.mockReset();
  bulkCreateMock.mockReset();
});

afterEach(() => {
  unsubscribe?.();
  setOutboxBackendForTests(null);
  if (onLineDescriptor) Object.defineProperty(window.navigator, "onLine", onLineDescriptor);
  else Reflect.deleteProperty(window.navigator, "onLine");
  vi.restoreAllMocks();
});

describe("outbox queue (in-memory backend)", () => {
  it("(1) enqueue stamps queued_at and listOutbox returns FIFO-by-id rows", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);

    await enqueueOutbox(baseItem("10"));
    await enqueueOutbox(baseItem("20"));
    await enqueueOutbox(baseItem("30"));

    expect(await countOutbox()).toBe(3);
    const rows = await listOutbox();
    expect(rows.map((row) => row.amt)).toEqual(["10", "20", "30"]);
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
    for (const row of rows) {
      expect(row.cat).toBe("চা");
      expect(row.grp).toBe("food");
      expect(row.pay).toBe("cash");
      expect(row.desc).toBeNull();
      expect(Number.isNaN(Date.parse(row.queued_at))).toBe(false);
    }
    // Mutating a returned row must not corrupt the queue.
    rows[0].amt = "tampered";
    expect((await listOutbox())[0].amt).toBe("10");
  });

  it("(2) removeOutbox drops exactly the targeted row", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);

    for (const amt of ["1", "2", "3"]) await enqueueOutbox(baseItem(amt));
    const rows = await listOutbox();
    await removeOutbox(rows[1].id);

    expect(await countOutbox()).toBe(2);
    expect((await listOutbox()).map((row) => row.amt)).toEqual(["1", "3"]);
    // Removing an already-gone id is a safe no-op.
    await removeOutbox(rows[1].id);
    expect(await countOutbox()).toBe(2);
  });

  it("(3) every entry point is a silent no-op without a backend (jsdom idb missing)", async () => {
    setOutboxBackendForTests(null);
    expect(IDB_ABSENT).toBe(true); // the production raw-IDB path never runs here

    await enqueueOutbox(baseItem("890")); // must not throw
    expect(await listOutbox()).toEqual([]);
    expect(await countOutbox()).toBe(0);
    await removeOutbox(1); // must not throw

    const send = okSend();
    const report = await flushOutbox(send);
    expect(report).toEqual({ flushed: 0, skipped: 0, remaining: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("flushOutbox verdict semantics", () => {
  it("(4) all-ok flush removes every row and reports the flushed count", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    for (const amt of ["10", "20"]) await enqueueOutbox(baseItem(amt));

    const send = okSend();
    const report = await flushOutbox(send);

    expect(report).toEqual({ flushed: 2, skipped: 0, remaining: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await countOutbox()).toBe(0);
  });

  it("(5) a definite reject drops only the bad row (never retried, counted as skipped)", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    for (const amt of ["10", "BAD", "30"]) await enqueueOutbox(baseItem(amt));

    const send = vi.fn(async (entry: OutboxItem) =>
      entry.amt === "BAD" ? ("reject" as const) : ("ok" as const),
    );
    const report = await flushOutbox(send);

    expect(report).toEqual({ flushed: 2, skipped: 1, remaining: 0 });
    expect(send).toHaveBeenCalledTimes(3); // the reject did NOT stop the run
    expect(await listOutbox()).toEqual([]);
  });

  it("(6) the first network verdict stops the run and keeps the remainder FIFO", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    for (const amt of ["10", "20", "30"]) await enqueueOutbox(baseItem(amt));

    let call = 0;
    const send = vi.fn(async (): Promise<OutboxSendResult> => {
      call += 1;
      return call === 2 ? "network" : "ok";
    });
    const report = await flushOutbox(send);

    expect(report).toEqual({ flushed: 1, skipped: 0, remaining: 2 });
    expect(send).toHaveBeenCalledTimes(2); // stopped before row 3
    expect((await listOutbox()).map((row) => row.amt)).toEqual(["20", "30"]);
  });

  it("(7) concurrent flush calls share one single-flight run", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    for (const amt of ["1", "2", "3"]) await enqueueOutbox(baseItem(amt));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await gate;
      return "ok" as const;
    });

    const first = flushOutbox(send);
    const second = flushOutbox(send);
    expect(second).toBe(first); // same in-flight promise, not a second run
    release();

    const [reportA, reportB] = (await Promise.all([first, second])) as [
      OutboxFlushReport,
      OutboxFlushReport,
    ];
    expect(reportA).toEqual({ flushed: 3, skipped: 0, remaining: 0 });
    expect(reportB).toEqual(reportA);
    expect(send).toHaveBeenCalledTimes(3); // not 6
  });
});

describe("useExpenseMutations offline wiring", () => {
  function renderMutations(qc: QueryClient) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    return renderHook(() => useExpenseMutations(), { wrapper });
  }

  it("(8) offline create: queued on-device, optimistic row rolled back, offlineQueued toast", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    const { qc } = hookedClient();
    seedExpenses(qc);
    setOnline(false);
    createExpenseMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const { result } = renderMutations(qc);
    const err: unknown = await act(async () =>
      result.current.create.mutateAsync(BODY).catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(OfflineQueuedError);
    expect(backend.rows).toHaveLength(1);
    expect(backend.rows[0]).toMatchObject({ amt: "890", cat: "মাছ", desc: "বাজার" });

    // The optimistic temp row is gone — the cached list is exactly the seed.
    const [, data] = qc.getQueriesData<{
      pages: Array<{ data?: { items: Expense[] } }>;
    }>({ queryKey: ["expenses", "list"] })[0];
    expect((data?.pages[0]?.data?.items ?? []).map((item) => item.id)).toEqual(["e-existing"]);

    expect(texts).toContain("অফলাইনে আছেন — খরচটি ডিভাইসে জমা হয়েছে, ইন্টারনেট এলে যোগ হবে");
    expect(texts).not.toContain("সংরক্ষণ করা যায়নি — আবার চেষ্টা করুন");
  });

  it("(9) a network-level TypeError while navigator reports online is still queued", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    setOnline(true);
    createExpenseMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const { qc } = hookedClient();
    const { result } = renderMutations(qc);
    const err: unknown = await act(async () =>
      result.current.create.mutateAsync(BODY).catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(OfflineQueuedError);
    expect(await countOutbox()).toBe(1);
  });

  it("(10) online create is unchanged: no enqueue, no offline toast", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    setOnline(true);
    createExpenseMock.mockResolvedValue({ ok: true, data: { ...EXISTING, id: "e-live" } });

    const { qc } = hookedClient();
    const { result } = renderMutations(qc);
    await act(async () => {
      await result.current.create.mutateAsync(BODY);
    });

    expect(createExpenseMock).toHaveBeenCalledTimes(1);
    expect(await countOutbox()).toBe(0);
    expect(texts).not.toContain("অফলাইনে আছেন — খরচটি ডিভাইসে জমা হয়েছে, ইন্টারনেট এলে যোগ হবে");
  });

  it("(11) a successful online create flushes an already-queued row (after-save trigger)", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    setOnline(true);
    await enqueueOutbox(baseItem("45"));
    createExpenseMock.mockResolvedValue({ ok: true, data: { ...EXISTING, id: "e-live" } });

    const { qc, invalidateSpy } = hookedClient();
    const { result } = renderMutations(qc);
    await act(async () => {
      await result.current.create.mutateAsync(BODY);
    });

    await waitFor(() => expect(backend.rows).toHaveLength(0)); // create POST + flush POST
    expect(createExpenseMock).toHaveBeenCalledTimes(2);
    expect(texts).toContain(offlineFlushedText(1, "bn"));
    expect(invalidatedRoots(invalidateSpy as unknown as InvalidateSpyLike)).toEqual(
      expect.arrayContaining(["expenses", "reports"]),
    );
  });

  it("(12) offline bulkCreate queues each item individually with one shared toast", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    setOnline(false);
    bulkCreateMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const { qc } = hookedClient();
    const { result } = renderMutations(qc);
    const items = [baseItem("10"), baseItem("20"), baseItem("30")];
    const err: unknown = await act(async () =>
      result.current.bulkCreate.mutateAsync(items).catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(OfflineQueuedError);
    expect((await listOutbox()).map((row) => row.amt)).toEqual(["10", "20", "30"]);
    expect(texts).toContain("অফলাইনে আছেন — খরচটি ডিভাইসে জমা হয়েছে, ইন্টারনেট এলে যোগ হবে");
  });
});

describe("OutboxAutoFlush boot/online triggers", () => {
  it("(13) flushes on mount, on the window online event, and stops after unmount", async () => {
    const backend = makeInMemoryOutboxBackend();
    setOutboxBackendForTests(backend);
    createExpenseMock.mockResolvedValue({ ok: true, data: { ...EXISTING, id: "e-live" } });

    const { qc, invalidateSpy } = hookedClient();
    await enqueueOutbox(baseItem("50"));

    const view = render(
      createElement(QueryClientProvider, { client: qc }, createElement(OutboxAutoFlush)),
    );

    // Boot trigger: queued row consumed + bn-digit toast + invalidations.
    await waitFor(() => expect(backend.rows).toHaveLength(0));
    expect(createExpenseMock).toHaveBeenCalledTimes(1);
    expect(texts).toContain("১ টি অফলাইন খরচ যোগ হয়েছে");
    await waitFor(() =>
      expect(invalidatedRoots(invalidateSpy as unknown as InvalidateSpyLike)).toEqual(
        expect.arrayContaining(["expenses", "reports"]),
      ),
    );

    // Online event trigger (one row per toast: the same ১ message again).
    await enqueueOutbox(baseItem("60"));
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(backend.rows).toHaveLength(0));
    expect(createExpenseMock).toHaveBeenCalledTimes(2);
    expect(texts.filter((text) => text === "১ টি অফলাইন খরচ যোগ হয়েছে")).toHaveLength(2);

    // After unmount the online listener is gone — the row survives.
    view.unmount();
    await enqueueOutbox(baseItem("70"));
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await flushMicrotasks();
    expect(backend.rows).toHaveLength(1);
    expect(createExpenseMock).toHaveBeenCalledTimes(2);
  });
});
