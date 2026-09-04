import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_EXPIRED_EVENT, apiMe, configureAuth } from "@khoroch/api-client";

/**
 * Client-level refresh-on-401 tests with a hand-rolled fetch stub (no msw).
 * Each queued entry is served to the next outgoing request, in order.
 */

interface RecordedCall {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "demo@khoroch.app",
  name: "Demo",
};
const PAIR1 = { accessToken: "access-1", refreshToken: "refresh-1" };
const PAIR2 = { accessToken: "access-2", refreshToken: "refresh-2" };

function makeResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const calls: RecordedCall[] = [];
let currentAccess: string | null = null;
let currentRefresh: string | null = null;

function stubFetch(responses: Array<{ status: number; body?: unknown }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : await request.json();
    calls.push({
      url: request.url,
      method: request.method,
      auth: request.headers.get("authorization"),
      body,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    return makeResponse(next.status, next.body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  calls.length = 0;
  currentAccess = PAIR1.accessToken;
  currentRefresh = PAIR1.refreshToken;
  configureAuth({
    getAccessToken: () => currentAccess,
    getRefreshToken: () => currentRefresh,
    onTokenRefresh: (tokens) => {
      currentAccess = tokens.accessToken;
      currentRefresh = tokens.refreshToken;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api-client refresh-on-401", () => {
  it("401 on me() → refresh once → retry succeeds with the new token", async () => {
    const fetchMock = stubFetch([
      { status: 401, body: { detail: "Token has expired" } }, // me
      { status: 200, body: { user: USER, ...PAIR2 } }, // refresh
      { status: 200, body: USER }, // retried me
    ]);

    const res = await apiMe();

    expect(res).toEqual({ ok: true, data: USER });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(calls[0]!.url).toContain("/api/v1/auth/me");
    expect(calls[0]!.auth).toBe("Bearer access-1");

    expect(calls[1]!.url).toContain("/api/v1/auth/refresh");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body).toEqual({ refreshToken: "refresh-1" });
    // refresh is a public endpoint — it must NOT carry the stale bearer
    expect(calls[1]!.auth).toBeNull();

    expect(calls[2]!.url).toContain("/api/v1/auth/me");
    expect(calls[2]!.auth).toBe("Bearer access-2");
  });

  it("does not loop when the retried request 401s again", async () => {
    const fetchMock = stubFetch([
      { status: 401, body: { detail: "Token has expired" } },
      { status: 200, body: { user: USER, ...PAIR2 } },
      { status: 401, body: { detail: "Token has expired" } },
    ]);

    const res = await apiMe();

    expect(res).toMatchObject({ ok: false, status: 401, detail: "Token has expired" });
    // exactly: original me, one refresh, one retry — nothing more
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(calls.filter((c) => c.url.includes("/auth/refresh"))).toHaveLength(1);
  });

  it("on refresh failure emits auth-expired once and surfaces the 401", async () => {
    const fetchMock = stubFetch([
      { status: 401, body: { detail: "Token has expired" } },
      { status: 401, body: { detail: "Refresh token revoked" } },
    ]);
    const onExpired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);

    const res = await apiMe();

    // The refresh attempt fails; the ORIGINAL me() 401 is what propagates
    // to the caller (middleware returns undefined after emitting the event).
    expect(res).toMatchObject({ ok: false, status: 401, detail: "Token has expired" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // no retry attempt
    expect(onExpired).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  });
});
