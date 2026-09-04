import { describe, expect, it } from "vitest";
import { DICT, isLang, t } from "./i18n";

describe("i18n", () => {
  it("has identical keys in bn and en", () => {
    const bn = Object.keys(DICT.bn).sort();
    const en = Object.keys(DICT.en).sort();
    expect(en).toEqual(bn);
  });

  it("translates both ways", () => {
    expect(t("bn", "navDashboard")).toBe("ড্যাশবোর্ড");
    expect(t("en", "navDashboard")).toBe("Dashboard");
  });

  it("falls back to bn for missing en keys", () => {
    const dict = DICT.en as Record<string, string | undefined>;
    // simulate a missing translation
    Object.defineProperty(dict, "__test_missing__", { value: undefined, configurable: true });
    // DICT is `as const`, so probe the bn dict through an index-signature view.
    const bnDict = DICT.bn as Record<string, string | undefined>;
    expect(t("en", "__test_missing__" as never)).toBe(bnDict.__test_missing__);
  });

  it("validates lang", () => {
    expect(isLang("bn")).toBe(true);
    expect(isLang("fr")).toBe(false);
  });
});
