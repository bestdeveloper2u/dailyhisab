import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { backupFilename, downloadBackup, parseBackupFile } from "./backup";
import { todayIso } from "./catalog";
import type { BackupEnvelope } from "./backup";

/**
 * T16.4 — browser half of the ADR-0012 flow: deterministic filenames, a
 * download that carries the envelope through untouched, and strict client
 * side shape-checking so a malformed file can never reach (and wipe via)
 * /import/restore.
 */

const ENVELOPE: BackupEnvelope = {
  schema_version: 1,
  exported_at: "2026-09-05T10:00:00Z",
  counts: { expenses: 1, debts: 1, budgets: 1 },
  expenses: [],
  debts: [],
  budgets: [],
};

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

/** jsdom's Blob lacks .text() — read it back through FileReader instead. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

let createObjectUrlMock: Mock;
let anchorClickSpy: MockInstance;

beforeEach(() => {
  createObjectUrlMock = vi.fn(() => "blob:mock");
  Object.defineProperty(URL, "createObjectURL", {
    value: createObjectUrlMock,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
  anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    value: realCreate,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: realRevoke,
    writable: true,
    configurable: true,
  });
  vi.restoreAllMocks();
});

function jsonFile(content: string): File {
  return new File([content], "backup.json", { type: "application/json" });
}

describe("backupFilename", () => {
  it("embeds the given ISO date", () => {
    expect(backupFilename("2026-09-05")).toBe("khoroch-backup-2026-09-05.json");
  });

  it("defaults to today", () => {
    expect(backupFilename()).toBe(`khoroch-backup-${todayIso()}.json`);
  });
});

describe("downloadBackup", () => {
  it("downloads the envelope verbatim as a .json attachment", async () => {
    downloadBackup(ENVELOPE);

    const anchor = anchorClickSpy.mock.calls.length;
    expect(anchor).toBe(1);
    const blob = createObjectUrlMock.mock.calls[0][0] as Blob;
    expect(JSON.parse(await blobText(blob))).toEqual(ENVELOPE);
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith("blob:mock");
  });
});

describe("parseBackupFile", () => {
  it("accepts a schema_version-1 envelope", async () => {
    const parsed = await parseBackupFile(jsonFile(JSON.stringify(ENVELOPE)));
    expect(parsed).toEqual({ ok: true, envelope: ENVELOPE });
  });

  it("rejects a foreign version", async () => {
    const parsed = await parseBackupFile(
      jsonFile(JSON.stringify({ ...ENVELOPE, schema_version: 2 })),
    );
    expect(parsed).toEqual({ ok: false });
  });

  it("rejects a JSON array / non-object document", async () => {
    expect(await parseBackupFile(jsonFile("[]"))).toEqual({ ok: false });
  });

  it("rejects a missing row array", async () => {
    const partial = { schema_version: 1, counts: {}, expenses: [], debts: [] };
    expect(await parseBackupFile(jsonFile(JSON.stringify(partial)))).toEqual({ ok: false });
  });

  it("rejects non-JSON content", async () => {
    expect(await parseBackupFile(jsonFile("this is not json"))).toEqual({ ok: false });
  });
});
