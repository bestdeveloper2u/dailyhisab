import { describe, expect, it } from "vitest";
import { fmtMoney, fmtTaka } from "./money";

describe("fmtMoney", () => {
  it("groups Indian-style (prototype fmt parity)", () => {
    expect(fmtMoney(49778)).toBe("49,778");
    expect(fmtMoney(1250000)).toBe("12,50,000");
  });

  it("keeps at most 2 decimals and trims trailing zeros", () => {
    expect(fmtMoney("777.50")).toBe("777.5");
    expect(fmtMoney("1234.25")).toBe("1,234.25");
    expect(fmtMoney(0.5)).toBe("0.5");
  });

  it("renders safe zero for NaN / empty / non-numeric input", () => {
    expect(fmtMoney(0)).toBe("0");
    expect(fmtMoney(NaN)).toBe("0");
    expect(fmtMoney("")).toBe("0");
    expect(fmtMoney("abc")).toBe("0");
  });
});

describe("fmtTaka", () => {
  it("en: ৳ symbol + grouped ASCII digits (prototype parity)", () => {
    expect(fmtTaka(49778, "en")).toBe("৳49,778");
    expect(fmtTaka("890.00", "en")).toBe("৳890");
  });

  it("bn: ৳ symbol + Bengali digits", () => {
    expect(fmtTaka(49778, "bn")).toBe("৳৪৯,৭৭৮");
    expect(fmtTaka("890.00", "bn")).toBe("৳৮৯০");
  });

  it("negative sign stays outside the symbol; NaN renders ৳0", () => {
    expect(fmtTaka(-500, "en")).toBe("-৳500");
    expect(fmtTaka(NaN, "bn")).toBe("৳০");
  });
});
