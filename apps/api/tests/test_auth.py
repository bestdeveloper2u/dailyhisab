"""Phase 1 auth flow tests (register/login/refresh/logout/me + security)."""

import jwt as pyjwt
import pytest
from httpx import AsyncClient, Response
from pydantic import ValidationError

from app.core.config import Settings
from app.core.security import decode_access_token

AUTH = "/api/v1/auth"


async def register(
    client: AsyncClient,
    email: str = "user@test.dev",
    password: str = "password123",
    name: str | None = None,
) -> Response:
    payload: dict[str, str] = {"email": email, "password": password}
    if name is not None:
        payload["name"] = name
    return await client.post(f"{AUTH}/register", json=payload)


async def login(
    client: AsyncClient, email: str = "user@test.dev", password: str = "password123"
) -> Response:
    return await client.post(
        f"{AUTH}/login", json={"email": email, "password": password}
    )


async def refresh(client: AsyncClient, refresh_token: str) -> Response:
    return await client.post(f"{AUTH}/refresh", json={"refreshToken": refresh_token})


async def me(client: AsyncClient, access_token: str) -> Response:
    return await client.get(
        f"{AUTH}/me", headers={"Authorization": f"Bearer {access_token}"}
    )


async def test_register_login_me_happy_path(client: AsyncClient) -> None:
    r = await register(client, name="Rakib Hasan")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["user"]["email"] == "user@test.dev"
    assert body["user"]["name"] == "Rakib Hasan"
    assert body["user"]["id"]
    assert set(body) == {"user", "accessToken", "refreshToken"}

    # Access token claims: sub=profile_id, sid=session id, exp-iat=900s.
    claims = decode_access_token(body["accessToken"])
    assert claims["sub"] == body["user"]["id"]
    assert isinstance(claims["sid"], str)
    assert claims["exp"] - claims["iat"] == 900

    r = await login(client)
    assert r.status_code == 200, r.text
    login_body = r.json()
    assert login_body["user"]["id"] == body["user"]["id"]
    assert login_body["accessToken"] != body["accessToken"]

    r = await me(client, login_body["accessToken"])
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "user@test.dev"


async def test_register_duplicate_email_409(client: AsyncClient) -> None:
    first = await register(client)
    assert first.status_code == 201
    dup = await register(client, email="USER@test.dev")  # case-insensitive
    assert dup.status_code == 409
    assert "already" in dup.json()["detail"]


async def test_login_wrong_password_401_same_message_as_unknown_email(
    client: AsyncClient,
) -> None:
    created = await register(client)
    assert created.status_code == 201
    wrong_pw = await login(client, password="wrong-password")
    assert wrong_pw.status_code == 401
    unknown = await login(client, email="nobody@test.dev")
    assert unknown.status_code == 401
    # Uniform message: login must not reveal whether the account exists.
    assert wrong_pw.json()["detail"] == unknown.json()["detail"]


async def test_register_short_password_422(client: AsyncClient) -> None:
    r = await register(client, password="short")
    assert r.status_code == 422


async def test_refresh_rotation_and_old_token_now_401(client: AsyncClient) -> None:
    created = await register(client)
    assert created.status_code == 201, created.text
    pair1 = created.json()

    rotated = await refresh(client, pair1["refreshToken"])
    assert rotated.status_code == 200, rotated.text
    pair2 = rotated.json()
    assert pair2["refreshToken"] != pair1["refreshToken"]
    # Access token may be byte-identical when minted in the same second with
    # identical claims (same session) — what must change is the refresh token.
    assert (await me(client, pair2["accessToken"])).status_code == 200

    # OLD refresh token presented again -> 401 (reuse detection fires).
    replay = await refresh(client, pair1["refreshToken"])
    assert replay.status_code == 401
    assert replay.json()["detail"] == "session revoked"


async def test_reuse_revokes_even_the_newest_token(client: AsyncClient) -> None:
    pair1 = (await register(client)).json()
    pair2 = (await refresh(client, pair1["refreshToken"])).json()
    # Replay pair1's refresh token: the whole session must die.
    assert (await refresh(client, pair1["refreshToken"])).status_code == 401
    # The newest refresh token no longer works...
    assert (await refresh(client, pair2["refreshToken"])).status_code == 401
    # ...and neither does the newest access token (session is gone).
    assert (await me(client, pair2["accessToken"])).status_code == 401


async def test_logout_revokes_session(client: AsyncClient) -> None:
    body = (await register(client)).json()
    headers = {"Authorization": f"Bearer {body['accessToken']}"}
    r = await client.post(f"{AUTH}/logout", headers=headers)
    assert r.status_code == 204
    # /me with the same access token now 401s (session liveness is checked).
    assert (await me(client, body["accessToken"])).status_code == 401
    # The refresh token is revoked too.
    assert (await refresh(client, body["refreshToken"])).status_code == 401


async def test_rate_limit_sixth_call_429(client: AsyncClient) -> None:
    statuses: list[int] = []
    r: Response | None = None
    for _ in range(6):
        r = await login(client, email="rl@test.dev", password="whatever123")
        statuses.append(r.status_code)
    assert statuses[:5] == [401] * 5  # limit is 5/min
    assert statuses[5] == 429
    assert r is not None
    assert int(r.headers["Retry-After"]) >= 1


async def test_access_token_tampered_401(client: AsyncClient) -> None:
    body = (await register(client)).json()
    token = body["accessToken"]
    forged = token[:-3] + ("aaa" if token[-3:] != "aaa" else "bbb")
    with pytest.raises(pyjwt.PyJWTError):
        decode_access_token(forged)
    assert (await me(client, forged)).status_code == 401


async def test_me_without_token_401(client: AsyncClient) -> None:
    r = await client.get(f"{AUTH}/me")
    assert r.status_code == 401


def test_jwt_secret_required_in_prod() -> None:
    with pytest.raises(ValidationError):
        Settings(env="prod", jwt_secret="", _env_file=None)


def test_jwt_secret_ephemeral_for_local_with_warning() -> None:
    with pytest.warns(UserWarning, match="KHOROCH_JWT_SECRET"):
        s = Settings(env="local", jwt_secret="", _env_file=None)
    assert len(s.jwt_secret) >= 32
