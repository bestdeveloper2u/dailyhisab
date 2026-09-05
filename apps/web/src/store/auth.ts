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
import { configureCookieAuth, logoutCookie, refreshCookieSession } from "../lib/auth-cookie";

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
   * REFRESH TRANSPORT (ADR-0008 adopted — T12.3): the refresh token is
   * still persisted to localStorage under REFRESH_KEY (JSON transport,
   * shared with the mobile app) and remains readable by injected scripts
   * (XSS). The web app now ALSO holds it in an HttpOnly cookie that JS
   * cannot read: boot restore and 401 recovery fall back to the cookie
   * whenever the JSON transport has nothing to answer with (see
   * lib/auth-cookie.ts). The localStorage copy is therefore a fallback
   * transport, no longer the only way back into a session.
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
          // refresh (JSON, then the cookie fallback) and, on total failure,
          // dispatched auth-expired which cleared us.
        }
        // 2) Cold start, JSON transport: rotate the persisted refresh token.
        //    The refresh response carries the user, so no separate me() call
        //    is needed.
        const refreshToken = get().refreshToken;
        if (refreshToken) {
          const res = await apiRefresh(refreshToken);
          if (res.ok) {
            setSession(set, res.data);
            return;
          }
          if (res.status !== 401 && res.status !== 403) {
            // Transient failure (network / 5xx): the cookie may hold a
            // tombstoned token whose replay trips reuse detection and revokes
            // an otherwise-live family — do NOT probe it (see lib/auth-cookie.ts).
            clearSession(set);
            return;
          }
        }
        // 3) ADR-0008 (T12.3): the HttpOnly cookie may still hold a valid
        //    refresh token even when localStorage was cleared (private mode,
        //    storage purge) or the persisted token was rejected above. One
        //    silent probe — on success this looks exactly like the JSON path.
        const session = await refreshCookieSession();
        if (session) {
          setSession(set, session);
          return;
        }
        // 4) Both transports exhausted → anonymous.
        if (refreshToken) {
          clearSession(set);
          // A persisted session died on both transports — announce it so
          // listeners drop whatever is left. A tokenless cold start stays
          // quiet: nothing expired, there was never a session here.
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
          }
        } else {
          set({ status: "anon" });
        }
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
        // ADR-0008 (T12.3): clear the httpOnly cookie too — fire-and-forget,
        // the endpoint is idempotent (204 even without a cookie).
        logoutCookie();
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

// ADR-0008 (T12.3): register the httpOnly-cookie transport as the client's
// one-shot refresh fallback, persisting rotated pairs it rescues (same shape
// the JSON path persists via onTokenRefresh).
configureCookieAuth({
  onSession: ({ user, accessToken, refreshToken }) =>
    useAuthStore.setState({ user, accessToken, refreshToken }),
});

// A failed silent refresh anywhere in the app drops the local session.
if (typeof window !== "undefined") {
  window.addEventListener(AUTH_EXPIRED_EVENT, () => {
    clearSession(useAuthStore.setState);
  });
}
