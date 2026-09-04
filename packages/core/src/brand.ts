/**
 * Daily Hisab — brand tokens (source of truth: docs/BRAND.md).
 * Web maps these to CSS vars/Tailwind theme; mobile to a RN theme object.
 */

export const BRAND_NAME = "Daily Hisab";

export const TAGLINE = {
  bn: "দৈনিক খরচের হিসাব",
  en: "Daily expense tracking",
} as const;

/** Core palette (docs/BRAND.md §3). Emerald #0E6B50 is the ONLY brand color. */
export const COLORS = {
  emerald: "#0E6B50",
  emeraldSoft: "#E3F0EA",
  onAccent: "#FFFFFF",
  ink: "#1C2321",
  muted: "#6B7570",
  ivory: "#F6F5F1",
  surface: "#FFFFFF",
  surface2: "#F1EFE9",
  line: "#E6E3DB",
  warning: "#B45309",
  warningSoft: "#FBF0DD",
  danger: "#B42318",
  dangerSoft: "#FBEAE8",
} as const;

/** Radius scale (docs/BRAND.md §5) */
export const RADII = {
  card: 16,
  control: 10,
  logo: 13, // ~30% of a 44px mark
} as const;

/** CSS custom properties for the web app (used with Tailwind v4 @theme). */
export const CSS_VARS: Record<string, string> = {
  "--dk-emerald": COLORS.emerald,
  "--dk-emerald-soft": COLORS.emeraldSoft,
  "--dk-on-accent": COLORS.onAccent,
  "--dk-ink": COLORS.ink,
  "--dk-muted": COLORS.muted,
  "--dk-ivory": COLORS.ivory,
  "--dk-surface": COLORS.surface,
  "--dk-surface-2": COLORS.surface2,
  "--dk-line": COLORS.line,
  "--dk-warning": COLORS.warning,
  "--dk-warning-soft": COLORS.warningSoft,
  "--dk-danger": COLORS.danger,
  "--dk-danger-soft": COLORS.dangerSoft,
  "--dk-radius-card": `${RADII.card}px`,
  "--dk-radius-control": `${RADII.control}px`,
};

export const APP_VERSION = "0.3.0";
