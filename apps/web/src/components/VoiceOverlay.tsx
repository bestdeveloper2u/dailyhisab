import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { toBnDigits } from "@khoroch/core";
import type { ParsedExpense } from "@khoroch/api-client";
import { useExpenseMutations, useVoiceParse } from "../lib/queries";
import { groupName, payName, todayIso } from "../lib/catalog";
import { w } from "../lib/web-i18n";
import { fmtTaka } from "../lib/money";
import { useLangStore } from "../store/lang";
import { Modal } from "./Modal";
import { toast } from "../lib/toast";
import { IconMic } from "./icons";

/**
 * Minimal Web Speech API surface (not in the standard TS DOM lib).
 * Guarded at runtime — jsdom and unsupported browsers fall back to typing.
 */
interface SpeechResultAlt {
  transcript: string;
}
interface SpeechResult {
  0: SpeechResultAlt;
  isFinal: boolean;
  length: number;
}
interface SpeechEvent {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechResult };
}
interface SpeechErrorEvent {
  error: string;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
}
type RecognitionCtor = new () => RecognitionLike;

/**
 * Overall parse confidence at or above which entries are saved without a
 * confirm step (prototype behaviour: mic → save, no "খুঁজে বের করুন" tap).
 * Below this the review list appears so amounts can be fixed first.
 */
const AUTO_SAVE_CONFIDENCE = 0.7;

/**
 * Silence that ends a dictation: after this long with no new speech the mic
 * stops by itself and the transcript auto-adds (owner: "too many issues" —
 * users spoke, waited, nothing happened because nobody re-pressed the mic).
 */
export const SILENCE_AUTO_SUBMIT_MS = 2000;

/**
 * Google-Translate-style dictation: continuous + interim results, so words
 * appear live while the user speaks. bn-BD rides Chrome's server engine.
 */
function getRecognition(): RecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  try {
    const rec = new Ctor();
    rec.lang = "bn-BD";
    rec.continuous = true;
    rec.interimResults = true;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Voice-first add flow mirroring the frozen prototype's overlay: speak or
 * type a transcript → POST /voice/parse → review the parsed candidates →
 * POST /expenses/bulk saves them in one flush (ADR-0004 §8 money strings).
 */
export function VoiceOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lang = useLangStore((s) => s.lang);
  const parse = useVoiceParse();
  const { bulkCreate } = useExpenseMutations();

  const [text, setText] = useState("");
  const [items, setItems] = useState<ParsedExpense[] | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const recRef = useRef<RecognitionLike | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  // Submission guard — set synchronously so Enter key-repeat, double-taps,
  // or Enter+button races can never fire the parse→bulk pipeline twice
  // (owner report: typed expense got added two times).
  const busyRef = useRef(false);
  // Dictation session refs — survive recognition restarts (onend→start).
  const baseTextRef = useRef("");
  const finalRef = useRef("");
  const wantListenRef = useRef(false);
  const fatalRef = useRef(false);
  const restartsRef = useRef(0);
  // Live mirror of `text` so timer/async closures never read stale state.
  const textRef = useRef("");
  const silenceTimerRef = useRef<number | null>(null);

  const micSupported = useMemo(() => getRecognition() !== null, []);
  const pending = parse.isPending || bulkCreate.isPending;

  function setTextBoth(v: string) {
    textRef.current = v;
    setText(v);
  }

  function clearSilenceTimer() {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }

  /** 2s of silence ends the dictation: mic stops → auto-add fires. */
  function armSilenceSubmit() {
    clearSilenceTimer();
    silenceTimerRef.current = window.setTimeout(() => {
      silenceTimerRef.current = null;
      if (wantListenRef.current && textRef.current.trim()) {
        stopListening();
      }
    }, SILENCE_AUTO_SUBMIT_MS);
  }

  function reset() {
    setTextBoth("");
    setItems(null);
    setConfidence(null);
    setSavedCount(null);
    setError(null);
    setNote(null);
  }

  function handleClose() {
    if (listening) {
      // ✕ while dictating = stop + submit — the overlay exists to add, so
      // closing must never silently discard what was said.
      stopListening();
      return;
    }
    wantListenRef.current = false;
    clearSilenceTimer();
    recRef.current?.stop();
    reset();
    onClose();
  }

  /** Compose textarea = base text + committed finals + live interim. */
  function renderTranscript(interim: string) {
    const parts = [baseTextRef.current, finalRef.current.trim(), interim.trim()];
    setTextBoth(parts.filter(Boolean).join(" "));
  }

  function startListening() {
    const rec = getRecognition();
    if (!rec) return;
    recRef.current = rec;
    baseTextRef.current = text.trim();
    finalRef.current = "";
    wantListenRef.current = true;
    fatalRef.current = false;
    restartsRef.current = 0;
    setListening(true);
    setError(null);
    setNote(null);
    rec.onresult = (e: SpeechEvent) => {
      // Rebuild finals from the full results array every event — idempotent,
      // so engines that re-deliver a final can never duplicate the transcript
      // (owner report: words appearing twice).
      let interim = "";
      const finals: string[] = [];
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        const said = r?.[0]?.transcript ?? "";
        if (!said) continue;
        if (r.isFinal) finals.push(said);
        else interim += said;
      }
      finalRef.current = finals.join(" ");
      renderTranscript(interim);
      armSilenceSubmit();
    };
    rec.onerror = (e: SpeechErrorEvent) => {
      switch (e.error) {
        case "aborted":
          break; // stop() was pressed — silence is correct
        case "no-speech":
          setNote(w(lang, "voiceNoSpeech"));
          break; // not fatal — onend will restart the mic
        case "not-allowed":
        case "service-not-allowed":
          fatalRef.current = true;
          setError(w(lang, "voiceMicPerm"));
          break;
        case "audio-capture":
          fatalRef.current = true;
          setError(w(lang, "voiceMicMissing"));
          break;
        case "network":
          fatalRef.current = true;
          setError(w(lang, "voiceNetErr"));
          break;
        default:
          fatalRef.current = true;
          setError(w(lang, "errFallback"));
      }
    };
    rec.onend = () => {
      setListening(false);
      clearSilenceTimer();
      // Commit this session's finals into the base so the restart below can
      // neither lose them (new session = empty results) nor duplicate them.
      baseTextRef.current = [baseTextRef.current, finalRef.current.trim()]
        .filter(Boolean)
        .join(" ");
      finalRef.current = "";
      // Google-Translate feel: keep the mic alive across pauses until the
      // user presses stop or a fatal error occurred.
      if (wantListenRef.current && !fatalRef.current && restartsRef.current < 30) {
        restartsRef.current += 1;
        try {
          rec.start();
          setListening(true);
        } catch {
          // start() throws if the engine is still winding down — onend fires
          // again and we retry on the next tick.
        }
      }
    };
    try {
      rec.start();
      armSilenceSubmit();
    } catch {
      setListening(false);
      setError(w(lang, "errFallback"));
    }
  }

  function stopListening() {
    wantListenRef.current = false;
    clearSilenceTimer();
    recRef.current?.stop();
    setListening(false);
    // Auto-add: stopping the mic IS the submit — no separate "find" tap.
    void runFlow();
  }

  /**
   * Parse → auto-add pipeline (prototype parity: no extra search step).
   * High confidence → bulk-save immediately and close; low confidence →
   * review list first; nothing recognized → keep the transcript editable.
   */
  async function runFlow() {
    if (busyRef.current) return;
    setError(null);
    setSavedCount(null);
    // textRef (not the state closure) so the silence-timer path always sees
    // the latest transcript.
    const transcript = (textRef.current ?? text).trim();
    if (!transcript || pending) return;
    busyRef.current = true;
    try {
      let res;
      try {
        res = await parse.mutateAsync(transcript);
      } catch {
        // fetch-level failure (offline, DNS, timeout) — TanStack rethrows.
        setError(w(lang, "voiceNetErr"));
        return;
      }
      if (!res.ok) {
        setError(res.detail || w(lang, "errFallback"));
        return;
      }
      setConfidence(res.data.confidence);
      if (res.data.items.length === 0) {
        setItems([]); // "কিছু বোঝা যায়নি" — transcript stays for editing
        return;
      }
      if (res.data.confidence >= AUTO_SAVE_CONFIDENCE) {
        const saved = await saveItems(res.data.items);
        if (saved) {
          // Prototype vpDone: brief ✓ then the overlay closes itself.
          window.setTimeout(() => handleClose(), 1600);
        }
        return;
      }
      setItems(res.data.items); // low confidence → review before saving
    } finally {
      busyRef.current = false;
    }
  }

  function removeItem(index: number) {
    setItems((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
  }

  function editItemAmt(index: number, raw: string) {
    setItems((prev) =>
      prev
        ? prev.map((item, i) => (i === index ? { ...item, amt: raw } : item))
        : prev,
    );
  }

  /** Sanitize parsed candidates → bulk-create → toast + reset. */
  async function saveItems(list: ParsedExpense[]): Promise<boolean> {
    setError(null);
    // The parser returns decimal-string amounts (ADR-0004 §1); apply a light
    // numeric sanity pass, normalize to 2 places, default pay/iso.
    const clean = list
      .filter((it) => /^\d{1,10}(\.\d{1,2})?$/.test(it.amt.trim()))
      .map((it) => ({
        amt: Number(it.amt.trim()).toFixed(2),
        cat: it.cat,
        grp: it.grp,
        pay: it.pay ?? ("cash" as const),
        iso: it.iso ?? todayIso(),
        desc: it.desc,
      }));
    if (clean.length === 0) {
      setError(w(lang, "errAmt"));
      return false;
    }
    let res;
    try {
      res = await bulkCreate.mutateAsync(clean);
    } catch {
      setError(w(lang, "errFallback"));
      return false;
    }
    if (res.ok) {
      const count = res.data.length;
      setSavedCount(count);
      setItems(null);
      setTextBoth("");
      setConfidence(null);
      // Prototype parity: announce the batch save (e.g. "✓ ২টি সংরক্ষিত হয়েছে").
      toast(
        lang === "bn"
          ? `✓ ${toBnDigits(String(count))} ${w(lang, "savedCount")}`
          : `✓ ${count} ${w(lang, "savedCount")}`,
      );
      return true;
    }
    setError(res.detail || w(lang, "errFallback"));
    return false;
  }

  async function handleSaveAll() {
    if (busyRef.current || !items || items.length === 0) return;
    busyRef.current = true;
    try {
      await saveItems(items);
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <Modal open={open} onClose={handleClose} label={w(lang, "voiceTitle")}>
      <div className="flex flex-col gap-4 p-5" aria-busy={pending}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">{w(lang, "voiceTitle")}</h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label={w(lang, "cancel")}
            className="rounded-control px-2 py-1 text-sm font-semibold text-muted hover:bg-surface-2"
          >
            ✕
          </button>
        </div>
        <p className="text-[13px] text-muted">{w(lang, "voiceHint")}</p>

        {error && (
          <p
            role="alert"
            className="rounded-control border border-danger bg-danger/5 px-3.5 py-2.5 text-sm font-medium text-danger"
          >
            {error}
          </p>
        )}

        <div className="flex flex-col items-center gap-3 py-1">
          {micSupported ? (
            <button
              type="button"
              onClick={listening ? stopListening : startListening}
              aria-pressed={listening}
              aria-label={listening ? w(lang, "listening") : w(lang, "mic")}
              className={`flex h-16 w-16 items-center justify-center rounded-full text-accent-ink shadow-card transition-transform ${
                listening ? "animate-pulse bg-danger" : "bg-emerald hover:scale-105"
              }`}
            >
              <IconMic className="h-7 w-7" />
            </button>
          ) : null}
          {listening && (
            <p className="text-sm font-semibold text-emerald" role="status">
              {w(lang, "listening")}…
            </p>
          )}
          {note && !listening && !error && (
            <p className="text-xs text-muted" role="status">
              {note}
            </p>
          )}
          {!micSupported && (
            <p className="text-xs text-muted">{w(lang, "voiceUnsupported")}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="sr-only" htmlFor="voice-text">
            {w(lang, "voiceHint")}
          </label>
          <textarea
            id="voice-text"
            ref={textAreaRef}
            rows={3}
            value={text}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTextBoth(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits (auto-add); Shift+Enter makes a new line.
              // Held-down Enter auto-repeats — e.repeat must not resubmit.
              if (e.repeat) return;
              if (e.key === "Enter" && !e.shiftKey && !listening) {
                e.preventDefault();
                void runFlow();
              }
            }}
            placeholder={w(lang, "voicePh")}
            className="w-full resize-none rounded-control border border-line bg-ivory px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
          />
          {listening && (
            <p className="text-[11px] text-muted">
              {lang === "bn"
                ? "বলতে থাকুন — ২ সেকেন্ড থামলেই অটো-যোগ হবে। চাইলে মাইক বন্ধ করেও যোগ করা যায়।"
                : "Keep speaking — pause 2s to auto-add, or press the mic to finish."}
            </p>
          )}
        </div>

        {items === null || items.length === 0 ? (!listening && text.trim() !== "" && (
          <button
            type="button"
            onClick={() => void runFlow()}
            disabled={pending}
            className="h-11 rounded-control bg-emerald font-bold text-accent-ink transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {parse.isPending ? w(lang, "voiceParsing") : w(lang, "voiceAddBtn")}
          </button>
        )) : null}

        {items !== null && items.length === 0 && (
          <p className="text-sm text-muted" role="status">
            {w(lang, "nothingFound")}
          </p>
        )}

        {items !== null && items.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-bold">{w(lang, "parsedItems")}</span>
              {confidence !== null && (
                <span className="text-muted">
                  {w(lang, "confidence")}:{" "}
                  {lang === "bn"
                    ? `${toBnDigits(String(Math.round(confidence * 100)))}%`
                    : `${Math.round(confidence * 100)}%`}
                </span>
              )}
            </div>
            {(confidence ?? 1) < AUTO_SAVE_CONFIDENCE && (
              <p className="text-xs font-semibold text-warning">{w(lang, "voiceReviewHint")}</p>
            )}
            <ul className="flex flex-col divide-y divide-line rounded-card border border-line">
              {items.map((item, i) => (
                <li key={`${item.cat}-${i}`} className="flex items-center gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{item.cat}</p>
                    <p className="text-xs text-muted">
                      {groupName(item.grp, lang)} · {payName(item.pay ?? "cash", lang)} ·{" "}
                      {item.iso ?? w(lang, "today")}
                    </p>
                  </div>
                  <input
                    aria-label={`${item.cat} — ${w(lang, "amtLabel")}`}
                    type="text"
                    inputMode="decimal"
                    value={item.amt}
                    onChange={(e) => editItemAmt(i, e.target.value)}
                    className="w-20 rounded-control border border-line bg-ivory px-2 py-1.5 text-right text-sm font-bold tabular-nums text-ink focus:border-emerald focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    aria-label={`${item.cat} — ${w(lang, "remove")}`}
                    className="rounded-control px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-danger"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">
              {w(lang, "totalSpend")}:{" "}
              {fmtTaka(
                items.reduce((sum, it) => sum + (Number(it.amt) || 0), 0),
                lang,
              )}
            </p>
            <button
              type="button"
              onClick={handleSaveAll}
              disabled={pending}
              className="h-11 rounded-control bg-emerald font-bold text-accent-ink transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {bulkCreate.isPending
                ? w(lang, "saving")
                : `${w(lang, "saveAll")} (${lang === "bn" ? toBnDigits(String(items.length)) : items.length})`}
            </button>
          </div>
        )}

        {savedCount !== null && items === null && (
          <p className="text-center text-sm font-bold text-emerald" role="status">
            {lang === "bn"
              ? `✓ ${toBnDigits(String(savedCount))} ${w(lang, "savedCount")}`
              : `✓ ${savedCount} ${w(lang, "savedCount")}`}
          </p>
        )}
      </div>
    </Modal>
  );
}
