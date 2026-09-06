"""Security headers middleware (T19.4, ADR-0018).

Adds `X-Content-Type-Options: nosniff` and `Referrer-Policy:
strict-origin-when-cross-origin` to every API response, including 404s and
error responses raised before/inside routing (implemented as a pure ASGI
middleware so nothing that sends an `http.response.start` can bypass it).

Deliberately NOT set here: CSP and Permissions-Policy. Those are edge
concerns owned by the root `vercel.json` (see ADR-0018) — the browser that
needs them talks to the Vercel edge first, and keeping a single source of
truth avoids the two layers drifting apart. Cache-related headers are left
untouched.
"""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

X_CONTENT_TYPE_OPTIONS = ("X-Content-Type-Options", "nosniff")
REFERRER_POLICY = ("Referrer-Policy", "strict-origin-when-cross-origin")

_SECURITY_HEADERS: tuple[tuple[str, str], ...] = (
    X_CONTENT_TYPE_OPTIONS,
    REFERRER_POLICY,
)


class SecurityHeadersMiddleware:
    """Append the API security headers to every HTTP response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                for key, value in _SECURITY_HEADERS:
                    headers.append((key.encode("latin-1"), value.encode("latin-1")))
            await send(message)

        await self.app(scope, receive, send_with_headers)
