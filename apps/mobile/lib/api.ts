/**
 * Tiny typed HTTP client for the Hisab auth API (FastAPI).
 *
 * API_BASE is taken from EXPO_PUBLIC_API_URL (Expo inlines EXPO_PUBLIC_* env
 * vars at bundle time). Device/simulator builds must set it explicitly, e.g.:
 *
 *   EXPO_PUBLIC_API_URL=https://api.khoroch.example \
 *     pnpm --filter @khoroch/mobile start
 *
 * It defaults to the local FastAPI dev server for development.
 *
 * Endpoints live under /api/v1 (auth + expenses). Error bodies always carry a
 * top-level `detail` key (ADR-0004 §7) in one of three forms:
 *   - "string"            — auth domain errors (ADR-0002)
 *   - {code, message_bn, message_en} — expenses/reports domain errors
 *   - [...]               — FastAPI's native 422 validation errors
 * `ApiError.message` resolves to the best human-readable string of the three;
 * `ApiError.code` is set only for the domain-triple form.
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

/**
 * Typed error for any non-2xx response or transport-level failure.
 *
 * `code` carries the ADR-0004 §7 domain code (`invalid_cursor`, `not_found`,
 * …) when the server sent the {code, message_bn, message_en} triple, else null.
 */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never got a response (network). */
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Domain error triple attached as `detail` (ADR-0004 §7). */
export interface ApiErrorDetail {
  code: string;
  message_bn: string;
  message_en: string;
}

async function parseError(res: Response): Promise<{ message: string; code: string | null }> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (body !== null && typeof body === "object" && "detail" in body) {
      const detail = body.detail;
      // Form 1: auth-style plain string (ADR-0002).
      if (typeof detail === "string" && detail.length > 0) {
        return { message: detail, code: null };
      }
      // Form 2: domain triple {code, message_bn, message_en} (ADR-0004 §7).
      if (detail !== null && typeof detail === "object" && !Array.isArray(detail)) {
        const d = detail as Partial<ApiErrorDetail>;
        if (typeof d.code === "string" && d.code.length > 0) {
          const message =
            typeof d.message_bn === "string" && d.message_bn.length > 0
              ? d.message_bn
              : typeof d.message_en === "string" && d.message_en.length > 0
                ? d.message_en
                : d.code;
          return { message, code: d.code };
        }
      }
      // Form 3: FastAPI 422 validation array → fall through to the generic
      // message; individual field errors are not worth UI surface on mobile.
    }
  } catch {
    // Non-JSON body — fall through to generic message.
  }
  return { message: `Request failed (${res.status})`, code: null };
}

/** Shared request helper: JSON in/out, any `detail` error form → ApiError. */
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
    const { message, code } = await parseError(res);
    throw new ApiError(res.status, message, code);
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

// --- Expenses (Phase 2, ADR-0004) -------------------------------------------

export type ExpenseGroup =
  | "food"
  | "housing"
  | "utility"
  | "transport"
  | "health"
  | "education"
  | "personal"
  | "other";

export type PayMethod = "cash" | "bkash" | "nagad" | "rocket" | "card" | "bank";

/**
 * One expense row — GET/POST /api/v1/expenses payload.
 * Keys mirror the DB columns exactly (ADR-0004 §3): no camelCase translation.
 */
export interface Expense {
  id: string;
  user_id: string;
  cat: string;
  grp: ExpenseGroup;
  /** Decimal string "890.00" — never a JSON number (ADR-0004 §1). */
  amt: string;
  pay: PayMethod;
  /** Serialized as explicit null when absent (ADR-0004 §6). */
  desc: string | null;
  /** Event date "YYYY-MM-DD" — the column name is NOT a currency code (ADR-0004 §2). */
  iso: string;
  /** RFC 3339 UTC with Z (ADR-0004 §4). */
  created_at: string;
}

/** POST /api/v1/expenses body. `pay` defaults to "cash" server-side. */
export interface ExpenseCreateInput {
  cat: string;
  grp: ExpenseGroup;
  /** Decimal string matching ^\d{1,10}\.\d{2}$ — e.g. "890.00". */
  amt: string;
  iso: string;
  pay?: PayMethod;
  desc?: string | null;
}

/** Envelope for every list endpoint (ADR-0004 §8). */
export interface ExpenseList {
  items: Expense[];
  /** Opaque keyset cursor; null on the last page. */
  next_cursor: string | null;
}

/** GET /api/v1/expenses query params; all optional. */
export interface ListExpensesParams {
  from?: string; // YYYY-MM-DD inclusive
  to?: string; // YYYY-MM-DD inclusive
  q?: string; // substring on cat
  limit?: number; // 1..100, default 20
  cursor?: string; // opaque next_cursor from the previous page
}

/** GET /api/v1/expenses (Bearer access) → 200 envelope; 400 invalid cursor. */
export async function listExpenses(
  accessToken: string,
  params: ListExpensesParams = {},
): Promise<ExpenseList> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      qs.set(key, String(value));
    }
  }
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  return request<ExpenseList>(`/api/v1/expenses${suffix}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** POST /api/v1/expenses (Bearer access) → 201 stored row; 422 validation. */
export async function createExpense(
  accessToken: string,
  input: ExpenseCreateInput,
): Promise<Expense> {
  return request<Expense>("/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// --- Dashboard report (Phase 3, ADR-0004) ------------------------------------

/**
 * GET /api/v1/reports/monthly payload. Money values are decimal STRINGS
 * ("1234.50"); `by_group` maps group name → decimal string; `by_day` is
 * ordered ascending by day of month.
 */
export interface MonthlyReport {
  ym: string; // "YYYY-MM"
  total: string; // decimal string, 2dp
  count: number; // expense rows in the month
  by_group: Record<string, string>; // grp → decimal string
  by_day: { iso: string; total: string }[];
}

/** GET /api/v1/reports/monthly?ym=YYYY-MM (Bearer access) → 200; 400 invalid_ym. */
export async function monthlyReport(
  accessToken: string,
  ym?: string,
): Promise<MonthlyReport> {
  const suffix = ym !== undefined ? `?ym=${encodeURIComponent(ym)}` : "";
  return request<MonthlyReport>(`/api/v1/reports/monthly${suffix}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// --- Debts (Phase 3, ADR-0004) ------------------------------------------------

/** lend = I gave money out, borrow = I took money in. */
export type DebtDir = "lend" | "borrow";

/** ?status= filter for GET /api/v1/debts (default "open"). */
export type DebtStatusFilter = "open" | "settled" | "all";

/**
 * One debt row — GET/POST /api/v1/debts payload. Keys mirror the DB columns
 * exactly (ADR-0004 §3): no camelCase translation.
 */
export interface Debt {
  id: string;
  user_id: string;
  party: string;
  dir: DebtDir;
  /** Decimal string "2000.00" — never a JSON number (ADR-0004 §1). */
  amt: string;
  /** Serialized as explicit null when absent (ADR-0004 §6). */
  note: string | null;
  /** Event date "YYYY-MM-DD". */
  iso: string;
  /** RFC 3339 UTC with Z, or explicit null while the debt is open. */
  settled_at: string | null;
  /** RFC 3339 UTC with Z (ADR-0004 §4). */
  created_at: string;
}

/** Envelope for GET /api/v1/debts (ADR-0004 §8). */
export interface DebtList {
  items: Debt[];
  /** Opaque keyset cursor; null on the last page. */
  next_cursor: string | null;
}

/** GET /api/v1/debts query params; all optional (status defaults to "open"). */
export interface ListDebtsParams {
  status?: DebtStatusFilter;
  limit?: number; // 1..100, default 20
  cursor?: string; // opaque next_cursor from the previous page
}

/** POST /api/v1/debts body. `iso` defaults to today server-side. */
export interface DebtCreateInput {
  party: string; // 1..120 chars
  dir: DebtDir;
  /** Decimal string matching ^\d{1,10}\.\d{2}$, > 0 — e.g. "2000.00". */
  amt: string;
  note?: string | null; // max 200 chars
  iso?: string | null; // YYYY-MM-DD
}

/** POST /api/v1/debts/{id}/pay result — FULL settles the row, PARTIAL shrinks it. */
export interface DebtPayResult {
  status: "FULL" | "PARTIAL";
  debt: Debt;
}

/** GET /api/v1/debts (Bearer access) → 200 envelope; 400 invalid_cursor. */
export async function listDebts(
  accessToken: string,
  params: ListDebtsParams = {},
): Promise<DebtList> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      qs.set(key, String(value));
    }
  }
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  return request<DebtList>(`/api/v1/debts${suffix}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** POST /api/v1/debts (Bearer access) → 201 stored row; 422 validation. */
export async function createDebt(
  accessToken: string,
  input: DebtCreateInput,
): Promise<Debt> {
  return request<Debt>("/api/v1/debts", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * POST /api/v1/debts/{id}/pay (Bearer access) → 200 {status, debt};
 * 409 debt_already_settled; 404 unknown/foreign id; 422 validation.
 */
export async function payDebt(
  accessToken: string,
  debtId: string,
  amt: string,
): Promise<DebtPayResult> {
  return request<DebtPayResult>(`/api/v1/debts/${debtId}/pay`, {
    method: "POST",
    body: JSON.stringify({ amt }),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
