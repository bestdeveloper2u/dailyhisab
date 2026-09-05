import { describe, expect, it } from "vitest";
import { normalizeAmountInput } from "./num";

describe("normalizeAmountInput", () => {
  it("maps Bengali digits to ASCII, keeping the decimal dot", () => {
    expect(normalizeAmountInput("৫০.২৫")).toBe("50.25");
  });

  it("strips the ৳ symbol", () => {
    expect(normalizeAmountInput("৳৭৭")).toBe("77");
  });

  it("strips comma grouping", () => {
    expect(normalizeAmountInput("1,000")).toBe("1000");
  });

  it("strips surrounding whitespace", () => {
    expect(normalizeAmountInput(" ৪০ ")).toBe("40");
  });

  it("keeps a single dot and drops extra dots", () => {
    expect(normalizeAmountInput("১.২.৩")).toBe("1.23");
  });

  it("returns '' when nothing numeric remains", () => {
    expect(normalizeAmountInput("")).toBe("");
  });
});
