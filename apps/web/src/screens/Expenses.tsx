import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useSearchParams } from "react-router";
import { useWindowVirtualizer, measureElement as defaultMeasureElement } from "@tanstack/react-virtual";
import { moneyToNumber, t, toBnDigits, type Lang } from "@khoroch/core";
import type { Expense, ExpenseCreateInput } from "@khoroch/api-client";
import { useExpensesInfinite, useExpenseMutations } from "../lib/queries";
import {
  dayLabel,
  groupName,
  monthLabel,
  payName,
  shiftYm,
  todayIso,
  ymOfIso,
  ymRange,
} from "../lib/catalog";
import { w } from "../lib/web-i18n";
import { fmtTaka } from "../lib/money";
import { usePageTitle } from "../lib/usePageTitle";
import { useLangStore } from "../store/lang";
import { downloadCsv, expensesToCsv } from "../lib/csv";
import { parseExpensesCsv, type ImportPreview } from "../lib/importCsv";
import { Modal } from "../components/Modal";
import { ExpenseForm } from "../components/ExpenseForm";
import { toast, toastWithAction } from "../lib/toast";
import { VoiceOverlay } from "../components/VoiceOverlay";
import {
  IconDownload,
  IconMic,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
} from "../components/icons";

/** How many month chips to offer either side of the current month. */
const MONTH_WINDOW = 6;

/**
 * T25.1 threshold-gated virtualization (TanStack Virtual v3,
 * https://tanstack.com/virtual/latest/docs/introduction). At or below this
 * many loaded rows the plain .map render stays byte-identical to the legacy
 * DOM (cheaper than virtualizer bookkeeping, and existing axe/playwright
 * snapshots see exactly the old tree); above it, the same header/row markup
 * renders through a window virtualizer so a 1,000+ row CSV import never
 * produces thousands of DOM nodes.
 */
const VIRTUAL_THRESHOLD = 60;
/** estimateSize seeds: day header ~44px, expense row ~56px (measureElement
 * corrects both to real layout heights as items mount). */
const HEADER_ESTIMATE_PX = 44;
const ROW_ESTIMATE_PX = 56;
const OVERSCAN = 8;

function monthChips(today: string): string[] {
  const thisYm = ymOfIso(today);
  return Array.from({ length: MONTH_WINDOW * 2 + 1 }, (_, i) =>
    shiftYm(thisYm, i - MONTH_WINDOW),
  );
}

interface DayGroup {
  iso: string;
  rows: Expense[];
  sum: number;
}

/**
 * Flat render-order entry feeding the virtualizer (T25.1): one header item
 * per day group followed by one item per expense row. Built from the
 * already-filtered `rows` (q + month chips are query params on
 * useExpensesInfinite), so the virtualized window never bypasses filtering.
 */
type ListEntry =
  | { kind: "header"; group: DayGroup }
  | { kind: "row"; row: Expense };

function groupByDay(rows: Expense[]): DayGroup[] {
  const groups: DayGroup[] = [];
  const index = new Map<string, DayGroup>();
  for (const row of rows) {
    let g = index.get(row.iso);
    if (!g) {
      g = { iso: row.iso, rows: [], sum: 0 };
      index.set(row.iso, g);
      groups.push(g);
    }
    g.rows.push(row);
    // Presentation-only sum (ADR-0004 §1: never a payload).
    g.sum += moneyToNumber(row.amt);
  }
  return groups;
}

/**
 * T22.1 single-tap delete (NN/g "Confirmation Dialogs"): instead of an
 * arm→confirm dialog, one ✕ tap deletes immediately and an UNDO toast offers
 * a ~6s window to re-create the identical row — reversible destruction is
 * friendlier than a modal, and the row never silently disappears.
 */
function DeleteButton({ expense }: { expense: Expense }) {
  const lang = useLangStore((s) => s.lang);
  const { remove, create } = useExpenseMutations();

  return (
    <button
      type="button"
      disabled={remove.isPending}
      aria-label={`${expense.cat} — ${w(lang, "remove")}`}
      onClick={() => {
        // Capture the FULL row payload BEFORE the delete request leaves —
        // undo must re-create the exact amount/date/group/method/note.
        const undoPayload: ExpenseCreateInput = {
          amt: expense.amt,
          cat: expense.cat,
          grp: expense.grp,
          pay: expense.pay,
          iso: expense.iso,
          desc: expense.desc ?? null,
        };
        remove.mutate(expense.id, {
          onSuccess: () => {
            toastWithAction(w(lang, "tDeletedUndo"), {
              label: w(lang, "undo"),
              onClick: () => {
                create
                  .mutateAsync(undoPayload)
                  .then(() => toast(w(lang, "tRestored")))
                  // create's onError already toasts tSaveErr; this replaces it
                  // with an undo-specific message a beat later.
                  .catch(() => toast(w(lang, "tRestoreFailed")));
              },
            });
          },
          onError: () => {
            // Delete failed → nothing changed, row stays, say so.
            toast(w(lang, "tDeleteFailed"));
          },
        });
      }}
      className="rounded-control p-2 text-muted hover:bg-surface-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-60"
    >
      <IconTrash className="h-4 w-4" />
    </button>
  );
}

/** Day-group header: label + presentation-only per-day sum (ADR-0004 §1).
 * Shared verbatim by the legacy and virtualized render paths. */
function DayGroupHeader({
  group,
  lang,
  today,
}: {
  group: DayGroup;
  lang: Lang;
  today: string;
}) {
  return (
    <div className="flex items-baseline justify-between px-1 py-1.5 text-[13px]">
      <span className="font-bold">
        {group.iso === today ? w(lang, "today") : dayLabel(group.iso, lang)}
      </span>
      <span className="font-semibold tabular-nums text-muted">
        {fmtTaka(group.sum, lang)}
      </span>
    </div>
  );
}

/** One expense row — identical markup/affordances (edit, single-tap delete)
 * in both render paths, so test queries (role/aria-label/text) are stable. */
function ExpenseRow({
  row,
  lang,
  onEdit,
}: {
  row: Expense;
  lang: Lang;
  onEdit: (row: Expense) => void;
}) {
  return (
    <li className="flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{row.cat}</p>
        <p className="truncate text-xs text-muted">
          {groupName(row.grp, lang)} · {payName(row.pay, lang)}
          {row.desc ? ` · ${row.desc}` : ""}
        </p>
      </div>
      <span className="text-sm font-bold tabular-nums text-ink">
        {fmtTaka(row.amt, lang)}
      </span>
      <button
        type="button"
        aria-label={`${row.cat} — ${w(lang, "edit")}`}
        onClick={() => onEdit(row)}
        className="rounded-control p-2 text-muted hover:bg-surface-2 hover:text-ink"
      >
        <IconPencil className="h-4 w-4" />
      </button>
      <DeleteButton expense={row} />
    </li>
  );
}

/**
 * Expense list screen: debounced search (?q=), month chips (?from=&to=),
 * keyset cursor pagination ("load more"), day-grouped rows with per-day
 * sums, inline edit/delete, and the voice/manual add flows.
 */
export function Expenses() {
  usePageTitle("খরচ তালিকা · Daily Hisab");
  const lang = useLangStore((s) => s.lang);
  const [searchParams, setSearchParams] = useSearchParams();
  const { bulkCreate } = useExpenseMutations();

  const [rawQ, setRawQ] = useState("");
  const [q, setQ] = useState("");
  const [month, setMonth] = useState<string | null>(null); // null = All
  const [formOpen, setFormOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  // Web Share Target intake (T23.2): text shared from another Android app,
  // passed to the voice overlay as initialText (cleared on overlay close so
  // a later manual reopen never re-applies the share).
  const [sharedText, setSharedText] = useState<string | null>(null);
  // CSV import (owner ask: sheet data must come IN, not only out).
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [editTarget, setEditTarget] = useState<Expense | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The shell FAB deep-links here with ?voice=1 / ?add=1. T23.2 adds the Web
  // Share Target intake (manifest share_target in vite.config.ts; feature
  // owner docs https://developer.chrome.com/docs/capabilities/web-apis/
  // web-share-target — Chrome/Android, installed-PWA-only, progressive
  // enhancement). A share GETs /expenses/?text=…&title=…: we only open +
  // prefill the voice overlay (the user still confirms — no blind creates)
  // and clear the params like the other deep links. Non-empty `text` beats
  // `title`; `url` is ignored on purpose (unsolicited links = spam vector).
  useEffect(() => {
    if (searchParams.get("voice") === "1") {
      setVoiceOpen(true);
      setSearchParams({}, { replace: true });
      return;
    }
    if (searchParams.get("add") === "1") {
      setFormOpen(true);
      setSearchParams({}, { replace: true });
      return;
    }
    const fromText = searchParams.get("text")?.trim() ?? "";
    const fromTitle = searchParams.get("title")?.trim() ?? "";
    const shared = (fromText || fromTitle).slice(0, 300);
    if (shared) {
      setSharedText(shared);
      setVoiceOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Debounce the search box into the actual ?q= filter (max 80 chars API-side).
  function onSearchChange(value: string) {
    setRawQ(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQ(value.trim().slice(0, 80)), 300);
  }
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const range = month ? ymRange(month) : undefined;
  const query = useExpensesInfinite({ q: q || undefined, from: range?.from, to: range?.to });

  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => (page.ok ? page.data.items : [])) ?? [],
    [query.data],
  );
  const loadedTotal = useMemo(
    () => rows.reduce((sum, row) => sum + moneyToNumber(row.amt), 0),
    [rows],
  );
  const dayGroups = useMemo(() => groupByDay(rows), [rows]);
  const chips = useMemo(() => monthChips(todayIso()), []);
  const today = todayIso();

  // T25.1: gate on TOTAL loaded rows (all pages), not per page — the point
  // is bounding DOM nodes for the whole screen.
  const virtualEnabled = rows.length > VIRTUAL_THRESHOLD;

  /** Flat header/row items in render order (see ListEntry). */
  const listEntries = useMemo<ListEntry[]>(() => {
    const entries: ListEntry[] = [];
    for (const group of dayGroups) {
      entries.push({ kind: "header", group });
      for (const row of group.rows) entries.push({ kind: "row", row });
    }
    return entries;
  }, [dayGroups]);

  const listRef = useRef<HTMLDivElement | null>(null);
  // Distance from page top to the list (official window-scroller pattern):
  // measured after mount; 0 on first paint is fine, the virtualizer
  // re-reads options on the next render pass.
  const listOffsetRef = useRef(0);
  useLayoutEffect(() => {
    listOffsetRef.current = listRef.current?.offsetTop ?? 0;
  }, []);

  // Hook runs unconditionally (count 0 = inert) so hook order is stable
  // across the threshold switch.
  const virtualizer = useWindowVirtualizer({
    count: virtualEnabled ? listEntries.length : 0,
    estimateSize: (i) =>
      listEntries[i]?.kind === "header" ? HEADER_ESTIMATE_PX : ROW_ESTIMATE_PX,
    overscan: OVERSCAN,
    scrollMargin: listOffsetRef.current,
    // measureElement keeps variable heights honest, EXCEPT when the element
    // reports no layout at all (jsdom/tests: offsetHeight 0) — then the
    // estimate stands instead of collapsing the item to 0px.
    measureElement: (element, entry, instance) => {
      const measured = defaultMeasureElement(element, entry, instance);
      return measured > 0
        ? measured
        : instance.options.estimateSize(instance.indexFromElement(element));
    },
    getItemKey: (i) => {
      const entry = listEntries[i];
      return entry?.kind === "header"
        ? `day:${entry.group.iso}`
        : `row:${entry?.row.id ?? i}`;
    },
  });

  function openEdit(row: Expense) {
    setEditTarget(row);
    setFormOpen(true);
  }

  const error = query.isError ? query.error : null;

  /** CSV of the loaded rows (prototype csvBtn @1358): toast started → download → done. */
  function handleExportCsv() {
    if (rows.length === 0) return;
    toast(w(lang, "csvStarted"));
    downloadCsv(expensesToCsv(rows, lang), "khoroch-expenses.csv");
    toast(w(lang, "csvDone"));
  }

  /** CSV আমদানি: read the picked file on-device → preview before saving. */
  async function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    try {
      const preview = parseExpensesCsv(await file.text());
      if (preview.items.length === 0) {
        toast(w(lang, "importNone"));
        return;
      }
      setImportPreview(preview);
    } catch {
      toast(w(lang, "importNone"));
    }
  }

  /**
   * Confirm import: save in chunks, then one final toast.
   * Chunk size MUST match the bulk endpoint cap (apps/api schemas/expense.py:
   * BulkExpensesIn.items max_length=50) — chunking larger silently 422s the
   * whole chunk and imports 0 rows (audit/t22x_audit.md P1-1).
   */
  async function confirmImport() {
    if (!importPreview || bulkCreate.isPending) return;
    const total = importPreview.items.length;
    const BULK_CHUNK = 50;
    let saved = 0;
    let failed = false;
    for (let i = 0; i < total; i += BULK_CHUNK) {
      try {
        const res = await bulkCreate.mutateAsync(importPreview.items.slice(i, i + BULK_CHUNK));
        if (!res.ok) {
          failed = true;
          break;
        }
        saved += res.data.length;
      } catch {
        failed = true;
        break;
      }
    }
    setImportPreview(null);
    if (failed && saved === 0) {
      // P3-1 (audit t22x): a failure must never wear the ✓ success glyph.
      toast(w(lang, "importFail"));
      return;
    }
    if (failed) {
      toast(
        lang === "bn"
          ? `⚠ ${toBnDigits(String(saved))} ${w(lang, "importDone")} — ${toBnDigits(String(total - saved))} ${w(lang, "importPartial")}`
          : `⚠ ${saved} ${w(lang, "importDone")} — ${total - saved} ${w(lang, "importPartial")}`,
      );
      return;
    }
    toast(
      lang === "bn"
        ? `✓ ${toBnDigits(String(saved))} ${w(lang, "importDone")}`
        : `✓ ${saved} ${w(lang, "importDone")}`,
    );
  }

  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{t(lang, "navExpenses")}</h1>
      <p className="mt-0.5 text-[13px] text-muted">{t(lang, "voiceHint")}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={rawQ}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={w(lang, "searchPh")}
            aria-label={w(lang, "searchPh")}
            className="w-full rounded-control border border-line bg-surface py-2.5 pl-9 pr-3 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="flex items-center gap-1.5 rounded-control bg-emerald px-3.5 py-2.5 text-sm font-bold text-accent-ink transition-[filter] hover:brightness-110"
        >
          <IconPlus className="h-4 w-4" />
          {t(lang, "addExpense")}
        </button>
        <button
          type="button"
          onClick={() => setVoiceOpen(true)}
          className="flex items-center gap-1.5 rounded-control border border-line bg-surface px-3.5 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2"
        >
          <IconMic className="h-4 w-4" />
          {w(lang, "voiceBtn")}
        </button>
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={rows.length === 0}
          aria-label={w(lang, "csvLabel")}
          className="flex items-center gap-1.5 rounded-control border border-line bg-surface px-3.5 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconDownload className="h-4 w-4" />
          {w(lang, "csvLabel")}
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label={w(lang, "importBtn")}
          className="flex items-center gap-1.5 rounded-control border border-line bg-surface px-3.5 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2"
        >
          <IconUpload className="h-4 w-4" />
          {w(lang, "importBtn")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => void onImportFile(e)}
          className="hidden"
        />
      </div>

      <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label={w(lang, "filterAll")}>
        <button
          type="button"
          onClick={() => setMonth(null)}
          aria-pressed={month === null}
          className={`whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${
            month === null
              ? "border-emerald bg-emerald-soft text-emerald"
              : "border-line bg-surface text-muted hover:bg-surface-2"
          }`}
        >
          {w(lang, "filterAll")}
        </button>
        {chips.map((ym) => (
          <button
            key={ym}
            type="button"
            onClick={() => setMonth(ym)}
            aria-pressed={month === ym}
            className={`whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${
              month === ym
                ? "border-emerald bg-emerald-soft text-emerald"
                : "border-line bg-surface text-muted hover:bg-surface-2"
            }`}
          >
            {monthLabel(ym, lang)}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-baseline justify-between text-[13px] text-muted">
        <span>
          {lang === "bn"
            ? `${toBnDigits(String(rows.length))} ${w(lang, "entries")}`
            : `${rows.length} ${w(lang, "entries")}`}
        </span>
        <span className="font-bold tabular-nums text-ink">
          {fmtTaka(loadedTotal, lang)}
        </span>
      </div>

      {query.isPending && (
        <p className="mt-5 text-sm text-muted" role="status">
          {w(lang, "loading")}
        </p>
      )}

      {error && (
        <div className="mt-5 rounded-card border border-danger bg-danger/5 p-4 text-sm font-medium text-danger" role="alert">
          {w(lang, "errLoad")}
        </div>
      )}

      {!query.isPending && rows.length === 0 && (
        <div className="mt-5 rounded-card border border-line bg-surface p-8 text-center shadow-card">
          <p className="font-bold">{w(lang, q || month ? "emptyFiltered" : "empty")}</p>
          <p className="mt-1 text-sm text-muted">{w(lang, "emptyHint")}</p>
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-control bg-emerald px-4 py-2.5 text-sm font-bold text-accent-ink hover:brightness-110"
          >
            <IconPlus className="h-4 w-4" />
            {t(lang, "addExpense")}
          </button>
        </div>
      )}

      {/*
        T25.1 threshold gate. Legacy path (rows <= VIRTUAL_THRESHOLD) is the
        exact pre-virtualization DOM. Virtual path (rows > threshold) renders
        the SAME DayGroupHeader/ExpenseRow markup as absolutely-positioned
        items inside a total-size spacer — the page (window) is the scroller
        (AppShell <main> has no overflow of its own), so this is
        useWindowVirtualizer and item starts are document coordinates minus
        the list's page offset (scrollMargin — official window-scroller
        pattern: tanstack.com/virtual latest docs, window example).
      */}
      {virtualEnabled ? (
        <div ref={listRef} data-virtualized="true" className="mt-3">
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const entry = listEntries[vi.index];
              if (!entry) return null;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{
                    transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
                  }}
                >
                  {entry.kind === "header" ? (
                    <DayGroupHeader group={entry.group} lang={lang} today={today} />
                  ) : (
                    <ul className="mb-1 flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
                      <ExpenseRow
                        row={entry.row}
                        lang={lang}
                        onEdit={openEdit}
                      />
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          {dayGroups.map((group) => (
            <div key={group.iso}>
              <DayGroupHeader group={group} lang={lang} today={today} />
              <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
                {group.rows.map((row) => (
                  <ExpenseRow key={row.id} row={row} lang={lang} onEdit={openEdit} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {query.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="rounded-control border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2 disabled:opacity-60"
          >
            {query.isFetchingNextPage ? w(lang, "loading") : w(lang, "loadMore")}
          </button>
        </div>
      )}

      <ExpenseForm
        key={editTarget?.id ?? "new"}
        open={formOpen}
        expense={editTarget}
        onClose={() => {
          setFormOpen(false);
          setEditTarget(null);
        }}
      />
      <VoiceOverlay
        open={voiceOpen}
        onClose={() => {
          setVoiceOpen(false);
          setSharedText(null);
        }}
        initialText={sharedText ?? undefined}
      />

      {/* CSV import preview: count + total before anything is saved. */}
      {importPreview && (
        <Modal open onClose={() => setImportPreview(null)} label={w(lang, "importTitle")}>
          <div className="flex flex-col gap-4 p-5">
            <h2 className="text-base font-bold">{w(lang, "importTitle")}</h2>
            <p className="text-sm text-muted">
              {lang === "bn"
                ? `${toBnDigits(String(importPreview.items.length))} ${w(lang, "importFound")}`
                : `${importPreview.items.length} ${w(lang, "importFound")}`}
            </p>
            <p className="text-lg font-bold tabular-nums text-ink">
              {w(lang, "importTotal")}:{" "}
              {fmtTaka(
                importPreview.items.reduce((s, it) => s + (Number(it.amt) || 0), 0),
                lang,
              )}
            </p>
            {importPreview.skipped > 0 && (
              <p className="text-xs font-semibold text-warning">
                {lang === "bn"
                  ? `${toBnDigits(String(importPreview.skipped))} ${w(lang, "importSkip")}`
                  : `${importPreview.skipped} ${w(lang, "importSkip")}`}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void confirmImport()}
                disabled={bulkCreate.isPending}
                className="h-11 flex-1 rounded-control bg-emerald font-bold text-accent-ink hover:brightness-110 disabled:opacity-60"
              >
                {bulkCreate.isPending
                  ? w(lang, "saving")
                  : `${w(lang, "importGo")} (${lang === "bn" ? toBnDigits(String(importPreview.items.length)) : importPreview.items.length})`}
              </button>
              <button
                type="button"
                onClick={() => setImportPreview(null)}
                className="h-11 rounded-control border border-line px-4 text-sm font-semibold text-muted hover:bg-surface-2"
              >
                {w(lang, "cancel")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
