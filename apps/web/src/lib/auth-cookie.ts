/**
 * httpOnly-cookie refresh transport — web adoption of ADR-0008 (T12.3).
 *
 * The API ships two cookie endpoints (cycle 9):
 *   - `POST /api/v1/auth/refresh-cookie`: rotates the refresh token carried
 *     in the `kh_refresh` HttpOnly cookie and returns the AuthOut triple
 *     (user + fresh pair); the rotated token is ALSO installed as the new
 *     cookie (HttpOnly, Secure, SameSite=Lax, path=/api/v1/auth).
 *   - `POST /api/v1/auth/logout-cookie`: clears the cookie and revokes the
 *     session it points at (idempotent, always 204).
 *
 * The cookie is HttpOnly — JS can neither read nor write it; it can only ask
 * the browser to SEND it. Both endpoints go through the SAME typed openapi
 * client (`api`) with `credentials: "include"` so the browser attaches
 * `kh_refresh`. The endpoints are registered as PUBLIC_AUTH_PATHS in
 * @khoroch/api-client, so the client middleware neither pins a stale Bearer
 * header onto them nor recurses its 401 handling when they answer 401.
 *
 * TRANSPORT-INTERLEAVING GUARD (why the cookie is a fallback, never a peer):
 * the JSON `POST /auth/refresh` rotates the token but does NOT touch the
 * cookie. After any JSON rotation the cookie therefore holds a stale,
 * tombstoned token whose replay trips the server's reuse detection and
 * revokes the WHOLE session family — including a perfectly valid token in
 * localStorage. The cookie transport is consequently probed ONLY where the
 * JSON fallback cannot answer, i.e. when no refresh token is persisted
 * locally (boot restore with cleared storage / private mode) or the server
 * definitively rejected the persisted one (401/403). That gating lives in
 * the package client's `refreshSession` (JSON first, cookie fallback once,
 * single-flight across both); this module is the typed transport + the
 * registration glue (`configureCookieAuth`).
 */
import { api, configureAuth, type AuthSession } from "@khoroch/api-client";

/**
 * Auth plumbing provided by the store (mirrors `configureAuth` in
 * api-client — the store imports this module, so callbacks are used instead
 * of a store import to avoid a circular dependency).
 */
interface CookieAuthHandlers {
  /**
   * Called with the ROTATED session whenever the cookie transport rescues a
   * session inside the package client's refresh fallback. The store persists
   * the pair immediately — mirror of api-client's `onTokenRefresh`.
   */
  onSession: (session: AuthSession) => void;
}

const handlers: CookieAuthHandlers = {
  onSession: () => {},
};

/**
 * Web opt-in (ADR-0008): register this module as the api-client cookie
 * fallback and hand the store the persistence hook for cookie rescues.
 * Mobile never calls this — its refresh flow stays JSON-only, byte-identical.
 */
export function configureCookieAuth(registered: Partial<CookieAuthHandlers>): void {
  Object.assign(handlers, registered);
  configureAuth({
    refreshFromCookie: async () => {
      const session = await refreshCookieSession();
      if (session) handlers.onSession(session); // persist the ROTATED pair
      return session;
    },
  });
}

/** Single-flight: concurrent 401s and a racing boot restore share one probe. */
let cookieRefreshInFlight: Promise<AuthSession | null> | null = null;

/**
 * Rotate the httpOnly refresh cookie into a full session.
 * Resolves `null` on ANY failure — 401/403 (no/invalid cookie), malformed
 * body, network error — so callers stay silently logged out; never throws.
 */
export function refreshCookieSession(): Promise<AuthSession | null> {
  cookieRefreshInFlight ??= (async () => {
    try {
      // Typed client, credentials included: `kh_refresh` rides along in the
      // request — but never in JS-readable form.
      const { data, response } = await api.POST("/api/v1/auth/refresh-cookie", {
        credentials: "include",
      });
      // 401 (and any other non-OK) → "no session"; undocumented statuses come
      // back with `data: undefined` and are swallowed the same way. The body
      // is ALSO validated at runtime — types don't protect callers from a
      // misbehaving server, and a half-formed session must never enter the
      // store.
      if (
        !response.ok ||
        !data ||
        typeof data.accessToken !== "string" ||
        typeof data.refreshToken !== "string" ||
        !data.user
      ) {
        return null;
      }
      return {
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      };
    } catch {
      return null; // network error / abort — never throw into callers
    }
  })().finally(() => {
    cookieRefreshInFlight = null;
  });
  return cookieRefreshInFlight;
}

/**
 * Clear the refresh cookie and revoke the session it points at.
 * Fire-and-forget on purpose: logout must never block on this, and the
 * endpoint is idempotent (204 even without a cookie).
 */
export function logoutCookie(): void {
  void api
    .POST("/api/v1/auth/logout-cookie", { credentials: "include" })
    .then(
      () => undefined,
      () => undefined, // network errors must not surface on logout
    );
}
