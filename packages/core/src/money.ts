/**
 * Daily Khoroch — money helpers.
 * Convention: amounts travel as numeric(12,2) *strings* at the API edge (ADR-0004),
 * rendered with ৳ prefix and Indian digit grouping (৳25,000 / ৳১২,৩৪৫).
 */

import type { Lang } from "./i18n";

/** Amount as it appears in API payloads, e.g. "890.00". */
export type Money = string;

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];

export function toBnDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
}

/** Indian grouping: 1234567 -> "12,34,567". */
export function indianGrouping(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

/** Format an amount with ৳ and Indian grouping. lang=bn renders Bengali digits. */
export function formatTaka(amount: Money | number, lang: Lang = "bn"): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return lang === "bn" ? "৳০" : "৳0";
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(2);
  const [int, frac] = fixed.split(".");
  const fracShort = frac === "00" ? "" : `.${frac}`;
  let out = `৳${indianGrouping(int)}${fracShort}`;
  if (lang === "bn") out = toBnDigits(out);
  return neg ? `-${out}` : out;
}

/** Parse a Money string to a number (paisa-less; numeric(12,2) domain). */
export function moneyToNumber(m: Money): number {
  return Number(m);
}

/** Build a Money string from a number, clamped to >= 0 and 2 decimals. */
export function moneyFromNumber(n: number): Money {
  return Math.max(0, n).toFixed(2);
}
