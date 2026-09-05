import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { useLangStore } from "../store/lang";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * T13.2 — crash resilience. The boundary must turn any render-time throw
 * into the branded retry card, and "Try again" must reset it so the same
 * children get a fresh render. React logs boundary catches via
 * console.error; each test silences it and restores the original.
 */

let restoreConsoleError: () => void = () => {};

beforeEach(() => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  restoreConsoleError = () => spy.mockRestore();
  useLangStore.setState({ lang: "bn" });
});

afterEach(() => {
  restoreConsoleError();
});

function Bomb({
  armed,
  getArmed,
}: {
  armed?: boolean;
  getArmed?: () => boolean;
}) {
  if (armed || getArmed?.()) throw new Error("boom — render-time failure");
  return <p>all clear</p>;
}

describe("ErrorBoundary", () => {
  it("renders the branded fallback instead of white-screening when a child throws", () => {
    render(
      <ErrorBoundary>
        <Bomb armed />
      </ErrorBoundary>,
    );

    expect(screen.getByText("কিছু একটা ভুল হয়েছে")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "আবার চেষ্টা করুন" }),
    ).toBeInTheDocument();
    // The crashed subtree is gone — no leaked child output.
    expect(screen.queryByText("all clear")).not.toBeInTheDocument();
  });

  it("retry clears the error state and re-renders the children", () => {
    // Armed on first render (so the boundary catches), disarmed before the
    // retry click — proving the retry truly re-renders the child subtree.
    const bomb = { armed: true };
    render(
      <ErrorBoundary>
        <Bomb getArmed={() => bomb.armed} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("কিছু একটা ভুল হয়েছে")).toBeInTheDocument();

    bomb.armed = false;
    fireEvent.click(screen.getByRole("button", { name: "আবার চেষ্টা করুন" }));

    expect(screen.getByText("all clear")).toBeInTheDocument();
    expect(screen.queryByText("কিছু একটা ভুল হয়েছে")).not.toBeInTheDocument();
  });

  it("localizes the fallback from the active language (en)", () => {
    useLangStore.setState({ lang: "en" });

    render(
      <ErrorBoundary>
        <Bomb armed />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("কিছু একটা ভুল হয়েছে")).not.toBeInTheDocument();
  });
});
