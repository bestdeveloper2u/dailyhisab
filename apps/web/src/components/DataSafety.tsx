import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { t, toBnDigits } from "@khoroch/core";
import type { BackupEnvelope } from "../lib/backup";
import { apiGetBackup, apiRestore, downloadBackup, parseBackupFile } from "../lib/backup";
import { w } from "../lib/web-i18n";
import { useLangStore } from "../store/lang";
import { toast } from "../lib/toast";
import { IconDownload, IconUpload } from "./icons";

/**
 * Settings ডেটা নিরাপত্তা card (T16.4 — ADR-0012 adoption): a real backup
 * download + restore-upload flow replacing the prototype's fake "auto
 * backup on ✓" row (see ADR-0015). Download streams the exact envelope the
 * server produced; restore requires picking a valid-looking file AND an
 * explicit confirmation, because restore replaces the whole ledger.
 */
export function DataSafety() {
  const lang = useLangStore((s) => s.lang);
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ envelope: BackupEnvelope; name: string } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const count = (n: number) => (lang === "bn" ? toBnDigits(String(n)) : String(n));

  async function download() {
    setBusy(true);
    setError(null);
    setSummary(null);
    toast(w(lang, "backupStarted"));
    const res = await apiGetBackup(lang);
    setBusy(false);
    if (!res.ok) {
      setError(res.detail || w(lang, "backupErr"));
      return;
    }
    downloadBackup(res.data);
    toast(w(lang, "backupDone"));
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file after a cancel
    if (!file) return;
    setError(null);
    setSummary(null);
    const parsed = await parseBackupFile(file);
    if (!parsed.ok) {
      setError(w(lang, "restoreBadFile"));
      return;
    }
    setPending({ envelope: parsed.envelope, name: file.name });
  }

  async function confirmRestore() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    const res = await apiRestore(pending.envelope, lang);
    setBusy(false);
    if (!res.ok) {
      setError(res.detail || w(lang, "restoreErr"));
      return;
    }
    setPending(null);
    const c = res.data.restored;
    setSummary(
      `${t(lang, "navExpenses")} ${count(c.expenses)} · ${t(lang, "navDebts")} ${count(
        c.debts,
      )} · ${t(lang, "navBudget")} ${count(c.budgets)}`,
    );
    toast(w(lang, "restoreDone"));
    // Every list/report cache is stale after a full ledger swap.
    await qc.invalidateQueries();
  }

  const btnBase =
    "flex shrink-0 items-center gap-1.5 rounded-control border border-line bg-surface px-3.5 py-2 text-sm font-semibold text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <p className="border-b border-line px-4 py-3 text-[13px] font-bold text-muted">
        {w(lang, "dataSafety")}
      </p>

      {/* ব্যাকআপ ডাউনলোড — GET /api/v1/export/backup.json */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{w(lang, "backupDl")}</span>
          <span className="mt-0.5 block text-xs font-normal text-muted">
            {w(lang, "backupSub")}
          </span>
        </span>
        <button type="button" onClick={() => void download()} disabled={busy} className={btnBase}>
          <IconDownload className="h-4 w-4" />
          {w(lang, "backupDl")}
        </button>
      </div>

      {/* রিস্টোর — POST /api/v1/import/restore (destructive: replaces all) */}
      <div className="px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{w(lang, "restoreTitle")}</span>
            <span className="mt-0.5 block text-xs font-normal text-muted">
              {w(lang, "restoreSub")}
            </span>
          </span>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className={btnBase}
          >
            <IconUpload className="h-4 w-4" />
            {w(lang, "restorePick")}
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label={w(lang, "restorePick")}
          onChange={(e) => void onPickFile(e)}
        />

        {pending && (
          <div className="mt-3 rounded-control border border-warning/40 bg-warning/5 p-3">
            <p className="truncate text-[13px] font-bold">{pending.name}</p>
            <p className="mt-1 text-xs text-muted">{w(lang, "restoreWarn")}</p>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirmRestore()}
                className="rounded-control bg-danger px-3 py-2 text-xs font-bold text-accent-ink hover:brightness-110 disabled:opacity-60"
              >
                {busy ? w(lang, "restoring") : w(lang, "restoreGo")}
              </button>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded-control px-2 py-2 text-xs font-semibold text-muted hover:bg-surface-2"
              >
                {w(lang, "cancel")}
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-2 text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        )}
        {summary && (
          <p className="mt-2 text-sm font-semibold text-emerald" role="status">
            {w(lang, "restoreDone")} {summary}
          </p>
        )}
      </div>
    </div>
  );
}
