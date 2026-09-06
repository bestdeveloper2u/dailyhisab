import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Expense } from "@khoroch/api-client";
import { Expenses } from "../src/screens/Expenses";
import { ToastHost } from "../src/components/Toast";
import {
  makeExpense,
  makeResponse,
  renderWithProviders,
  resetLang,
  stubFetch,
} from "./helpers";
import { useLangStore } from "../src/store/lang";

/**
 * T22.1 — single-tap delete with an UNDO toast (NN/g "Confirmation Dialogs"):
 * one ✕ tap deletes immediately; the toast's Undo action re-creates the row
 * with the EXACT pre-delete payload (amt/cat/grp/pay/iso/desc) and the
 * failed-delete path leaves the row in place.
 */

const ROW: Expense = makeExpense({
  id: "del-1",
  cat: "ইলিশ",
  amt: "890.50",
  grp: "food",
  pay: "bkash",
  desc: "রসিদ",
  iso: "2026-09-04",
});

beforeEach(resetLang);
afterEach(() => vi.unstubAllGlobals());

interface Recorded {
  method: string;
  pathname: string;
  body?: unknown;
}

/** Stateful "server": list reflects every delete/create; records all calls. */
function stubExpenseApi(opts: {
  deleteStatus?: number;
  createStatus?: number;
}) {
  let items: Expense[] = [{ ...ROW }];
  const calls: Recorded[] = [];
  stubFetch(async (req, url) => {
    let body: unknown;
    try {
      body = await req.clone().json();
    } catch {
      body = undefined;
    }
    const rec: Recorded = { method: req.method, pathname: url.pathname, body };
    calls.push(rec);

    if (req.method === "GET" && url.pathname === "/api/v1/expenses") {
      return makeResponse(200, { items, next_cursor: null });
    }
    if (req.method === "DELETE" && url.pathname === "/api/v1/expenses/del-1") {
      if (opts.deleteStatus !== 200 && opts.deleteStatus !== undefined) {
        return makeResponse(opts.deleteStatus, {
          detail: { code: "db", message_bn: "ডিবি ত্রুটি", message_en: "db error" },
        });
      }
      items = items.filter((r) => r.id !== "del-1");
      return makeResponse(204, null);
    }
    if (req.method === "POST" && url.pathname === "/api/v1/expenses") {
      if (opts.createStatus !== undefined && opts.createStatus >= 400) {
        return makeResponse(opts.createStatus, {
          detail: { code: "db", message_bn: "সংরক্ষণ হয়নি", message_en: "not saved" },
        });
      }
      const b = body as Partial<Expense>;
      items = [
        ...items,
        { ...ROW, id: "restored-1", ...b },
      ];
      return makeResponse(201, { ...ROW, id: "restored-1" });
    }
    return makeResponse(404, { detail: "not mocked" });
  });
  return calls;
}

function renderScreen() {
  return renderWithProviders(
    <>
      <Expenses />
      <ToastHost />
    </>,
    { route: "/expenses" },
  );
}

describe("single-tap delete with undo", () => {
  it("deletes on the first ✕ tap and shows the undo toast", async () => {
    const calls = stubExpenseApi({});
    const user = userEvent.setup();
    renderScreen();

    expect(await screen.findByText("ইলিশ")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ইলিশ — মুছুন" }));

    // No confirm step: DELETE fires immediately, exactly once.
    await waitFor(() => {
      expect(
        calls.filter((c) => c.method === "DELETE" && c.pathname === "/api/v1/expenses/del-1"),
      ).toHaveLength(1);
    });
    // The undo toast is rendered with its inline action button.
    const region = screen.getByRole("status");
    await waitFor(() => expect(region).toHaveTextContent("মোছা হয়েছে"));
    expect(screen.getByRole("button", { name: "ফিরিয়ে আনুন" })).toBeInTheDocument();
    // Invalidation refetched the list without the deleted row.
    await waitFor(() => expect(screen.queryByText("ইলিশ")).not.toBeInTheDocument());
  });

  it("undo re-creates the payload-exact row and invalidates the list", async () => {
    const calls = stubExpenseApi({});
    const user = userEvent.setup();
    renderScreen();

    expect(await screen.findByText("ইলিশ")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ইলিশ — মুছুন" }));
    await waitFor(() => expect(screen.queryByText("ইলিশ")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "ফিরিয়ে আনুন" }));

    // EXACT pre-delete payload, decimal string preserved.
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.pathname === "/api/v1/expenses");
      expect(post?.body).toEqual({
        amt: "890.50",
        cat: "ইলিশ",
        grp: "food",
        pay: "bkash",
        iso: "2026-09-04",
        desc: "রসিদ",
      });
    });
    // "Restored" toast + the refetched list shows the row again.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("ফিরিয়ে আনো হয়েছে"));
    expect(await screen.findByText("ইলিশ")).toBeInTheDocument();
    // initial load + post-delete refetch + post-undo refetch.
    const listLoads = calls.filter((c) => c.method === "GET" && c.pathname === "/api/v1/expenses");
    expect(listLoads.length).toBeGreaterThanOrEqual(3);
  });

  it("a failed delete shows an error toast and keeps the row (en)", async () => {
    useLangStore.setState({ lang: "en" });
    stubExpenseApi({ deleteStatus: 500 });
    const user = userEvent.setup();
    renderScreen();

    expect(await screen.findByText("ইলিশ")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ইলিশ — Delete" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Delete failed"));
    // Row stays — nothing was destroyed.
    expect(screen.getByText("ইলিশ")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("a failed undo shows an error toast and the row stays deleted", async () => {
    stubExpenseApi({ createStatus: 500 });
    const user = userEvent.setup();
    renderScreen();

    expect(await screen.findByText("ইলিশ")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ইলিশ — মুছুন" }));
    await waitFor(() => expect(screen.queryByText("ইলিশ")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "ফিরিয়ে আনুন" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("ফিরিয়ে আনা যায়নি"),
    );
    // The restore POST failed → the row must NOT come back.
    await waitFor(() => {
      expect(screen.queryByText("ইলিশ")).not.toBeInTheDocument();
    });
  });
});
