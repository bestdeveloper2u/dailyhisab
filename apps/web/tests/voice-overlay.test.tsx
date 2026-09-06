import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { SILENCE_AUTO_SUBMIT_MS, VoiceOverlay } from "../src/components/VoiceOverlay";
import {
  makeQueryClient,
  makeResponse,
  renderWithProviders,
  resetLang,
  stubFetch,
  type RouteHandler,
} from "./helpers";

const after = () => vi.unstubAllGlobals();

beforeEach(resetLang);
afterEach(after);

/** Parse + bulk stubs; captured request bodies let the tests assert the wire format. */
function voiceHandler(opts: {
  parseResult: { items: unknown[]; confidence: number };
  onParse?: (body: unknown) => void;
  onBulk?: (body: unknown) => void;
}): RouteHandler {
  return (req, url) => {
    if (req.method === "POST" && url.pathname === "/api/v1/voice/parse") {
      return req.json().then((body) => {
        opts.onParse?.(body);
        return makeResponse(200, opts.parseResult);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/expenses/bulk") {
      return req.json().then((body) => {
        opts.onBulk?.(body);
        const items = (body as { items: unknown[] }).items;
        return makeResponse(201, { items: items.map((_, i) => ({ id: `bulk-${i}` })) });
      });
    }
    return makeResponse(404, { detail: { code: "not_found", message_bn: "নেই", message_en: "missing" } });
  };
}

describe("VoiceOverlay (speak → auto-add)", () => {
  it("auto-saves in one tap when confidence is high — no find/confirm step", async () => {
    const parseBodies: unknown[] = [];
    const bulkBodies: unknown[] = [];
    stubFetch(
      voiceHandler({
        parseResult: {
          items: [
            { amt: "890", cat: "মাছ", grp: "food", pay: null, iso: null, desc: null },
            { amt: "200.5", cat: "চাল", grp: "food", pay: "cash", iso: "2026-09-01", desc: null },
          ],
          confidence: 0.92,
        },
        onParse: (b) => parseBodies.push(b),
        onBulk: (b) => bulkBodies.push(b),
      }),
    );
    const onClose = vi.fn();
    renderWithProviders(<VoiceOverlay open onClose={onClose} />);
    const user = userEvent.setup();

    // jsdom has no SpeechRecognition — the typing fallback must show.
    expect(screen.getByText("এই ব্রাউজারে ভয়েস নেই — লিখে দিন")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "আজ মাছ ৮৯০ টাকা, চাল ২০০.৫ টাকা");
    // Single "যোগ করুন" tap = parse + auto-save; no review list in between.
    await user.click(screen.getByRole("button", { name: "যোগ করুন" }));

    expect(parseBodies).toEqual([{ text: "আজ মাছ ৮৯০ টাকা, চাল ২০০.৫ টাকা" }]);

    // Bulk payload: normalized money strings + defaulted pay/iso (ADR-0004 §1/§8).
    expect(await screen.findByText("✓ ২ সংরক্ষিত হয়েছে")).toBeInTheDocument();
    expect(bulkBodies).toHaveLength(1);
    expect(bulkBodies[0]).toEqual({
      items: [
        { amt: "890.00", cat: "মাছ", grp: "food", pay: "cash", iso: expect.any(String), desc: null },
        { amt: "200.50", cat: "চাল", grp: "food", pay: "cash", iso: "2026-09-01", desc: null },
      ],
    });
    expect(screen.queryByText("পাওয়া খরচ")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    // The ✓ state is brief; the overlay closes itself right after (1.6s timer).
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the review list for low-confidence parses so amounts can be fixed", async () => {
    stubFetch(
      voiceHandler({
        parseResult: {
          items: [{ amt: "300", cat: "রিকশা", grp: "transport", pay: null, iso: null, desc: null }],
          confidence: 0.4,
        },
      }),
    );
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox"), "রিকশা তিনশো");
    await user.click(screen.getByRole("button", { name: "যোগ করুন" }));

    // Review stage with the low-confidence hint; saving is explicit.
    expect(await screen.findByText("পাওয়া খরচ")).toBeInTheDocument();
    expect(screen.getByText("নিশ্চয়তা: ৪০%")).toBeInTheDocument();
    expect(screen.getByText("নিশ্চয়তা কম — পরিমাণ ঠিক করে সেভ করুন")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "সব সংরক্ষণ (১)" }));
    expect(await screen.findByText("✓ ১ সংরক্ষিত হয়েছে")).toBeInTheDocument();
  });

  it("keeps the transcript editable when nothing is recognized", async () => {
    stubFetch(
      voiceHandler({
        items: [],
        parseResult: { items: [], confidence: 0.9 },
      } as Parameters<typeof voiceHandler>[0]),
    );
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox"), "আজকের গল্প");
    await user.click(screen.getByRole("button", { name: "যোগ করুন" }));

    expect(await screen.findByText("কিছু বোঝা যায়নি — আবার লিখুন")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("আজকের গল্প");
    // The add button returns so the user can edit and retry.
    expect(screen.getByRole("button", { name: "যোগ করুন" })).toBeInTheDocument();
  });

  it("keeps the transcript and surfaces the API error when parsing fails", async () => {
    stubFetch(() =>
      makeResponse(422, { detail: [{ msg: "text too short", type: "value_error" }] }),
    );
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox"), "হ্যালো");
    await user.click(screen.getByRole("button", { name: "যোগ করুন" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("text too short");
    expect(screen.queryByText("পাওয়া খরচ")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("হ্যালো");
  });

  it("never submits twice — Enter auto-repeat and in-flight re-entry are guarded", async () => {
    // Owner report: a typed expense got added two times. The parse call is a
    // deferred promise so the first submit stays in flight for the whole test.
    let resolveParse: ((res: Response) => void) | null = null;
    const parseBodies: unknown[] = [];
    const handler: RouteHandler = (req, url) => {
      if (req.method === "POST" && url.pathname === "/api/v1/voice/parse") {
        return req.json().then((body) => {
          parseBodies.push(body);
          return new Promise<Response>((resolve) => {
            resolveParse = resolve;
          });
        });
      }
      return makeResponse(404, { detail: { code: "not_found", message_bn: "নেই", message_en: "missing" } });
    };
    stubFetch(handler);
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox"), "মাছ ৮৯০ টাকা");
    await user.click(screen.getByRole("button", { name: "যোগ করুন" }));
    expect(parseBodies).toHaveLength(1);

    // Held-down Enter fires repeated keydowns — none may resubmit.
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", repeat: true });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", repeat: true });

    expect(parseBodies).toHaveLength(1);
    expect(resolveParse).not.toBeNull();
    resolveParse!(makeResponse(200, { items: [], confidence: 0.9 }));
  });

  it("re-delivered final results never duplicate the transcript", async () => {
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start = vi.fn(() => instances.push(this));
      stop = vi.fn();
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    const mic = screen.getByRole("button", { name: "মাইক্রোফোন" });
    fireEvent.click(mic);
    expect(instances.length).toBeGreaterThan(0);
    const rec = instances[0];

    const evt = (results: Array<{ t: string; final: boolean }>) => ({
      resultIndex: 0,
      results: results.map((r) => ({ 0: { transcript: r.t }, isFinal: r.final, length: 1 })),
    });

    // Final delivered, then re-delivered by the engine (Android quirk), then
    // an interim follows — the committed text must contain it exactly once.
    // Direct handler calls must run inside act() so state flushes.
    act(() => rec.onresult?.(evt([{ t: "মাছ ৮৯০ টাকা", final: true }])));
    act(() => rec.onresult?.(evt([{ t: "মাছ ৮৯০ টাকা", final: true }])));
    act(() =>
      rec.onresult?.(evt([{ t: "মাছ ৮৯০ টাকা", final: true }, { t: " চাল", final: false }])),
    );
    expect(screen.getByRole("textbox")).toHaveValue("মাছ ৮৯০ টাকা চাল");

    // Stop the mic so the armed silence timer cannot leak into other tests.
    fireEvent.click(screen.getByRole("button", { name: "শুনছি…" }));
  });

  it("auto-adds after 2s of silence while listening", async () => {
    const parseBodies: unknown[] = [];
    stubFetch((req, url) => {
      if (req.method === "POST" && url.pathname === "/api/v1/voice/parse") {
        return req.json().then((body) => {
          parseBodies.push(body);
          return makeResponse(200, {
            items: [{ amt: "890", cat: "মাছ", grp: "food", pay: null, iso: null, desc: null }],
            confidence: 0.95,
          });
        });
      }
      if (req.method === "POST" && url.pathname === "/api/v1/expenses/bulk") {
        return req.json().then((body) => {
          const items = (body as { items: unknown[] }).items;
          return makeResponse(201, { items: items.map((_, i) => ({ id: `b${i}` })) });
        });
      }
      return makeResponse(404, { detail: { code: "not_found", message_bn: "নেই", message_en: "missing" } });
    });
    const instances: FakeRecognition2[] = [];
    class FakeRecognition2 {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start = vi.fn(() => instances.push(this));
      stop = vi.fn();
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition2);
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "মাইক্রোফোন" }));
    act(() =>
      instances[0].onresult?.({
        resultIndex: 0,
        results: [{ 0: { transcript: "মাছ ৮৯০ টাকা" }, isFinal: true, length: 1 }],
      }),
    );

    // Nobody presses anything — silence alone must submit the expense.
    await new Promise((r) => setTimeout(r, SILENCE_AUTO_SUBMIT_MS + 150));

    expect(parseBodies).toEqual([{ text: "মাছ ৮৯০ টাকা" }]);
    expect(await screen.findByText("✓ ১ সংরক্ষিত হয়েছে")).toBeInTheDocument();
  });
});

/*
 * T23.2 Web Share Target prefill: Expenses passes shared text as
 * `initialText`; on the closed→open transition the textarea is prefilled and
 * the SAME parse flow a manual tap triggers runs exactly once, parking at
 * the confirm step. Without initialText nothing changes.
 */
describe("VoiceOverlay initialText (T23.2 share-target prefill)", () => {
  /** Providers built here so tests can rerender with new props. */
  function renderOverlay(ui: ReactElement) {
    const queryClient = makeQueryClient();
    const tree = (node: ReactElement) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(tree(ui));
    return { ...view, rerender: (node: ReactElement) => view.rerender(tree(node)) };
  }

  it("prefills the textarea and auto-parses the shared text exactly once", async () => {
    const parseBodies: unknown[] = [];
    stubFetch(
      voiceHandler({
        parseResult: {
          items: [{ amt: "40", cat: "চা", grp: "food", pay: null, iso: null, desc: null }],
          confidence: 0.4,
        },
        onParse: (b) => parseBodies.push(b),
      }),
    );
    renderOverlay(<VoiceOverlay open initialText="চায়ে ৪০ টাকা" onClose={() => {}} />);

    // Prefilled…
    expect(screen.getByRole("textbox", { name: "যা বলতে চান তা লিখুন — বা মাইকে চেপে বলুন" })).toHaveValue(
      "চায়ে ৪০ টাকা",
    );
    // …auto-parsed once (same pipeline as a manual "যোগ করুন" tap)…
    await waitFor(() => expect(parseBodies).toEqual([{ text: "চায়ে ৪০ টাকা" }]));
    // …and parked at the confirm step (low confidence → review list).
    expect(await screen.findByText("পাওয়া খরচ")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "যা বলতে চান তা লিখুন — বা মাইকে চেপে বলুন" })).toHaveValue(
      "চায়ে ৪০ টাকা",
    );
    expect(parseBodies).toHaveLength(1);
  });

  it("parse failure leaves the shared text in the textarea for manual confirm", async () => {
    stubFetch(() => makeResponse(422, { detail: [{ msg: "text too short", type: "value_error" }] }));
    renderOverlay(<VoiceOverlay open initialText="হ্যালো" onClose={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("text too short");
    expect(screen.getByRole("textbox", { name: "যা বলতে চান তা লিখুন — বা মাইকে চেপে বলুন" })).toHaveValue("হ্যালো");
    // The add button returns so the user can edit and retry.
    expect(screen.getByRole("button", { name: "যোগ করুন" })).toBeInTheDocument();
  });

  it("re-opening without initialText never re-applies (Expenses clears the prop on close)", async () => {
    const parseBodies: unknown[] = [];
    const onClose = vi.fn();
    stubFetch(
      voiceHandler({
        parseResult: {
          items: [{ amt: "40", cat: "চা", grp: "food", pay: null, iso: null, desc: null }],
          confidence: 0.4,
        },
        onParse: (b) => parseBodies.push(b),
      }),
    );
    const view = renderOverlay(<VoiceOverlay open initialText="চায়ে ৪০ টাকা" onClose={onClose} />);
    await screen.findByText("পাওয়া খরচ");
    expect(parseBodies).toHaveLength(1);

    // Close via ✕ (reset() + onClose run — exactly Expenses' path), then
    // reopen from the mic button: no initialText, so nothing re-prefills
    // or re-parses.
    await userEvent.setup().click(screen.getByRole("button", { name: "বাতিল" }));
    view.rerender(<VoiceOverlay open={false} onClose={onClose} />);
    view.rerender(<VoiceOverlay open onClose={onClose} />);
    expect(await screen.findByRole("dialog", { name: "ভয়েসে খরচ যোগ করুন" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "যা বলতে চান তা লিখুন — বা মাইকে চেপে বলুন" })).toHaveValue("");
    expect(onClose).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(parseBodies).toHaveLength(1);
  });

  it("no initialText → no prefill and no auto-parse (behavior unchanged)", async () => {
    const parseBodies: unknown[] = [];
    stubFetch(
      voiceHandler({
        parseResult: { items: [], confidence: 0.9 },
        onParse: (b) => parseBodies.push(b),
      }),
    );
    renderOverlay(<VoiceOverlay open onClose={() => {}} />);

    expect(screen.getByRole("textbox", { name: "যা বলতে চান তা লিখুন — বা মাইকে চেপে বলুন" })).toHaveValue("");
    await new Promise((r) => setTimeout(r, 50));
    expect(parseBodies).toEqual([]);
    // Empty text → the add button stays hidden (same as before this feature).
    expect(screen.queryByRole("button", { name: "যোগ করুন" })).not.toBeInTheDocument();
  });
});
