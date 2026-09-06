import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Expense, Khata } from "@khoroch/api-client";
import { ExpenseForm } from "./ExpenseForm";
import { todayIso, yesterdayIso } from "../lib/catalog";
import { saveExpenseDraft } from "../lib/draft";
import { subscribeToasts } from "../lib/toast";
import { W } from "../lib/web-i18n";
import { useLangStore } from "../store/lang";

/**
 * T20.2 — ExpenseForm আজ/গতকাল date chips + the optimistic expense create
 * (TanStack Query v5 pattern). The api-client module is mocked so the
 * cache-priming/rollback behaviour of lib/queries.ts is exercised against a
 * controllable POST /expenses promise — no HTTP plumbing involved.
 */

const { createExpenseMock, listCategoriesMock } = vi.hoisted(() => ({
  createExpenseMock: vi.fn(),
  listCategoriesMock: vi.fn(),
}));

vi.mock("@khoroch/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@khoroch/api-client")>()),
  apiCreateExpense: createExpenseMock,
  apiListCategories: listCategoriesMock,
}));

/** Existing cached list row (ExpenseOut shape) + the server's created row. */
const EXISTING: Expense = {
  id: "e0",
  amt: "120.00",
  cat: "চা",
  grp: "food",
  pay: "cash",
  iso: "2026-09-05",
  desc: null,
  created_at: "2026-09-05T08:00:00Z",
  user_id: "u1",
};

const SERVER_ROW: Expense = {
  ...EXISTING,
  id: "srv-1",
  amt: "250.00",
  cat: "মাছ",
  iso: todayIso(),
  created_at: "2026-09-06T09:00:00Z",
};

/** Infinite-expenses cache key for the default filter ({pageLimit: 20}). */
const LIST_KEY = ["expenses", "list", { pageLimit: 20 }] as const;

/** REAL cached page shape: the queryFn returns the raw api-client result. */
interface ListPage {
  ok: boolean;
  data: { items: Expense[]; next_cursor: string | null };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderForm(onClose = vi.fn()) {
  const qc = makeClient();
  const { container } = render(
    <QueryClientProvider client={qc}>
      <ExpenseForm open onClose={onClose} />
    </QueryClientProvider>,
  );
  return { qc, container, onClose };
}

function seedList(qc: QueryClient, items: Expense[]) {
  qc.setQueryData<{ pages: ListPage[]; pageParams: unknown[] }>(LIST_KEY, {
    pages: [{ ok: true, data: { items, next_cursor: null } }],
    pageParams: [null],
  });
}

function cachedItems(qc: QueryClient): Expense[] {
  return (
    qc.getQueryData<{ pages: ListPage[]; pageParams: unknown[] }>(LIST_KEY)?.pages[0]
      ?.data?.items ?? []
  );
}

/** Fill the two required fields and submit the form. */
function fillAndSubmit(container: HTMLElement, amt = "২৫০", cat = "মাছ") {
  fireEvent.change(screen.getByLabelText("পরিমাণ (৳)"), { target: { value: amt } });
  fireEvent.change(screen.getByLabelText("খাত"), { target: { value: cat } });
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);
}

/** Toast capture via the imperative module's listener channel. */
let texts: string[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  texts = [];
  unsubscribe = subscribeToasts((state) => {
    if (state) texts.push(state.text);
  });
  useLangStore.setState({ lang: "bn" });
  createExpenseMock.mockReset();
  // Default: an empty (but successful) khata list — no suggestions anywhere.
  listCategoriesMock.mockReset();
  listCategoriesMock.mockResolvedValue({ ok: true, data: { items: [], next_cursor: null } });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  vi.restoreAllMocks();
  useLangStore.setState({ lang: "bn" });
  listCategoriesMock.mockReset();
});

describe("ExpenseForm আজ/গতকাল date chips (T20.2)", () => {
  it("আজ chip sets iso to today, even after a manual date edit", () => {
    renderForm();

    const date = screen.getByLabelText("তারিখ") as HTMLInputElement;
    fireEvent.change(date, { target: { value: "2026-01-15" } });
    expect(date.value).toBe("2026-01-15");

    fireEvent.click(screen.getByRole("button", { name: "আজ" }));
    expect(date.value).toBe(todayIso());
  });

  it("গতকাল chip sets iso to yesterday", () => {
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "গতকাল" }));
    expect((screen.getByLabelText("তারিখ") as HTMLInputElement).value).toBe(
      yesterdayIso(),
    );
  });

  it("chip pressed state follows iso (only one chip active at a time)", () => {
    renderForm();

    const today = screen.getByRole("button", { name: "আজ" });
    const yesterday = screen.getByRole("button", { name: "গতকাল" });

    // Fresh form defaults to today → আজ pressed.
    expect(today).toHaveAttribute("aria-pressed", "true");
    expect(yesterday).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(yesterday);
    expect(yesterday).toHaveAttribute("aria-pressed", "true");
    expect(today).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(today);
    expect(today).toHaveAttribute("aria-pressed", "true");
    expect(yesterday).toHaveAttribute("aria-pressed", "false");
  });

  it("a manual date edit deactivates both chips", () => {
    renderForm();

    const today = screen.getByRole("button", { name: "আজ" });
    const yesterday = screen.getByRole("button", { name: "গতকাল" });
    expect(today).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(screen.getByLabelText("তারিখ"), { target: { value: "2026-01-15" } });

    expect(today).toHaveAttribute("aria-pressed", "false");
    expect(yesterday).toHaveAttribute("aria-pressed", "false");
  });

  it("renders the datehint", () => {
    renderForm();

    expect(screen.getByText(W.bn.dateHint)).toBeInTheDocument();
  });
});

describe("ExpenseForm optimistic create (T20.2)", () => {
  it("prepends a synthesized row to the cached expenses list before the server answers", async () => {
    let resolveCreate!: (value: unknown) => void;
    createExpenseMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { qc, container } = renderForm();
    seedList(qc, [EXISTING]);

    fillAndSubmit(container);

    // The POST is in flight, yet the row is already in the cache.
    await waitFor(() => expect(createExpenseMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cachedItems(qc)[0]?.id).toMatch(/^temp-/));
    const optimistic = cachedItems(qc)[0] as Expense;
    expect(optimistic.amt).toBe("250.00");
    expect(optimistic.cat).toBe("মাছ");
    expect(optimistic.iso).toBe(todayIso());
    // Prepended, not replaced — the existing row is still in place.
    expect(cachedItems(qc)[1]).toEqual(EXISTING);

    // The server answers; the form closes and the submit body was exact.
    resolveCreate({ ok: true, data: SERVER_ROW });
    await waitFor(() => expect(createExpenseMock.mock.calls[0]?.[0]).toEqual({ amt: "250.00", cat: "মাছ", grp: "food", pay: "cash", iso: todayIso(), desc: null }));
  });

  it("a failed create (500) rolls the cache back and shows the error toast", async () => {
    createExpenseMock.mockResolvedValue({ ok: false, status: 500, detail: "boom" });
    const { qc, container } = renderForm();
    seedList(qc, [EXISTING]);

    fillAndSubmit(container);

    await waitFor(() => expect(texts).toContain(W.bn.tSaveErr));
    // Rolled back to exactly the pre-mutation snapshot.
    await waitFor(() => expect(cachedItems(qc)).toEqual([EXISTING]));
    // The form stays open with the values, showing the inline detail.
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("shows the success toast and closes the form on a successful create", async () => {
    createExpenseMock.mockResolvedValue({ ok: true, data: SERVER_ROW });
    const { qc, container, onClose } = renderForm();
    seedList(qc, [EXISTING]);

    fillAndSubmit(container);

    await waitFor(() => expect(texts).toContain(W.bn.tSaved));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // The optimistic row is still in the cache (invalidate re-syncs in-app).
    expect(cachedItems(qc)[0]?.amt).toBe("250.00");
    expect(createExpenseMock).toHaveBeenCalledWith(
      expect.objectContaining({ amt: "250.00", cat: "মাছ", iso: todayIso() }),
      "bn",
    );
  });
});

/** Fixture in API order: most-used → most-recent → cat (ADR-0019). */
const KHATAS: Khata[] = [
  { cat: "চা", grp: "food", last_used: "2026-09-05", use_count: 30 },
  { cat: "চাল", grp: "food", last_used: "2026-09-01", use_count: 12 },
  { cat: "রিকশা", grp: "transport", last_used: "2026-08-30", use_count: 7 },
  { cat: "মাছ", grp: "food", last_used: "2026-09-04", use_count: 22 },
];

function mockKhatas(items: Khata[] = KHATAS) {
  listCategoriesMock.mockResolvedValue({ ok: true, data: { items, next_cursor: null } });
}

function typeCat(value: string) {
  fireEvent.change(screen.getByLabelText("খাত"), { target: { value } });
}

describe("ExpenseForm khata picker combobox (T20.4)", () => {
  it("typing filters the fetched khatas and shows matching suggestions", async () => {
    mockKhatas();
    renderForm();

    typeCat("চা");

    const listbox = await screen.findByRole("listbox", { name: W.bn.khataSuggestionsLabel });
    const input = screen.getByLabelText("খাত");
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    // API order preserved; only substring matches shown (মাছ stays hidden).
    const names = within(listbox).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["চা খাদ্য ও মুদি", "চাল খাদ্য ও মুদি"]);
    expect(within(listbox).queryByRole("option", { name: /মাছ/ })).not.toBeInTheDocument();
  });

  it("ArrowDown highlights the next option; Enter fills cat AND grp and closes the popup", async () => {
    mockKhatas();
    renderForm();

    typeCat("চা");
    await screen.findByRole("listbox");
    const input = screen.getByLabelText("খাত");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "exp-cat-option-1");
    expect(
      within(screen.getByRole("listbox")).getByRole("option", { name: /চাল/ }),
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("চাল");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // A suggestion from a non-default group carries its grp into the form.
    typeCat("রি");
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("রিকশা");
    expect((screen.getByLabelText("গ্রুপ") as HTMLSelectElement).value).toBe("transport");
  });

  it("Escape closes only the popup — the form modal stays open", async () => {
    mockKhatas();
    const { onClose } = renderForm();

    typeCat("চা");
    await screen.findByRole("listbox");

    fireEvent.keyDown(screen.getByLabelText("খাত"), { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("খাত")).toHaveAttribute("aria-expanded", "false");
    // Without stopPropagation the Modal's window listener would close it all.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("পরিমাণ (৳)")).toBeInTheDocument();
  });

  it("mouse selection (onMouseDown) fills cat AND grp before blur hides the popup", async () => {
    mockKhatas();
    renderForm();

    typeCat("রি");
    const option = await screen.findByRole("option", { name: /রিকশা/ });

    fireEvent.mouseDown(option);

    expect(screen.getByLabelText("খাত")).toHaveValue("রিকশা");
    expect((screen.getByLabelText("গ্রুপ") as HTMLSelectElement).value).toBe("transport");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("free-typing an unknown khata never shows a popup and still submits", async () => {
    mockKhatas();
    createExpenseMock.mockResolvedValue({ ok: true, data: SERVER_ROW });
    const { container, onClose } = renderForm();

    fireEvent.change(screen.getByLabelText("পরিমাণ (৳)"), { target: { value: "১০০" } });
    typeCat("বিরিয়ানি");

    // No history match → no listbox, but the typed value stays put.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() =>
      expect(createExpenseMock).toHaveBeenCalledWith(
        expect.objectContaining({ amt: "100.00", cat: "বিরিয়ানি" }),
        "bn",
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("a failed categories fetch means no popup — the form still works", async () => {
    listCategoriesMock.mockResolvedValue({ ok: false, status: 500, detail: "boom" });
    createExpenseMock.mockResolvedValue({ ok: true, data: SERVER_ROW });
    const { container, onClose } = renderForm();

    // Let the (failing) query settle before typing.
    await waitFor(() => expect(listCategoriesMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("পরিমাণ (৳)"), { target: { value: "৫০" } });
    typeCat("চা");
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(createExpenseMock).toHaveBeenCalledWith(
        expect.objectContaining({ amt: "50.00", cat: "চা" }),
        "bn",
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("caps suggestions at 8 and never opens for a restored draft (T19.2)", async () => {
    mockKhatas(
      Array.from({ length: 10 }, (_, i) => ({
        cat: `খাত-${i}`,
        grp: "other" as const,
        last_used: "2026-09-01",
        use_count: i,
      })),
    );
    saveExpenseDraft({
      amt: "50",
      cat: "খাত-1",
      grp: "food",
      pay: "cash",
      iso: todayIso(),
      desc: "",
    });
    renderForm();

    // Draft restore fills state — the popup must NOT pop open on its own,
    // even though the restored khata exists in the fetched list.
    await waitFor(() => expect(screen.getByLabelText("খাত")).toHaveValue("খাত-1"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // Typing does open — capped at 8 of the 10 matches.
    typeCat("খাত");
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option")).toHaveLength(8);
  });
});
