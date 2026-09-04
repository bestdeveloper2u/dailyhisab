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

describe("VoiceOverlay (parse → review → bulk save)", () => {
  it("parses a transcript, lets the user edit the review list, and bulk-saves the kept items", async () => {
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
    await user.click(screen.getByRole("button", { name: "খরচ খুঁজে বের করুন" }));

    expect(parseBodies).toEqual([{ text: "আজ মাছ ৮৯০ টাকা, চাল ২০০.৫ টাকা" }]);

    // Review stage: candidates + confidence are shown for editing.
    expect(await screen.findByText("পাওয়া খরচ")).toBeInTheDocument();
    expect(screen.getByText("নিশ্চয়তা: ৯২%")).toBeInTheDocument();
    expect(screen.getByText("মাছ")).toBeInTheDocument();
    expect(screen.getByText("খাদ্য ও মুদি · নগদ টাকা · আজ")).toBeInTheDocument();
    expect(screen.getByText("চাল")).toBeInTheDocument();

    // Edit one amount, drop the other candidate.
    const chalAmt = screen.getByLabelText("চাল — পরিমাণ (৳)");
    await user.clear(chalAmt);
    await user.type(chalAmt, "250");
    await user.click(screen.getByRole("button", { name: "মাছ — মুছুন" }));
    expect(screen.queryByText("মাছ")).not.toBeInTheDocument();
    expect(screen.getByText("মোট ব্যয়: ৳২৫০")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "সব সংরক্ষণ (১)" }));

    // Bulk payload: normalized money string + defaulted pay/iso (ADR-0004 §1/§8).
    expect(await screen.findByText("✓ ১ সংরক্ষিত হয়েছে")).toBeInTheDocument();
    expect(bulkBodies).toHaveLength(1);
    expect(bulkBodies[0]).toEqual({
      items: [{ amt: "250.00", cat: "চাল", grp: "food", pay: "cash", iso: "2026-09-01", desc: null }],
    });

    // Post-save reset: review gone, transcript cleared, overlay still open.
    expect(screen.queryByText("পাওয়া খরচ")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the transcript and surfaces the API error when parsing fails", async () => {
    stubFetch(() =>
      makeResponse(422, { detail: [{ msg: "text too short", type: "value_error" }] }),
    );
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox"), "হ্যালো");
    await user.click(screen.getByRole("button", { name: "খরচ খুঁজে বের করুন" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("text too short");
    expect(screen.queryByText("পাওয়া খরচ")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("হ্যালো");
  });
});
