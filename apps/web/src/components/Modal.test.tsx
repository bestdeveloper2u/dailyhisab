import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { Modal } from "./Modal";

/**
 * T18.1 — WAI-ARIA APG dialog focus contract: initial focus into the dialog,
 * Tab containment, focus restoration to the trigger, and Escape/backdrop
 * close all coexisting through one window keydown listener.
 */

/** Trigger button (stays mounted) + a dialog with three focusable children. */
function Fixture({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <button type="button" onClick={onClose}>
        trigger
      </button>
      <Modal open={open} onClose={onClose} label="Test dialog">
        <div>
          <button type="button">First</button>
          <button type="button">Second</button>
          <button type="button">Last</button>
        </div>
      </Modal>
    </>
  );
}

beforeEach(() => {
  // Leave no focus behind from a previous test — activeElement must be body.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
});

describe("Modal focus contract", () => {
  it("open moves focus to the first focusable element inside the dialog", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Fixture open={false} onClose={onClose} />);
    screen.getByRole("button", { name: "trigger" }).focus();

    rerender(<Fixture open onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Test dialog" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("open with no focusable child focuses the dialog panel itself", () => {
    render(
      <Modal open onClose={() => {}} label="Empty dialog">
        <p>static content</p>
      </Modal>,
    );

    expect(screen.getByRole("dialog", { name: "Empty dialog" })).toHaveFocus();
  });

  it("Tab on last element wraps to first; Shift+Tab on first wraps to last; mid-cycle Tab is untouched", () => {
    const onClose = vi.fn();
    render(<Fixture open onClose={onClose} />);
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(first).toHaveFocus();

    // Shift+Tab from the first focusable wraps around to the last.
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    // Tab from the last focusable wraps around to the first.
    fireEvent.keyDown(window, { key: "Tab" });
    expect(first).toHaveFocus();

    // Between the boundaries the browser keeps its natural order — the
    // handler must not hijack focus.
    second.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(second).toHaveFocus();
  });

  it("Escape calls onClose AND focus returns to the trigger button that was focused before open", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Fixture open={false} onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();

    rerender(<Fixture open onClose={onClose} />);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The parent flips open=false in response; the effect cleanup restores.
    rerender(<Fixture open={false} onClose={onClose} />);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("backdrop click calls onClose; when open=false renders nothing", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Fixture open onClose={onClose} />);

    fireEvent.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Fixture open={false} onClose={onClose} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("modal-backdrop")).not.toBeInTheDocument();
  });

  it("no crash when document.activeElement is body at open (no restore attempt)", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Fixture open={false} onClose={onClose} />);
    expect(document.activeElement).toBe(document.body);

    rerender(<Fixture open onClose={onClose} />);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();

    rerender(<Fixture open={false} onClose={onClose} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("with zero focusables, Tab and Shift+Tab keep focus pinned to the panel", () => {
    render(
      <Modal open onClose={() => {}} label="Empty dialog">
        <p>static content</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Empty dialog" });

    fireEvent.keyDown(window, { key: "Tab" });
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(dialog).toHaveFocus();
  });

  it("does not stack duplicate Escape listeners across StrictMode double-invoked effects", () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Modal open onClose={onClose} label="Strict dialog">
          <button type="button">Inside</button>
        </Modal>
      </StrictMode>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
