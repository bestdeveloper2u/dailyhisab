import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_DURATION, toast } from "../src/lib/toast";
import { ToastHost } from "../src/components/Toast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain any pending auto-hide timer so module-level state never leaks
  // between tests (the toast module keeps a single shared slot).
  act(() => {
    vi.advanceTimersByTime(TOAST_DURATION + 100);
  });
  vi.useRealTimers();
});

describe("toast", () => {
  it("renders a polite status live region that shows and auto-hides", () => {
    render(<ToastHost />);

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("");

    act(() => {
      toast("সংরক্ষিত ✓");
    });
    expect(screen.getByRole("status")).toHaveTextContent("সংরক্ষিত ✓");

    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION + 100);
    });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("replaces a visible message instead of stacking", () => {
    render(<ToastHost />);

    act(() => {
      toast("first");
    });
    act(() => {
      toast("second");
    });

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("second");
    expect(region).not.toHaveTextContent("first");
  });

  it("ignores empty messages", () => {
    render(<ToastHost />);
    act(() => {
      toast("");
    });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});
