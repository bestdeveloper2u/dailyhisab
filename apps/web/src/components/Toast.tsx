import { useEffect, useState } from "react";
import { currentToast, dismissToast, subscribeToasts, type ToastState } from "../lib/toast";

/**
 * Prototype-faithful toast UI (www/index.html #toast @977 + CSS @380-412):
 * fixed bottom-center pill (above the mobile tab bar, 34px on desktop).
 * The live region stays mounted so screen readers hear messages on change.
 * Mount ONCE, in the app shell.
 *
 * T22.1: an action toast renders its action as a button INSIDE the same live
 * region — it never steals focus (no autofocus), and clicking it dismisses
 * the toast before running the callback so any follow-up toast survives.
 */
export function ToastHost() {
  const [state, setState] = useState<ToastState | null>(currentToast());

  useEffect(() => subscribeToasts(setState), []);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast"
      className={`pointer-events-none fixed left-1/2 z-[90] -translate-x-1/2 rounded-full bg-ink px-4.5 py-2.5 text-center text-[13.5px] font-semibold text-ivory shadow-card transition-all duration-300 max-w-[min(92vw,480px)] ${
        state
          ? "bottom-[84px] translate-y-0 opacity-100 lg:bottom-[34px]"
          : "bottom-[76px] translate-y-4 opacity-0"
      }`}
    >
      {state?.text ?? ""}
      {state?.action && (
        <button
          type="button"
          onClick={() => {
            const action = state.action;
            if (!action) return;
            dismissToast(state.id);
            action.onClick();
          }}
          className="pointer-events-auto ml-2.5 rounded-full bg-ivory/15 px-2.5 py-1 text-xs font-bold text-ivory transition-colors hover:bg-ivory/25"
        >
          {state.action.label}
        </button>
      )}
    </div>
  );
}
