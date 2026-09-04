/**
 * @khoroch/api-client — typed client for the Daily Khoroch API.
 *
 * The `paths`/`components` types are generated from apps/api/openapi.json by
 * `pnpm generate` (src/schema.gen.d.ts — do not edit by hand).
 *
 * Runtime behaviour:
 *  - `Authorization: Bearer <accessToken>` is injected on every protected
 *    call (login/register/refresh are excluded — they never carry a stale
 *    token).
 *  - A 401 on a protected call triggers ONE silent refresh (single-flight,
 *    rotation-aware) and retries the original request with the new token.
 *    The retry uses raw `fetch` so it can never re-enter this middleware —
 *    no loops.
 *  - If the refresh fails (revoked/unknown token), `khoroch:auth-expired`
 *    is dispatched on `window` and the original 401 is returned; the app
 *    store listens for the event and drops the session.
 */
import createClient from "openapi-fetch";
import type { Middleware } from "openapi-fetch";
import type { components, paths } from "./schema.gen";

export type { components, paths };

export type User = components["schemas"]["UserOut"];
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}
export type AuthSession = { user: User } & AuthTokens;

/** Normalised result: `detail` carries the backend `{ detail: string }` message. */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; detail: string };

/** Window event dispatched when a 401 could not be recovered via refresh. */
export const AUTH_EXPIRED_EVENT = "khoroch:auth-expired";

/** Endpoints whose 401s are final answers — refreshing on them would loop. */
const PUBLIC_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/register",
  "/api/v1/auth/refresh",
]);

/**
 * Auth plumbing provided by the app (the client must not import the store —
 * that would be a circular dependency). Registered via `configureAuth`.
 */
interface AuthHandlers {
  getAccessToken: () => string | null | undefined;
  getRefreshToken: () => string | null | undefined;
  /** Called with the rotated pair after a successful silent refresh. */
  onTokenRefresh?: (tokens: AuthTokens) => void;
}

const auth: AuthHandlers = {
  getAccessToken: () => null,
  getRefreshToken: () => null,
};

export function configureAuth(handlers: Partial<AuthHandlers>): void {
  Object.assign(auth, handlers);
}

/** Extract the human-readable `{ detail }` message (Flatten 422 arrays). */
function errorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "detail" in err) {
    const detail = (err as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((item) =>
          typeof item === "object" && item !== null && "msg" in item
            ? String((item as { msg: unknown }).msg)
            : String(item),
        )
        .join("; ");
    }
  }
  return "Unexpected error";
}

function emitAuthExpired(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

/**
 * A pristine clone of each request, stashed in onRequest BEFORE `fetch`
 * disturbs the original body — a 401 retry may need to re-send a POST body.
 */
const pristineRequests = new WeakMap<Request, Request>();

export const api = createClient<paths>({
  baseUrl: import.meta.env.VITE_API_URL ?? "",
  // Defer globalThis.fetch lookup to call time: openapi-fetch otherwise
  // binds fetch at client creation, which would bypass test doubles
  // installed later with vi.stubGlobal("fetch", …).
  fetch: (...args) => globalThis.fetch(...args),
});

// Single-flight: concurrent 401s share one refresh call.
let refreshInFlight: Promise<AuthSession | null> | null = null;

async function refreshSession(): Promise<AuthSession | null> {
  refreshInFlight ??= (async () => {
    const refreshToken = auth.getRefreshToken();
    if (!refreshToken) return null;
    // Goes through the middleware client, but /auth/refresh is in
    // PUBLIC_AUTH_PATHS so its own 401 can never recurse into here.
    const { data } = await api.POST("/api/v1/auth/refresh", {
      body: { refreshToken },
    });
    if (!data) return null;
    return {
      user: data.user,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    };
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

api.use({
  onRequest({ schemaPath, request }) {
    pristineRequests.set(request, request.clone());
    const token = auth.getAccessToken();
    if (token && !PUBLIC_AUTH_PATHS.has(schemaPath)) {
      request.headers.set("Authorization", `Bearer ${token}`);
    }
    return undefined;
  },
  async onResponse({ schemaPath, request, response }) {
    if (response.status !== 401) return undefined;
    // Final 401s (bad credentials, revoked/unknown refresh token): never refresh.
    if (PUBLIC_AUTH_PATHS.has(schemaPath)) return undefined;

    const tokens = await refreshSession();
    if (!tokens) {
      emitAuthExpired(); // store clears the session → user lands on /login
      return undefined; // original 401 propagates to the caller (its detail wins)
    }
    auth.onTokenRefresh?.(tokens); // persist the ROTATED pair immediately

    const pristine = pristineRequests.get(request) ?? request;
    const headers = new Headers(pristine.headers);
    headers.set("Authorization", `Bearer ${tokens.accessToken}`);
    // Raw fetch on purpose: outside the middleware pipeline → no retry loops.
    return fetch(new Request(pristine, { headers }));
  },
});

/* ------------------------------------------------------------------ */
/* Typed endpoint helpers                                              */
/* ------------------------------------------------------------------ */

export async function apiLogin(body: components["schemas"]["LoginIn"]): Promise<ApiResult<AuthSession>> {
  const { data, error, response } = await api.POST("/api/v1/auth/login", { body });
  if (data) {
    return {
      ok: true,
      data: { user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken },
    };
  }
  return { ok: false, status: response.status, detail: errorMessage(error) };
}

export async function apiRegister(
  body: components["schemas"]["RegisterIn"],
): Promise<ApiResult<AuthSession>> {
  const { data, error, response } = await api.POST("/api/v1/auth/register", { body });
  if (data) {
    return {
      ok: true,
      data: { user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken },
    };
  }
  return { ok: false, status: response.status, detail: errorMessage(error) };
}

export async function apiRefresh(refreshToken: string): Promise<ApiResult<AuthSession>> {
  const { data, error, response } = await api.POST("/api/v1/auth/refresh", {
    body: { refreshToken },
  });
  if (data) {
    return {
      ok: true,
      data: { user: data.user, accessToken: data.accessToken, refreshToken: data.refreshToken },
    };
  }
  return { ok: false, status: response.status, detail: errorMessage(error) };
}

export async function apiLogout(): Promise<ApiResult<null>> {
  const { error, response } = await api.POST("/api/v1/auth/logout", {});
  if (response.ok) return { ok: true, data: null };
  return { ok: false, status: response.status, detail: errorMessage(error) };
}

export async function apiMe(): Promise<ApiResult<User>> {
  const { data, error, response } = await api.GET("/api/v1/auth/me");
  if (data) return { ok: true, data };
  return { ok: false, status: response.status, detail: errorMessage(error) };
}
