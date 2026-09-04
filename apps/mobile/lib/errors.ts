/**
 * Map any error thrown by lib/api to a Bengali-first, user-facing string.
 * Kept out of lib/api.ts so the HTTP layer stays UI-free.
 */
import { ApiError } from "./api";
import { STRINGS } from "./strings";

export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) {
      return STRINGS.bn.errNetwork;
    }
    if (err.status === 401) {
      return STRINGS.bn.errUnauthorized;
    }
    if (err.message.length > 0) {
      return err.message;
    }
  }
  return STRINGS.bn.errGeneric;
}
