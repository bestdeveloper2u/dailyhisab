import { describe, expect, it } from "vitest";
import { parseExpensesCsv, toIsoDate } from "../src/lib/importCsv";

/**
 * CSV import = inverse of expensesToCsv: our own bn/en export re-imports
 * losslessly, headerless sheets follow the export column order, Bengali
 * digits and DD-MM-YYYY dates are normalized on-device (zero AI cost).
 */
describe("parseExpensesCsv (CSV import, on-device)", () => {
  const bnExport = [
    "\uFEFF",
    '"তারিখ","বিবরণ","খাত","গ্রুপ","পরিমাণ","পেমেন্ট"',
    '"2026-09-01","চাল ৫ কেজি","চাল","খাদ্য ও মুদি","৫০০","নগদ টাকা"',
    '"2026-09-02","","রিকশা","যাতায়াত","৮০","বিকাশ"',
  ].join("\n");

  it("re-imports our own bn export losslessly", () => {
    const { items, skipped } = parseExpensesCsv(bnExport);
    expect(skipped).toBe(0);
    expect(items).toEqual([
      { iso: "2026-09-01", desc: "চাল ৫ কেজি", cat: "চাল", grp: "food", pay: "cash", amt: "500.00" },
      { iso: "2026-09-02", desc: undefined, cat: "রিকশা", grp: "transport", pay: "bkash", amt: "80.00" },
    ]);
  });

  it("re-imports our own en export via header detection", () => {
    const csv = [
      '"Date","Note","Category","Group","Amount","Payment"',
      '"2026-09-03","eggs","eggs","Food & Groceries","120.50","Cash"',
    ].join("\n");
    const { items } = parseExpensesCsv(csv);
    expect(items[0]).toMatchObject({ iso: "2026-09-03", cat: "eggs", grp: "food", pay: "cash", amt: "120.50" });
  });

  it("accepts headerless rows in export column order", () => {
    const csv = '2026-09-01,milk,milk,খাদ্য ও মুদি,"1,250",nagad';
    const { items } = parseExpensesCsv(csv);
    expect(items[0]).toMatchObject({ iso: "2026-09-01", cat: "milk", grp: "food", pay: "nagad", amt: "1250.00" });
  });

  it("normalizes DD-MM-YYYY dates and skips garbage rows", () => {
    const csv = [
      "তারিখ,বিবরণ,খাত,গ্রুপ,পরিমাণ,পেমেন্ট",
      "05/09/2026,x,x,অন্যান্য,৩০,নগদ টাকা",
      "bad-date,x,x,অন্যান্য,৩০,নগদ টাকা",
      "2026-09-05,x,x,অন্যান্য,০,নগদ টাকা",
    ].join("\n");
    const { items, skipped } = parseExpensesCsv(csv);
    expect(items[0].iso).toBe("2026-09-05");
    expect(skipped).toBe(2);
  });

  it("unknown groups fall back to other, unknown pay to cash", () => {
    const csv = "2026-09-01,,misc,mystery-group,10,mystery-pay";
    const { items } = parseExpensesCsv(csv);
    expect(items[0].grp).toBe("other");
    expect(items[0].pay).toBe("cash");
  });

  it("returns empty for an empty file", () => {
    expect(parseExpensesCsv("   \n").items).toHaveLength(0);
  });

  it("toIsoDate: ISO stays, dashes and slashes both work, junk rejected", () => {
    expect(toIsoDate("2026-09-05")).toBe("2026-09-05");
    expect(toIsoDate("০৫-০৯-২০২৬")).toBe("2026-09-05");
    expect(toIsoDate("5/9/2026")).toBe("2026-09-05");
    expect(toIsoDate("yesterday")).toBeNull();
    expect(toIsoDate("2026-13-40")).toBeNull();
  });
});
