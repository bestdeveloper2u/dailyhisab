/**
 * Imperative toast module (prototype www/index.html toast() @1634-1637):
 * a single shared message slot driven by `toast(text)` from anywhere
 * (mutation callbacks, helpers, event handlers). `components/Toast.tsx`
 * renders the visible live region.
 *
 * T22.1 delete-undo (NN/g "Confirmation Dialogs"): `toastWithAction` adds a
 * reversible-destruction toast — the message stays ~6s with an inline action
 * button (e.g. "Undo") so a single-tap delete can be taken back.
 */

export const TOAST_DURATION = 2600;

/** Action toasts linger ~6s — undo needs time to be noticed and clicked. */
export const ACTION_TOAST_DURATION = 6000;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastState {
  id: number;
  text: string;
  action?: ToastAction;
}

export type ToastListener = (state: ToastState | null) => void;

let current: ToastState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
const listeners = new Set<ToastListener>();

function emit(): void {
  for (const listener of listeners) listener(current);
}

function showToast(text: string, action: ToastAction | undefined, durationMs: number): void {
  if (!text) return;
  if (timer !== null) clearTimeout(timer);
  current = action ? { id: ++seq, text, action } : { id: ++seq, text };
  emit();
  timer = setTimeout(() => {
    current = null;
    timer = null;
    emit();
  }, durationMs);
}

/** Current message, if any (exposed for late-mounting hosts). */
export function currentToast(): ToastState | null {
  return current;
}

/** Subscribe to toast changes; returns an unsubscribe function. */
export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Show a message for ~2.6s. Bengali text for bn locale, English for en. */
export function toast(text: string): void {
  showToast(text, undefined, TOAST_DURATION);
}

/**
 * Show a message with an inline action (undo) for ~6s. The action is rendered
 * as a button inside the live region by `components/Toast.tsx`.
 */
export function toastWithAction(
  text: string,
  action: ToastAction,
  durationMs: number = ACTION_TOAST_DURATION,
): void {
  showToast(text, action, durationMs);
}

/**
 * Dismiss the current toast programmatically (the action button was clicked).
 * With an `id`, the dismissal no-ops when a newer toast already replaced it —
 * the action may itself fire a follow-up toast that must survive.
 */
export function dismissToast(id?: number): void {
  if (id !== undefined && current?.id !== id) return;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  current = null;
  emit();
}
