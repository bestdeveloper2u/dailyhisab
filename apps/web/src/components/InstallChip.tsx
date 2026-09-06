import { useLangStore } from "../store/lang";
import { toast } from "../lib/toast";
import { w } from "../lib/web-i18n";
import { dismissInstallChip, promptInstall, useInstallPrompt } from "../lib/installPrompt";

/**
 * PWA install chip (T26.1 — MDN BeforeInstallPromptEvent). A quiet row in the
 * Settings "অ্যাপ" card: install + "পরে". Renders NOTHING unless the browser
 * actually offered the install prompt AND the user has neither installed nor
 * dismissed — so the card looks unchanged in standalone/unsupported contexts.
 * Accepted installs toast; a dismissed browser outcome keeps the chip (the
 * user may reconsider), while "পরে" hides it for good (localStorage).
 */
export function InstallChip() {
  const lang = useLangStore((s) => s.lang);
  const { canInstall, installed, dismissed } = useInstallPrompt();

  if (installed || dismissed || !canInstall) return null;

  async function install() {
    const res = await promptInstall();
    // A dismissed browser outcome keeps the chip; acceptance is irreversible.
    if (res?.outcome === "accepted") toast(w(lang, "installDone"));
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-b border-line px-4 py-3.5 last:border-b-0">
      <button
        type="button"
        onClick={() => void install()}
        className="shrink-0 rounded-control bg-emerald px-3.5 py-2 text-sm font-bold text-accent-ink transition-[filter] hover:brightness-110"
      >
        {w(lang, "installApp")}
      </button>
      <button
        type="button"
        onClick={dismissInstallChip}
        className="shrink-0 rounded-control px-3 py-2 text-sm font-semibold text-muted transition-colors hover:bg-surface-2"
      >
        {w(lang, "installLater")}
      </button>
    </div>
  );
}
