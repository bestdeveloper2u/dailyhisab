/*
 * Client-side CSV import — the inverse of lib/csv.ts expensesToCsv.
 * Accepts our own export (bn/en headers) AND headerless sheets in the same
 * column order, plus lenient dates (ISO / DD-MM-YYYY) and Bengali digits.
 * No AI, no backend change — parsed on-device, saved via /expenses/bulk.
 */
import { GROUP_LABELS, PAY_LABELS } from "./catalog";
import { bnToEnDigits } from "./parseDebt";
import type { ExpenseGroup, PayMethod } from "@khoroch/api-client";

/** One bulk-ready expense row (matches the /expenses/bulk item shape). */
export type ImportRow = {
  iso: string;
  desc?: string;
  cat: string;
  grp: ExpenseGroup;
  pay: PayMethod;
  amt: string;
};

export type ImportPreview = {
  items: ImportRow[];
  skipped: number;
};

/** RFC 4180 line: quoted cells, "" escapes, commas inside quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Strip BOM, currency marks, thousands separators → plain number string. */
function toAmount(raw: string): string | null {
  const clean = bnToEnDigits(raw).replace(/[৳\s,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const n = Number(clean);
  if (!Number.isFinite(n) || n <= 0 || n > 99_999_999) return null;
  return n.toFixed(2);
}

function buildIso(y: number, mo: number, d: number): string | null {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Real calendar validity (audit/t22x_audit.md P2-1): the API's pydantic
  // `iso: date` rejects e.g. 2026-02-31 with a 422 that fails the WHOLE
  // atomic bulk chunk — reject impossible dates on-device instead.
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) {
    return null;
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Accept ISO (YYYY-MM-DD) and DD-MM-YYYY / DD/MM/YYYY → ISO, else null. */
export function toIsoDate(raw: string): string | null {
  const s = bnToEnDigits(raw.trim());
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return buildIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) return buildIso(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  return null;
}

const GROUP_BY_LABEL = new Map<string, ExpenseGroup>(
  Object.entries(GROUP_LABELS).flatMap(([key, labels]) => [
    [key, key as ExpenseGroup],
    [labels.bn, key as ExpenseGroup],
    [labels.en.toLowerCase(), key as ExpenseGroup],
  ]),
);

const PAY_BY_LABEL = new Map<string, PayMethod>(
  Object.entries(PAY_LABELS).flatMap(([key, labels]) => [
    [key, key as PayMethod],
    [labels.bn, key as PayMethod],
    [labels.en.toLowerCase(), key as PayMethod],
  ]),
);

const KINDS = ["iso", "desc", "cat", "grp", "amt", "pay"] as const;
type Kind = (typeof KINDS)[number];

const HEADER_KEYS: Record<Kind, string[]> = {
  iso: ["তারিখ", "date"],
  desc: ["বিবরণ", "note", "description"],
  cat: ["খাত", "খাতা", "category"],
  grp: ["গ্রুপ", "group"],
  amt: ["পরিমাণ", "amount", "টাকা"],
  pay: ["পেমেন্ট", "payment"],
};

/** Map a header row to column kinds; null when it isn't a header at all. */
function detectHeader(cells: string[]): Kind[] | null {
  const kinds: Kind[] = [];
  let hits = 0;
  for (const cell of cells) {
    const norm = bnToEnDigits(cell).toLowerCase();
    const kind = KINDS.find((k) =>
      HEADER_KEYS[k].some((h) => norm === bnToEnDigits(h).toLowerCase()),
    );
    if (kind) hits += 1;
    kinds.push(kind ?? "desc");
  }
  return hits >= 3 ? kinds : null; // ≥3 recognized headers = real header row
}

/**
 * Parse a CSV string into bulk-ready rows. Headerless files must follow the
 * export column order (date, note, category, group, amount, payment).
 */
export function parseExpensesCsv(text: string): ImportPreview {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { items: [], skipped: 0 };

  let order: Kind[] = ["iso", "desc", "cat", "grp", "amt", "pay"];
  let start = 0;
  const maybeHeader = splitCsvLine(lines[0]);
  const detected = detectHeader(maybeHeader);
  if (detected) {
    order = detected;
    start = 1;
  }

  const items: ImportRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(start)) {
    const cells = splitCsvLine(line);
    const byKind: Partial<Record<Kind, string>> = {};
    order.forEach((kind, i) => {
      if (byKind[kind] === undefined) byKind[kind] = cells[i] ?? "";
    });
    const amt = toAmount(byKind.amt ?? "");
    const iso = toIsoDate(byKind.iso ?? "");
    const cat = (byKind.cat ?? "").trim();
    const desc = (byKind.desc ?? "").trim();
    // Length guards mirror ExpenseIn (apps/api schemas/expense.py: cat ≤80,
    // desc ≤200) — an over-long row would 422 the WHOLE atomic bulk chunk
    // (audit/t22x_audit.md P2-1), so skip it on-device like invalid amounts.
    if (!amt || !iso || !cat || cat.length > 80 || desc.length > 200) {
      skipped += 1;
      continue;
    }
    const grpRaw = (byKind.grp ?? "").trim().toLowerCase();
    const payRaw = (byKind.pay ?? "").trim().toLowerCase();
    items.push({
      iso,
      desc: desc || undefined,
      cat,
      grp: GROUP_BY_LABEL.get(grpRaw) ?? "other",
      pay: PAY_BY_LABEL.get(payRaw) ?? "cash",
      amt,
    });
  }
  return { items, skipped };
}
