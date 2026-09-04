import { describe, expect, it } from "vitest";
import { formatTaka, indianGrouping, moneyFromNumber, moneyToNumber, toBnDigits } from "./money";

describe("indianGrouping", () => {
  it("groups Indian style", () => {
    expect(indianGrouping("0")).toBe("0");
    expect(indianGrouping("890")).toBe("890");
    expect(indianGrouping("25000")).toBe("25,000");
    expect(indianGrouping("1234567")).toBe("12,34,567");
  });
});

describe("formatTaka", () => {
  it("formats bn with Bengali digits", () => {
    expect(formatTaka("890.00", "bn")).toBe("৳৮৯০");
    expect(formatTaka("25000.50", "bn")).toBe("৳২৫,০০০.৫০");
  });
  it("formats en with Latin digits", () => {
    expect(formatTaka("890.00", "en")).toBe("৳890");
    expect(formatTaka("25000.50", "en")).toBe("৳25,000.50");
  });
  it("handles numbers and junk", () => {
    expect(formatTaka(1234.56, "en")).toBe("৳1,234.56");
    expect(formatTaka("abc", "bn")).toBe("৳০");
  });
});

describe("money conversions", () => {
  it("round-trips", () => {
    expect(moneyToNumber(moneyFromNumber(890))).toBeCloseTo(890);
    expect(moneyFromNumber(-5)).toBe("0.00");
  });
  it("converts digits", () => {
    expect(toBnDigits("৳25,000")).toBe("৳২৫,০০০");
  });
});
