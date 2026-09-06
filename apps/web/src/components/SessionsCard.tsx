import { useEffect, useRef, useState } from "react";
import { toBnDigits } from "@khoroch/core";
import type { Lang } from "@khoroch/api-client";
import {
  RevokeOthersConflictError,
  useRevokeOthersMutation,
  useSessions,
  type SessionsOut,
} from "../lib/queries";
import { w } from "../lib/web-i18n";
import { useLangStore } from "../store/lang";

const TTL_ORDER: ReadonlyArray<"w" | "d" | "h" | "m"> = ["w", "d", "h", "m"];

const TTL_UNITS: Record<Lang, Record<"w" | "d" | "h" | "m", string>> = {
  bn: { w: "সপ্তাহ", d: "দি", h: "ঘ", m: "মি" },
  en: { w: "w", d: "d", h: "h", m: "m" },
};

/** Weeks-capped split of a remaining-seconds count (pure, unit-testable). */
// eslint-disable-next-line react-refresh/only-export-components -- spec: pure TTL helpers live beside the card so tests import them directly
export function splitSessionTtl(expiresIn: number): Record<"w" | "d" | "h" | "m", number> {
  const total = Math.max(0, Math.floor(expiresIn));
  return {
    w: Math.floor(total / 604800),
    d: Math.floor((total % 604800) / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
  };
}

/**
 * Humanized remaining TTL ("৬দি ২১ঘ" / "6d 21h"): the two most significant
 * non-zero units, Bengali digits in bn. Sub-minute shows "০মি" / "0m".
 * Pure + exported for unit tests.
 */
// eslint-disable-next-line react-refresh/only-export-components -- same co-location rationale
export function formatSessionTtl(expiresIn: number, lang: Lang): string {
  const parts = splitSessionTtl(expiresIn);
  let shown = TTL_ORDER.filter((unit) => parts[unit] > 0);
  if (shown.length === 0) shown = ["m"];
  shown = shown.slice(0, 2);
  return shown
    .map((unit) => {
      const n = lang === "bn" ? toBnDigits(String(parts[unit])) : String(parts[unit]);
      return `${n}${TTL_UNITS[lang][unit]}`;
    })
    .join(" ");
}

const CONFIRM_RESET_MS = 4000; // ADR-0021 spirit: destructive taps need a confirm window

/**
 * Settings "সক্রিয় সেশন" card (T26.2): the caller's live sessions with a
 * this-device badge and a two-tap revoke-others. The destructive action is
 * disabled (with an explanatory helper) while the token carries no `sid`
 * claim (`current === null`) or there is nothing else to revoke.
 * Card/row markup mirrors screens/Settings.tsx (local Card/Row twins).
 */
export function SessionsCard() {
  const lang = useLangStore((s) => s.lang);
  const sessions = useSessions();
  const revoke = useRevokeOthersMutation();
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  const data: SessionsOut | null =
    sessions.data !== undefined && sessions.data.ok ? sessions.data.data : null;
  const noCurrent = data !== null && data.current === null;
  const noOthers = data !== null && data.items.length < 2;
  const disabled = data === null || noCurrent || noOthers || revoke.isPending;

  function onTapRevoke() {
    if (revoke.isPending || data === null) return;
    if (!confirming) {
      // First tap arms the confirm window; it self-defuses after ~4s.
      setConfirming(true);
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), CONFIRM_RESET_MS);
      return;
    }
    if (confirmTimer.current !== null) {
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setConfirming(false);
    setConflict(false);
    revoke.mutate(undefined, {
      onError: (err) => {
        if (err instanceof RevokeOthersConflictError) setConflict(true);
      },
    });
  }

  let helper: string | null = null;
  if (conflict || noCurrent) helper = w(lang, "sessionsNoCurrent");
  else if (noOthers) helper = w(lang, "sessionsNoOthers");

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <p className="border-b border-line px-4 py-3 text-[13px] font-bold text-muted">
        {w(lang, "sessionsTitle")}
      </p>

      {sessions.isPending && (
        <div className="px-4 py-3.5 text-sm text-muted">{w(lang, "loading")}</div>
      )}

      {!sessions.isPending &&
        (sessions.isError || (sessions.data !== undefined && !sessions.data.ok)) && (
          <div className="px-4 py-3.5 text-sm font-medium text-danger" role="alert">
            {w(lang, "sessionsLoadErr")}
          </div>
        )}

      {data?.items.map((item) => (
        <div key={item.id} className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <span className="min-w-0 flex-1 truncate font-en text-sm text-muted" title={item.id}>
            {item.id.slice(0, 8)}
          </span>
          <span className="shrink-0 text-[13px] font-medium">
            {formatSessionTtl(item.expires_in, lang)}
          </span>
          {item.id === data.current && (
            <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] font-medium text-muted">
              {w(lang, "sessionsThisDevice")}
            </span>
          )}
        </div>
      ))}

      {data !== null && (
        <div className="px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {w(lang, "sessionsOthersLbl")}
            </span>
            <button
              type="button"
              onClick={onTapRevoke}
              disabled={disabled}
              className={`shrink-0 rounded-control border border-line px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                confirming
                  ? "bg-danger text-accent-ink hover:brightness-110"
                  : "text-danger hover:bg-surface-2"
              }`}
            >
              {revoke.isPending
                ? w(lang, "sessionsRevoking")
                : confirming
                  ? w(lang, "sessionsConfirm")
                  : w(lang, "sessionsRevoke")}
            </button>
          </div>
          {helper !== null && (
            <p
              role={conflict ? "alert" : undefined}
              className={`mt-1.5 text-xs ${conflict ? "font-medium text-danger" : "text-muted"}`}
            >
              {helper}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
