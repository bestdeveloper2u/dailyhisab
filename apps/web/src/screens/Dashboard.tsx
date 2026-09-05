import { formatTaka, toBnDigits, type Lang } from "@khoroch/core";
import { Link, useNavigate } from "react-router";
import { useBudget, useMonthlyReport, useYearlyReport } from "../lib/queries";
import {
  fullDateLabel,
  groupName,
  groupDot,
  monthLabel,
  shiftYm,
  shortMonthLabel,
  todayIso,
} from "../lib/catalog";
import { W } from "../lib/web-i18n";
import { useLangStore } from "../store/lang";

/** "YYYY-MM" for the current month, UTC — the API's ?ym= domain. */
function currentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

function fmtMoney(v: string, lang: Lang): string {
  return formatTaka(v, lang);
}

function fmtPct(p: number, lang: Lang): string {
  const s = p.toFixed(1);
  return lang === "bn" ? `${toBnDigits(s)}%` : `${s}%`;
}

/* ---------- stat card (prototype .card.stat) ---------- */

function StatCard({
  label,
  amount,
  delta,
  lang,
}: {
  label: string;
  amount: string;
  delta?: { down: boolean; pct: number } | null;
  lang: Lang;
}) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3.5 shadow-card">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p
        className={`mt-0.5 text-xl font-extrabold tabular-nums text-ink ${
          lang === "bn" ? "font-bn" : "font-en"
        }`}
      >
        {amount}
      </p>
      {delta !== undefined && delta !== null && (
        <p
          className={`mt-0.5 text-[11.5px] font-semibold tracking-tight ${
            delta.down ? "text-emerald" : "text-danger"
          }`}
        >
          {W[lang].vsPrev} {delta.down ? "↓" : "↑"}
          {fmtPct(delta.pct, lang)} {delta.down ? W[lang].cmpLess : W[lang].cmpMore}
        </p>
      )}
    </div>
  );
}

/* ---------- skeleton ---------- */

function Skeleton() {
  return (
    <div aria-hidden="true">
      <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-[86px] animate-pulse rounded-card border border-line bg-surface"
          />
        ))}
      </div>
      <div className="my-3.5 grid grid-cols-2 gap-2.5">
        {[0, 1].map((i) => (
          <div key={i} className="h-[50px] animate-pulse rounded-[14px] bg-surface-2" />
        ))}
      </div>
      <div className="mt-2 h-[110px] animate-pulse rounded-card border border-line bg-surface" />
      <div className="mt-3 h-[120px] animate-pulse rounded-card border border-line bg-surface" />
      <div className="mt-[18px] grid gap-6 lg:grid-cols-2">
        <div className="h-[200px] animate-pulse rounded-card border border-line bg-surface" />
        <div className="h-[150px] animate-pulse rounded-card border border-line bg-surface" />
      </div>
    </div>
  );
}

/* ---------- section label (prototype .section-label) ---------- */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[12.5px] font-semibold tracking-wide text-muted">
      {children}
    </p>
  );
}

export function Dashboard() {
  const lang = useLangStore((s) => s.lang);
  const navigate = useNavigate();

  const ym = currentYm();
  const prevYm = shiftYm(ym, -1);
  const year = Number(ym.slice(0, 4));
  const today = todayIso();

  const reportQ = useMonthlyReport(ym);
  const prevQ = useMonthlyReport(prevYm);
  const yearQ = useYearlyReport(year);
  const budgetQ = useBudget(ym);

  const report =
    reportQ.data !== undefined && reportQ.data.ok ? reportQ.data.data : undefined;
  const prev =
    prevQ.data !== undefined && prevQ.data.ok ? prevQ.data.data : undefined;
  const yearly =
    yearQ.data !== undefined && yearQ.data.ok ? yearQ.data.data : undefined;
  const budget =
    budgetQ.data !== undefined && budgetQ.data.ok ? budgetQ.data.data : undefined;

  const loading =
    reportQ.isLoading || prevQ.isLoading || yearQ.isLoading || budgetQ.isLoading;
  const failed =
    (reportQ.data !== undefined && !reportQ.data.ok) ||
    (budgetQ.data !== undefined && !budgetQ.data.ok);

  const retry = () => {
    void reportQ.refetch();
    void prevQ.refetch();
    void yearQ.refetch();
    void budgetQ.refetch();
  };

  const num = (v: string | undefined): number => Number(v ?? "0");

  // Today's total comes from the monthly report's by-day breakdown.
  const todayTotal =
    report?.by_day.find((d) => d.iso === today)?.total ?? "0.00";

  // Month-over-month delta (prototype updStatDelta).
  const delta =
    prev !== undefined && num(prev.total) > 0
      ? {
          down: num(report?.total) < num(prev.total),
          pct: Math.abs(
            (num(report?.total) - num(prev.total)) / num(prev.total) * 100,
          ),
        }
      : null;

  const hasPrevData = prev !== undefined && (num(prev.total) > 0 || prev.count > 0);
  const cmpDiffNum = hasPrevData ? num(report?.total) - num(prev.total) : 0;
  const cmpDown = cmpDiffNum < 0;
  const cmpPct =
    hasPrevData && num(prev.total) > 0
      ? Math.abs((cmpDiffNum / num(prev.total)) * 100)
      : 0;

  const groupRows =
    report === undefined
      ? []
      : Object.entries(report.by_group)
          .sort(([, a], [, b]) => num(b) - num(a))
          .map(([g, amt]) => ({
            grp: g,
            amt,
            pct: num(report.total) > 0 ? (num(amt) / num(report.total)) * 100 : 0,
          }));

  // Trend: only months that have data (prototype renderDashCharts).
  const trendBars = (yearly?.by_month ?? [])
    .filter((m) => num(m.total) > 0)
    .map((m) => ({ ym: m.ym, total: num(m.total) }));
  const trendMax = Math.max(...trendBars.map((t) => t.total), 1);

  const budgetLeftStr = budget
    ? (num(budget.total) - num(budget.spent)).toFixed(2)
    : "0.00";
  const budgetPct = Math.min(budget?.usage_pct ?? 0, 100);
  const budgetOver = (budget?.usage_pct ?? 0) > 100;

  return (
    <section>
      {/* Title: "আজ" + full Bengali date (prototype screen-dashboard) */}
      <h1 className="text-[22px] font-bold sm:text-2xl">{W[lang].today}</h1>
      <p className="mt-0.5 text-[13px] text-muted">{fullDateLabel(new Date(), lang)}</p>

      {loading ? (
        <Skeleton />
      ) : report === undefined || failed ? (
        <div className="mt-5 rounded-card border border-line bg-surface p-5 text-center shadow-card">
          <p className="text-sm text-muted">{W[lang].errLoad}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-control bg-emerald px-3.5 py-2 text-sm font-bold text-accent-ink transition-[filter] hover:brightness-110"
          >
            {W[lang].errRetry}
          </button>
        </div>
      ) : (
        <>
          {/* stat4: today / this month (+delta) / last month / year */}
          <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <StatCard
              label={W[lang].statToday}
              amount={fmtMoney(todayTotal, lang)}
              lang={lang}
            />
            <StatCard
              label={`${W[lang].statMonth} (${monthLabel(ym, lang).split(" ")[0]})`}
              amount={fmtMoney(report.total, lang)}
              delta={delta}
              lang={lang}
            />
            <StatCard
              label={`${W[lang].statPrev} (${monthLabel(prevYm, lang).split(" ")[0]})`}
              amount={fmtMoney(prev?.total ?? "0.00", lang)}
              lang={lang}
            />
            <StatCard
              label={`${W[lang].statYear} ${lang === "bn" ? toBnDigits(String(year)) : year}`}
              amount={fmtMoney(yearly?.total ?? "0.00", lang)}
              lang={lang}
            />
          </div>

          {/* quick actions (prototype quickrow) */}
          <div className="my-3.5 grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => navigate("/expenses?voice=1")}
              className="rounded-[14px] bg-emerald px-2.5 py-3 text-[14.5px] font-semibold text-accent-ink transition-transform active:scale-[0.97]"
            >
              🎙 {W[lang].voiceBtn}
            </button>
            <button
              type="button"
              onClick={() => navigate("/expenses?add=1")}
              className="rounded-[14px] border-[1.5px] border-dashed border-emerald bg-surface px-2.5 py-3 text-[14.5px] font-semibold text-emerald transition-transform active:scale-[0.97]"
            >
              ✏️ {W[lang].qaManual}
            </button>
          </div>

          {/* budget progress card (prototype total-card + bprog.big) */}
          <div className="mt-2 flex flex-col gap-1 rounded-card border border-line bg-surface p-5 shadow-card">
            {budget === undefined ? (
              <>
                <span className="text-[13px] font-medium text-muted">
                  {W[lang].noBudget}
                </span>
                <Link
                  to="/budget"
                  className="mt-1 w-fit text-sm font-semibold text-emerald hover:underline"
                >
                  {W[lang].setBudget} →
                </Link>
              </>
            ) : (
              <>
                <span className="text-[13px] font-medium text-muted">
                  {W[lang].budProg} — {monthLabel(ym, lang)} ({W[lang].limitLbl}{" "}
                  {fmtMoney(budget.total, lang)})
                </span>
                <div className="mt-2.5 h-3.5 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className={`h-full rounded-full ${
                      budgetOver ? "bg-danger" : "bg-emerald"
                    }`}
                    style={{ width: `${Math.max(budgetPct, budget.spent !== "0.00" ? 1.5 : 0)}%` }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] font-medium tabular-nums text-muted">
                    {t2(lang, "spent")}: {fmtMoney(budget.spent, lang)}
                  </span>
                  <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] font-medium tabular-nums text-muted">
                    {t2(lang, "budgetLeft")}: {fmtMoney(budgetLeftStr, lang)}
                  </span>
                  <span className="rounded-full bg-emerald-soft px-2.5 py-1 text-[12.5px] font-semibold text-emerald">
                    {W[lang].dataSafe} ✓
                  </span>
                </div>
              </>
            )}
          </div>

          {/* data banner (prototype sheet-banner, honest copy) */}
          <div className="mt-3 flex items-center gap-2.5 rounded-card bg-emerald-soft px-3.5 py-2.5 text-emerald">
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="shrink-0"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <div>
              <span className="text-[13.5px] font-semibold">{W[lang].dataSafe}</span>
              <span className="block text-xs font-normal text-muted">
                {W[lang].dataSafeSub}
              </span>
            </div>
          </div>

          {/* month comparison (prototype dashCmp) */}
          <div className="mt-3 rounded-card border border-line bg-surface p-4 shadow-card">
            <p className="text-[13.5px] font-semibold text-muted">{W[lang].cmpTitle}</p>
            {!hasPrevData ? (
              <p className="mt-1.5 text-[13px] text-muted">{W[lang].cmpNoPrev}</p>
            ) : (
              <div className="mt-2 grid grid-cols-1 gap-2.5 md:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold text-muted">
                    {W[lang].cmpThis} · {monthLabel(ym, lang)}
                  </p>
                  <p className="mt-0.5 text-[21px] font-extrabold tabular-nums text-ink">
                    {fmtMoney(report.total, lang)}
                  </p>
                  <p className="text-xs text-muted">
                    {report.count} {W[lang].entries}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted">
                    {W[lang].cmpPrev} · {monthLabel(prevYm, lang)}
                  </p>
                  <p className="mt-0.5 text-[21px] font-extrabold tabular-nums text-ink">
                    {fmtMoney(prev?.total ?? "0.00", lang)}
                  </p>
                  <p className="text-xs text-muted">
                    {prev?.count ?? 0} {W[lang].entries}
                  </p>
                </div>
                <div className="border-t border-dashed border-line pt-2 md:border-l md:border-t-0 md:pl-3 md:pt-0">
                  <p className="text-xs font-semibold text-muted">{W[lang].cmpDiff}</p>
                  <p
                    className={`mt-0.5 text-[21px] font-extrabold tabular-nums ${
                      cmpDown ? "text-emerald" : "text-danger"
                    }`}
                  >
                    {cmpDown ? "↓" : "↑"} {fmtMoney(String(Math.abs(cmpDiffNum)), lang)}
                  </p>
                  <p
                    className={`text-xs font-bold ${
                      cmpDown ? "text-emerald" : "text-danger"
                    }`}
                  >
                    {cmpDown ? "▼" : "▲"} {fmtPct(cmpPct, lang)}{" "}
                    {cmpDown ? W[lang].cmpLess : W[lang].cmpMore}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* split2: group bars + monthly trend (prototype) */}
          <div className="mt-[18px] grid items-start gap-6 lg:grid-cols-2">
            <div>
              <SectionLabel>{W[lang].byGroupMonth}</SectionLabel>
              <div className="rounded-card border border-line bg-surface p-4 shadow-card">
                {groupRows.length === 0 ? (
                  <p className="py-1.5 text-sm text-muted">{W[lang].empty}</p>
                ) : (
                  groupRows.map((r) => (
                    <div
                      key={r.grp}
                      className="flex flex-col gap-1 border-b border-line py-2.5 last:border-b-0"
                    >
                      <div className="flex items-center gap-2 text-[13.5px]">
                        <span className="flex flex-1 items-center gap-2 min-w-0 font-semibold text-ink">
                          <span
                            className="inline-block h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: groupDot(r.grp) }}
                          />
                          <span className="truncate">{groupName(r.grp, lang)}</span>
                        </span>
                        <span className="text-[12.5px] tabular-nums text-muted">
                          {fmtPct(r.pct, lang)}
                        </span>
                        <span className="font-bold tabular-nums text-ink">
                          {fmtMoney(r.amt, lang)}
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
            <div>
              <SectionLabel>{W[lang].trend}</SectionLabel>
              <div className="flex h-[150px] items-end gap-1.5 rounded-card border border-line bg-surface px-3.5 pb-2 pt-4 shadow-card">
                {trendBars.length === 0 ? (
                  <p className="w-full text-center text-sm text-muted">
                    {W[lang].noData}
                  </p>
                ) : (
                  trendBars.map((t) => (
                    <div
                      key={t.ym}
                      className="flex h-full flex-1 flex-col items-center justify-end gap-1.5"
                    >
                      <span className="text-[11px] tabular-nums text-muted">
                        {fmtMoney(String(t.total), lang)}
                      </span>
                      <div
                        className={`w-full max-w-[30px] rounded-t-md ${
                          t.total > 0 ? "bg-emerald opacity-90" : "bg-surface-2"
                        }`}
                        style={{ height: `${Math.max(8, (t.total / trendMax) * 100)}%` }}
                      />
                      <span className="text-[10.5px] text-muted">
                        {shortMonthLabel(t.ym, lang)}
                      </span>
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

/** t() from core only knows the core DICT — screen keys live in W. */
function t2(lang: Lang, key: "spent" | "budgetLeft"): string {
  return lang === "bn" ? (key === "spent" ? "খরচ" : "বাজেটে বাকি") : key === "spent" ? "Spent" : "Left";
}
