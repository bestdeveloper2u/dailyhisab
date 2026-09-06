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

/**
 * One distinct khata (category) derived from the caller's history
 * (ADR-0019). `grp`/`last_used` come from the khata's most recent expense
 * and are prefill hints only.
 */
export interface Khata {
  cat: string;
  grp: ExpenseGroup;
  /** How many of the caller's expenses use this khata (≥ 1). */
  use_count: number;
  /** "YYYY-MM-DD" of the khata's most recent expense. */
  last_used: string;
}

/** GET /api/v1/expenses/categories (Bearer access) → khata rows,
 * most-used → most-recent (ADR-0019); 401 expired/invalid. */
export async function listKhataCategories(
  accessToken: string,
): Promise<Khata[]> {
  const out = await request<{ items: Khata[] }>("/api/v1/expenses/categories", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return out.items;
}

// --- Voice parse + bulk create (Phase 4, T15.2) -------------------------------

/** One expense candidate from POST /voice/parse (schema: ParsedItem). */
export interface ParsedExpense {
  cat: string;
  grp: ExpenseGroup;
  /** Decimal string "40.00" — never a JSON number (ADR-0004 §1). */
  amt: string;
  /** Serialized as explicit null when the transcript didn't name a method. */
  pay?: PayMethod | null;
  desc?: string | null;
  /** "YYYY-MM-DD", or null → caller defaults to today. */
  iso?: string | null;
}

/** POST /voice/parse response: the candidates plus an overall 0..1 confidence. */
export interface VoiceParseResult {
  items: ParsedExpense[];
  confidence: number;
}

/**
 * POST /api/v1/voice/parse (Bearer access) → 200 candidates; 422 empty text.
 * Rule-based parser — READ-ONLY (no rows are created here).
 */
export async function voiceParse(
  accessToken: string,
  text: string,
): Promise<VoiceParseResult> {
  return request<VoiceParseResult>("/api/v1/voice/parse", {
    method: "POST",
    body: JSON.stringify({ text }),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * POST /api/v1/expenses/bulk (Bearer access) → 201 stored rows; 422
 * validation. Accepts up to 50 items in a single flush (voice multi-insert).
 */
export async function createExpensesBulk(
  accessToken: string,
  items: ExpenseCreateInput[],
): Promise<Expense[]> {
  const out = await request<{ items: Expense[] }>("/api/v1/expenses/bulk", {
    method: "POST",
    body: JSON.stringify({ items }),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return out.items;
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

/**
 * GET /api/v1/reports/yearly payload. Money values are decimal STRINGS
 * ("1234.50"); `by_group` maps group name → decimal string; `by_month` is
 * ALWAYS all 12 months of the year, ascending, zero-filled ("0.00").
 */
export interface YearlyReport {
  year: number; // YYYY
  total: string; // decimal string, 2dp
  count: number; // expense rows in the year
  by_group: Record<string, string>; // grp → decimal string
  by_month: { ym: string; total: string }[]; // 12 entries, "YYYY-MM"
}

/** GET /api/v1/reports/yearly?year=YYYY (Bearer access) → 200; 400 invalid_year. */
export async function yearlyReport(
  accessToken: string,
  year?: number,
): Promise<YearlyReport> {
  const suffix = year !== undefined ? `?year=${String(year)}` : "";
  return request<YearlyReport>(`/api/v1/reports/yearly${suffix}`, {
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

// --- Budgets (Phase 3, ADR-0004 / T10.1) --------------------------------------

/** Per-category budget vs actual spend for one month (BudgetCatUsage). */
export interface BudgetCatUsage {
  /** Category limit for the month — decimal string "8000.00". */
  budget: string;
  /** Actual spend in the category — decimal string. */
  spent: string;
  /** spent / budget × 100 as a JSON number (can exceed 100 when over). */
  usage_pct: number;
}

/**
 * GET/PUT /api/v1/budgets payload: the stored budget merged with that
 * month's spending. Money values are decimal STRINGS ("1234.50");
 * `by_cat` maps category name → BudgetCatUsage.
 */
export interface Budget {
  /** "YYYY-MM" the usage was computed for. */
  ym: string;
  /** Stored monthly limit — decimal string, "0.00" when never set. */
  total: string;
  /** Stored per-category limits: cat → decimal string (may be empty). */
  cats: Record<string, string>;
  /** Total spend in `ym` — decimal string. */
  spent: string;
  /** spent / total × 100 as a JSON number (can exceed 100 when over). */
  usage_pct: number;
  by_cat: Record<string, BudgetCatUsage>;
}

/**
 * PUT /api/v1/budgets body — both fields optional (partial upsert).
 * Values must match ^\d{1,10}\.\d{2}$ — e.g. "890.00".
 * NOTE: a non-null `cats` REPLACES the whole per-category map, so callers
 * editing one category must send the full merged map.
 */
export interface BudgetPutInput {
  total?: string | null;
  cats?: Record<string, string> | null;
}

/**
 * GET /api/v1/budgets?ym=YYYY-MM (Bearer access) → 200 Budget;
 * 400 invalid ym; 422 validation. `ym` omitted → server default (current).
 */
export async function getBudget(
  accessToken: string,
  ym?: string,
): Promise<Budget> {
  const suffix = ym !== undefined ? `?ym=${encodeURIComponent(ym)}` : "";
  return request<Budget>(`/api/v1/budgets${suffix}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * PUT /api/v1/budgets (Bearer access) → 200 upserted Budget (the GET view
 * for the CURRENT month); 422 validation. Upserts the single stored budget
 * row — month-agnostic; viewing another month only changes GET usage.
 */
export async function putBudget(
  accessToken: string,
  body: BudgetPutInput,
): Promise<Budget> {
  return request<Budget>("/api/v1/budgets", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// --- CSV export (Phase 3, T12.2) ------------------------------------------------

/** GET /api/v1/export/expenses.csv query params; both optional. */
export interface ExportCsvParams {
  from?: string; // YYYY-MM-DD inclusive
  to?: string; // YYYY-MM-DD inclusive
}

/**
 * Full URL for the CSV export endpoint (UTF-8 BOM + Bengali header row).
 * Returns a URL instead of fetching because the file must go through
 * FileSystem.downloadAsync (native download + share sheet), not fetch();
 * the caller attaches the Bearer access token as a header itself.
 */
export function exportExpensesCsvUrl(params: ExportCsvParams = {}): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      qs.set(key, value);
    }
  }
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  return `${API_BASE}/api/v1/export/expenses.csv${suffix}`;
}

// --- Data safety: backup.json export + restore (T21.3, ADR-0012) ---------------

/** One budgets row inside a BackupEnvelope (BackupBudgetRow). */
export interface BackupBudgetRow {
  /** "YYYY-MM" the budget applies to. */
  ym: string;
  /** Monthly limit — decimal string "12000.00" (never a JSON number). */
  total: string;
  /** cat → decimal string (may be empty). */
  cats: Record<string, string>;
}

/**
 * The full-fidelity backup document (schema BackupEnvelope, ADR-0012) —
 * BOTH directions of the flow: GET /export/backup.json returns it and
 * POST /import/restore accepts it verbatim. `expenses`/`debts` reuse the
 * CRUD wire shapes, so money stays exact decimal STRINGS end-to-end
 * (ADR-0004 §1): fetch → stringify → share/POST must never round or
 * reformat a value.
 */
export interface BackupEnvelope {
  /** Always 1 today; absent in exotic clients → optional. */
  schema_version?: number;
  /** RFC 3339 timestamp of the export. */
  exported_at: string;
  counts: { expenses: number; debts: number; budgets: number };
  expenses: Expense[];
  debts: Debt[];
  budgets: BackupBudgetRow[];
}

/** POST /api/v1/import/restore response (RestoreOut). */
export interface RestoreResult {
  /** How many rows of each collection were inserted. */
  restored: { expenses: number; debts: number; budgets: number };
}

/**
 * GET /api/v1/export/backup.json (Bearer access) → 200 envelope.
 * Returns the parsed JSON untouched — decimal amounts arrive as strings and
 * are handed back as strings (no rounding/reformatting anywhere).
 */
export async function exportBackup(
  accessToken: string,
): Promise<BackupEnvelope> {
  return request<BackupEnvelope>("/api/v1/export/backup.json", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * POST /api/v1/import/restore (Bearer access) → 200 restored counts;
 * 422 validation. DESTRUCTIVE: the server REPLACES the caller's whole
 * ledger (one transaction — a failed restore rolls the deletes back too).
 * Callers must confirm with the user first.
 */
export async function restoreBackup(
  accessToken: string,
  envelope: BackupEnvelope,
): Promise<RestoreResult> {
  return request<RestoreResult>("/api/v1/import/restore", {
    method: "POST",
    body: JSON.stringify(envelope),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Parse + shape-check pasted backup text BEFORE the destructive restore
 * (mobile twin of the web's parseBackupFile): a JSON object carrying a
 * `schema_version` key or at least one of the three row arrays, where any
 * row collection that IS present must be an array. Returns null for
 * everything else — wrong app's JSON, truncated paste, a bare list, or
 * text that isn't JSON at all — so we never wipe a ledger on bad input.
 */
export function parseBackupEnvelope(text: string): BackupEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const env = parsed as Record<string, unknown>;
    let arrays = 0;
    for (const key of ["expenses", "debts", "budgets"] as const) {
      const value = env[key];
      if (value !== undefined) {
        if (!Array.isArray(value)) return null;
        arrays += 1;
      }
    }
    if (!("schema_version" in env) && arrays === 0) return null;
    return parsed as BackupEnvelope;
  } catch {
    return null; // not JSON at all
  }
}

// --- Recurring expenses (Phase 5, T16.1/T16.3) ---------------------------------

/**
 * Rule cadence (T16.1): occurrences are driven by `start_date` — there are
 * NO weekday/monthday fields on the wire.
 */
export type RecurringFreq = "daily" | "weekly" | "monthly" | "yearly";

/**
 * One recurring rule — GET/POST/PATCH /api/v1/recurring payload
 * (RecurringOut). Keys mirror the DB columns exactly (T16.1 contract): no
 * camelCase mapping.
 */
export interface Recurring {
  id: string;
  user_id: string;
  cat: string;
  grp: ExpenseGroup;
  /** Decimal string "12000.00" — never a JSON number (ADR-0004 §1). */
  amt: string;
  pay: PayMethod;
  /** Serialized as explicit null when absent (ADR-0004 §6). */
  desc: string | null;
  freq: RecurringFreq;
  /** First occurrence "YYYY-MM-DD". */
  start_date: string;
  /**
   * Next occurrence "YYYY-MM-DD" — server-owned, forward-only materialization
   * cursor (ADR-0014 §3); never present in request bodies.
   */
  next_run: string;
  /** Paused rules stay listed but are skipped by POST /recurring/run. */
  active: boolean;
  /** RFC 3339 UTC with Z (ADR-0004 §4). */
  created_at: string;
  updated_at: string;
}

/** Envelope for GET /api/v1/recurring (T16.1): keyset like expenses/debts. */
export interface RecurringList {
  items: Recurring[];
  /** Opaque keyset cursor; null on the last page. */
  next_cursor: string | null;
}

/** GET /api/v1/recurring query params; all optional. */
export interface ListRecurringParams {
  /** true = running rules only, false = paused only; omit for both. */
  active?: boolean;
  limit?: number; // 1..100, default 20
  cursor?: string; // opaque next_cursor from the previous page
}

/**
 * POST /api/v1/recurring body. `pay` defaults to "cash"; `start_date`
 * defaults to today server-side (the first occurrence).
 */
export interface RecurringCreateInput {
  cat: string; // 1..80 chars
  grp: ExpenseGroup;
  /** Decimal string matching ^\d{1,10}\.\d{2}$ — e.g. "12000.00". */
  amt: string;
  pay?: PayMethod;
  desc?: string | null; // max 200 chars
  freq: RecurringFreq;
  /** "YYYY-MM-DD"; omit/null → server fills today. */
  start_date?: string | null;
}

/** PATCH /api/v1/recurring/{id} body — all fields optional (partial update). */
export interface RecurringUpdateInput {
  cat?: string;
  grp?: ExpenseGroup;
  amt?: string;
  pay?: PayMethod;
  desc?: string | null;
  freq?: RecurringFreq;
  start_date?: string | null;
  /** The active toggle. Paused rules stay listed but never auto-run. */
  active?: boolean;
}

/**
 * POST /api/v1/recurring/run result — what THIS run materialized
 * (ADR-0014 §4). `created === expenses.length`.
 */
export interface RecurringRunResult {
  /** The run date "YYYY-MM-DD" the server used. */
  ran_on: string;
  /** Expenses actually inserted (0 on an idempotent same-day re-run). */
  created: number;
  /** Due rules processed this run. */
  rules: number;
  /** The created expense rows. */
  expenses: Expense[];
}

/** GET /api/v1/recurring (Bearer access) → 200 envelope; 400 invalid cursor. */
export async function listRecurring(
  accessToken: string,
  params: ListRecurringParams = {},
): Promise<RecurringList> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      qs.set(key, String(value));
    }
  }
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  return request<RecurringList>(`/api/v1/recurring${suffix}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** POST /api/v1/recurring (Bearer access) → 201 stored rule; 422 validation. */
export async function createRecurring(
  accessToken: string,
  input: RecurringCreateInput,
): Promise<Recurring> {
  return request<Recurring>("/api/v1/recurring", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** PATCH /api/v1/recurring/{id} (Bearer access) → 200 updated rule; 404 unknown/foreign id. */
export async function updateRecurring(
  accessToken: string,
  id: string,
  patch: RecurringUpdateInput,
): Promise<Recurring> {
  return request<Recurring>(`/api/v1/recurring/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** DELETE /api/v1/recurring/{id} (Bearer access) → 204; 404 unknown/foreign id. */
export async function deleteRecurring(
  accessToken: string,
  id: string,
): Promise<void> {
  await request<void>(`/api/v1/recurring/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * POST /api/v1/recurring/run (Bearer access) → 200 summary; idempotent within
 * a day (re-run ⇒ created=0). WRITES expenses — callers must confirm first.
 */
export async function runRecurring(
  accessToken: string,
): Promise<RecurringRunResult> {
  return request<RecurringRunResult>("/api/v1/recurring/run", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
