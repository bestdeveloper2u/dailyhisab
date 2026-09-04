import { t } from "@khoroch/core";
import { ComingSoon } from "../components/ComingSoon";
import { useLangStore } from "../store/lang";

export function Expenses() {
  const lang = useLangStore((s) => s.lang);
  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{t(lang, "navExpenses")}</h1>
      <p className="mt-0.5 text-[13px] text-muted">{t(lang, "voiceHint")}</p>
      <ComingSoon />
    </section>
  );
}
