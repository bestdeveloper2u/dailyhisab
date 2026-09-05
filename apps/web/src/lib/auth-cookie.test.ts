import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_EXPIRED_EVENT, type AuthSession } from "@khoroch/api-client";
import { logoutCookie, refreshCookieSession } from "./auth-cookie";
import { REFRESH_KEY, useAuthStore } from "../store/auth";

/**
 * ADR-0008 adoption tests (T12.3): the httpOnly-cookie refresh transport and
 * its wiring into the auth store / api-client refresh fallback. Pure store
 * tests — no MemoryRouter, just a URL-routed fetch stub.
 */

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "demo@khoroch.app",
  name: "Demo",
};

function authOut(access: string, refresh: string): AuthSession {
  return { user: USER, accessToken: access, refreshToken: refresh };
}

interface RecordedCall {
  url: string;
  method: string;
  credentials: string;
  auth: string | null;
}

interface QueuedResponse {
  status: number;
  body?: unknown;
}

interface Route {
  /** Substring matched against the request URL. */
  match: string;
  /** Served in order; an exhausted queue makes the stub throw. */
  responses: QueuedResponse[];
}

function route(match: string, ...responses: QueuedResponse[]): Route {
  return { match, responses };
}

function makeResponse(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const calls: RecordedCall[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function stubRoutes(routes: Route[]): void {
  calls.length = 0;
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    calls.push({
      url: request.url,
      method: request.method,
      credentials: request.credentials,
      auth: request.headers.get("authorization"),
    });
    // EXACT pathname match: "/auth/refresh" must never swallow the calls of
    // "/auth/refresh-cookie" (substring matching would).
    const path = new URL(request.url).pathname;
    const matched = routes.find((r) => path === r.match);
    const next = matched?.responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    return makeResponse(next.status, next.body);
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Number of recorded calls whose pathname equals `path` exactly. */
function countTo(path: string): number {
  return calls.filter((c) => new URL(c.url).pathname === path).length;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.setState({
    user: null,
    accessToken: null,
    refreshToken: null,
    status: "loading",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth-cookie transport", () => {
  it("refreshCookieSession POSTs the typed endpoint with credentials:'include' and returns the session", async () => {
    stubRoutes([route("/api/v1/auth/refresh-cookie", { status: 200, body: authOut("access-c", "refresh-c") })]);

    const session = await refreshCookieSession();

    expect(session).toEqual(authOut("access-c", "refresh-c"));
    expect(countTo("/api/v1/auth/refresh-cookie")).toBe(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    // the whole point: the browser is told to attach the HttpOnly cookie
    expect(call.credentials).toBe("include");
    // cookie transport carries NO Bearer header
    expect(call.auth).toBeNull();
  });

  it("refreshCookieSession treats 401/403 as 'no session' (null, never throws)", async () => {
    stubRoutes([
      route("/api/v1/auth/refresh-cookie", { status: 401 }, { status: 403 }),
    ]);

    await expect(refreshCookieSession()).resolves.toBeNull();
    await expect(refreshCookieSession()).resolves.toBeNull();
  });

  it("refreshCookieSession resolves null on malformed body and network errors", async () => {
    stubRoutes([
      // 200 but not an AuthOut triple
      route("/api/v1/auth/refresh-cookie", { status: 200, body: { user: USER } }),
      route("/api/v1/auth/refresh-cookie", { status: 500 }),
    ]);
    // first call: malformed success body
    await expect(refreshCookieSession()).resolves.toBeNull();
    // second call: the stub itself throws (route queue exhausted) — still null
    await expect(refreshCookieSession()).resolves.toBeNull();
  });

  it("concurrent cookie refreshes share one probe (single-flight)", async () => {
    stubRoutes([route("/api/v1/auth/refresh-cookie", { status: 200, body: authOut("access-c", "refresh-c") })]);

    const [a, b] = await Promise.all([refreshCookieSession(), refreshCookieSession()]);

    expect(a).toEqual(b);
    expect(countTo("/api/v1/auth/refresh-cookie")).toBe(1);
  });

  it("logoutCookie fire-and-forgets POST /auth/logout-cookie with credentials:'include'", async () => {
    stubRoutes([route("/api/v1/auth/logout-cookie", { status: 204 })]);

    logoutCookie();
    await flush();

    expect(countTo("/api/v1/auth/logout-cookie")).toBe(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.credentials).toBe("include");
  });
});

describe("boot restore via httpOnly cookie (ADR-0008)", () => {
  it("(a) restores the session via cookie when localStorage is empty", async () => {
    stubRoutes([route("/api/v1/auth/refresh-cookie", { status: 200, body: authOut("access-c", "refresh-c") })]);

    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.status).toBe("authed");
    expect(state.user).toEqual(USER);
    expect(state.accessToken).toBe("access-c");
    // the cookie-rotated pair is persisted exactly like the JSON path's
    expect(JSON.parse(window.localStorage.getItem(REFRESH_KEY)!).state.refreshToken).toBe(
      "refresh-c",
    );
    // cold start with no tokens: ONLY the cookie probe — no me(), no JSON refresh
    expect(calls).toHaveLength(1);
    expect(calls[0]!.credentials).toBe("include");
  });

  it("(b) JSON refresh failure → cookie fallback recovers exactly once", async () => {
    useAuthStore.setState({ refreshToken: "refresh-1", status: "loading" });
    stubRoutes([
      route("/api/v1/auth/refresh", { status: 401, body: { detail: "Refresh token revoked" } }),
      route("/api/v1/auth/refresh-cookie", { status: 200, body: authOut("access-c", "refresh-c") }),
    ]);

    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.status).toBe("authed");
    expect(state.accessToken).toBe("access-c");
    expect(JSON.parse(window.localStorage.getItem(REFRESH_KEY)!).state.refreshToken).toBe(
      "refresh-c",
    );
    // one refresh TOTAL — not one per path, no retries
    expect(countTo("/api/v1/auth/refresh")).toBe(1);
    expect(countTo("/api/v1/auth/refresh-cookie")).toBe(1);
  });

  it("(c) JSON and cookie both fail → anon + auth-expired event once", async () => {
    useAuthStore.setState({ refreshToken: "refresh-1", status: "loading" });
    stubRoutes([
      route("/api/v1/auth/refresh", { status: 401, body: { detail: "Refresh token revoked" } }),
      route("/api/v1/auth/refresh-cookie", { status: 401 }),
    ]);
    const onExpired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);

    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.status).toBe("anon");
    expect(state.user).toBeNull();
    expect(state.refreshToken).toBeNull();
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(countTo("/api/v1/auth/refresh")).toBe(1);
    expect(countTo("/api/v1/auth/refresh-cookie")).toBe(1);
    window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  });

  it("(d) logout fires the cookie endpoint alongside the JSON logout", async () => {
    useAuthStore.setState({
      user: USER,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      status: "authed",
    });
    stubRoutes([
      route("/api/v1/auth/logout-cookie", { status: 204 }),
      route("/api/v1/auth/logout", { status: 204 }),
    ]);

    await useAuthStore.getState().logout();

    expect(countTo("/api/v1/auth/logout-cookie")).toBe(1);
    expect(countTo("/api/v1/auth/logout")).toBe(1);
    expect(useAuthStore.getState().status).toBe("anon");
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("401 on a protected call: middleware JSON-fails then cookie-rescues exactly once", async () => {
    useAuthStore.setState({
      user: USER,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      status: "authed",
    });
    stubRoutes([
      route("/api/v1/auth/me", { status: 401, body: { detail: "Token has expired" } }, { status: 200, body: USER }),
      route("/api/v1/auth/refresh", { status: 401, body: { detail: "Refresh token revoked" } }),
      route("/api/v1/auth/refresh-cookie", { status: 200, body: authOut("access-c", "refresh-c") }),
    ]);

    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.status).toBe("authed");
    expect(state.user).toEqual(USER);
    expect(state.accessToken).toBe("access-c");
    // retried me() carries the cookie-rescued token
    const meRetry = calls.filter((c) => c.url.includes("/api/v1/auth/me"))[1]!;
    expect(meRetry.auth).toBe("Bearer access-c");
    // single-flight across transports: one JSON refresh, one cookie probe
    expect(countTo("/api/v1/auth/refresh")).toBe(1);
    expect(countTo("/api/v1/auth/refresh-cookie")).toBe(1);
    // the rescue persisted the rotated pair
    expect(JSON.parse(window.localStorage.getItem(REFRESH_KEY)!).state.refreshToken).toBe(
      "refresh-c",
    );
  });
});
