# ADR-0022: Offline expense creates queue in an app-level IndexedDB outbox, flushed by app-driven triggers

- Status: ACCEPTED (2026-09-06, cycle 23)
- Deciders: CTO (T23.1)
- Tags: pwa, offline, outbox, indexeddb, background-sync, zero-cost

## Context

The PWA shell already boots offline (vite-plugin-pwa precache, T9.1), but a
create made with no connectivity still failed with the generic
"couldn't save" toast — the typed amount was lost. For a daily-expense
ledger used in low-connectivity areas, "you typed it, you keep it" is a core
expectation: an offline create should survive until the network returns, then
post itself without the user re-entering anything.

The framework-shaped alternatives considered:

- **workbox-background-sync plugin** (SW-side queue): requires registering
  the queue inside the service worker. Our SW is `generateSW`-produced
  (zero custom SW code today); adopting the plugin means switching to
  `injectManifest`/custom SW — a build-config risk with its own cache-invalidations
  review, for a feature that is 90% app logic. Its replay trigger
  (`SyncManager`) is also Chromium-only; Safari/Firefox users would get
  nothing.
- **Pure Background Sync API registration**: same Chromium-only replay
  limitation, and the API only *hints* the SW to run — it is not a queue.

## Decision

An **app-level outbox** in `apps/web/src/lib/outbox.ts`:

- IndexedDB database `khoroch.outbox` v1, object store `queue`
  (`keyPath: "id"`, `autoIncrement: true`). Record = the six `ExpenseIn`
  fields + `queued_at`; FIFO order = ascending autoIncrement id (IDB's
  default key ordering — getAll() needs no index).
- `queries.ts` create/bulk mutations wrap the API call: when the browser
  reports offline (`navigator.onLine === false`) or the failure is a
  network-level `TypeError`, every item is enqueued and the mutation throws
  `OfflineQueuedError`; `onError` then rolls the optimistic row back and
  shows the bilingual "saved on this device, will be added when you're back
  online" toast instead of the save-failed one. Definite validation
  failures (4xx from a *reachable* server) keep today's exact behavior.
- `flushOutbox(send)` drains the queue FIFO: `'ok'` rows are removed;
  `'reject'` rows (definite 422/4xx — retrying bad data can never succeed)
  are dropped and counted as *skipped*; the first `'network'` verdict stops
  the run and keeps the remainder. Concurrent callers share a single-flight
  run, so boot + online-event + after-save triggers can never double-POST.
- Flush triggers: (a) authed boot — `<OutboxAutoFlush/>` mounted beside
  `RecurringAutoRun` in App.tsx, so it only runs with a live session;
  (b) the window `online` event (browser-only listener, removed on unmount);
  (c) a cheap attempt after every successful create/bulkCreate. Every
  trigger funnels through `flushOutboxWithUi`, which toasts the flushed
  count (bn digits localised) and invalidates the expenses+reports caches
  only when something actually landed.
- Flush POSTs reuse the same `apiCreateExpense` + lang context the
  mutations use, so queued rows are indistinguishable from online ones
  (same auth middleware, same 401-refresh path).
- Best-effort **Background Sync registration** (`registration.sync.register("khoroch-outbox")`,
  Chromium-only — MDN:
  https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
  is fire-and-forget next to the boot mount. This is REGISTRATION ONLY: the
  service-worker config is untouched this cycle (no `generateSW` switch), and
  every failure is swallowed — the app-driven online+boot flush is the
  universal fallback that works on all browsers.

## Consequences

- No new dependencies (raw `indexedDB` global) and no SW/build changes.
  Tests inject an in-memory backend (`setOutboxBackendForTests` /
  `makeInMemoryOutboxBackend`) because jsdom has no IndexedDB; every entry
  point is a silent no-op without storage (SSR, old browsers), degrading to
  today's behavior.
- Failure semantics are explicit: 422-style rejects are dropped (the queue
  never retries bad data), transport failures are retried on the next
  trigger, and a flush that loses connectivity mid-run keeps the unsent
  remainder in order. A crash between POST-accept and queue-remove can
  re-send one row (at-least-once, not exactly-once); for personal expenses
  a duplicated row is the acceptable direction versus silent data loss.
- Quota/private-mode enqueue failures are silent — the user simply gets the
  normal save-failed toast, exactly as today.
- If sync ever needs to run while the tab is closed (true background
  replay), the registered `'khoroch-outbox'` tag is the SW-side hook: a
  future `injectManifest` switch can add a sync listener that replays the
  same queue without any client-code change.
