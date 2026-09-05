/**
 * App preferences provider (T11.3) — the mobile ThemeContext.
 *
 * Owns two persisted prefs:
 *   - theme mode: "light" (default) | "dark"   → lib/theme.ts PALETTES
 *   - UI language: "bn" (default) | "en"       → lib/strings.ts STRINGS
 *
 * Persistence is a tiny JSON blob in expo-secure-store under "khoroch.prefs".
 * The app has no AsyncStorage dependency and T11.3 must not add native deps,
 * so SecureStore doubles as the key-value store (the blob is <100 bytes, well
 * under its value limit). Any storage failure degrades to in-memory state —
 * the app renders with defaults instead of crashing.
 */
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { STRINGS, type Lang, type MobileStringKey } from "./strings";
import { PALETTES, type ThemeColors, type ThemeMode } from "./theme";

const PREFS_KEY = "khoroch.prefs";

export interface PrefsContextValue {
  /** True once the stored blob has been read (or failed) at startup. */
  ready: boolean;
  mode: ThemeMode;
  lang: Lang;
  /** Color palette for the active mode — light tokens until `ready`. */
  colors: ThemeColors;
  setMode(mode: ThemeMode): void;
  setLang(lang: Lang): void;
  /** STRINGS lookup for the active language. */
  t(key: MobileStringKey): string;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);

/** Unknown stored value → mode (anything but "dark" reads as light). */
function asMode(value: unknown): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

/** Unknown stored value → lang (anything but "en" reads as bn). */
function asLang(value: unknown): Lang {
  return value === "en" ? "en" : "bn";
}

async function loadStoredPrefs(): Promise<{ mode: ThemeMode; lang: Lang }> {
  try {
    const raw = await SecureStore.getItemAsync(PREFS_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        const obj = parsed as { theme?: unknown; lang?: unknown };
        return { mode: asMode(obj.theme), lang: asLang(obj.lang) };
      }
    }
  } catch {
    // Corrupt blob / SecureStore unavailable → fall through to defaults.
  }
  return { mode: "light", lang: "bn" };
}

async function persistPrefs(mode: ThemeMode, lang: Lang): Promise<void> {
  try {
    await SecureStore.setItemAsync(
      PREFS_KEY,
      JSON.stringify({ theme: mode, lang }),
    );
  } catch {
    // Storage unavailable → prefs stay session-only.
  }
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [mode, setModeState] = useState<ThemeMode>("light");
  const [lang, setLangState] = useState<Lang>("bn");

  useEffect(() => {
    let cancelled = false;
    void loadStoredPrefs().then((stored) => {
      if (!cancelled) {
        setModeState(stored.mode);
        setLangState(stored.lang);
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      void persistPrefs(next, lang);
    },
    [lang],
  );

  const setLang = useCallback(
    (next: Lang) => {
      setLangState(next);
      void persistPrefs(mode, next);
    },
    [mode],
  );

  const value = useMemo<PrefsContextValue>(
    () => ({
      ready,
      mode,
      lang,
      colors: PALETTES[mode],
      setMode,
      setLang,
      t: (key: MobileStringKey) => STRINGS[lang][key],
    }),
    [ready, mode, lang, setMode, setLang],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  const ctx = useContext(PrefsContext);
  if (!ctx) {
    throw new Error("usePrefs must be used inside <PrefsProvider>");
  }
  return ctx;
}
