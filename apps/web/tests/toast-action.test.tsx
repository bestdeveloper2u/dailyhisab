import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_TOAST_DURATION,
  TOAST_DURATION,
  dismissToast,
  subscribeToasts,
  toast,
  toastWithAction,
} from "../src/lib/toast";
import { ToastHost } from "../src/components/Toast";

/**
 * T22.1 — toastWithAction: the reversible-destruction toast. A message with
 * an inline action button (Undo) that lives ~6s inside the existing
 * role=status live region; plain toast() behaviour is untouched.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain any pending auto-hide timer so module-level state never leaks
  // between tests (the toast module keeps a single shared slot).
  act(() => {
    vi.advanceTimersByTime(ACTION_TOAST_DURATION + 100);
  });
  vi.useRealTimers();
});

describe("toastWithAction", () => {
  it("renders the action as a button inside the status live region", () => {
    render(<ToastHost />);
    act(() => {
      toastWithAction("মোছা হয়েছে", { label: "ফিরিয়ে আনুন", onClick: () => {} });
    });

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("মোছা হয়েছে");
    // The action lives INSIDE the same live region and never steals focus.
    expect(screen.getByRole("button", { name: "ফিরিয়ে আনুন" })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it("clicking the action runs its callback and dismisses the toast", () => {
    render(<ToastHost />);
    const onClick = vi.fn();
    act(() => {
      toastWithAction("Deleted", { label: "Undo", onClick });
    });

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("keeps the action toast visible ~6s, longer than a plain toast", () => {
    render(<ToastHost />);
    act(() => {
      toastWithAction("Deleted", { label: "Undo", onClick: () => {} });
    });

    // Still visible past the plain-toast horizon…
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION + 500);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Deleted");

    // …and auto-dismisses at the ~6s action horizon.
    act(() => {
      vi.advanceTimersByTime(ACTION_TOAST_DURATION - TOAST_DURATION);
    });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("plain toast() is unchanged: no button, ~2.6s lifetime", () => {
    render(<ToastHost />);
    act(() => {
      toast("সংরক্ষিত ✓");
    });

    expect(screen.getByRole("status")).toHaveTextContent("সংরক্ষিত ✓");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION - 100);
    });
    expect(screen.getByRole("status")).toHaveTextContent("সংরক্ষিত ✓");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("a follow-up toast fired by the action survives the dismissal", () => {
    render(<ToastHost />);
    act(() => {
      // Undo's onClick fires a NEW toast (e.g. "restored") — the dismissal
      // triggered by the click itself must not swallow it.
      toastWithAction("Deleted", {
        label: "Undo",
        onClick: () => toast("ফিরিয়ে আনো হয়েছে"),
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(screen.getByRole("status")).toHaveTextContent("ফিরিয়ে আনো হয়েছে");
    // …and the follow-up runs on the plain 2.6s lifetime, not the 6s one.
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION + 100);
    });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("dismissToast(id) no-ops when a newer toast already replaced this one", () => {
    const ids: number[] = [];
    const unsubscribe = subscribeToasts((s) => {
      if (s) ids.push(s.id);
    });
    render(<ToastHost />);
    act(() => {
      toast("first");
    });
    act(() => {
      toast("second");
    });
    unsubscribe();
    expect(screen.getByRole("status")).toHaveTextContent("second");

    // A stale id (the already-replaced "first" toast) changes nothing…
    act(() => {
      dismissToast(ids[0]);
    });
    expect(screen.getByRole("status")).toHaveTextContent("second");

    // …while the current id dismisses it.
    act(() => {
      dismissToast(ids[1]);
    });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
