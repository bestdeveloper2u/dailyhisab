import { formatTaka, toBnDigits, t, type Lang } from "@khoroch/core";
import { Link } from "react-router";
import { useBudget, useExpensesInfinite, useMonthlyReport } from "../lib/queries";
import { groupName } from "../lib/catalog";
import { W } from "../lib/web-i18n";
import { useLangStore } from "../store/lang";

/** "YYYY-MM" for the current month, UTC — the API's ?ym= domain. */
function currentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

interface StatCardProps {
  label: string;
  amount: string;
  meta?: string;
  lang: Lang;
}

function StatCard({ label, amount, meta, lang }: StatCardProps) {
  return (
    <div className="rounded-card border border-line bg-surface p-5 shadow-card">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      {/* Amounts are always ink — emerald is reserved for accent, never for money. */}
      <p
        className={`mt-2 text-3xl font-bold tabular-nums text-ink ${
          lang === "bn" ? "font-bn" : "font-en"
        }`}
      >
        {amount}
      </p>
      {meta !== undefined && <p className="mt-1.5 text-xs text-muted">{meta}</p>}
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true">
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[104px] animate-pulse rounded-card border border-line bg-surface"
          />
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="h-[220px] animate-pulse rounded-card border border-line bg-surface" />
        <div className="h-[220px] animate-pulse rounded-card border border-line bg-surface" />
      </div>
    </div>
  );
}

function CardShell({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-bold text-ink">{title}</h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function Dashboard() {
  const lang = useLangStore((s) => s.lang);
  const ym = currentYm();

  const reportQ = useMonthlyReport(ym);
  const budgetQ = useBudget(ym);
  const recentQ = useExpensesInfinite({ pageLimit: 5 });

  const report =
    reportQ.data !== undefined && reportQ.data.ok ? reportQ.data.data : undefined;
  const budget =
    budgetQ.data !== undefined && budgetQ.data.ok ? budgetQ.data.data : undefined;
  const recent =
    recentQ.data !== undefined &&
    recentQ.data.pages.length > 0 &&
    recentQ.data.pages[0].ok
      ? recentQ.data.pages[0].data.items
      : [];

  const retry = () => {
    void reportQ.refetch();
    void budgetQ.refetch();
    void recentQ.refetch();
  };

  const fmtMoney = (v: string) => formatTaka(v, lang);
  const fmtCount = (n: number) => (lang === "bn" ? toBnDigits(String(n)) : String(n));

  // Remaining budget, computed server-side values only (total − spent).
  const budgetLeft = (() => {
    if (budget === undefined) return null;
    const left = Number(budget.total) - Number(budget.spent);
    return left.toFixed(2);
  })();

  const groupRows =
    report === undefined
      ? []
      : Object.entries(report.by_group).sort(
          ([, a], [, b]) => Number(b) - Number(a),
        );

  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{t(lang, "navDashboard")}</h1>
      <p className="mt-1.5 text-[13px] text-muted">{t(lang, "thisMonth")}</p>

      {reportQ.isLoading ? (
        <Skeleton />
      ) : report === undefined ? (
        <div className="mt-5 rounded-card border border-line bg-surface p-5 text-center shadow-card">
          <p className="text-sm text-muted">{W[lang].errLoad}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-control bg-emerald px-3.5 py-2 text-sm font-bold text-white transition-[filter] hover:brightness-110"
          >
            {W[lang].errRetry}
          </button>
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label={t(lang, "spent")}
              amount={fmtMoney(report.total)}
              meta={`${fmtCount(report.count)} ${W[lang].txCount}`}
              lang={lang}
            />
            <StatCard
              label={t(lang, "budgetLeft")}
              amount={budgetLeft === null ? "—" : fmtMoney(budgetLeft)}
              meta={budget === undefined ? W[lang].noBudget : undefined}
              lang={lang}
            />
            <StatCard
              label={W[lang].byGroup}
              amount={
                groupRows.length > 0
                  ? groupName(groupRows[0][0], lang)
                  : W[lang].empty
              }
              meta={
                groupRows.length > 0 ? `${W[lang].topGroup}: ${fmtMoney(groupRows[0][1])}` : undefined
              }
              lang={lang}
            />
          </div>

          <div className="mt-6 grid items-start gap-4 lg:grid-cols-2">
            <CardShell title={W[lang].byGroup}>
              {groupRows.length === 0 ? (
                <p className="py-2 text-sm text-muted">{W[lang].empty}</p>
              ) : (
                <ul>
                  {groupRows.map(([grp, amt]) => (
                    <li
                      key={grp}
                      className="flex items-center justify-between gap-4 border-b border-line py-2.5 first:pt-0 last:border-b-0 last:pb-0"
                    >
                      <span className="min-w-0 truncate text-sm text-ink">
                        {groupName(grp, lang)}
                      </span>
                      <span className="text-sm font-semibold tabular-nums text-ink">
                        {fmtMoney(amt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardShell>

            <CardShell
              title={W[lang].recent}
              action={
                <Link
                  to="/expenses"
                  className="text-xs font-semibold text-emerald hover:underline"
                >
                  {W[lang].viewAll} →
                </Link>
              }
            >
              {recent.length === 0 ? (
                <p className="py-2 text-sm text-muted">{W[lang].emptyHint}</p>
              ) : (
                <ul>
                  {recent.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-4 border-b border-line py-2.5 first:pt-0 last:border-b-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{e.cat}</p>
                        <p className="mt-0.5 truncate text-xs text-muted">
                          {groupName(e.grp, lang)}
                          {e.iso !== undefined && e.iso !== null
                            ? ` · ${e.iso.slice(0, 10)}`
                            : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-bold tabular-nums text-ink">
                        {fmtMoney(e.amt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardShell>
          </div>
        </>
      )}
    </section>
  );
}
