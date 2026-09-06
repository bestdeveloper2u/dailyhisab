/**
 * Boot-time recurring auto-materialization (T17.1 — ADR-0014 §3).
 *
 * After a successful auth bootstrap, RequireAuth renders
 * <RecurringAutoRun/>: once per LOCAL day per device it fires
 * POST /recurring/run so due rules materialize into real expenses without
 * the user ever opening পুনরাবৃত্ত. The endpoint is idempotent (ADR-0014
 * §3 — a same-day re-run returns created: 0), and a localStorage stamp
 * (`khoroch.recurringRun.<YYYY-MM-DD>`) keeps the client from even sending
 * the extra request. Fire-and-forget by contract: never awaited in render,
 * never blocks the UI, and created === 0 or ANY failure is fully silent
 * (no toast, no console noise).
 */
import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toBnDigits, type Lang } from "@khoroch/core";
import { apiRunRecurring } from "@khoroch/api-client";

import { useLangStore } from "../store/lang";
import { todayIso } from "./catalog";
import { toast } from "./toast";

/** localStorage key prefix; the suffix is the LOCAL date (YYYY-MM-DD). */
const STAMP_PREFIX = "khoroch.recurringRun.";

/** Stamp key for a LOCAL date (defaults to today). */
export function recurringRunStampKey(date: string = todayIso()): string {
  return `${STAMP_PREFIX}${date}`;
}

/** bn → "৫ টি আবর্তনশীল খরচ যোগ হয়েছে" · en → "5 recurring expenses added". */
function bootToastText(created: number, lang: Lang): string {
  const count = lang === "bn" ? toBnDigits(String(created)) : String(created);
  return lang === "bn"
    ? `${count} টি আবর্তনশীল খরচ যোগ হয়েছে`
    : `${count} recurring expenses added`;
}

/**
 * One guarded boot run: stamp check → optimistic stamp write → POST.
 * Exported for tests; the UI path is <RecurringAutoRun/>.
 */
export function runRecurringBoot(qc: QueryClient, lang: Lang): void {
  const key = recurringRunStampKey();
  if (typeof window !== "undefined") {
    try {
      // Already ran today (any mount, any tab) → nothing to do, silently.
      if (window.localStorage.getItem(key) !== null) return;
      // Stamp FIRST — before the request resolves — so a crash or reload
      // mid-run cannot re-fire the POST on every boot. The server's
      // same-day idempotency (created: 0) covers the residual risk anyway.
      window.localStorage.setItem(key, "1");
    } catch {
      // Storage unavailable (private mode / quota) → still attempt today's
      // run; ADR-0014 §3 server idempotency keeps a repeat harmless.
    }
  }
  void apiRunRecurring(lang)
    .then((res) => {
      // created === 0 (idempotent re-run) or an api-error result → silent.
      if (!res.ok || res.data.created <= 0) return;
      toast(bootToastText(res.data.created, lang));
      // The run just materialized real expenses — same invalidation set as
      // the Recurring screen's run-now mutation (lib/queries.ts).
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["reports"] });
      void qc.invalidateQueries({ queryKey: ["recurring"] });
    })
    .catch(() => {
      // Transport-level rejection → fully silent: no toast, no log.
    });
}

/**
 * Mount-once side-effect host for the authed tree (RequireAuth → Outlet).
 * Renders nothing. Reading lang reactively means a bn↔en flip re-runs the
 * effect, but the day stamp makes the repeat a no-op.
 */
export function RecurringAutoRun(): null {
  const qc = useQueryClient();
  const lang = useLangStore((s) => s.lang);
  useEffect(() => {
    runRecurringBoot(qc, lang);
  }, [qc, lang]);
  return null;
}
