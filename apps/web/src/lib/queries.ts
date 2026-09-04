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
  apiBulkCreateExpenses,
  apiCreateExpense,
  apiDeleteExpense,
  apiListExpenses,
  apiMonthlyReport,
  apiUpdateExpense,
  apiVoiceParse,
  apiYearlyReport,
  type Expense,
  type ExpenseCreateInput,
  type ExpenseUpdateInput,
  type Lang,
} from "@khoroch/api-client";
import { useLangStore } from "../store/lang";

export interface ExpenseFilters {
  q?: string;
  /** ISO date bounds (month chip). Undefined = no bound ("All"). */
  from?: string;
  to?: string;
  pageLimit?: number;
}

export const qk = {
  expenses: (filters: ExpenseFilters) => ["expenses", "list", filters] as const,
  monthly: (ym: string, lang: Lang) => ["reports", "monthly", ym, lang] as const,
  yearly: (year: number, lang: Lang) => ["reports", "yearly", year, lang] as const,
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

/** All create/update/delete mutations invalidate the touched caches. */
export function useExpenseMutations() {
  const lang = useLangStore((s) => s.lang);
  const qc = useQueryClient();
  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["expenses"] });
    await qc.invalidateQueries({ queryKey: ["reports"] });
  };

  const create = useMutation({
    mutationFn: (body: ExpenseCreateInput) => apiCreateExpense(body, lang),
    onSuccess: () => void invalidate(),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ExpenseUpdateInput }) =>
      apiUpdateExpense(id, body, lang),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDeleteExpense(id, lang),
    onSuccess: () => void invalidate(),
  });
  const bulkCreate = useMutation({
    mutationFn: (items: ExpenseCreateInput[]) => apiBulkCreateExpenses(items, lang),
    onSuccess: () => void invalidate(),
  });

  return { create, update, remove, bulkCreate };
}

export function useVoiceParse() {
  const lang = useLangStore((s) => s.lang);
  return useMutation({
    mutationFn: (text: string) => apiVoiceParse(text, lang),
  });
}

/** Utility for optimistic delete flows elsewhere; exported for symmetry. */
export type { Expense };
