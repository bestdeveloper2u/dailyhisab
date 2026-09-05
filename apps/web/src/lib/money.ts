/**
 * Web-side money display (prototype parity — www/index.html:1097):
 * `const fmt = n => n.toLocaleString("en-IN")` — every rendered ৳ amount is
 * Indian-grouped (৳49,778 / lakh-style 12,50,000).
 *
 * fmtMoney is the grouping engine every rendered amount flows through;
 * fmtTaka adds the currency symbol (placement unchanged: sign stays outside
 * the symbol, as before) and Bengali digits in the bn locale.
 */

import { toBnDigits, type Lang } from "@khoroch/core";

/**
 * Indian-grouped number without a symbol.
 * 49778 -> "49,778", 1250000 -> "12,50,000", "777.50" -> "777.5".
 * NaN/undefined/empty/non-numeric input safely renders "0".
 */
export function fmtMoney(v: number | string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/**
 * Full display amount: ৳ + fmtMoney grouping, Bengali digits in bn.
 * Negative sign stays outside the symbol (-৳500), matching the previous
 * rendering; non-finite input renders ৳0 / ৳০.
 */
export function fmtTaka(v: number | string, lang: Lang): string {
  const n = Number(v);
  const body = fmtMoney(Math.abs(n));
  const out = `৳${lang === "bn" ? toBnDigits(body) : body}`;
  return Number.isFinite(n) && n < 0 ? `-${out}` : out;
}
