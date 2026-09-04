import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isLang, type Lang } from "@khoroch/core";

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

/**
 * Bengali-first product: persisted to localStorage key "khoroch.lang",
 * defaults to "bn". Corrupt/stale stored values fall back to "bn" (isLang).
 */
export const useLangStore = create<LangState>()(
  persist(
    (set) => ({
      lang: "bn",
      setLang: (lang) => set({ lang }),
    }),
    {
      name: "khoroch.lang",
      storage: createJSONStorage(() => window.localStorage),
      merge: (persisted, current) => {
        const stored = (persisted as { lang?: unknown } | undefined)?.lang;
        return { ...current, lang: isLang(stored) ? stored : "bn" };
      },
    },
  ),
);
