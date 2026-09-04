import { t } from "@khoroch/core";
import { useLangStore } from "../store/lang";

/** Shared "screen under reconstruction" note for placeholder screens. */
export function ComingSoon() {
  const lang = useLangStore((s) => s.lang);
  return (
    <div className="mt-5 rounded-card border border-line bg-surface p-5 shadow-card">
      <p className="text-sm text-muted">{t(lang, "comingSoon")}</p>
    </div>
  );
}
