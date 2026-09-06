import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Expense } from "@khoroch/api-client";
import { ExpenseForm } from "../src/components/ExpenseForm";
import { VoiceOverlay } from "../src/components/VoiceOverlay";
import { todayIso } from "../src/lib/catalog";
import { W } from "../src/lib/web-i18n";
import { useLangStore } from "../src/store/lang";
import { makeResponse, renderWithProviders, stubFetch, type RouteHandler } from "./helpers";

/**
 * T24.1 — duplicate-add guard (WCAG 2.2 SC 3.3.4 "checked" submissions,
 * https://www.w3.org/TR/WCAG22/#error-prevention-legal-financial-data):
 * re-adding an expense saved moments ago ("চায়ে ৪০ টাকা" said twice) must
 * never save silently — both add surfaces demand one explicit confirmation.
 */

/* ------------------------------------------------------------------ */
/* shared fixtures                                                     */
/* ------------------------------------------------------------------ */

/** "চায়ে ৪০ টাকা" saved three minutes ago — squarely inside the window. */
const RECENT_TEA: Expense = {
  id: "tea-1",
  user_id: "u1",
  amt: "40.00",
  cat: "চা",
  grp: "food",
  pay: "cash",
  desc: null,
  iso: todayIso(),
  created_at: new Date(Date.now() - 3 * 60_000).toISOString(),
};

const PARSED_TEA = { amt: "40", cat: "চা", grp: "food", pay: null, iso: null, desc: null };

const NOT_FOUND = { detail: { code: "not_found", message_bn: "নেই", message_en: "missing" } };

beforeEach(() => {
  window.localStorage.clear();
  useLangStore.setState({ lang: "bn" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useLangStore.setState({ lang: "bn" });
});

/* ------------------------------------------------------------------ */
/* ExpenseForm (manual add)                                            */
/* ------------------------------------------------------------------ */

interface FormRoutesOpts {
  dayRows?: Expense[];
  onDayQuery?: (url: URL) => void;
  onCreate?: (body: unknown) => void;
  onPatch?: (body: unknown) => void;
}

function formRoutes(opts: FormRoutesOpts = {}): RouteHandler {
  return (req, url) => {
    if (req.method === "GET" && url.pathname === "/api/v1/expenses") {
      opts.onDayQuery?.(url);
      return makeResponse(200, { items: opts.dayRows ?? [], next_cursor: null });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/expenses") {
      return req.json().then((body) => {
        opts.onCreate?.(body);
        return makeResponse(201, { ...RECENT_TEA, id: "srv-new", amt: "40.00" });
      });
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/api/v1/expenses/")) {
      return req.json().then((body) => {
        opts.onPatch?.(body);
        return makeResponse(200, { ...RECENT_TEA, ...body });
      });
    }
    // khata categories and anything else: not needed by these tests
    return makeResponse(404, NOT_FOUND);
  };
}

function renderForm(props: Partial<Parameters<typeof ExpenseForm>[0]> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const view = render(
    <QueryClientProvider client={qc}>
      <ExpenseForm open onClose={onClose} {...props} />
    </QueryClientProvider>,
  );
  return { onClose, container: view.container };
}

function fillAmountCat(amt: string, cat: string) {
  fireEvent.change(screen.getByLabelText("পরিমাণ (৳)"), { target: { value: amt } });
  fireEvent.change(screen.getByLabelText("খাত"), { target: { value: cat } });
}

function submitForm(container: HTMLElement) {
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);
}

describe("ExpenseForm duplicate guard (T24.1)", () => {
  it("an identical expense saved minutes ago waits for an explicit তবুও যোগ করুন", async () => {
    const dayUrls: URL[] = [];
    const created: unknown[] = [];
    stubFetch(
      formRoutes({
        dayRows: [RECENT_TEA],
        onDayQuery: (url) => dayUrls.push(url),
        onCreate: (body) => created.push(body),
      }),
    );
    const { container, onClose } = renderForm();

    fillAmountCat("৪০", "চা");
    submitForm(container);

    // First submit = the check: warning shown, day queried, nothing created.
    expect(await screen.findByRole("alert")).toHaveTextContent(W.bn.dupTitle);
    expect(screen.getByRole("alert")).toHaveTextContent("চা · ৳৪০");
    await waitFor(() => expect(dayUrls).toHaveLength(1));
    expect(dayUrls[0].searchParams.get("from")).toBe(todayIso());
    expect(created).toEqual([]);

    // The submit button itself becomes the confirmation.
    const button = screen.getByRole("button", { name: W.bn.dupAddAnyway });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ amt: "40.00", cat: "চা" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // Confirm consumed itself — no lingering warning after the save.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a different amount saves straight away — no warning, one create", async () => {
    const dayUrls: URL[] = [];
    const created: unknown[] = [];
    stubFetch(
      formRoutes({
        dayRows: [RECENT_TEA],
        onDayQuery: (url) => dayUrls.push(url),
        onCreate: (body) => created.push(body),
      }),
    );
    const { container } = renderForm();

    fillAmountCat("৫০", "চা");
    submitForm(container);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ amt: "50.00", cat: "চা" });
    expect(dayUrls).toHaveLength(1); // the check ran…
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // …and passed
  });

  it("the same khata+amount from hours ago is a real second expense, not a repeat", async () => {
    const created: unknown[] = [];
    stubFetch(
      formRoutes({
        dayRows: [
          { ...RECENT_TEA, created_at: new Date(Date.now() - 8 * 60 * 60_000).toISOString() },
        ],
        onCreate: (body) => created.push(body),
      }),
    );
    const { container } = renderForm();

    fillAmountCat("৪০", "চা");
    submitForm(container);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("editing the amount after a warning re-arms the guard (fresh check, fresh confirm)", async () => {
    const dayUrls: URL[] = [];
    const created: unknown[] = [];
    stubFetch(
      formRoutes({
        dayRows: [RECENT_TEA],
        onDayQuery: (url) => dayUrls.push(url),
        onCreate: (body) => created.push(body),
      }),
    );
    const { container } = renderForm();

    fillAmountCat("৪০", "চা");
    submitForm(container);
    expect(await screen.findByRole("alert")).toHaveTextContent(W.bn.dupTitle);

    // Change the amount: the warning must clear and the next submit re-check.
    fireEvent.change(screen.getByLabelText("পরিমাণ (৳)"), { target: { value: "৬০" } });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: W.bn.save })).toBeEnabled();

    submitForm(container);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ amt: "60.00" });
    expect(dayUrls).toHaveLength(2); // re-checked, not trusted from before
  });

  it("edit mode is never guarded — the PATCH goes through with no day query", async () => {
    const dayUrls: URL[] = [];
    const patched: unknown[] = [];
    stubFetch(
      formRoutes({
        dayRows: [RECENT_TEA],
        onDayQuery: (url) => dayUrls.push(url),
        onPatch: (body) => patched.push(body),
      }),
    );
    const { container } = renderForm({
      expense: { ...RECENT_TEA, id: "tea-1", amt: "45.00" },
    });

    submitForm(container);

    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toMatchObject({ amt: "45.00" });
    expect(dayUrls).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* VoiceOverlay (voice add)                                            */
/* ------------------------------------------------------------------ */

interface VoiceRoutesOpts {
  parse: { items: unknown[]; confidence: number };
  dayRows?: Expense[];
  onBulk?: (body: unknown) => void;
}

function voiceRoutes(opts: VoiceRoutesOpts): RouteHandler {
  return (req, url) => {
    if (req.method === "POST" && url.pathname === "/api/v1/voice/parse") {
      return makeResponse(200, opts.parse);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/expenses") {
      return makeResponse(200, { items: opts.dayRows ?? [], next_cursor: null });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/expenses/bulk") {
      return req.json().then((body) => {
        opts.onBulk?.(body);
        const items = (body as { items: unknown[] }).items;
        return makeResponse(201, { items: items.map((_, i) => ({ id: `bulk-${i}` })) });
      });
    }
    return makeResponse(404, NOT_FOUND);
  };
}

async function typeAndAdd(transcript: string) {
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), transcript);
  await user.click(screen.getByRole("button", { name: W.bn.voiceAddBtn }));
}

describe("VoiceOverlay duplicate guard (T24.1)", () => {
  it("a confident repeat of a just-saved expense parks at review instead of auto-saving", async () => {
    const bulk: unknown[] = [];
    stubFetch(
      voiceRoutes({
        parse: { items: [PARSED_TEA], confidence: 0.95 },
        dayRows: [RECENT_TEA],
        onBulk: (body) => bulk.push(body),
      }),
    );
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    await typeAndAdd("চায়ে ৪০ টাকা");

    // High confidence — but the guard found today's চা ৳40: checked, not saved.
    expect(await screen.findByRole("alert")).toHaveTextContent(W.bn.dupTitle);
    expect(await screen.findByText(W.bn.dupTag)).toBeInTheDocument();
    expect(bulk).toEqual([]);

    // The save button spells out the confirmation; saving is deliberate.
    const confirm = await screen.findByRole("button", { name: "তবুও সংরক্ষণ করুন (১)" });
    fireEvent.click(confirm);

    expect(await screen.findByText("✓ ১ সংরক্ষিত হয়েছে")).toBeInTheDocument();
    expect(bulk).toHaveLength(1);
    expect((bulk[0] as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ amt: "40.00", cat: "চা" }),
    ]);
  });

  it("the same phrase twice inside one transcript is flagged even with empty history", async () => {
    const bulk: unknown[] = [];
    stubFetch(
      voiceRoutes({
        parse: { items: [PARSED_TEA, { ...PARSED_TEA, amt: "40.0" }], confidence: 0.9 },
        dayRows: [],
        onBulk: (body) => bulk.push(body),
      }),
    );
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    await typeAndAdd("চায়ে ৪০ টাকা চায়ে ৪০ টাকা");

    expect(await screen.findByRole("alert")).toHaveTextContent(W.bn.dupTitle);
    expect(bulk).toEqual([]);
    const confirm = await screen.findByRole("button", { name: "তবুও সংরক্ষণ করুন (২)" });
    fireEvent.click(confirm);

    expect(await screen.findByText("✓ ২ সংরক্ষিত হয়েছে")).toBeInTheDocument();
    expect(bulk).toHaveLength(1);
    expect((bulk[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("a confident phrase with no duplicate still auto-saves in one tap", async () => {
    const bulk: unknown[] = [];
    const dayUrls: URL[] = [];
    stubFetch((req, url) => {
      if (req.method === "GET" && url.pathname === "/api/v1/expenses") {
        dayUrls.push(url);
        return makeResponse(200, { items: [], next_cursor: null });
      }
      return voiceRoutes({
        parse: { items: [PARSED_TEA], confidence: 0.95 },
        dayRows: [],
        onBulk: (body) => bulk.push(body),
      })(req, url);
    });
    renderWithProviders(<VoiceOverlay open onClose={() => {}} />);
    await typeAndAdd("চায়ে ৪০ টাকা");

    // Prototype parity: nothing suspicious → mic → saved, no review step.
    expect(await screen.findByText("✓ ১ সংরক্ষিত হয়েছে")).toBeInTheDocument();
    expect(bulk).toHaveLength(1);
    expect((bulk[0] as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ amt: "40.00", cat: "চা" }),
    ]);
    expect(dayUrls).toHaveLength(1);
    expect(dayUrls[0].searchParams.get("from")).toBe(todayIso());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
