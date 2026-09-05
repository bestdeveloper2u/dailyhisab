import { useEffect, useMemo, useState } from "react";
import { moneyToNumber, t } from "@khoroch/core";
import type { Budget } from "@khoroch/api-client";
import { useBudget, useBudgetMutation } from "../lib/queries";
import { groupName, monthLabel, normalizeAmount, shiftYm, todayIso, ymOfIso } from "../lib/catalog";
import { w } from "../lib/web-i18n";
import { fmtTaka } from "../lib/money";
import { usePageTitle } from "../lib/usePageTitle";
import { useLangStore } from "../store/lang";
import { toast } from "../lib/toast";

/** Prototype tag rule: ≤75% good, ≤100% warn, above over. */
function budgetTag(pct: number, lang: "bn" | "en"): { label: string; cls: string } {
  if (pct > 100) return { label: w(lang, "budOver"), cls: "bg-danger/10 text-danger" };
  if (pct > 75) return { label: w(lang, "budWarn"), cls: "bg-warning/10 text-warning" };
  return { label: w(lang, "budGood"), cls: "bg-emerald-soft text-emerald" };
}

/** Month stepper identical in spirit to the report screen's. */
function PeriodSwitch({
  label,
  onPrev,
  onNext,
  lang,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  lang: "bn" | "en";
}) {
  return (
    <div className="mt-4 flex items-center justify-between rounded-card border border-line bg-surface px-2 py-1.5 shadow-card">
      <button
        type="button"
        aria-label={w(lang, "prevMonth")}
        onClick={onPrev}
        className="rounded-control px-3 py-1.5 text-lg text-muted hover:bg-surface-2"
      >
        ‹
      </button>
      <span className="text-[15px] font-bold">{label}</span>
      <button
        type="button"
        aria-label={w(lang, "nextMonth")}
        onClick={onNext}
        className="rounded-control px-3 py-1.5 text-lg text-muted hover:bg-surface-2"
      >
        ›
      </button>
    </div>
  );
}

/**
 * Total budget card: editable limit input (PUT {total} on blur/Enter),
 * usage bar (danger past 100%) and spent/left chips.
 */
function TotalCard({ budget, lang }: { budget: Budget; lang: "bn" | "en" }) {
  const { put } = useBudgetMutation();
  const [total, setTotal] = useState(moneyToNumber(budget.total).toString());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTotal(moneyToNumber(budget.total).toString());
  }, [budget.ym, budget.total]);

  const spentNum = moneyToNumber(budget.spent);
  const totalNum = moneyToNumber(budget.total);
  // Backend guards the 0-budget division; compare directly for the over state.
  const over = totalNum === 0 ? spentNum > 0 : budget.usage_pct > 100;
  const displayPct = totalNum === 0 ? (spentNum > 0 ? 100 : 0) : Math.min(budget.usage_pct, 100);
  const left = Math.max(totalNum - spentNum, 0);

  function saveTotal() {
    const normalized = normalizeAmount(total);
    if (!normalized) {
      setError(w(lang, "errAmt"));
      return;
    }
    setError(null);
    put.mutate(
      { total: normalized },
      {
        onSuccess: (res) => {
          if (!res.ok) setError(res.detail || w(lang, "budErrSave"));
          else toast(t(lang, "savedCheck"));
        },
        onError: () => setError(w(lang, "budErrSave")),
      },
    );
  }

  return (
    <div className="mt-4 max-w-[520px] rounded-card border border-line bg-surface p-5 shadow-card">
      <label htmlFor="budTotal" className="text-[13px] font-medium text-muted">
        {w(lang, "budMonthly")}
      </label>
      <input
        id="budTotal"
        type="text"
        inputMode="decimal"
        value={total}
        onChange={(e) => setTotal(e.target.value)}
        onBlur={saveTotal}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-2xl font-bold tabular-nums text-ink focus:border-emerald focus:outline-none"
      />
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuenow={Math.round(budget.usage_pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={w(lang, "budVsLimit")}
      >
        <div
          className={`h-full rounded-full ${over ? "bg-danger" : "bg-emerald"}`}
          style={{ width: `${Math.max(displayPct, spentNum > 0 ? 2 : 0)}%` }}
        />
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <span className="rounded-full border border-line px-2.5 py-1 text-xs font-semibold tabular-nums text-ink">
          {w(lang, "spentLbl")}: {fmtTaka(budget.spent, lang)} ({Math.round(budget.usage_pct)}
          %)
        </span>
        <span
          className={`rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums ${
            over ? "border-danger text-danger" : "border-line text-ink"
          }`}
        >
          {over
            ? `${w(lang, "overLim")} ${fmtTaka(spentNum - totalNum, lang)}`
            : `${w(lang, "leftLbl")}: ${fmtTaka(left, lang)}`}
        </span>
      </div>
      {error && (
        <p className="mt-2 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** One category row: name + status tag, spent/limit, usage bar, limit input. */
function CatRow({ budget, cat, usage }: { budget: Budget; cat: string; usage: { budget: string; spent: string; usage_pct: number } }) {
  const lang = useLangStore((s) => s.lang);
  const { put } = useBudgetMutation();
  const [limit, setLimit] = useState(
    moneyToNumber(budget.cats[cat] ?? "0") > 0 ? moneyToNumber(budget.cats[cat] ?? "0").toString() : "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = budget.cats[cat] ?? "0";
    setLimit(moneyToNumber(stored) > 0 ? moneyToNumber(stored).toString() : "");
  }, [budget.ym, budget.cats, cat]);

  const spentNum = moneyToNumber(usage.spent);
  const limitNum = moneyToNumber(usage.budget);
  const over = limitNum === 0 ? spentNum > 0 : usage.usage_pct > 100;
  const tag = budgetTag(limitNum === 0 ? (spentNum > 0 ? 101 : 0) : usage.usage_pct, lang);

  function saveCat() {
    if (limit === "") return; // cleared box = keep as-is; only explicit values PUT
    const normalized = normalizeAmount(limit);
    if (!normalized) {
      setError(w(lang, "errAmt"));
      return;
    }
    setError(null);
    const cats: Record<string, string> = { ...budget.cats, [cat]: normalized };
    put.mutate(
      { cats },
      {
        onSuccess: (res) => {
          if (!res.ok) setError(res.detail || w(lang, "budErrSave"));
          else toast(t(lang, "savedCheck"));
        },
        onError: () => setError(w(lang, "budErrSave")),
      },
    );
  }

  return (
    <div className="border-b border-line px-4 py-3 last:border-none">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {groupName(cat, lang)}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${tag.cls}`}>
          {tag.label}
        </span>
        <span className="text-[13px] font-semibold tabular-nums text-ink">
          {fmtTaka(usage.spent, lang)} / {fmtTaka(usage.budget, lang)}
        </span>
        <input
          type="text"
          inputMode="decimal"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          onBlur={saveCat}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={w(lang, "budCatPh")}
          aria-label={`${groupName(cat, lang)} — ${w(lang, "budCatPh")}`}
          className="w-24 rounded-control border border-line bg-surface px-2 py-1.5 text-right text-sm tabular-nums text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
        />
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full ${over ? "bg-danger" : "bg-emerald"}`}
          style={{
            width: `${over ? 100 : Math.max(usage.usage_pct, spentNum > 0 ? 2 : 0)}%`,
          }}
        />
      </div>
      {error && (
        <p className="mt-1 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Budget screen (বাজেট): monthly limit vs spend for the picked month with a
 * total usage bar and per-category budgets — PUT /budgets on every edit.
 */
export function Budget() {
  usePageTitle("বাজেট · Daily Hisab");
  const lang = useLangStore((s) => s.lang);
  const [ym, setYm] = useState(ymOfIso(todayIso()));
  const query = useBudget(ym);
  const budget = query.data?.ok ? query.data.data : null;

  // by_cat is the union of budgeted cats and cats with spend that month.
  const cats = useMemo(
    () => Object.entries(budget?.by_cat ?? {}).sort((a, b) => b[1].usage_pct - a[1].usage_pct),
    [budget],
  );

  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{t(lang, "navBudget")}</h1>
      <p className="mt-0.5 text-[13px] text-muted">
        {monthLabel(ym, lang)} — {w(lang, "budVsLimit")}
      </p>

      <PeriodSwitch
        label={monthLabel(ym, lang)}
        onPrev={() => setYm((m) => shiftYm(m, -1))}
        onNext={() => setYm((m) => shiftYm(m, 1))}
        lang={lang}
      />

      {query.isPending && (
        <p className="mt-5 text-sm text-muted" role="status">
          {w(lang, "loading")}
        </p>
      )}
      {query.isError && (
        <div
          className="mt-5 rounded-card border border-danger bg-danger/5 p-4 text-sm font-medium text-danger"
          role="alert"
        >
          {w(lang, "budErr")}
        </div>
      )}

      {budget && (
        <>
          <TotalCard key={budget.ym} budget={budget} lang={lang} />

          <h2 className="mt-6 px-1 text-[13px] font-bold text-muted">{w(lang, "budCatLbl")}</h2>
          {cats.length === 0 ? (
            <div className="mt-2 max-w-[520px] rounded-card border border-line bg-surface p-6 text-center shadow-card">
              <p className="text-sm font-semibold">{w(lang, "budNoCat")}</p>
            </div>
          ) : (
            <div className="mt-2 max-w-[520px] rounded-card border border-line bg-surface py-1 shadow-card">
              {cats.map(([cat, usage]) => (
                <CatRow key={`${budget.ym}-${cat}`} budget={budget} cat={cat} usage={usage} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
