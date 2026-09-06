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
