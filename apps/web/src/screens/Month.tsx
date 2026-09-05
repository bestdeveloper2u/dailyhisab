import { useMemo, useState } from "react";
import { moneyToNumber, t, toBnDigits } from "@khoroch/core";
import { useExpensesInfinite, useMonthlyReport } from "../lib/queries";
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

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-card">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums text-ink">{value}</p>
    </div>
  );
}

/** ‹ month › switcher (prototype month-switch @731-735, mirrors PeriodSwitch). */
function MonthSwitch({ ym, setYm, lang }: { ym: string; setYm: (v: string) => void; lang: "bn" | "en" }) {
  return (
    <div className="mt-4 flex items-center justify-between rounded-card border border-line bg-surface px-2 py-1.5 shadow-card">
      <button
        type="button"
        aria-label={w(lang, "prevMonth")}
        onClick={() => setYm(shiftYm(ym, -1))}
        className="rounded-control px-3 py-1.5 text-lg text-muted hover:bg-surface-2"
      >
        ‹
      </button>
      <span className="text-[15px] font-bold">{monthLabel(ym, lang)}</span>
      <button
        type="button"
        aria-label={w(lang, "nextMonth")}
        onClick={() => setYm(shiftYm(ym, 1))}
        className="rounded-control px-3 py-1.5 text-lg text-muted hover:bg-surface-2"
      >
        ›
      </button>
    </div>
  );
}

/**
 * মাসিক হিসাব (prototype screen-month @720-755): 4 KPIs, month switcher,
 * total + previous-month comparison, the month's day-grouped entries and
 * group share bars — same aggregates the Dashboard uses, for any month.
 */
export function Month() {
  usePageTitle("মাসিক হিসাব · Daily Hisab");
  const lang = useLangStore((s) => s.lang);
  const [ym, setYm] = useState(ymOfIso(todayIso()));

  const reportQ = useMonthlyReport(ym);
  const prevQ = useMonthlyReport(shiftYm(ym, -1));
  const range = ymRange(ym);
  const listQ = useExpensesInfinite({ from: range.from, to: range.to, pageLimit: 50 });

  const report = reportQ.data?.ok ? reportQ.data.data : null;
  const prev = prevQ.data?.ok ? prevQ.data.data : null;
  const rows = useMemo(
    () => listQ.data?.pages.flatMap((page) => (page.ok ? page.data.items : [])) ?? [],
    [listQ.data],
  );

  const num = (v: string | null | undefined): number => Number(v ?? "0");

  const topDay = useMemo(
    () =>
      report?.by_day.length
        ? report.by_day.reduce((a, b) => (moneyToNumber(b.total) > moneyToNumber(a.total) ? b : a))
        : null,
    [report],
  );
  const topGroup = useMemo(
    () =>
      report
        ? Object.entries(report.by_group).sort((a, b) => num(b[1]) - num(a[1]))[0]
        : null,
    [report],
  );
  const daysWithSpend = report ? new Set(report.by_day.map((d) => d.iso)).size : 0;
  const dailyAvg =
    report && daysWithSpend > 0 ? moneyToNumber(report.total) / daysWithSpend : 0;

  // Day-grouped entries for the month list (prototype monthRows).
  const dayGroups = useMemo(() => {
    const groups: Array<{ iso: string; rows: typeof rows; sum: number }> = [];
    const index = new Map<string, { iso: string; rows: typeof rows; sum: number }>();
    for (const row of rows) {
      let g = index.get(row.iso);
      if (!g) {
        g = { iso: row.iso, rows: [], sum: 0 };
        index.set(row.iso, g);
        groups.push(g);
      }
      g.rows.push(row);
      g.sum += moneyToNumber(row.amt);
    }
    return groups;
  }, [rows]);

  const groupRows = useMemo(
    () =>
      report
        ? Object.entries(report.by_group)
            .sort(([, a], [, b]) => num(b) - num(a))
            .map(([g, amt]) => ({
              grp: g,
              amt,
              pct: num(report.total) > 0 ? (num(amt) / num(report.total)) * 100 : 0,
            }))
        : [],
    [report],
  );

  // Previous-month comparison (prototype prevCmp).
  const hasPrev = prev !== null && (num(prev.total) > 0 || prev.count > 0);
  const diffNum = hasPrev ? num(report?.total) - num(prev.total) : 0;
  const diffDown = diffNum < 0;
  const diffPct =
    hasPrev && num(prev.total) > 0 ? Math.abs((diffNum / num(prev.total)) * 100) : 0;

  const today = todayIso();

  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{t(lang, "navMonthly")}</h1>
      <p className="mt-0.5 text-[13px] text-muted">{w(lang, "monthSub")}</p>

      <MonthSwitch ym={ym} setYm={setYm} lang={lang} />

      {(reportQ.isPending || listQ.isPending) && (
        <p className="mt-5 text-sm text-muted" role="status">
          {w(lang, "loading")}
        </p>
      )}
      {reportQ.isError && (
        <div
          className="mt-5 rounded-card border border-danger bg-danger/5 p-4 text-sm font-medium text-danger"
          role="alert"
        >
          {w(lang, "errReport")}
        </div>
      )}

      {report && (
        <>
          {/* kpis (prototype kpis @724-729): entries / daily avg / top day / top group */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi
              label={w(lang, "entriesCount")}
              value={lang === "bn" ? toBnDigits(String(report.count)) : String(report.count)}
            />
            <Kpi label={w(lang, "dailyAvg")} value={fmtTaka(dailyAvg, lang)} />
            {topDay ? (
              <Kpi
                label={w(lang, "topDay")}
                value={`${dayLabel(topDay.iso, lang)} · ${fmtTaka(topDay.total, lang)}`}
              />
            ) : (
              <Kpi label={w(lang, "topDay")} value="—" />
            )}
            {topGroup ? (
              <Kpi
                label={w(lang, "topGroup")}
                value={`${groupName(topGroup[0], lang)} · ${fmtTaka(topGroup[1], lang)}`}
              />
            ) : (
              <Kpi label={w(lang, "topGroup")} value="—" />
            )}
          </div>

          {/* total + prev comparison (prototype total-card + prevCmp @737-743) */}
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-card border border-line bg-surface p-5 shadow-card">
              <span className="text-[13px] font-medium text-muted">
                {w(lang, "monthTotal")} · {monthLabel(ym, lang)}
              </span>
              <p className="mt-1 text-3xl font-extrabold tabular-nums text-ink">
                {fmtTaka(report.total, lang)}
              </p>
            </div>
            <div className="rounded-card border border-line bg-surface p-5 shadow-card">
              <span className="text-[13px] font-medium text-muted">
                {w(lang, "cmpTitle")}
              </span>
              {!hasPrev ? (
                <p className="mt-2 text-[13px] text-muted">{w(lang, "cmpNoPrev")}</p>
              ) : (
                <div className="mt-2 flex items-baseline gap-3">
                  <span className="text-sm tabular-nums text-muted">
                    {monthLabel(shiftYm(ym, -1), lang)}: {fmtTaka(prev?.total ?? "0.00", lang)}
                  </span>
                  <span
                    className={`text-lg font-extrabold tabular-nums ${
                      diffDown ? "text-emerald" : "text-danger"
                    }`}
                  >
                    {diffDown ? "↓" : "↑"} {fmtTaka(String(Math.abs(diffNum)), lang)}{" "}
                    <span className="text-xs font-bold">
                      ({diffDown ? "▼" : "▲"}{" "}
                      {lang === "bn" ? `${toBnDigits(diffPct.toFixed(1))}%` : `${diffPct.toFixed(1)}%`}{" "}
                      {diffDown ? w(lang, "cmpLess") : w(lang, "cmpMore")})
                    </span>
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* entries + group bars (prototype split2 @745-754) */}
          <div className="mt-[18px] grid items-start gap-6 lg:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-2 text-[12.5px] font-semibold tracking-wide text-muted">
                {w(lang, "allEntries")}
              </p>
              {rows.length === 0 ? (
                <div className="rounded-card border border-line bg-surface p-6 text-center shadow-card">
                  <p className="font-bold">{w(lang, "empty")}</p>
                  <p className="mt-1 text-sm text-muted">{w(lang, "emptyHint")}</p>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
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
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {listQ.hasNextPage && (
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => void listQ.fetchNextPage()}
                        disabled={listQ.isFetchingNextPage}
                        className="rounded-control border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2 disabled:opacity-60"
                      >
                        {listQ.isFetchingNextPage ? w(lang, "loading") : w(lang, "loadMore")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div>
              <p className="mb-2 text-[12.5px] font-semibold tracking-wide text-muted">
                {w(lang, "byGroup")}
              </p>
              <div className="rounded-card border border-line bg-surface px-4 py-2 shadow-card">
                {groupRows.length === 0 ? (
                  <p className="py-2 text-sm text-muted">{w(lang, "noData")}</p>
                ) : (
                  groupRows.map((r) => (
                    <div
                      key={r.grp}
                      className="flex flex-col gap-1 border-b border-line py-2.5 last:border-b-0"
                    >
                      <div className="flex items-center gap-2 text-[13.5px]">
                        <span className="min-w-0 flex-1 truncate font-semibold text-ink">
                          {groupName(r.grp, lang)}
                        </span>
                        <span className="text-[12.5px] tabular-nums text-muted">
                          {lang === "bn"
                            ? `${toBnDigits(r.pct.toFixed(1))}%`
                            : `${r.pct.toFixed(1)}%`}
                        </span>
                        <span className="font-bold tabular-nums text-ink">
                          {fmtTaka(r.amt, lang)}
                        </span>
                      </div>
                      <div className="h-[7px] overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-emerald"
                          style={{ width: `${Math.max(r.pct, 1.5)}%` }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
