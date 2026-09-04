import { t, type Lang } from "@khoroch/core";
import { useLangStore } from "../store/lang";

const OPTIONS: ReadonlyArray<{ value: Lang; label: string }> = [
  { value: "bn", label: "বাং" },
  { value: "en", label: "EN" },
];

interface LangToggleProps {
  /** compact = app bar; regular = settings row */
  size?: "compact" | "regular";
}

/** Segmented bn/en switch wired to the persisted language store. */
export function LangToggle({ size = "regular" }: LangToggleProps) {
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);
  const sizing = size === "compact" ? "px-2.5 py-1 text-[12px]" : "px-3.5 py-1.5 text-[13px]";

  return (
    <div
      role="group"
      aria-label={t(lang, "language")}
      className="flex items-center gap-0.5 rounded-control bg-surface-2 p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = lang === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => setLang(opt.value)}
            className={`rounded-[8px] font-semibold transition-colors ${sizing} ${
              active ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
