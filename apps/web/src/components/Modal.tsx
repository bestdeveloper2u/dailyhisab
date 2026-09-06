import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible dialog name. */
  label: string;
  children: ReactNode;
}

/**
 * Elements the dialog's Tab cycle may stop on (WAI-ARIA APG dialog pattern).
 * Disabled form controls are excluded; hidden elements are rare in our
 * sheets, so DOM-order matching is enough here.
 */
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Bottom-sheet on small viewports / centered panel on desktop, mirroring the
 * frozen prototype's voice overlay. Closes on Escape and backdrop click.
 *
 * Focus contract (WAI-ARIA APG dialog pattern): on open, focus moves to the
 * first focusable descendant — or to the panel itself when the content has
 * none; Tab / Shift+Tab cycle within the dialog; on close, focus returns to
 * the element that was focused before opening, but only if it is still
 * connected to the document (it may have been unmounted with the dialog).
 */
export function Modal({ open, onClose, label, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Latest-ref pattern: consumers pass inline callbacks (e.g. VoiceOverlay's
  // handleClose), so reading onClose through a ref lets the focus effect
  // depend on [open] alone — parent re-renders must never tear focus down,
  // restore it, and yank it back mid-typing.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    // Remember the trigger for restoration. Nothing focused → activeElement
    // is <body>; restoring to <body> is meaningless, so skip the capture.
    const active = document.activeElement;
    triggerRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;

    // APG: initial focus goes to the first focusable element inside the
    // dialog; when the content has none, the dialog container takes focus
    // (the panel carries tabIndex={-1} for exactly this).
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (first) {
        first.focus();
      } else {
        panel.focus();
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const dialog = panelRef.current;
      if (!dialog) return;

      // Compute the cycle fresh on every Tab — content (and therefore the
      // focusable list) can change between keystrokes.
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );

      // Zero tabbable descendants: pin focus to the dialog panel itself.
      if (focusables.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }

      const current = document.activeElement;
      const index =
        current instanceof HTMLElement ? focusables.indexOf(current) : -1;

      if (e.shiftKey) {
        // Shift+Tab from the first focusable (or from outside the cycle)
        // wraps around to the last.
        if (index <= 0) {
          e.preventDefault();
          focusables[focusables.length - 1].focus();
        }
      } else if (index === -1 || index === focusables.length - 1) {
        // Tab from the last focusable (or from outside the cycle) wraps
        // around to the first — this is what keeps keyboard focus from
        // escaping behind the backdrop.
        e.preventDefault();
        focusables[0].focus();
      }
      // Mid-cycle Tab/Shift+Tab is left to the browser's natural order.
    };

    // One window listener handles both Escape and containment; the cleanup
    // below removes exactly what was added, so React StrictMode's
    // mount→cleanup→mount double-invoke can never stack duplicate listeners.
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Runs on close (open→false) and on unmount-while-open: hand focus
      // back to the trigger if it survived in the document.
      const trigger = triggerRef.current;
      triggerRef.current = null;
      if (trigger && trigger.isConnected) trigger.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-sm lg:items-center"
      onClick={onClose}
      data-testid="modal-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-card border border-line bg-surface shadow-card lg:max-w-lg lg:rounded-card"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
