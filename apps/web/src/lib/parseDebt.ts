/*
 * Client-side Bengali debt-sentence parser (prototype VOICE_CTX.debt parity):
 * "করিমকে ৫০০ টাকা ধার দিলাম, বাজারের বাকি" → party করিম, dir lend, amt 500,
 * note "বাজারের বাকি". Pure regex on-device — no AI call, zero token cost.
 */

export type ParsedDebt = {
  party: string;
  dir: "lend" | "borrow";
  amt: string;
  note: string;
};

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";

/** Convert Bengali digits (০-৯) to ASCII so amounts parse uniformly. */
export function bnToEnDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

/**
 * Shared pre-parse normalization: Bengali digits → ASCII, whitespace
 * collapse, and thousands-separator removal ("1,250" → "1250"). Doing the
 * comma strip ONCE here means every downstream step — party, amount AND the
 * note slice — sees the same clean string; otherwise the separator comma
 * leaks into the note (commaIdx landed after "1,250" → "250 টাকা ধার নিয়েছি").
 */
function normalizeTranscript(raw: string): string {
  return bnToEnDigits(raw.trim())
    .replace(/\s+/g, " ")
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
}

/**
 * Party words must not carry a leading money/loan keyword ("ধাররহিম",
 * "দেনাসেলিম") — the keyword belongs to the sentence, not the name.
 */
function stripPartyPrefix(word: string): string {
  return word.replace(/^(ধার|দেনা|টাকা|পয়সা)/, "");
}

/**
 * Parse one debt sentence. Returns null when no amount and no party can be
 * found — the overlay then keeps the transcript editable with a hint.
 */
export function parseDebtText(raw: string): ParsedDebt | null {
  const text = normalizeTranscript(raw);
  if (!text) return null;

  // Direction: "দিলাম/দিয়েছি" = lent out; "নিলাম/নিয়েছি" = borrowed.
  // Saying both defaults to lend (the sentence's subject is what I gave).
  const borrow = /(?:নিলাম|নিয়েছি|নিচ্ছি)/.test(text);
  const lend = /(?:দিলাম|দিয়েছি|দিচ্ছি)/.test(text);
  const dir: "lend" | "borrow" = borrow && !lend ? "borrow" : "lend";

  /*
   * Party: a name before থেকে / কাছে / কে. The SPACED form ("রহিম থেকে") must
   * be tried FIRST: the glued regex otherwise matches INSIDE the word "থেকে"
   * itself (prefix "থে" + suffix "কে") and steals the party from the real
   * name standing in front of it.
   */
  const STOP = new Set(["কারো", "কারও", "সবাই", "সবার"]);
  let party = "";
  const spaced = text.match(/([^\s,।]+)\s+(?:থেকে|কাছে)(?=[\s,।]|$)/u);
  if (spaced) {
    const word = stripPartyPrefix(spaced[1]);
    if (word && !STOP.has(word)) party = word;
  }
  if (!party) {
    const glued = text.match(/([^\s,।]+?)(?:কে|থেকে|কাছে)(?=[\s,।]|$)/u);
    if (glued) {
      const word = stripPartyPrefix(glued[1]);
      if (word && !STOP.has(word)) party = word;
    }
  }
  if (!party) {
    // Fallback: first non-keyword word of the sentence.
    const first = stripPartyPrefix(
      text.split(" ")[0]?.replace(/^(ধার|দেনা|আজ|কাল)[,]*/, "") ?? "",
    );
    if (first) party = first;
  }

  // Amount: first number in the sentence (500, 500.50) — thousands commas
  // are already gone (normalizeTranscript), so "1,250" → 1250.
  const amtMatch = text.match(/(\d+(?:\.\d{1,2})?)/);
  if (!party || !amtMatch) return null;
  const amt = Number(amtMatch[1]);
  if (!Number.isFinite(amt) || amt <= 0) return null;

  // Note: whatever follows the first comma (e.g. "বাজারের বাকি") of the SAME
  // normalized string — never the raw input's separator commas.
  const commaIdx = text.indexOf(",");
  const note = commaIdx >= 0 ? text.slice(commaIdx + 1).trim() : "";

  return { party, dir, amt: String(amt), note };
}

/**
 * Extract the monthly budget amount from a transcript (prototype
 * VOICE_CTX.budget): "এই মাসের বাজেট ২৫০০০ টাকা" → "25000". Returns null
 * when no positive number is present — the overlay then keeps the
 * transcript editable instead of saving nonsense.
 */
export function parseBudgetAmount(raw: string): string | null {
  const text = normalizeTranscript(raw);
  const m = text.match(/(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}
