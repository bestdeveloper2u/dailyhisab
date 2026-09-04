import { formatTaka, t, type Lang } from "@khoroch/core";
import { ComingSoon } from "../components/ComingSoon";
import { useLangStore } from "../store/lang";

interface StatCardProps {
  label: string;
  amount: string;
  lang: Lang;
}

function StatCard({ label, amount, lang }: StatCardProps) {
  return (
    <div className="rounded-card border border-line bg-surface p-5 shadow-card">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      {/* Amounts are always ink — emerald is reserved for accent, never for money. */}
      <p
        className={`mt-1 text-3xl font-bold tabular-nums text-ink ${
          lang === "bn" ? "font-bn" : "font-en"
        }`}
      >
        {amount}
      </p>
    </div>
  );
}

export function Dashboard() {
  const lang = useLangStore((s) => s.lang);
  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{t(lang, "navDashboard")}</h1>
      <p className="mt-0.5 text-[13px] text-muted">{t(lang, "thisMonth")}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <StatCard label={t(lang, "spent")} amount={formatTaka("4820.00", lang)} lang={lang} />
        <StatCard label={t(lang, "budgetLeft")} amount={formatTaka("12500.00", lang)} lang={lang} />
      </div>
      <ComingSoon />
    </section>
  );
}
