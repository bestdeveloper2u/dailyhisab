/**
 * Daily Hisab — mobile theme.
 * Single mapping of @khoroch/core brand tokens to React Native style values.
 * Screens must use these tokens; no inline magic colors/radii (ADR-0003).
 *
 * T11.3 adds a second palette: DARK_COLORS maps 1:1 from the prototype's
 * [data-theme="dark"] block (www/index.html lines 23–29). The `theme` export
 * stays the LIGHT palette so existing screens keep compiling unchanged;
 * theme-aware screens (settings) read PALETTES[mode] via lib/prefs.tsx.
 */

import { COLORS, RADII } from "@khoroch/core";

export const theme = {
  colors: COLORS,
  radius: RADII,
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 22,
  },
} as const;

export type Theme = typeof theme;

/** Theme mode selected on the Settings screen (T11.3). */
export type ThemeMode = "light" | "dark";

/** Color token set — the same keys in both modes (core COLORS keys). */
export type ThemeColors = Record<keyof typeof COLORS, string>;

/**
 * Dark palette — mapped from the prototype's [data-theme="dark"] block:
 *   bg #0F1312 · surface #171D1B · surface-2 #1E2623 · ink #E9EDEB
 *   muted #93A09A · line #26302C · accent #2FB98F · accent-soft #15302A
 *   accent-ink #06231A · warn #D99A3D/#332915 · danger #E5484D/#331A1A
 * Core token names: ivory=bg, surface2=surface-2, emerald=accent,
 * emeraldSoft=accent-soft, onAccent=accent-ink, warning=warn.
 */
export const DARK_COLORS: ThemeColors = {
  emerald: "#2FB98F",
  emeraldSoft: "#15302A",
  onAccent: "#06231A",
  ink: "#E9EDEB",
  muted: "#93A09A",
  ivory: "#0F1312",
  surface: "#171D1B",
  surface2: "#1E2623",
  line: "#26302C",
  warning: "#D99A3D",
  warningSoft: "#332915",
  danger: "#E5484D",
  dangerSoft: "#331A1A",
};

/** Both palettes keyed by mode; light is the core brand palette. */
export const PALETTES: Record<ThemeMode, ThemeColors> = {
  light: COLORS,
  dark: DARK_COLORS,
};
