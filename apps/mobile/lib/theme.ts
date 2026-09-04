/**
 * Daily Hisab — mobile theme.
 * Single mapping of @khoroch/core brand tokens to React Native style values.
 * Screens must use these tokens; no inline magic colors/radii (ADR-0003).
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
