/**
 * TanStack Query hooks for the Phase 2 screens. Lang rides in the query
 * keys so switching bn/en re-fetches with the matching error locale;
 * staleTime (30s, set in main.tsx) keeps it cheap.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  api,
  apiBulkCreateExpenses,
  apiCreateDebt,
  apiCreateExpense,
  apiCreateRecurring,
  apiDeleteDebt,
  apiDeleteExpense,
  apiDeleteRecurring,
  apiGetBudget,
  apiListCategories,
  apiListDebts,
  apiListExpenses,
  apiListRecurring,
  apiMonthlyReport,
  apiPayDebt,
  apiPutBudget,
  apiRunRecurring,
  apiUpdateDebt,
  apiUpdateExpense,
  apiUpdateRecurring,
  apiVoiceParse,
  apiYearlyReport,
  errorMessage,
  type ApiResult,
  type BudgetInput,
  type components,
  type Debt,
  type DebtCreateInput,
  type DebtStatus,
  type DebtUpdateInput,
  type Expense,
  type ExpenseCreateInput,
  type ExpenseUpdateInput,
  type Lang,
  type RecurringCreateInput,
  type RecurringUpdateInput,
} from "@khoroch/api-client";
import { toBnDigits } from "@khoroch/core";
import { useLangStore } from "../store/lang";
import { toast } from "../lib/toast";
import { w } from "../lib/web-i18n";
import {
  enqueueOutbox,
  flushOutboxWithUi,
  OfflineQueuedError,
  shouldQueueOffline,
  toOutboxItem,
} from "./outbox";

export interface ExpenseFilters {
  q?: string;
  /** ISO date bounds (month chip). Undefined = no bound ("All"). */
  from?: string;
  to?: string;
  pageLimit?: number;
}

/** Infinite-query cache shape for the expenses list (useExpensesInfinite).
 *  Pages are RAW api-client results — {ok, data:{items,next_cursor}} — because
 *  the queryFn returns the helper result untouched (T20.2 regression fix). */
interface ExpenseListPage {
  ok: boolean;
  data?: { items: Expense[]; next_cursor: string | null };
}
interface ExpenseListData {
  pages: ExpenseListPage[];
  pageParams: unknown[];
}

export const qk = {
  expenses: (filters: ExpenseFilters) => ["expenses", "list", filters] as const,
  monthly: (ym: string, lang: Lang) => ["reports", "monthly", ym, lang] as const,
  yearly: (year: number, lang: Lang) => ["reports", "yearly", year, lang] as const,
  debts: (status: DebtStatus) => ["debts", "list", status] as const,
  budget: (ym: string, lang: Lang) => ["budgets", ym, lang] as const,
  recurring: (filter: RecurringFilter) => ["recurring", "list", filter] as const,
  khataCategories: ["khata", "categories"] as const,
  sessions: ["auth", "sessions"] as const,
};

/** Keyset-paginated expense list (`{items, next_cursor}` per page). */
export function useExpensesInfinite(filters: ExpenseFilters) {
  const lang = useLangStore((s) => s.lang);
  const limit = filters.pageLimit ?? 20;
  return useInfiniteQuery({
    queryKey: qk.expenses({ ...filters, pageLimit: limit }),
    queryFn: ({ pageParam }) =>
      apiListExpenses(
        { q: filters.q, from: filters.from, to: filters.to, limit, cursor: pageParam },
        lang,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => {
      if (!lastPage.ok) return undefined;
      return lastPage.data.next_cursor ?? undefined;
    },
  });
}

export function useMonthlyReport(ym: string) {
  const lang = useLangStore((s) => s.lang);
  return useQuery({
    queryKey: qk.monthly(ym, lang),
    queryFn: () => apiMonthlyReport(ym, lang),
  });
}

export function useYearlyReport(year: number) {
  const lang = useLangStore((s) => s.lang);
  return useQuery({
    queryKey: qk.yearly(year, lang),
    queryFn: () => apiYearlyReport(year, lang),
  });
}

/**
 * History-derived khata list for the expense-form picker (ADR-0019). The set
 * is bounded by the user's own distinct cats and is cheap to re-read, so a
 * 5-minute staleTime keeps it out of the hot path entirely.
 */
export function useKhataCategories() {
  const lang = useLangStore((s) => s.lang);
  return useQuery({
    queryKey: qk.khataCategories,
    queryFn: () => apiListCategories(lang),
    staleTime: 5 * 60 * 1000,
  });
}

/** All create/update/delete mutations invalidate the touched caches. */
export function useExpenseMutations() {
  const lang = useLangStore((s) => s.lang);
  const qc = useQueryClient();
  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["expenses"] });
    await qc.invalidateQueries({ queryKey: ["reports"] });
  };

  // T20.2 optimistic create (TanStack Query v5 pattern): the new row is
  // prepended to every cached expenses list the moment the request leaves —
  // instant feedback on slow networks — and rolled back from the snapshot if
  // the server rejects it. Edit/delete stay non-optimistic.
  const create = useMutation({
    mutationFn: async (body: ExpenseCreateInput) => {
      try {
        const res = await apiCreateExpense(body, lang);
        if (!res.ok) throw new Error(res.detail || w(lang, "errFallback"));
        return res;
      } catch (err) {
        // T23.1 (ADR-0022): offline (or transport-dead) creates are queued
        // on-device and flushed on reconnect instead of being lost. The
        // thrown OfflineQueuedError reroutes onError to the "queued" toast.
        if (shouldQueueOffline(err)) {
          await enqueueOutbox(toOutboxItem(body));
          throw new OfflineQueuedError();
        }
        throw err;
      }
    },
    onMutate: async (body: ExpenseCreateInput) => {
      await qc.cancelQueries({ queryKey: ["expenses"] });
      const previous = qc.getQueriesData<ExpenseListData>({ queryKey: ["expenses", "list"] });
      const optimistic: Expense = {
        id: `temp-${crypto.randomUUID()}`,
        user_id: "optimistic",
        amt: body.amt,
        cat: body.cat,
        grp: body.grp,
        pay: body.pay,
        desc: body.desc ?? null,
        iso: body.iso,
        created_at: new Date().toISOString(),
      };
      qc.setQueriesData<ExpenseListData>({ queryKey: ["expenses", "list"] }, (old) => {
        const firstPage = old?.pages?.[0];
        const pageData = firstPage?.data;
        if (!old || !firstPage || !pageData) return old; // error/empty states — nothing to prepend to
        return {
          ...old,
          pages: [
            {
              ...firstPage,
              data: { ...pageData, items: [optimistic, ...pageData.items] },
            },
            ...old.pages.slice(1),
          ],
        };
      });
      return { previous };
    },
    onSuccess: () => {
      // Cheap outbox attempt after every real save (no-op when empty).
      void flushOutboxWithUi(qc, lang);
    },
    onError: (err, _body, ctx) => {
      if (ctx) for (const [key, data] of ctx.previous) qc.setQueryData(key, data);
      // Offline-queued is not a save failure: roll the optimistic row back
      // (it returns with a real id after the flush invalidation) and say so.
      if (err instanceof OfflineQueuedError) toast(w(lang, "offlineQueued"));
      else toast(w(lang, "tSaveErr"));
    },
    onSettled: () => void invalidate(),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ExpenseUpdateInput }) =>
      apiUpdateExpense(id, body, lang),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    // Throw on ok:false (mirrors create) so a failed DELETE is an actual
    // mutation error — T22.1's onError toast ("মোছা যায়নি") fires and the
    // row stays; a bare resolved result would skip every onError callback.
    mutationFn: async (id: string) => {
      const res = await apiDeleteExpense(id, lang);
      if (!res.ok) throw new Error(res.detail || w(lang, "errFallback"));
      return res;
    },
    onSuccess: () => void invalidate(),
  });
  const bulkCreate = useMutation({
    mutationFn: async (items: ExpenseCreateInput[]) => {
      try {
        return await apiBulkCreateExpenses(items, lang);
      } catch (err) {
        // T23.1 (ADR-0022): same offline detection as the single create —
        // each item queued individually, one shared "queued" toast.
        if (shouldQueueOffline(err)) {
          for (const item of items) await enqueueOutbox(toOutboxItem(item));
          throw new OfflineQueuedError();
        }
        throw err;
      }
    },
    onError: (err) => {
      if (err instanceof OfflineQueuedError) toast(w(lang, "offlineQueued"));
    },
    onSuccess: () => {
      void invalidate();
      void flushOutboxWithUi(qc, lang);
    },
  });

  return { create, update, remove, bulkCreate };
}

export function useVoiceParse() {
  const lang = useLangStore((s) => s.lang);
  return useMutation({
    mutationFn: (text: string) => apiVoiceParse(text, lang),
  });
}

/** Keyset-paginated debt list for one status tab (`open` by default). */
export function useDebtsInfinite(status: DebtStatus) {
  const lang = useLangStore((s) => s.lang);
  return useInfiniteQuery({
    queryKey: qk.debts(status),
    queryFn: ({ pageParam }) =>
      apiListDebts({ status, limit: 20, cursor: pageParam }, lang),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => {
      if (!lastPage.ok) return undefined;
      return lastPage.data.next_cursor ?? undefined;
    },
  });
}

/** Budget vs spend for one month (`ym = YYYY-MM`). */
export function useBudget(ym: string) {
  const lang = useLangStore((s) => s.lang);
  return useQuery({
    queryKey: qk.budget(ym, lang),
    queryFn: () => apiGetBudget(ym, lang),
  });
}

/** Debt mutations invalidate every debts tab (open/settled/all share data). */
export function useDebtMutations() {
  const lang = useLangStore((s) => s.lang);
  const qc = useQueryClient();
  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["debts"] });
  };

  const create = useMutation({
    mutationFn: (body: DebtCreateInput) => apiCreateDebt(body, lang),
    onSuccess: () => void invalidate(),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: DebtUpdateInput }) =>
      apiUpdateDebt(id, body, lang),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDeleteDebt(id, lang),
    onSuccess: () => void invalidate(),
  });
  const pay = useMutation({
    mutationFn: ({ id, amt }: { id: string; amt: string }) => apiPayDebt(id, amt, lang),
    onSuccess: () => void invalidate(),
  });

  return { create, update, remove, pay };
}

/** Budget upsert refreshes the month view (the PUT returns the GET view). */
export function useBudgetMutation() {
  const lang = useLangStore((s) => s.lang);
  const qc = useQueryClient();
  const put = useMutation({
    mutationFn: (body: BudgetInput) => apiPutBudget(body, lang),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["budgets"] }),
  });
  return { put };
}

/** Recurring list filter tab: running / paused / both. */
export type RecurringFilter = "all" | "active" | "paused";

/**
 * Keyset-paginated recurring rule list (T16.4 — ADR-0014). The `active`
 * tab maps to the API's `?active=` boolean; `all` omits it.
 */
export function useRecurringInfinite(filter: RecurringFilter = "all") {
  const lang = useLangStore((s) => s.lang);
  return useInfiniteQuery({
    queryKey: qk.recurring(filter),
    queryFn: ({ pageParam }) =>
      apiListRecurring(
        {
          active: filter === "all" ? undefined : filter === "active",
          limit: 20,
          cursor: pageParam,
        },
        lang,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => {
      if (!lastPage.ok) return undefined;
      return lastPage.data.next_cursor ?? undefined;
    },
  });
}

/**
 * Rule mutations. Run-now also invalidates expenses + reports: a successful
 * run just materialized real expenses (idempotent per day — ADR-0014), so
 * every dashboard/report cache is stale the moment it returns.
 */
export function useRecurringMutations() {
  const lang = useLangStore((s) => s.lang);
  const qc = useQueryClient();
  const invalidateRules = async () => {
    await qc.invalidateQueries({ queryKey: ["recurring"] });
  };

  const create = useMutation({
    mutationFn: (body: RecurringCreateInput) => apiCreateRecurring(body, lang),
    onSuccess: () => void invalidateRules(),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: RecurringUpdateInput }) =>
      apiUpdateRecurring(id, body, lang),
    onSuccess: () => void invalidateRules(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDeleteRecurring(id, lang),
    onSuccess: () => void invalidateRules(),
  });
  const run = useMutation({
    mutationFn: () => apiRunRecurring(lang),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["recurring"] });
      await qc.invalidateQueries({ queryKey: ["expenses"] });
      await qc.invalidateQueries({ queryKey: ["reports"] });
    },
  });

  return { create, update, remove, run };
}

/* ------------------------------------------------------------------ */
/* Auth sessions (T26.2 — backend v0.21.0)                             */
/* ------------------------------------------------------------------ */

export type SessionsOut = components["schemas"]["SessionsOut"];
export type SessionItem = components["schemas"]["SessionItemOut"];
export type RevokeOthersResult = components["schemas"]["RevokeOthersOut"];

/**
 * Typed 409: the access token carried no `sid` claim, so the server refuses
 * to guess which session to keep (POST /auth/sessions/revoke-others). The UI
 * checks `instanceof` and shows the "current session not identified" helper
 * instead of a generic failure toast.
 */
export class RevokeOthersConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevokeOthersConflictError";
  }
}

/** The caller's live sessions (`current` = this token's sid, or null). */
export async function apiListSessions(
  lang: Lang = "bn",
): Promise<ApiResult<SessionsOut>> {
  const { data, error, response } = await api.GET("/api/v1/auth/sessions");
  if (data) return { ok: true, data };
  return { ok: false, status: response.status, detail: errorMessage(error, lang) };
}

/** Revoke every session except the caller's own (no request body). */
export async function apiRevokeOtherSessions(
  lang: Lang = "bn",
): Promise<ApiResult<RevokeOthersResult>> {
  const { data, error, response } = await api.POST("/api/v1/auth/sessions/revoke-others", {});
  if (data) return { ok: true, data };
  return { ok: false, status: response.status, detail: errorMessage(error, lang) };
}

/** GET /auth/sessions — raw ApiResult, handled by SessionsCard like other queries. */
export function useSessions() {
  const lang = useLangStore((s) => s.lang);
  return useQuery({
    queryKey: qk.sessions,
    queryFn: () => apiListSessions(lang),
  });
}

/**
 * Revoke-others mutation: success toasts the localised count (bn digits),
 * invalidates qk.sessions, and a 409 becomes the typed
 * RevokeOthersConflictError instead of a toast (the card renders its own
 * helper for it — mirrors the ok:false-throw style of the other mutations).
 */
export function useRevokeOthersMutation() {
  const lang = useLangStore((s) => s.lang);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<RevokeOthersResult> => {
      const res = await apiRevokeOtherSessions(lang);
      if (!res.ok) {
        throw res.status === 409
          ? new RevokeOthersConflictError(res.detail || w(lang, "errFallback"))
          : new Error(res.detail || w(lang, "errFallback"));
      }
      return res.data;
    },
    onSuccess: async (data) => {
      const n = lang === "bn" ? toBnDigits(String(data.revoked)) : String(data.revoked);
      toast(w(lang, "sessionsRevoked").replace("{n}", n));
      await qc.invalidateQueries({ queryKey: qk.sessions });
    },
    onError: (err) => {
      // 409 is surfaced to the caller as state, not a message toast.
      if (err instanceof RevokeOthersConflictError) return;
      toast(w(lang, "sessionsRevokeErr"));
    },
  });
}

/** Utility for optimistic delete flows elsewhere; exported for symmetry. */
export type { Expense, Debt };
