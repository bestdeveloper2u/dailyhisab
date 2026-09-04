import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type { ReactElement } from "react";
import { useLangStore } from "../src/store/lang";
import type { Expense } from "@khoroch/api-client";

/** JSON/204 response builder (mirrors api-client.test.ts). */
export function makeResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type RouteHandler = (req: Request, url: URL) => Response | Promise<Response>;

/**
 * Route-based fetch stub: the handler inspects method + URL and answers.
 * Unlike a response queue this tolerates refetches (query invalidation).
 */
export function stubFetch(handler: RouteHandler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    return handler(request, new URL(request.url));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: ReactElement,
  opts: { route?: string } = {},
) {
  const queryClient = makeQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[opts.route ?? "/"]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Reset the lang store to the bn default between tests. */
export function resetLang(): void {
  window.localStorage.clear();
  useLangStore.setState({ lang: "bn" });
}

export const USER_ID = "11111111-1111-4111-8111-111111111111";

export function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    user_id: USER_ID,
    cat: "মাছ",
    grp: "food",
    amt: "890.00",
    pay: "cash",
    desc: null,
    iso: "2026-09-04",
    created_at: "2026-09-04T09:30:00Z",
    ...overrides,
  };
}
