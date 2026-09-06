import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useSearchParams } from "react-router";
import { moneyToNumber, t, toBnDigits } from "@khoroch/core";
import type { Expense } from "@khoroch/api-client";
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
import { toast } from "../lib/toast";
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

/** Two-step delete: first click arms, second click fires DELETE. */
function DeleteButton({ expense }: { expense: Expense }) {
  const lang = useLangStore((s) => s.lang);
  const { remove } = useExpenseMutations();
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        aria-label={`${expense.cat} — ${w(lang, "remove")}`}
        onClick={() => setArmed(true)}
        className="rounded-control p-2 text-muted hover:bg-surface-2 hover:text-danger"
      >
        <IconTrash className="h-4 w-4" />
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        disabled={remove.isPending}
        onClick={() =>
          remove.mutate(expense.id, {
            onSuccess: () => {
              setArmed(false);
              toast(w(lang, "tDeleted"));
            },
          })
        }
        className="rounded-control bg-danger px-2 py-1.5 text-xs font-bold text-accent-ink disabled:opacity-60"
      >
        {w(lang, "confirmDelete")}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        aria-label={w(lang, "cancel")}
        className="rounded-control px-1.5 py-1.5 text-xs font-semibold text-muted hover:bg-surface-2"
      >
        ✕
      </button>
    </span>
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
  // CSV import (owner ask: sheet data must come IN, not only out).
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [editTarget, setEditTarget] = useState<Expense | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The shell FAB deep-links here with ?voice=1 / ?add=1.
  useEffect(() => {
    if (searchParams.get("voice") === "1") {
      setVoiceOpen(true);
      setSearchParams({}, { replace: true });
    } else if (searchParams.get("add") === "1") {
      setFormOpen(true);
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

  /** Confirm import: save in 100-row batches, then one final toast. */
  async function confirmImport() {
    if (!importPreview || bulkCreate.isPending) return;
    let saved = 0;
    for (let i = 0; i < importPreview.items.length; i += 100) {
      try {
        const res = await bulkCreate.mutateAsync(importPreview.items.slice(i, i + 100));
        if (!res.ok) break;
        saved += res.data.length;
      } catch {
        break;
      }
    }
    setImportPreview(null);
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

      <div className="mt-3 flex flex-col gap-4">
        {dayGroups.map((group) => (
          <div key={group.iso}>
            <div className="flex items-baseline justify-between px-1 py-1.5 text-[13px]">
              <span className="font-bold">
                {group.iso === today ? w(lang, "today") : dayLabel(group.iso, lang)}
              </span>
              <span className="font-semibold tabular-nums text-muted">
                {fmtTaka(group.sum, lang)}
              </span>
            </div>
            <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
              {group.rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-3.5 py-3">
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
                    onClick={() => {
                      setEditTarget(row);
                      setFormOpen(true);
                    }}
                    className="rounded-control p-2 text-muted hover:bg-surface-2 hover:text-ink"
                  >
                    <IconPencil className="h-4 w-4" />
                  </button>
                  <DeleteButton expense={row} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

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
      <VoiceOverlay open={voiceOpen} onClose={() => setVoiceOpen(false)} />

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
