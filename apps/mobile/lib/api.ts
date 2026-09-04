/**
 * Tiny typed HTTP client for the Khoroch auth API (FastAPI).
 *
 * API_BASE is taken from EXPO_PUBLIC_API_URL (Expo inlines EXPO_PUBLIC_* env
 * vars at bundle time). Device/simulator builds must set it explicitly, e.g.:
 *
 *   EXPO_PUBLIC_API_URL=https://api.khoroch.example \
 *     pnpm --filter @khoroch/mobile start
 *
 * It defaults to the local FastAPI dev server for development.
 * All endpoints live under /api/v1/auth and return {detail: string} on error.
 */

export const API_BASE: string = (
  process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");

export interface User {
  id: string;
  email: string;
  name: string | null;
}

/** Shape returned by login / register / refresh. Keys are camelCase. */
export interface AuthPair {
  user: User;
  accessToken: string;
  refreshToken: string;
}

/** Typed error for any non-2xx response or transport-level failure. */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never got a response (network). */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (body !== null && typeof body.detail === "string" && body.detail.length > 0) {
      return body.detail;
    }
  } catch {
    // Non-JSON body — fall through to generic message.
  }
  return `Request failed (${res.status})`;
}

/** Shared request helper: JSON in/out, {detail} errors → ApiError. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, "Network request failed");
  }

  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorDetail(res));
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

/** POST /api/v1/auth/login → 200 pair; 401 on bad credentials. */
export async function login(email: string, password: string): Promise<AuthPair> {
  return request<AuthPair>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

/** POST /api/v1/auth/register → 201 pair; 409 duplicate; 422 weak password. */
export async function register(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<AuthPair> {
  return request<AuthPair>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** POST /api/v1/auth/refresh → 200 new pair; 401 if revoked/unknown. */
export async function refresh(refreshToken: string): Promise<AuthPair> {
  return request<AuthPair>("/api/v1/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
}

/** POST /api/v1/auth/logout (Bearer access) → 204. */
export async function logout(accessToken: string): Promise<void> {
  await request<void>("/api/v1/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** GET /api/v1/auth/me (Bearer access) → 200 user; 401 expired/invalid. */
export async function me(accessToken: string): Promise<User> {
  return request<User>("/api/v1/auth/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
