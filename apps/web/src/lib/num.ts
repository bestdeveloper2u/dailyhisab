/**
 * Bengali-digit normalization for the amount input (T15.1b).
 *
 * Users on bn keyboards type ০১২৩৪৫৬৭৮৯; the API only accepts ASCII digits.
 * One pass maps Bengali digits (U+09E6–U+09EF) to 0–9 and strips the ৳
 * symbol, commas and whitespace. A single decimal dot is kept — any extra
 * dots are dropped so '১.২.৩' becomes '1.23'. Anything unrecognised is
 * discarded; the result is a plain decimal string ('' when nothing remains).
 */
export function normalizeAmountInput(raw: string): string {
  let out = "";
  let sawDot = false;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code >= 0x09e6 && code <= 0x09ef) {
      out += String(code - 0x09e6);
    } else if (ch >= "0" && ch <= "9") {
      out += ch;
    } else if (ch === "." && !sawDot) {
      out += ch;
      sawDot = true;
    }
    // ৳, commas, whitespace and anything else: dropped.
  }
  return out;
}
