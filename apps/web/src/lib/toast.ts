/**
 * Imperative toast module (prototype www/index.html toast() @1634-1637):
 * a single shared message slot driven by `toast(text)` from anywhere
 * (mutation callbacks, helpers, event handlers). `components/Toast.tsx`
 * renders the visible live region.
 */

export const TOAST_DURATION = 2600;

export interface ToastState {
  id: number;
  text: string;
}

export type ToastListener = (state: ToastState | null) => void;

let current: ToastState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
const listeners = new Set<ToastListener>();

function emit(): void {
  for (const listener of listeners) listener(current);
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
  if (!text) return;
  if (timer !== null) clearTimeout(timer);
  current = { id: ++seq, text };
  emit();
  timer = setTimeout(() => {
    current = null;
    timer = null;
    emit();
  }, TOAST_DURATION);
}
