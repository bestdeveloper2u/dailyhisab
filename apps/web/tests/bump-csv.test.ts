import { describe, expect, it } from "vitest";
import type { Expense } from "@khoroch/api-client";
import { BUMP_STEPS, bumpAmount } from "../src/lib/catalog";
import { expensesToCsv } from "../src/lib/csv";
import { makeExpense } from "./helpers";

describe("bumpAmount (prototype bump @1718)", () => {
  it("adds the chip amount to the current value", () => {
    expect(bumpAmount("", 10)).toBe("10");
    expect(bumpAmount("0", 50)).toBe("50");
    expect(bumpAmount("120", 50)).toBe("170");
    expect(bumpAmount("890.5", 100)).toBe("990.5");
    expect(bumpAmount("1500", 500)).toBe("2000");
  });

  it("treats empty/garbage input as 0", () => {
    expect(bumpAmount("", 500)).toBe("500");
    expect(bumpAmount("abc", 10)).toBe("10");
  });

  it("recovers a negative value and avoids float drift", () => {
    expect(bumpAmount("-40", 50)).toBe("10");
    expect(bumpAmount("0.1", 0.2)).toBe("0.3");
  });

  it("exposes the four prototype steps (+10/+50/+100/+500)", () => {
    expect(BUMP_STEPS.map((s) => s.add)).toEqual([10, 50, 100, 500]);
    expect(BUMP_STEPS.map((s) => s.key)).toEqual(["bump10", "bump50", "bump100", "bump500"]);
  });
});

describe("expensesToCsv (prototype csvBtn @1358)", () => {
  const row: Expense = makeExpense({ desc: 'বাজার "বড়" হাট' });

  it("emits a BOM + Bengali header + fully quoted cells", () => {
    const csv = expensesToCsv([row], "bn");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.slice(1).split("\n");
    expect(lines[0]).toBe('"তারিখ","বিবরণ","খাত","গ্রুপ","পরিমাণ","পেমেন্ট"');
    expect(lines[1]).toContain('"মাছ"');
    expect(lines[1]).toContain('"খাদ্য ও মুদি"');
    expect(lines[1]).toContain('"890.00"');
    expect(lines[1]).toContain('"নগদ টাকা"');
  });

  it("quotes embedded quotes per RFC 4180 and localizes headers", () => {
    const csv = expensesToCsv([row], "en");
    const dataRow = csv.split("\n")[1];
    expect(csv).toContain('"Date","Note","Category","Group","Amount","Payment"');
    expect(dataRow).toContain('""বড়"" হাট');
  });

  it("handles multiple rows and empty notes", () => {
    const csv = expensesToCsv([makeExpense(), makeExpense({ cat: "রিকশা", grp: "transport", pay: "cash", desc: null })], "bn");
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv).toContain('"রিকশা"');
    expect(csv).toContain('"যাতায়াত"');
  });
});
