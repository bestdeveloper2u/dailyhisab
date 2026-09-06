import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { subscribeToasts } from "../lib/toast";
import { useLangStore } from "../store/lang";
import type { BackupEnvelope } from "../lib/backup";
import { DataSafety } from "./DataSafety";

/**
 * T16.4 — Settings ডেটা নিরাপত্তা: backup download streams the exact
 * /export/backup.json envelope; restore requires a shape-valid file AND an
 * explicit confirm before the destructive /import/restore POST.
 */

const ENVELOPE: BackupEnvelope = {
  schema_version: 1,
  exported_at: "2026-09-05T10:00:00Z",
  counts: { expenses: 3, debts: 1, budgets: 1 },
  expenses: [],
  debts: [],
  budgets: [],
};

/** jsdom's Blob lacks .text() — read it back through FileReader instead. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

interface Recorded {
  method: string;
  pathname: string;
  body?: unknown;
}

function stubApi(handler: (rec: Recorded) => Response | object) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const pathname = new URL(req.url).pathname;
    let body: unknown;
    try {
      body = await req.clone().json();
    } catch {
      body = undefined;
    }
    const rec: Recorded = { method: req.method, pathname, body };
    calls.push(rec);
    const out = handler(rec);
    if (out instanceof Response) return out;
    return Response.json(out);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

beforeEach(() => {
  useLangStore.setState({ lang: "en" });
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:mock"),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useLangStore.setState({ lang: "bn" });
});

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DataSafety />
    </QueryClientProvider>,
  );
}

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("DataSafety (Settings ডেটা নিরাপত্তা)", () => {
  it("downloads the backup envelope untouched", async () => {
    stubApi(({ method, pathname }) => {
      if (method === "GET" && pathname === "/api/v1/export/backup.json") return ENVELOPE;
      return new Response(null, { status: 404 });
    });
    const seen: string[] = [];
    const unsubscribe = subscribeToasts((s) => s && seen.push(s.text));

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Download backup" }));

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(JSON.parse(await blobText(blob))).toEqual(ENVELOPE);
    await waitFor(() => expect(seen).toContain("Backup downloaded ✓"));
    unsubscribe();
  });

  it("restore needs a valid file, an explicit confirm, then posts the envelope", async () => {
    const calls = stubApi(({ method, pathname }) => {
      if (method === "POST" && pathname === "/api/v1/import/restore") {
        return { restored: ENVELOPE.counts };
      }
      return new Response(null, { status: 404 });
    });
    const seen: string[] = [];
    const unsubscribe = subscribeToasts((s) => s && seen.push(s.text));

    renderCard();
    // merely picking the file must NOT touch the destructive endpoint
    pickFile(new File([JSON.stringify(ENVELOPE)], "backup.json", { type: "application/json" }));

    expect(await screen.findByText("backup.json")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Yes, restore" }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.pathname === "/api/v1/import/restore");
      expect(post?.body).toEqual(ENVELOPE);
    });
    expect(await screen.findByText(/Expenses 3 · Debts 1 · Budget 1/)).toBeInTheDocument();
    await waitFor(() => expect(seen).toContain("Restored ✓"));
    unsubscribe();
  });

  it("rejects a non-backup file before any request is made", async () => {
    const calls = stubApi(() => new Response(null, { status: 404 }));

    renderCard();
    pickFile(new File([JSON.stringify({ hello: "world" })], "other.json", {
      type: "application/json",
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file is not a Daily Hisab backup",
    );
    expect(calls).toHaveLength(0);
  });
});
