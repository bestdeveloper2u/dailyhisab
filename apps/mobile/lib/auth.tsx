/**
 * Auth session provider — the single owner of the signed-in state.
 *
 * Tokens are persisted in expo-secure-store (Keychain / EncryptedSharedPreferences)
 * under the keys below. On mount the stored access token is hydrated and the
 * user profile is fetched from GET /auth/me; on 401 the refresh endpoint is
 * tried exactly once (and any NEW pair it returns is persisted), otherwise the
 * stored session is cleared and the app starts signed out.
 */
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import * as api from "./api";

const ACCESS_KEY = "khoroch.access";
const REFRESH_KEY = "khoroch.refresh";

interface AuthState {
  user: api.User | null;
  accessToken: string | null;
  /** True until the SecureStore hydration + /me attempt has settled. */
  loading: boolean;
}

export interface AuthContextValue extends AuthState {
  login(email: string, password: string): Promise<void>;
  register(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SIGNED_OUT: AuthState = { user: null, accessToken: null, loading: false };

async function persistTokens(pair: api.AuthPair): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, pair.accessToken),
    SecureStore.setItemAsync(REFRESH_KEY, pair.refreshToken),
  ]);
}

async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ ...SIGNED_OUT, loading: true });
  const { accessToken } = state;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let stored: { access: string | null; refresh: string | null };
      try {
        stored = {
          access: await SecureStore.getItemAsync(ACCESS_KEY),
          refresh: await SecureStore.getItemAsync(REFRESH_KEY),
        };
      } catch {
        // SecureStore unavailable → start signed out rather than crash.
        if (!cancelled) setState(SIGNED_OUT);
        return;
      }

      if (!stored.access) {
        if (!cancelled) setState(SIGNED_OUT);
        return;
      }

      try {
        const user = await api.me(stored.access);
        if (!cancelled) {
          setState({ user, accessToken: stored.access, loading: false });
        }
        return;
      } catch (err) {
        // Access token expired/invalid → try the refresh flow exactly once.
        if (!(err instanceof api.ApiError) || err.status !== 401 || !stored.refresh) {
          await clearTokens().catch(() => undefined);
          if (!cancelled) setState(SIGNED_OUT);
          return;
        }

        try {
          const pair = await api.refresh(stored.refresh);
          await persistTokens(pair); // keep the NEW pair for the next launch
          const user = await api.me(pair.accessToken);
          if (!cancelled) {
            setState({ user, accessToken: pair.accessToken, loading: false });
          }
        } catch {
          // Refresh revoked/unknown → nothing left to restore.
          await clearTokens().catch(() => undefined);
          if (!cancelled) setState(SIGNED_OUT);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const pair = await api.login(email, password);
    await persistTokens(pair);
    setState({ user: pair.user, accessToken: pair.accessToken, loading: false });
  }, []);

  const register = useCallback(
    async (input: { email: string; password: string; name?: string }) => {
      const pair = await api.register(input);
      await persistTokens(pair);
      setState({ user: pair.user, accessToken: pair.accessToken, loading: false });
    },
    [],
  );

  const logout = useCallback(async () => {
    // Revoke server-side first; the local session is cleared either way so a
    // failed network call can never leave the user stuck signed in.
    if (accessToken) {
      await api.logout(accessToken).catch(() => undefined);
    }
    await clearTokens().catch(() => undefined);
    setState(SIGNED_OUT);
  }, [accessToken]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, register, logout }),
    [state, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
