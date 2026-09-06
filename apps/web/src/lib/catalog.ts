/**
 * Phase 2 label catalogs + date helpers for the expenses/voice/reports UI.
 * Label spellings mirror the frozen prototype (www/index.html GROUPS/PAY maps).
 */
import { toBnDigits, type Lang } from "@khoroch/core";
import type { ExpenseGroup, PayMethod } from "@khoroch/api-client";

export const GROUP_LABELS: Record<ExpenseGroup, { bn: string; en: string }> = {
  food: { bn: "খাদ্য ও মুদি", en: "Food & Groceries" },
  housing: { bn: "বাসস্থান", en: "Housing" },
  utility: { bn: "ইউটিলিটি বিল", en: "Utilities" },
  transport: { bn: "যাতায়াত", en: "Transport" },
  health: { bn: "স্বাস্থ্য", en: "Health" },
  education: { bn: "শিক্ষা", en: "Education" },
  personal: { bn: "ব্যক্তিগত ও গৃহস্থালি", en: "Personal & Household" },
  other: { bn: "অন্যান্য", en: "Other" },
};

export const GROUP_ORDER: ExpenseGroup[] = [
  "food",
  "housing",
  "utility",
  "transport",
  "health",
  "education",
  "personal",
  "other",
];

export const groupName = (g: string, lang: Lang): string =>
  GROUP_LABELS[g as ExpenseGroup]?.[lang] ?? g;

export const PAY_LABELS: Record<PayMethod, { bn: string; en: string }> = {
  cash: { bn: "নগদ টাকা", en: "Cash" },
  bkash: { bn: "বিকাশ", en: "bKash" },
  nagad: { bn: "নগদ (অ্যাপ)", en: "Nagad App" },
  rocket: { bn: "রকেট", en: "Rocket" },
  card: { bn: "কার্ড", en: "Card" },
  bank: { bn: "ব্যাংক ট্রান্সফার", en: "Bank transfer" },
};

export const payName = (p: string, lang: Lang): string =>
  PAY_LABELS[p as PayMethod]?.[lang] ?? p;

/** Display order for the settings payment-methods card (prototype @869-874). */
export const PAY_ORDER: PayMethod[] = [
  "cash",
  "bkash",
  "nagad",
  "rocket",
  "card",
  "bank",
];

/** Prototype group dot colors (www/index.html GROUPS map — frozen design). */
export const GROUP_DOTS: Record<string, string> = {
  food: "#D97706",
  housing: "#0F766E",
  utility: "#2563EB",
  transport: "#7C3AED",
  health: "#DC2626",
  education: "#DB2777",
  personal: "#65A30D",
  other: "#64748B",
};

export const groupDot = (g: string): string => GROUP_DOTS[g] ?? GROUP_DOTS.other;

const BN_WEEKDAYS = [
  "রবিবার",
  "সোমবার",
  "মঙ্গলবার",
  "বুধবার",
  "বৃহস্পতিবার",
  "শুক্রবার",
  "শনিবার",
];
const EN_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** bn → "বুধবার, ২ সেপ্টেম্বর ২০২৬" · en → "Wednesday, 2 September 2026". */
export function fullDateLabel(d: Date, lang: Lang): string {
  const wd = (lang === "bn" ? BN_WEEKDAYS : EN_WEEKDAYS)[d.getDay()] ?? "";
  const day = lang === "bn" ? toBnDigits(String(d.getDate())) : String(d.getDate());
  const mon = (lang === "bn" ? BN_MONTHS : EN_MONTHS)[d.getMonth()] ?? "";
  const y = lang === "bn" ? toBnDigits(String(d.getFullYear())) : String(d.getFullYear());
  return `${wd}, ${day} ${mon} ${y}`;
}

/** Short month label for the trend chart: bn "সেপ্টেম্ব" · en "Sep". */
export function shortMonthLabel(ym: string, lang: Lang): string {
  const m = Number(ym.slice(5, 7));
  if (lang === "bn") return (BN_MONTHS[(m || 1) - 1] ?? "").slice(0, 5);
  return (EN_MONTHS[(m || 1) - 1] ?? "").slice(0, 3);
}

const BN_MONTHS = [
  "জানুয়ারি",
  "ফেব্রুয়ারি",
  "মার্চ",
  "এপ্রিল",
  "মে",
  "জুন",
  "জুলাই",
  "আগস্ট",
  "সেপ্টেম্বর",
  "অক্টোবর",
  "নভেম্বর",
  "ডিসেম্বর",
];
const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Local-side YYYY-MM-DD for "today" (the API also accepts bare dates). */
export function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local-side YYYY-MM-DD for "yesterday" (আজ/গতকাল quick-date chips, T20.2). */
export function yesterdayIso(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "2026-09-04" → "2026-09" (month key). */
export const ymOfIso = (iso: string): string => iso.slice(0, 7);

/** Human month label: bn → "সেপ্টেম্বর ২০২৬", en → "September 2026". */
export function monthLabel(ym: string, lang: Lang): string {
  const [y, m] = ym.split("-").map(Number);
  const name = (lang === "bn" ? BN_MONTHS : EN_MONTHS)[(m ?? 1) - 1] ?? "";
  return lang === "bn"
    ? `${name} ${toBnDigits(String(y))}`
    : `${name} ${y}`;
}

/** Human date label: bn → "৪ সেপ্টেম্বর", en → "4 September". */
export function dayLabel(iso: string, lang: Lang): string {
  const [, m, d] = iso.split("-").map(Number);
  const name = (lang === "bn" ? BN_MONTHS : EN_MONTHS)[(m ?? 1) - 1] ?? "";
  return lang === "bn"
    ? `${toBnDigits(String(d ?? ""))} ${name}`
    : `${d} ${name}`;
}

/** Shift a YYYY-MM key by n months (clamps into the valid range). */
export function shiftYm(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** First/last day of a YYYY-MM month, as ISO dates for ?from=&to= filters. */
export function ymRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${ym}-01`,
    to: `${ym}-${String(last).padStart(2, "0")}`,
  };
}

/** Normalize user amount input to the API's `^\d{1,10}\.\d{2}$` Money string. */
export function normalizeAmount(raw: string): string | null {
  const cleaned = raw.trim().replace(/[,\s৳]/g, "");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [int, frac = ""] = cleaned.split(".");
  return `${int}.${(frac + "00").slice(0, 2)}`;
}

/**
 * Prototype bump() (www/index.html @1718): add `add` to the current amount
 * input value, tolerating empty/garbage input, rounded to 2dp as a string.
 */
export function bumpAmount(current: string, add: number): string {
  const parsed = Number.parseFloat(current);
  const base = Number.isFinite(parsed) ? parsed : 0;
  return (Math.round((base + add) * 100) / 100).toString();
}

/** Bump chips mirroring the prototype qchips (@783-784). */
export const BUMP_STEPS = [
  { key: "bump10", add: 10 },
  { key: "bump50", add: 50 },
  { key: "bump100", add: 100 },
  { key: "bump500", add: 500 },
] as const;

export type BumpKey = (typeof BUMP_STEPS)[number]["key"];
