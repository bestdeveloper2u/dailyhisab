import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VoiceOverlay } from "../src/components/VoiceOverlay";
import { makeResponse, renderWithProviders, resetLang, stubFetch, type RouteHandler } from "./helpers";

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
});
