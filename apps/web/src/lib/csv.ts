import type { Lang } from "@khoroch/core";
import type { Expense } from "@khoroch/api-client";
import { groupName, payName } from "./catalog";

/**
 * Client-side CSV export for the loaded expense rows, mirroring the frozen
 * prototype (www/index.html csvBtn @1358-1368): UTF-8 BOM so Excel reads the
 * Bengali headers, fully quoted cells, khoroch-expenses-style filename.
 */

const HEADERS: Record<Lang, string[]> = {
  bn: ["তারিখ", "বিবরণ", "খাত", "গ্রুপ", "পরিমাণ", "পেমেন্ট"],
  en: ["Date", "Note", "Category", "Group", "Amount", "Payment"],
};

/** Quote a cell per RFC 4180 (double the quotes, wrap everything). */
function cell(value: string | null): string {
  return `"${(value ?? "").replace(/"/g, '""')}"`;
}

/** Build the full CSV file content (BOM included) for the given rows. */
export function expensesToCsv(rows: Expense[], lang: Lang): string {
  const lines = [
    HEADERS[lang],
    ...rows.map((row) => [
      row.iso,
      row.desc ?? "",
      row.cat,
      groupName(row.grp, lang),
      row.amt,
      payName(row.pay, lang),
    ]),
  ];
  return "\uFEFF" + lines.map((line) => line.map(cell).join(",")).join("\n");
}

/** Trigger a browser download of `content` as a CSV file attachment. */
export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
