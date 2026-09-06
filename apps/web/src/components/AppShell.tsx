import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useEffect, useRef, useState } from "react";
import { t, type Lang } from "@khoroch/core";
import { useLangStore } from "../store/lang";
import { w } from "../lib/web-i18n";
import { LangToggle } from "./LangToggle";
import { Logo } from "./Logo";
import { ToastHost } from "./Toast";
import { UserMenu } from "./UserMenu";
import {
  IconBarChart,
  IconCalendar,
  IconHome,
  IconMic,
  IconPencil,
  IconPlus,
  IconReceipt,
  IconRepeat,
  IconSliders,
  IconSwap,
  IconWallet,
} from "./icons";

/*
 * Sidebar/tab destinations. Labels resolve per render (t for the core dict,
 * w for web-local keys) — navRecurring lives in web-i18n until it graduates
 * into @khoroch/core alongside the others.
 */
const NAV = [
  { to: "/", end: true, Icon: IconHome, label: (l: Lang) => t(l, "navDashboard") },
  { to: "/expenses", end: false, Icon: IconReceipt, label: (l: Lang) => t(l, "navExpenses") },
  { to: "/month", end: false, Icon: IconCalendar, label: (l: Lang) => t(l, "navMonthly") },
  { to: "/report", end: false, Icon: IconBarChart, label: (l: Lang) => t(l, "navReport") },
  { to: "/debts", end: false, Icon: IconSwap, label: (l: Lang) => t(l, "navDebts") },
  { to: "/recurring", end: false, Icon: IconRepeat, label: (l: Lang) => w(l, "navRecurring") },
  { to: "/budget", end: false, Icon: IconWallet, label: (l: Lang) => t(l, "navBudget") },
  { to: "/settings", end: false, Icon: IconSliders, label: (l: Lang) => t(l, "navSettings") },
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

  /*
   * T21.4 — prototype fabcol scroll-hide (@1781-1783): scrolling DOWN more
   * than 6px while past the 90px app bar hides the FAB column; ANY scroll-up
   * beyond the 6px hysteresis shows it again. The hysteresis stops touch
   * jitter from flapping the FABs. The real scroll container here is the
   * window (main has no overflow of its own), unlike the prototype's
   * scrollable <main> — so we track window.scrollY. The listener is passive:
   * it must never block the scroll thread.
   */
  const [fabHidden, setFabHidden] = useState(false);
  const lastScrollY = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const last = lastScrollY.current;
      if (y > last + 6 && y > 90) setFabHidden(true);
      else if (y < last - 6) setFabHidden(false);
      lastScrollY.current = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /*
   * T21.2 — context-aware FAB targets (prototype fabMode @1374 / addFab
   * @1772-1780): on /debts the pencil focuses the debt-party input, on
   * /budget the monthly-limit input, elsewhere it opens the add-expense
   * form; the mic opens the matching voice overlay.
   */
  const pencilTarget = pathname.startsWith("/debts")
    ? "/debts?focus=party"
    : pathname.startsWith("/budget")
      ? "/budget?focus=total"
      : "/expenses?add=1";
  const micTarget = pathname.startsWith("/debts")
    ? "/debts?voice=1"
    : pathname.startsWith("/budget")
      ? "/budget?voice=1"
      : "/expenses?voice=1";

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
            {NAV.map(({ to, end, Icon, label }) => (
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
                {label(lang)}
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

      {/* Prototype fabcol: small pencil FAB (নিজে লিখুন) above the big mic FAB —
          voice stays visually separate, exactly like the frozen prototype.
          Scroll-hide (.fadhide parity): slides out of the way while reading
          down, springs back on scroll-up; reduced motion keeps the toggle but
          drops the transition via the app-wide CSS kill-switch. `inert` keeps
          the hidden buttons out of the tab order. */}
      <div
        inert={fabHidden}
        aria-hidden={fabHidden}
        className={`fab-pos fixed right-4 z-40 flex flex-col items-center gap-2.5 transition-[transform,opacity] duration-300 ease-out lg:right-8 ${
          fabHidden ? "pointer-events-none translate-y-[160%] opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <button
          type="button"
          aria-label={w(lang, "qaManual")}
          title={w(lang, "qaManual")}
          onClick={() => navigate(pencilTarget)}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-card transition-[filter] hover:bg-surface-2"
        >
          <IconPencil className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label={w(lang, "voiceTitle")}
          title={w(lang, "voiceTitle")}
          onClick={() =>
            // Prototype fabMode(): the mic is context-aware — debts ledger,
            // budget screen, or expense-voice everywhere else.
            navigate(micTarget)
          }
          className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald text-accent-ink shadow-card transition-transform active:scale-95"
        >
          <IconMic className="h-6 w-6" />
        </button>
      </div>

      <nav
        aria-label="Tabs"
        className="pb-safe fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-line bg-surface lg:hidden"
      >
        {/* All 8 NAV items fit <1024px by going icon-only: 360px / 8 ≈ 45px per
            tab, each ≥44px tall (WCAG 2.2 target size); labels live in the
            accessible name (aria-label) + title tooltip. */}
        {NAV.map(({ to, end, Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            aria-label={label(lang)}
            title={label(lang)}
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
