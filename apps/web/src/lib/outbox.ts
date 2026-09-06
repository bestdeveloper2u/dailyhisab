/**
 * T23.1 (ADR-0022) — PWA offline expense OUTBOX.
 *
 * Expenses created while offline (or while the transport dies mid-flight)
 * are queued on-device in IndexedDB and flushed FIFO when connectivity
 * returns. Flush triggers: authed boot (<OutboxAutoFlush/>, mounted beside
 * RecurringAutoRun in App.tsx), the window `online` event, and a cheap
 * attempt after every successful create/bulkCreate. Best-effort Background
 * Sync is REGISTERED-ONLY (Chromium); the app-driven online+boot flush is
 * the universal fallback — see ADR-0022.
 *
 * Zero dependencies: raw IndexedDB via the `indexedDB` global, with an
 * injectable in-memory backend for tests (jsdom has no IDB). Every entry
 * point is no-op-safe when `indexedDB` or `navigator` are missing, so SSR
 * and old browsers degrade to "never queue, never flush".
 */
import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiCreateExpense, type ExpenseCreateInput, type Lang } from "@khoroch/api-client";
import { toBnDigits } from "@khoroch/core";

import { useLangStore } from "../store/lang";
import { toast } from "./toast";
import { w } from "./web-i18n";

/** One queued expense (mirror of ExpenseIn + an enqueue timestamp). The
 * grp/pay unions are DERIVED from the API input so a schema change here is
 * a compile error, not a 422 at flush time. */
export interface OutboxItem {
  amt: string;
  cat: string;
  grp: ExpenseCreateInput["grp"];
  pay: ExpenseCreateInput["pay"];
  iso: string;
  desc: string | null;
  queued_at: string;
}

/** A queued row as stored: OutboxItem + the autoIncrement primary key. */
export interface OutboxEntry extends OutboxItem {
  id: number;
}

/** The 6 user-visible fields a caller hands to enqueueOutbox. */
export type OutboxItemInput = Omit<OutboxItem, "queued_at">;

/** Verdict of one flush POST: stored / definite-reject / transport-down. */
export type OutboxSendResult = "ok" | "reject" | "network";

/** Flusher's transport — decoupled from api-client so tests stay offline. */
export type OutboxSend = (item: OutboxItem) => Promise<OutboxSendResult>;

export interface OutboxFlushReport {
  /** Entries accepted by the server and removed from the queue. */
  flushed: number;
  /** Entries dropped as definite 4xx-style rejects (never retried). */
  skipped: number;
  /** Entries still queued after this run (network-stopped or never sent). */
  remaining: number;
}

/**
 * Thrown by the create/bulk mutations when the expense was queued offline
 * instead of saved. queries.ts onError checks `instanceof` to swap the
 * "couldn't save" toast for the "queued until you're back online" one and
 * to roll the optimistic row back (the row will come back with a real id
 * after the flush invalidation).
 */
export class OfflineQueuedError extends Error {
  constructor() {
    super("offline: expense queued in the outbox, will flush on reconnect");
    this.name = "OfflineQueuedError";
  }
}

/* ------------------------------------------------------------------ *
 * Storage backends: production raw IndexedDB, tests in-memory array. *
 * ------------------------------------------------------------------ */

export interface OutboxBackend {
  add(item: OutboxItem): Promise<number>;
  list(): Promise<OutboxEntry[]>;
  remove(id: number): Promise<void>;
  count(): Promise<number>;
}

const DB_NAME = "khoroch.outbox";
const DB_VERSION = 1;
const STORE = "queue";

/** Injectable override (tests); null = production raw-IDB path. */
let backendOverride: OutboxBackend | null = null;

/**
 * Swap in an alternate backend. Pass null to restore the production
 * IndexedDB path. Test-only by name — the app never calls this.
 */
export function setOutboxBackendForTests(backend: OutboxBackend | null): void {
  backendOverride = backend;
}

/** Fresh in-memory backend (FIFO by insertion order) for tests. */
export function makeInMemoryOutboxBackend(): OutboxBackend & { rows: OutboxEntry[] } {
  let nextId = 1;
  const rows: OutboxEntry[] = [];
  return {
    rows,
    async add(item) {
      rows.push({ ...item, id: nextId });
      return nextId++;
    },
    async list() {
      return rows.map((row) => ({ ...row }));
    },
    async remove(id) {
      const at = rows.findIndex((row) => row.id === id);
      if (at !== -1) rows.splice(at, 1);
    },
    async count() {
      return rows.length;
    },
  };
}

function reqAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("outbox: idb request failed"));
  });
}

function openOutboxDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) {
        open.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("outbox: idb open failed"));
  });
}

/** Production backend: one reused connection, one tx per operation. */
const idbBackend: OutboxBackend = {
  async add(item) {
    const db = await openOutboxDb();
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      // autoIncrement keyPath → the new key is always a number.
      return (await reqAsPromise(store.add(item))) as number;
    } finally {
      db.close();
    }
  },
  async list() {
    const db = await openOutboxDb();
    try {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      // IDB's default key ordering IS ascending key → FIFO by id for free.
      return await reqAsPromise(store.getAll());
    } finally {
      db.close();
    }
  },
  async remove(id) {
    const db = await openOutboxDb();
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      await reqAsPromise(store.delete(id));
    } finally {
      db.close();
    }
  },
  async count() {
    const db = await openOutboxDb();
    try {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      return await reqAsPromise(store.count());
    } finally {
      db.close();
    }
  },
};

/** Active backend, or null when storage is unavailable (SSR / old browser). */
function activeBackend(): OutboxBackend | null {
  if (backendOverride) return backendOverride;
  return typeof indexedDB === "undefined" ? null : idbBackend;
}

/* ------------------------- *
 * Queue primitive API       *
 * ------------------------- */

/** Stamp queued_at and append. Silent no-op without a backend. */
export async function enqueueOutbox(item: OutboxItemInput): Promise<void> {
  const backend = activeBackend();
  if (!backend) return;
  try {
    await backend.add({ ...item, queued_at: new Date().toISOString() });
  } catch {
    // Quota/private-mode failure: the expense is simply not queued — the
    // caller's normal error path already told the user the save failed.
  }
}

/** Queued rows, FIFO by id. Never throws (missing storage → []). */
export async function listOutbox(): Promise<OutboxEntry[]> {
  const backend = activeBackend();
  if (!backend) return [];
  try {
    return await backend.list();
  } catch {
    return [];
  }
}

/** Remove one row by id. Silent no-op without a backend. */
export async function removeOutbox(id: number): Promise<void> {
  const backend = activeBackend();
  if (!backend) return;
  try {
    await backend.remove(id);
  } catch {
    // A stranded row is harmless: the next flush retries the POST, and the
    // server dedupes nothing — but expense re-send is the safer failure
    // direction here (missing data beats duplicated effort for the user).
  }
}

/** Queue depth (0 without a backend). */
export async function countOutbox(): Promise<number> {
  const backend = activeBackend();
  if (!backend) return 0;
  try {
    return await backend.count();
  } catch {
    return 0;
  }
}

/* ------------------------- *
 * Flush                     *
 * ------------------------- */

let inFlightFlush: Promise<OutboxFlushReport> | null = null;

/**
 * Drain the queue FIFO. 'ok' rows are removed; 'reject' rows (definite
 * 422/4xx — retrying bad data can never succeed) are dropped and counted
 * as skipped; the FIRST 'network' verdict stops the run and keeps the rest
 * for the next trigger. Concurrent callers share one single-flight run.
 */
export function flushOutbox(send: OutboxSend): Promise<OutboxFlushReport> {
  if (inFlightFlush) return inFlightFlush;
  inFlightFlush = runFlush(send).finally(() => {
    inFlightFlush = null;
  });
  return inFlightFlush;
}

async function runFlush(send: OutboxSend): Promise<OutboxFlushReport> {
  const backend = activeBackend();
  if (!backend) return { flushed: 0, skipped: 0, remaining: 0 };
  let flushed = 0;
  let skipped = 0;
  for (const entry of await backend.list()) {
    let verdict: OutboxSendResult;
    try {
      verdict = await send(entry);
    } catch {
      // A throwing transport is a transport problem, not bad data.
      verdict = "network";
    }
    if (verdict === "network") break;
    await backend.remove(entry.id);
    if (verdict === "ok") flushed++;
    else skipped++;
  }
  return { flushed, skipped, remaining: await backend.count() };
}

/* ------------------------------------------------------------------ *
 * Offline detection + mutation helpers (used by lib/queries.ts)      *
 * ------------------------------------------------------------------ */

/** True when the browser reports no connectivity (false on servers). */
export function isNavigatorOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** fetch() rejects with TypeError on DNS/socket/CORS-level failure. */
export function isNetworkLevelError(err: unknown): boolean {
  return err instanceof TypeError;
}

/** Should a failed create be queued instead of reported as lost? */
export function shouldQueueOffline(err: unknown): boolean {
  return isNavigatorOffline() || isNetworkLevelError(err);
}

/** Map an API create body to the queue record (desc: null when absent). */
export function toOutboxItem(body: ExpenseCreateInput): OutboxItemInput {
  return {
    amt: body.amt,
    cat: body.cat,
    grp: body.grp,
    pay: body.pay,
    iso: body.iso,
    desc: body.desc ?? null,
  };
}

/** Map a queue record back to the exact API body the server expects. */
export function toExpenseCreateInput(item: OutboxItem): ExpenseCreateInput {
  return {
    amt: item.amt,
    cat: item.cat,
    grp: item.grp,
    pay: item.pay,
    iso: item.iso,
    desc: item.desc,
  };
}

/** Flush POST path — same apiCreateExpense + lang the mutations use. */
function makeApiSend(lang: Lang): OutboxSend {
  return async (item) => {
    try {
      const res = await apiCreateExpense(toExpenseCreateInput(item), lang);
      return res.ok ? "ok" : "reject";
    } catch (err) {
      return isNetworkLevelError(err) ? "network" : "reject";
    }
  };
}

/** bn → "৩ টি অফলাইন খরচ যোগ হয়েছে" (digits localised like recurringRun). */
export function offlineFlushedText(n: number, lang: Lang): string {
  const count = lang === "bn" ? toBnDigits(String(n)) : String(n);
  return w(lang, "offlineFlushed").replace("{n}", count);
}

/**
 * One flush attempt + user-visible result: toast with the flushed count
 * and cache invalidation ONLY when something actually landed. Safe to
 * call anywhere (boot, online event, after-create) — a no-op flush is
 * silent and costs one IndexedDB read.
 */
export async function flushOutboxWithUi(qc: QueryClient, lang: Lang): Promise<OutboxFlushReport> {
  const report = await flushOutbox(makeApiSend(lang));
  if (report.flushed > 0) {
    toast(offlineFlushedText(report.flushed, lang));
    // The flush just created real server rows — same invalidation set as
    // the optimistic create path in lib/queries.ts.
    void qc.invalidateQueries({ queryKey: ["expenses"] });
    void qc.invalidateQueries({ queryKey: ["reports"] });
  }
  return report;
}

/* ------------------------------------------------------------------ *
 * Boot/online trigger — mounted beside RecurringAutoRun (App.tsx)    *
 * ------------------------------------------------------------------ */

/**
 * Mount-once side-effect host for the authed tree (ADR-0022 §Flush).
 * Attempts a flush on mount and on every window `online` event; the
 * listener exists only in the browser and is removed on unmount.
 * Renders nothing.
 */
export function OutboxAutoFlush(): null {
  const qc = useQueryClient();
  const lang = useLangStore((s) => s.lang);
  useEffect(() => {
    void flushOutboxWithUi(qc, lang);
    // Best-effort Chromium sync hint; failures are swallowed by design.
    registerOutboxBackgroundSync();
    if (typeof window === "undefined") return;
    const onOnline = (): void => {
      void flushOutboxWithUi(qc, lang);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [qc, lang]);
  return null;
}

/**
 * Best-effort Background Sync registration (Chromium-only; MDN:
 * https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API).
 * Registration ONLY — the SW config is untouched this cycle, and the
 * app-driven boot/online flush above is the universal fallback on every
 * browser. Every failure is silently ignored by design.
 */
export function registerOutboxBackgroundSync(): void {
  if (typeof navigator === "undefined") return;
  try {
    // Structurally typed: `registration.sync` (SyncManager) is Chromium-only
    // and missing from TS's DOM lib — `?.` is what keeps other browsers safe.
    type SyncCapableRegistration = { sync?: { register(tag: string): Promise<void> } };
    void navigator.serviceWorker?.ready
      .then((registration) => {
        const syncable = registration as SyncCapableRegistration;
        void syncable.sync?.register("khoroch-outbox").catch(() => {});
      })
      .catch(() => {});
  } catch {
    // No SW controller / unsupported → app-level triggers already cover it.
  }
}
