import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOTION_KEY,
  THEME_KEY,
  applyMotion,
  applyTheme,
  resolveMotion,
  resolveTheme,
} from "../src/store/theme";
import { W } from "../src/lib/web-i18n";

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.motion;
});

describe("theme system", () => {
  it("resolveTheme defaults to light and repairs corrupt stored values", () => {
    expect(resolveTheme(null)).toBe("light");
    expect(resolveTheme(undefined)).toBe("light");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("banana")).toBe("light");
    expect(resolveTheme(42)).toBe("light");
  });

  it("applyTheme sets data-theme on <html> and persists the raw string", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");

    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("the store mirrors the persisted value (FOUC wiring contract)", async () => {
    // The store is a module singleton created at import time — exactly like
    // production, where the inline FOUC script has already written
    // data-theme before the bundle loads. Re-import the module after seeding
    // localStorage so store init sees the persisted value.
    window.localStorage.setItem(THEME_KEY, "dark");
    delete document.documentElement.dataset.theme;
    vi.resetModules();
    const fresh = await import("../src/store/theme");
    expect(fresh.useThemeStore.getState().theme).toBe(
      fresh.resolveTheme(window.localStorage.getItem(fresh.THEME_KEY)),
    );
    expect(fresh.useThemeStore.getState().theme).toBe("dark");

    fresh.useThemeStore.getState().setTheme("dark");
    expect(fresh.useThemeStore.getState().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });
});

describe("motion system", () => {
  it("resolveMotion honors an explicit stored choice", () => {
    expect(resolveMotion("off", false)).toBe("off");
    expect(resolveMotion("on", true)).toBe("on");
  });

  it("resolveMotion defaults to prefers-reduced-motion when unset", () => {
    expect(resolveMotion(null, true)).toBe("off");
    expect(resolveMotion(null, false)).toBe("on");
    expect(resolveMotion("junk", true)).toBe("off");
  });

  it("applyMotion sets data-motion on <html> and persists the raw string", () => {
    applyMotion("off");
    expect(document.documentElement.dataset.motion).toBe("off");
    expect(window.localStorage.getItem(MOTION_KEY)).toBe("off");

    applyMotion("on");
    expect(document.documentElement.dataset.motion).toBe("on");
    expect(window.localStorage.getItem(MOTION_KEY)).toBe("on");
  });
});

describe("FOUC guard", () => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

  it("index.html carries the pre-paint theme/motion bootstrap script", () => {
    expect(html).toContain("khoroch.theme");
    expect(html).toContain("khoroch.motion");
    expect(html).toContain("data-theme");
    expect(html).toContain("prefers-reduced-motion");
    // Inline in <head>, before any module script that could paint.
    expect(html.indexOf("khoroch.theme")).toBeLessThan(html.indexOf("src/main.tsx"));
  });

  it("defaults the html element to light + motion on", () => {
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('data-motion="on"');
  });
});

describe("web i18n keys", () => {
  it("bn and en dicts keep identical key sets", () => {
    expect(Object.keys(W.en).sort()).toEqual(Object.keys(W.bn).sort());
  });

  it("the new theme/toast/bump keys exist in both locales", () => {
    const required = [
      "theme",
      "light",
      "dark",
      "motion",
      "on",
      "off",
      "profileSettings",
      "tDeleted",
      "csvStarted",
      "csvDone",
      "csvLabel",
      "bump10",
      "bump50",
      "bump100",
      "bump500",
    ] as const;
    for (const key of required) {
      expect(W.bn[key]).toBeTruthy();
      expect(W.en[key]).toBeTruthy();
    }
  });

  it("bump labels follow the prototype (+১০ bn / +10 en)", () => {
    expect(W.bn.bump10).toBe("+১০");
    expect(W.bn.bump500).toBe("+৫০০");
    expect(W.en.bump10).toBe("+10");
    expect(W.en.bump500).toBe("+500");
  });
});
