import { describe, expect, it } from "vitest";
import { bnToEnDigits, parseBudgetAmount, parseDebtText } from "../src/lib/parseDebt";

/**
 * Prototype VOICE_CTX.debt parity: "করিমকে ৫০০ টাকা ধার দিলাম, বাজারের বাকি"
 * → party করিম, dir lend, amt 500, note "বাজারের বাকি". All parsing happens
 * on-device (regex) — no AI call, no token cost.
 */
describe("parseDebtText (voice debt parser, on-device)", () => {
  it("parses the prototype lend sentence with note", () => {
    expect(parseDebtText("করিমকে ৫০০ টাকা ধার দিলাম, বাজারের বাকি")).toEqual({
      party: "করিম",
      dir: "lend",
      amt: "500",
      note: "বাজারের বাকি",
    });
  });

  it("parses a spaced borrow sentence", () => {
    expect(parseDebtText("রহিম থেকে ২০০ ধার নিলাম")).toEqual({
      party: "রহিম",
      dir: "borrow",
      amt: "200",
      note: "",
    });
  });

  it("parses glued কাছে borrow with ASCII digits", () => {
    const parsed = parseDebtText("সেলিমকাছে 1,250 টাকা ধার নিয়েছি");
    expect(parsed?.party).toBe("সেলিম");
    expect(parsed?.dir).toBe("borrow");
    expect(parsed?.amt).toBe("1250");
  });

  it("keeps the note clean when the amount carries a thousands comma", () => {
    // Regression: the separator comma used to leak into the note because
    // note extraction read the RAW string ("250 টাকা ধার নিয়েছি").
    const parsed = parseDebtText("সেলিমকাছে 1,250 টাকা ধার নিয়েছি");
    expect(parsed?.amt).toBe("1250");
    expect(parsed?.note).toBe("");
  });

  it("defaults to lend when both দিলাম and নিলাম appear", () => {
    expect(parseDebtText("করিমকে ৫০০ দিলাম আগে নিলাম ছিল")?.dir).toBe("lend");
  });

  it("strips a leading ধার/দেনা keyword from the party word", () => {
    expect(parseDebtText("ধাররহিমকে ৩০০ টাকা দিলাম")?.party).toBe("রহিম");
    expect(parseDebtText("দেনাসেলিম থেকে ২৫০ নিলাম")?.party).toBe("সেলিম");
  });

  it("parses a spaced borrow sentence that carries a note", () => {
    // Regression: the glued regex used to match inside "থেকে" itself
    // (prefix "থে" + suffix "কে"), so the real name never won.
    expect(parseDebtText("রহিম থেকে ২০০ ধার নিলাম, আগের বাকি")).toEqual({
      party: "রহিম",
      dir: "borrow",
      amt: "200",
      note: "আগের বাকি",
    });
  });

  it("defaults direction to lend when only দিলাম appears", () => {
    expect(parseDebtText("করিমকে ৫০০ দিলাম")?.dir).toBe("lend");
  });

  it("returns null without an amount", () => {
    expect(parseDebtText("করিমকে ধার দিলাম")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parseDebtText("   ")).toBeNull();
  });

  it("bnToEnDigits converts all Bengali digits", () => {
    expect(bnToEnDigits("৫০০.২৫")).toBe("500.25");
  });

  it("parses a spaced কাছে party too", () => {
    expect(parseDebtText("রহিম কাছে ১০০ নিলাম")?.party).toBe("রহিম");
  });
});

/**
 * Bengali number-word amounts — parity with the server expense voice parser
 * (apps/api/app/routers/voice.py _NUMBER_WORDS): "করিমকে পাঁচশো টাকা ধার
 * দিলাম" → 500, "এই মাসের বাজেট আট হাজার টাকা" → 8000.
 */
describe("Bengali number-word amounts (server voice.py parity)", () => {
  it("parses the prototype word-amount debt sentence", () => {
    expect(parseDebtText("করিমকে পাঁচশো টাকা ধার দিলাম")).toEqual({
      party: "করিম",
      dir: "lend",
      amt: "500",
      note: "",
    });
  });

  it("multiplies a word amount by হাজার (দুই হাজার → 2000)", () => {
    expect(parseDebtText("রহিম থেকে দুই হাজার টাকা ধার নিলাম")).toEqual({
      party: "রহিম",
      dir: "borrow",
      amt: "2000",
      note: "",
    });
  });

  it("matches longest-first (একশো → 100, not এক → 1)", () => {
    expect(parseDebtText("করিমকে একশো টাকা দিলাম")?.amt).toBe("100");
  });

  it("keeps digit precedence and multiplies digits by হাজার (১ হাজার → 1000)", () => {
    // Server parity: test_parse_thousand_multiplier "বই ১ হাজার" → 1000.
    expect(parseDebtText("করিমকে ১ হাজার টাকা দিলাম")?.amt).toBe("1000");
  });

  it("treats a bare হাজার as 1000", () => {
    expect(parseDebtText("করিমকে হাজার টাকা দিলাম")?.amt).toBe("1000");
  });

  it("budget parses আট হাজার (the task example)", () => {
    expect(parseBudgetAmount("এই মাসের বাজেট আট হাজার টাকা")).toBe("8000");
  });

  it("budget parses পাঁচ হাজার without grabbing হাজার as the base", () => {
    expect(parseBudgetAmount("এই মাসের বাজেট পাঁচ হাজার টাকা")).toBe("5000");
  });

  it("budget parses নব্বই হাজার (longest-first: নব্বই → 90)", () => {
    expect(parseBudgetAmount("এই মাসের বাজেট নব্বই হাজার টাকা")).toBe("90000");
  });

  it("budget accepts a plain word amount with no multiplier (পঞ্চাশ → 50)", () => {
    expect(parseBudgetAmount("এই মাসের বাজেট পঞ্চাশ টাকা")).toBe("50");
  });

  it("budget still combines ASCII digits with হাজার", () => {
    expect(parseBudgetAmount("এই মাসের বাজেট ২ হাজার টাকা")).toBe("2000");
  });

  it("returns null when only non-number words appear", () => {
    expect(parseDebtText("করিমকে ধার দিলাম")).toBeNull();
  });
});

/**
 * Prototype VOICE_CTX.budget: "এই মাসের বাজেট ২৫০০০ টাকা" → 25000. No
 * number → null keeps the transcript editable instead of saving nonsense.
 */
describe("parseBudgetAmount (voice budget parser, on-device)", () => {
  it("parses the prototype budget sentence", () => {
    expect(parseBudgetAmount("এই মাসের বাজেট ২৫০০০ টাকা")).toBe("25000");
  });

  it("strips a thousands comma from the budget amount", () => {
    expect(parseBudgetAmount("এই মাসের বাজেট 25,000 টাকা")).toBe("25000");
  });

  it("returns null without any number", () => {
    expect(parseBudgetAmount("বাজেট সেট করো")).toBeNull();
  });
});
