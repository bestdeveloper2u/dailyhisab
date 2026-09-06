import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToasts } from "../lib/toast";
import { useLangStore } from "../store/lang";
import { SessionsCard, formatSessionTtl, splitSessionTtl } from "./SessionsCard";

/**
 * T26.2 — Settings সক্রিয় সেশন card. Rides the real api-client contract like
 * Recurring/DataSafety tests: global fetch is stubbed with the exact shapes
 * the generated client emits (GET /auth/sessions, POST .../revoke-others).
 */

const CURRENT_ID = "cur12345-aaaaaaaa-bbbb";
const OTHER_ID = "oth98765-cccccccc-dddd";
/** 594000s = 6d 21h; 3600s = 1h (KV TTL seconds remaining). */
const SESSIONS_TWO = {
  current: CURRENT_ID,
  items: [
    { id: CURRENT_ID, expires_in: 594000 },
    { id: OTHER_ID, expires_in: 3600 },
  ],
};

interface Recorded {
  method: string;
  pathname: string;
}

function stubApi(handler: (rec: Recorded) => Response | object) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const rec: Recorded = { method: req.method, pathname: new URL(req.url).pathname };
    calls.push(rec);
    const out = handler(rec);
    if (out instanceof Response) return out;
    return Response.json(out);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SessionsCard />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useLangStore.setState({ lang: "bn" });
});

describe("session TTL humanizer (pure helpers)", () => {
  it("splits weeks-capped and formats two most significant units", () => {
    expect(splitSessionTtl(594000)).toEqual({ w: 0, d: 6, h: 21, m: 0 });
    expect(splitSessionTtl(604800 * 2 + 3600)).toEqual({ w: 2, d: 0, h: 1, m: 0 });
    expect(formatSessionTtl(594000, "en")).toBe("6d 21h");
    expect(formatSessionTtl(3600, "en")).toBe("1h");
    expect(formatSessionTtl(90, "en")).toBe("1m");
    expect(formatSessionTtl(0, "en")).toBe("0m");
  });

  it("formats bn digits and unit glyphs", () => {
    expect(formatSessionTtl(594000, "bn")).toBe("৬দি ২১ঘ");
    expect(formatSessionTtl(604800, "bn")).toBe("১সপ্তাহ");
  });
});

describe("SessionsCard (Settings সক্রিয় সেশন)", () => {
  it("renders id prefixes, humanized TTLs and the this-device badge", async () => {
    useLangStore.setState({ lang: "en" });
    stubApi(({ method, pathname }) => {
      if (method === "GET" && pathname === "/api/v1/auth/sessions") return SESSIONS_TWO;
      return new Response(null, { status: 404 });
    });

    renderCard();

    expect(await screen.findByText("cur12345")).toBeInTheDocument();
    expect(screen.getByText("oth98765")).toBeInTheDocument();
    expect(screen.getByText("6d 21h")).toBeInTheDocument();
    expect(screen.getByText("1h")).toBeInTheDocument();
    expect(screen.getAllByText("This device")).toHaveLength(1);
  });

  it("revoke is two-tap: first tap only arms Confirm?, second POSTs + refetches + toasts", async () => {
    useLangStore.setState({ lang: "en" });
    let live = SESSIONS_TWO;
    const calls = stubApi(({ method, pathname }) => {
      if (method === "GET" && pathname === "/api/v1/auth/sessions") return live;
      if (method === "POST" && pathname === "/api/v1/auth/sessions/revoke-others") {
        live = { current: CURRENT_ID, items: [SESSIONS_TWO.items[0]] };
        return { revoked: 1 };
      }
      return new Response(null, { status: 404 });
    });
    const seen: string[] = [];
    const unsubscribe = subscribeToasts((s) => s && seen.push(s.text));

    renderCard();
    const revoke = await screen.findByRole("button", { name: "Revoke other devices" });

    fireEvent.click(revoke);
    expect(screen.getByRole("button", { name: "Confirm?" })).toBeInTheDocument();
    expect(
      calls.some((c) => c.method === "POST" && c.pathname === "/api/v1/auth/sessions/revoke-others"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm?" }));

    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.pathname === "/api/v1/auth/sessions/revoke-others"),
      ).toBe(true),
    );
    await waitFor(() => expect(seen).toContain("Revoked 1 session(s)"));
    // invalidation refetches and the revoked row disappears
    await waitFor(() => expect(screen.queryByText("oth98765")).not.toBeInTheDocument());
    expect(screen.getByText("cur12345")).toBeInTheDocument();
    unsubscribe();
  });

  it("current=null (409 case) disables revoke and shows the helper text", async () => {
    useLangStore.setState({ lang: "en" });
    stubApi(({ method, pathname }) => {
      if (method === "GET" && pathname === "/api/v1/auth/sessions") {
        return { current: null, items: SESSIONS_TWO.items };
      }
      return new Response(null, { status: 404 });
    });

    renderCard();

    expect(await screen.findByText("cur12345")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke other devices" })).toBeDisabled();
    expect(screen.getByText("Current session not identified")).toBeInTheDocument();
  });

  it("fewer than two sessions disables revoke with its own helper", async () => {
    useLangStore.setState({ lang: "en" });
    stubApi(({ method, pathname }) => {
      if (method === "GET" && pathname === "/api/v1/auth/sessions") {
        return { current: CURRENT_ID, items: [SESSIONS_TWO.items[0]] };
      }
      return new Response(null, { status: 404 });
    });

    renderCard();

    expect(await screen.findByText("cur12345")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke other devices" })).toBeDisabled();
    expect(screen.getByText("No other active sessions")).toBeInTheDocument();
  });
});
