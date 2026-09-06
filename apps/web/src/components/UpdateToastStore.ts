/**
 * Imperative store backing the PWA update prompt (T16.2) — same pattern as
 * lib/toast.ts: a single shared slot that main.tsx fills from the
 * virtual:pwa-register callbacks and components/UpdateToast.tsx renders.
 * Unlike the message toast the slot is sticky: it holds until the user
 * refreshes or dismisses, because an auto-hidden "update available" panel
 * would defeat its purpose.
 */

export interface UpdatePromptState {
  id: number;
  /** Trigger the actual refresh (updateSW() or location.reload()). */
  refresh: () => void;
}

export type UpdatePromptListener = (state: UpdatePromptState | null) => void;

let current: UpdatePromptState | null = null;
let seq = 0;
const listeners = new Set<UpdatePromptListener>();

function emit(): void {
  for (const listener of listeners) listener(current);
}

/** Current prompt, if any (exposed for late-mounting hosts). */
export function currentUpdatePrompt(): UpdatePromptState | null {
  return current;
}

/** Subscribe to prompt changes; returns an unsubscribe function. */
export function subscribeUpdatePrompt(
  listener: UpdatePromptListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce that a new app version is ready. A later notification replaces
 * the current one (the newest update wins); the panel is never auto-hidden.
 */
export function notifyAppUpdate(refresh: () => void): void {
  current = { id: ++seq, refresh };
  emit();
}

/** "Later" — hide the panel. The service-worker update itself is untouched. */
export function dismissAppUpdate(): void {
  if (current === null) return;
  current = null;
  emit();
}
