import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
  AUTH_EXPIRED_EVENT,
  apiLogin,
  apiLogout,
  apiMe,
  apiRefresh,
  apiRegister,
  configureAuth,
  type AuthSession,
  type User,
} from "@khoroch/api-client";

export type AuthStatus = "loading" | "authed" | "anon";

/** localStorage key holding ONLY the refresh token. */
export const REFRESH_KEY = "khoroch.refresh";

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
}

export type AuthResult = { ok: true } | { ok: false; detail: string };

interface AuthState {
  user: User | null;
  /**
   * Access token lives in MEMORY ONLY. It never touches localStorage,
   * so a page reload always goes through the refresh flow below.
   */
  accessToken: string | null;
  /**
   * SECURITY TRADEOFF (documented): the refresh token is persisted to
   * localStorage under REFRESH_KEY, which is readable by any injected
   * script (XSS). This is deliberate for the current cycle — pending
   * httpOnly-cookie refresh endpoints on the API. Revisit before prod.
   */
  refreshToken: string | null;
  status: AuthStatus;
  /** Restore a session on app start: me() with in-memory token, else refresh. */
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<AuthResult>;
  register: (input: RegisterInput) => Promise<AuthResult>;
  /** Revoke server-side, then drop all local state (memory + localStorage). */
  logout: () => Promise<void>;
}

function setSession(
  set: (partial: Partial<AuthState>) => void,
  session: AuthSession,
): void {
  set({
    user: session.user,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    status: "authed",
  });
}

function clearSession(set: (partial: Partial<AuthState>) => void): void {
  set({ user: null, accessToken: null, refreshToken: null, status: "anon" });
  // zustand persist would otherwise leave a tombstone {"refreshToken":null}
  // behind — remove the key entirely so no stale token can be reused.
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(REFRESH_KEY);
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      status: "loading",

      bootstrap: async () => {
        // 1) Warm SPA session: in-memory access token still works.
        if (get().accessToken) {
          const me = await apiMe();
          if (me.ok) {
            set({ user: me.data, status: "authed" });
            return;
          }
          // me() failed — the client middleware already attempted one silent
          // refresh and, on failure, dispatched auth-expired which cleared us.
        }
        // 2) Cold start: rotate the persisted refresh token. The refresh
        //    response carries the user, so no separate me() call is needed.
        const refreshToken = get().refreshToken;
        if (!refreshToken) {
          set({ status: "anon" });
          return;
        }
        const res = await apiRefresh(refreshToken);
        if (res.ok) setSession(set, res.data);
        else clearSession(set);
      },

      login: async (email, password) => {
        const res = await apiLogin({ email, password });
        if (!res.ok) return { ok: false, detail: res.detail };
        setSession(set, res.data);
        return { ok: true };
      },

      register: async ({ email, password, name }) => {
        const res = await apiRegister({ email, password, name });
        if (!res.ok) return { ok: false, detail: res.detail };
        setSession(set, res.data);
        return { ok: true };
      },

      logout: async () => {
        try {
          // Best-effort server revocation; a 401 here means the client
          // middleware already refreshed (or expired us) — either way we clear.
          await apiLogout();
        } catch {
          /* network errors must not block logout */
        }
        clearSession(set);
        window.localStorage.removeItem(REFRESH_KEY);
      },
    }),
    {
      name: REFRESH_KEY,
      // Guarded storage: a persisted snapshot without a refresh token is a
      // TOMBSTONE (anonymous state) — remove the key instead of writing it,
      // so localStorage faithfully means "a session exists here".
      storage: createJSONStorage((): StateStorage => ({
        getItem: (name) => window.localStorage.getItem(name),
        setItem: (name, value) => {
          try {
            const parsed = JSON.parse(value) as { state?: { refreshToken?: unknown } };
            if (typeof parsed?.state?.refreshToken === "string") {
              window.localStorage.setItem(name, value);
            } else {
              window.localStorage.removeItem(name);
            }
          } catch {
            window.localStorage.removeItem(name);
          }
        },
        removeItem: (name) => window.localStorage.removeItem(name),
      })),
      // Persist ONLY the refresh token — never user PII or the access token.
      partialize: (state) => ({ refreshToken: state.refreshToken }),
      merge: (persisted, current) => {
        const stored = (persisted as { refreshToken?: unknown } | undefined)?.refreshToken;
        return { ...current, refreshToken: typeof stored === "string" ? stored : null };
      },
    },
  ),
);

// Hand the client its auth plumbing (the client cannot import the store —
// circular dependency — so the store registers getters/callbacks instead).
configureAuth({
  getAccessToken: () => useAuthStore.getState().accessToken,
  getRefreshToken: () => useAuthStore.getState().refreshToken,
  onTokenRefresh: ({ accessToken, refreshToken }) =>
    useAuthStore.setState({ accessToken, refreshToken }),
});

// A failed silent refresh anywhere in the app drops the local session.
if (typeof window !== "undefined") {
  window.addEventListener(AUTH_EXPIRED_EVENT, () => {
    clearSession(useAuthStore.setState);
  });
}
