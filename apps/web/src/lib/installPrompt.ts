/**
 * PWA install-prompt capture (T26.1) — MDN BeforeInstallPromptEvent:
 * https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent
 *
 * Same imperative-store pattern as components/UpdateToastStore.ts and
 * lib/toast.ts: a single module-scope slot that the (single) `beforeinstallprompt`
 * listener fills and components subscribe to. The event fires at most once per
 * page load — and never in already-installed or unsupported contexts — so the
 * listeners are registered exactly once at module init (SSR/no-window safe)
 * and `prompt()` is consumed by at most one caller (a second call throws
 * InvalidStateError).
 */
import { useSyncExternalStore } from "react";

/** Minimal local shape — lib.dom does not ship BeforeInstallPromptEvent. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface InstallPromptState {
  /** A beforeinstallprompt was captured and prompt() has not been used yet. */
  canInstall: boolean;
  /** Already running standalone, or the appinstalled event fired. */
  installed: boolean;
  /** User chose "Later" on the chip — persisted, survives reloads. */
  dismissed: boolean;
}

export type InstallPromptListener = (state: InstallPromptState) => void;

/** localStorage key for the dismissed flag (mirrors "khoroch.lang"). */
const STORAGE_KEY = "khoroch.installChip";

let promptEvent: BeforeInstallPromptEvent | null = null;
let installed = false;
let dismissed = false;
const listeners = new Set<InstallPromptListener>();

let state: InstallPromptState = { canInstall: false, installed: false, dismissed: false };

function recompute(): void {
  state = {
    canInstall: promptEvent !== null && !installed,
    installed,
    dismissed,
  };
}

function emit(): void {
  recompute();
  for (const listener of listeners) listener(state);
}

/** Current state, if any (exposed for late-mounting hosts / useSyncExternalStore). */
export function currentInstallState(): InstallPromptState {
  return state;
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribeInstallState(listener: InstallPromptListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reactive snapshot for components (SSR-safe third arg mirrors the store). */
export function useInstallPrompt(): InstallPromptState {
  return useSyncExternalStore(subscribeInstallState, currentInstallState, currentInstallState);
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // private mode / storage disabled — dismissal is per-load only
  }
}

function isStandalone(): boolean {
  try {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches
    );
  } catch {
    return false;
  }
}

/**
 * Show the browser's install UI. Resolves the user's choice, or `null` when
 * there is nothing to prompt with (no captured event / already installed /
 * prompt() rejected). The captured event is single-use: it is consumed the
 * moment prompt() leaves, so canInstall drops even on a "dismissed" outcome —
 * the chip then waits for the next beforeinstallprompt (a fresh page load).
 */
export async function promptInstall(): Promise<{
  outcome: "accepted" | "dismissed";
} | null> {
  const event = promptEvent;
  if (event === null || installed) return null;
  promptEvent = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "accepted") {
      // appinstalled usually follows; flag installed immediately so the chip
      // can never flash back in the gap before the event lands.
      installed = true;
    }
    emit();
    return { outcome: choice.outcome };
  } catch {
    emit(); // prompt() threw (user-agent refusal) — state back to not-installable
    return null;
  }
}

/**
 * "Later" — hides the chip for good. The captured event is NOT consumed here
 * (the browser may still fire its own UI); only this app's chip is muted.
 */
export function dismissInstallChip(): void {
  dismissed = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // storage unavailable — dismissal still holds for this page load
  }
  emit();
}

function init(): void {
  if (typeof window === "undefined") return;
  installed = isStandalone();
  dismissed = readDismissed();
  recompute();
  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault(); // keep Chrome's mini-infobar out of the app's way
    promptEvent = ev as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    promptEvent = null;
    emit();
  });
}

init();
