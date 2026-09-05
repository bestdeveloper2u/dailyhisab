import { APP_VERSION, t } from "@khoroch/core";
import { useNavigate } from "react-router";
import { LangToggle } from "../components/LangToggle";
import { Segmented } from "../components/Segmented";
import { useAuthStore } from "../store/auth";
import { useLangStore } from "../store/lang";
import {
  useMotionStore,
  useThemeStore,
  type Motion,
  type Theme,
} from "../store/theme";
import { w } from "../lib/web-i18n";

const THEME_OPTIONS = [
  { value: "light", labelKey: "light" },
  { value: "dark", labelKey: "dark" },
] as const satisfies ReadonlyArray<{ value: Theme; labelKey: "light" | "dark" }>;

const MOTION_OPTIONS = [
  { value: "on", labelKey: "on" },
  { value: "off", labelKey: "off" },
] as const satisfies ReadonlyArray<{ value: Motion; labelKey: "on" | "off" }>;

export function Settings() {
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const motion = useMotionStore((s) => s.motion);
  const setMotion = useMotionStore((s) => s.setMotion);
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{t(lang, "navSettings")}</h1>
      <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{t(lang, "language")}</span>
          <LangToggle />
        </div>
        {/* Theme — segmented light/dark (prototype themeSeg @854). */}
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{w(lang, "theme")}</span>
          <Segmented<Theme>
            label={w(lang, "theme")}
            value={theme}
            onChange={setTheme}
            options={THEME_OPTIONS.map((opt) => ({ value: opt.value, label: w(lang, opt.labelKey) }))}
          />
        </div>
        {/* Motion on/off (prototype twMotion @969-970); default honors prefers-reduced-motion. */}
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{w(lang, "motion")}</span>
          <Segmented<Motion>
            label={w(lang, "motion")}
            value={motion}
            onChange={setMotion}
            options={MOTION_OPTIONS.map((opt) => ({ value: opt.value, label: w(lang, opt.labelKey) }))}
          />
        </div>
        <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <span className="flex-1 text-sm font-medium">{lang === "bn" ? "ভার্সন" : "Version"}</span>
          <span className="rounded-full border border-line px-2 py-0.5 font-en text-[11px] font-semibold leading-none text-muted">
            v{APP_VERSION}
          </span>
        </div>
        <div className="flex items-center gap-3 px-4 py-3.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {user?.name ?? user?.email ?? t(lang, "login")}
            {user?.email && (
              <span className="ml-2 font-en text-xs font-normal text-muted">{user.email}</span>
            )}
          </span>
          <button
            type="button"
            onClick={handleLogout}
            className="shrink-0 rounded-control border border-line px-3.5 py-2 text-sm font-semibold text-danger transition-colors hover:bg-surface-2"
          >
            {t(lang, "logout")}
          </button>
        </div>
      </div>
    </section>
  );
}
