import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateToastHost } from "../src/components/UpdateToast";
import {
  currentUpdatePrompt,
  dismissAppUpdate,
  notifyAppUpdate,
} from "../src/components/UpdateToastStore";
import { useLangStore } from "../src/store/lang";

/**
 * T16.2 — PWA update prompt. main.tsx fills the shared slot from the
 * virtual:pwa-register callbacks (onNeedRefresh / onNeedReload) with the
 * real refresh trigger; these tests drive the slot directly so the branded
 * panel is covered without dragging the virtual module into vitest.
 */

beforeEach(() => {
  // Reset the module-level slot (and the persisted language) so tests never
  // leak state into each other, mirroring the toast.test.tsx hygiene.
  dismissAppUpdate();
  useLangStore.setState({ lang: "bn" });
});

describe("UpdateToastHost", () => {
  it("renders nothing until an update is announced", () => {
    render(<UpdateToastHost />);

    expect(screen.queryByTestId("update-toast")).not.toBeInTheDocument();
  });

  it("shows the branded refresh prompt and calls the refresh handler once", () => {
    const refresh = vi.fn();
    render(<UpdateToastHost />);

    act(() => {
      notifyAppUpdate(refresh);
    });

    expect(screen.getByTestId("update-toast")).toHaveTextContent(
      "নতুন সংস্করণ প্রস্তুত",
    );
    expect(
      screen.getByRole("button", { name: "রিফ্রেশ করুন" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "পরে" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "রিফ্রেশ করুন" }));

    expect(refresh).toHaveBeenCalledTimes(1);
    // Refreshing means reloading — the panel clears instead of stranding.
    expect(screen.queryByTestId("update-toast")).not.toBeInTheDocument();
    expect(currentUpdatePrompt()).toBeNull();
  });

  it("appears immediately on late-mounted hosts reading the shared slot", () => {
    notifyAppUpdate(() => {});
    render(<UpdateToastHost />);

    expect(screen.getByTestId("update-toast")).toBeInTheDocument();
  });

  it("localizes the copy from the active language (en)", () => {
    useLangStore.setState({ lang: "en" });
    render(<UpdateToastHost />);

    act(() => {
      notifyAppUpdate(() => {});
    });

    expect(screen.getByTestId("update-toast")).toHaveTextContent(
      "A new version is ready",
    );
    expect(
      screen.getByRole("button", { name: "Refresh now" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "রিফ্রেশ করুন" }),
    ).not.toBeInTheDocument();
  });

  it("'Later' dismisses the panel without refreshing", () => {
    const refresh = vi.fn();
    render(<UpdateToastHost />);
    act(() => {
      notifyAppUpdate(refresh);
    });

    fireEvent.click(screen.getByRole("button", { name: "পরে" }));

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId("update-toast")).not.toBeInTheDocument();
    expect(currentUpdatePrompt()).toBeNull();
  });

  it("a newer notification replaces the refresh handler (latest wins)", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<UpdateToastHost />);

    act(() => {
      notifyAppUpdate(first);
      notifyAppUpdate(second);
    });

    expect(screen.getAllByTestId("update-toast")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "রিফ্রেশ করুন" }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
