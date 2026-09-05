import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useEffect, useRef } from "react";
import { t } from "@khoroch/core";
import { useLangStore } from "../store/lang";
import { LangToggle } from "./LangToggle";
import { Logo } from "./Logo";
import { ToastHost } from "./Toast";
import { UserMenu } from "./UserMenu";
import {
  IconBarChart,
  IconCalendar,
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
  { to: "/month", key: "navMonthly", end: false, Icon: IconCalendar },
  { to: "/report", key: "navReport", end: false, Icon: IconBarChart },
  { to: "/debts", key: "navDebts", end: false, Icon: IconSwap },
  { to: "/budget", key: "navBudget", end: false, Icon: IconWallet },
  { to: "/settings", key: "navSettings", end: false, Icon: IconSliders },
] as const;

/**
 * App shell mirroring the frozen prototype (www/index.html):
 * app bar with brand + version chip + compact language toggle,
 * 236px sidebar ≥1024px, 6-item icon-only bottom tab bar <1024px
 * with safe-area inset, and an emerald floating add button.
 */
export function AppShell() {
  const lang = useLangStore((s) => s.lang);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  /*
   * T14.6 — route-change focus management (WCAG 2.2 SC 2.4.3 Focus Order).
   * In an SPA the URL changes but focus stays put: after a route swap the
   * keyboard/screen-reader user is still anchored to the sidebar link they
   * just activated and gets NO announcement of the new page. Moving focus to
   * the <main> landmark (tabIndex=-1) on every pathname change restores a
   * sensible reading order. The initial mount is skipped so a fresh page
   * load keeps the browser default; query-string-only changes (e.g. opening
   * the add form on /expenses) do NOT re-trigger — only real route swaps.
   */
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className={`min-h-dvh bg-ivory text-ink ${lang === "bn" ? "font-bn" : "font-en"}`}>
      {/* T14.4 — skip link (WCAG 2.2 SC 2.4.1 Bypass Blocks): the header,
          sidebar and tab bar repeat on every route; keyboard users can jump
          straight to the content landmark. Visually hidden until focused. */}
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault(); // keep the SPA URL clean — focus instead of hash-nav
          mainRef.current?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-emerald focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-ink focus:shadow-card"
      >
        {t(lang, "skipToContent")}
      </a>
      <ToastHost />
      <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-line bg-ivory px-4 sm:px-6">
        <Logo withVersion />
        <div className="flex-1" />
        <LangToggle size="compact" />
        <UserMenu />
      </header>

      {/* Fluid full-width layout like the frozen prototype (no max-w cap). */}
      <div className="flex w-full">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[236px] shrink-0 flex-col border-r border-line bg-surface px-2.5 py-3 lg:flex">
          <nav aria-label="Main" className="flex flex-col gap-1">
            {/* খরচ যোগ করুন (prototype sidebar item @605-608) — opens the
                manual-add form on the expenses screen. */}
            <button
              type="button"
              onClick={() => navigate("/expenses?add=1")}
              className="flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <IconPlus className="h-[19px] w-[19px] shrink-0" />
              {t(lang, "addExpense")}
            </button>
            {NAV.map(({ to, key, end, Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-semibold transition-colors ${
                    isActive ? "bg-emerald text-accent-ink" : "text-muted hover:bg-surface-2 hover:text-ink"
                  }`
                }
              >
                <Icon className="h-[19px] w-[19px] shrink-0" />
                {t(lang, key)}
              </NavLink>
            ))}
          </nav>
        </aside>

        <main
          ref={mainRef}
          id="main"
          tabIndex={-1}
          className="min-w-0 flex-1 px-[clamp(16px,3.5vw,40px)] pb-[130px] pt-2 focus:outline-none"
        >
          <Outlet />
        </main>
      </div>

      <button
        type="button"
        aria-label={t(lang, "addExpense")}
        onClick={() => navigate("/expenses?voice=1")}
        className="fab-pos fixed right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-emerald text-accent-ink shadow-card lg:right-8"
      >
        <IconPlus className="h-6 w-6" />
      </button>

      <nav
        aria-label="Tabs"
        className="pb-safe fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-line bg-surface lg:hidden"
      >
        {/* All 7 NAV items fit <1024px by going icon-only: 360px / 7 ≈ 51px per
            tab, each ≥44px tall (WCAG 2.2 target size); labels live in the
            accessible name (aria-label) + title tooltip. */}
        {NAV.map(({ to, key, end, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            aria-label={t(lang, key)}
            title={t(lang, key)}
            className={({ isActive }) =>
              `flex min-h-11 min-w-0 flex-1 items-center justify-center ${
                isActive ? "text-emerald" : "text-muted"
              }`
            }
          >
            <Icon className="h-6 w-6" />
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
