import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiMe } from "@khoroch/api-client";
import { REFRESH_KEY, useAuthStore } from "../src/store/auth";

/**
 * Store-level auth tests against the real api-client, with a hand-rolled
 * fetch stub. Covers: login success persistence, register auto-login,
 * logout cleanup, bootstrap refresh flow, and the auth-expired collapse.
 */

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "demo@khoroch.app",
  name: "Demo",
};
const AUTHED = { user: USER, accessToken: "access-1", refreshToken: "refresh-1" };

function makeResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(responses: Array<{ status: number; body?: unknown }>) {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
    return makeResponse(next.status, next.body);
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.setState({
    user: null,
    accessToken: null,
    refreshToken: null,
    status: "anon",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth store", () => {
  it("login success stores the user in memory and persists only the refresh token", async () => {
    stubFetch([{ status: 200, body: AUTHED }]);

    const res = await useAuthStore.getState().login("demo@khoroch.app", "demo1234");

    expect(res).toEqual({ ok: true });
    const state = useAuthStore.getState();
    expect(state.status).toBe("authed");
    expect(state.user).toEqual(USER);
    expect(state.accessToken).toBe("access-1");

    const persisted = JSON.parse(window.localStorage.getItem(REFRESH_KEY)!);
    expect(persisted.state.refreshToken).toBe("refresh-1");
    // the access token never touches storage
    expect(JSON.stringify(persisted)).not.toContain("access-1");
  });

  it("login failure surfaces the backend detail message and stays anon", async () => {
    stubFetch([{ status: 401, body: { detail: "Invalid email or password" } }]);

    const res = await useAuthStore.getState().login("demo@khoroch.app", "wrong-password");

    expect(res).toEqual({ ok: false, detail: "Invalid email or password" });
    expect(useAuthStore.getState().status).toBe("anon");
    expect(useAuthStore.getState().user).toBeNull();
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("register success auto-logs the user in", async () => {
    stubFetch([
      {
        status: 201,
        body: { user: { ...USER, name: "New" }, accessToken: "access-9", refreshToken: "refresh-9" },
      },
    ]);

    const res = await useAuthStore.getState().register({
      email: "new@khoroch.app",
      password: "password123",
      name: "New",
    });

    expect(res).toEqual({ ok: true });
    const state = useAuthStore.getState();
    expect(state.status).toBe("authed");
    expect(state.user?.name).toBe("New");
    expect(state.accessToken).toBe("access-9");
    expect(JSON.parse(window.localStorage.getItem(REFRESH_KEY)!).state.refreshToken).toBe(
      "refresh-9",
    );
  });

  it("logout revokes server-side, clears state and localStorage", async () => {
    useAuthStore.setState({
      user: USER,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      status: "authed",
    });
    stubFetch([{ status: 204 }]);

    await useAuthStore.getState().logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().status).toBe("anon");
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("bootstrap rotates the persisted refresh token into a session", async () => {
    useAuthStore.setState({ refreshToken: "refresh-seed", status: "loading" });
    stubFetch([
      { status: 200, body: { user: USER, accessToken: "access-2", refreshToken: "refresh-2" } },
    ]);

    await useAuthStore.getState().bootstrap();

    const state = useAuthStore.getState();
    expect(state.status).toBe("authed");
    expect(state.user).toEqual(USER);
    expect(state.accessToken).toBe("access-2");
    // rotation: the NEW refresh token is what gets persisted
    expect(JSON.parse(window.localStorage.getItem(REFRESH_KEY)!).state.refreshToken).toBe(
      "refresh-2",
    );
  });

  it("bootstrap without any stored token ends anon without network calls", async () => {
    stubFetch([]);

    await useAuthStore.getState().bootstrap();

    expect(useAuthStore.getState().status).toBe("anon");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a me() 401 that cannot be refreshed collapses the session to anon", async () => {
    useAuthStore.setState({
      user: USER,
      accessToken: "access-1",
      refreshToken: "refresh-1",
      status: "authed",
    });
    stubFetch([
      { status: 401, body: { detail: "Token has expired" } },
      { status: 401, body: { detail: "Refresh token revoked" } },
    ]);

    const res = await apiMe();

    expect(res).toMatchObject({ ok: false, status: 401 });
    const state = useAuthStore.getState();
    expect(state.status).toBe("anon");
    expect(state.refreshToken).toBeNull();
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });
});
