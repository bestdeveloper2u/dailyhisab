import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T26.1 — PWA install chip. The installPrompt store is a module singleton
 * whose listeners bind at import time, so every test rebuilds it with
 * vi.resetModules + dynamic imports after stubbing matchMedia (jsdom has
 * none), then drives the real window events (beforeinstallprompt /
 * appinstalled) exactly as a browser would deliver them. The fresh lang
 * store/toast module handles are captured too — resetModules re-evaluates
 * the whole import chain, so stale static imports would observe nothing.
 */

type BipEvent = Event & {
  prompt: ReturnType<typeof vi.fn>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type ChipMod = typeof import("./InstallChip");
type LangMod = typeof import("../store/lang");
type ToastMod = typeof import("../lib/toast");

interface Setup {
  InstallChip: ChipMod["InstallChip"];
  useLangStore: LangMod["useLangStore"];
  subscribeToasts: ToastMod["subscribeToasts"];
}

/** jsdom lacks matchMedia — the module init queries it for standalone mode. */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      media: "(display-mode: standalone)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
}

function makeBipEvent(outcome: "accepted" | "dismissed"): BipEvent {
  const ev = new Event("beforeinstallprompt", { cancelable: true }) as BipEvent;
  ev.prompt = vi.fn(async () => {});
  ev.userChoice = Promise.resolve({ outcome, platform: "web" });
  return ev;
}

/** Fresh store + component per test (the store is a module singleton). */
async function setup(opts: { standalone?: boolean } = {}): Promise<Setup> {
  vi.resetModules();
  stubMatchMedia(opts.standalone ?? false);
  const chip = (await import("./InstallChip")) as ChipMod;
  const lang = (await import("../store/lang")) as LangMod;
  const toastMod = (await import("../lib/toast")) as ToastMod;
  lang.useLangStore.setState({ lang: "en" });
  return {
    InstallChip: chip.InstallChip,
    useLangStore: lang.useLangStore,
    subscribeToasts: toastMod.subscribeToasts,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("InstallChip (Settings app card, T26.1)", () => {
  it("renders nothing by default — no beforeinstallprompt ever fired", async () => {
    const { InstallChip } = await setup();

    render(<InstallChip />);

    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Later" })).not.toBeInTheDocument();
  });

  it("appears after a beforeinstallprompt arrives, preventDefault applied", async () => {
    const { InstallChip } = await setup();
    const ev = makeBipEvent("accepted");

    act(() => {
      window.dispatchEvent(ev);
    });
    render(<InstallChip />);

    expect(await screen.findByRole("button", { name: "Install app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("stays hidden in standalone display mode even with an event", async () => {
    const { InstallChip } = await setup({ standalone: true });

    act(() => {
      window.dispatchEvent(makeBipEvent("accepted"));
    });
    render(<InstallChip />);

    // installed=true from init stays true: the event must not resurrect the chip
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Later" })).not.toBeInTheDocument();
  });

  it("'Later' hides the chip and persists khoroch.installChip", async () => {
    const { InstallChip } = await setup();
    act(() => {
      window.dispatchEvent(makeBipEvent("accepted"));
    });
    render(<InstallChip />);
    await screen.findByRole("button", { name: "Install app" });

    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("khoroch.installChip")).toBe("1");
  });

  it("install click consumes prompt(); accepted outcome toasts and hides", async () => {
    const { InstallChip, subscribeToasts } = await setup();
    const ev = makeBipEvent("accepted");
    act(() => {
      window.dispatchEvent(ev);
    });
    const seen: string[] = [];
    const unsubscribe = subscribeToasts((s) => s && seen.push(s.text));
    render(<InstallChip />);
    await screen.findByRole("button", { name: "Install app" });

    fireEvent.click(screen.getByRole("button", { name: "Install app" }));

    await waitFor(() => expect(ev.prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(seen).toContain("App installed"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument(),
    );
    unsubscribe();
  });

  it("appinstalled event hides the chip (installed flag)", async () => {
    const { InstallChip } = await setup();
    act(() => {
      window.dispatchEvent(makeBipEvent("dismissed"));
    });
    render(<InstallChip />);
    await screen.findByRole("button", { name: "Install app" });

    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument(),
    );
  });
});
