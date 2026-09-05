import { useEffect, useState } from "react";
import { currentToast, subscribeToasts, type ToastState } from "../lib/toast";

/**
 * Prototype-faithful toast UI (www/index.html #toast @977 + CSS @380-412):
 * fixed bottom-center pill (above the mobile tab bar, 34px on desktop).
 * The live region stays mounted so screen readers hear messages on change.
 * Mount ONCE, in the app shell.
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
    </div>
  );
}
