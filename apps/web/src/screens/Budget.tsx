import { t } from "@khoroch/core";
import { ComingSoon } from "../components/ComingSoon";
import { useLangStore } from "../store/lang";

export function Budget() {
  const lang = useLangStore((s) => s.lang);
  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{t(lang, "navBudget")}</h1>
      <ComingSoon />
    </section>
  );
}
