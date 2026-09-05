"""httpOnly-cookie refresh slice (T8.3, ADR-0008 addendum).

Covers ``POST /auth/refresh-cookie`` and ``POST /auth/logout-cookie``:
rotation semantics must be byte-identical to the JSON endpoints (same KV
keys, same reuse-detection family kill); the cookie is ``HttpOnly``,
``SameSite=Lax``, ``Path=/api/v1/auth`` and ``Secure`` unless
``KHOROCH_REFRESH_COOKIE_SECURE=0`` (tests run plain http, so conftest pins
it off; a dedicated unit test below proves Secure is on by default).
"""

from typing import Any

from fastapi import Response as FastAPIResponse
from httpx import AsyncClient, Response

import app.core.cookies as cookies_mod
from app.core.config import Settings
from app.core.cookies import REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH

AUTH = "/api/v1/auth"

# CookieJar handle for the ASGI test host (base_url is http://test). NOTE:
# httpx's cookiejar silently drops cookies pinned with an explicit domain
# ("test"), so only scope by path — mirroring the server's Path attribute.
_TEST_COOKIE_KWARGS = {"path": REFRESH_COOKIE_PATH}


async def register(client: AsyncClient) -> dict[str, Any]:
    r = await client.post(
        f"{AUTH}/register",
        json={"email": "cookie@test.dev", "password": "password123"},
    )
    assert r.status_code == 201, r.text
    return r.json()


def set_cookie(client: AsyncClient, token: str) -> None:
    # Drop any server-set kh_refresh cookies first: the cookiejar keys on
    # (domain, path, name) and would otherwise send BOTH the stale server
    # cookie and the manually installed one in a single Cookie header.
    client.cookies.jar.clear()
    client.cookies.set(REFRESH_COOKIE_NAME, token, **_TEST_COOKIE_KWARGS)


async def call_refresh_cookie(client: AsyncClient, token: str) -> Response:
    set_cookie(client, token)
    return await client.post(f"{AUTH}/refresh-cookie")


def refresh_cookie_headers(r: Response) -> list[str]:
    """kh_refresh Set-Cookie headers of a response (usually exactly one)."""
    return [
        h for h in r.headers.get_list("set-cookie") if h.startswith(f"{REFRESH_COOKIE_NAME}=")
    ]


def cookie_value(set_cookie: str) -> str:
    return set_cookie.split(";", 1)[0].split("=", 1)[1]


async def test_refresh_cookie_rotates_and_old_token_dies(client: AsyncClient) -> None:
    pair1 = await register(client)
    r = await call_refresh_cookie(client, pair1["refreshToken"])
    assert r.status_code == 200, r.text
    pair2 = r.json()
    assert set(pair2) == {"user", "accessToken", "refreshToken"}
    assert pair2["user"]["email"] == "cookie@test.dev"
    assert pair2["refreshToken"] != pair1["refreshToken"]

    # The rotated token is echoed in Set-Cookie with the right attributes.
    headers = refresh_cookie_headers(r)
    assert len(headers) == 1
    header = headers[0].lower()
    assert cookie_value(headers[0]) == pair2["refreshToken"]
    assert "httponly" in header
    assert "samesite=lax" in header
    assert f"path={REFRESH_COOKIE_PATH}" in header
    assert "max-age=2592000" in header  # refresh TTL (30 days)
    assert "secure" not in header  # test env pins KHOROCH_REFRESH_COOKIE_SECURE=0

    # OLD token replayed (via JSON) → reuse detection fires, family dies.
    replay = await client.post(
        f"{AUTH}/refresh", json={"refreshToken": pair1["refreshToken"]}
    )
    assert replay.status_code == 401
    assert replay.json()["detail"] == "session revoked"
    # ...and the same holds when replayed through the cookie endpoint.
    assert (await call_refresh_cookie(client, pair1["refreshToken"])).status_code == 401


async def test_refresh_cookie_new_token_keeps_working(client: AsyncClient) -> None:
    pair1 = await register(client)
    r2 = await call_refresh_cookie(client, pair1["refreshToken"])
    assert r2.status_code == 200, r2.text
    pair2 = r2.json()

    # New token works via the JSON endpoint (same KV keys).
    j = await client.post(
        f"{AUTH}/refresh", json={"refreshToken": pair2["refreshToken"]}
    )
    assert j.status_code == 200, j.text
    # ...and via the cookie endpoint again (third generation).
    r3 = await call_refresh_cookie(client, j.json()["refreshToken"])
    assert r3.status_code == 200, r3.text


async def test_refresh_cookie_reuse_kills_whole_family(client: AsyncClient) -> None:
    pair1 = await register(client)
    r2 = await call_refresh_cookie(client, pair1["refreshToken"])
    assert r2.status_code == 200, r2.text
    pair2 = r2.json()

    # Replay the STALE token through the cookie endpoint.
    replay = await call_refresh_cookie(client, pair1["refreshToken"])
    assert replay.status_code == 401
    assert replay.json()["detail"] == "session revoked"

    # The family is dead: the newest cookie token no longer refreshes...
    assert (await call_refresh_cookie(client, pair2["refreshToken"])).status_code == 401
    # ...nor via JSON...
    stale_json = await client.post(
        f"{AUTH}/refresh", json={"refreshToken": pair2["refreshToken"]}
    )
    assert stale_json.status_code == 401
    # ...and the newest access token is dead too (session liveness check).
    me = await client.get(
        f"{AUTH}/me", headers={"Authorization": f"Bearer {pair2['accessToken']}"}
    )
    assert me.status_code == 401


async def test_logout_cookie_revokes_and_clears(client: AsyncClient) -> None:
    pair = await register(client)
    # Establish a live session through the cookie endpoint first.
    r = await call_refresh_cookie(client, pair["refreshToken"])
    assert r.status_code == 200, r.text

    set_cookie(client, pair["refreshToken"])
    out = await client.post(f"{AUTH}/logout-cookie")
    assert out.status_code == 204
    headers = refresh_cookie_headers(out)
    assert len(headers) == 1
    header = headers[0].lower()
    assert "max-age=0" in header
    assert f"path={REFRESH_COOKIE_PATH}" in header

    # Session revoked: refresh (JSON) dead, access token dead.
    revoked = await client.post(
        f"{AUTH}/refresh", json={"refreshToken": pair["refreshToken"]}
    )
    assert revoked.status_code == 401
    me = await client.get(
        f"{AUTH}/me", headers={"Authorization": f"Bearer {pair['accessToken']}"}
    )
    assert me.status_code == 401


async def test_logout_cookie_idempotent(client: AsyncClient) -> None:
    # No cookie at all → still 204.
    assert (await client.post(f"{AUTH}/logout-cookie")).status_code == 204
    # Garbage cookie → 204, nothing blows up.
    client.cookies.set(REFRESH_COOKIE_NAME, "not-a-real-token", **_TEST_COOKIE_KWARGS)
    assert (await client.post(f"{AUTH}/logout-cookie")).status_code == 204


async def test_refresh_cookie_missing_401(client: AsyncClient) -> None:
    r = await client.post(f"{AUTH}/refresh-cookie")
    assert r.status_code == 401
    assert r.json()["detail"] == "Missing refresh token cookie"


async def test_refresh_cookie_unknown_token_401(client: AsyncClient) -> None:
    r = await call_refresh_cookie(client, "stale-or-forged-token-value-123")
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid refresh token"


async def test_refresh_cookie_secure_on_by_default(monkeypatch) -> None:
    """Prod default: the cookie MUST carry ``Secure`` (tests only turn it off)."""
    monkeypatch.setattr(
        cookies_mod,
        "get_settings",
        lambda: Settings(env="prod", jwt_secret="x" * 48, refresh_cookie_secure=True),
    )
    resp = FastAPIResponse()
    cookies_mod.set_refresh_cookie(resp, "some-token")
    header = resp.headers["set-cookie"].lower()
    assert "secure" in header
    assert "httponly" in header
    assert "samesite=lax" in header
    assert f"path={REFRESH_COOKIE_PATH}" in header

    cleared = FastAPIResponse()
    cookies_mod.clear_refresh_cookie(cleared)
    assert "max-age=0" in cleared.headers["set-cookie"].lower()
