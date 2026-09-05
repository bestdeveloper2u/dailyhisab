"""httpOnly refresh-cookie plumbing (ADR-0008 addendum, cycle 4/T8.3).

Single place that knows how the refresh token travels as a cookie:

* name ``kh_refresh``, scoped to ``path=/api/v1/auth`` so it is attached
  only to auth endpoints;
* ``HttpOnly`` (invisible to JS — the XSS tradeoff mitigation),
  ``SameSite=Lax`` (top-level navigations still send it; cross-site POSTs
  do not), ``Secure`` unless :attr:`Settings.refresh_cookie_secure` is
  disabled (tests only);
* ``Max-Age`` mirrors the refresh-token TTL, so the cookie never outlives
  the KV entries it maps to.

The JSON endpoints (/auth/refresh, /auth/logout) are unchanged — these
helpers serve only the cookie-flavoured additions.
"""

from fastapi import Response

from app.core.config import get_settings

#: Cookie carrying the rotating refresh token (httpOnly, JS never sees it).
REFRESH_COOKIE_NAME = "kh_refresh"
#: Path scope: the cookie rides only on auth endpoints (refresh + logout).
REFRESH_COOKIE_PATH = "/api/v1/auth"


def set_refresh_cookie(response: Response, token: str) -> None:
    """Attach the (rotated) refresh token as an httpOnly cookie."""
    settings = get_settings()
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        max_age=settings.refresh_ttl,
        expires=settings.refresh_ttl,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.refresh_cookie_secure,
        samesite="lax",
    )


def clear_refresh_cookie(response: Response) -> None:
    """Expire the refresh cookie (Max-Age=0) with matching attributes."""
    settings = get_settings()
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.refresh_cookie_secure,
        samesite="lax",
    )
