/**
 * Backup/restore adoption (T16.4 — ADR-0012): typed calls to the live
 * `GET /api/v1/export/backup.json` and `POST /api/v1/import/restore`
 * endpoints plus the browser side of the flow (JSON download, file
 * shape-checking before the destructive restore).
 *
 * The envelope IS the CRUD wire shape (money as exact decimal strings),
 * so the downloaded file feeds straight back into restore — no client-side
 * transformation anywhere.
 */
import {
  api,
  errorMessage,
  type ApiResult,
  type components,
  type Lang,
} from "@khoroch/api-client";
import { todayIso } from "./catalog";

export type BackupEnvelope = components["schemas"]["BackupEnvelope"];
export type RestoreResult = components["schemas"]["RestoreOut"];

/** Fetch the caller's full-fidelity backup document (auth required). */
export async function apiGetBackup(lang: Lang = "bn"): Promise<ApiResult<BackupEnvelope>> {
  const { data, error, response } = await api.GET("/api/v1/export/backup.json");
  if (data) return { ok: true, data };
  return { ok: false, status: response.status, detail: errorMessage(error, lang) };
}

/**
 * REPLACE the caller's ledger with the uploaded envelope (one server-side
 * transaction — a failed restore leaves the current data untouched).
 */
export async function apiRestore(
  envelope: BackupEnvelope,
  lang: Lang = "bn",
): Promise<ApiResult<RestoreResult>> {
  const { data, error, response } = await api.POST("/api/v1/import/restore", { body: envelope });
  if (data) return { ok: true, data };
  return { ok: false, status: response.status, detail: errorMessage(error, lang) };
}

/** khoroch-backup-YYYY-MM-DD.json — same-day downloads sort together. */
export function backupFilename(iso = todayIso()): string {
  return `khoroch-backup-${iso}.json`;
}

/** Trigger a browser download of the envelope as a .json attachment. */
export function downloadBackup(envelope: BackupEnvelope, filename = backupFilename()): void {
  const blob = new Blob([`${JSON.stringify(envelope, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type ParsedBackup = { ok: true; envelope: BackupEnvelope } | { ok: false };

/**
 * jsdom-safe file text read: `File.prototype.text()` exists in every real
 * browser but not in jsdom, so the shape-check rides FileReader (supported
 * everywhere, tests included).
 */
function fileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("backup file read failed"));
    reader.readAsText(file);
  });
}

/**
 * Parse + shape-check a picked file BEFORE the destructive restore call:
 * an object with schema_version 1 and the three row arrays. Anything else
 * (wrong app's JSON, truncated file, a list) is rejected client-side so we
 * never wipe a ledger on a malformed upload.
 */
export async function parseBackupFile(file: File): Promise<ParsedBackup> {
  try {
    const parsed: unknown = JSON.parse(await fileText(file));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false };
    }
    const env = parsed as Record<string, unknown>;
    if (env.schema_version !== 1) return { ok: false };
    if (
      !Array.isArray(env.expenses) ||
      !Array.isArray(env.debts) ||
      !Array.isArray(env.budgets)
    ) {
      return { ok: false };
    }
    if (typeof env.counts !== "object" || env.counts === null) return { ok: false };
    return { ok: true, envelope: parsed as BackupEnvelope };
  } catch {
    return { ok: false }; // not JSON at all
  }
}
