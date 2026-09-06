/*
 * Client-side Bengali debt-sentence parser (prototype VOICE_CTX.debt parity):
 * "করিমকে ৫০০ টাকা ধার দিলাম, বাজারের বাকি" → party করিম, dir lend, amt 500,
 * note "বাজারের বাকি". Pure regex on-device — no AI call, zero token cost.
 * Amounts accept digits (৫০০/500) AND Bengali number-words ("পাঁচশো টাকা" →
 * 500, "আট হাজার টাকা" → 8000), mirroring the server voice parser
 * (apps/api/app/routers/voice.py _NUMBER_WORDS).
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

/*
 * Bengali number-words — vocabulary copied EXACTLY from the server expense
 * voice parser (apps/api/app/routers/voice.py _NUMBER_WORDS, same insertion
 * order). Longest-first matching keeps একশ over এক, পাঁচশ over পাঁচ; the
 * sort below is stable, so equal-length ties keep the server's order too.
 */
const NUMBER_WORDS: Record<string, number> = {
  "একশ": 100,
  "পাঁচশ": 500,
  "দুইশ": 200,
  "নব্বই": 90,
  "চল্লিশ": 40,
  "পঞ্চাশ": 50,
  "সত্তর": 70,
  "ত্রিশ": 30,
  "বিশ": 20,
  "ষাট": 60,
  "হাজার": 1000,
  "দশ": 10,
  "পাঁচ": 5,
  "panch": 5,
  "চার": 4,
  "ছয়": 6,
  "সাত": 7,
  "আট": 8,
  "নয়": 9,
  "শত": 100,
  "dui": 2,
  "দুই": 2,
  "তিন": 3,
  "এক": 1,
  "আশি": 80,
};
const NUMBER_WORDS_ORDERED = Object.keys(NUMBER_WORDS).sort(
  (a, b) => b.length - a.length,
);

const THOUSAND_WORD = "হাজার";
const THOUSAND_MULT = 1000;

/**
 * Amount from a normalized transcript: explicit digits win ("৫০০"→500,
 * "120.50"), otherwise the first Bengali number-word in longest-first order
 * is the base (server parity) — and "হাজার" multiplies it by 1000 ("আট
 * হাজার" → 8000, "১ হাজার" → 1000). হাজার itself never acts as the base
 * when another number-word is present, so the multiplier can't square
 * itself; a bare "হাজার" (no other word) still means 1000. Returns null
 * when nothing usable is found.
 */
function extractAmount(text: string): number | null {
  const digitMatch = text.match(/(\d+(?:\.\d{1,2})?)/);
  if (digitMatch) {
    const n = Number(digitMatch[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return text.includes(THOUSAND_WORD) ? n * THOUSAND_MULT : n;
  }
  let base: number | null = null;
  for (const word of NUMBER_WORDS_ORDERED) {
    if (word === THOUSAND_WORD) continue;
    if (text.includes(word)) {
      base = NUMBER_WORDS[word];
      break;
    }
  }
  if (base !== null) {
    return text.includes(THOUSAND_WORD) ? base * THOUSAND_MULT : base;
  }
  return text.includes(THOUSAND_WORD) ? NUMBER_WORDS[THOUSAND_WORD] : null;
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

  // Amount: explicit digits first (500, 500.50) — thousands commas are
  // already gone (normalizeTranscript), so "1,250" → 1250 — otherwise
  // Bengali number-words ("পাঁচশো টাকা" → 500, "আট হাজার টাকা" → 8000),
  // same vocabulary as the server voice parser.
  const amt = extractAmount(text);
  if (!party || amt === null) return null;

  // Note: whatever follows the first comma (e.g. "বাজারের বাকি") of the SAME
  // normalized string — never the raw input's separator commas.
  const commaIdx = text.indexOf(",");
  const note = commaIdx >= 0 ? text.slice(commaIdx + 1).trim() : "";

  return { party, dir, amt: String(amt), note };
}

/**
 * Extract the monthly budget amount from a transcript (prototype
 * VOICE_CTX.budget): "এই মাসের বাজেট ২৫০০০ টাকা" → "25000", words included:
 * "এই মাসের বাজেট আট হাজার টাকা" → "8000". Returns null when no positive
 * number (digits or number-words) is present — the overlay then keeps the
 * transcript editable instead of saving nonsense.
 */
export function parseBudgetAmount(raw: string): string | null {
  const text = normalizeTranscript(raw);
  const n = extractAmount(text);
  return n === null ? null : String(n);
}
