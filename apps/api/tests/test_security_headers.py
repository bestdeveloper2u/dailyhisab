"""Security header contract tests (T19.4, ADR-0018).

The API middleware must stamp `X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin` on every response —
success, auth failure, and 404 alike — without touching cache headers or
inventing a server-side Permissions-Policy (that one is edge-only).
"""

from httpx import AsyncClient

NOSNIFF = "nosniff"
REFERRER = "strict-origin-when-cross-origin"


async def test_healthz_carries_both_headers(client: AsyncClient) -> None:
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.headers["x-content-type-options"] == NOSNIFF
    assert resp.headers["referrer-policy"] == REFERRER


async def test_login_response_carries_both_headers(client: AsyncClient) -> None:
    await client.post(
        "/api/v1/auth/register",
        json={"email": "headers@test.dev", "password": "password123", "name": "H"},
    )
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": "headers@test.dev", "password": "password123"},
    )
    assert resp.status_code == 200
    assert resp.headers["x-content-type-options"] == NOSNIFF
    assert resp.headers["referrer-policy"] == REFERRER


async def test_headers_on_404(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/definitely-not-a-route")
    assert resp.status_code == 404
    assert resp.headers["x-content-type-options"] == NOSNIFF
    assert resp.headers["referrer-policy"] == REFERRER


async def test_header_values_exact_on_both_health_routes(client: AsyncClient) -> None:
    for path in ("/healthz", "/api/v1/healthz"):
        resp = await client.get(path)
        assert resp.status_code == 200
        assert resp.headers.get("x-content-type-options") == NOSNIFF
        assert resp.headers.get("referrer-policy") == REFERRER


async def test_no_permissions_policy_set_server_side(client: AsyncClient) -> None:
    # Permissions-Policy is edge-only (vercel.json, ADR-0018): the API must
    # not emit its own value that could drift from (or shadow) the edge one.
    resp = await client.get("/healthz")
    assert "permissions-policy" not in resp.headers
    assert resp.headers["x-content-type-options"] == NOSNIFF


async def test_cache_related_headers_untouched(client: AsyncClient) -> None:
    # The middleware appends only the two security headers; it must not add
    # or alter cache-related headers on a plain FastAPI response.
    resp = await client.get("/healthz")
    assert "cache-control" not in resp.headers
    assert "etag" not in resp.headers
    assert resp.headers["x-content-type-options"] == NOSNIFF
    assert resp.headers["referrer-policy"] == REFERRER
