import { APP_VERSION, t } from "@khoroch/core";
import { useNavigate } from "react-router";
import {
  GROUP_LABELS,
  GROUP_ORDER,
  PAY_LABELS,
  PAY_ORDER,
} from "../lib/catalog";
import { LangToggle } from "../components/LangToggle";
import { DataSafety } from "../components/DataSafety";
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
import { usePageTitle } from "../lib/usePageTitle";

const THEME_OPTIONS = [
  { value: "light", labelKey: "light" },
  { value: "dark", labelKey: "dark" },
] as const satisfies ReadonlyArray<{ value: Theme; labelKey: "light" | "dark" }>;

const MOTION_OPTIONS = [
  { value: "on", labelKey: "on" },
  { value: "off", labelKey: "off" },
] as const satisfies ReadonlyArray<{ value: Motion; labelKey: "on" | "off" }>;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <p className="border-b border-line px-4 py-3 text-[13px] font-bold text-muted">
        {title}
      </p>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

/**
 * Settings (prototype screen-settings @843-880): profile + language + theme,
 * voice language, data & backup, payment methods, and the expense-group
 * list. Group/payment catalogs are display-only (they mirror the API's
 * enums); auth profile fields are read-only until a profile API exists.
 */
export function Settings() {
  usePageTitle("সেটিংস · Daily Hisab");
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

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          {/* প্রোফাইল (prototype profile card @848-856) */}
          <Card title={w(lang, "profileSettings")}>
            <Row label={w(lang, "profName")}>
              <span className="truncate text-sm font-semibold text-ink">
                {user?.name ?? "—"}
              </span>
            </Row>
            <Row label={w(lang, "profEmail")}>
              <span className="truncate font-en text-sm text-muted">{user?.email ?? "—"}</span>
            </Row>
            <Row label={t(lang, "language")}>
              <LangToggle />
            </Row>
            {/* থিম — segmented light/dark (prototype themeSeg @854) */}
            <Row label={w(lang, "theme")}>
              <Segmented<Theme>
                label={w(lang, "theme")}
                value={theme}
                onChange={setTheme}
                options={THEME_OPTIONS.map((opt) => ({ value: opt.value, label: w(lang, opt.labelKey) }))}
              />
            </Row>
            {/* ভয়েস ভাষা (prototype @855) — voice input is bn-BD today */}
            <Row label={w(lang, "voiceLang")}>
              <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] font-medium text-muted">
                {w(lang, "voiceLangV")}
              </span>
            </Row>
          </Card>

          {/* ডেটা নিরাপত্তা — real backup download + restore (ADR-0012, T16.4);
              supersedes the prototype's sheet-sync/"auto backup" row (ADR-0015). */}
          <DataSafety />
        </div>

        <div className="flex flex-col gap-4">
          {/* পেমেন্ট মাধ্যম (prototype payMethods card @867-875) */}
          <Card title={w(lang, "payMethods")}>
            {PAY_ORDER.map((pay) => (
              <Row key={pay} label={PAY_LABELS[pay][lang]} />
            ))}
          </Card>

          {/* খরচের গ্রুপ তালিকা (prototype khataList @876-877) */}
          <Card title={w(lang, "khataList")}>
            {GROUP_ORDER.map((grp) => (
              <Row key={grp} label={GROUP_LABELS[grp][lang]} />
            ))}
          </Card>

          {/* অ্যাপ + সেশন */}
          <Card title={lang === "bn" ? "অ্যাপ" : "App"}>
            <Row label={w(lang, "motion")}>
              <Segmented<Motion>
                label={w(lang, "motion")}
                value={motion}
                onChange={setMotion}
                options={MOTION_OPTIONS.map((opt) => ({ value: opt.value, label: w(lang, opt.labelKey) }))}
              />
            </Row>
            <Row label={lang === "bn" ? "ভার্সন" : "Version"}>
              <span className="rounded-full border border-line px-2 py-0.5 font-en text-[11px] font-semibold leading-none text-muted">
                v{APP_VERSION}
              </span>
            </Row>
            <Row label={
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{user?.name ?? user?.email ?? t(lang, "login")}</span>
                {user?.email && (
                  <span className="block truncate font-en text-xs font-normal text-muted">{user.email}</span>
                )}
              </span>
            }>
              <button
                type="button"
                onClick={handleLogout}
                className="shrink-0 rounded-control border border-line px-3.5 py-2 text-sm font-semibold text-danger transition-colors hover:bg-surface-2"
              >
                {t(lang, "logout")}
              </button>
            </Row>
          </Card>
        </div>
      </div>
    </section>
  );
}
