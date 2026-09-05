import { useMemo, useState } from "react";
import { moneyToNumber, t, toBnDigits } from "@khoroch/core";
import { useExpensesInfinite, useMonthlyReport, useYearlyReport } from "../lib/queries";
import {
  dayLabel,
  groupName,
  monthLabel,
  shiftYm,
  todayIso,
  ymOfIso,
} from "../lib/catalog";
import { w } from "../lib/web-i18n";
import { fmtTaka } from "../lib/money";
import { usePageTitle } from "../lib/usePageTitle";
import { useLangStore } from "../store/lang";

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-card">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-ink">{value}</p>
    </div>
  );
}

/** Horizontal share bars for by_group (bar = accent, amounts stay ink). */
function GroupBars({ byGroup, lang }: { byGroup: Record<string, string>; lang: "bn" | "en" }) {
  const entries = useMemo(
    () =>
      Object.entries(byGroup)
        .map(([g, amt]) => ({ g, amt, n: moneyToNumber(amt) }))
        .sort((a, b) => b.n - a.n),
    [byGroup],
  );
  const total = entries.reduce((s, e) => s + e.n, 0);
  if (entries.length === 0) {
    return <p className="py-2 text-sm text-muted">{w(lang, "noData")}</p>;
  }
  return (
    <ul className="flex flex-col">
      {entries.map(({ g, amt, n }) => (
        <li key={g} className="border-b border-line py-2.5 last:border-none">
          <div className="flex items-baseline gap-2 text-[13px]">
            <span className="flex-1 font-semibold">{groupName(g, lang)}</span>
            <span className="tabular-nums text-muted">
              {total > 0 ? `${Math.round((n / total) * 100)}%` : "—"}
            </span>
            <span className="font-bold tabular-nums text-ink">{fmtTaka(amt, lang)}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-emerald"
              style={{ width: total > 0 ? `${Math.max(2, (n / total) * 100)}%` : "0%" }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Vertical bars for by_day / by_month trends. */
function TrendBars({
  data,
  labelFor,
  ariaLabel,
}: {
  data: Array<{ key: string; amt: string }>;
  labelFor: (key: string) => string;
  ariaLabel: string;
}) {
  const lang = useLangStore((s) => s.lang);
  const values = data.map((d) => moneyToNumber(d.amt));
  const max = Math.max(1, ...values);
  if (data.length === 0) {
    return <p className="py-2 text-sm text-muted">{w(lang, "noData")}</p>;
  }
  return (
    <div className="flex h-36 items-end gap-1.5 px-1 pt-3" role="img" aria-label={ariaLabel}>
      {data.map((d, i) => (
        <div key={d.key} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
          <div
            title={fmtTaka(d.amt, lang)}
            className={`w-full max-w-8 rounded-t-md ${values[i] > 0 ? "bg-emerald" : "bg-surface-2"}`}
            style={{ height: `${Math.max(3, (values[i] / max) * 100)}%` }}
          />
          <span className="max-w-full truncate text-[10px] text-muted">{labelFor(d.key)}</span>
        </div>
      ))}
    </div>
  );
}

function PeriodSwitch({
  label,
  onPrev,
  onNext,
  prevAria,
  nextAria,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  prevAria: string;
  nextAria: string;
}) {
  return (
    <div className="mt-4 flex items-center justify-between rounded-card border border-line bg-surface px-2 py-1.5 shadow-card">
      <button
        type="button"
        aria-label={prevAria}
        onClick={onPrev}
        className="rounded-control px-3 py-1.5 text-lg text-muted hover:bg-surface-2"
      >
        ‹
      </button>
      <span className="text-[15px] font-bold">{label}</span>
      <button
        type="button"
        aria-label={nextAria}
        onClick={onNext}
        className="rounded-control px-3 py-1.5 text-lg text-muted hover:bg-surface-2"
      >
        ›
      </button>
    </div>
  );
}

function MonthlyView({ thisYm }: { thisYm: string }) {
  const lang = useLangStore((s) => s.lang);
  const [ym, setYm] = useState(thisYm);
  const query = useMonthlyReport(ym);

  const report = query.data?.ok ? query.data.data : null;
  const byDay = useMemo(
    () => (report?.by_day ?? []).map((d) => ({ key: d.iso, amt: d.total })),
    [report],
  );
  const topDay = byDay.length
    ? byDay.reduce((a, b) => (moneyToNumber(b.amt) > moneyToNumber(a.amt) ? b : a))
    : null;
  const topGroup = report
    ? Object.entries(report.by_group).sort((a, b) => moneyToNumber(b[1]) - moneyToNumber(a[1]))[0]
    : null;
  const daysWithSpend = report ? new Set(report.by_day.map((d) => d.iso)).size : 0;
  const dailyAvg =
    report && daysWithSpend > 0 ? moneyToNumber(report.total) / daysWithSpend : 0;

  return (
    <div>
      <PeriodSwitch
        label={monthLabel(ym, lang)}
        onPrev={() => setYm(shiftYm(ym, -1))}
        onNext={() => setYm(shiftYm(ym, 1))}
        prevAria={w(lang, "prevMonth")}
        nextAria={w(lang, "nextMonth")}
      />

      {query.isPending && (
        <p className="mt-5 text-sm text-muted" role="status">{w(lang, "loading")}</p>
      )}
      {query.isError && (
        <p className="mt-5 text-sm font-medium text-danger" role="alert">{w(lang, "errReport")}</p>
      )}

      {report && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label={w(lang, "totalSpend")} value={fmtTaka(report.total, lang)} />
            <Kpi
              label={w(lang, "entriesCount")}
              value={lang === "bn" ? toBnDigits(String(report.count)) : String(report.count)}
            />
            <Kpi label={w(lang, "dailyAvg")} value={fmtTaka(dailyAvg, lang)} />
            {topDay ? (
              <Kpi
                label={w(lang, "topDay")}
                value={`${dayLabel(topDay.key, lang)} · ${fmtTaka(topDay.amt, lang)}`}
              />
            ) : (
              <Kpi label={w(lang, "topDay")} value="—" />
            )}
          </div>

          <h2 className="mt-6 px-1 text-[13px] font-bold text-muted">{w(lang, "byDay")}</h2>
          <div className="mt-2 rounded-card border border-line bg-surface px-2 pb-3 pt-1 shadow-card">
            <TrendBars
              data={byDay}
              labelFor={(iso) => dayLabel(iso, lang)}
              ariaLabel={w(lang, "byDay")}
            />
          </div>

          <h2 className="mt-6 px-1 text-[13px] font-bold text-muted">{w(lang, "byGroup")}</h2>
          <div className="mt-2 rounded-card border border-line bg-surface px-4 py-2 shadow-card">
            <GroupBars byGroup={report.by_group} lang={lang} />
          </div>
          {topGroup && (
            <p className="sr-only">
              {w(lang, "topGroup")}: {groupName(topGroup[0], lang)}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function YearlyView({ thisYear }: { thisYear: number }) {
  const lang = useLangStore((s) => s.lang);
  const [year, setYear] = useState(thisYear);
  const query = useYearlyReport(year);
  // Matrix (prototype matrixLbl @769) aggregates group × month client-side
  // from the year's entries — the yearly API returns separate by_group /
  // by_month totals without the cross product.
  const listQ = useExpensesInfinite({
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    pageLimit: 200,
  });
  const rows = useMemo(
    () => listQ.data?.pages.flatMap((page) => (page.ok ? page.data.items : [])) ?? [],
    [listQ.data],
  );

  const report = query.data?.ok ? query.data.data : null;
  const byMonth = useMemo(
    () => (report?.by_month ?? []).map((m) => ({ key: m.ym, amt: m.total })),
    [report],
  );
  const topMonth = byMonth.length
    ? byMonth.reduce((a, b) => (moneyToNumber(b.amt) > moneyToNumber(a.amt) ? b : a))
    : null;
  const topGroup = report
    ? Object.entries(report.by_group).sort((a, b) => moneyToNumber(b[1]) - moneyToNumber(a[1]))[0]
    : null;
  const monthlyAvg = report ? moneyToNumber(report.total) / 12 : 0;

  // group × month cross product from the loaded entries (matrix table).
  const matrix = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
    const cells = new Map<string, number>(); // `${grp}|${ym}` → taka
    const colTotals = new Map<string, number>();
    const rowTotals = new Map<string, number>();
    for (const row of rows) {
      const ym = row.iso.slice(0, 7);
      const v = moneyToNumber(row.amt);
      const ck = `${row.grp}|${ym}`;
      cells.set(ck, (cells.get(ck) ?? 0) + v);
      colTotals.set(ym, (colTotals.get(ym) ?? 0) + v);
      rowTotals.set(row.grp, (rowTotals.get(row.grp) ?? 0) + v);
    }
    const groups = [...rowTotals.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
    return { months, cells, colTotals, rowTotals, groups };
  }, [rows, year]);

  const cellText = (v: number): string =>
    v === 0 ? "—" : lang === "bn" ? toBnDigits(String(Math.round(v))) : String(Math.round(v));

  return (
    <div>
      <PeriodSwitch
        label={lang === "bn" ? toBnDigits(String(year)) : String(year)}
        onPrev={() => setYear((y) => y - 1)}
        onNext={() => setYear((y) => y + 1)}
        prevAria={w(lang, "prevYear")}
        nextAria={w(lang, "nextYear")}
      />

      {query.isPending && (
        <p className="mt-5 text-sm text-muted" role="status">{w(lang, "loading")}</p>
      )}
      {query.isError && (
        <p className="mt-5 text-sm font-medium text-danger" role="alert">{w(lang, "errReport")}</p>
      )}

      {report && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label={w(lang, "totalSpend")} value={fmtTaka(report.total, lang)} />
            <Kpi
              label={w(lang, "entriesCount")}
              value={lang === "bn" ? toBnDigits(String(report.count)) : String(report.count)}
            />
            <Kpi label={w(lang, "monthlyAvg")} value={fmtTaka(monthlyAvg, lang)} />
            {topMonth ? (
              <Kpi
                label={w(lang, "topMonth")}
                value={`${monthLabel(topMonth.key, lang)} · ${fmtTaka(topMonth.amt, lang)}`}
              />
            ) : (
              <Kpi label={w(lang, "topMonth")} value="—" />
            )}
          </div>

          <h2 className="mt-6 px-1 text-[13px] font-bold text-muted">{w(lang, "trend")}</h2>
          <div className="mt-2 rounded-card border border-line bg-surface px-2 pb-3 pt-1 shadow-card">
            <TrendBars
              data={byMonth}
              labelFor={(ym) => monthLabel(ym, lang).split(" ")[0] ?? ym}
              ariaLabel={w(lang, "trend")}
            />
          </div>

          <h2 className="mt-6 px-1 text-[13px] font-bold text-muted">{w(lang, "byGroup")}</h2>
          <div className="mt-2 rounded-card border border-line bg-surface px-4 py-2 shadow-card">
            <GroupBars byGroup={report.by_group} lang={lang} />
          </div>
          {topGroup && (
            <p className="sr-only">
              {w(lang, "topGroup")}: {groupName(topGroup[0], lang)}
            </p>
          )}

          {/* matrix: গ্রুপভিত্তিক মাসিক ব্যয় (prototype matrixLbl @769) */}
          {matrix.groups.length > 0 && (
            <>
              <h2 className="mt-6 px-1 text-[13px] font-bold text-muted">{w(lang, "matrixLbl")}</h2>
              <div className="mt-2 overflow-x-auto rounded-card border border-line bg-surface shadow-card">
                <table className="w-full min-w-[640px] border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-line text-muted">
                      <th scope="col" className="sticky left-0 bg-surface px-3 py-2.5 text-left font-semibold">
                        {w(lang, "byGroup")}
                      </th>
                      {matrix.months.map((ym) => (
                        <th key={ym} scope="col" className="px-2.5 py-2.5 text-right font-semibold">
                          {monthLabel(ym, lang).split(" ")[0]}
                        </th>
                      ))}
                      <th scope="col" className="px-3 py-2.5 text-right font-bold text-ink">
                        {w(lang, "matrixTotal")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.groups.map((grp) => (
                      <tr key={grp} className="border-b border-line last:border-b-0">
                        <th scope="row" className="sticky left-0 bg-surface px-3 py-2 text-left font-semibold text-ink">
                          {groupName(grp, lang)}
                        </th>
                        {matrix.months.map((ym) => (
                          <td key={ym} className="px-2.5 py-2 text-right tabular-nums text-muted">
                            {cellText(matrix.cells.get(`${grp}|${ym}`) ?? 0)}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-right font-bold tabular-nums text-ink">
                          {cellText(matrix.rowTotals.get(grp) ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line bg-surface-2/50">
                      <th scope="row" className="sticky left-0 bg-surface px-3 py-2.5 text-left font-bold text-ink">
                        {w(lang, "matrixTotal")}
                      </th>
                      {matrix.months.map((ym) => (
                        <td key={ym} className="px-2.5 py-2.5 text-right font-bold tabular-nums text-ink">
                          {cellText(matrix.colTotals.get(ym) ?? 0)}
                        </td>
                      ))}
                      <td className="px-3 py-2.5 text-right font-extrabold tabular-nums text-ink">
                        {cellText(matrix.groups.reduce((s, g) => s + (matrix.rowTotals.get(g) ?? 0), 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {listQ.hasNextPage && (
                <p className="mt-1.5 px-1 text-xs text-muted">
                  {listQ.isFetchingNextPage
                    ? w(lang, "loading")
                    : `${w(lang, "loadMore")} → ${rows.length}+ ${w(lang, "entries")}`}
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Report screen: monthly (total, count, by_day, by_group) and yearly
 * (total, count, by_month, by_group) aggregates from the cached report API.
 */
export function Report() {
  usePageTitle("রিপোর্ট · Daily Hisab");
  const lang = useLangStore((s) => s.lang);
  const [mode, setMode] = useState<"monthly" | "yearly">("monthly");
  const today = todayIso();

  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{t(lang, "navReport")}</h1>
      <p className="mt-0.5 text-[13px] text-muted">{t(lang, "thisMonth")}</p>

      <div
        className="mt-3 inline-flex rounded-control bg-surface-2 p-1"
        role="group"
        aria-label={`${w(lang, "monthly")} / ${w(lang, "yearly")}`}
      >
        {(["monthly", "yearly"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-control px-4 py-1.5 text-[13px] font-bold ${
              mode === m ? "bg-surface text-ink shadow-card" : "text-muted"
            }`}
          >
            {w(lang, m)}
          </button>
        ))}
      </div>

      {mode === "monthly" ? (
        <MonthlyView thisYm={ymOfIso(today)} />
      ) : (
        <YearlyView thisYear={Number(today.slice(0, 4))} />
      )}
    </section>
  );
}
