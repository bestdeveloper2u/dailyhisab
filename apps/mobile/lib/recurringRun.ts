/**
 * Boot-time recurring auto-materialization (T17.1 — ADR-0014 §3).
 *
 * Called from RootNavigator once the auth bootstrap has settled with a live
 * session: once per LOCAL day per device it fires POST /recurring/run so
 * recurring rules materialize without the user opening পুনরাবৃত্ত. The day
 * stamp is persisted in expo-secure-store under the SAME key convention as
 * the web app (`khoroch.recurringRun.<YYYY-MM-DD>`) and written BEFORE the
 * request resolves, so a crash mid-run can never loop the POST across
 * launches. The endpoint is idempotent anyway (same-day re-run ⇒
 * created: 0). Everything except a created > 0 success is fully silent.
 */
import * as SecureStore from "expo-secure-store";

import { toBnDigits } from "@khoroch/core";

import { runRecurring } from "./api";
import { STRINGS, type Lang } from "./strings";

/** Same key convention as the web app: one stamp per LOCAL day per device. */
const STAMP_PREFIX = "khoroch.recurringRun.";

/** Local-side YYYY-MM-DD for today (never UTC). */
function localTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface RecurringBootOptions {
  /** Live Bearer access token from the restored session. */
  accessToken: string;
  /** Active UI language (lib/prefs) for the toast wording. */
  lang: Lang;
  /** Show-toast callback (lib/toast useToast()). */
  showToast: (message: string) => void;
}

/**
 * At most one auto-run per local day. Never throws: storage and network
 * failures both degrade to silence — ADR-0014 §3 idempotency means a missed
 * or repeated call can never duplicate expenses.
 */
export async function maybeRunRecurringBoot(
  opts: RecurringBootOptions,
): Promise<void> {
  const key = `${STAMP_PREFIX}${localTodayIso()}`;
  try {
    if ((await SecureStore.getItemAsync(key)) !== null) return;
    // Optimistic: stamp BEFORE the request so a kill mid-run doesn't re-fire
    // on every launch; the server's created: 0 covers the residual risk.
    await SecureStore.setItemAsync(key, "1");
  } catch {
    // SecureStore unavailable → proceed without a local stamp (prefs.tsx
    // degradation pattern); server idempotency keeps a repeat harmless.
  }
  try {
    const result = await runRecurring(opts.accessToken);
    if (result.created > 0) {
      const count =
        opts.lang === "bn"
          ? toBnDigits(String(result.created))
          : String(result.created);
      opts.showToast(`${count} ${STRINGS[opts.lang].toastRecurringBootAdded}`);
    }
  } catch {
    // ANY failure (network, 401, 5xx) → fully silent: no toast, no log.
  }
}
