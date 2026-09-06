import { useEffect, useState } from "react";
import type { Lang } from "@khoroch/core";
import { useLangStore } from "../store/lang";
import {
  currentUpdatePrompt,
  dismissAppUpdate,
  subscribeUpdatePrompt,
  type UpdatePromptState,
} from "./UpdateToastStore";

/**
 * Local copy (bn + en) — same reasoning as ErrorBoundary: the update prompt
 * must not depend on a lib string module that could itself be stale or part
 * of a failure, and both dicts must keep identical keys.
 */
const COPY: Record<
  Lang,
  { title: string; body: string; refresh: string; later: string }
> = {
  bn: {
    title: "নতুন সংস্করণ প্রস্তুত",
    body: "সর্বশেষ সংশোধনীগুলো পেতে অ্যাপটি রিফ্রেশ করুন।",
    refresh: "রিফ্রেশ করুন",
    later: "পরে",
  },
  en: {
    title: "A new version is ready",
    body: "Refresh the app to get the latest fixes.",
    refresh: "Refresh now",
    later: "Later",
  },
};

/**
 * PWA update prompt (T16.2): a sticky branded panel replacing the silent
 * service-worker update. Reuses the visual language of components/Toast.tsx
 * (fixed bottom-center ink pill → card, same shadow/typography tokens) but
 * sits one row higher so the two never overlap, and carries real buttons.
 * Mount ONCE, in main.tsx, outside the router/providers.
 */
export function UpdateToastHost() {
  const lang = useLangStore((s) => s.lang);
  const [state, setState] = useState<UpdatePromptState | null>(
    currentUpdatePrompt(),
  );

  useEffect(() => subscribeUpdatePrompt(setState), []);

  if (state === null) return null;

  const copy = COPY[lang];
  const refresh = () => {
    // Reload first, then clear — if the reload is blocked (unload handler,
    // devtools) the panel is not left stranded on screen either way.
    state.refresh();
    dismissAppUpdate();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-toast"
      className={`pointer-events-auto fixed left-1/2 z-[91] w-[min(92vw,420px)] -translate-x-1/2 rounded-card bg-ink px-4 py-3.5 text-ivory shadow-card ${
        lang === "bn" ? "font-bn" : "font-en"
      } bottom-[132px] lg:bottom-[86px]`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">{copy.title}</p>
          <p className="mt-0.5 text-xs text-ivory/75">{copy.body}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={refresh}
            className="h-9 rounded-control bg-emerald px-3.5 text-[13px] font-bold text-accent-ink transition-[filter] hover:brightness-110"
          >
            {copy.refresh}
          </button>
          <button
            type="button"
            onClick={dismissAppUpdate}
            className="h-9 rounded-control px-3 text-[13px] font-semibold text-ivory/75 transition-colors hover:text-ivory"
          >
            {copy.later}
          </button>
        </div>
      </div>
    </div>
  );
}
