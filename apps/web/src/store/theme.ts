import { create } from "zustand";

/**
 * Appearance preferences (prototype www/index.html setTheme @1618 /
 * setMotion @1621, init @1766): raw-string localStorage values so the inline
 * FOUC script in index.html can read them before first paint without JSON.
 *
 *   khoroch.theme  → "light" | "dark"   (default light)
 *   khoroch.motion → "on" | "off"       (default: prefers-reduced-motion)
 */

export type Theme = "light" | "dark";
export type Motion = "on" | "off";

export const THEME_KEY = "khoroch.theme";
export const MOTION_KEY = "khoroch.motion";

export const isTheme = (v: unknown): v is Theme => v === "light" || v === "dark";
export const isMotion = (v: unknown): v is Motion => v === "on" || v === "off";

/** Pure: stored value → theme. Missing/corrupt values fall back to light. */
export function resolveTheme(stored: unknown): Theme {
  return isTheme(stored) ? stored : "light";
}

/** Pure: stored value + OS reduced-motion → effective motion setting. */
export function resolveMotion(stored: unknown, prefersReducedMotion: boolean): Motion {
  if (isMotion(stored)) return stored;
  return prefersReducedMotion ? "off" : "on";
}

function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Apply a theme to <html> and persist it. The data-theme attribute is what
 * the token overrides in index.css ([data-theme="dark"]) key off, so every
 * utility that references a color token switches at once.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode — keep the in-memory choice only */
  }
}

/** Apply the motion preference: "off" toggles the CSS kill-switch (index.css). */
export function applyMotion(motion: Motion): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.motion = motion;
  }
  try {
    window.localStorage.setItem(MOTION_KEY, motion);
  } catch {
    /* private mode — keep the in-memory choice only */
  }
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const useThemeStore = create<ThemeState>()((set) => ({
  theme: resolveTheme(readStored(THEME_KEY)),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
}));

interface MotionState {
  motion: Motion;
  setMotion: (motion: Motion) => void;
}

export const useMotionStore = create<MotionState>()((set) => ({
  motion: resolveMotion(readStored(MOTION_KEY), prefersReducedMotion()),
  setMotion: (motion) => {
    applyMotion(motion);
    set({ motion });
  },
}));
