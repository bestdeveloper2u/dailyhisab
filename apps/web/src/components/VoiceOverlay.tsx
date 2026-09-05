import { useRef, useState, type ChangeEvent } from "react";
import { formatTaka, toBnDigits } from "@khoroch/core";
import type { ParsedExpense } from "@khoroch/api-client";
import { useExpenseMutations, useVoiceParse } from "../lib/queries";
import { groupName, payName, todayIso } from "../lib/catalog";
import { w } from "../lib/web-i18n";
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
  results: { length: number; [i: number]: SpeechResult };
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type RecognitionCtor = new () => RecognitionLike;

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
    rec.continuous = false;
    rec.interimResults = false;
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
  const recRef = useRef<RecognitionLike | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const micSupported = getRecognition() !== null;
  const pending = parse.isPending || bulkCreate.isPending;

  function reset() {
    setText("");
    setItems(null);
    setConfidence(null);
    setSavedCount(null);
    setError(null);
  }

  function handleClose() {
    recRef.current?.stop();
    reset();
    onClose();
  }

  function startListening() {
    const rec = getRecognition();
    if (!rec) return;
    recRef.current = rec;
    setListening(true);
    setError(null);
    rec.onresult = (e: SpeechEvent) => {
      const said = e.results?.[0]?.[0]?.transcript ?? "";
      if (said) setText((prev) => (prev ? `${prev} ${said}` : said));
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  }

  function stopListening() {
    recRef.current?.stop();
    setListening(false);
  }

  async function handleParse() {
    setError(null);
    setSavedCount(null);
    const transcript = text.trim();
    if (!transcript) return;
    const res = await parse.mutateAsync(transcript);
    if (res.ok) {
      setItems(res.data.items);
      setConfidence(res.data.confidence);
    } else {
      setError(res.detail || w(lang, "errFallback"));
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

  async function handleSaveAll() {
    if (!items || items.length === 0) return;
    setError(null);
    // The parser returns decimal-string amounts (ADR-0004 §1); apply a light
    // numeric sanity pass, normalize to 2 places, default pay/iso.
    const clean = items
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
      return;
    }
    const res = await bulkCreate.mutateAsync(clean);
    if (res.ok) {
      const count = res.data.length;
      setSavedCount(count);
      setItems(null);
      setText("");
      setConfidence(null);
      // Prototype parity: announce the batch save (e.g. "✓ ২টি সংরক্ষিত হয়েছে").
      toast(
        lang === "bn"
          ? `✓ ${toBnDigits(String(count))} ${w(lang, "savedCount")}`
          : `✓ ${count} ${w(lang, "savedCount")}`,
      );
    } else {
      setError(res.detail || w(lang, "errFallback"));
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
            rows={2}
            value={text}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
            placeholder={w(lang, "voicePh")}
            className="w-full resize-none rounded-control border border-line bg-ivory px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
          />
        </div>

        {items === null && (
          <button
            type="button"
            onClick={handleParse}
            disabled={pending || !text.trim()}
            className="h-11 rounded-control bg-emerald font-bold text-accent-ink transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {parse.isPending ? w(lang, "finding") : w(lang, "findBtn")}
          </button>
        )}

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
              {formatTaka(
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
