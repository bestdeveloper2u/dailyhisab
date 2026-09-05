import { NavLink, Outlet, useNavigate } from "react-router";
import { t } from "@khoroch/core";
import { useLangStore } from "../store/lang";
import { LangToggle } from "./LangToggle";
import { Logo } from "./Logo";
import {
  IconBarChart,
  IconHome,
  IconPlus,
  IconReceipt,
  IconSliders,
  IconSwap,
  IconWallet,
} from "./icons";

const NAV = [
  { to: "/", key: "navDashboard", end: true, Icon: IconHome },
  { to: "/expenses", key: "navExpenses", end: false, Icon: IconReceipt },
  { to: "/report", key: "navReport", end: false, Icon: IconBarChart },
  { to: "/debts", key: "navDebts", end: false, Icon: IconSwap },
  { to: "/budget", key: "navBudget", end: false, Icon: IconWallet },
  { to: "/settings", key: "navSettings", end: false, Icon: IconSliders },
] as const;

/** Tab bar drops "budget" on small viewports (still reachable via sidebar/settings). */
const TABS = NAV.filter((item) => item.key !== "navBudget");

/**
 * App shell mirroring the frozen prototype (www/index.html):
 * app bar with brand + version chip + compact language toggle,
 * 236px sidebar ≥1024px, 5-item bottom tab bar <1024px with safe-area inset,
 * and an emerald floating add button.
 */
export function AppShell() {
  const lang = useLangStore((s) => s.lang);
  const navigate = useNavigate();

  return (
    <div className={`min-h-dvh bg-ivory text-ink ${lang === "bn" ? "font-bn" : "font-en"}`}>
      <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-line bg-ivory px-4 sm:px-6">
        <Logo withVersion />
        <div className="flex-1" />
        <LangToggle size="compact" />
      </header>

      {/* Fluid full-width layout like the frozen prototype (no max-w cap). */}
      <div className="flex w-full">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[236px] shrink-0 flex-col border-r border-line bg-surface px-2.5 py-3 lg:flex">
          <nav aria-label="Main" className="flex flex-col gap-1">
            {NAV.map(({ to, key, end, Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-semibold transition-colors ${
                    isActive ? "bg-emerald text-white" : "text-muted hover:bg-surface-2 hover:text-ink"
                  }`
                }
              >
                <Icon className="h-[19px] w-[19px] shrink-0" />
                {t(lang, key)}
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 px-[clamp(16px,3.5vw,40px)] pb-[130px] pt-2">
          <Outlet />
        </main>
      </div>

      <button
        type="button"
        aria-label={t(lang, "addExpense")}
        onClick={() => navigate("/expenses?voice=1")}
        className="fab-pos fixed right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-emerald text-white shadow-card lg:right-8"
      >
        <IconPlus className="h-6 w-6" />
      </button>

      <nav
        aria-label="Tabs"
        className="pb-safe fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-line bg-surface lg:hidden"
      >
        {TABS.map(({ to, key, end, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px] font-semibold ${
                isActive ? "text-emerald" : "text-muted"
              }`
            }
          >
            <Icon className="h-[21px] w-[21px]" />
            {t(lang, key)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
